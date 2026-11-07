import { useCallback, useRef, useState } from "react";
import { useConfig } from "wagmi";
import { getAccount, readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, erc20Abi, isAddressEqual, maxUint256, parseUnits, type Abi, type Address } from "viem";

import { useToast } from "@/components/ToastProvider";
import {
  masonryGenesisPassAbi,
  masonryGenesisSettlementAbi,
  masonryGenesisStakingAbi,
  masonryLevelUsdcVaultAbi,
  masonrySquareUsdcVaultAbi,
  iMasonryExactInputV4RouterAbi,
} from "@/lib/abis/masonry";
import type { TaxedAsset } from "@/lib/fireTax";
import { PASSES, PASS_TIER_ID, type PassTier } from "@/lib/launch";
import { PRIMARY } from "@/lib/networks";
import { PREVIEW_KEEPER, simulateTx, usePreview } from "@/lib/preview";
import type { TokenId } from "@/lib/tokens";
import { useNetworkStatus } from "./useNetworkStatus";

/**
 * Every write the app can make, gated in one place:
 *
 *   Preview  → mutate the simulated chain + "Simulated" toast. The wallet is
 *              never asked to sign, approve or send anything.
 *   Not ready (disconnected / unsupported / undeployed) → an explanatory toast,
 *              no request.
 *   Ready    → for each step: approve only if the allowance is short, then
 *              simulate the call (eth_call) and only on success ask the wallet
 *              to send it. Reverts are decoded into the contract's error name.
 */

interface Approval {
  token: Address;
  spender: Address;
  amount: bigint;
}
interface CallStep {
  label: string;
  approvals?: Approval[];
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

function decode(e: unknown): string {
  if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return "You declined in your wallet. Nothing was sent.";
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert?.data?.errorName) return `Reverted: ${revert.data.errorName}`;
    return e.shortMessage;
  }
  return (e as Error)?.message?.split("\n")[0] ?? "Failed";
}

