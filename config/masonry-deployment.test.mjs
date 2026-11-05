import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { masonryContractKeys, officialChain, parseMasonryDeployment } from './masonry-deployment.mjs';

const registry = JSON.parse(readFileSync(new URL('./official-infrastructure.json', import.meta.url), 'utf8'));
const base = officialChain(registry, 84532);
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;

function fixture() {
  const contracts = Object.fromEntries(masonryContractKeys.map((k, i) => [k, addr(0x1000 + i)]));
  contracts.poolManager = base.poolManager;
  contracts.usdc = base.usdc;
  const sorted = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
  const [l0, l1] = sorted(contracts.level, contracts.usdc);
  const [s0, s1] = sorted(contracts.square, contracts.usdc);
  return {
    chainId: 84532,
    deployBlock: '1',
    contracts,
    pools: {
      level: { currency0: l0, currency1: l1, fee: 3000, tickSpacing: 60, hooks: contracts.levelHook },
      square: { currency0: s0, currency1: s1, fee: 3000, tickSpacing: 60, hooks: contracts.squareHook },
    },
  };
}

test('a complete record on an official chain validates', () => {
  assert.equal(parseMasonryDeployment(fixture(), registry).chainId, 84532);
});

test('every registry chain lists a v4 PoolManager and native USDC', () => {
  for (const chain of registry.chains) {
    assert.match(chain.poolManager, /^0x[0-9a-fA-F]{40}$/);
    assert.match(chain.usdc, /^0x[0-9a-fA-F]{40}$/);
  }
});

test('unofficial USDC, PoolManager or chain is rejected', () => {
  const usdc = fixture();
  usdc.contracts.usdc = addr(0xdead);
  assert.throws(() => parseMasonryDeployment(usdc, registry), /native USDC|official USDC/);
  const pm = fixture();
  pm.contracts.poolManager = addr(0xbeef);
  assert.throws(() => parseMasonryDeployment(pm, registry), /official Uniswap v4 PoolManager/);
  const chain = fixture();
  chain.chainId = 56;
  assert.throws(() => parseMasonryDeployment(chain, registry), /no Uniswap v4 PoolManager with native USDC/);
});

test('pool keys must pair the asset with USDC through the bound hook, static fee', () => {
  const hook = fixture();
  hook.pools.level.hooks = hook.contracts.squareHook;
  assert.throws(() => parseMasonryDeployment(hook, registry), /bound hook/);
  const order = fixture();
  [order.pools.square.currency0, order.pools.square.currency1] = [order.pools.square.currency1, order.pools.square.currency0];
  assert.throws(() => parseMasonryDeployment(order, registry), /sort below/);
  const dynamic = fixture();
  dynamic.pools.level.fee = 0x800000;
  assert.throws(() => parseMasonryDeployment(dynamic, registry), /fee/);
});

test('repeated contract addresses are rejected', () => {
  const dup = fixture();
  dup.contracts.squareVault = dup.contracts.levelVault;
  assert.throws(() => parseMasonryDeployment(dup, registry), /repeats/);
});
