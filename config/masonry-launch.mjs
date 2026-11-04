// Masonry-only draft launch-plan validator. No runtime contract integration
// until the v4 hook, Treasury and Genesis adapters are replaced/reviewed.
const nonnegative = (n, path) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${path}: expected nonnegative safe integer`);
  return n;
};
const positive = (n, path) => {
  nonnegative(n, path);
  if (!n) throw new Error(`${path}: must be positive`);
  return n;
};
const obj = (x, path) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${path}: expected object`);
  return x;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const positiveRawAmount = (n, path) => {
  if (typeof n !== 'string' || !/^[1-9][0-9]*$/.test(n) || BigInt(n) > (1n << 256n) - 1n) {
    throw new Error(`${path}: expected a positive uint256 decimal string`);
  }
  return n;
};

/**
 * Reject incomplete configs and inconsistent allocations before deploy.
 * Amounts are WHOLE tokens in this wizard view; scaling to base units occurs
 * only when deployment artifacts are generated. No mainnet deploy wiring yet.
 */
export function validateMasonryLaunch(doc) {
  const d = obj(doc, 'document');
  if (d.schemaVersion !== 1 || d.protocol !== 'masonry') throw new Error('unsupported Masonry launch schema');
  const s = obj(d.square, 'square');
  const initial = obj(s.initial, 'square.initial');
  const vested = obj(s.vesting, 'square.vesting');
  const source = obj(d.level, 'level');
  const levelInitial = obj(source.initial, 'level.initial');
  const policy = obj(d.policy, 'policy');
  const genesisBurn = obj(d.genesisBurnExecution, 'genesisBurnExecution');
  positiveRawAmount(genesisBurn.maxFeeSharesPerCallBaseUnits, 'genesisBurnExecution.maxFeeSharesPerCallBaseUnits');
  positiveRawAmount(genesisBurn.maxUsdcPerCallBaseUnits, 'genesisBurnExecution.maxUsdcPerCallBaseUnits');

  const squareCap = positive(s.maxSupply, 'square.maxSupply');
  const farms = nonnegative(s.farming, 'square.farming');
  const sale = nonnegative(s.saleEscrow, 'square.saleEscrow');
  const deployer = nonnegative(s.deployer, 'square.deployer');
  const initialAmounts = ['ownerTeamDeveloper', 'treasury', 'arbitrage']
    .map((k) => nonnegative(initial[k], `square.initial.${k}`));
  const vestingAmounts = ['team', 'developer', 'treasury', 'arbitrage']
    .map((k) => nonnegative(vested[k], `square.vesting.${k}`));
  const allocated = sum([farms, sale, deployer, ...initialAmounts, ...vestingAmounts]);
  if (allocated !== squareCap) throw new Error(`SQUARE supply mismatch: allocated ${allocated}, max ${squareCap}`);

  const levelLaunchSupply = positive(source.authorizedLaunchSupply, 'level.authorizedLaunchSupply');
  const levelLaunchFunding = sum(['ownerTeamDeveloper', 'treasury', 'arbitrage']
    .map((k) => nonnegative(levelInitial[k], `level.initial.${k}`)));
  if (levelLaunchFunding > levelLaunchSupply) {
    throw new Error('initial LEVEL funding exceeds authorized launch supply');
  }

  for (const [key, value] of Object.entries({
    fireTaxHardCapBps: 1200,
    genesisDurationSeconds: 604800,
    genesisLpOpenDelaySeconds: 86400,
    genesisLevelSellMinimumBps: 300,
    genesisLevelSellBurnShareBps: 10000,
    genesisNftRequired: true,
    genesisNftPriceUsdc: 50,
    genesisProNftPriceUsdc: 100,
    genesisUltraNftPriceUsdc: 500,
    genesisUltraMultiplier: 1,
    fireTaxBaselineBps: 100,
    fireTaxRecoverySeconds: 25200,
    maximumExpansionPerEpochBps: 200,
    requiresFreshTwapStrictlyAbovePegBps: 10100,
    farmsCompoundCooldownSeconds: 10800,
    genesisCompoundCooldownSeconds: 10800,
    farmEmissionDays: 365,
    operationalVestingDays: 180,
    genesisLevelUsdcLpBurnFeeBps: 50,
    squareTaxPolBps: 1200,
    squareTaxUsdcReserveBps: 2000,
    squareTaxSquareReserveBps: 6800,
    criticalDefenseEntryBps: 9000,
    criticalDefenseExitBps: 10100,
    criticalRecoveryEpochs: 2,
    epochSeconds: 21600,
    criticalOracleMaxAgeSeconds: 1800,
    governanceTimelocksEnabled: false,
    ownerTradingPauseEnabled: false,
  })) {
    if (policy[key] !== value) throw new Error(`policy.${key}: Masonry release invariant must equal ${value}`);
  }
  if (policy.fullTaxAtOrBelowPegBps !== 8500) throw new Error('full Fire Tax threshold must be 0.85 of peg');

  return { squareCap, allocatedSquare: allocated, vestedSquare: sum(vestingAmounts),
    initialLevelFunding: levelLaunchFunding, levelLaunchSupply };
}
