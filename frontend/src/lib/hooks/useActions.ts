import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { useConfig } from "wagmi";
import { getAccount, getPublicClient, readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  isAddressEqual,
  parseAbiItem,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type Log,
} from "viem";

import { useToast } from "@/components/ToastProvider";
import {
  erc20Abi,
  masonryAbi,
  miniSwapRouterAbi,
  pegDefenseHookAbi,
  permit2Abi,
  positionManagerAbi,
  positionWrapperAbi,
  shareBuybackHookAbi,
} from "@/lib/abis";
import { encodeBurnPosition } from "@/lib/swap/encodeBurnPosition";
import { encodeMintPosition } from "@/lib/swap/encodeMintPosition";
import type { PoolKey } from "@/lib/swap/poolKey";
import { maxUsableTick, minUsableTick } from "@/lib/swap/tickMath";
import { sameWalletSession } from "@/lib/walletSession";
import type { FarmPool, FarmState } from "./useFarm";
import { useNetworkStatus } from "./useNetworkStatus";

interface Approval {
  token: Address;
  spender: Address;
  amount: bigint;
}
export interface CallStep {
  label: string;
  /** ERC-20 allowances this step needs. Each is checked first and only requested when short. */
  approvals?: Approval[];
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

const ERC721_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

function decode(e: unknown): string {
  if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) {
    return "You declined in your wallet. Nothing was sent.";
  }
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert?.data?.errorName) return `Reverted: ${revert.data.errorName}`;
    return e.shortMessage;
  }
  return (e as Error)?.message?.split("\n")[0] ?? "Failed";
}

/**
 * Every write the interface can make, against this repo's contracts only.
 *
 * One pipeline (`run`) for all of them:
 *   1. refuse unless the wallet is on a network with a deployment
 *   2. for each step: top up only the allowances that are short (exact amounts,
 *      never unlimited), simulate the call, then ask for one signature
 *   3. before every signature, re-check that the wallet account and chain are
 *      the ones the flow started on — a mid-flow switch aborts, nothing is sent
 *   4. wait for the receipt, then refetch every read
 */
