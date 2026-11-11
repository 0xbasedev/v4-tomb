import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coreRoles, create3Address, factory, planBridge, planCore, planMasonry } from '../scripts/create3.mjs';
import { verifyCreate3Receipts } from '../scripts/protocol.mjs';
import { parseNetworks } from './schema.mjs';
import { validateAddressPatterns } from './create3-plan.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const core = read('./examples/local.json');
const bridge = read('./xshare-bridge.json');
const base = {
  releaseId: '0x' + '99'.repeat(32),
  deployer: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
};
const account = '0x0000000000000000000000000000000000000123';
const release = {
  ...base,
  canonicalDomain: 8453,
  canonicalTokenRole: 'estate',
  routeCaps: { 56: '200', 369: '300', 146: '400' },
  bridgeOperators: Object.fromEntries(bridge.networks.map(({ id }) => [id, { owner: account, ism: account }])),
};
const corePlan = planCore(core, base, 0).networks[0].create3;

test('core plan has the expected CreateX hook flags and matches the Solidity fixture', () => {
  const fixture = read('../contracts/test/fixtures/networks.json');
  assert.deepEqual(corePlan, fixture.networks[0].create3);
  assert.equal(BigInt(corePlan.addresses.hook) & 0x3fffn, 0x1088n);
  assert.equal(core.networks[0].deployment, null);
  assert.equal(new Set(Object.values(corePlan.addresses)).size, coreRoles.length);
  const create3 = create3Address(corePlan, 'estate');
  assert.equal(create3.salt.slice(0, 44).toLowerCase(), base.deployer.toLowerCase() + '00');
  assert.notEqual(create3Address({ ...corePlan, deployer: account }, 'estate').address, create3.address);
  assert.notEqual(create3Address({ ...corePlan, releaseId: '0x' + '88'.repeat(32) }, 'estate').address, create3.address);
});

test('bridge plan links its home token to the core plan and configures reciprocal caps', () => {
  const planned = planBridge(bridge, release);
  const [home, ...satellites] = planned.networks;
  assert.equal(home.token, corePlan.addresses.estate);
  assert.equal(home.bridge, create3Address(corePlan, 'xshareBridge').address);
  for (const satellite of satellites) {
    assert.equal(satellite.bridge, home.bridge);
    assert.equal(satellite.token, create3Address(corePlan, 'bridgedShare').address);
    assert.deepEqual(satellite.routes, [{ domain: home.id, peer: home.bridge, limit: release.routeCaps[satellite.id] }]);
    assert.deepEqual(home.routes.find(({ domain }) => domain === satellite.id),
      { domain: satellite.id, peer: satellite.bridge, limit: release.routeCaps[satellite.id] });
  }
  assert.ok(planned.networks.every(({ enabled }) => !enabled));
  assert.ok(bridge.networks.every(({ bridge }) => bridge === null));
});

test('bridge plan requires explicit home token, owners, verifiers and caps', () => {
  assert.throws(() => planBridge(bridge, { ...release, canonicalTokenRole: null }), /token role/);
  assert.throws(() => planBridge(bridge, { ...release, bridgeOperators: {} }), /owner/);
  assert.throws(() => planBridge(bridge, { ...release, routeCaps: {} }), /routeCaps/);
});

test('modern Masonry plans its hook flags and independent oracle and token addresses', () => {
  const plan = planMasonry(release);
  const bridgePlan = planBridge(bridge, { ...release, canonicalTokenRole: 'masonryShare' });
  assert.equal(bridgePlan.networks[0].token, plan.addresses.masonryShare);
  assert.equal(BigInt(plan.addresses.masonryTaxHook) & 0x3fffn, 0x35c8n);
  assert.equal(BigInt(plan.addresses.masonryShareTaxHook) & 0x3fffn, 0x35c8n);
  assert.notEqual(plan.addresses.masonryLevelOracle, plan.addresses.masonryShareOracle);
  assert.deepEqual(plan.initCodeHashes, {});
});

