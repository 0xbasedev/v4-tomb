// Robinhood launch-readiness checks. Amounts in the wizard are WHOLE tokens.
import { parseMasonryDeployment } from './masonry-deployment.mjs';
import { validateMasonryLaunch } from './masonry-launch.mjs';

const WEI_LOOKING = 10n ** 12n;

const fail = (message) => {
  throw new Error(`Robinhood launch: ${message}`);
};

const isAddress = (value) =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);

export function looksLikeWei(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= Number(WEI_LOOKING);
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    return BigInt(value) >= WEI_LOOKING && !value.endsWith('000000'); // allow explicit 6-decimal base units in known cap fields
  }
  return false;
}

function walkForWei(node, path, allowBaseUnitPaths) {
  if (node === null || node === undefined) return;
  if (typeof node === 'number' || typeof node === 'string') {
    if (allowBaseUnitPaths.has(path)) return;
    if (looksLikeWei(node)) fail(`${path} looks like a wei/base-unit amount (${node}); use whole tokens`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkForWei(v, `${path}[${i}]`, allowBaseUnitPaths));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkForWei(v, path ? `${path}.${k}` : k, allowBaseUnitPaths);
  }
}

export function validateRobinhoodInfrastructure(networks, official) {
  const rh = (networks?.networks ?? []).find((n) => n.id === 4663);
  if (!rh) fail('chain 4663 missing from frontend-networks.json');
  if (!rh.enabled) fail('Robinhood Chain must be enabled');
  const ref = rh.referenceToken;
  if (!ref) fail('missing referenceToken');
  if (ref.symbol !== 'USDG') fail(`peg symbol must be USDG, got ${ref.symbol}`);
  if (ref.decimals !== 6) fail(`peg-decimals mismatch: expected 6, got ${ref.decimals}`);
  if (!isAddress(ref.address)) fail('missing referenceToken.address');
  const infra = rh.infrastructure ?? {};
  for (const key of ['poolManager', 'weth', 'usdg']) {
    if (!isAddress(infra[key])) fail(`missing infrastructure address: ${key}`);
  }
  if (infra.usdc != null) fail('do not set infrastructure.usdc on Robinhood; USDG lives in infrastructure.usdg');
  const chain = (official?.chains ?? []).find((c) => c.id === 4663);
  if (!chain) fail('chain 4663 missing from official-infrastructure.json');
  if (chain.referenceTokenDecimals !== 6) fail('official-infrastructure peg-decimals mismatch: expected 6');
  if (!isAddress(chain.poolManager) || !isAddress(chain.usdc)) fail('missing official PoolManager or reference token address');
  if (chain.poolManager.toLowerCase() !== infra.poolManager.toLowerCase()) fail('PoolManager address mismatch');
  if (chain.usdc.toLowerCase() !== infra.usdg.toLowerCase()) fail('USDG address mismatch between configs');
  if (chain.usdc.toLowerCase() !== ref.address.toLowerCase()) fail('referenceToken.address does not match USDG');
  return { rh, chain };
}

export function validateRobinhoodLaunchReadiness({ launch, deployment, networks, official }) {
  const { rh, chain } = validateRobinhoodInfrastructure(networks, official);
  const allow = new Set([
    'genesisBurnExecution.maxFeeSharesPerCallBaseUnits',
    'genesisBurnExecution.maxUsdcPerCallBaseUnits',
  ]);
  if (launch) {
    walkForWei(launch.square, 'square', allow);
    walkForWei(launch.level, 'level', allow);
    walkForWei(launch.policy, 'policy', allow);
  }
  if (!deployment) fail('missing addresses: no Masonry deployment record for chain 4663');
  if (deployment.chainId !== 4663) fail(`deployment chainId must be 4663, got ${deployment.chainId}`);
  const parsed = parseMasonryDeployment(deployment, official);
  if (parsed.contracts.usdc.toLowerCase() !== chain.usdc.toLowerCase()) {
    fail('deployment.usdc must be Robinhood USDG');
  }
  if (parsed.contracts.poolManager.toLowerCase() !== rh.infrastructure.poolManager.toLowerCase()) {
    fail('deployment.poolManager must be the official Robinhood PoolManager');
  }
  // Legacy WETH Treasury/Boardroom/TrustNote must not appear as Masonry launch destinations.
  const banned = ['boardroom', 'trustNote', 'trustnote', 'pegDefenseHook', 'money', 'estate'];
  for (const key of banned) {
    if (parsed.contracts[key]) fail(`legacy bond-era key ${key} must not be wired in the Masonry launch`);
  }
  return { ...validateMasonryLaunch(launch), chainId: 4663 };
}
