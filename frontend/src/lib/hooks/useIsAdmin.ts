import { useAccount, useReadContracts } from "wagmi";

import { treasuryAbi, hookAbi, genesisRewardPoolAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Detect whether the connected wallet holds an admin role on any of the
 * protocol's privileged surfaces.
 *
 * Admin slots checked:
 *   - Treasury.operator()              → setExtraFunds, setBootstrap, etc.
 *   - PegDefenseHook.trustees()         → setAutoCalculateTax, setTreasury, etc.
 *   - GenesisRewardPool.operator()      → add() to register stake tokens
 *
 * Pre-governance-rotation, all three slots typically point at the deployer EOA
 * — being "the deployer" therefore unlocks everything. Post-rotation, the
 * Timelock holds all three; an EOA gets `isAdmin: false` and the page renders
 * its restricted-access state.
 *
 * Important: this is a UI gate only. The actual security comes from the
 * onlyOperator / onlyTrustees modifiers on the contracts themselves. A
 * malicious user can route around the page; their transactions revert.
 */
export function useIsAdmin() {
  const deployment = useDeployment();
  const { address, isConnected } = useAccount();

  const enabled = !!deployment && isConnected;

  const { data, isLoading } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: deployment.treasury, abi: treasuryAbi, functionName: "operator" },
          { address: deployment.hook, abi: hookAbi, functionName: "trustees" },
          {
            address: deployment.genesisRewardPool,
            abi: genesisRewardPoolAbi,
            functionName: "operator",
          },
        ]
      : [],
    query: { enabled, refetchInterval: 30_000 },
  });

  const treasuryOperator = data?.[0] as `0x${string}` | undefined;
  const hookTrustees = data?.[1] as `0x${string}` | undefined;
  const genesisOperator = data?.[2] as `0x${string}` | undefined;

  const matches = (addr: `0x${string}` | undefined): boolean =>
    !!address && !!addr && addr.toLowerCase() === address.toLowerCase();

  return {
    isAdmin: matches(treasuryOperator) || matches(hookTrustees) || matches(genesisOperator),
    isTreasuryOperator: matches(treasuryOperator),
    isHookTrustees: matches(hookTrustees),
    isGenesisOperator: matches(genesisOperator),
    treasuryOperator,
    hookTrustees,
    genesisOperator,
    isLoading,
  };
}
