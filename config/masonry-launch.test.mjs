import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMasonryLaunch } from './masonry-launch.mjs';

const template = JSON.parse(readFileSync(new URL('./masonry-launch.template.json', import.meta.url), 'utf8'));
const complete = () => {
  const doc = structuredClone(template);
  doc.level.authorizedLaunchSupply = 11000;
  return doc;
};

test('incomplete wizard template cannot deploy', () => {
  assert.throws(() => validateMasonryLaunch(template), /level\.authorizedLaunchSupply/);
});

test('a complete exact allocation reconciles to 33,333', () => {
  const out = validateMasonryLaunch(complete());
  assert.equal(out.squareCap, 33333);
  assert.equal(out.allocatedSquare, 33333);
  assert.equal(out.vestedSquare, 6841);
  assert.equal(out.liquidDeployerSquare, 101);
  assert.equal(out.initialLevelFunding, 11000);
});

test('the template carries the owner-decided xSHARE vesting split', () => {
  assert.deepEqual(template.square.vesting, { team: 1000, developer: 1000, treasury: 2940, arbitrage: 1901 });
  assert.equal(template.square.initial.deployerDao, 100);
  assert.equal(template.square.deployer + template.square.initial.deployerDao, 101);
  // Arbitrage holds 1,951 in total with its initial 50.
  assert.equal(template.square.initial.arbitrage + template.square.vesting.arbitrage, 1951);
});

test('the deployer/DAO outright allocation is required and counted', () => {
  const missing = complete();
  delete missing.square.initial.deployerDao;
  assert.throws(() => validateMasonryLaunch(missing), /square\.initial\.deployerDao/);
  const moved = complete();
  moved.square.initial.deployerDao = 0;
  assert.throws(() => validateMasonryLaunch(moved), /SQUARE supply mismatch/);
});

test('keeper cadence is a fixed launch invariant: 3h for every pass', () => {
  for (const [key, value] of Object.entries({ genesisProKeeperIntervalSeconds: 21600, genesisUltraKeeperIntervalSeconds: 21600 })) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), /release invariant/);
  }
});

test('advancing the epoch costs a fixed $20 for every caller', () => {
  for (const value of [0, 5, 19, 21, undefined]) {
    const cfg = complete();
    cfg.policy.epochAdvanceFeeUsd = value;
    assert.throws(() => validateMasonryLaunch(cfg), /policy\.epochAdvanceFeeUsd: Masonry release invariant must equal 20/);
  }
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

test('confirmed Genesis rules are fixed launch invariants', () => {
  for (const [key, value] of Object.entries({
    genesisDurationSeconds: 86400,
    genesisLpOpenDelaySeconds: 0,
    genesisLevelSellMinimumBps: 300,
    genesisTaxDecayBpsPerEpoch: 0,
    fireTaxBaselineBps: 300,
    fireTaxHardCapBps: 1200,
    shareSellTaxBps: 600,
    withdrawFeeBaselineBps: 300,
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
    ['maximumExpansionPerEpochBps', 300, /1–200|2% hard cap/],
    ['maximumExpansionPerEpochBps', 0, /1–200|2% hard cap/],
    ['farmEmissionDays', 0, /1–3650/],
    ['farmEmissionDays', 3651, /1–3650/],
    ['criticalOracleMaxAgeSeconds', 86400, /1–1800/],
    ['criticalOracleMaxAgeSeconds', 0, /1–1800/],
    ['farmShareWethLpAllocPoints', 0, /farmShareWethLpAllocPoints/],
  ];
  for (const [key, value, pattern] of cases) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), pattern, key);
  }
});

test('stricter in-bound tokenomics defaults are accepted', () => {
  const cfg = complete();
  cfg.policy.maximumExpansionPerEpochBps = 100;
  cfg.policy.farmEmissionDays = 180;
  cfg.policy.criticalOracleMaxAgeSeconds = 600;
  cfg.policy.farmShareWethLpAllocPoints = 500;
  assert.equal(validateMasonryLaunch(cfg).squareCap, 33333);
});

test('per-pool range knobs are required and bounded independently', () => {
  const cases = [
    ['rangeLevel', 'lowerHalfWidthBps', 400, /500–3000/],
    ['rangeLevel', 'upperHalfWidthBps', 3500, /500–3000/],
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
  const claim = complete();
  claim.policy.farmClaimToWallet = true;
  assert.throws(() => validateMasonryLaunch(claim), /farmClaimToWallet/);
});

test('share sell tax base is fixed at 3%', () => {
  const cfg = complete();
  cfg.policy.shareSellTaxBps = 1300;
  assert.throws(() => validateMasonryLaunch(cfg), /shareSellTaxBps/);
  const zero = complete();
  zero.policy.shareSellTaxBps = 0;
  assert.throws(() => validateMasonryLaunch(zero), /shareSellTaxBps/);
  assert.equal(validateMasonryLaunch(complete()).squareCap, 33333);
});
