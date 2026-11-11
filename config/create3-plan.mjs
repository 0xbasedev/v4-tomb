import { parseNetworks, projectDeploymentKeys } from './schema.mjs';

export const factory = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
export const factoryCodeHash = '0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f';
const proxyHash = '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f';
export const coreRoles = projectDeploymentKeys;
export const masonryRoles = [
  'masonryPeg', 'masonryShare', 'masonrySwapRouter', 'masonryGenesisPass', 'masonryGenesisSchedule', 'masonryGenesisStaking',
  'masonryGenesisSettlement', 'masonryGenesisLPBurnFee', 'masonryLevelUsdcVault', 'masonrySquareUsdcVault',
  'masonryBuybackGuard', 'masonryCompoundGate', 'masonryCriticalDefense', 'masonryLevelOracle',
  'masonryTaxHook', 'masonryShareTaxHook', 'masonryShareOracle',
  'masonryVestingTeam', 'masonryVestingDeveloper', 'masonryVestingTreasury', 'masonryVestingArbitrage',
];
export const bridgeRoles = ['xshareBridge', 'bridgedShare'];
const hookFlags = { hook: 0x1088, masonryTaxHook: 0x35c8, masonryShareTaxHook: 0x35c8 };
const hookMask = 0x3fff;
const searchLimit = 1_000_000;
const roles = new Set([...coreRoles, ...masonryRoles, ...bridgeRoles]);
const domains = [8453, 56, 369, 146];
const uint256Max = (1n << 256n) - 1n;

export function validateAddressPatterns(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Address patterns must be keyed by contract role.');
  const patterns = {};
  for (const [role, pattern] of Object.entries(input)) {
    if (!roles.has(role) || !pattern || typeof pattern !== 'object' || Array.isArray(pattern)
      || Object.keys(pattern).some((key) => key !== 'prefix' && key !== 'suffix')) {
      throw new Error(`Invalid address pattern for ${role}.`);
    }
    const [prefix, suffix] = ['prefix', 'suffix'].map((edge) => {
      const value = Object.hasOwn(pattern, edge) ? pattern[edge] : '';
      if (typeof value !== 'string' || !/^(?:0x)?[0-9a-f]*$/i.test(value.trim())) {
        throw new Error(`Use only hexadecimal digits (0–9 and A–F) in the ${role} ${edge}.`);
      }
      return value.trim().replace(/^0x/i, '').toLowerCase();
    });
    if (!prefix && !suffix) continue;
    const flags = hookFlags[role];
    if (flags !== undefined) {
      const fixedBits = Math.min(suffix.length * 4, 14);
      const fixedMask = (1 << fixedBits) - 1;
      if (prefix.length * 4 + suffix.length * 4 - fixedBits > 4) {
        throw new Error(`The ${role} pattern adds too many search bits. Try a one-character prefix or a shorter suffix.`);
      }
      if (suffix && (parseInt(suffix, 16) & fixedMask) !== (flags & fixedMask)) {
        throw new Error(`The ${role} suffix conflicts with Uniswap permissions. Try ${flags.toString(16).padStart(4, '0')} or leave it blank.`);
      }
    } else if (prefix.length + suffix.length > 4) {
      throw new Error(`Use up to four hexadecimal characters total for the ${role} prefix and suffix.`);
    }
    patterns[role] = { prefix, suffix };
  }
  return patterns;
}

