import { useReadContracts } from "wagmi";

import { erc20Abi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Aggregate token-supply read across LEVEL, SQUARE, and BOND. One
 * multicall — three totalSupply() reads.
 */
export function useTokenSupplies() {
  const deployment = useDeployment();
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: deployment.peg, abi: erc20Abi, functionName: "totalSupply" },
          { address: deployment.share, abi: erc20Abi, functionName: "totalSupply" },
          { address: deployment.bond, abi: erc20Abi, functionName: "totalSupply" },
        ]
      : [],
    query: { enabled, refetchInterval: 30_000 },
  });

  return {
    pegSupply: data?.[0],
    shareSupply: data?.[1],
    bondSupply: data?.[2],
    isLoading,
    isError,
    refetch,
  };
}
