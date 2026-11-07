import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRobinhoodInfrastructure, validateRobinhoodLaunchReadiness, looksLikeWei } from './validate-robinhood-launch.mjs';

const networks = JSON.parse(readFileSync(new URL('./frontend-networks.json', import.meta.url), 'utf8'));
const official = JSON.parse(readFileSync(new URL('./official-infrastructure.json', import.meta.url), 'utf8'));
const template = JSON.parse(readFileSync(new URL('./masonry-launch.template.json', import.meta.url), 'utf8'));

const completeLaunch = () => {
  const doc = structuredClone(template);
  doc.square.vesting = { team: 3000, developer: 2500, treasury: 941, arbitrage: 500 };
  doc.level.authorizedLaunchSupply = 11000;
  return doc;
};

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;

const completeDeployment = () => {
  const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const pm = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
  const c = {
    level: addr(1), square: addr(2), usdc: usdg, poolManager: pm, treasury: addr(5),
    chamber: addr(19), farm: addr(20), xBond: addr(21),
    schedule: addr(6), pass: addr(7), staking: addr(8), settlement: addr(9), lpBurnFee: addr(10),
    levelHook: addr(11), levelOracle: addr(12), buybackGuard: addr(13), levelVault: addr(14),
    squareHook: addr(15), squareVault: addr(16), criticalDefense: addr(17), miniSwapRouter: addr(18),
  };
  const sort = (a, b) => BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const [l0, l1] = sort(c.level, c.usdc);
  const [s0, s1] = sort(c.square, c.usdc);
  return {
    chainId: 4663,
    deployBlock: '1',
    contracts: c,
    pools: {
      level: { currency0: l0, currency1: l1, hooks: c.levelHook, fee: 3000, tickSpacing: 60 },
      square: { currency0: s0, currency1: s1, hooks: c.squareHook, fee: 3000, tickSpacing: 60 },
    },
  };
};

test('current Robinhood infrastructure config is consistent', () => {
  const { rh } = validateRobinhoodInfrastructure(networks, official);
  assert.equal(rh.referenceToken.symbol, 'USDG');
  assert.equal(rh.referenceToken.decimals, 6);
});

test('empty deployment fails as missing addresses', () => {
  assert.throws(
    () => validateRobinhoodLaunchReadiness({ launch: completeLaunch(), deployment: null, networks, official }),
    /missing addresses/,
  );
});

test('a complete record with whole-token amounts passes readiness (fixture only)', () => {
  const out = validateRobinhoodLaunchReadiness({
    launch: completeLaunch(),
    deployment: completeDeployment(),
    networks,
    official,
  });
  assert.equal(out.chainId, 4663);
  assert.equal(out.squareCap, 33333);
});

test('wei-looking launch amounts are rejected', () => {
  const launch = completeLaunch();
  launch.square.farming = 25641 * (10 ** 18);
  assert.throws(
    () => validateRobinhoodLaunchReadiness({ launch, deployment: completeDeployment(), networks, official }),
    /wei/,
  );
});

test('peg-decimals mismatch is rejected', () => {
  const broken = structuredClone(networks);
  broken.networks = broken.networks.map((n) => n.id === 4663 ? { ...n, referenceToken: { ...n.referenceToken, decimals: 18 } } : n);
  assert.throws(() => validateRobinhoodInfrastructure(broken, official), /peg-decimals/);
});

test('looksLikeWei distinguishes whole tokens from raw units', () => {
  assert.equal(looksLikeWei(33333), false);
  assert.equal(looksLikeWei(25641), false);
  assert.equal(looksLikeWei(10 ** 18), true);
});
