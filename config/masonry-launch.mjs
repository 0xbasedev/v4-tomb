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
const addressField = (value, path) => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${path}: must be a 20-byte hex address`);
  }
  if (/^0x0{40}$/i.test(value)) throw new Error(`${path}: cannot be the zero address`);
  return value;
};
const requiredText = (value, path) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path}: must be non-empty text`);
  return value;
};
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
function validateRangeKnobs(range, label) {
  if (!range || typeof range !== 'object') throw new Error(`${label}: missing range knobs`);
  const mode = range.mode ?? 'follow';
  const recenter = nonnegative(range.recenterBps, `${label}.recenterBps`);
  if (mode === 'pegAnchor') {
    const lower = nonnegative(range.lowerHalfWidthBps, `${label}.lowerHalfWidthBps`);
    const upper = nonnegative(range.upperHalfWidthBps, `${label}.upperHalfWidthBps`);
    if (lower < 500 || lower > 3000) throw new Error(`${label}.lowerHalfWidthBps: must be 500–3000`);
    if (upper < 500 || upper > 3000) throw new Error(`${label}.upperHalfWidthBps: must be 500–3000`);
    const tighter = Math.min(lower, upper);
    if (recenter < 100 || recenter >= tighter) {
      throw new Error(`${label}.recenterBps: must be 100–min(lower,upper) (inner band)`);
    }
  } else if (mode === 'follow') {
    const halfWidth = nonnegative(range.halfWidthBps, `${label}.halfWidthBps`);
    if (halfWidth < 500 || halfWidth > 3000) throw new Error(`${label}.halfWidthBps: must be 500–3000 (±5% to ±30%)`);
    if (recenter < 100 || recenter >= halfWidth) {
      throw new Error(`${label}.recenterBps: must be 100–halfWidth (inner band)`);
    }
  } else {
    throw new Error(`${label}.mode: must be follow or pegAnchor`);
  }
  const rangeCooldown = nonnegative(range.cooldownSeconds, `${label}.cooldownSeconds`);
  if (rangeCooldown < 60 || rangeCooldown > 86400) throw new Error(`${label}.cooldownSeconds: must be 60–86400`);
  const twapDev = nonnegative(range.maxTwapDeviationBps, `${label}.maxTwapDeviationBps`);
  if (twapDev < 1 || twapDev > 1000) throw new Error(`${label}.maxTwapDeviationBps: must be 1–1000`);
}

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
    genesisDurationSeconds: 604800,
    genesisLpOpenDelaySeconds: 86400,
    genesisLevelSellMinimumBps: 300,
    genesisLevelSellBurnShareBps: 10000,
    genesisNftRequired: true,
    genesisNftPriceUsdc: 50,
    genesisProNftPriceUsdc: 100,
    genesisUltraNftPriceUsdc: 500,
    genesisUltraMultiplier: 1,
    fireTaxRecoverySeconds: 25200,
    requiresFreshTwapStrictlyAbovePegBps: 10100,
    farmsCompoundCooldownSeconds: 10800,
    genesisCompoundCooldownSeconds: 10800,
    operationalVestingDays: 180,
    genesisLevelUsdcLpBurnFeeBps: 50,
    genesisLiquidRewardBps: 5000,
    genesisVestingInstallments: 16,
    genesisVestingIntervalSeconds: 21600,
    genesisWalletClaimFeeBps: 200,
    genesisAutomationFeeBps: 200,
    squareGenesisSellMinimumBps: 600,
    squareTaxPolBps: 1200,
    squareTaxUsdcReserveBps: 2000,
    squareTaxSquareReserveBps: 6800,
    criticalDefenseEntryBps: 9000,
    criticalDefenseExitBps: 10100,
    criticalRecoveryEpochs: 2,
    epochSeconds: 21600,
    governanceTimelocksEnabled: false,
    ownerTradingPauseEnabled: false,
  })) {
    if (policy[key] !== value) throw new Error(`policy.${key}: Masonry release invariant must equal ${value}`);
  }
  if (policy.fullTaxAtOrBelowPegBps !== 9000) throw new Error('full Fire Tax threshold must be 0.90 of peg');

  const baseline = nonnegative(policy.fireTaxBaselineBps, 'policy.fireTaxBaselineBps');
  const hardCap = nonnegative(policy.fireTaxHardCapBps, 'policy.fireTaxHardCapBps');
  if (baseline < 300) throw new Error('policy.fireTaxBaselineBps: 3% floor (300) is required');
  if (hardCap > 1200) throw new Error('policy.fireTaxHardCapBps: cannot exceed 12% (1200)');
  if (baseline > hardCap) throw new Error('policy.fireTaxBaselineBps: cannot exceed fireTaxHardCapBps');

  const expansion = nonnegative(policy.maximumExpansionPerEpochBps, 'policy.maximumExpansionPerEpochBps');
  if (expansion < 1 || expansion > 200) {
    throw new Error('policy.maximumExpansionPerEpochBps: must be 1–200 (2% hard cap)');
  }

  const farmDays = nonnegative(policy.farmEmissionDays, 'policy.farmEmissionDays');
  if (farmDays < 1 || farmDays > 3650) throw new Error('policy.farmEmissionDays: must be 1–3650');

  const oracleAge = nonnegative(policy.criticalOracleMaxAgeSeconds, 'policy.criticalOracleMaxAgeSeconds');
  if (oracleAge < 1 || oracleAge > 1800) {
    throw new Error('policy.criticalOracleMaxAgeSeconds: must be 1–1800');
  }

  positive(policy.farmShareWethLpAllocPoints, 'policy.farmShareWethLpAllocPoints');

  const discount = nonnegative(policy.bondMaxDiscountBps, 'policy.bondMaxDiscountBps');
  if (discount > 10000) throw new Error('policy.bondMaxDiscountBps: cannot exceed 10000');
  const debt = nonnegative(policy.bondMaxDebtRatioBps, 'policy.bondMaxDebtRatioBps');
  if (debt < 1 || debt > 10000) throw new Error('policy.bondMaxDebtRatioBps: must be 1–10000');
  positive(policy.bondMaxSupply, 'policy.bondMaxSupply');
  const premium = nonnegative(policy.bondRedeemPremiumBps, 'policy.bondRedeemPremiumBps');
  if (premium > 10000) throw new Error('policy.bondRedeemPremiumBps: cannot exceed 10000');


  validateRangeKnobs(policy.rangeLevel, 'policy.rangeLevel');
  validateRangeKnobs(policy.rangeSquare, 'policy.rangeSquare');

  addressField(d.daoWallet, 'daoWallet');
  if (typeof policy.farmClaimToWallet !== 'boolean') {
    throw new Error('policy.farmClaimToWallet: must be a boolean');
  }
  const farmWithdraw = nonnegative(policy.farmWithdrawCooldownSeconds, 'policy.farmWithdrawCooldownSeconds');
  if (farmWithdraw < 60 || farmWithdraw > 86400) {
    throw new Error('policy.farmWithdrawCooldownSeconds: must be 60–86400');
  }
  for (const key of [
    'farmZapLabel', 'farmZapNotice', 'farmWithdrawTitle', 'farmCooldownNotice', 'farmForfeitNotice',
    'farmCancelHint', 'farmCompoundLabel', 'farmCancelLabel', 'farmCompleteWithdrawLabel', 'farmFireTaxNote',
  ]) {
    requiredText(policy[key], `policy.${key}`);
  }
  const withdrawFee = nonnegative(policy.liquidityWithdrawFeeBps, 'policy.liquidityWithdrawFeeBps');
  if (withdrawFee > 1000) throw new Error('policy.liquidityWithdrawFeeBps: cannot exceed 1000');

  return { squareCap, allocatedSquare: allocated, vestedSquare: sum(vestingAmounts),
    initialLevelFunding: levelLaunchFunding, levelLaunchSupply };
}
