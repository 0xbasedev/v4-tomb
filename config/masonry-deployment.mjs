// Masonry (xTOMB / xSHARE) deployment manifest: the one schema the Wizard
// writes, the frontend reads and Admin displays. Pure validation — no RPC.
// On-chain checks (code, decimals, symbol, bound addresses) run separately
// in the Wizard and Admin against the same keys.

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
const fail = (message) => { throw new Error(`Masonry deployment: ${message}`); };

/** Contracts every xTOMB deployment must record, in the order Admin lists them. */
export const masonryContractKeys = [
  'level', 'square', 'usdc', 'poolManager', 'treasury',
  'schedule', 'pass', 'staking', 'settlement', 'lpBurnFee',
  'levelHook', 'levelOracle', 'buybackGuard', 'levelVault',
  'squareHook', 'squareVault', 'criticalDefense', 'miniSwapRouter',
];

/** Human labels for the same keys (UI uses these; contract names in parentheses). */
export const masonryContractLabels = {
  level: 'xTOMB token (LEVEL)',
  square: 'xSHARE token (SQUARE)',
  usdc: 'USDC (official, 6 decimals)',
  poolManager: 'Uniswap v4 PoolManager',
  treasury: 'Treasury',
  schedule: 'Genesis schedule (MasonryGenesisSchedule)',
  pass: 'Genesis pass (MasonryGenesisPass)',
  staking: 'Genesis staking (MasonryGenesisStaking)',
  settlement: 'Genesis settlement (MasonryGenesisSettlement)',
  lpBurnFee: 'Genesis LP fee, POL to Treasury (MasonryGenesisLPBurnFee)',
  levelHook: 'xTOMB/USDC hook (MasonryLevelHook)',
  levelOracle: 'xTOMB TWAP oracle (MasonryLevelOracle)',
  buybackGuard: 'Buyback guard (MasonryBuybackGuard)',
  levelVault: 'xTOMB/USDC LP vault (MasonryLevelUsdcVault)',
  squareHook: 'xSHARE/USDC hook (MasonrySquareHook)',
  squareVault: 'xSHARE/USDC LP vault (MasonrySquareUsdcVault)',
  criticalDefense: 'Critical Defense (MasonryCriticalDefense)',
  miniSwapRouter: 'Swap router (MiniSwapRouter)',
};

const DYNAMIC_FEE_FLAG = 0x800000;

function poolKey(key, path, { asset, usdc, hook }) {
  if (!object(key)) fail(`${path} must be a pool key`);
  for (const field of ['currency0', 'currency1', 'hooks']) {
    if (!isAddress(key[field])) fail(`${path}.${field} must be a nonzero address`);
  }
  if (BigInt(key.currency0) >= BigInt(key.currency1)) fail(`${path}: currency0 must sort below currency1`);
  const pair = [key.currency0.toLowerCase(), key.currency1.toLowerCase()];
  if (!pair.includes(asset.toLowerCase()) || !pair.includes(usdc.toLowerCase())) fail(`${path} must pair its asset with the official USDC`);
  if (key.hooks.toLowerCase() !== hook.toLowerCase()) fail(`${path}.hooks must be the bound hook`);
  if (!Number.isSafeInteger(key.fee) || key.fee < 0 || key.fee >= 1_000_000) fail(`${path}.fee must be a static fee in pips`);
  if (key.fee === DYNAMIC_FEE_FLAG) fail(`${path}: the official pools use a static LP fee`);
  if (!Number.isSafeInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) fail(`${path}.tickSpacing must be 1–32767`);
  return key;
}

/**
 * Validate one chain's Masonry deployment record.
 *   { chainId, deployBlock, contracts: { …masonryContractKeys }, pools: { level, square } }
 * `registry` is config/official-infrastructure.json: the chain must be listed and
 * its PoolManager and USDC must match the official addresses.
 */
export function parseMasonryDeployment(record, registry) {
  if (!object(record)) fail('expected an object');
  if (!Number.isSafeInteger(record.chainId) || record.chainId <= 0) fail('chainId must be a positive integer');
  if (typeof record.deployBlock !== 'string' || !/^(0|[1-9][0-9]*)$/.test(record.deployBlock)) fail('deployBlock must be a decimal string');
  const c = record.contracts;
  if (!object(c)) fail('contracts missing');
  for (const key of masonryContractKeys) {
    if (!isAddress(c[key])) fail(`contracts.${key} must be a nonzero address`);
  }
  const seen = new Map();
  for (const key of masonryContractKeys) {
    const a = c[key].toLowerCase();
    if (seen.has(a)) fail(`contracts.${key} repeats contracts.${seen.get(a)}`);
    seen.set(a, key);
  }
  if (registry) {
    const chain = officialChain(registry, record.chainId);
    if (!chain) fail(`chain ${record.chainId} has no Uniswap v4 PoolManager with native USDC in the registry`);
    if (c.poolManager.toLowerCase() !== chain.poolManager.toLowerCase()) fail('poolManager is not the official Uniswap v4 PoolManager for this chain');
    if (c.usdc.toLowerCase() !== chain.usdc.toLowerCase()) fail('usdc is not Circle-issued native USDC for this chain');
  }
  const p = record.pools;
  if (!object(p)) fail('pools missing');
  poolKey(p.level, 'pools.level', { asset: c.level, usdc: c.usdc, hook: c.levelHook });
  poolKey(p.square, 'pools.square', { asset: c.square, usdc: c.usdc, hook: c.squareHook });
  return record;
}

/** The registry entry for a chain, or undefined when xTOMB can't launch there. */
export function officialChain(registry, chainId) {
  if (!object(registry) || !Array.isArray(registry.chains)) fail('registry must list chains');
  return registry.chains.find((chain) => chain.id === chainId);
}
