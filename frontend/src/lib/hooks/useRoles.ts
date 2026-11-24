import { useReadContracts } from "wagmi";
import type { Abi, Address } from "viem";

import { genesisRewardPoolAbi, masonryAbi, oracleAbi, pegDefenseHookAbi, pegFarmAbi, protocolTokenAbi, shareBuybackHookAbi, shareFarmAbi, timelockAbi, treasuryAbi } from "@/lib/abis";
import type { ProtocolDeployment } from "@/lib/addresses";
import { ok, results, type ReadCall } from "./reads";

export interface RoleRow {
  contract: string;
  role: string;
  holder: Address | null;
  /** The role is held by the Timelock, or by the Treasury where that is the design. */
  state: "timelock" | "treasury" | "other" | "unknown";
}

/**
 * Who holds each privileged role. Read-only: the page shows where governance
 * stands; it does not offer any privileged write.
 */
export function useRoles(d: ProtocolDeployment | null) {
  const enabled = !!d;
  const spec: { contract: string; role: string; address: Address; abi: Abi; fn: string }[] = d
    ? [
        { contract: "Treasury", role: "operator", address: d.treasury, abi: treasuryAbi as Abi, fn: "operator" },
        { contract: "xROOM (Masonry)", role: "operator", address: d.masonry, abi: masonryAbi as Abi, fn: "operator" },
        { contract: "xTOMB token", role: "operator (minter)", address: d.peg, abi: protocolTokenAbi as Abi, fn: "operator" },
        { contract: "xTOMB token", role: "owner", address: d.peg, abi: protocolTokenAbi as Abi, fn: "owner" },
        { contract: "xSHARE token", role: "operator", address: d.share, abi: protocolTokenAbi as Abi, fn: "operator" },
        { contract: "xSHARE token", role: "owner", address: d.share, abi: protocolTokenAbi as Abi, fn: "owner" },
        { contract: "Oracle", role: "operator", address: d.oracle, abi: oracleAbi as Abi, fn: "operator" },
        { contract: "Oracle", role: "owner", address: d.oracle, abi: oracleAbi as Abi, fn: "owner" },
        { contract: "PegDefenseHook", role: "owner", address: d.hook, abi: pegDefenseHookAbi as Abi, fn: "owner" },
        { contract: "PegDefenseHook", role: "trustees", address: d.hook, abi: pegDefenseHookAbi as Abi, fn: "trustees" },
        { contract: "ShareBuybackHook", role: "owner", address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, fn: "owner" },
        { contract: "ShareBuybackHook", role: "trustees", address: d.shareBuybackHook, abi: shareBuybackHookAbi as Abi, fn: "trustees" },
        { contract: "GenesisRewardPool", role: "operator", address: d.genesisRewardPool, abi: genesisRewardPoolAbi as Abi, fn: "operator" },
        { contract: "PegFarm", role: "operator", address: d.pegFarm, abi: pegFarmAbi as Abi, fn: "operator" },
        { contract: "ShareFarm", role: "operator", address: d.shareFarm, abi: shareFarmAbi as Abi, fn: "operator" },
      ]
    : [];

  const read = useReadContracts({
    allowFailure: true,
    contracts: d
      ? ([
          ...spec.map((s) => ({ address: s.address, abi: s.abi, functionName: s.fn, chainId: d.chainId })),
          { address: d.timelock, abi: timelockAbi as Abi, functionName: "admin", chainId: d.chainId },
          { address: d.timelock, abi: timelockAbi as Abi, functionName: "pendingAdmin", chainId: d.chainId },
          { address: d.timelock, abi: timelockAbi as Abi, functionName: "delay", chainId: d.chainId },
        ] as ReadCall[])
      : [],
    query: { enabled, refetchInterval: 60_000 },
  });
  const r = results(read.data);
  const eq = (a: Address | undefined, b: Address) => !!a && a.toLowerCase() === b.toLowerCase();

  const rows: RoleRow[] = spec.map((s, i) => {
    const holder = ok<Address>(r[i]);
    return {
      contract: s.contract,
      role: s.role,
      holder: holder ?? null,
      state: !holder ? "unknown" : eq(holder, d!.timelock) ? "timelock" : eq(holder, d!.treasury) ? "treasury" : "other",
    };
  });
  const n = spec.length;
  const delay = ok<bigint>(r[n + 2]);
  return {
    rows,
    timelock: {
      address: d?.timelock ?? null,
      admin: ok<Address>(r[n]) ?? null,
      pendingAdmin: ok<Address>(r[n + 1]) ?? null,
      delaySeconds: delay !== undefined ? Number(delay) : null,
    },
    loaded: enabled && read.isFetched,
  };
}
