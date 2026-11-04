import { useAccount, useChainId } from "wagmi";

import { getDeployment, type LegacyProtocolDeployment } from "@/lib/addresses";

/**
 * Resolve the deployed contract map for the connected wallet's chain. Returns
 * null if the chain is unsupported or has no complete deployment.
 *
 * Frontend components should branch on `deployment === null` and render a clear
 * "wrong chain" or "not yet deployed" message rather than crashing.
 */
export function useDeployment(): LegacyProtocolDeployment | null {
  const selectedChainId = useChainId();
  const { chainId, isConnected } = useAccount();
  return getDeployment(isConnected ? (chainId ?? -1) : selectedChainId);
}
