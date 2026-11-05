import { useReadContracts } from "wagmi";
import type { Address } from "viem";

import { masonryGenesisLPBurnFeeAbi, masonryGenesisSettlementAbi, masonrySquareHookAbi } from "@/lib/abis/masonry";
import { usePreview } from "@/lib/preview";
import { useNetworkStatus } from "./useNetworkStatus";

export type AdminRole = "lpBurnFee.owner" | "settlement.binder" | "squareHook.polBinder";

/**
 * Roles the connected wallet holds on the deployed contracts. Admin is only
 * shown to a wallet with at least one. In Preview the sample wallet holds all
 * three (`?owner=0` or the dock's Owner box shows the page as a user sees it).
 */
export function useIsAdmin(): { isAdmin: boolean; roles: AdminRole[]; holders: Partial<Record<AdminRole, Address>> } {
  const preview = usePreview();
  const net = useNetworkStatus();
  const c = net.deployment?.contracts;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: c
      ? [
          { address: c.lpBurnFee, abi: masonryGenesisLPBurnFeeAbi, functionName: "owner" },
          { address: c.settlement, abi: masonryGenesisSettlementAbi, functionName: "binder" },
          { address: c.squareHook, abi: masonrySquareHookAbi, functionName: "polBinder" },
        ]
      : [],
    query: { enabled: !!c, refetchInterval: 60_000 },
  });
  if (preview.enabled) {
    const on = preview.owner && preview.sampleWallet;
    return { isAdmin: on, roles: on ? ["lpBurnFee.owner", "settlement.binder", "squareHook.polBinder"] : [], holders: {} };
  }
  const keys: AdminRole[] = ["lpBurnFee.owner", "settlement.binder", "squareHook.polBinder"];
  const holders: Partial<Record<AdminRole, Address>> = {};
  keys.forEach((k, i) => {
    const r = reads.data?.[i];
    if (r?.status === "success") holders[k] = r.result as Address;
  });
  const me = net.walletAddress?.toLowerCase();
  const roles = keys.filter((k) => me && holders[k]?.toLowerCase() === me);
  return { isAdmin: roles.length > 0, roles, holders };
}