test('custom addresses match both ends and replay the same salt across plans', () => {
  const addressPatterns = {
    masonryShare: { prefix: '0xA', suffix: 'B' },
    masonryGenesisSchedule: { prefix: 'c', suffix: '3' },
    masonryTaxHook: { suffix: '35c8' },
    xshareBridge: { suffix: 'd' },
    bridgedShare: { prefix: 'e' },
  };
  const customized = { ...release, canonicalDomain: 777, addressPatterns };
  const plan = planMasonry(customized);
  const bridgePlan = planBridge(bridge, { ...customized, canonicalDomain: 8453, canonicalTokenRole: 'masonryShare' });
  assert.equal(plan.addresses.masonryGenesisSchedule, '0xC1e16e56c5f5075D3b0E35508f518CBFec035683');
  assert.equal(plan.addressNonces.masonryGenesisSchedule, 399);
  assert.match(plan.addresses.masonryShare, /^0xa[0-9a-f]{38}b$/i);
  assert.equal(create3Address(plan, 'masonryShare').address, plan.addresses.masonryShare);
  assert.equal(bridgePlan.networks[0].token, plan.addresses.masonryShare);
  assert.equal(bridgePlan.create3.addressNonces.masonryShare, plan.addressNonces.masonryShare);
  assert.ok(bridgePlan.networks.every(({ bridge }) => bridge.toLowerCase().endsWith('d')));
  assert.ok(bridgePlan.networks.slice(1).every(({ token }) => token.toLowerCase().startsWith('0xe')));
  assert.equal(BigInt(plan.addresses.masonryTaxHook) & 0xffffn, 0x35c8n);
});

test('validates patterns and rejects conflicting hook flags before searching', () => {
  assert.deepEqual(validateAddressPatterns({ masonryPeg: { prefix: ' 0xAb ', suffix: 'CD' } }),
    { masonryPeg: { prefix: 'ab', suffix: 'cd' } });
  assert.throws(() => validateAddressPatterns({ masonryPeg: { prefix: 'xtomb' } }), /hexadecimal/);
  assert.throws(() => validateAddressPatterns({ masonryPeg: { prefix: 'abc', suffix: 'de' } }), /up to four/);
  assert.throws(() => validateAddressPatterns({ typo: { suffix: 'b' } }), /Invalid address pattern/);
  assert.throws(() => planMasonry({ ...release, addressPatterns: { masonryTaxHook: { suffix: 'dead' } } }), /conflicts with Uniswap permissions/);
  assert.throws(() => validateAddressPatterns({ hook: { prefix: 'ab' } }), /too many search bits/);
});

test('legacy core custom addresses match the Solidity deployment fixture', () => {
  const plan = planCore(core, {
    ...base, addressPatterns: { money: { prefix: 'a', suffix: 'd' }, miniSwapRouter: { suffix: 'b' }, timelock: { prefix: 'c' } },
  }, 0).networks[0].create3;
  assert.deepEqual(plan, read('../contracts/test/fixtures/networks.json').networks[1].create3);
  assert.match(plan.addresses.money, /^0xa[0-9a-f]{38}d$/i);
  assert.equal(plan.addresses.estate, corePlan.addresses.estate);
});

test('schema keeps planned addresses separate and rejects an inconsistent plan', () => {
  const planned = planCore(core, base, 0);
  assert.equal(parseNetworks(planned)[0].deployment, null);
  planned.networks[0].create3.addresses.estate = planned.networks[0].create3.addresses.money;
  assert.throws(() => parseNetworks(planned), /must be unique/);
});

const created = '0x4db17dd5e4732fb6da34a148104a592783ca119a1e7bb8829eba6cbadef0b511';
const proxyCreated = '0x2feea65dd4e9f9cbd86b74b7734210c59a1b2981b5b137bd0ee3e208200c9067';
const topic = (address) => '0x' + address.slice(2).padStart(64, '0');

test('receipt verification requires the planned factory, caller, proxy and contract events', async () => {
  const plan = read('../contracts/test/fixtures/networks.json').networks[1].create3;
  const receipts = coreRoles.map((role) => {
    const predicted = create3Address(plan, role, role === 'hook' ? plan.hookNonce : undefined);
    return {
      to: factory, from: base.deployer, contractAddress: null,
      logs: [
        { address: factory, topics: [proxyCreated, topic(predicted.proxy), predicted.guarded] },
        { address: factory, topics: [created, topic(predicted.address)] },
      ],
    };
  });
  await verifyCreate3Receipts(plan, plan.addresses, receipts);
  const wrongNonce = { ...plan, addressNonces: { ...plan.addressNonces, money: plan.addressNonces.money + 1 } };
  await assert.rejects(verifyCreate3Receipts(wrongNonce, plan.addresses, receipts), /does not match the CREATE3 prediction/);
  const wrongSalt = structuredClone(receipts);
  wrongSalt[0].logs[0].topics[2] = '0x' + '00'.repeat(32);
  await assert.rejects(verifyCreate3Receipts(plan, plan.addresses, wrongSalt), /creation receipt/);
  await assert.rejects(verifyCreate3Receipts(plan, plan.addresses, receipts.map((receipt) => ({ ...receipt, from: account }))), /creation receipt/);
});
