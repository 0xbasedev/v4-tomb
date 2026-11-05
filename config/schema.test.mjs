import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNetworks, transactionUrl, pegReserves, deploymentKeys } from './schema.mjs';
import { publishDeployment } from '../scripts/protocol.mjs';

const local = JSON.parse(readFileSync(new URL('./examples/local.json', import.meta.url)));
const historical = JSON.parse(readFileSync(new URL('./examples/upstream-base-sepolia.json', import.meta.url)));
const clone = (value) => structuredClone(value);

test('local template is valid, unconfigured and contains no deployed addresses', () => {
  assert.equal(parseNetworks(local)[0].deployment, null);
  assert.equal(Object.values(local.networks[0].infrastructure).every((value) => value === null), true);
});

test('historical upstream deployment remains available as explicit configuration', () => {
  assert.equal(parseNetworks(historical)[0].id, 84532);
});

for (const [description, change] of [
  ['unknown schema', (d) => { d.schemaVersion = 2; }],
  ['empty networks', (d) => { d.networks = []; }],
  ['duplicate chains', (d) => { d.networks.push(clone(d.networks[0])); }],
  ['unsafe chain ID', (d) => { d.networks[0].id = Number.MAX_SAFE_INTEGER + 1; }],
  ['bad RPC scheme', (d) => { d.networks[0].rpcUrl = 'javascript:alert(1)'; }],
  ['embedded RPC credentials', (d) => { d.networks[0].rpcUrl = 'https://key:secret@example.com'; }],
  ['bad explorer scheme', (d) => { d.networks[0].explorerUrl = 'ftp://example.com'; }],
  ['missing infrastructure key', (d) => { delete d.networks[0].infrastructure.permit2; }],
  ['zero infrastructure', (d) => { d.networks[0].infrastructure.weth = `0x${'0'.repeat(40)}`; }],
  ['missing deployed-network factory', (d) => { d.networks[0].infrastructure.create2Deployer = null; }],
  ['partial deployment', (d) => { delete d.networks[0].deployment.oracle; }],
  ['numeric block precision risk', (d) => { d.networks[0].deployment.deployBlock = 42; }],
  ['negative deployment block', (d) => { d.networks[0].deployment.deployBlock = '-1'; }],
  ['inconsistent manager', (d) => { d.networks[0].deployment.poolManager = d.networks[0].deployment.weth; }],
  ['wrong hook flags', (d) => { d.networks[0].deployment.hook = d.networks[0].deployment.money; }],
  ['identical peg and MONEY', (d) => { d.networks[0].deployment.money = d.networks[0].deployment.weth; }],
]) {
  test(`rejects ${description}`, () => {
    const value = clone(historical);
    change(value);
    assert.throws(() => parseNetworks(value), /Network configuration:/);
  });
}

test('arbitrary chain IDs and two network profiles work without code changes', () => {
  const value = clone(local);
  value.networks[0].id = 707070;
  value.networks.push({ ...clone(value.networks[0]), id: 909090 });
  assert.deepEqual(parseNetworks(value).map((n) => n.id), [707070, 909090]);
});

test('explorer URLs use the originating chain and omit missing explorers', () => {
  const hash = `0x${'a'.repeat(64)}`;
  assert.equal(transactionUrl(parseNetworks(historical), 84532, hash), `https://sepolia.basescan.org/tx/${hash}`);
  assert.equal(transactionUrl(parseNetworks(historical), 1, hash), undefined);
  assert.equal(transactionUrl(parseNetworks(local), 31337, hash), undefined);
  assert.equal(transactionUrl(parseNetworks(historical), 84532, 'invalid'), undefined);
});

test('pool reserves map correctly for both address orderings and checksum case', () => {
  const low = `0x${'0'.repeat(36)}aAaA`;
  const high = `0x${'f'.repeat(40)}`;
  assert.deepEqual(pegReserves(low, high, 11n, 22n), { money: 11n, weth: 22n });
  assert.deepEqual(pegReserves(high, low, 11n, 22n), { money: 22n, weth: 11n });
});

function publication() {
  const document = clone(historical);
  const deployment = document.networks[0].deployment;
  const artifact = { ...deployment, chainId: 84532 };
  const names = ['OldMoney', 'Estate', 'TrustNote', 'Treasury', 'Boardroom', 'Oracle',
    'V4PositionWrapper', 'GenesisRewardPool', 'MainRewardPool', 'ShareRewardPool', 'MiniSwapRouter', 'Timelock'];
  const keys = ['money', 'estate', 'trustNote', 'treasury', 'boardroom', 'oracle', 'lpWrapper',
    'genesisRewardPool', 'mainRewardPool', 'shareRewardPool', 'miniSwapRouter', 'timelock'];
  const broadcast = { chain: 84532, transactions: names.map((contractName, index) => ({
    contractName, transactionType: 'CREATE', hash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  })) };
  const rpc = async (method, params) => {
    if (method === 'eth_chainId') return '0x14a34';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getTransactionReceipt') {
      const index = broadcast.transactions.findIndex((tx) => tx.hash === params[0]);
      return { status: '0x1', blockNumber: `0x${(42 + index).toString(16)}`, contractAddress: deployment[keys[index]] };
    }
    throw new Error('unexpected RPC');
  };
  return { document, artifact, broadcast, rpc };
}

test('publishes a complete deployment only after checking mined receipts and code', async () => {
  const p = publication();
  const result = await publishDeployment(p.document, p.artifact, p.broadcast, 0, p.rpc);
  assert.equal(result.networks[0].deployment.deployBlock, '42');
  assert.equal(Object.keys(result.networks[0].deployment).length, deploymentKeys.length + 1);
  assert.equal(p.document.networks[0].deployment.deployBlock, '41868762');
});

test('publishes renamed peg and share artifacts using the same legacy manifest keys', async () => {
  const p = publication();
  p.broadcast.transactions[0].contractName = 'PegToken';
  p.broadcast.transactions[1].contractName = 'ShareToken';
  const result = await publishDeployment(p.document, p.artifact, p.broadcast, 0, p.rpc);
  assert.equal(result.networks[0].deployment.money, p.artifact.money);
  assert.equal(result.networks[0].deployment.estate, p.artifact.estate);
});

for (const [description, change, expected] of [
  ['simulation without transaction hashes', (p) => { delete p.broadcast.transactions[0].hash; }, /completed broadcast/],
  ['broadcast chain mismatch', (p) => { p.broadcast.chain = 1; }, /same chain/],
  ['RPC chain mismatch', (p) => { const rpc = p.rpc; p.rpc = (m, a) => m === 'eth_chainId' ? '0x1' : rpc(m, a); }, /RPC chain mismatch/],
  ['reverted transaction', (p) => { const rpc = p.rpc; p.rpc = async (m, a) => m === 'eth_getTransactionReceipt' ? { ...await rpc(m, a), status: '0x0' } : rpc(m, a); }, /successful mined/],
  ['pending transaction', (p) => { const rpc = p.rpc; p.rpc = (m, a) => m === 'eth_getTransactionReceipt' ? null : rpc(m, a); }, /successful mined/],
  ['artifact from another simulation', (p) => { p.artifact.money = p.artifact.estate; }, /creation receipt/],
  ['missing deployed code', (p) => { const rpc = p.rpc; p.rpc = (m, a) => m === 'eth_getCode' ? '0x' : rpc(m, a); }, /No deployed code/],
]) {
  test(`publication rejects ${description}`, async () => {
    const p = publication();
    change(p);
    await assert.rejects(publishDeployment(p.document, p.artifact, p.broadcast, 0, p.rpc), expected);
  });
}
