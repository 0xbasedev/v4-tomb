import { useReadContracts } from "wagmi";
import { erc20Abi, formatUnits, zeroAddress, type Address } from "viem";

import type { MasonryDeployment } from "@config/masonry-deployment.mjs";
import {
  iERC20Abi,
  masonryCriticalDefenseAbi,
  masonryGenesisLPBurnFeeAbi,
  masonryGenesisPassAbi,
  masonryGenesisScheduleAbi,
  masonryGenesisSettlementAbi,
  masonryGenesisStakingAbi,
  masonryLevelHookAbi,
  masonryLevelOracleAbi,
  masonrySquareHookAbi,
} from "@/lib/abis/masonry";
import { sellTax, type TaxQuote, type TaxedAsset } from "@/lib/fireTax";
import { genesisClock, type GenesisClock, type Tranche } from "@/lib/genesis";
import { DEFENSE, DEPLOYMENTS, PASSES, PASS_TIER_FROM_ID, type PassTier } from "@/lib/launch";
import { marketPhase, type MarketPhase } from "@/lib/market";
import { SIM_POOLS, SIM_SQUARE_REFERENCE, simPrices, usePreview } from "@/lib/preview";
import type { TokenId } from "@/lib/tokens";
import { useNetworkStatus, type NetworkState } from "./useNetworkStatus";

/**
 * useProtocol — every protocol read the screens need, from one place.
 *
 * Preview: the simulated chain (lib/preview.tsx), flagged `sim: true`.
 * Live:    multicall reads against the verified deployment (MasonryGenesis*,
 *          the two hooks, the oracle, Critical Defense, the LP burn fee and
 *          ERC-20 metadata). Values the contracts don't expose stay null and
 *          the screens say "—", never a made-up number.
 */

export interface ProtocolState {
  sim: boolean;
  net: NetworkState;
  account: Address | null;
  clock: GenesisClock | null;
  /** false: the schedule is deployed with start 0 (set once later by the scheduler). null: unknown. */
  genesisScheduled: boolean | null;
  pass: PassTier | null;
  market: {
    twap: number | null;
    observedAt: number | null;
    fresh: boolean;
    defense: { active: boolean; checkpoints: number; validNow: boolean };
    phase: MarketPhase;
  };
  hooks: {
    xTOMB: { raisedBps: number; raisedAt: number; genesisBurned: number | null };
    xSHARE: {
      raisedBps: number;
      raisedAt: number;
      reference: number | null;
      pol: number | null;
      usdcReserve: number | null;
      retained: number | null;
      critical: number | null;
      levelBurned: number | null;
      usdcRouted: number | null;
    };
  };
  prices: Partial<Record<TokenId, number | null>>;
  balances: Partial<Record<TokenId, number | null>>;
  staking: {
    funded: boolean | null;
    budget: number | null;
    totals: Record<0 | 1, number | null>;
    positions: Record<0 | 1, { shares: number; pending: number } | null>;
    nextCompoundAt: Record<0 | 1, number>;
    keeper: { executor: Address | null; minNetShares: number };
  };
  tranches: Tranche[];
  lpBurn: { totalShares: number | null; levelBurned: number | null; pendingShares: number | null; pendingUsdc: number | null };
  /** Static LP fee of each official pool (pool key), bps. */
  poolFeeBps: Record<TaxedAsset, number>;
  /** Share of an LP share's value held in its asset (sets the sell leg of an LP exit). */
  lpAssetShare: Record<TaxedAsset, number>;
  now: number;
  taxFor: (asset: TaxedAsset, valueUsd: number) => TaxQuote;
}

const n18 = (v: unknown) => (typeof v === "bigint" ? Number(formatUnits(v, 18)) : null);
const ok = <T,>(r: { status: string; result?: unknown } | undefined): T | undefined => (r && r.status === "success" ? (r.result as T) : undefined);

/** Post-sale price ÷ pre-sale price for selling `valueUsd` of the asset into a constant-product pool. */
function projectedRatio(pool: { asset: number; usdc: number }, price: number, valueUsd: number): number {
  const x = valueUsd / price;
  return (pool.asset / (pool.asset + x)) ** 2;
}

