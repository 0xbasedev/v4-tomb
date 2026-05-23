import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { maxUint160, zeroAddress, type Address } from "viem";

import { erc20Abi, permit2Abi, positionManagerAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";
import { useToast } from "@/components/ToastProvider";
import { encodeMintPosition } from "@/lib/swap/encodeMintPosition";
import type { PoolKey } from "@/lib/swap/encodeV4Swap";

/**
 * Mint a MONEY-WETH V4 LP position via PositionManager.modifyLiquidities.
 *
 * Full chain on a cold cache is FIVE wallet pops:
 *   1. MONEY.approve(permit2, max)
 *   2. WETH.approve(permit2, max)
 *   3. permit2.approve(MONEY, positionManager, max, exp)
 *   4. permit2.approve(WETH, positionManager, max, exp)
 *   5. positionManager.modifyLiquidities(MINT_POSITION + SETTLE_PAIR, deadline)
 *
 * Repeat mints with valid Permit2 grants collapse to step 5 only.
 *
 * The mint emits Transfer(0x0, recipient, tokenId) from the PositionManager,
 * so post-success we surface the new tokenId. The user then has the option
 * to wrap it in the WrapPanel below.
 */

export interface MintSubmitArgs {
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  /** Pre-computed liquidity (callable code uses TickMath + LiquidityAmounts). */
  liquidity: bigint;
  /** Caps on the actual amounts pulled (slippage protection). */
  amount0Max: bigint;
  amount1Max: bigint;
  /** Owner of the new NFT. */
  recipient: Address;
  /** Token addresses for the approval reads/writes (sorted: currency0 < currency1). */
  token0: Address;
  token1: Address;
  onSuccess?: (txHash: `0x${string}`) => void;
}

type MintState =
  | "idle"
  | "approvingErc20A"
  | "approvingErc20B"
  | "approvingPermit2A"
  | "approvingPermit2B"
  | "minting"
  | "done"
  | "error";

export function useMintPosition() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const toast = useToast();
  const toastIdRef = useRef<string | null>(null);
  const pendingRef = useRef<MintSubmitArgs | null>(null);
  const [state, setState] = useState<MintState>("idle");

  const erc20ApproveA = useWriteContract();
  const erc20ApproveB = useWriteContract();
  const permit2ApproveA = useWriteContract();
  const permit2ApproveB = useWriteContract();
  const mintExec = useWriteContract();

  const r1 = useWaitForTransactionReceipt({ hash: erc20ApproveA.data });
  const r2 = useWaitForTransactionReceipt({ hash: erc20ApproveB.data });
  const r3 = useWaitForTransactionReceipt({ hash: permit2ApproveA.data });
  const r4 = useWaitForTransactionReceipt({ hash: permit2ApproveB.data });
  const r5 = useWaitForTransactionReceipt({ hash: mintExec.data });

  const checkRead = useReadContracts({
    allowFailure: false,
    contracts:
      deployment && pendingRef.current
        ? [
            {
              address: pendingRef.current.token0,
              abi: erc20Abi,
              functionName: "allowance",
              args: [user, deployment.permit2],
            },
            {
              address: pendingRef.current.token1,
              abi: erc20Abi,
              functionName: "allowance",
              args: [user, deployment.permit2],
            },
            {
              address: deployment.permit2,
              abi: permit2Abi,
              functionName: "allowance",
              args: [user, pendingRef.current.token0, deployment.positionManager],
            },
            {
              address: deployment.permit2,
              abi: permit2Abi,
              functionName: "allowance",
              args: [user, pendingRef.current.token1, deployment.positionManager],
            },
          ]
        : [],
    query: { enabled: !!deployment && !!pendingRef.current },
  });

  // ----- State transitions ----- (cascade as receipts confirm)

  useEffect(() => {
    if (state === "approvingErc20A" && r1.isError)
      return handleError(erc20ApproveA.error?.message ?? "Token0 approve reverted");
    if (state === "approvingErc20A" && r1.isSuccess) advanceErc20BOrPermit2OrMint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, r1.isSuccess, r1.isError]);

  useEffect(() => {
    if (state === "approvingErc20B" && r2.isError)
      return handleError(erc20ApproveB.error?.message ?? "Token1 approve reverted");
    if (state === "approvingErc20B" && r2.isSuccess) advancePermit2OrMint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, r2.isSuccess, r2.isError]);

  useEffect(() => {
    if (state === "approvingPermit2A" && r3.isError)
      return handleError(permit2ApproveA.error?.message ?? "Permit2 (token0) reverted");
    if (state === "approvingPermit2A" && r3.isSuccess) advancePermit2BOrMint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, r3.isSuccess, r3.isError]);

  useEffect(() => {
    if (state === "approvingPermit2B" && r4.isError)
      return handleError(permit2ApproveB.error?.message ?? "Permit2 (token1) reverted");
    if (state === "approvingPermit2B" && r4.isSuccess) submitMintCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, r4.isSuccess, r4.isError]);

  useEffect(() => {
    if (state !== "minting") return;
    if (r5.isError) return handleError(mintExec.error?.message ?? "Mint reverted");
    if (r5.isSuccess && mintExec.data) {
      const args = pendingRef.current;
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "success",
          title: "Position Minted",
          message: "Your V4 LP NFT is in your wallet. Wrap it below to stake.",
          txHash: mintExec.data,
        });
      args?.onSuccess?.(mintExec.data);
      setState("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, r5.isSuccess, r5.isError]);

  // Wallet-side rejections
  useEffect(() => {
    if (state === "approvingErc20A" && erc20ApproveA.isError) handleError(erc20ApproveA.error?.message ?? "Rejected");
    if (state === "approvingErc20B" && erc20ApproveB.isError) handleError(erc20ApproveB.error?.message ?? "Rejected");
    if (state === "approvingPermit2A" && permit2ApproveA.isError) handleError(permit2ApproveA.error?.message ?? "Rejected");
    if (state === "approvingPermit2B" && permit2ApproveB.isError) handleError(permit2ApproveB.error?.message ?? "Rejected");
    if (state === "minting" && mintExec.isError) handleError(mintExec.error?.message ?? "Rejected");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, erc20ApproveA.isError, erc20ApproveB.isError, permit2ApproveA.isError, permit2ApproveB.isError, mintExec.isError]);

  // ----- Internal advancers -----

  function handleError(message: string) {
    const short = message.split("\n")[0]?.slice(0, 120) ?? "Reverted";
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "error",
        title: "Mint Position · Reverted",
        message: short,
      });
    setState("error");
  }

  async function advanceErc20BOrPermit2OrMint() {
    if (!deployment || !pendingRef.current) return;
    const args = pendingRef.current;
    const fresh = await checkRead.refetch();
    const token1Erc20 = (fresh.data?.[1] as bigint) ?? 0n;
    if (token1Erc20 < args.amount1Max) {
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "pending",
          title: "Authorize Token (2/2)",
          message: "Approving Permit2 on the other token.",
        });
      erc20ApproveB.writeContract({
        address: args.token1,
        abi: erc20Abi,
        functionName: "approve",
        args: [deployment.permit2, 2n ** 256n - 1n],
      });
      setState("approvingErc20B");
    } else {
      advancePermit2OrMint();
    }
  }

  async function advancePermit2OrMint() {
    if (!deployment || !pendingRef.current) return;
    const args = pendingRef.current;
    const fresh = await checkRead.refetch();
    const a = fresh.data?.[2] as readonly [bigint, number, number] | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!a || a[0] < args.amount0Max || a[1] < now) {
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "pending",
          title: "Authorize Permit2 (1/2)",
          message: "Approving PositionManager on token0.",
        });
      const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      permit2ApproveA.writeContract({
        address: deployment.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [args.token0, deployment.positionManager, maxUint160, exp],
      });
      setState("approvingPermit2A");
    } else {
      advancePermit2BOrMint();
    }
  }

  async function advancePermit2BOrMint() {
    if (!deployment || !pendingRef.current) return;
    const args = pendingRef.current;
    const fresh = await checkRead.refetch();
    const b = fresh.data?.[3] as readonly [bigint, number, number] | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!b || b[0] < args.amount1Max || b[1] < now) {
      toastIdRef.current &&
        toast.update(toastIdRef.current, {
          variant: "pending",
          title: "Authorize Permit2 (2/2)",
          message: "Approving PositionManager on token1.",
        });
      const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      permit2ApproveB.writeContract({
        address: deployment.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [args.token1, deployment.positionManager, maxUint160, exp],
      });
      setState("approvingPermit2B");
    } else {
      submitMintCall();
    }
  }

  function submitMintCall() {
    if (!deployment || !pendingRef.current) return;
    const args = pendingRef.current;
    toastIdRef.current &&
      toast.update(toastIdRef.current, {
        variant: "pending",
        title: "Submit Mint",
        message: "Awaiting your final signature.",
      });
    const unlockData = encodeMintPosition({
      poolKey: args.poolKey,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      liquidity: args.liquidity,
      amount0Max: args.amount0Max,
      amount1Max: args.amount1Max,
      recipient: args.recipient,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    mintExec.writeContract({
      address: deployment.positionManager,
      abi: positionManagerAbi,
      functionName: "modifyLiquidities",
      args: [unlockData, deadline],
    });
    setState("minting");
  }

  const submit = useCallback(
    async (args: MintSubmitArgs) => {
      if (!deployment) return;
      pendingRef.current = args;
      setState("idle");
      toastIdRef.current = toast.push({
        variant: "pending",
        title: "Initiating Mint",
        message: "Reading allowances…",
      });
      const fresh = await checkRead.refetch();
      const token0Erc20 = (fresh.data?.[0] as bigint) ?? 0n;
      if (token0Erc20 < args.amount0Max) {
        toastIdRef.current &&
          toast.update(toastIdRef.current, {
            variant: "pending",
            title: "Authorize Token (1/2)",
            message: "Approving Permit2 on the first token.",
          });
        erc20ApproveA.writeContract({
          address: args.token0,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.permit2, 2n ** 256n - 1n],
        });
        setState("approvingErc20A");
      } else {
        advanceErc20BOrPermit2OrMint();
      }
    },
    [deployment, checkRead, erc20ApproveA, toast],
  );

  const isInFlight =
    state === "approvingErc20A" ||
    state === "approvingErc20B" ||
    state === "approvingPermit2A" ||
    state === "approvingPermit2B" ||
    state === "minting";

  return { state, submit, isInFlight };
}
