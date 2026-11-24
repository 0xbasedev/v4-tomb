import { useReadContracts } from "wagmi";
import { zeroAddress, type Abi, type Address, type Hex } from "viem";

import {
  erc20Abi,
  masonryAbi,
  pegDefenseHookAbi,
  poolManagerAbi,
  shareBuybackHookAbi,
  treasuryAbi,
} from "@/lib/abis";
import type { ProtocolDeployment } from "@/lib/addresses";
import { toNumber } from "@/lib/format";
import { CEILING, EPOCH_SECONDS, LOCKUP, NAMES, PEG_POOL_FEES, marketPhase, type MarketPhase } from "@/lib/protocol";
import { decodePoolState, poolKeys, poolStateSlots, type PoolId, type PoolState } from "@/lib/swap/poolKey";
import { batch } from "./reads";
import { useFarm, type FarmState } from "./useFarm";
import { useNetworkStatus, type NetworkState } from "./useNetworkStatus";

/**
 * Everything the pages read, from this repo's contracts only:
 *
 *   Treasury          epoch clock, TWAP, ceiling, expansion preview, fund cuts
 *   PegDefenseHook    live sell-tax rate, ratchet, deferred tax, totals
 *   ShareBuybackHook  pending buyback and its totals
 *   Masonry (xROOM)   stake token, lockups, position
 *   GenesisRewardPool / PegFarm / ShareFarm   pools and positions
 *   PoolManager       slot0 + liquidity of the three pools (extsload)
 *
 * With no deployment (`deployed === false`) every value is null. Nothing is
 * simulated: a page must show "—" or say it is not deployed.
 */
export interface ProtocolState {
  net: NetworkState;
  account: Address | null;
  /** A deployment exists for the network in view. */
  deployed: boolean;
  /** Deployed, and the first batch of reads has not settled yet. */
  loading: boolean;
  now: number;
  symbols: { peg: string; share: string; quote: string; room: string };
  quoteDecimals: number;
  epoch: { current: number | null; nextAt: number | null; period: number; startTime: number | null };
  market: {
    /** Treasury.getPegPrice — the TWAP recorded for the last epoch, in the paired asset. */
    twap: number | null;
    /** Treasury.getPegUpdatedPrice — what the TWAP would be if the oracle updated now. */
    liveTwap: number | null;
    /** Spot price from the peg pool's resting tick. */
    spot: number | null;
    /** Spot price of the share token in the paired asset, from its pool. */
    shareSpot: number | null;
    ceiling: number;
    phase: MarketPhase;
    circulating: bigint | null;
    /** What allocateSeigniorage would mint at the recorded TWAP. Zero at or below the ceiling. */
    nextExpansion: bigint | null;
    daoCutBps: number | null;
    devCutBps: number | null;
  };
  tax: {
    /** currentTaxRate — what a peg-token sell pays right now (bps), ratchet included. */
    rateBps: number | null;
    /** targetTaxRate — where the schedule points; below rateBps while a recovery is pending. */
    targetBps: number | null;
    pendingDecrease: { toBps: number; readyAt: number } | null;
    /** The price the tax is assessed against (TWAP, or resting spot without an oracle). */
    price: number | null;
    /** autoCalculateTax — the master switch. Off means sells are not taxed. */
    enabled: boolean | null;
    bound: boolean | null;
    feeRecipient: Address | null;
    burnThreshold: number | null;
    pendingBurn: bigint | null;
    pendingRoute: bigint | null;
    settleableNow: bigint | null;
    totals: { assessed: bigint | null; burned: bigint | null; routed: bigint | null };
    /** LP fee the hook would charge on the peg pool at its resting tick (hundredths of a bip). */
    poolFeePips: number;
  };
  buyback: {
    enabled: boolean | null;
    pendingQuote: bigint | null;
    readyAt: number | null;
    totals: { assessed: bigint | null; converted: bigint | null; pegBurned: bigint | null };
  };
  supplies: { peg: bigint | null; share: bigint | null };
  balances: { peg: bigint | null; share: bigint | null; quote: bigint | null; pegLp: bigint | null; shareLp: bigint | null; pairLp: bigint | null };
  masonry: {
    stakeToken: Address | null;
    stakeSymbol: string;
    /** True when the stake token is the peg/share LP wrapper (the default wiring). */
    stakesPairLp: boolean | null;
    totalStaked: bigint | null;
    staked: bigint | null;
    wallet: bigint | null;
    earned: bigint | null;
    canWithdraw: boolean | null;
    canClaim: boolean | null;
    /** Epoch of the last stake or claim — the lockups count from here. */
    epochTimerStart: number | null;
    withdrawLockupEpochs: number;
    rewardLockupEpochs: number;
  };
  farms: Record<"genesis" | "pegFarm" | "shareFarm", FarmState>;
  pools: Record<PoolId, PoolState | null>;
}

