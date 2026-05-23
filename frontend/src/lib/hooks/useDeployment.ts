import { useChainId } from "wagmi";

import { getDeployment, type OldMoneyDeployment } from "@/lib/addresses";

/**
 * Resolve the deployed contract map for the connected wallet's chain. Returns
 * null if the chain has no deployment yet (e.g., Base mainnet pre-launch).
 *
 * Frontend components should branch on `deployment === null` and render a clear
 * "wrong chain" or "not yet deployed" message rather than crashing.
 */
export function useDeployment(): OldMoneyDeployment | null {
  const chainId = useChainId();
  return getDeployment(chainId);
}
