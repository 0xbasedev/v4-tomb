import { useReadContracts } from "wagmi";

import { erc20Abi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Aggregate token-supply read across MONEY, ESTATE, and TRUSTNOTE. One
 * multicall — three totalSupply() reads.
 */
export function useTokenSupplies() {
  const deployment = useDeployment();
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: deployment.money, abi: erc20Abi, functionName: "totalSupply" },
          { address: deployment.estate, abi: erc20Abi, functionName: "totalSupply" },
          { address: deployment.trustNote, abi: erc20Abi, functionName: "totalSupply" },
        ]
      : [],
    query: { enabled, refetchInterval: 30_000 },
  });

  return {
    moneySupply: data?.[0],
    estateSupply: data?.[1],
    trustNoteSupply: data?.[2],
    isLoading,
    isError,
    refetch,
  };
}
