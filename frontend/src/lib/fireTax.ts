import { EPOCH_SECONDS, FIRE, POLICY, SHARE_SELL_TAX_BPS } from "@/lib/launch";
import { PEG } from "@/lib/peg";

/**
 * Sell tax and withdraw fee, mirroring the contracts (MasonryRules, MasonryLevelHook,
 * MasonrySquareHook, MasonryLoyalty).
 *
 * Sell tax, charged on sells only. Buys and wallet transfers pay nothing.
 *
 *   rate = max( target(xTOMB TWAP), target(projected post-sale price, xTOMB only),
 *               recovery floor, Genesis Tax floor )
 *
 *   target(p)  the base rate at or above peg, 6% at or below 0.90 of peg, square-root
 *              curve in between. Base: 0.5% for xTOMB, 3% for xSHARE.
 *   recovery   after a higher rate is observed the floor falls back to the base in a
 *              straight line over seven hours.
 *   Genesis    6% on both tokens while Genesis runs, then 0.3% lower every six-hour
 *              epoch until it meets the rate above.
 *
 * Both tokens follow the xTOMB peg. xTOMB tax is always burned. xSHARE tax is sold for
 * the stablecoin and paid to the DAO wallet at or above peg, and buys and burns xTOMB under peg.
 *
 * Withdraw fee (Farm, Masonry, pooled range vault): the same curve from a 1.5% base to 6%,
 * on the TWAP and the recovery floor only. Time in without withdrawing takes up to half off.
 */

export type TaxedAsset = "xTOMB" | "xSHARE";
export type TaxDriver = "baseline" | "twap" | "projected" | "recovery" | "genesis";

const BPS = 10_000;
const DROP_BPS = Math.round((1 - FIRE.fullTaxAt) * BPS); // 1,000: full rate at 0.90 of peg

/** Base sell tax per token, charged at or above the xTOMB peg. */
export const SELL_BASE_BPS: Record<TaxedAsset, number> = { xTOMB: FIRE.baselineBps, xSHARE: SHARE_SELL_TAX_BPS };
/** Base liquidity withdraw fee, charged at or above peg. */
export const WITHDRAW_BASE_BPS = POLICY.withdrawFeeBaselineBps as number;
/** Time-in discount: grows every second to half the fee after three weeks without withdrawing. */
export const TIME_IN = { fullAfterSeconds: 21 * 86_400, maxDiscountBps: 5_000 };

/** Integer-exact mirror of MasonryRules.targetSellTaxBps on a 1e4 price basis. */
export function targetBps(priceOverReference: number, baseBps: number = FIRE.baselineBps): number {
  const peg = BPS;
  const price = Math.round(priceOverReference * BPS);
  if (price >= peg) return baseBps;
  const bottom = Math.floor((peg * (BPS - DROP_BPS)) / BPS);
  if (price <= bottom) return FIRE.capBps;
  const progress = Math.floor(((peg - price) * BPS) / (peg - bottom));
  // Integer floor-sqrt, matching OpenZeppelin Math.sqrt(progress * 10_000).
  const nonlinear = Math.floor(Math.sqrt(progress * BPS));
  return baseBps + Math.floor(((FIRE.capBps - baseBps) * nonlinear) / BPS);
}

/** Mirror of MasonryRules.recoveryFloorBps. */
export function recoveryFloorBps(raisedBps: number, raisedAt: number, now: number, baseBps: number = FIRE.baselineBps): number {
  const raised = Math.min(FIRE.capBps, Math.max(baseBps, raisedBps));
  if (now <= raisedAt) return raised;
  const elapsed = now - raisedAt;
  if (elapsed >= FIRE.recoverySeconds) return baseBps;
  return baseBps + Math.floor(((raised - baseBps) * (FIRE.recoverySeconds - elapsed)) / FIRE.recoverySeconds);
}

/** Mirror of MasonryRules.genesisTaxFloorBps: 6% in Genesis, then 0.3% lower per epoch. */
export function genesisFloorBps(active: boolean, genesisEnd: number | null, now: number): number {
  if (active) return POLICY.genesisLevelSellMinimumBps;
  if (genesisEnd === null || genesisEnd === 0 || now < genesisEnd) return 0;
  const decayed = Math.floor((now - genesisEnd) / EPOCH_SECONDS) * POLICY.genesisTaxDecayBpsPerEpoch;
  return Math.max(0, POLICY.genesisLevelSellMinimumBps - decayed);
}

/** Mirror of MasonryLoyalty.discountedFeeBps. `since` is the staker's time-in clock; 0 or null = none. */
export function timeInFeeBps(feeBps: number, since: number | null, now: number): number {
  if (!since || since >= now) return feeBps;
  const held = Math.min(now - since, TIME_IN.fullAfterSeconds);
  return feeBps - Math.floor((feeBps * TIME_IN.maxDiscountBps * held) / (TIME_IN.fullAfterSeconds * BPS));
}

