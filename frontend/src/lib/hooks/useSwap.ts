import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { maxUint160, zeroAddress, type Address } from "viem";

import {
  erc20Abi,
  permit2Abi,
  universalRouterAbi,
} from "@/lib/abis";
import { useDeployment } from "./useDeployment";
import { useToast } from "@/components/ToastProvider";
import { encodeV4Swap, type PoolKey } from "@/lib/swap/encodeV4Swap";

/**
 * Orchestrate a UniversalRouter V4 swap.
 *
 * The full chain on a cold cache is FOUR wallet pops:
 *   1. tokenIn.approve(permit2, max)         — first time only, ERC-20 leg
 *   2. permit2.approve(tokenIn, UR, max, exp) — first time only, Permit2 leg
 *   3. UR.execute(commands, inputs, deadline) — every swap
 *
 * The hook reads the current state of (1) and (2) and skips them when allowances
 * are already sufficient. Most users will see a single signature for repeat swaps
 * with the same token + reasonably-soon expiration.
 *
 * Toast lifecycle mirrors useApproveAndCall — pending toast upgraded to success
 * or error in place, with BaseScan link on success.
 *
 * Slippage: amountOutMinimum currently 0n (no protection). Sprint C polish
 * lets the user specify a slippage tolerance (e.g., 50 bps) and we'd multiply
 * the expected output by (10_000 - slippageBps) / 10_000.
 */

const PERMIT2_APPROVE_EXPIRATION = Number(
  BigInt(Math.floor(Date.now() / 1000)) + 30n * 24n * 60n * 60n,
); // 30 days from "now"; refreshed per-submit below

export interface SwapSubmitArgs {
  poolKey: PoolKey;
  zeroForOne: boolean;
  tokenIn: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  onSuccess?: () => void;
}

type SwapState = "idle" | "approvingErc20" | "approvingPermit2" | "swapping" | "done" | "error";

