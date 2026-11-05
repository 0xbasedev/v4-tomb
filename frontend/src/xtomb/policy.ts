import launch from "../../../config/masonry-launch.template.json";

export const policy = launch.policy;
export const durationDays = policy.genesisDurationSeconds / 86_400;
export const lpDay = 1 + policy.genesisLpOpenDelaySeconds / 86_400;
export const percent = (bps: number) => `${bps / 100}%`;

export const tiers = [
  { name: "Genesis", price: policy.genesisNftPriceUsdc, tone: "ember", details: ["Manual staking and claims", "Manual LP compounding from Day 2"] },
  { name: "Pro", price: policy.genesisProNftPriceUsdc, tone: "spectre", details: ["All Genesis access", "Opt in to keeper compounding"] },
  { name: "Ultra", price: policy.genesisUltraNftPriceUsdc, tone: "amethyst", details: ["All Pro access", "24-hour early access to standard staking", "Same reward weighting as every tier"] },
] as const;

/** Mirrors the Solidity curve's integer steps for normalized sample prices. */
export function sampleTargetBps(priceInTenThousandths: number) {
  const peg = 10_000;
  const bottom = policy.fullTaxAtOrBelowPegBps;
  const baseline = policy.fireTaxBaselineBps;
  const cap = policy.fireTaxHardCapBps;
  if (priceInTenThousandths >= peg) return baseline;
  if (priceInTenThousandths <= bottom) return cap;
  const progress = Math.floor((peg - priceInTenThousandths) * peg / (peg - bottom));
  const quadratic = Math.floor(progress * progress / peg);
  return baseline + Math.floor((cap - baseline) * quadratic / peg);
}
