import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMasonryLaunch } from './masonry-launch.mjs';

const template = JSON.parse(readFileSync(new URL('./masonry-launch.template.json', import.meta.url), 'utf8'));
const complete = () => {
  const doc = structuredClone(template);
  // Test fixture only, NOT approved allocation split.
  doc.square.vesting = { team: 3000, developer: 2500, treasury: 941, arbitrage: 500 };
  doc.level.authorizedLaunchSupply = 11000;
  return doc;
};

test('incomplete wizard template cannot deploy', () => {
  assert.throws(() => validateMasonryLaunch(template), /square\.vesting\.team/);
});

test('a complete exact allocation reconciles to 33,333', () => {
  const out = validateMasonryLaunch(complete());
  assert.equal(out.squareCap, 33333);
  assert.equal(out.allocatedSquare, 33333);
  assert.equal(out.vestedSquare, 6941);
  assert.equal(out.initialLevelFunding, 11000);
});

test('over-allocation and missing LEVEL funding are rejected', () => {
  const excess = complete();
  excess.square.vesting.team += 1;
  assert.throws(() => validateMasonryLaunch(excess), /SQUARE supply mismatch/);
  const level = complete();
  level.level.authorizedLaunchSupply = 10999;
  assert.throws(() => validateMasonryLaunch(level), /exceeds authorized launch supply/);
});

test('immutable economic boundaries cannot be raised or shortened', () => {
  for (const [key, value] of Object.entries({
    fireTaxRecoverySeconds: 3600,
    farmsCompoundCooldownSeconds: 0,
    operationalVestingDays: 30,
  })) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), /release invariant/);
  }
});

test('other SQUARE supply maxima are configurable with exact reconciliation', () => {
  const cfg = complete();
  cfg.square.maxSupply = 40000;
  cfg.square.vesting.treasury += 6667;
  assert.equal(validateMasonryLaunch(cfg).allocatedSquare, 40000);
});

test('Genesis LP fee, SQUARE treasury splits and critical defense are fixed release invariants', () => {
  for (const [key, value] of Object.entries({
    genesisLevelUsdcLpBurnFeeBps: 100,
    squareTaxPolBps: 1500,
    squareTaxUsdcReserveBps: 1000,
    squareTaxSquareReserveBps: 7500,
    criticalDefenseEntryBps: 8500,
    criticalDefenseExitBps: 10000,
    criticalRecoveryEpochs: 1,
    epochSeconds: 3600,
    governanceTimelocksEnabled: true,
    ownerTradingPauseEnabled: true,
  })) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), /release invariant/);
  }
});

test('Genesis burn execution caps must be positive uint256 decimal strings', () => {
  for (const value of [null, '0', '-100', '1.5', 100, '1e9', '0x10']) {
    const cfg = complete();
    cfg.genesisBurnExecution.maxUsdcPerCallBaseUnits = value;
    assert.throws(() => validateMasonryLaunch(cfg), /positive uint256 decimal string/);
  }
  assert.equal(validateMasonryLaunch(complete()).squareCap, 33333);
});

test('confirmed Genesis rules are fixed launch invariants', () => {
  for (const [key, value] of Object.entries({
    genesisDurationSeconds: 86400,
    genesisLpOpenDelaySeconds: 0,
    genesisLevelSellMinimumBps: 1200,
    genesisLevelSellBurnShareBps: 0,
    genesisNftRequired: false,
    genesisNftPriceUsdc: 0,
    genesisProNftPriceUsdc: 50,
    genesisUltraNftPriceUsdc: 100,
    genesisUltraMultiplier: 4,
    genesisLiquidRewardBps: 10_000,
    genesisVestingInstallments: 1,
    genesisVestingIntervalSeconds: 0,
    genesisWalletClaimFeeBps: 0,
    genesisAutomationFeeBps: 1000,
    squareGenesisSellMinimumBps: 1200,
  })) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), new RegExp(key));
  }
});

