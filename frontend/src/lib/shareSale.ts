import { EPOCH_SECONDS } from "@/lib/launch";

/**
 * xSHARE auction terms — the values MasonryShareSale is deployed with.
 * Kept in one place so the page and the deploy settings read the same numbers.
 */
export const SHARE_SALE = {
  trancheCount: 20,
  trancheSize: 5,
  /** Shares of each tranche paid at purchase; the rest unlock later. */
  upfrontPerTranche: 1,
  startPriceUsd: 100,
  priceStepUsd: 5,
  auctionPassUsd: 60,
  /** One unlock step, in protocol epochs. */
  unlockEpochs: 6,
} as const;

export const SALE_TOTAL_SHARES = SHARE_SALE.trancheCount * SHARE_SALE.trancheSize;
export const SALE_VESTING_PER_TRANCHE = SHARE_SALE.trancheSize - SHARE_SALE.upfrontPerTranche;
export const SALE_UNLOCK_HOURS = (SHARE_SALE.unlockEpochs * EPOCH_SECONDS) / 3600;

/** Price per share in tranche `t` (0-based). */
export const tranchePrice = (t: number) => SHARE_SALE.startPriceUsd + t * SHARE_SALE.priceStepUsd;
/** Cost of the whole of tranche `t`. */
export const trancheCost = (t: number) => SHARE_SALE.trancheSize * tranchePrice(t);
/** What a full sell-out raises, before auction passes. */
export const SALE_MAX_RAISE = Array.from({ length: SHARE_SALE.trancheCount }, (_, t) => trancheCost(t)).reduce((a, b) => a + b, 0);
