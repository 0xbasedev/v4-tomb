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

test('Genesis burn execution caps must be positive uint256 decimal strings', () => {
  for (const value of [null, '0', '-100', '1.5', 100, '1e9', '0x10']) {
    const cfg = complete();
    cfg.genesisBurnExecution.maxUsdcPerCallBaseUnits = value;
    assert.throws(() => validateMasonryLaunch(cfg), /positive uint256 decimal string/);
  }
  assert.equal(validateMasonryLaunch(complete()).squareCap, 33333);
});