test('out-of-bounds configurable tokenomics are rejected', () => {
  const cases = [
    ['fireTaxBaselineBps', 200, /3% floor/],
    ['fireTaxHardCapBps', 2000, /cannot exceed 12%/],
    ['maximumExpansionPerEpochBps', 300, /1–200|2% hard cap/],
    ['maximumExpansionPerEpochBps', 0, /1–200|2% hard cap/],
    ['farmEmissionDays', 0, /1–3650/],
    ['farmEmissionDays', 3651, /1–3650/],
    ['criticalOracleMaxAgeSeconds', 86400, /1–1800/],
    ['criticalOracleMaxAgeSeconds', 0, /1–1800/],
    ['farmShareWethLpAllocPoints', 0, /farmShareWethLpAllocPoints/],
    ['bondMaxDiscountBps', 10001, /bondMaxDiscountBps/],
    ['bondMaxDebtRatioBps', 0, /bondMaxDebtRatioBps/],
    ['bondMaxDebtRatioBps', 10001, /bondMaxDebtRatioBps/],
    ['bondMaxSupply', 0, /bondMaxSupply/],
    ['bondRedeemPremiumBps', 10001, /bondRedeemPremiumBps/],
  ];
  for (const [key, value, pattern] of cases) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), pattern, key);
  }
  const inverted = complete();
  inverted.policy.fireTaxBaselineBps = 1200;
  inverted.policy.fireTaxHardCapBps = 600;
  assert.throws(() => validateMasonryLaunch(inverted), /cannot exceed fireTaxHardCapBps/);
});

test('stricter in-bound tokenomics defaults are accepted', () => {
  const cfg = complete();
  cfg.policy.fireTaxHardCapBps = 900;
  cfg.policy.maximumExpansionPerEpochBps = 100;
  cfg.policy.farmEmissionDays = 180;
  cfg.policy.criticalOracleMaxAgeSeconds = 600;
  cfg.policy.farmShareWethLpAllocPoints = 500;
  cfg.policy.bondMaxDiscountBps = 5000;
  cfg.policy.bondMaxDebtRatioBps = 2000;
  cfg.policy.bondMaxSupply = 500000;
  cfg.policy.bondRedeemPremiumBps = 0;
  assert.equal(validateMasonryLaunch(cfg).squareCap, 33333);
});

test('per-pool range knobs are required and bounded independently', () => {
  const cases = [
    ['rangeLevel', 'halfWidthBps', 400, /500–3000/],
    ['rangeLevel', 'halfWidthBps', 3500, /500–3000/],
    ['rangeSquare', 'halfWidthBps', 400, /500–3000/],
    ['rangeLevel', 'recenterBps', 50, /inner band/],
    ['rangeSquare', 'recenterBps', 800, /inner band/],
    ['rangeLevel', 'cooldownSeconds', 10, /60–86400/],
    ['rangeSquare', 'cooldownSeconds', 90000, /60–86400/],
    ['rangeLevel', 'maxTwapDeviationBps', 0, /1–1000/],
    ['rangeSquare', 'maxTwapDeviationBps', 1500, /1–1000/],
  ];
  for (const [pool, key, value, pattern] of cases) {
    const cfg = complete();
    cfg.policy[pool][key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), pattern, `${pool}.${key}=${value}`);
  }
});

test('daoWallet rejects the zero address and missing farm copy', () => {
  const zero = complete();
  zero.daoWallet = '0x0000000000000000000000000000000000000000';
  assert.throws(() => validateMasonryLaunch(zero), /zero address/);
  const missing = complete();
  missing.daoWallet = 'not-an-address';
  assert.throws(() => validateMasonryLaunch(missing), /20-byte hex address/);
  const noCopy = complete();
  noCopy.policy.farmZapNotice = '';
  assert.throws(() => validateMasonryLaunch(noCopy), /farmZapNotice/);
  const cd = complete();
  cd.policy.farmWithdrawCooldownSeconds = 10;
  assert.throws(() => validateMasonryLaunch(cd), /60–86400/);
});
