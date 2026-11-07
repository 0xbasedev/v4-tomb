import launch from "@config/masonry-launch.template.json" with { type: "json" };
import registryJson from "@config/official-infrastructure.json" with { type: "json" };
import deploymentsJson from "@config/masonry-deployments.json" with { type: "json" };
import { parseMasonryDeployment } from "@config/masonry-deployment.mjs";
import type { MasonryDeployment, OfficialRegistry } from "@config/masonry-deployment.mjs";

/**
 * The validated launch configuration, imported — never copied — from
 * config/masonry-launch.template.json. Every number the UI shows about Genesis,
 * the Fire Tax, expansion, Critical Defense and xSHARE routing comes from here.
 * The deploy scripts validate the same file (config/masonry-launch.mjs), so a
 * changed invariant fails the build instead of drifting from the contracts.
 *
 * Token names: the contracts call the peg asset LEVEL and the share asset
 * SQUARE. The UI calls them xTOMB and xSHARE.
 */
export const LAUNCH = launch;
export const POLICY = launch.policy;
export const REGISTRY = registryJson as unknown as OfficialRegistry;
export const DEPLOYMENTS = (deploymentsJson as { deployments: MasonryDeployment[] }).deployments.filter((record) => {
  try { parseMasonryDeployment(record, REGISTRY); return true; } catch { return false; }
});

const bps = (n: number) => n / 10_000;
export const pct = (b: number, digits = 2) => `${+(b / 100).toFixed(digits)}%`;

export const EPOCH_SECONDS = POLICY.epochSeconds;

export const SQUARE_SUPPLY = {
  /** Configured cap (defaults to 33,333). */
  cap: launch.square.maxSupply,
  farming: launch.square.farming,
  saleEscrow: launch.square.saleEscrow,
  deployer: launch.square.deployer,
  initial: launch.square.initial,
  /** Vesting buckets stay null in the template until the Wizard sets them. */
  vesting: launch.square.vesting as Record<"team" | "developer" | "treasury" | "arbitrage", number | null>,
};

export const LEVEL_SUPPLY = {
  authorizedLaunchSupply: launch.level.authorizedLaunchSupply as number | null,
  initial: launch.level.initial,
};

/** Fire Tax parameters shared by the official peg and share hooks. */
export const FIRE = {
  baselineBps: POLICY.fireTaxBaselineBps,
  capBps: POLICY.fireTaxHardCapBps,
  /** At or below this share of the reference price the cap applies (0.90). */
  fullTaxAt: bps(POLICY.fullTaxAtOrBelowPegBps),
  recoverySeconds: POLICY.fireTaxRecoverySeconds,
  genesisFloorBps: { xTOMB: POLICY.genesisLevelSellMinimumBps, xSHARE: POLICY.squareGenesisSellMinimumBps } as const,
  /** Share of the xTOMB Genesis sell tax that is burned (100%). */
  genesisBurnShare: bps(POLICY.genesisLevelSellBurnShareBps),
};

/** Normal xSHARE fee routing — shares of collected tax, never of the gross sale. */
export const SQUARE_ROUTING = {
  polBps: POLICY.squareTaxPolBps,
  usdcReserveBps: POLICY.squareTaxUsdcReserveBps,
  squareReserveBps: POLICY.squareTaxSquareReserveBps,
};

export const DEFENSE = {
  enterAt: bps(POLICY.criticalDefenseEntryBps),
  exitAbove: bps(POLICY.criticalDefenseExitBps),
  recoveryEpochs: POLICY.criticalRecoveryEpochs,
  oracleMaxAgeSeconds: POLICY.criticalOracleMaxAgeSeconds,
};

export const EXPANSION = {
  /** Fresh validated TWAP strictly above this. */
  gate: bps(POLICY.requiresFreshTwapStrictlyAbovePegBps),
  maxPerEpochBps: POLICY.maximumExpansionPerEpochBps,
};

export const GENESIS_POLICY = {
  durationSeconds: POLICY.genesisDurationSeconds,
  lpDelaySeconds: POLICY.genesisLpOpenDelaySeconds,
  /** From Day 2 the LP pool receives 75% of emissions (contract constant). */
  lpEmissionShare: 0.75,
  liquidShare: bps(POLICY.genesisLiquidRewardBps),
  installments: POLICY.genesisVestingInstallments,
  installmentSeconds: POLICY.genesisVestingIntervalSeconds,
  walletFeeBps: POLICY.genesisWalletClaimFeeBps,
  automationFeeBps: POLICY.genesisAutomationFeeBps,
  lpBurnFeeBps: POLICY.genesisLevelUsdcLpBurnFeeBps,
  compoundCooldownSeconds: POLICY.genesisCompoundCooldownSeconds,
  /** MasonryGenesisStaking.ULTRA_EARLY_ACCESS — Ultra may pre-stake in the standard pool. */
  ultraEarlySeconds: 86_400,
  ultraMultiplier: POLICY.genesisUltraMultiplier,
  passRequired: POLICY.genesisNftRequired,
};

export const FARM_POLICY = {
  compoundCooldownSeconds: POLICY.farmsCompoundCooldownSeconds,
  emissionDays: POLICY.farmEmissionDays,
};

/** Pass tiers, matching MasonryGenesisPass.Tier: None = 0, Genesis = 1, Pro = 2, Ultra = 3. */
export type PassTier = "genesis" | "pro" | "ultra";
export const PASS_TIER_ID: Record<PassTier, 1 | 2 | 3> = { genesis: 1, pro: 2, ultra: 3 };
export const PASS_TIER_FROM_ID: Record<number, PassTier | null> = { 0: null, 1: "genesis", 2: "pro", 3: "ultra" };

export interface PassDef {
  id: PassTier;
  rank: 1 | 2 | 3;
  name: string;
  priceUsdc: number;
  keeper: boolean;
  earlyStandardStaking: boolean;
  perks: string[];
}

export const PASSES: Record<PassTier, PassDef> = {
  genesis: {
    id: "genesis",
    rank: 1,
    name: "Genesis",
    priceUsdc: POLICY.genesisNftPriceUsdc,
    keeper: false,
    earlyStandardStaking: false,
    perks: ["Stake, claim and withdraw by hand", "Compound into the LP pool by hand from Day 2"],
  },
  pro: {
    id: "pro",
    rank: 2,
    name: "Pro",
    priceUsdc: POLICY.genesisProNftPriceUsdc,
    keeper: true,
    earlyStandardStaking: false,
    perks: ["Everything in Genesis", `Opt in to keeper compounding (${pct(POLICY.genesisAutomationFeeBps)} of the liquid half per run)`],
  },
  ultra: {
    id: "ultra",
    rank: 3,
    name: "Ultra",
    priceUsdc: POLICY.genesisUltraNftPriceUsdc,
    keeper: true,
    earlyStandardStaking: true,
    perks: ["Everything in Pro", "Stake in the standard pool up to 24 hours before Genesis starts", "Same reward weighting as every pass — rewards start at the same time"],
  },
};
export const PASS_ORDER: PassTier[] = ["genesis", "pro", "ultra"];
