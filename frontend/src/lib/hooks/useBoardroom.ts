import { useAccount, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";

import { boardroomAbi, erc20Abi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Composite Boardroom (The Club) state read.
 *
 * Returns:
 *   totalStaked       — Boardroom.totalSupply (all members' ESTATE)
 *   yourStake         — Boardroom.balanceOf(you)
 *   earned            — claimable MONEY for you
 *   canWithdraw       — false until withdrawLockupEpochs since last stake
 *   canClaimReward    — false until rewardLockupEpochs since last stake
 *   epochTimerStart   — epoch at last stake (used to compute remaining lockup)
 *   withdrawLockupEpochs / rewardLockupEpochs — protocol parameters
 *   estateInWallet    — ESTATE.balanceOf(you), for the stake input's MAX
 *   estateAllowance   — ESTATE → Boardroom allowance, for the approve gate (T9)
 *
 * Anonymous browsing (no wallet) returns zero/false for the user-specific
 * fields but still surfaces the protocol parameters.
 */
export function useBoardroom() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "totalSupply" },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "balanceOf", args: [user] },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "earned", args: [user] },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "canWithdraw", args: [user] },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "canClaimReward", args: [user] },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "members", args: [user] },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "withdrawLockupEpochs" },
          { address: deployment.boardroom, abi: boardroomAbi, functionName: "rewardLockupEpochs" },
          { address: deployment.estate, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          {
            address: deployment.estate,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, deployment.boardroom],
          },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  const totalStaked = data?.[0];
  const yourStake = data?.[1];
  const earned = data?.[2];
  const canWithdraw = data?.[3] ?? false;
  const canClaimReward = data?.[4] ?? false;
  const member = data?.[5];
  const epochTimerStart = member?.[2]; // members returns [lastSnapshotIndex, rewardEarned, epochTimerStart]
  const withdrawLockupEpochs = data?.[6];
  const rewardLockupEpochs = data?.[7];
  const estateInWallet = data?.[8];
  const estateAllowance = data?.[9];

  return {
    totalStaked,
    yourStake,
    earned,
    canWithdraw,
    canClaimReward,
    epochTimerStart,
    withdrawLockupEpochs,
    rewardLockupEpochs,
    estateInWallet,
    estateAllowance,
    isLoading,
    isError,
    refetch,
  };
}
