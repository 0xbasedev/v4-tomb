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