export function useSwap() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const toast = useToast();
  const toastIdRef = useRef<string | null>(null);
  const pendingRef = useRef<SwapSubmitArgs | null>(null);
  const [state, setState] = useState<SwapState>("idle");

  const erc20Approve = useWriteContract();
  const permit2Approve = useWriteContract();
  const swapExec = useWriteContract();

  const erc20Receipt = useWaitForTransactionReceipt({ hash: erc20Approve.data });
  const permit2Receipt = useWaitForTransactionReceipt({ hash: permit2Approve.data });
  const swapReceipt = useWaitForTransactionReceipt({ hash: swapExec.data });

  // Read allowances + permit2 allowance for the in-flight token. We deliberately
  // accept that the caller drives the read via `submit` — we don't pre-subscribe
  // to every potential token. The read happens fresh inside submit().
  const enabledRead = !!deployment && !!pendingRef.current;
  const checkRead = useReadContracts({
    allowFailure: false,
    contracts:
      enabledRead && pendingRef.current && deployment
        ? [
            {
              address: pendingRef.current.tokenIn,
              abi: erc20Abi,
              functionName: "allowance",
              args: [user, deployment.permit2],
            },
            {
              address: deployment.permit2,
              abi: permit2Abi,
              functionName: "allowance",
              args: [user, pendingRef.current.tokenIn, deployment.universalRouter],
            },
          ]
        : [],
    query: { enabled: enabledRead },
  });

  // ----- State machine transitions -----

  // ERC-20 approve confirmed → check Permit2 leg
  useEffect(() => {
    if (state !== "approvingErc20") return;
    if (erc20Receipt.isError) return handleError(erc20Approve.error?.message ?? "ERC-20 approve reverted");
    if (erc20Receipt.isSuccess) advanceFromErc20Approved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, erc20Receipt.isSuccess, erc20Receipt.isError]);

  // Permit2 approve confirmed → submit swap
  useEffect(() => {
    if (state !== "approvingPermit2") return;
    if (permit2Receipt.isError) return handleError(permit2Approve.error?.message ?? "Permit2 approve reverted");
    if (permit2Receipt.isSuccess) advanceFromPermit2Approved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, permit2Receipt.isSuccess, permit2Receipt.isError]);

  // Swap confirmed → done
  useEffect(() => {
    if (state !== "swapping") return;
    if (swapReceipt.isError) return handleError(swapExec.error?.message ?? "Swap reverted");
    if (swapReceipt.isSuccess) {
      const args = pendingRef.current;
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "success",
          title: "Swap Confirmed",
          message: "Tokens delivered to your wallet.",
          txHash: swapExec.data,
        });
      args?.onSuccess?.();
      setState("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, swapReceipt.isSuccess, swapReceipt.isError]);

  // Wallet-side rejections
  useEffect(() => {
    if (state === "approvingErc20" && erc20Approve.isError) {
      handleError(erc20Approve.error?.message ?? "Approval rejected");
    }
    if (state === "approvingPermit2" && permit2Approve.isError) {
      handleError(permit2Approve.error?.message ?? "Permit2 approval rejected");
    }
    if (state === "swapping" && swapExec.isError) {
      handleError(swapExec.error?.message ?? "Swap rejected");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, erc20Approve.isError, permit2Approve.isError, swapExec.isError]);

  function handleError(message: string) {
    const short = message.split("\n")[0]?.slice(0, 120) ?? "Reverted";
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "error",
        title: "Swap · Reverted",
        message: short,
      });
    setState("error");
  }

  function advanceFromErc20Approved() {
    const args = pendingRef.current;
    if (!args || !deployment) return;
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "pending",
        title: "Authorize Permit2",
        message: "Approving Permit2 to spend on UniversalRouter.",
      });
    const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    permit2Approve.writeContract({
      address: deployment.permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [args.tokenIn, deployment.universalRouter, maxUint160, expiration],
    });
    setState("approvingPermit2");
  }

  function advanceFromPermit2Approved() {
    const args = pendingRef.current;
    if (!args || !deployment) return;
    submitSwapCall(args);
  }

  function submitSwapCall(args: SwapSubmitArgs) {
    if (!deployment) return;
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "pending",
        title: "Submit Swap",
        message: "Awaiting your final signature.",
      });
    const { commands, inputs } = encodeV4Swap({
      poolKey: args.poolKey,
      zeroForOne: args.zeroForOne,
      amountIn: args.amountIn,
      amountOutMinimum: args.amountOutMinimum,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    swapExec.writeContract({
      address: deployment.universalRouter,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [commands, inputs, deadline],
    });
    setState("swapping");
  }

  const submit = useCallback(
    async (args: SwapSubmitArgs) => {
      if (!deployment) return;
      pendingRef.current = args;
      setState("idle");
      toastIdRef.current = toast.push({
        variant: "pending",
        title: "Initiating Swap",
        message: "Reading allowances…",
      });

      // Fresh allowance read for this token
      const fresh = await checkRead.refetch();
      const erc20Allowance = (fresh.data?.[0] as bigint) ?? 0n;
      const permit2AllowanceTuple = fresh.data?.[1] as
        | readonly [bigint, number, number]
        | undefined;
      const permit2AllowedAmount = permit2AllowanceTuple?.[0] ?? 0n;
      const permit2ExpiresAt = permit2AllowanceTuple?.[1] ?? 0;
      const now = Math.floor(Date.now() / 1000);

      const needsErc20 = erc20Allowance < args.amountIn;
      const needsPermit2 = permit2AllowedAmount < args.amountIn || permit2ExpiresAt < now;

      if (needsErc20) {
        toastIdRef.current &&
          toast.update(toastIdRef.current, {
            variant: "pending",
            title: "Authorize Permit2 (1/2)",
            message: "Approving Permit2 on the input token.",
          });
        erc20Approve.writeContract({
          address: args.tokenIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.permit2, 2n ** 256n - 1n],
        });
        setState("approvingErc20");
      } else if (needsPermit2) {
        advanceFromErc20Approved();
      } else {
        submitSwapCall(args);
      }
    },
    [deployment, checkRead, erc20Approve, toast],
  );

  const isInFlight =
    state === "approvingErc20" || state === "approvingPermit2" || state === "swapping";

  return { state, submit, isInFlight };
}

// Silence unused import warning — PERMIT2_APPROVE_EXPIRATION is a reference
// constant kept for clarity even though we recompute the actual expiration
// inside `advanceFromErc20Approved` to keep it relative to call time.
void PERMIT2_APPROVE_EXPIRATION;
