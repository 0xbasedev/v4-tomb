import { useAccount, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";

import { erc20Abi, treasuryAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Bond market read — Trust Notes page state. Combines:
 *
 *   - getBondDiscountRate / getBondPremiumRate (Treasury views; return 0 outside
 *     their active band, which matches the UI's "Notes are not issued" copy)
 *   - getBurnableMoneyLeft (acquisition headroom this epoch)
 *   - getRedeemableBonds (Treasury reserve depth)
 *   - MONEY balance in wallet (for the burn input MAX)
 *   - TRUSTNOTE balance in wallet (for the present input MAX)
 *   - TRUSTNOTE allowance for Treasury (T9 approve gate)
 *   - MONEY allowance for Treasury (T9 approve gate)
 *   - TRUSTNOTE.totalSupply (Notes Outstanding tile)
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
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getBurnableMoneyLeft" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getRedeemableBonds" },
          { address: deployment.money, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          { address: deployment.trustNote, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          {
            address: deployment.money,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, deployment.treasury],
          },
          {
            address: deployment.trustNote,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, deployment.treasury],
          },
          { address: deployment.trustNote, abi: erc20Abi, functionName: "totalSupply" },
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
    moneyInWallet: grab(4),
    trustNotesInWallet: grab(5),
    moneyAllowance: grab(6),
    trustNoteAllowance: grab(7),
    trustNoteSupply: grab(8),
    isLoading,
    isError,
    refetch,
  };
}
