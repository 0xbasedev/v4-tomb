import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { zeroAddress } from "viem";

import { erc20Abi, moneyRewardPoolAbi, shareRewardPoolAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

type RewardKind = "money" | "share";

interface UseRewardPoolArgs {
  /** Which reward pool — Genesis, Main, or Share. Caller resolves the address. */
  pool: Address | undefined;
  /** Which PID within the pool. Most pools have one PID; Genesis can have many. */
  pid: number;
  /** Whether this pool emits MONEY (Genesis, Main) or ESTATE (Share). */
  reward: RewardKind;
}

/**
 * Per-PID state for one reward pool. Reads:
 *   poolInfo(pid)          → token, allocPoint, lastRewardTime, accPerShare, isStarted
 *   userInfo(pid, user)    → amount, rewardDebt
 *   pendingMoney/Share     → claimable for this user
 *   totalAllocPoint        → for displaying alloc weight as %
 *   poolStartTime
 *   ERC20.balanceOf(user) on the stake token
 *   ERC20.allowance(user, pool) on the stake token
 *
 * Notes:
 *   - We can't read `poolInfo.length` without a custom view, so the caller must
 *     already know the PIDs they want. The Vault page hardcodes PID lists; later
 *     versions can probe via multicall with allowFailure to count.
 *   - When pool is undefined or pid is invalid, all values come back as zero —
 *     allowFailure=true catches the per-PID revert gracefully.
 */
export function useRewardPool({ pool, pid, reward }: UseRewardPoolArgs) {
  const deployment = useDeployment();
  const { address } = useAccount();
  const user = address ?? zeroAddress;

  const abi = reward === "money" ? moneyRewardPoolAbi : shareRewardPoolAbi;
  const pendingName = reward === "money" ? "pendingMoney" : "pendingShare";

  const enabled = deployment !== null && pool !== undefined;
  const pidArg = BigInt(pid);

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: true,
    contracts:
      enabled && pool
        ? [
            { address: pool, abi, functionName: "poolInfo", args: [pidArg] },
            { address: pool, abi, functionName: "userInfo", args: [pidArg, user] },
            {
              address: pool,
              abi: abi as typeof moneyRewardPoolAbi & typeof shareRewardPoolAbi,
              // pendingMoney for MONEY pools, pendingShare for share pools
              functionName: pendingName as "pendingMoney",
              args: [pidArg, user],
            },
            { address: pool, abi, functionName: "totalAllocPoint" },
            { address: pool, abi, functionName: "poolStartTime" },
          ]
        : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  // poolInfo returns [token, allocPoint, lastRewardTime, accPerShare, isStarted]
  const poolInfoOk = data?.[0]?.status === "success";
  const poolInfo = poolInfoOk
    ? (data[0].result as readonly [Address, bigint, bigint, bigint, boolean])
    : undefined;
  const stakeToken = poolInfo?.[0];
  const allocPoint = poolInfo?.[1] ?? 0n;
  const lastRewardTime = poolInfo?.[2] ?? 0n;

  // userInfo returns [amount, rewardDebt]
  const userInfoOk = data?.[1]?.status === "success";
  const userInfo = userInfoOk ? (data[1].result as readonly [bigint, bigint]) : undefined;
  const yourStake = userInfo?.[0] ?? 0n;

  const pending = data?.[2]?.status === "success" ? (data[2].result as bigint) : 0n;
  const totalAllocPoint = data?.[3]?.status === "success" ? (data[3].result as bigint) : 0n;
  const poolStartTime = data?.[4]?.status === "success" ? (data[4].result as bigint) : 0n;

  return {
    stakeToken,
    allocPoint,
    totalAllocPoint,
    lastRewardTime,
    yourStake,
    pending,
    poolStartTime,
    /** Convenience: pool entry exists for this pid (poolInfo didn't revert). */
    exists: poolInfoOk,
    isLoading,
    isError,
    refetch,
  };
}

/** Wallet balance + allowance for an arbitrary ERC-20 against a spender. */
export function useTokenStatus(token: Address | undefined, spender: Address | undefined) {
  const { address } = useAccount();
  const user = address ?? zeroAddress;
  const enabled = !!token && !!spender;

  const { data, isLoading, refetch } = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? [
          { address: token, abi: erc20Abi, functionName: "balanceOf", args: [user] },
          { address: token, abi: erc20Abi, functionName: "allowance", args: [user, spender] },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  return {
    balance: data?.[0] ?? 0n,
    allowance: data?.[1] ?? 0n,
    isLoading,
    refetch,
  };
}