export function useActions() {
  const preview = usePreview();
  const net = useNetworkStatus();
  const toast = useToast();
  const config = useConfig();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const run = useCallback(
    async (title: string, steps: CallStep[], onDone?: () => void) => {
      if (!net.canTransact || !net.walletAddress || !net.deployment) {
        toast.push({ variant: "info", title, message: net.reason ?? "Transactions are unavailable." });
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const account = net.walletAddress;
      const chainId = net.deployment.chainId;
      // The wallet must still be the same account on the deployment's chain at
      // the moment of every signature prompt — not just when the flow began.
      const still = () => {
        const a = getAccount(config);
        if (!a.address || !isAddressEqual(a.address, account) || a.chainId !== chainId) throw new Error("The wallet account or network changed. Nothing was sent; reconnect and try again.");
      };
      const id = toast.push({ variant: "pending", title, message: "Checking…" });
      try {
        for (const step of steps) {
          for (const a of step.approvals ?? []) {
            const allowance = await readContract(config, { address: a.token, abi: erc20Abi, functionName: "allowance", args: [account, a.spender] });
            if (allowance >= a.amount) continue;
            toast.update(id, { message: `Approve ${step.label} in your wallet…` });
            still();
            const h = await writeContract(config, { address: a.token, abi: erc20Abi, functionName: "approve", args: [a.spender, a.amount] });
            await waitForTransactionReceipt(config, { hash: h });
          }
          toast.update(id, { message: `Simulating ${step.label}…` });
          const sim = await simulateContract(config, { account, address: step.address, abi: step.abi, functionName: step.functionName, args: step.args } as Parameters<typeof simulateContract>[1]);
          toast.update(id, { message: `Confirm ${step.label} in your wallet…` });
          still();
          const hash = await writeContract(config, sim.request as Parameters<typeof writeContract>[1]);
          const receipt = await waitForTransactionReceipt(config, { hash });
          if (receipt.status !== "success") throw new Error(`${step.label} reverted`);
          toast.update(id, { txHash: hash });
        }
        toast.update(id, { variant: "success", title: `${title} · Confirmed`, message: "Done." });
        onDone?.();
      } catch (e) {
        toast.update(id, { variant: "error", title: `${title} · Not sent`, message: decode(e) });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [config, net, toast],
  );

  const sim = useCallback(
    (title: string, apply: () => void, onDone?: () => void) => {
      simulateTx(toast, title, () => {
        apply();
        onDone?.();
      });
    },
    [toast],
  );

  const c = net.deployment?.contracts;
  const e18 = (n: number) => parseUnits(n.toFixed(18), 18);
  const e6 = (n: number) => parseUnits(n.toFixed(6), 6);

  return {
    busy,
    sim: preview.enabled,

    purchasePass(tier: PassTier, onDone?: () => void) {
      const label = `Buy ${PASSES[tier].name} pass · ${PASSES[tier].priceUsdc} ${PRIMARY.referenceToken?.symbol ?? "USDC"}`;
      if (preview.enabled) return sim(label, () => preview.act.purchase(tier), onDone);
      if (!c) return run(label, []);
      return run(
        label,
        [
          {
            label: "pass purchase",
            approvals: [{ token: c.usdc, spender: c.pass, amount: e6(PASSES[tier].priceUsdc) }],
            address: c.pass,
            abi: masonryGenesisPassAbi as Abi,
            functionName: "purchase",
            args: [PASS_TIER_ID[tier]],
          },
        ],
        onDone,
      );
    },

    upgradePass(tier: PassTier, held: PassTier, onDone?: () => void) {
      const cost = PASSES[tier].priceUsdc - PASSES[held].priceUsdc;
      const label = `Upgrade to ${PASSES[tier].name} · ${cost} ${PRIMARY.referenceToken?.symbol ?? "USDC"}`;
      if (preview.enabled) return sim(label, () => preview.act.upgrade(tier), onDone);
      if (!c || cost <= 0) return run(label, []);
      return run(label, [{ label: "pass upgrade", approvals: [{ token: c.usdc, spender: c.pass, amount: e6(cost) }], address: c.pass, abi: masonryGenesisPassAbi as Abi, functionName: "upgrade", args: [PASS_TIER_ID[tier]] }], onDone);
    },

    deposit(pool: 0 | 1, amount: number, standardAsset: Address | null, onDone?: () => void) {
      const label = pool === 0 ? `Stake ${amount} in the standard pool` : `Stake ${amount} LP in the xTOMB/USDC pool`;
      if (preview.enabled) return sim(label, () => preview.act.deposit(pool, amount), onDone);
      if (!c) return run(label, []);
      const token = pool === 0 ? standardAsset : c.levelVault;
      if (!token) return run(label, []);
      // Standard asset decimals are deployment-bound; USDC (6) is the reference deployment.
      const raw = pool === 0 && token.toLowerCase() === c.usdc.toLowerCase() ? e6(amount) : e18(amount);
      return run(label, [{ label: "deposit", approvals: [{ token, spender: c.staking, amount: raw }], address: c.staking, abi: masonryGenesisStakingAbi as Abi, functionName: "deposit", args: [BigInt(pool), raw] }], onDone);
    },

    withdraw(pool: 0 | 1, shares: number, onDone?: () => void) {
      const label = `Withdraw from pool ${pool}`;
      if (preview.enabled) return sim(label, () => preview.act.withdraw(pool, shares), onDone);
      if (!c) return run(label, []);
      return run(label, [{ label: "withdraw", address: c.staking, abi: masonryGenesisStakingAbi as Abi, functionName: "withdraw", args: [BigInt(pool), e18(shares)] }], onDone);
    },

    claim(pool: 0 | 1, onDone?: () => void) {
      const label = `Claim from pool ${pool}`;
      if (preview.enabled) return sim(label, () => preview.act.claim(pool), onDone);
      if (!c) return run(label, []);
      return run(label, [{ label: "claim", address: c.staking, abi: masonryGenesisStakingAbi as Abi, functionName: "claim", args: [BigInt(pool)] }], onDone);
    },

    /** plan from lib/compoundPlan.ts (live); Preview computes its own. */
    compound(pool: 0 | 1, plan: { levelToSell: bigint; grossShares: bigint; minNetShares: bigint } | null, onDone?: () => void) {
      const label = `Compound pool ${pool} into the LP pool`;
      if (preview.enabled) return sim(label, () => preview.act.compound(pool, false), onDone);
      if (!c || !plan || !net.walletAddress) return run(label, []);
      return run(
        label,
        [
          {
            label: "compound",
            address: c.staking,
            abi: masonryGenesisStakingAbi as Abi,
            functionName: "compoundToLP",
            args: [BigInt(pool), net.walletAddress, plan.minNetShares, { levelToSell: plan.levelToSell, grossShares: plan.grossShares }],
          },
        ],
        onDone,
      );
    },

    setKeeper(executor: Address | null, minNetShares: number, onDone?: () => void) {
      const label = executor ? "Opt in to keeper compounding" : "Opt out of keeper compounding";
      if (preview.enabled) return sim(label, () => preview.act.setKeeper(executor ? PREVIEW_KEEPER : null, minNetShares), onDone);
      if (!c) return run(label, []);
      return run(
        label,
        [{ label: "keeper setting", address: c.staking, abi: masonryGenesisStakingAbi as Abi, functionName: "setKeeper", args: [executor ?? "0x0000000000000000000000000000000000000000", executor ? e18(minNetShares) : 0n] }],
        onDone,
      );
    },

    release(index: number, onDone?: () => void) {
      const label = `Release a vesting installment (tranche #${index + 1})`;
      if (preview.enabled) return sim(label, () => preview.act.release(index), onDone);
      if (!c) return run(label, []);
      return run(label, [{ label: "release", address: c.settlement, abi: masonryGenesisSettlementAbi as Abi, functionName: "release", args: [BigInt(index)] }], onDone);
    },

    /** One official-pool swap through MiniSwapRouter. `minOut` comes from a prior simulation. */
    swapLeg(asset: TaxedAsset, side: "sell" | "buy", amountIn: number, minOut: bigint, onDone?: () => void) {
      const label = side === "sell" ? `Sell ${asset} for USDC` : `Buy ${asset} with USDC`;
      if (!c || !net.deployment || !net.walletAddress) return run(label, []);
      const key = asset === "xTOMB" ? net.deployment.pools.level : net.deployment.pools.square;
      const assetAddr = asset === "xTOMB" ? c.level : c.square;
      const tokenIn = side === "sell" ? assetAddr : c.usdc;
      const raw = side === "sell" ? e18(amountIn) : e6(amountIn);
      const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
      return run(
        label,
        [{ label: "swap", approvals: [{ token: tokenIn, spender: c.miniSwapRouter, amount: raw }], address: c.miniSwapRouter, abi: iMasonryExactInputV4RouterAbi as Abi, functionName: "swapExactIn", args: [key, zeroForOne, raw, minOut, net.walletAddress] }],
        onDone,
      );
    },

    /** Simulated multi-leg route for Preview (the live UI sends each leg with swapLeg/redeem). */
    simulateRoute(label: string, input: TokenId, output: TokenId, amountIn: number, amountOut: number, sold?: { asset: TaxedAsset; valueUsd: number; rateBps: number }, onDone?: () => void) {
      return sim(label, () => preview.act.swap(input, output, amountIn, amountOut, sold), onDone);
    },

    addLiquidity(lp: "xTOMB-USDC" | "xSHARE-USDC", assetAmount: number, usdcAmount: number, shares: number, onDone?: () => void) {
      const label = `Add liquidity · ${lp}`;
      if (preview.enabled) return sim(label, () => preview.act.addLiquidity(lp, assetAmount, usdcAmount, shares), onDone);
      if (!c || !net.walletAddress) return run(label, []);
      const vault = lp === "xTOMB-USDC" ? c.levelVault : c.squareVault;
      const assetAddr = lp === "xTOMB-USDC" ? c.level : c.square;
      const maxAsset = e18(assetAmount * 1.005);
      const maxUsdc = e6(usdcAmount * 1.005);
      return run(
        label,
        [
          {
            label: "vault deposit",
            approvals: [
              { token: assetAddr, spender: vault, amount: maxAsset },
              { token: c.usdc, spender: vault, amount: maxUsdc },
            ],
            address: vault,
            abi: (lp === "xTOMB-USDC" ? masonryLevelUsdcVaultAbi : masonrySquareUsdcVaultAbi) as Abi,
            functionName: "deposit",
            args: [e18(shares), maxAsset, maxUsdc, net.walletAddress],
          },
        ],
        onDone,
      );
    },

    /**
     * Four-argument redeem with explicit output floors: simulate with zero
     * floors to read the vault's exact outputs, then send with
     * `slippageBps` taken off each.
     */
    async redeem(lp: "xTOMB-USDC" | "xSHARE-USDC", shares: number, slippageBps: number, onDone?: () => void) {
      const label = `Redeem ${lp} shares`;
      if (preview.enabled) return sim(label, () => preview.act.redeem(lp, shares), onDone);
      if (!c || !net.walletAddress || !net.canTransact) return run(label, []);
      const vault = lp === "xTOMB-USDC" ? c.levelVault : c.squareVault;
      const abi = (lp === "xTOMB-USDC" ? masonryLevelUsdcVaultAbi : masonrySquareUsdcVaultAbi) as Abi;
      try {
        const probe = await simulateContract(config, { account: net.walletAddress, address: vault, abi, functionName: "redeem", args: [e18(shares), 0n, 0n, net.walletAddress] } as Parameters<typeof simulateContract>[1]);
        const [assetOut, usdcOut] = probe.result as readonly [bigint, bigint];
        const floor = (x: bigint) => (x * BigInt(10_000 - slippageBps)) / 10_000n;
        return run(label, [{ label: "redeem", address: vault, abi, functionName: "redeem", args: [e18(shares), floor(assetOut), floor(usdcOut), net.walletAddress] }], onDone);
      } catch (e) {
        toast.push({ variant: "error", title: `${label} · Not sent`, message: decode(e) });
      }
    },

    /** Admin: any write against a deployed contract, still simulated first. */
    admin(label: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[], onDone?: () => void) {
      if (preview.enabled) return sim(label, () => preview.act.note(`Admin · ${label}`), onDone);
      return run(label, [{ label, address, abi, functionName, args }], onDone);
    },

    note(label: string) {
      if (preview.enabled) sim(label, () => preview.act.note(label));
    },
  };
}

export const UNLIMITED = maxUint256;
