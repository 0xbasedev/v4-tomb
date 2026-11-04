import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseNetworks, projectDeploymentKeys } from '../config/schema.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { concatHex, encodeAbiParameters, encodePacked, getAddress, keccak256, sliceHex } = require('viem');

export const factory = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
export const factoryCodeHash = '0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f';
const proxyHash = '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f';
export const coreRoles = projectDeploymentKeys;
export const hashHex = keccak256;
const masonryRoles = [
  'masonryPeg', 'masonryShare', 'masonryGenesisPass', 'masonryGenesisSchedule', 'masonryGenesisStaking',
  'masonryGenesisSettlement', 'masonryGenesisLPBurnFee', 'masonryLevelUsdcVault', 'masonrySquareUsdcVault',
  'masonryBuybackGuard', 'masonryCompoundGate', 'masonryCriticalDefense', 'masonryLevelOracle',
  'masonryTaxHook', 'masonryShareTaxHook', 'masonryShareOracle',
  'masonryVestingTeam', 'masonryVestingDeveloper', 'masonryVestingTreasury', 'masonryVestingArbitrage',
];
const domains = [8453, 4663, 56, 369, 146];
const uint256Max = (1n << 256n) - 1n;

function requireAddress(value, label) {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || BigInt(value) === 0n) {
    throw new Error(`${label} must be a nonzero address`);
  }
  return getAddress(value);
}

function readRelease(release) {
  if (typeof release?.releaseId !== 'string' || !/^0x[\da-f]{64}$/i.test(release.releaseId)
    || BigInt(release.releaseId) === 0n) throw new Error('releaseId must be a nonzero bytes32');
  return { factory, deployer: requireAddress(release.deployer, 'deployer'), releaseId: release.releaseId };
}

export function create3Address(plan, role, nonce = 0) {
  const digest = keccak256(encodePacked(['bytes32', 'string', 'uint256'], [plan.releaseId, role, BigInt(nonce)]));
  const salt = concatHex([plan.deployer, '0x00', sliceHex(digest, 0, 11)]);
  const guarded = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [plan.deployer, salt]));
  const proxy = sliceHex(keccak256(concatHex(['0xff', plan.factory, guarded, proxyHash])), 12);
  const address = getAddress(sliceHex(keccak256(concatHex(['0xd694', proxy, '0x01'])), 12));
  return { address, salt, guarded, proxy };
}

function mineHook(plan, role, flags) {
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const { address } = create3Address(plan, role, nonce);
    if ((BigInt(address) & 0x3fffn) === flags) return { address, nonce };
  }
  throw new Error(`No hook salt found for ${role}`);
}

export function planCore(template, release, index) {
  const plan = readRelease(release);
  const document = structuredClone(template);
  const network = parseNetworks(document)[index];
  if (!network || network.deployment !== null) throw new Error('Select an undeployed core network');
  if (release.canonicalDomain != null && release.canonicalDomain !== network.id) {
    throw new Error('Selected core network must match the home chain in the release');
  }
  const { address: hook, nonce: hookNonce } = mineHook(plan, 'hook', 0x1088n);
  const addresses = Object.fromEntries(coreRoles.map((role) => [
    role, role === 'hook' ? hook : create3Address(plan, role).address,
  ]));
  network.create3 = { ...plan, addresses, hookNonce };
  parseNetworks(document);
  return document;
}

export function planMasonry(release) {
  const plan = readRelease(release);
  const { canonicalDomain: chainId, masonryInitCodeHashes = {} } = release;
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Set the Masonry chain in the release');
  for (const [role, hash] of Object.entries(masonryInitCodeHashes)) {
    if (!masonryRoles.includes(role) || !/^0x[\da-f]{64}$/i.test(hash) || BigInt(hash) === 0n) {
      throw new Error(`Invalid Masonry initcode hash for ${role}`);
    }
  }
  // Before/after initialize, after add/remove liquidity, before/after swap, before swap delta.
  const hookFlags = 0x35c8n;
  const hooks = Object.fromEntries(['masonryTaxHook', 'masonryShareTaxHook'].map((role) => [
    role, mineHook(plan, role, hookFlags),
  ]));
  const addresses = Object.fromEntries(masonryRoles.map((role) => [
    role, hooks[role]?.address ?? create3Address(plan, role).address,
  ]));
  return {
    ...plan,
    chainId,
    addresses,
    initCodeHashes: masonryInitCodeHashes,
    hookNonces: Object.fromEntries(Object.entries(hooks).map(([role, result]) => [role, result.nonce])),
  };
}

export function planBridge(template, release) {
  const plan = readRelease(release);
  const { canonicalDomain, canonicalTokenRole, routeCaps, bridgeOperators } = release;
  if (!domains.includes(canonicalDomain) || !['estate', 'masonryShare'].includes(canonicalTokenRole)) {
    throw new Error('Select a supported canonicalDomain and the explicit estate or masonryShare token role');
  }
  const networkIds = template.networks?.map(({ id, domain }) => id === domain ? id : 0) ?? [];
  if (networkIds.length !== domains.length || !domains.every((id) => networkIds.includes(id))) {
    throw new Error('Bridge template must contain the five supported domains exactly once');
  }

  const document = structuredClone(template);
  const bridge = create3Address(plan, 'xshareBridge').address;
  const wrapped = create3Address(plan, 'bridgedShare').address;
  const canonicalToken = create3Address(plan, canonicalTokenRole).address;
  const satellites = domains.filter((id) => id !== canonicalDomain);
  document.create3 = plan;
  document.canonicalDomain = canonicalDomain;
  document.canonicalTokenRole = canonicalTokenRole;
  document.routeCaps = Object.fromEntries(satellites.map((id) => {
    const cap = routeCaps?.[id];
    if (typeof cap !== 'string' || !/^[1-9]\d{0,77}$/.test(cap) || BigInt(cap) > uint256Max) {
      throw new Error(`routeCaps.${id} must be a positive uint256 decimal string`);
    }
    return [id, cap];
  }));
  for (const network of document.networks) {
    const home = network.id === canonicalDomain;
    network.bridge = bridge;
    network.token = home ? canonicalToken : wrapped;
    network.bridgeOwner = requireAddress(bridgeOperators?.[network.id]?.owner, `bridgeOperators.${network.id}.owner`);
    network.bridgeIsm = requireAddress(bridgeOperators?.[network.id]?.ism, `bridgeOperators.${network.id}.ism`);
    network.enabled = false;
    network.routes = (home ? satellites : [canonicalDomain]).map((id) => ({
      domain: id, peer: bridge, limit: document.routeCaps[home ? id : network.id],
    }));
  }
  return document;
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

function main([target, template, releaseFile, output, index = '0', ...extra]) {
  if (!['core', 'bridge', 'masonry'].includes(target) || !releaseFile || !output
    || !/^(0|[1-9]\d*)$/.test(index) || extra.length !== 0) {
    throw new Error('Usage: node scripts/create3.mjs <core|bridge|masonry> <template (use - for masonry)> <release> <output> [core-network-index]');
  }
  const release = read(releaseFile);
  const result = target === 'core' ? planCore(read(template), release, Number(index))
    : target === 'bridge' ? planBridge(read(template), release)
    : planMasonry(release);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`Wrote predicted addresses to ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
