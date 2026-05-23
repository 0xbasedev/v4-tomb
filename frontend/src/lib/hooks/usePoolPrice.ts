import { useReadContracts } from "wagmi";

import { hookAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Live spot price for the MONEY-WETH pool, sourced from the PegDefenseHook.
 *
 * Two reads, one multicall:
 *   hook.lastTick()                    → tick at the last observed swap
 *   hook.priceFromTick(lastTick)       → 1e18-scaled MONEY/WETH price
 *
 * The hook stores `lastTick` immutably at pool init and updates it on every
 * subsequent swap. For a fresh deploy at tick 0, this returns 1.0 ETH per
 * MONEY. After trades, it reflects the most recent tick.
 *
 * Separately exposes `autoCalculateTax` so the SwapCard can show the user
 * whether tax is currently being applied to MONEY sells.
 */
export function usePoolPrice() {
  const deployment = useDeployment();
  const enabled = deployment !== null;

  const { data, isLoading, refetch } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: deployment.hook, abi: hookAbi, functionName: "lastTick" },
          { address: deployment.hook, abi: hookAbi, functionName: "autoCalculateTax" },
          { address: deployment.hook, abi: hookAbi, functionName: "bound" },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  const lastTick = data?.[0]?.status === "success" ? (data[0].result as number) : 0;
  const taxOn = data?.[1]?.status === "success" ? (data[1].result as boolean) : false;
  const bound = data?.[2]?.status === "success" ? (data[2].result as boolean) : false;

  // Second multicall: priceFromTick(lastTick). Split so we don't double-fetch
  // before lastTick lands.
  const priceCall = useReadContracts({
    allowFailure: true,
    contracts:
      enabled && bound
        ? [
            { address: deployment.hook, abi: hookAbi, functionName: "priceFromTick", args: [lastTick] },
          ]
        : [],
    query: { enabled: enabled && bound, refetchInterval: 15_000 },
  });
  const price = priceCall.data?.[0]?.status === "success" ? (priceCall.data[0].result as bigint) : 0n;

  return {
    lastTick,
    price,
    taxOn,
    bound,
    isLoading: isLoading || priceCall.isLoading,
    refetch: () => {
      refetch();
      priceCall.refetch();
    },
  };
}
