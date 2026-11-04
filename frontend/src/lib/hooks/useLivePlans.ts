import { useEffect, useState } from "react";
import { useConfig, useReadContracts } from "wagmi";
import { simulateContract } from "wagmi/actions";
import { erc20Abi, formatUnits, parseUnits, zeroAddress, type Address } from "viem";

import { masonryBuybackGuardAbi, masonryGenesisStakingAbi, masonryLevelUsdcVaultAbi, miniSwapRouterAbi } from "@/lib/abis/masonry";
import { planCompound, type CompoundPlan } from "@/lib/compoundPlan";
import { cumulativeEmitted, genesisClock } from "@/lib/genesis";
import { GENESIS_POLICY } from "@/lib/launch";
import type { TaxedAsset } from "@/lib/fireTax";
import { useNetworkStatus } from "./useNetworkStatus";

const ACC = 10n ** 18n; // MasonryGenesisStaking ACC_PRECISION

/**
 * Live compound plan for a source pool. Reconstructs the accrued reward the
 * contract will settle (stored pending can omit accrual since the last
 * checkpoint), then plans the sell and the gross shares against the guard's
 * validated spot and the vault's fixed range. Null in Preview or when any
 * input is unavailable — the button then explains why.
 */
export function useCompoundPlan(pool: 0 | 1, sellTaxBps: number | null, poolFeeBps: number): { plan: CompoundPlan | null; reward: number | null } {
  const net = useNetworkStatus();
  const c = net.deployment?.contracts;
  const user = net.walletAddress ?? zeroAddress;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: c
      ? [
          { address: c.buybackGuard, abi: masonryBuybackGuardAbi, functionName: "validatedSpot" },
          { address: c.levelVault, abi: masonryLevelUsdcVaultAbi, functionName: "tickLower" },
          { address: c.levelVault, abi: masonryLevelUsdcVaultAbi, functionName: "tickUpper" },
          { address: c.levelVault, abi: masonryLevelUsdcVaultAbi, functionName: "levelIsCurrency0" },
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "pools", args: [BigInt(pool)] },
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "positions", args: [BigInt(pool), user] },
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "rewardBudget" },
          { address: c.schedule, abi: [{ type: "function", name: "start", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const, functionName: "start" },
        ]
      : [],
    query: { enabled: !!c && !!net.walletAddress && sellTaxBps !== null, refetchInterval: 20_000 },
  });
  const data = reads.data as readonly { status: string; result?: unknown }[] | undefined;
  if (!data || data.length < 8 || data.some((x) => x.status !== "success") || sellTaxBps === null) return { plan: null, reward: null };
  const r = (i: number) => data[i]!.result;
  const [spot] = r(0) as readonly [bigint, bigint];
  const lower = Number(r(1));
  const upper = Number(r(2));
  const level0 = r(3) as boolean;
  const [totalStaked, lastEmitted, accLevel] = r(4) as readonly [bigint, bigint, bigint];
  const [shares, paidPerShare, pending] = r(5) as readonly [bigint, bigint, bigint];
  const budget = r(6) as bigint;
  const start = Number(r(7) as bigint);
  const clock = genesisClock(start, Math.floor(Date.now() / 1000));
  const emitted = parseUnits(cumulativeEmitted(pool, Number(formatUnits(budget, 18)), clock).toFixed(18), 18);
  const acc = totalStaked > 0n && emitted > lastEmitted ? accLevel + ((emitted - lastEmitted) * ACC) / totalStaked : accLevel;
  const reward = pending + (shares * (acc - paidPerShare)) / ACC;
  const liquid = reward / 2n;
  const plan = planCompound({
    budget: liquid,
    spot18: spot,
    tickLower: lower,
    tickUpper: upper,
    levelIsCurrency0: level0,
    sellCostBps: sellTaxBps + poolFeeBps,
    lpBurnBps: GENESIS_POLICY.lpBurnFeeBps,
    slippageBps: 100,
  });
  return { plan, reward: Number(formatUnits(reward, 18)) };
}

/**
 * Simulated output of one official-pool swap (MiniSwapRouter.swapExactIn via
 * eth_call from the user's address). Runs only once the router allowance
 * covers the input — the router pulls tokens, so the call can't be simulated
 * without it. Returns the contract's own output; the UI derives the minimum
 * received from this number, never from an estimate.
 */
export function useSwapSimulation(asset: TaxedAsset | null, side: "sell" | "buy", amountIn: number) {
  const net = useNetworkStatus();
  const config = useConfig();
  const c = net.deployment?.contracts;
  const key = net.deployment ? (asset === "xTOMB" ? net.deployment.pools.level : net.deployment.pools.square) : null;
  const tokenIn: Address | undefined = c && asset ? (side === "sell" ? (asset === "xTOMB" ? c.level : c.square) : c.usdc) : undefined;
  const raw = amountIn > 0 ? (side === "sell" ? parseUnits(amountIn.toFixed(18), 18) : parseUnits(amountIn.toFixed(6), 6)) : 0n;
  const allowanceRead = useReadContracts({
    allowFailure: true,
    contracts: c && tokenIn && net.walletAddress ? [{ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [net.walletAddress, c.miniSwapRouter] }] : [],
    query: { enabled: !!c && !!tokenIn && !!net.walletAddress, refetchInterval: 15_000 },
  });
  const allowance = allowanceRead.data?.[0]?.status === "success" ? (allowanceRead.data[0].result as bigint) : 0n;
  const [state, setState] = useState<{ out: bigint | null; error: string | null }>({ out: null, error: null });

  useEffect(() => {
    if (!c || !key || !tokenIn || !net.walletAddress || raw === 0n || allowance < raw) {
      setState({ out: null, error: null });
      return;
    }
    let cancelled = false;
    const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
    const t = window.setTimeout(async () => {
      try {
        const sim = await simulateContract(config, {
          account: net.walletAddress!,
          address: c.miniSwapRouter,
          abi: miniSwapRouterAbi,
          functionName: "swapExactIn",
          args: [key, zeroForOne, raw, 0n, net.walletAddress!],
        });
        if (!cancelled) setState({ out: sim.result as bigint, error: null });
      } catch (e) {
        if (!cancelled) setState({ out: null, error: (e as Error).message.split("\n")[0] });
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [c, key, tokenIn, raw, allowance, net.walletAddress, config]);

  return { ...state, needsApproval: !!c && raw > 0n && allowance < raw };
}
