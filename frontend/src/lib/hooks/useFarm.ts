import { useReadContracts } from "wagmi";
import { zeroAddress, type Abi, type Address } from "viem";

import { erc20Abi, genesisRewardPoolAbi, pegFarmAbi, shareFarmAbi } from "@/lib/abis";
import type { ProtocolDeployment } from "@/lib/addresses";
import { ok, results, type ReadCall } from "./reads";

export type FarmId = "genesis" | "pegFarm" | "shareFarm";
export type FarmPhase = "unknown" | "upcoming" | "live" | "ended";

export interface FarmPool {
  pid: number;
  token: Address;
  /** Stake-token symbol read from chain; a neutral label until it loads. */
  symbol: string;
  decimals: number;
  /** Which protocol wrapper this is, if any — drives the "how do I get this?" help. */
  role: "pegLp" | "shareLp" | "pairLp" | "other";
  allocPoint: bigint;
  /** Share of this farm's emissions, in bps of totalAllocPoint. */
  weightBps: number | null;
  totalStaked: bigint | null;
  staked: bigint | null;
  pending: bigint | null;
  wallet: bigint | null;
}

export interface FarmState {
  id: FarmId;
  address: Address | null;
  abi: Abi;
  reward: "peg" | "share";
  start: number | null;
  end: number | null;
  totalRewards: bigint | null;
  phase: FarmPhase;
  pools: FarmPool[];
  /** False until the first read settles (or forever when nothing is deployed). */
  loaded: boolean;
}

const SPEC: Record<FarmId, { abi: Abi; pending: string; reward: "peg" | "share"; probe: number }> = {
  genesis: { abi: genesisRewardPoolAbi as Abi, pending: "pendingPeg", reward: "peg", probe: 6 },
  pegFarm: { abi: pegFarmAbi as Abi, pending: "pendingPeg", reward: "peg", probe: 3 },
  shareFarm: { abi: shareFarmAbi as Abi, pending: "pendingShare", reward: "share", probe: 4 },
};

/**
 * One reward pool contract (GenesisRewardPool, PegFarm or ShareFarm).
 *
 * None of them exposes a pool count, so pids are probed: `poolInfo(pid)` reverts
 * past the end of the array and the probe stops at the first failure.
 */
export function useFarm(d: ProtocolDeployment | null, id: FarmId, account: Address | null, now: number): FarmState {
  const spec = SPEC[id];
  const address = d ? (id === "genesis" ? d.genesisRewardPool : id === "pegFarm" ? d.pegFarm : d.shareFarm) : null;
  const user = account ?? zeroAddress;
  const chainId = d?.chainId;
  const enabled = !!address && chainId !== undefined;

  const head = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? ([
          { address, abi: spec.abi, functionName: "poolStartTime", chainId },
          id === "pegFarm"
            ? { address, abi: spec.abi, functionName: "epochEndTimes", args: [1n], chainId }
            : { address, abi: spec.abi, functionName: "poolEndTime", chainId },
          { address, abi: spec.abi, functionName: "TOTAL_REWARDS", chainId },
          { address, abi: spec.abi, functionName: "totalAllocPoint", chainId },
          ...Array.from({ length: spec.probe }, (_, pid) => ({
            address,
            abi: spec.abi,
            functionName: "poolInfo",
            args: [BigInt(pid)],
            chainId,
          })),
        ] as ReadCall[])
      : [],
    query: { enabled, refetchInterval: 30_000 },
  });
  const h = results(head.data);
  const start = ok<bigint>(h[0]);
  const end = ok<bigint>(h[1]);
  const totalAlloc = ok<bigint>(h[3]) ?? 0n;

  const infos: { pid: number; token: Address; allocPoint: bigint }[] = [];
  for (let pid = 0; pid < spec.probe; pid++) {
    const info = ok<readonly [Address, bigint, bigint, bigint, boolean]>(h[4 + pid]);
    if (!info) break;
    infos.push({ pid, token: info[0], allocPoint: info[1] });
  }

  const PER = 6;
  const detail = useReadContracts({
    allowFailure: true,
    contracts:
      enabled && infos.length
        ? (infos.flatMap(({ pid, token }) => [
            { address: token, abi: erc20Abi, functionName: "symbol", chainId },
            { address: token, abi: erc20Abi, functionName: "decimals", chainId },
            { address: token, abi: erc20Abi, functionName: "balanceOf", args: [address], chainId },
            { address: token, abi: erc20Abi, functionName: "balanceOf", args: [user], chainId },
            { address, abi: spec.abi, functionName: "userInfo", args: [BigInt(pid), user], chainId },
            { address, abi: spec.abi, functionName: spec.pending, args: [BigInt(pid), user], chainId },
          ]) as ReadCall[])
        : [],
    query: { enabled: enabled && infos.length > 0, refetchInterval: 15_000 },
  });
  const x = results(detail.data);

  const same = (a: Address, b: Address | undefined) => !!b && a.toLowerCase() === b.toLowerCase();
  const pools: FarmPool[] = infos.map(({ pid, token, allocPoint }, i) => {
    const o = i * PER;
    const info = ok<readonly [bigint, bigint]>(x[o + 4]);
    return {
      pid,
      token,
      symbol: ok<string>(x[o]) ?? `Pool ${pid} token`,
      decimals: Number(ok<number>(x[o + 1]) ?? 18),
      role: same(token, d?.lpWrapper) ? "pegLp" : same(token, d?.shareLpWrapper) ? "shareLp" : same(token, d?.pairLpWrapper) ? "pairLp" : "other",
      allocPoint,
      weightBps: totalAlloc > 0n ? Number((allocPoint * 10_000n) / totalAlloc) : null,
      totalStaked: ok<bigint>(x[o + 2]) ?? null,
      staked: account ? (info?.[0] ?? null) : null,
      pending: account ? (ok<bigint>(x[o + 5]) ?? null) : null,
      wallet: account ? (ok<bigint>(x[o + 3]) ?? null) : null,
    };
  });

  const s = start !== undefined ? Number(start) : null;
  const e = end !== undefined ? Number(end) : null;
  const phase: FarmPhase = s === null || e === null ? "unknown" : now < s ? "upcoming" : now < e ? "live" : "ended";

  return {
    id,
    address,
    abi: spec.abi,
    reward: spec.reward,
    start: s,
    end: e,
    totalRewards: ok<bigint>(h[2]) ?? null,
    phase,
    pools,
    loaded: enabled && head.isFetched,
  };
}
