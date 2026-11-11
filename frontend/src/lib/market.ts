import { DEFENSE, EXPANSION, SQUARE_ROUTING, pct } from "@/lib/launch";

/**
 * Market state from the validated xTOMB TWAP (MasonryLevelOracle) and
 * Critical Defense (MasonryCriticalDefense).
 *
 *   expansion  planned rule: a fresh validated TWAP strictly above $1.01 makes
 *              an epoch eligible; at most 2% of circulating xTOMB per eligible
 *              six-hour epoch, no catch-up. Treasury mint wiring is still open
 *              on the merge branch, so this is shown as planned.
 *   band       $1.00 – $1.01: no expansion, baseline Fire Tax.
 *   tax        below $1.00: the Fire Tax target rises toward 12% at $0.85.
 *   defense    Critical Defense entered at a fresh TWAP ≤ $0.90. It exits only
 *              after two consecutive real six-hour checkpoints with a fresh TWAP
 *              strictly above $1.01; stale data never ends it. While active,
 *              100% of new xSHARE tax buys and burns xTOMB.
 *   stale      no valid TWAP: sells are rejected, nothing expands, defense
 *              keeps its last confirmed mode.
 */

export type MarketPhase = "expansion" | "band" | "tax" | "defense" | "stale";

export interface MarketInputs {
  twap: number | null;
  fresh: boolean;
  defenseActive: boolean;
}

export function marketPhase({ twap, fresh, defenseActive }: MarketInputs): MarketPhase {
  if (defenseActive) return "defense";
  if (!fresh || twap === null) return "stale";
  if (twap > EXPANSION.gate) return "expansion";
  if (twap >= 1) return "band";
  return "tax";
}

export const PHASE_META: Record<MarketPhase, { label: string; title: string; chip: string; detail: string }> = {
  expansion: {
    label: "Above gate",
    title: "Above the expansion price gate",
    chip: "chip-ember",
    detail: `Fresh TWAP above $${EXPANSION.gate.toFixed(2)}: an epoch can mint up to ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB (planned; Treasury wiring pending).`,
  },
  band: { label: "At peg", title: "Inside the peg band", chip: "chip", detail: `Between $1.00 and $${EXPANSION.gate.toFixed(2)}: no expansion, baseline Fire Tax.` },
  tax: { label: "Below peg", title: "Below peg — the Fire Tax rises", chip: "chip-amethyst", detail: "Sells pay a higher Fire Tax as the TWAP falls toward $0.85, where it reaches the 12% cap." },
  defense: {
    label: "Critical Defense",
    title: "Critical Defense is active",
    chip: "chip-bad",
    detail: `Entered at a TWAP ≤ $${DEFENSE.enterAt.toFixed(2)}. 100% of new xSHARE tax buys and burns xTOMB until ${DEFENSE.recoveryEpochs} consecutive six-hour checkpoints close above $${DEFENSE.exitAbove.toFixed(2)}.`,
  },
  stale: { label: "Oracle stale", title: "No valid TWAP", chip: "chip-warn", detail: "The hook rejects sells until the oracle has a fresh validated price. Buys continue; defense keeps its last mode." },
};

/** Upper bound of one eligible epoch's expansion. */
export function expansionCap(circulating: number, twap: number | null, fresh: boolean): number {
  if (!fresh || twap === null || twap <= EXPANSION.gate) return 0;
  return (circulating * EXPANSION.maxPerEpochBps) / 10_000;
}

/** Split of a collected xSHARE tax amount. */
export function squareTaxSplit(amount: number, critical: boolean) {
  if (critical) return { pol: 0, usdcReserve: 0, squareReserve: 0, buyBurn: amount };
  return {
    pol: (amount * SQUARE_ROUTING.polBps) / 10_000,
    usdcReserve: (amount * SQUARE_ROUTING.usdcReserveBps) / 10_000,
    squareReserve: (amount * SQUARE_ROUTING.squareReserveBps) / 10_000,
    buyBurn: 0,
  };
}

/**
 * Critical Defense state machine as the contract runs it, for the simulator:
 * a fresh reading ≤ enter activates; while active, each fresh epoch checkpoint
 * strictly above exit counts toward recovery, anything else resets it; stale
 * readings change nothing.
 */
export function stepDefense(state: { active: boolean; checkpoints: number }, twap: number, fresh: boolean) {
  if (!fresh) return state;
  if (!state.active) return twap <= DEFENSE.enterAt ? { active: true, checkpoints: 0 } : state;
  if (twap > DEFENSE.exitAbove) {
    const checkpoints = state.checkpoints + 1;
    return checkpoints >= DEFENSE.recoveryEpochs ? { active: false, checkpoints: 0 } : { active: true, checkpoints };
  }
  return { active: true, checkpoints: 0 };
}

/** 0 (cold, deep below peg) → 1 (hot, well above) for the ambient heat. */
export function heatFor(twap: number | null): number {
  if (twap === null || !(twap > 0)) return 0.5;
  return Math.max(0, Math.min(1, (twap - 0.85) / (1.15 - 0.85)));
}