export function useActions() {
  const net = useNetworkStatus();
  const toast = useToast();
  const config = useConfig();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const run = useCallback(
    async (title: string, build: CallStep[] | (() => Promise<CallStep[]>)): Promise<Log[] | null> => {
      const d = net.deployment;
      if (!net.canTransact || !net.account || !d) {
        toast.push({ variant: "info", title, message: net.reason ?? "Transactions are unavailable." });
        return null;
      }
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      const origin = { address: net.account, chainId: d.chainId };
      const account = origin.address;
      const chainId = origin.chainId;
      const still = () => {
        const a = getAccount(config);
        if (!sameWalletSession(origin, { address: a.address, chainId: a.chainId })) {
          throw new Error("The wallet account or network changed. Nothing was sent; start again.");
        }
      };
      const id = toast.push({ variant: "pending", title, message: "Checking…" });
      const logs: Log[] = [];
      let actionSubmitted = false;
      let approvalSubmitted = false;
      let succeeded = false;
      try {
        const steps = typeof build === "function" ? await build() : build;
        if (steps.length === 0) throw new Error("Nothing to do.");
        for (const step of steps) {
          for (const a of step.approvals ?? []) {
            const allowance = (await readContract(config, {
              chainId,
              address: a.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [account, a.spender],
            })) as bigint;
            if (allowance >= a.amount) continue;
            toast.update(id, { message: `Approve the exact amount for “${step.label}” in your wallet…` });
            still();
            approvalSubmitted = true;
            const h = await writeContract(config, {
              chainId,
              account,
              address: a.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [a.spender, a.amount],
            });
            const r = await waitForTransactionReceipt(config, { chainId, hash: h });
            if (r.status !== "success") throw new Error("The approval reverted.");
          }
          toast.update(id, { message: `Checking ${step.label}…` });
          const call = {
            chainId,
            account,
            address: step.address,
            abi: step.abi,
            functionName: step.functionName,
            args: step.args,
          };
          const sim = await simulateContract(config, call as Parameters<typeof simulateContract>[1]);
          const estimated = await getPublicClient(config, { chainId })!.estimateContractGas(call);
          toast.update(id, { message: `Confirm “${step.label}” in your wallet…` });
          still();
          const hash = await writeContract(config, {
            ...sim.request,
            // Hooked V4 calls under-estimate; leave headroom rather than fail on-chain.
            gas: (estimated * 3n) / 2n + 80_000n,
          } as Parameters<typeof writeContract>[1]);
          actionSubmitted = true;
          toast.update(id, { message: `Waiting for ${step.label} to confirm…`, txHash: hash, chainId });
          const receipt = await waitForTransactionReceipt(config, { chainId, hash });
          if (receipt.status !== "success") throw new Error(`${step.label} reverted`);
          logs.push(...receipt.logs);
        }
        toast.update(id, { variant: "success", title: `${title} · Confirmed`, message: "Done." });
        succeeded = true;
      } catch (e) {
        toast.update(id, {
          variant: "error",
          title: `${title} · ${actionSubmitted ? "Failed" : "Not sent"}`,
          message: `${approvalSubmitted && !actionSubmitted ? "An approval was sent, but the action itself was not. " : ""}${decode(e)}`,
        });
      } finally {
        if (actionSubmitted || approvalSubmitted) void queryClient.invalidateQueries();
        busyRef.current = false;
        setBusy(false);
      }
      return succeeded ? logs : null;
    },
    [config, net, toast, queryClient],
  );

  const d = net.deployment;
  const account = net.account;

  return useMemo(() => {
    const done = (logs: Log[] | null) => logs !== null;
    /** No deployment → an honest toast via `run`, never a thrown error. */
    const need = () => d ?? null;

    return {
      busy,
      /** Why writes are unavailable right now; null when they are available. */
      blocked: net.reason,

      // ---- xROOM (Masonry) ----
      roomStake: async (stakeToken: Address, amount: bigint) =>
        done(
          await run("Stake in xROOM", need() ? [
            { label: "stake", approvals: [{ token: stakeToken, spender: d!.masonry, amount }], address: d!.masonry, abi: masonryAbi as Abi, functionName: "stake", args: [amount] },
          ] : []),
        ),
      roomWithdraw: async (amount: bigint) =>
        done(await run("Withdraw from xROOM", need() ? [{ label: "withdraw", address: d!.masonry, abi: masonryAbi as Abi, functionName: "withdraw", args: [amount] }] : [])),
      roomClaim: async () =>
        done(await run("Claim xROOM rewards", need() ? [{ label: "claim", address: d!.masonry, abi: masonryAbi as Abi, functionName: "claimReward", args: [] }] : [])),
      roomExit: async () =>
        done(await run("Exit xROOM", need() ? [{ label: "exit", address: d!.masonry, abi: masonryAbi as Abi, functionName: "exit", args: [] }] : [])),

      // ---- GenesisRewardPool / PegFarm / ShareFarm ----
      farmDeposit: async (farm: FarmState, pool: FarmPool, amount: bigint) =>
        done(
          await run(`Deposit ${pool.symbol}`, farm.address ? [
            { label: "deposit", approvals: [{ token: pool.token, spender: farm.address, amount }], address: farm.address, abi: farm.abi, functionName: "deposit", args: [BigInt(pool.pid), amount] },
          ] : []),
        ),
      farmWithdraw: async (farm: FarmState, pool: FarmPool, amount: bigint) =>
        done(await run(`Withdraw ${pool.symbol}`, farm.address ? [{ label: "withdraw", address: farm.address, abi: farm.abi, functionName: "withdraw", args: [BigInt(pool.pid), amount] }] : [])),
      /** A zero deposit pays out pending rewards and moves no stake. */
      farmClaim: async (farm: FarmState, pool: FarmPool) =>
        done(await run("Claim rewards", farm.address ? [{ label: "claim", address: farm.address, abi: farm.abi, functionName: "deposit", args: [BigInt(pool.pid), 0n] }] : [])),
      /** Returns the stake and FORFEITS pending rewards. */
      farmEmergencyWithdraw: async (farm: FarmState, pool: FarmPool) =>
        done(await run("Emergency withdraw", farm.address ? [{ label: "emergency withdraw", address: farm.address, abi: farm.abi, functionName: "emergencyWithdraw", args: [BigInt(pool.pid)] }] : [])),

      // ---- MiniSwapRouter (always the overload with a deadline) ----
      swap: async (a: { key: PoolKey; zeroForOne: boolean; tokenIn: Address; amountIn: bigint; minOut: bigint; deadlineSeconds?: number }) =>
        done(
          await run("Swap", need() && account ? [
            {
              label: "swap",
              approvals: [{ token: a.tokenIn, spender: d!.miniSwapRouter, amount: a.amountIn }],
              address: d!.miniSwapRouter,
              abi: miniSwapRouterAbi as Abi,
              functionName: "swapExactIn",
              args: [a.key, a.zeroForOne, a.amountIn, a.minOut, account, BigInt(Math.floor(Date.now() / 1000) + (a.deadlineSeconds ?? 600))],
            },
          ] : []),
        ),

      // ---- Uniswap V4 PositionManager: full-range position → wrapper ----
      /** Mints a full-range position. Resolves to the new NFT id (null if it could not be read back). */
      mintPosition: async (a: { key: PoolKey; liquidity: bigint; amount0Max: bigint; amount1Max: bigint }): Promise<{ ok: boolean; tokenId: bigint | null }> => {
        const logs = await run("Mint liquidity position", async () => {
          if (!d || !account) return [];
          const steps: CallStep[] = [];
          const carried: Approval[] = [];
          const sides: [Address, bigint][] = [
            [a.key.currency0, a.amount0Max],
            [a.key.currency1, a.amount1Max],
          ];
          const nowSec = Math.floor(Date.now() / 1000);
          // The PositionManager pulls through Permit2: token → Permit2 (ERC-20 allowance),
          // then Permit2 → PositionManager (a Permit2 allowance, short-lived and exact).
          for (const [token, amount] of sides) {
            const [allowed, expiry] = (await readContract(config, {
              chainId: d.chainId,
              address: d.permit2,
              abi: permit2Abi,
              functionName: "allowance",
              args: [account, token, d.positionManager],
            })) as readonly [bigint, number, number];
            const erc20 = { token, spender: d.permit2, amount };
            if (allowed >= amount && Number(expiry) > nowSec + 120) {
              carried.push(erc20);
              continue;
            }
            steps.push({
              label: "Permit2 allowance",
              approvals: [erc20],
              address: d.permit2,
              abi: permit2Abi as Abi,
              functionName: "approve",
              args: [token, d.positionManager, amount, nowSec + 1800],
            });
          }
          steps.push({
            label: "mint position",
            approvals: carried,
            address: d.positionManager,
            abi: positionManagerAbi as Abi,
            functionName: "modifyLiquidities",
            args: [
              encodeMintPosition({
                poolKey: a.key,
                tickLower: minUsableTick(a.key.tickSpacing),
                tickUpper: maxUsableTick(a.key.tickSpacing),
                liquidity: a.liquidity,
                amount0Max: a.amount0Max,
                amount1Max: a.amount1Max,
                recipient: account,
              }),
              BigInt(nowSec + 1800),
            ],
          });
          return steps;
        });
        if (!logs || !d || !account) return { ok: false, tokenId: null };
        let tokenId: bigint | null = null;
        try {
          const minted = parseEventLogs({ abi: [ERC721_TRANSFER], eventName: "Transfer", logs }).find(
            (l) => isAddressEqual(l.address, d.positionManager) && l.args.from === zeroAddress && isAddressEqual(l.args.to, account),
          );
          tokenId = minted?.args.tokenId ?? null;
        } catch {
          /* the mint still succeeded; the id can be typed in by hand */
        }
        return { ok: true, tokenId };
      },
      /** Approves the wrapper for this one NFT (only if needed), then wraps it into stakeable ERC-20 shares. */
      wrapPosition: async (wrapper: Address, tokenId: bigint) =>
        done(
          await run("Wrap position", async () => {
            if (!d) return [];
            const approved = (await readContract(config, { chainId: d.chainId, address: d.positionManager, abi: positionManagerAbi, functionName: "getApproved", args: [tokenId] })) as Address;
            const steps: CallStep[] = [];
            if (!isAddressEqual(approved, wrapper)) {
              steps.push({ label: "approve this NFT", address: d.positionManager, abi: positionManagerAbi as Abi, functionName: "approve", args: [wrapper, tokenId] });
            }
            steps.push({ label: "wrap", address: wrapper, abi: positionWrapperAbi as Abi, functionName: "wrap", args: [tokenId] });
            return steps;
          }),
        ),
      /** Burns the wrapper shares and returns the NFT. Only the address that wrapped it can. */
      unwrapPosition: async (wrapper: Address, tokenId: bigint) =>
        done(await run("Unwrap position", need() ? [{ label: "unwrap", address: wrapper, abi: positionWrapperAbi as Abi, functionName: "unwrap", args: [tokenId] }] : [])),
      /** Removes all liquidity, burns the NFT and returns both tokens. Minimums protect against a moved price. */
      burnPosition: async (a: { key: PoolKey; tokenId: bigint; amount0Min: bigint; amount1Min: bigint }) =>
        done(
          await run("Remove liquidity", need() && account ? [
            {
              label: "remove liquidity",
              address: d!.positionManager,
              abi: positionManagerAbi as Abi,
              functionName: "modifyLiquidities",
              args: [
                encodeBurnPosition({ tokenId: a.tokenId, amount0Min: a.amount0Min, amount1Min: a.amount1Min, currency0: a.key.currency0, currency1: a.key.currency1, recipient: account }),
                BigInt(Math.floor(Date.now() / 1000) + 1800),
              ],
            },
          ] : []),
        ),

      // ---- Permissionless upkeep: anyone may call these, they only move value to the burn or the fee recipient ----
      pokeTaxRate: async () =>
        done(await run("Advance the tax ratchet", need() ? [{ label: "pokeTaxRate", address: d!.hook, abi: pegDefenseHookAbi as Abi, functionName: "pokeTaxRate", args: [] }] : [])),
      settleDeferredTax: async () =>
        done(await run("Settle deferred tax", need() ? [{ label: "settleDeferredTax", address: d!.hook, abi: pegDefenseHookAbi as Abi, functionName: "settleDeferredTax", args: [] }] : [])),
      executeBuyback: async () =>
        done(await run("Execute buyback", need() ? [{ label: "executeBuyback", address: d!.shareBuybackHook, abi: shareBuybackHookAbi as Abi, functionName: "executeBuyback", args: [] }] : [])),
    };
  }, [busy, net.reason, run, d, account, config]);
}
