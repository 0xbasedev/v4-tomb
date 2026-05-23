import { useReadContracts } from "wagmi";

import { treasuryAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Composite epoch state read from the Treasury. Batches three view calls —
 * current epoch, next epoch point, and the constant PERIOD — into one
 * multicall via useReadContracts.
 *
 * Returns parsed BigInt values plus a derived `secondsUntilNextEpoch` based on
 * the most recent block timestamp the user's chain has seen.
 *
 * The hook itself doesn't render the countdown — components consume the raw
 * seconds and format. This keeps the data layer pure.
 */
export function useEpoch() {
  const deployment = useDeployment();
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: deployment.treasury, abi: treasuryAbi, functionName: "epoch" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "nextEpochPoint" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "PERIOD" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "startTime" },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  const epoch = data?.[0];
  const nextEpochPoint = data?.[1];
  const period = data?.[2];
  const startTime = data?.[3];

  const now = BigInt(Math.floor(Date.now() / 1000));
  const secondsUntilNextEpoch =
    nextEpochPoint && nextEpochPoint > now ? Number(nextEpochPoint - now) : 0;

  return {
    epoch,
    nextEpochPoint,
    period,
    startTime,
    secondsUntilNextEpoch,
    isLoading,
    isError,
    refetch,
  };
}