// Both the browser worker and CLI use the same address derivation and plan validation.
export function create3Planner({ concatHex, encodeAbiParameters, encodePacked, getAddress, keccak256, sliceHex }) {
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

  function deriveAddress(plan, role, nonce) {
    const digest = keccak256(encodePacked(['bytes32', 'string', 'uint256'], [plan.releaseId, role, BigInt(nonce)]));
    const salt = concatHex([plan.deployer, '0x00', sliceHex(digest, 0, 11)]);
    const guarded = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [plan.deployer, salt]));
    const proxy = sliceHex(keccak256(concatHex(['0xff', plan.factory, guarded, proxyHash])), 12);
    const address = sliceHex(keccak256(concatHex(['0xd694', proxy, '0x01'])), 12);
    return { address, salt, guarded, proxy };
  }

  function create3Address(plan, role, nonce = plan.addressNonces?.[role] ?? 0) {
    const result = deriveAddress(plan, role, nonce);
    return { ...result, address: getAddress(result.address) };
  }

  function planRoles(plan, release, targetRoles, onSearch) {
    const patterns = validateAddressPatterns(release.addressPatterns);
    const addresses = {};
    const addressNonces = {};
    const hookNonces = {};
    for (const role of targetRoles) {
      const pattern = patterns[role];
      const flags = hookFlags[role];
      if (!pattern && flags === undefined) {
        addresses[role] = create3Address(plan, role).address;
        continue;
      }
      onSearch?.(role);
      let found = false;
      for (let nonce = 0; nonce < searchLimit; nonce++) {
        const { address } = deriveAddress(plan, role, nonce);
        if (pattern && (!address.startsWith('0x' + pattern.prefix) || !address.endsWith(pattern.suffix))) continue;
        if (flags !== undefined && (parseInt(address.slice(-4), 16) & hookMask) !== flags) continue;
        addresses[role] = getAddress(address);
        if (flags !== undefined) hookNonces[role] = nonce;
        else addressNonces[role] = nonce;
        found = true;
        break;
      }
      if (!found) throw new Error(`No match for ${role} after one million attempts. Shorten or clear its address pattern and try again.`);
    }
    if (Object.keys(addressNonces).length) plan.addressNonces = addressNonces;
    return { addresses, hookNonces };
  }

  function planCore(template, release, index) {
    const plan = readRelease(release);
    const document = structuredClone(template);
    const network = parseNetworks(document)[index];
    if (!network || network.deployment !== null) throw new Error('Select an undeployed core network');
    if (release.canonicalDomain != null && release.canonicalDomain !== network.id) {
      throw new Error('Selected core network must match the home chain in the release');
    }
    const { addresses, hookNonces } = planRoles(plan, release, coreRoles);
    network.create3 = { ...plan, addresses, hookNonce: hookNonces.hook };
    parseNetworks(document);
    return document;
  }

  function planMasonry(release, onSearch) {
    const plan = readRelease(release);
    const { canonicalDomain: chainId, masonryInitCodeHashes = {} } = release;
    if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Set the Masonry chain in the release');
    for (const [role, hash] of Object.entries(masonryInitCodeHashes)) {
      if (!masonryRoles.includes(role) || !/^0x[\da-f]{64}$/i.test(hash) || BigInt(hash) === 0n) {
        throw new Error(`Invalid Masonry initcode hash for ${role}`);
      }
    }
    const { addresses, hookNonces } = planRoles(plan, release, masonryRoles, onSearch);
    return {
      ...plan,
      chainId,
      addresses,
      initCodeHashes: masonryInitCodeHashes,
      hookNonces,
    };
  }

  function planBridge(template, release, onSearch) {
    const plan = readRelease(release);
    const { canonicalDomain, canonicalTokenRole, routeCaps, bridgeOperators } = release;
    if (!domains.includes(canonicalDomain) || !['estate', 'masonryShare'].includes(canonicalTokenRole)) {
      throw new Error('Select a supported canonicalDomain and the explicit estate or masonryShare token role');
    }
    const networkIds = template.networks?.map(({ id, domain }) => id === domain ? id : 0) ?? [];
    if (networkIds.length !== domains.length || !domains.every((id) => networkIds.includes(id))) {
      throw new Error('Bridge template must contain the four supported domains exactly once');
    }

    const document = structuredClone(template);
    const { addresses } = planRoles(plan, release, [...bridgeRoles, canonicalTokenRole], onSearch);
    const bridge = addresses.xshareBridge;
    const wrapped = addresses.bridgedShare;
    const canonicalToken = addresses[canonicalTokenRole];
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
  return { create3Address, planCore, planMasonry, planBridge };
}
