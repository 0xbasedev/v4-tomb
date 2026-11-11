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

test('keeper cadence is a fixed launch invariant: Pro 6h, Ultra 3h', () => {
  for (const [key, value] of Object.entries({ genesisProKeeperIntervalSeconds: 10800, genesisUltraKeeperIntervalSeconds: 21600 })) {
    const cfg = complete();
    cfg.policy[key] = value;
    assert.throws(() => validateMasonryLaunch(cfg), /release invariant/);
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
    fireTaxHardCapBps: 2000,
    maximumExpansionPerEpochBps: 300,
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
    criticalOracleMaxAgeSeconds: 86400,
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
