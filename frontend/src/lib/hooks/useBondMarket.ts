import { useAccount, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";

import { erc20Abi, treasuryAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Bond market read — Bonds page state. Combines:
 *
 *   - getBondDiscountRate / getBondPremiumRate (Treasury views; return 0 outside
 *     their active band, which matches the UI's "Bonds are not issued" copy)
 *   - getBurnablePegLeft (acquisition headroom this epoch)
 *   - getRedeemableBonds (Treasury reserve depth)
 *   - LEVEL balance in wallet (for the burn input MAX)
 *   - BOND balance in wallet (for the present input MAX)
 *   - BOND allowance for Treasury (T9 approve gate)
 *   - LEVEL allowance for Treasury (T9 approve gate)
 *   - BOND.totalSupply (Bonds Outstanding tile)
 *
 * Rates are 1e18-scaled. Frontend converts to a multiplier (rate / 1e18) for
 * display in the BondForm.
 */
export function useBondMarket() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getBondDiscountRate" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getBondPremiumRate" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getBurnablePegLeft" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getRedeemableBonds" },
          { address: deployment.peg, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          { address: deployment.bond, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          {
            address: deployment.peg,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, deployment.treasury],
          },
          {
            address: deployment.bond,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, deployment.treasury],
          },
          { address: deployment.bond, abi: erc20Abi, functionName: "totalSupply" },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  const grab = (i: number): bigint =>
    data?.[i]?.status === "success" ? (data[i].result as bigint) : 0n;

  return {
    discountRate: grab(0),
    premiumRate: grab(1),
    burnableLeft: grab(2),
    redeemableBonds: grab(3),
    pegInWallet: grab(4),
    bondsInWallet: grab(5),
    pegAllowance: grab(6),
    bondAllowance: grab(7),
    bondSupply: grab(8),
    isLoading,
    isError,
    refetch,
  };
}