export function useProtocol(): ProtocolState {
  const preview = usePreview();
  const net = useNetworkStatus();
  // Disconnected in live mode: public reads from the first verified deployment.
  const d: MasonryDeployment | null = net.preview ? null : (net.deployment ?? (net.walletConnected ? null : (DEPLOYMENTS[0] ?? null)));
  const live = useLiveReads(d, net.account);

  if (preview.enabled) {
    const clock = preview.scheduled ? genesisClock(preview.start, preview.now) : null;
    const prices = simPrices(preview);
    const twap = preview.oracleFresh ? preview.twap : null;
    const connected = !!net.account;
    const p: ProtocolState = {
      sim: true,
      net,
      account: net.account,
      clock,
      genesisScheduled: preview.scheduled,
      pass: connected ? preview.pass : null,
      market: {
        twap: preview.twap,
        observedAt: preview.oracleFresh ? preview.now - 240 : preview.now - 3 * 3600,
        fresh: preview.oracleFresh,
        defense: { ...preview.defense, validNow: preview.oracleFresh },
        phase: marketPhase({ twap: preview.twap, fresh: preview.oracleFresh, defenseActive: preview.defense.active }),
      },
      hooks: {
        xTOMB: { raisedBps: preview.raised.xTOMB.bps, raisedAt: preview.raised.xTOMB.at, genesisBurned: 18_420 },
        xSHARE: {
          raisedBps: preview.raised.xSHARE.bps,
          raisedAt: preview.raised.xSHARE.at,
          reference: SIM_SQUARE_REFERENCE,
          pol: 41.2,
          usdcReserve: 68.6,
          retained: 233.4,
          critical: preview.defense.active ? 12.4 : 0,
          levelBurned: 2_140,
          usdcRouted: 8_220,
        },
      },
      prices,
      balances: connected ? preview.balances : {},
      staking: {
        funded: true,
        budget: 1_050_000,
        totals: { 0: 2_400_000, 1: 480_000 },
        // Nothing can be staked before the schedule has a start.
        positions: connected && preview.scheduled
          ? { 0: { shares: preview.positions[0].shares, pending: preview.pending[0] }, 1: { shares: preview.positions[1].shares, pending: preview.pending[1] } }
          : { 0: null, 1: null },
        nextCompoundAt: preview.nextCompoundAt,
        keeper: preview.keeper,
      },
      tranches: connected ? preview.tranches : [],
      lpBurn: { totalShares: 1_284.2, levelBurned: 642.1, pendingShares: 0, pendingUsdc: 0 },
      poolFeeBps: { xTOMB: SIM_POOLS.xTOMB.feeBps, xSHARE: SIM_POOLS.xSHARE.feeBps },
      lpAssetShare: { xTOMB: 0.5, xSHARE: 0.5 },
      now: preview.now,
      taxFor: (asset, valueUsd) => {
        const ratio = asset === "xTOMB" ? preview.twap : preview.squareRatio;
        const price = prices[asset];
        return sellTax({
          asset,
          twap: preview.oracleFresh ? ratio : null,
          projected: preview.oracleFresh ? ratio * projectedRatio(SIM_POOLS[asset], price, valueUsd) : null,
          raisedBps: preview.raised[asset].bps,
          raisedAt: preview.raised[asset].at,
          now: preview.now,
          genesisActive: !!clock?.active,
        });
      },
    };
    void twap;
    return p;
  }

  return { ...live, net, account: net.account };
}

