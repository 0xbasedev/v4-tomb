/**
 * The protocol's fixed rules, copied from the contracts in ../contracts/src.
 * These are constructor defaults and constants — the interface shows them as
 * "rules" and reads the live value from chain wherever one exists.
 */

/** On-screen names. The token symbols are read from chain when a deployment exists. */
export const NAMES = {
  peg: "xTOMB",
  share: "xSHARE",
  room: "xROOM",
  /** Static copy never names the paired asset; its symbol is read from chain. */
  quote: "the paired asset",
  chain: "BNB Chain",
} as const;

/** Treasury.PERIOD */
export const EPOCH_SECONDS = 6 * 3600;
/** Treasury: pegPriceCeiling = pegPriceOne · 101 / 100 */
export const CEILING = 1.01;

/** Masonry.initialize defaults. */
export const LOCKUP = { withdrawEpochs: 6, rewardEpochs: 3 } as const;

/**
 * PegDefenseHook sell-tax schedule (taxTiersTwaps / taxTiersRates):
 *   TWAP < 1.12 → 12%   ·   1.12 ≤ TWAP < 1.20 → 6%   ·   TWAP ≥ 1.20 → 3%
 * MAX_TAX_BPS = 1200. The rate rises immediately and falls only after
 * TAX_RECOVERY_PERIOD (7 hours).
 */
export const TAX = {
  tiers: [
    { from: 0, bps: 1200 },
    { from: 1.12, bps: 600 },
    { from: 1.2, bps: 300 },
  ],
  maxBps: 1200,
  recoverySeconds: 7 * 3600,
} as const;

export function scheduleBps(twap: number): number {
  let bps: number = TAX.tiers[0].bps;
  for (const t of TAX.tiers) if (twap >= t.from) bps = t.bps;
  return bps;
}

/** PegDefenseHook LP-fee bands (hundredths of a bip), by distance from the peg tick. */
export const PEG_POOL_FEES = { expansion: 1000, base: 3000, contraction: 10_000, deepContraction: 30_000 } as const;

/** Emission programmes (contract constants). */
export const EMISSIONS = {
  genesis: { total: 11_000, seconds: 86_400, reward: "peg" },
  pegFarm: { total: 140_000, seconds: 9 * 86_400, reward: "peg", phases: "80,000 over the first 4 days, then 60,000 over 5 days" },
  shareFarm: { total: 59_500, seconds: 370 * 86_400, reward: "share", split: "pool 0 · peg LP 30% — pool 1 · share LP 70%" },
} as const;

export type MarketPhase = "expansion" | "hold" | "unknown";

/** Above the ceiling the Treasury mints to the Masonry; otherwise it does nothing. There is no third state. */
export function marketPhase(twap: number | null, ceiling: number | null): MarketPhase {
  if (twap === null || twap <= 0) return "unknown";
  return twap > (ceiling ?? CEILING) ? "expansion" : "hold";
}

export const PHASE_META: Record<MarketPhase, { label: string; chip: string; detail: string }> = {
  expansion: {
    label: "Expansion",
    chip: "chip-iris",
    detail: "TWAP is above the 1.01 ceiling. The next epoch mints new xTOMB to xROOM stakers.",
  },
  hold: {
    label: "No expansion",
    chip: "chip-spectre",
    detail: "TWAP is at or below the 1.01 ceiling. The Treasury mints nothing this epoch.",
  },
  unknown: {
    label: "No reading",
    chip: "",
    detail: "No TWAP is available.",
  },
};
