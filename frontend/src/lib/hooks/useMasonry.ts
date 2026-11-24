import { useAccount, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";

import { masonryAbi, erc20Abi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Composite Masonry (xROOM) state read.
 *
 * Returns:
 *   totalStaked       — Masonry.totalSupply (all members' xSHARE)
 *   yourStake         — Masonry.balanceOf(you)
 *   earned            — claimable xTOMB for you
 *   canWithdraw       — false until withdrawLockupEpochs since last stake
 *   canClaimReward    — false until rewardLockupEpochs since last stake
 *   epochTimerStart   — epoch at last stake (used to compute remaining lockup)
 *   withdrawLockupEpochs / rewardLockupEpochs — protocol parameters
 *   shareInWallet    — xSHARE.balanceOf(you), for the stake input's MAX
 *   shareAllowance   — xSHARE → Masonry allowance, for the approve gate (T9)
 *
 * Anonymous browsing (no wallet) returns zero/false for the user-specific
 * fields but still surfaces the protocol parameters.
 */
export function useMasonry() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: deployment.masonry, abi: masonryAbi, functionName: "totalSupply" },
          { address: deployment.masonry, abi: masonryAbi, functionName: "balanceOf", args: [user] },
          { address: deployment.masonry, abi: masonryAbi, functionName: "earned", args: [user] },
          { address: deployment.masonry, abi: masonryAbi, functionName: "canWithdraw", args: [user] },
          { address: deployment.masonry, abi: masonryAbi, functionName: "canClaimReward", args: [user] },
          { address: deployment.masonry, abi: masonryAbi, functionName: "members", args: [user] },
          { address: deployment.masonry, abi: masonryAbi, functionName: "withdrawLockupEpochs" },
          { address: deployment.masonry, abi: masonryAbi, functionName: "rewardLockupEpochs" },
          { address: deployment.share, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          {
            address: deployment.share,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, deployment.masonry],
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
  const shareInWallet = data?.[8];
  const shareAllowance = data?.[9];

  return {
    totalStaked,
    yourStake,
    earned,
    canWithdraw,
    canClaimReward,
    epochTimerStart,
    withdrawLockupEpochs,
    rewardLockupEpochs,
    shareInWallet,
    shareAllowance,
    isLoading,
    isError,
    refetch,
  };
}