export interface TaxInputs {
  asset: TaxedAsset;
  /** Validated xTOMB TWAP ÷ peg; null = the oracle has no valid price. */
  twap: number | null;
  /** Projected post-sale xTOMB price ÷ peg (from the swap preview); null = not projected. xTOMB sells only. */
  projected: number | null;
  /** xTOMB hook recovery state: the last raised rate and when it was raised. */
  raisedBps: number;
  raisedAt: number;
  now: number;
  genesisActive: boolean;
  /** When Genesis ended, for the decaying Genesis Tax floor. Omit while Genesis runs or is unscheduled. */
  genesisEnd?: number | null;
}

export interface TaxQuote {
  /** null when the hook would reject the sell (no valid TWAP). */
  rateBps: number | null;
  driver: TaxDriver | null;
  parts: Record<TaxDriver, number>;
  /** True when the tax ends up burned: always for xTOMB, under peg for xSHARE. */
  burned: boolean;
  blocked?: string;
}

/** Sell tax at peg with nothing raised: the rate shown before live data is available. */
export function officialSellTax(asset: TaxedAsset): TaxQuote {
  const base = SELL_BASE_BPS[asset];
  return {
    rateBps: base,
    driver: "baseline",
    parts: { baseline: base, twap: 0, projected: 0, recovery: 0, genesis: 0 },
    burned: asset === "xTOMB",
  };
}

function pick(parts: Record<TaxDriver, number>, base: number): { rate: number; driver: TaxDriver } {
  // Highest wins; ties resolve to the more specific driver.
  const order: TaxDriver[] = ["genesis", "recovery", "projected", "twap", "baseline"];
  let driver: TaxDriver = "baseline";
  let rate = 0;
  for (const d of order) if (parts[d] > rate) (rate = parts[d]), (driver = d);
  // Anything sitting at the base rate isn't driving it.
  if (rate <= base) driver = "baseline";
  return { rate: Math.min(rate, FIRE.capBps), driver };
}

export function sellTax(i: TaxInputs): TaxQuote {
  const base = SELL_BASE_BPS[i.asset];
  const parts: Record<TaxDriver, number> = {
    baseline: base,
    twap: i.twap !== null ? targetBps(i.twap, base) : 0,
    // xSHARE follows the xTOMB TWAP only; a projected price applies to xTOMB sells.
    projected: i.asset === "xTOMB" && i.projected !== null ? targetBps(i.projected, base) : 0,
    recovery: recoveryFloorBps(i.raisedBps, i.raisedAt, i.now, base),
    genesis: genesisFloorBps(i.genesisActive, i.genesisEnd ?? null, i.now),
  };
  if (i.twap === null) {
    // With no valid xTOMB TWAP the xSHARE hook charges the full rate and burns it;
    // the xTOMB hook rejects the sell.
    if (i.asset === "xSHARE") return { rateBps: FIRE.capBps, driver: "twap", parts: { ...parts, twap: FIRE.capBps }, burned: true };
    return {
      rateBps: null,
      driver: null,
      parts,
      burned: true,
      blocked: "The oracle has no valid TWAP, so the hook rejects xTOMB sells. Buys still go through.",
    };
  }
  const { rate, driver } = pick(parts, base);
  return { rateBps: rate, driver, parts, burned: i.asset === "xTOMB" || i.twap < 1 };
}

/** Withdraw fee before the time-in discount: TWAP + recovery only (no projected spot, which is sandwichable). */
export function withdrawFee(i: Pick<TaxInputs, "twap" | "raisedBps" | "raisedAt" | "now">): TaxQuote {
  const base = WITHDRAW_BASE_BPS;
  const parts: Record<TaxDriver, number> = {
    baseline: base,
    twap: i.twap !== null ? targetBps(i.twap, base) : 0,
    projected: 0,
    recovery: recoveryFloorBps(i.raisedBps, i.raisedAt, i.now, base),
    genesis: 0,
  };
  if (i.twap === null) {
    return { rateBps: null, driver: null, parts, burned: false, blocked: "The oracle has no valid TWAP, so the fee cannot be read." };
  }
  const { rate, driver } = pick(parts, base);
  return { rateBps: rate, driver, parts, burned: false };
}

export const DRIVER_LABEL: Record<TaxDriver, string> = {
  baseline: "base rate",
  twap: "xTOMB TWAP below peg",
  projected: "projected post-sale price",
  recovery: "recovery floor",
  genesis: "Genesis Tax",
};

/** Where the tax goes, in words. `underPeg` is true when xTOMB is under peg or has no valid TWAP. */
export function taxDestination(asset: TaxedAsset, underPeg: boolean): string {
  if (asset === "xTOMB") return "burned in full";
  return underPeg ? "buys xTOMB and burns it" : `sold for ${PEG.symbol}, paid to the DAO wallet`;
}

/** Seconds until a raised floor is fully back at the base rate. */
export function recoveryRemaining(raisedAt: number, now: number): number {
  return Math.max(0, raisedAt + FIRE.recoverySeconds - now);
}
