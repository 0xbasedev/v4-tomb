import { useReadContracts } from "wagmi";

import { treasuryAbi } from "@/lib/abis";
import { useDeployment } from "./useDeployment";

/**
 * Composite snapshot of the MONEY market state. Batches five Treasury views —
 * current price (TWAP-consulted), peg target (always 1e18), ceiling, ratio,
 * and circulating supply — into one multicall.
 *
 * `getMoneyPrice()` returns 0 until the Oracle has been updated at least once.
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
export function useMoneyMarket() {
  const deployment = useDeployment();
  const enabled = deployment !== null;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getMoneyPrice" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "moneyPriceOne" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "moneyPriceCeiling" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "premiumThreshold" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getMoneyCirculatingSupply" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "getReserve" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "epoch" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "bootstrapEpochs" },
        ]
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  // getMoneyPrice may revert if the oracle hasn't been updated — treat as 0.
  const price = data?.[0]?.status === "success" ? (data[0].result as bigint) : 0n;
  const priceOne = data?.[1]?.status === "success" ? (data[1].result as bigint) : 0n;
  const priceCeiling = data?.[2]?.status === "success" ? (data[2].result as bigint) : 0n;
  const premiumThreshold = data?.[3]?.status === "success" ? (data[3].result as bigint) : 0n;
  const circulatingSupply = data?.[4]?.status === "success" ? (data[4].result as bigint) : 0n;
  const seigniorageSaved = data?.[5]?.status === "success" ? (data[5].result as bigint) : 0n;
  const epoch = data?.[6]?.status === "success" ? (data[6].result as bigint) : 0n;
  const bootstrapEpochs = data?.[7]?.status === "success" ? (data[7].result as bigint) : 0n;

  // Derive phase. Pre-first-observation we surface "bootstrap" since the
  // Treasury is technically in its guaranteed-expansion window.
  const inBootstrap = epoch < bootstrapEpochs;
  let phase: "bootstrap" | "expansion" | "contraction" | "redemption" = "contraction";
  if (inBootstrap) {
    phase = "bootstrap";
  } else if (price >= premiumThreshold && premiumThreshold > 0n) {
    phase = "redemption";
  } else if (price >= priceCeiling && priceCeiling > 0n) {
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
