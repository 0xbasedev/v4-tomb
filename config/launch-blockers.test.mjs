import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create3Address, planMasonry } from '../scripts/create3.mjs';
import { factory, masonryRoles } from './create3-plan.mjs';
import { masonryPlanBlockers, onchainBlockers } from './launch-blockers.mjs';

const release = {
  releaseId: '0x' + '11'.repeat(32), deployer: '0x' + '22'.repeat(20), canonicalDomain: 4663,
  masonryInitCodeHashes: Object.fromEntries(masonryRoles.map((r, i) => [r, '0x' + (i + 1).toString(16).padStart(64, '0')])),
};
const plan = planMasonry(release);
const infra = { poolManager: '0x' + '33'.repeat(20), positionManager: '0x' + '44'.repeat(20), permit2: '0x' + '55'.repeat(20), universalRouter: '0x' + '66'.repeat(20), pegToken: '0x' + '77'.repeat(20) };
const policy = { liquidityWithdrawFeeBps: 200, fireTaxHardCapBps: 1200, fireTaxBaselineBps: 300 };

test('a complete plan has no blockers', () => {
  assert.deepEqual(masonryPlanBlockers(plan, { expectedChainId: 4663, create3Address, infrastructure: infra, pegToken: { decimals: 6 }, registryPegDecimals: 6, policy }), []);
});

test('each mismatch is a hard blocker', () => {
  const cases = [
    [{ ...plan, chainId: 8453 }, {}, /chainId mismatch/],
    [{ ...plan, factory: '0x' + '99'.repeat(20) }, {}, /factory/],
    [{ ...plan, deployer: '0x' + '0'.repeat(40) }, {}, /deployer/],
    [{ ...plan, addresses: { ...plan.addresses, masonryFarm: undefined } }, {}, /export incomplete: masonryFarm/],
    [{ ...plan, addresses: { ...plan.addresses, masonryFarm: plan.addresses.masonryPeg } }, {}, /repeats|salt/],
    [{ ...plan, addresses: { ...plan.addresses, masonryTaxHook: '0x' + 'ab'.repeat(20) } }, {}, /permission bits|salt/],
    [plan, { infrastructure: { ...infra, permit2: null } }, /missing dependency: permit2/],
    [plan, { pegToken: { decimals: 18 }, registryPegDecimals: 6 }, /wrong peg token decimals/],
    [plan, { policy: { ...policy, liquidityWithdrawFeeBps: 1500 } }, /10% cap/],
    [plan, { policy: { ...policy, fireTaxHardCapBps: 1300 } }, /12% cap/],
  ];
  for (const [p, o, re] of cases) {
    const b = masonryPlanBlockers(p, { expectedChainId: 4663, create3Address, ...o });
    assert.ok(b.some((x) => re.test(x)), `${re} not in ${JSON.stringify(b)}`);
  }
  assert.equal(factory.length, 42);
});

test('on-chain: missing code and unbound range managers block', () => {
  const b = onchainBlockers({ code: { masonryFarm: '0x' }, rangeManagerOf: { masonryTaxHook: plan.addresses.masonryLevelRangeManager }, plan, decimalsRead: 18, decimalsExpected: 6 });
  assert.ok(b.some((x) => /no code at masonryFarm/.test(x)));
  assert.ok(b.some((x) => /unbound: masonryShareTaxHook/.test(x)));
  assert.ok(!b.some((x) => /unbound: masonryTaxHook/.test(x)));
  assert.ok(b.some((x) => /wrong peg token decimals/.test(x)));
});

test('networks.json, frontend-networks.json and the registry agree; divergence blocks', async () => {
  const { readFileSync } = await import('node:fs');
  const { manifestBlockers } = await import('./launch-blockers.mjs');
  const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url)));
  const [p, f, r] = [read('./networks.json'), read('./frontend-networks.json'), read('./official-infrastructure.json')];
  assert.deepEqual(manifestBlockers(p, f, r), []);
  p.networks.find((n) => n.id === 4663).pegToken.decimals = 18;
  assert.ok(manifestBlockers(p, f, r).some((x) => /pegTokenDecimals disagrees/.test(x)));
});
