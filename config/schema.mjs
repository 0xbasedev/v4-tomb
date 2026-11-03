export const infrastructureKeys = [
  'weth', 'poolManager', 'positionManager', 'permit2', 'universalRouter', 'create2Deployer',
];
export const deploymentKeys = [
  'money', 'estate', 'trustNote', 'treasury', 'boardroom', 'oracle', 'hook', 'lpWrapper',
  'genesisRewardPool', 'mainRewardPool', 'shareRewardPool', 'timelock', 'miniSwapRouter',
  ...infrastructureKeys.filter((key) => key !== 'create2Deployer'),
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const address = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
  && !/^0x0{40}$/i.test(value);
const fail = (message) => { throw new Error(`Network configuration: ${message}`); };
const string = (value) => typeof value === 'string' && value.trim().length > 0;
function url(value, label) {
  if (!string(value)) fail(`${label} must be an HTTP(S) URL`);
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${label} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(`${label} must be an HTTP(S) URL without embedded credentials`);
  }
}

/** Validate the same public manifest used by the UI, deployment, and keeper. */
export function parseNetworks(document) {
  if (!object(document) || document.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (!Array.isArray(document.networks) || document.networks.length === 0) fail('networks must not be empty');
  const ids = new Set();
  for (const network of document.networks) {
    if (!object(network)) fail('invalid network');
    const { id, nativeCurrency, infrastructure, deployment } = network;
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) fail('chain IDs must be unique positive safe integers');
    ids.add(id);
    if (!string(network.name) || typeof network.testnet !== 'boolean') fail(`invalid metadata for chain ${id}`);
    if (!object(nativeCurrency) || !string(nativeCurrency.name) || !string(nativeCurrency.symbol)
      || nativeCurrency.decimals !== 18) fail('native currency must have name, symbol and 18 decimals');
    url(network.rpcUrl, 'rpcUrl');
    if (network.explorerUrl !== null) url(network.explorerUrl, 'explorerUrl');
    if (!object(infrastructure)) fail('missing infrastructure');
    for (const key of infrastructureKeys) {
      if (infrastructure[key] !== null && !address(infrastructure[key])) fail(`invalid infrastructure.${key}`);
    }
    if (deployment === null) continue;
    if (!object(deployment)) fail('deployment must be complete or null');
    if (!address(infrastructure.create2Deployer)) fail('a deployed network requires create2Deployer');
    for (const key of deploymentKeys) {
      if (!address(deployment[key])) fail(`invalid deployment.${key}`);
    }
    if (typeof deployment.deployBlock !== 'string' || !/^(0|[1-9][0-9]*)$/.test(deployment.deployBlock)) {
      fail('deployBlock must be a nonnegative decimal string');
    }
    for (const key of infrastructureKeys.filter((key) => key !== 'create2Deployer')) {
      if (deployment[key].toLowerCase() !== infrastructure[key]?.toLowerCase()) fail(`deployment.${key} disagrees with infrastructure`);
    }
    // A swapped hook permission bit yields a different address and an unusable pool.
    if ((BigInt(deployment.hook) & 0x3fffn) !== 0x1088n) fail('hook permission bits must be 0x1088');
    if (deployment.money.toLowerCase() === deployment.weth.toLowerCase()) fail('MONEY and WETH must differ');
  }
  return document.networks;
}

export function transactionUrl(networks, chainId, hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) return undefined;
  const explorer = networks.find((network) => network.id === chainId)?.explorerUrl;
  return explorer ? `${explorer.replace(/\/$/, '')}/tx/${hash}` : undefined;
}

/** PoolManager orders currencies by address, independently of symbol or chain. */
export function pegReserves(money, weth, amount0, amount1) {
  return BigInt(weth) < BigInt(money)
    ? { money: amount1, weth: amount0 }
    : { money: amount0, weth: amount1 };
}
