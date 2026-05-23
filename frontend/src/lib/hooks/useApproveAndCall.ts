import { useCallback, useEffect, useRef, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import type { Address, Abi } from "viem";

import { erc20Abi } from "@/lib/abis";
import { useToast } from "@/components/ToastProvider";

/**
 * Orchestrate "approve (if needed) → call → refetch" in one hook.
 *
 * Internal state machine:
 *   idle → approving → awaitApprove → calling → awaitCall → done | error
 *
 * Submit-time parameters: the consumer supplies the amount + call config to
 * submit() rather than to the hook itself. This avoids the closure-capture
 * issue where ActionPanel's setState+submit dance would otherwise miss the
 * just-typed amount.
 */

export type CallState =
  | "idle"
  | "approving"
  | "awaitApprove"
  | "calling"
  | "awaitCall"
  | "done"
  | "error";

export interface SubmitArgs {
  /** Amount being approved + executed (wei). 0n if no approve leg needed. */
  amount: bigint;
  /** Currently observed allowance. If >= amount, skips approve. */
  currentAllowance: bigint;
  /** Token to approve. null skips the approve leg entirely. */
  token: Address | null;
  /** Spender that needs the allowance. */
  spender: Address | null;
  /** Address + ABI + function + args for the actual call. */
  call: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  };
  /** Short label shown in toasts ("Stake into The Club"). */
  label: string;
  /** Called once after the actual call's receipt confirms. */
  onSuccess?: () => void;
}

export function useApproveAndCall() {
  const [state, setState] = useState<CallState>("idle");
  const toast = useToast();
  const toastIdRef = useRef<string | null>(null);
  /** Hold the call config + onSuccess across the approve→call pipeline. */
  const pendingRef = useRef<SubmitArgs | null>(null);

  const approve = useWriteContract();
  const exec = useWriteContract();

  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const execReceipt = useWaitForTransactionReceipt({ hash: exec.data });

  useEffect(() => {
    if (state === "approving" && approve.data) setState("awaitApprove");
  }, [state, approve.data]);
  useEffect(() => {
    if (state === "calling" && exec.data) setState("awaitCall");
  }, [state, exec.data]);

  // Approve mined → start the actual call
  useEffect(() => {
    if (state !== "awaitApprove") return;
    if (approveReceipt.isError) {
      handleError(approve.error?.message ?? "Approval reverted");
      return;
    }
    if (approveReceipt.isSuccess && pendingRef.current) {
      const args = pendingRef.current;
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "pending",
          title: args.label,
          message: "Awaiting your signature for the second step.",
        });
      exec.writeContract(args.call);
      setState("calling");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, approveReceipt.isSuccess, approveReceipt.isError]);

  // Exec mined → done
  useEffect(() => {
    if (state !== "awaitCall") return;
    if (execReceipt.isError) {
      handleError(exec.error?.message ?? "Transaction reverted");
      return;
    }
    if (execReceipt.isSuccess && pendingRef.current) {
      const args = pendingRef.current;
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "success",
          title: `${args.label} · Confirmed`,
          message: "The Trust acknowledges your action.",
          txHash: exec.data,
        });
      args.onSuccess?.();
      setState("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, execReceipt.isSuccess, execReceipt.isError]);

  // Wallet-side rejection on either leg
  useEffect(() => {
    if (state === "approving" && approve.isError) {
      handleError(approve.error?.message ?? "Approval rejected");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, approve.isError]);
  useEffect(() => {
    if (state === "calling" && exec.isError) {
      handleError(exec.error?.message ?? "Transaction rejected");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, exec.isError]);

  function handleError(message: string) {
    const short = message.split("\n")[0]?.slice(0, 120) ?? "Reverted";
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "error",
        title: `${pendingRef.current?.label ?? "Transaction"} · Reverted`,
        message: short,
      });
    setState("error");
  }

  const submit = useCallback(
    (args: SubmitArgs) => {
      pendingRef.current = args;
      setState("idle");
      toastIdRef.current = toast.push({
        variant: "pending",
        title: args.label,
        message: "Awaiting your signature.",
      });

      const needsApprove =
        args.token !== null && args.spender !== null && args.currentAllowance < args.amount;
      if (needsApprove && args.token && args.spender) {
        approve.writeContract({
          address: args.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [args.spender, args.amount],
        });
        setState("approving");
      } else {
        exec.writeContract(args.call);
        setState("calling");
      }
    },
    [approve, exec, toast],
  );

  const isInFlight =
    state === "approving" ||
    state === "awaitApprove" ||
    state === "calling" ||
    state === "awaitCall";

  return { state, submit, isInFlight };
}
