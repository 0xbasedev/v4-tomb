import { useReadContracts } from "wagmi";

import { treasuryAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Composite snapshot of the xTOMB market state. Batches five Treasury views —
 * current price (TWAP-consulted), peg target (always 1e18), ceiling, ratio,
 * and circulating supply — into one multicall.
 *
 * `getPegPrice()` returns 0 until the Oracle has been updated at least once.
 * Callers should treat 0n as "not yet observable" rather than "0 ETH".
 *
 * `phase` derives the bond market state from price + ceiling + premium threshold,
 * matching the on-chain branching in Treasury._allocateSeigniorage:
 *   price >= premium    →  redemption open
 *   price >= ceiling    →  expansion / above peg
 *   else                →  contraction / acquisition open
 *
 * Hook leaves `closed` as a separate frontend-only state for the case where
 * the Treasury reports epoch 0 (no contraction has happened yet).
 */
export function usePegMarket() {
  const deployment = useDeployment();
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getPegPrice" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "pegPriceOne" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "pegPriceCeiling" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getPegCirculatingSupply" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "epoch" },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  // getPegPrice may revert if the oracle hasn't been updated — treat as 0.
  const price = data?.[0]?.status === "success" ? (data[0].result as bigint) : 0n;
  const priceOne = data?.[1]?.status === "success" ? (data[1].result as bigint) : 0n;
  const priceCeiling = data?.[2]?.status === "success" ? (data[2].result as bigint) : 0n;
  const circulatingSupply = data?.[3]?.status === "success" ? (data[3].result as bigint) : 0n;
  const epoch = data?.[4]?.status === "success" ? (data[4].result as bigint) : 0n;
  // The Treasury has no bonds, no reserve and no bootstrap. These stay in the return
  // shape as zeroes so existing screens keep rendering.
  const premiumThreshold = 0n;
  const seigniorageSaved = 0n;
  const bootstrapEpochs = 0n;

  // Derive phase. Pre-first-observation we surface "bootstrap" since the
  // Treasury is technically in its guaranteed-expansion window.
  // Two phases only: above the ceiling the Treasury mints, otherwise it does nothing.
  let phase: "bootstrap" | "expansion" | "contraction" | "redemption" = "contraction";
  if (price > priceCeiling && priceCeiling > 0n) {
    phase = "expansion";
  }

  return {
    price,
    priceOne,
    priceCeiling,
    premiumThreshold,
    circulatingSupply,
    seigniorageSaved,
    epoch,
    bootstrapEpochs,
    phase,
    isLoading,
    isError,
    refetch,
  };
}
