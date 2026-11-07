import { FIRE } from "@/lib/launch";
import { PEG } from "@/lib/peg";

/**
 * Fire Tax — one sell tax per sale, computed the way the hooks do it
 * (MasonryRules + MasonryTaxHook._quote on the merge branch):
 *
 *   rate = max( target(validated TWAP),
 *               target(projected post-sale price),
 *               recovery floor,
 *               Genesis floor (while Genesis runs) )
 *
 *   target(p)  3% baseline at or above the reference price, the 12% cap at or
 *              below 0.90 × reference, square-root curve in between (mirrors
 *              MasonryRules.targetSellTaxBps).
 *   recovery   after a higher target is observed the floor decays linearly
 *              back to the 3% baseline over seven hours.
 *   Genesis    3% on xTOMB sells, 6% on xSHARE sells, for the seven days.
 *
 * Every input is capped at 12%, so the result is too. Buys and wallet
 * transfers pay 0%. The hook rejects a sell when its oracle has no valid TWAP.
 * xTOMB's reference is the $1 peg; xSHARE's is the reference price set at
 * deployment.
 */

export type TaxedAsset = "xTOMB" | "xSHARE";
export type TaxDriver = "baseline" | "twap" | "projected" | "recovery" | "genesis";

const BPS = 10_000;
const DROP_BPS = Math.round((1 - FIRE.fullTaxAt) * BPS); // 1,500

/** Integer-exact mirror of MasonryRules.targetSellTaxBps on a 1e4 price basis. */
export function targetBps(priceOverReference: number): number {
  const peg = BPS;
  const price = Math.round(priceOverReference * BPS);
  if (price >= peg) return FIRE.baselineBps;
  const bottom = Math.floor((peg * (BPS - DROP_BPS)) / BPS);
  if (price <= bottom) return FIRE.capBps;
  const progress = Math.floor(((peg - price) * BPS) / (peg - bottom));
  // Integer floor-sqrt, matching OpenZeppelin Math.sqrt(progress * 10_000).
  const nonlinear = Math.floor(Math.sqrt(progress * BPS));
  return FIRE.baselineBps + Math.floor(((FIRE.capBps - FIRE.baselineBps) * nonlinear) / BPS);
}

/** Mirror of MasonryRules.recoveryFloorBps. */
export function recoveryFloorBps(raisedBps: number, raisedAt: number, now: number): number {
  const raised = Math.min(FIRE.capBps, Math.max(FIRE.baselineBps, raisedBps));
  if (now <= raisedAt) return raised;
  const elapsed = now - raisedAt;
  if (elapsed >= FIRE.recoverySeconds) return FIRE.baselineBps;
  return FIRE.baselineBps + Math.floor(((raised - FIRE.baselineBps) * (FIRE.recoverySeconds - elapsed)) / FIRE.recoverySeconds);
}

export interface TaxInputs {
  asset: TaxedAsset;
  /** Validated TWAP ÷ reference price; null = the oracle has no valid price. */
  twap: number | null;
  /** Projected post-sale price ÷ reference (from the swap preview); null = not projected yet. */
  projected: number | null;
  /** Hook recovery state: the last raised rate and when it was raised. */
  raisedBps: number;
  raisedAt: number;
  now: number;
  genesisActive: boolean;
}

export interface TaxQuote {
  /** null when the hook would reject the sell (no valid TWAP). */
  rateBps: number | null;
  driver: TaxDriver | null;
  parts: Record<TaxDriver, number>;
  /** xTOMB sells during Genesis burn the whole tax. */
  burned: boolean;
  blocked?: string;
}

export function sellTax(i: TaxInputs): TaxQuote {
  const genesis = i.genesisActive ? FIRE.genesisFloorBps[i.asset] : 0;
  const parts: Record<TaxDriver, number> = {
    baseline: FIRE.baselineBps,
    twap: i.twap !== null ? targetBps(i.twap) : 0,
    projected: i.projected !== null ? targetBps(i.projected) : 0,
    recovery: recoveryFloorBps(i.raisedBps, i.raisedAt, i.now),
    genesis,
  };
  if (i.twap === null) {
    return {
      rateBps: null,
      driver: null,
      parts,
      burned: false,
      blocked: "The oracle has no valid TWAP, so the hook rejects sells. Buys still go through.",
    };
  }
  // Highest wins; ties resolve to the more specific driver.
  const order: TaxDriver[] = ["genesis", "recovery", "projected", "twap", "baseline"];
  let driver: TaxDriver = "baseline";
  let rate = 0;
  for (const d of order) if (parts[d] > rate) (rate = parts[d]), (driver = d);
  // Anything sitting at the baseline isn't driving the rate, unless Genesis
  // is what pinned it there (xTOMB's Genesis floor now equals the 3% baseline).
  if (rate <= FIRE.baselineBps && driver !== "genesis") driver = "baseline";
  return { rateBps: Math.min(rate, FIRE.capBps), driver, parts, burned: i.asset === "xTOMB" && i.genesisActive && FIRE.genesisBurnShare >= 1 };
}

export const DRIVER_LABEL: Record<TaxDriver, string> = {
  baseline: "ordinary baseline",
  twap: "TWAP below reference",
  projected: "projected post-sale price",
  recovery: "recovery floor",
  genesis: "Genesis floor",
};

/** Where the tax goes, in words. */
export function taxDestination(asset: TaxedAsset, genesisActive: boolean, criticalDefense: boolean): string {
  if (asset === "xTOMB") return genesisActive ? "burned in full (Genesis)" : "sent to the hook's fee recipient";
  return criticalDefense ? "100% to xTOMB buy-and-burn (Critical Defense)" : `12% POL · 20% ${PEG.symbol} reserve · 68% xSHARE reserve`;
}

/** Seconds until a raised floor is fully back at the baseline. */
export function recoveryRemaining(raisedAt: number, now: number): number {
  return Math.max(0, raisedAt + FIRE.recoverySeconds - now);
}
