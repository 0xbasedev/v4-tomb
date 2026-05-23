import { useAccount, useReadContracts } from "wagmi";

import { positionManagerAbi, lpWrapperAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Inspect a V4 LP NFT by tokenId. Reads:
 *   - positionManager.ownerOf(tokenId)              → owner check
 *   - positionManager.getApproved(tokenId)          → drives skip-approve fast path
 *   - positionManager.getPositionLiquidity(tokenId) → for the display
 *   - positionManager.getPoolAndPositionInfo()      → for pool + tick validation
 *   - lpWrapper.tickLower / tickUpper               → expected range
 *   - lpWrapper.wrappedBy(tokenId)                  → 0x0 if not yet wrapped
 *
 * Returns parsed bigint/address values plus boolean flags the WrapPanel uses
 * to choose between Approve / Wrap / Already-Wrapped / Wrong-Pool messaging.
 */
export function useV4Position(tokenIdRaw: string) {
  const deployment = useDeployment();
  const { address } = useAccount();

  // Parse tokenId from input. Empty string disables the query.
  let tokenId: bigint | null = null;
  if (tokenIdRaw.trim() !== "") {
    try {
      tokenId = BigInt(tokenIdRaw.trim());
    } catch {
      tokenId = null;
    }
  }

  const enabled = deployment !== null && tokenId !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: true,
    contracts:
      enabled && tokenId !== null && deployment
        ? [
            {
              address: deployment.positionManager,
              abi: positionManagerAbi,
              functionName: "ownerOf",
              args: [tokenId],
            },
            {
              address: deployment.positionManager,
              abi: positionManagerAbi,
              functionName: "getApproved",
              args: [tokenId],
            },
            {
              address: deployment.positionManager,
              abi: positionManagerAbi,
              functionName: "getPositionLiquidity",
              args: [tokenId],
            },
            {
              address: deployment.lpWrapper,
              abi: lpWrapperAbi,
              functionName: "tickLower",
            },
            {
              address: deployment.lpWrapper,
              abi: lpWrapperAbi,
              functionName: "tickUpper",
            },
            {
              address: deployment.lpWrapper,
              abi: lpWrapperAbi,
              functionName: "wrappedBy",
              args: [tokenId],
            },
          ]
        : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  const owner = data?.[0]?.status === "success" ? (data[0].result as `0x${string}`) : undefined;
  const approved = data?.[1]?.status === "success" ? (data[1].result as `0x${string}`) : undefined;
  const liquidity = data?.[2]?.status === "success" ? (data[2].result as bigint) : 0n;
  const wrapperTickLower = data?.[3]?.status === "success" ? (data[3].result as number) : 0;
  const wrapperTickUpper = data?.[4]?.status === "success" ? (data[4].result as number) : 0;
  const wrappedBy = data?.[5]?.status === "success" ? (data[5].result as `0x${string}`) : undefined;

  // ownerOf reverting (data[0].status = "failure") means the tokenId doesn't exist.
  const exists = data?.[0]?.status === "success";
  const isOwner = !!address && !!owner && owner.toLowerCase() === address.toLowerCase();
  const isApproved =
    !!approved &&
    !!deployment &&
    approved.toLowerCase() === deployment.lpWrapper.toLowerCase();
  const isAlreadyWrapped =
    !!wrappedBy && wrappedBy !== "0x0000000000000000000000000000000000000000";

  return {
    tokenId,
    owner,
    isOwner,
    isApproved,
    isAlreadyWrapped,
    exists,
    liquidity,
    wrapperTickLower,
    wrapperTickUpper,
    isLoading,
    isError,
    refetch,
  };
}