const num = (v: bigint | undefined): number | null => (v === undefined ? null : Number(v));

export function useProtocol(): ProtocolState {
  const net = useNetworkStatus();
  const d: ProtocolDeployment | null = net.deployment;
  const account = net.account;
  const user = account ?? zeroAddress;
  const now = Math.floor(Date.now() / 1000);
  const enabled = !!d;

  const core = d
    ? batch(d.chainId, {
        epoch: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "epoch" },
        nextEpochPoint: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "nextEpochPoint" },
        startTime: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "startTime" },
        twap: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "getPegPrice" },
        liveTwap: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "getPegUpdatedPrice" },
        ceiling: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "pegPriceCeiling" },
        circulating: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "getPegCirculatingSupply" },
        expansion: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "getExpansionAmount" },
        daoCut: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "daoFundSharedPercent" },
        devCut: { address: d.treasury, abi: treasuryAbi as Abi, functionName: "devFundSharedPercent" },

        taxRate: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "currentTaxRate" },
        taxTarget: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "targetTaxRate" },
        taxDecrease: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "pendingTaxDecrease" },
        taxPrice: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "currentTaxPrice" },
        taxOn: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "autoCalculateTax" },
        hookBound: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "bound" },
        feeRecipient: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "feeRecipient" },
        burnThreshold: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "burnThreshold" },
        deferred: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "deferredTaxStatus" },
        taxAssessed: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "totalTaxAssessed" },
        taxBurned: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "totalTaxBurned" },
        taxRouted: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "totalTaxRouted" },
        pegIs0: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "pegIsCurrency0" },
        pegTick: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "pegTick" },
        bandTicks: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "bandTicks" },
        feeExpansion: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "expansionFee" },
        feeBase: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "baseFee" },
        feeContraction: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "contractionFee" },
        feeDeep: { address: d.hook, abi: pegDefenseHookAbi as Abi, functionName: "deepContractionFee" },

        buyback: { address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, functionName: "buybackStatus" },
        buybackOn: { address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, functionName: "taxEnabled" },
        quoteAssessed: { address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, functionName: "totalQuoteAssessed" },
        quoteConverted: { address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, functionName: "totalQuoteConverted" },
        pegBurned: { address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, functionName: "totalPegBurned" },

        pegSymbol: { address: d.peg, abi: erc20Abi as Abi, functionName: "symbol" },
        shareSymbol: { address: d.share, abi: erc20Abi as Abi, functionName: "symbol" },
        quoteSymbol: { address: d.weth, abi: erc20Abi as Abi, functionName: "symbol" },
        quoteDecimals: { address: d.weth, abi: erc20Abi as Abi, functionName: "decimals" },
        pegSupply: { address: d.peg, abi: erc20Abi as Abi, functionName: "totalSupply" },
        shareSupply: { address: d.share, abi: erc20Abi as Abi, functionName: "totalSupply" },

        stakeToken: { address: d.masonry, abi: masonryAbi as Abi, functionName: "share" },
        masonryTotal: { address: d.masonry, abi: masonryAbi as Abi, functionName: "totalSupply" },
        withdrawLockup: { address: d.masonry, abi: masonryAbi as Abi, functionName: "withdrawLockupEpochs" },
        rewardLockup: { address: d.masonry, abi: masonryAbi as Abi, functionName: "rewardLockupEpochs" },
      })
    : null;
  const coreRead = useReadContracts({
    allowFailure: true,
    contracts: core?.contracts ?? [],
    query: { enabled, refetchInterval: 15_000 },
  });
  const c = <T,>(key: Parameters<NonNullable<typeof core>["get"]>[1]) => core?.get<T>(coreRead.data, key);

  const stakeToken = c<Address>("stakeToken") ?? null;

  // Wallet-specific reads, and the Masonry stake token's own metadata.
  const mine = d
    ? batch(d.chainId, {
        peg: account ? { address: d.peg, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
        share: account ? { address: d.share, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
        quote: account ? { address: d.weth, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
        pegLp: account ? { address: d.lpWrapper, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
        shareLp: account ? { address: d.shareLpWrapper, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
        pairLp: account ? { address: d.pairLpWrapper, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
        staked: account ? { address: d.masonry, abi: masonryAbi as Abi, functionName: "balanceOf", args: [user] } : null,
        earned: account ? { address: d.masonry, abi: masonryAbi as Abi, functionName: "earned", args: [user] } : null,
        canWithdraw: account ? { address: d.masonry, abi: masonryAbi as Abi, functionName: "canWithdraw", args: [user] } : null,
        canClaim: account ? { address: d.masonry, abi: masonryAbi as Abi, functionName: "canClaimReward", args: [user] } : null,
        member: account ? { address: d.masonry, abi: masonryAbi as Abi, functionName: "members", args: [user] } : null,
        stakeSymbol: stakeToken ? { address: stakeToken, abi: erc20Abi as Abi, functionName: "symbol" } : null,
        stakeWallet: stakeToken && account ? { address: stakeToken, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] } : null,
      })
    : null;
  const mineRead = useReadContracts({
    allowFailure: true,
    contracts: mine?.contracts ?? [],
    query: { enabled: enabled && (mine?.contracts.length ?? 0) > 0, refetchInterval: 15_000 },
  });
  const m = <T,>(key: Parameters<NonNullable<typeof mine>["get"]>[1]) => mine?.get<T>(mineRead.data, key);

  // Pool state straight from the PoolManager's storage: exact for our pools,
  // unlike a token balance of the PoolManager, which covers every pool on the chain.
  const keys = d ? poolKeys(d) : null;
  const ids: PoolId[] = ["peg", "share", "pair"];
  const poolRead = useReadContracts({
    allowFailure: true,
    contracts:
      d && keys
        ? ids.flatMap((id) => {
            const slots = poolStateSlots(keys[id]);
            return [slots.slot0, slots.liquidity].map((slot) => ({
              address: d.poolManager,
              abi: poolManagerAbi as Abi,
              functionName: "extsload",
              args: [slot],
              chainId: d.chainId,
            }));
          })
        : [],
    query: { enabled, refetchInterval: 15_000 },
  });
  const words = (poolRead.data ?? []) as readonly ({ status: string; result?: unknown } | undefined)[];
  const word = (i: number) => (words[i]?.status === "success" ? (words[i]!.result as Hex) : undefined);
  const pools = Object.fromEntries(
    ids.map((id, i) => [id, keys ? decodePoolState(keys[id], word(i * 2), word(i * 2 + 1)) : null]),
  ) as Record<PoolId, PoolState | null>;

  const farms = {
    genesis: useFarm(d, "genesis", account, now),
    pegFarm: useFarm(d, "pegFarm", account, now),
    shareFarm: useFarm(d, "shareFarm", account, now),
  };

  // ---- derive ----
  const e18 = (v: bigint | undefined) => toNumber(v ?? null, 18);
  const twapRaw = c<bigint>("twap");
  const twap = twapRaw && twapRaw > 0n ? e18(twapRaw) : null;
  const liveRaw = c<bigint>("liveTwap");
  const ceiling = e18(c<bigint>("ceiling")) ?? CEILING;

  const pegIs0 = c<boolean>("pegIs0");
  const pegPool = pools.peg;
  const quoteDecimals = Number(c<number>("quoteDecimals") ?? 18);
  // Price of an 18-decimal protocol token in the paired asset, from a pool's sqrt price.
  const spotOf = (pool: PoolState | null, token: Address | undefined): number | null => {
    if (!pool || pool.sqrtPriceX96 === 0n || !token) return null;
    const ratio = Number(pool.sqrtPriceX96) / 2 ** 96;
    const oneInZero = ratio * ratio; // raw currency1 per raw currency0
    const tokenIsZero = pool.key.currency0.toLowerCase() === token.toLowerCase();
    return (tokenIsZero ? oneInZero : 1 / oneInZero) * 10 ** (18 - quoteDecimals);
  };
  const spot = spotOf(pegPool, d?.peg);
  const shareSpot = spotOf(pools.share, d?.share);

  // PegDefenseHook._feeForTick, mirrored for the quote.
  let poolFeePips: number = PEG_POOL_FEES.base;
  const pegTick = c<number>("pegTick");
  const band = c<number>("bandTicks");
  if (pegPool && pegIs0 !== undefined && pegTick !== undefined && band !== undefined) {
    const delta = pegIs0 ? pegPool.tick - pegTick : pegTick - pegPool.tick;
    poolFeePips =
      delta >= band
        ? Number(c<number>("feeExpansion") ?? PEG_POOL_FEES.expansion)
        : delta > -band
          ? Number(c<number>("feeBase") ?? PEG_POOL_FEES.base)
          : delta > -2 * band
            ? Number(c<number>("feeContraction") ?? PEG_POOL_FEES.contraction)
            : Number(c<number>("feeDeep") ?? PEG_POOL_FEES.deepContraction);
  }

  const decrease = c<readonly [bigint, bigint]>("taxDecrease");
  const deferred = c<readonly [bigint, bigint, bigint, bigint]>("deferred");
  const buyback = c<readonly [bigint, bigint, bigint]>("buyback");
  const member = m<readonly [bigint, bigint, bigint]>("member");
  const same = (a: Address | null, b: Address | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  return {
    net,
    account,
    deployed: enabled,
    loading: enabled && !coreRead.isFetched,
    now,
    symbols: {
      peg: c<string>("pegSymbol") ?? NAMES.peg,
      share: c<string>("shareSymbol") ?? NAMES.share,
      quote: c<string>("quoteSymbol") ?? NAMES.quote,
      room: NAMES.room,
    },
    quoteDecimals,
    epoch: {
      current: num(c<bigint>("epoch")),
      nextAt: num(c<bigint>("nextEpochPoint")),
      period: EPOCH_SECONDS,
      startTime: num(c<bigint>("startTime")),
    },
    market: {
      twap,
      liveTwap: liveRaw && liveRaw > 0n ? e18(liveRaw) : null,
      spot,
      shareSpot,
      ceiling,
      phase: marketPhase(twap, ceiling),
      circulating: c<bigint>("circulating") ?? null,
      nextExpansion: c<bigint>("expansion") ?? null,
      daoCutBps: num(c<bigint>("daoCut")),
      devCutBps: num(c<bigint>("devCut")),
    },
    tax: {
      rateBps: num(c<bigint>("taxRate")),
      targetBps: num(c<bigint>("taxTarget")),
      pendingDecrease: decrease && decrease[1] > 0n ? { toBps: Number(decrease[0]), readyAt: Number(decrease[1]) } : null,
      price: e18(c<bigint>("taxPrice")),
      enabled: c<boolean>("taxOn") ?? null,
      bound: c<boolean>("hookBound") ?? null,
      feeRecipient: c<Address>("feeRecipient") ?? null,
      burnThreshold: e18(c<bigint>("burnThreshold")),
      pendingBurn: deferred?.[0] ?? null,
      pendingRoute: deferred?.[1] ?? null,
      settleableNow: deferred?.[3] ?? null,
      totals: {
        assessed: c<bigint>("taxAssessed") ?? null,
        burned: c<bigint>("taxBurned") ?? null,
        routed: c<bigint>("taxRouted") ?? null,
      },
      poolFeePips,
    },
    buyback: {
      enabled: c<boolean>("buybackOn") ?? null,
      pendingQuote: buyback?.[0] ?? null,
      readyAt: buyback ? Number(buyback[2]) : null,
      totals: {
        assessed: c<bigint>("quoteAssessed") ?? null,
        converted: c<bigint>("quoteConverted") ?? null,
        pegBurned: c<bigint>("pegBurned") ?? null,
      },
    },
    supplies: { peg: c<bigint>("pegSupply") ?? null, share: c<bigint>("shareSupply") ?? null },
    balances: {
      peg: m<bigint>("peg") ?? null,
      share: m<bigint>("share") ?? null,
      quote: m<bigint>("quote") ?? null,
      pegLp: m<bigint>("pegLp") ?? null,
      shareLp: m<bigint>("shareLp") ?? null,
      pairLp: m<bigint>("pairLp") ?? null,
    },
    masonry: {
      stakeToken,
      stakeSymbol: m<string>("stakeSymbol") ?? `${NAMES.peg}/${NAMES.share} LP`,
      stakesPairLp: stakeToken ? same(stakeToken, d?.pairLpWrapper) : null,
      totalStaked: c<bigint>("masonryTotal") ?? null,
      staked: m<bigint>("staked") ?? null,
      wallet: m<bigint>("stakeWallet") ?? null,
      earned: m<bigint>("earned") ?? null,
      canWithdraw: m<boolean>("canWithdraw") ?? null,
      canClaim: m<boolean>("canClaim") ?? null,
      epochTimerStart: member ? Number(member[2]) : null,
      withdrawLockupEpochs: Number(c<bigint>("withdrawLockup") ?? LOCKUP.withdrawEpochs),
      rewardLockupEpochs: Number(c<bigint>("rewardLockup") ?? LOCKUP.rewardEpochs),
    },
    farms,
    pools,
  };
}
