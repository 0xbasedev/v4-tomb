import { useTransactionSession } from "./useTransactionSession";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { zeroAddress, type Address } from "viem";

import { erc20Abi, miniSwapRouterAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";
import { useToast } from "@/components/ToastProvider";
import type { PoolKey } from "@/lib/swap/encodeV4Swap";

/**
 * Orchestrate a MiniSwapRouter swap.
 *
 * Replaces the prior UniversalRouter + Permit2 path. Reasoning in
 * src/swap/MiniSwapRouter.sol — Uniswap's UR has shifted ExactInputSingleParams
 * shape across versions, making frontend encoding brittle. Our router takes
 * a single calldata shape we own.
 *
 * Cold-cache flow is 2 wallet pops:
 *   1. tokenIn.approve(router, amountIn)  — plain ERC-20, no Permit2
 *   2. router.swapExactIn(poolKey, zeroForOne, amountIn, minOut, recipient)
 *
 * Repeat swaps in the same direction with the same amount-ish: 1 pop
 * (allowance still good).
 *
 * Slippage protection: amountOutMin is checked inside MiniSwapRouter and
 * reverts cleanly with TooLittleReceived(min, actual) — a real revert reason
 * the frontend / wallet can decode, not the "exceeds max gas" wall we hit
 * with UR.
 */

export interface SwapSubmitArgs {
  poolKey: PoolKey;
  zeroForOne: boolean;
  tokenIn: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  onSuccess?: () => void;
}

type SwapState = "idle" | "checking" | "approving" | "swapping" | "done" | "error";

export function useSwap() {
  const session = useTransactionSession();
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const toast = useToast();
  const toastIdRef = useRef<string | null>(null);
  const pendingRef = useRef<SwapSubmitArgs | null>(null);
  const [state, setState] = useState<SwapState>("idle");

  const approve = useWriteContract();
  const exec = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data, chainId: session.chainId });
  const execReceipt = useWaitForTransactionReceipt({ hash: exec.data, chainId: session.chainId });

  // Track tokenIn allowance for the MiniSwapRouter so submit() can fast-path
  // past approve when the allowance already covers the swap.
  const allowanceRead = useReadContract({
    address: pendingRef.current?.tokenIn,
    abi: erc20Abi,
    functionName: "allowance",
    args: deployment ? [user, deployment.miniSwapRouter] : undefined,
    query: { enabled: !!deployment && !!pendingRef.current?.tokenIn },
  });

  // Approve confirmed → submit swap
  useEffect(() => {
    if (state !== "approving") return;
    if (approveReceipt.isError) {
      handleError(approve.error?.message ?? "Approval reverted");
      return;
    }
    if (approveReceipt.isSuccess) submitSwapCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, approveReceipt.isSuccess, approveReceipt.isError]);

  // Swap confirmed → done
  useEffect(() => {
    if (state !== "swapping") return;
    if (execReceipt.isError) {
      handleError(exec.error?.message ?? "Swap reverted");
      return;
    }
    if (execReceipt.isSuccess) {
      const args = pendingRef.current;
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "success",
          title: "Swap Confirmed",
          message: "Tokens delivered to your wallet.",
          txHash: exec.data,
        });
      args?.onSuccess?.();
      setState("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, execReceipt.isSuccess, execReceipt.isError]);

  // Wallet-side rejections
  useEffect(() => {
    if (state === "approving" && approve.isError) {
      handleError(approve.error?.message ?? "Approval rejected");
    }
    if (state === "swapping" && exec.isError) {
      handleError(exec.error?.message ?? "Swap rejected");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, approve.isError, exec.isError]);

  function handleError(message: string) {
    const short = message.split("\n")[0]?.slice(0, 200) ?? "Reverted";
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "error",
        title: "Swap · Reverted",
        message: short,
      });
    setState("error");
  }

  function submitSwapCall() {
    if (!session.valid()) {
      handleError("Wallet or network changed. Start the action again.");
      return;
    }
    const args = pendingRef.current;
    if (!args || !deployment) return;
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "pending",
        title: "Submit Swap",
        message: "Awaiting your signature.",
      });
    if (!session.valid()) {
      handleError("Wallet or network changed. Start the action again.");
      return;
    }
    exec.writeContract({
      chainId: session.chainId,
      account: session.account,
      address: deployment.miniSwapRouter,
      abi: miniSwapRouterAbi,
      functionName: "swapExactIn",
      args: [
        {
          currency0: args.poolKey.currency0,
          currency1: args.poolKey.currency1,
          fee: args.poolKey.fee,
          tickSpacing: args.poolKey.tickSpacing,
          hooks: args.poolKey.hooks,
        },
        args.zeroForOne,
        args.amountIn,
        args.amountOutMinimum,
        user,
      ],
    });
    setState("swapping");
  }

  const submit = useCallback(
    async (args: SwapSubmitArgs) => {
      if (!deployment) return;
      session.begin();
      if (!session.valid()) return;
      approve.reset();
      exec.reset();
      pendingRef.current = args;
      setState("checking");
      toastIdRef.current = toast.push({
        variant: "pending",
        title: "Initiating Swap",
        message: "Reading allowance…",
      });

      const fresh = await allowanceRead.refetch();
      const currentAllowance = (fresh.data as bigint | undefined) ?? 0n;

      if (currentAllowance < args.amountIn) {
        toastIdRef.current &&
          toast.update(toastIdRef.current, {
            variant: "pending",
            title: "Authorize Token",
            message: "Approving the router to spend your input token.",
          });
        if (!session.valid()) {
          handleError("Wallet or network changed. Start the action again.");
          return;
        }
        approve.writeContract({
          chainId: session.chainId,
          account: session.account,
          address: args.tokenIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.miniSwapRouter, 2n ** 256n - 1n],
        });
        setState("approving");
      } else {
        submitSwapCall();
      }
    },
    [deployment, allowanceRead, approve, toast],
  );

  const isInFlight = state === "checking" || state === "approving" || state === "swapping";

  return { state, submit, isInFlight };
}