/** Live multicall reads. Returns nulls (never samples) for anything unread. */
function useLiveReads(d: MasonryDeployment | null, account: Address | null): Omit<ProtocolState, "net" | "account"> {
  const user = account ?? zeroAddress;
  const c = d?.contracts;
  const enabled = !!c;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: c
      ? [
          { address: c.schedule, abi: masonryGenesisScheduleAbi, functionName: "start" }, // 0
          { address: c.levelOracle, abi: masonryLevelOracleAbi, functionName: "latestValidatedTwap" }, // 1
          { address: c.criticalDefense, abi: masonryCriticalDefenseAbi, functionName: "active" }, // 2
          { address: c.criticalDefense, abi: masonryCriticalDefenseAbi, functionName: "recoveryCheckpoints" }, // 3
          { address: c.criticalDefense, abi: masonryCriticalDefenseAbi, functionName: "validNow" }, // 4
          { address: c.levelHook, abi: masonryLevelHookAbi, functionName: "raisedBps" }, // 5
          { address: c.levelHook, abi: masonryLevelHookAbi, functionName: "raisedAt" }, // 6
          { address: c.levelHook, abi: masonryLevelHookAbi, functionName: "genesisLevelBurned" }, // 7
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "raisedBps" }, // 8
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "raisedAt" }, // 9
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "squareReferencePrice" }, // 10
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "polSquare" }, // 11
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "usdcReserveSquare" }, // 12
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "retainedSquare" }, // 13
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "criticalSquare" }, // 14
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "levelBurned" }, // 15
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "usdcRouted" }, // 16
          { address: c.pass, abi: masonryGenesisPassAbi, functionName: "tierOf", args: [user] }, // 17
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "funded" }, // 18
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "rewardBudget" }, // 19
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "pools", args: [0n] }, // 20
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "pools", args: [1n] }, // 21
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "positions", args: [0n, user] }, // 22
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "positions", args: [1n, user] }, // 23
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "nextCompoundAt", args: [0n, user] }, // 24
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "nextCompoundAt", args: [1n, user] }, // 25
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "keeper", args: [user] }, // 26
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "minimumNetCompoundShares", args: [user] }, // 27
          { address: c.settlement, abi: masonryGenesisSettlementAbi, functionName: "trancheCount", args: [user] }, // 28
          { address: c.lpBurnFee, abi: masonryGenesisLPBurnFeeAbi, functionName: "totalFeeSharesCollected" }, // 29
          { address: c.lpBurnFee, abi: masonryGenesisLPBurnFeeAbi, functionName: "totalLevelBurnedFromLPFees" }, // 30
          { address: c.lpBurnFee, abi: masonryGenesisLPBurnFeeAbi, functionName: "pendingFeeShares" }, // 31
          { address: c.lpBurnFee, abi: masonryGenesisLPBurnFeeAbi, functionName: "pendingBurnUSDC" }, // 32
          { address: c.level, abi: iERC20Abi, functionName: "balanceOf", args: [user] }, // 33
          { address: c.square, abi: iERC20Abi, functionName: "balanceOf", args: [user] }, // 34
          { address: c.usdc, abi: iERC20Abi, functionName: "balanceOf", args: [user] }, // 35
          { address: c.levelVault, abi: iERC20Abi, functionName: "balanceOf", args: [user] }, // 36
          { address: c.squareVault, abi: iERC20Abi, functionName: "balanceOf", args: [user] }, // 37
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "oracle" }, // 38
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });
  // Pool 0 shares are denominated in the deployment-bound standard asset, so
  // read which asset that is and its decimals instead of assuming 18 (or USDC).
  const stdAssetRead = useReadContracts({
    allowFailure: true,
    contracts: c ? [{ address: c.staking, abi: masonryGenesisStakingAbi, functionName: "standardAsset" }] : [],
    query: { enabled },
  });
  const stdAsset = ok<Address>(stdAssetRead.data?.[0]) ?? null;
  const stdDecRead = useReadContracts({
    allowFailure: true,
    contracts: stdAsset ? [{ address: stdAsset, abi: erc20Abi, functionName: "decimals" }] : [],
    query: { enabled: !!stdAsset },
  });
  const stdDecimals = ok<number>(stdDecRead.data?.[0]) ?? null;
  const r = reads.data ?? [];
  const count = Number(ok<bigint>(r[28]) ?? 0n);
  const trancheReads = useReadContracts({
    allowFailure: true,
    contracts:
      c && count > 0
        ? Array.from({ length: Math.min(count, 32) }, (_, i) => ({
            address: c.settlement,
            abi: masonryGenesisSettlementAbi,
            functionName: "tranches" as const,
            args: [user, BigInt(i)] as const,
          }))
        : [],
    query: { enabled: enabled && count > 0, refetchInterval: 30_000 },
  });

  // xSHARE's own validated TWAP lives in the oracle its hook created.
  const squareOracle = ok<Address>(r[38]);
  const squareTwapRead = useReadContracts({
    allowFailure: true,
    contracts: squareOracle ? [{ address: squareOracle, abi: masonryLevelOracleAbi, functionName: "latestValidatedTwap" }] : [],
    query: { enabled: !!squareOracle, refetchInterval: 15_000 },
  });
  const sq = ok<readonly [bigint, bigint, boolean]>(squareTwapRead.data?.[0]);
  const squareTwap = sq ? n18(sq[0]) : null;
  const squareFresh = !!sq?.[2];

  const nowSec = Math.floor(Date.now() / 1000);
  const start = ok<bigint>(r[0]);
  // start == 0: deployed unscheduled — no clock until the scheduler sets it.
  const clock = start !== undefined && start !== 0n ? genesisClock(Number(start), nowSec) : null;
  const twapRead = ok<readonly [bigint, bigint, boolean]>(r[1]);
  const twap = twapRead ? n18(twapRead[0]) : null;
  const observedAt = twapRead ? Number(twapRead[1]) : null;
  const fresh = !!twapRead?.[2];
  const defenseActive = ok<boolean>(r[2]) ?? false;
  const ref = n18(ok<bigint>(r[10]));
  const tier = ok<number>(r[17]);
  // decimals: pool 0 → standard asset (unknown until read), pool 1 → LP vault shares (18).
  const pos = (i: number, decimals: number | null) => {
    const v = ok<readonly [bigint, bigint, bigint]>(r[i]);
    return v && decimals !== null ? { shares: Number(formatUnits(v[0], decimals)), pending: Number(formatUnits(v[2], 18)) } : null;
  };
  const pool = (i: number, decimals: number | null) => {
    const v = ok<readonly [bigint, bigint, bigint]>(r[i]);
    return v && decimals !== null ? Number(formatUnits(v[0], decimals)) : null;
  };
  const raisedX = Number(ok<number>(r[5]) ?? 100);
  const raisedAtX = Number(ok<bigint>(r[6]) ?? 0n);
  const raisedS = Number(ok<number>(r[8]) ?? 100);
  const raisedAtS = Number(ok<bigint>(r[9]) ?? 0n);
  const keeper = ok<Address>(r[26]);
  const tranches: Tranche[] = (trancheReads.data ?? [])
    .map((t) => ok<readonly [bigint, bigint, number]>(t))
    .filter((t): t is readonly [bigint, bigint, number] => !!t)
    .map((t) => ({ amount: Number(formatUnits(t[0], 18)), nextRelease: Number(t[1]), releasedInstallments: Number(t[2]) }));
  const usdcBal = ok<bigint>(r[35]);

  return {
    sim: false,
    clock,
    genesisScheduled: start === undefined ? null : start !== 0n,
    pass: tier !== undefined ? PASS_TIER_FROM_ID[tier] : null,
    market: {
      twap,
      observedAt,
      fresh,
      defense: { active: defenseActive, checkpoints: Number(ok<number>(r[3]) ?? 0), validNow: ok<boolean>(r[4]) ?? false },
      phase: marketPhase({ twap, fresh, defenseActive }),
    },
    hooks: {
      xTOMB: { raisedBps: raisedX, raisedAt: raisedAtX, genesisBurned: n18(ok<bigint>(r[7])) },
      xSHARE: {
        raisedBps: raisedS,
        raisedAt: raisedAtS,
        reference: ref,
        pol: n18(ok<bigint>(r[11])),
        usdcReserve: n18(ok<bigint>(r[12])),
        retained: n18(ok<bigint>(r[13])),
        critical: n18(ok<bigint>(r[14])),
        levelBurned: n18(ok<bigint>(r[15])),
        usdcRouted: (() => {
          const v = ok<bigint>(r[16]);
          return v !== undefined ? Number(formatUnits(v, 6)) : null;
        })(),
      },
    },
    // Live USD prices need the validated TWAPs; xSHARE has no USD oracle of its own,
    // and vault share prices need pool state, so those stay unknown rather than guessed.
    prices: { xTOMB: twap, USDC: 1, xSHARE: squareTwap, "xTOMB-USDC": null, "xSHARE-USDC": null },
    balances: {
      xTOMB: n18(ok<bigint>(r[33])),
      xSHARE: n18(ok<bigint>(r[34])),
      USDC: usdcBal !== undefined ? Number(formatUnits(usdcBal, 6)) : null,
      "xTOMB-USDC": n18(ok<bigint>(r[36])),
      "xSHARE-USDC": n18(ok<bigint>(r[37])),
    },
    staking: {
      funded: ok<boolean>(r[18]) ?? null,
      budget: n18(ok<bigint>(r[19])),
      totals: { 0: pool(20, stdDecimals), 1: pool(21, 18) },
      positions: { 0: pos(22, stdDecimals), 1: pos(23, 18) },
      nextCompoundAt: { 0: Number(ok<bigint>(r[24]) ?? 0n), 1: Number(ok<bigint>(r[25]) ?? 0n) },
      keeper: { executor: keeper && keeper !== zeroAddress ? keeper : null, minNetShares: n18(ok<bigint>(r[27])) ?? 0 },
    },
    tranches,
    lpBurn: { totalShares: n18(ok<bigint>(r[29])), levelBurned: n18(ok<bigint>(r[30])), pendingShares: n18(ok<bigint>(r[31])), pendingUsdc: ok<bigint>(r[32]) !== undefined ? Number(formatUnits(ok<bigint>(r[32])!, 6)) : null },
    poolFeeBps: { xTOMB: (d?.pools.level.fee ?? 0) / 100, xSHARE: (d?.pools.square.fee ?? 0) / 100 },
    lpAssetShare: { xTOMB: 0.5, xSHARE: 0.5 },
    now: nowSec,
    taxFor: (asset, _valueUsd) =>
      sellTax({
        asset,
        twap: asset === "xTOMB" ? (fresh ? twap : null) : squareFresh && squareTwap !== null && ref ? squareTwap / ref : null,
        // The hook projects the post-sale price itself; the swap simulation shows the result.
        projected: null,
        raisedBps: asset === "xTOMB" ? raisedX : raisedS,
        raisedAt: asset === "xTOMB" ? raisedAtX : raisedAtS,
        now: nowSec,
        genesisActive: !!clock?.active,
      }),
  };
}

export const PASS_PRICE_USDC = Object.fromEntries(Object.values(PASSES).map((p) => [p.id, p.priceUsdc])) as Record<PassTier, number>;
export const ORACLE_MAX_AGE = DEFENSE.oracleMaxAgeSeconds;
