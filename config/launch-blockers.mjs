// Hard launch blockers. Any entry returned here must stop the Wizard export and the launch.
import { factory, masonryRoles } from './create3-plan.mjs';

const zero = /^0x0{40}$/i;
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !zero.test(v);
const hookRoles = ['masonryTaxHook', 'masonryShareTaxHook'];
export const rangeBindings = { masonryLevelRangeManager: 'masonryTaxHook', masonrySquareRangeManager: 'masonryShareTaxHook' };

/**
 * @param plan       Masonry CREATE3 plan (planMasonry output).
 * @param opts.expectedChainId chain the operator selected.
 * @param opts.create3Address  (plan, role, nonce) => { address }, used to re-derive every salt/address.
 * @param opts.infrastructure  { poolManager, positionManager, permit2, universalRouter, pegToken, weth? }
 * @param opts.pegToken        { decimals } from config; opts.registryPegDecimals from official registry.
 * @param opts.policy          launch policy (fees/caps).
 */
export function masonryPlanBlockers(plan, opts = {}) {
  const out = [];
  if (!plan || typeof plan !== 'object') return ['no Masonry plan'];
  if (opts.expectedChainId !== undefined && plan.chainId !== opts.expectedChainId) {
    out.push(`chainId mismatch: plan ${plan.chainId}, selected ${opts.expectedChainId}`);
  }
  if (String(plan.factory).toLowerCase() !== factory.toLowerCase()) out.push(`CREATE3 factory ${plan.factory} is not CreateX ${factory}`);
  if (!isAddr(plan.deployer)) out.push('deployer missing or zero');
  const seen = new Map();
  for (const role of masonryRoles) {
    const a = plan.addresses?.[role];
    if (!isAddr(a)) { out.push(`address export incomplete: ${role}`); continue; }
    const k = a.toLowerCase();
    if (seen.has(k)) out.push(`${role} repeats ${seen.get(k)}`);
    seen.set(k, role);
    if (!plan.initCodeHashes?.[role]) out.push(`initcode hash missing: ${role}`);
    if (opts.create3Address) {
      const nonce = hookRoles.includes(role) ? plan.hookNonces?.[role] : plan.addressNonces?.[role] ?? 0;
      const derived = opts.create3Address(plan, role, nonce).address;
      if (derived.toLowerCase() !== k) out.push(`salt/address mismatch for ${role}: plan ${a}, derived ${derived}`);
    }
  }
  for (const role of hookRoles) {
    const a = plan.addresses?.[role];
    if (isAddr(a) && (BigInt(a) & 0x3fffn) !== 0x35c8n) out.push(`${role} address lacks v4 permission bits 0x35c8`);
  }
  for (const [key, value] of Object.entries(opts.infrastructure ?? {})) {
    if (!isAddr(value)) out.push(`missing dependency: ${key}`);
  }
  if (opts.pegToken) {
    const d = opts.pegToken.decimals;
    if (!Number.isInteger(d)) out.push('peg token decimals missing');
    else if (opts.registryPegDecimals !== undefined && d !== opts.registryPegDecimals) {
      out.push(`wrong peg token decimals: config ${d}, registry ${opts.registryPegDecimals}`);
    }
  }
  const p = opts.policy;
  if (p) {
    if (!(p.fireTaxHardCapBps <= 1200)) out.push('fireTaxHardCapBps above 12% cap');
    if (p.fireTaxBaselineBps > p.fireTaxHardCapBps) out.push('fireTaxBaselineBps above hard cap');
    if (!(p.shareSellTaxBps >= 1 && p.shareSellTaxBps <= 1200)) out.push('shareSellTaxBps above 12% cap');
  }
  return out;
}

/** On-chain blockers from a live/fork read: every published address has code; every range manager is bound. */
export function onchainBlockers({ code, rangeManagerOf, plan, decimalsRead, decimalsExpected }) {
  const out = [];
  for (const [role, c] of Object.entries(code)) if (!c || c === '0x') out.push(`no code at ${role}`);
  for (const [rm, hook] of Object.entries(rangeBindings)) {
    const bound = rangeManagerOf?.[hook];
    if (!bound || bound.toLowerCase() !== plan.addresses[rm]?.toLowerCase()) out.push(`unbound: ${hook}.rangeManager != ${rm}`);
  }
  if (decimalsExpected !== undefined && decimalsRead !== decimalsExpected) {
    out.push(`wrong peg token decimals on-chain: ${decimalsRead}, expected ${decimalsExpected}`);
  }
  return out;
}

/**
 * Keeper, scripts (PROTOCOL_CONFIG → networks.json) and frontend (frontend-networks.json) must agree
 * with the official registry on every shared chain. Divergence is a hard blocker.
 */
export function manifestBlockers(protocol, frontend, registry) {
  const out = [];
  const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
  const fe = new Map((frontend?.networks ?? []).map((n) => [n.id, n]));
  const reg = new Map((registry?.chains ?? []).map((c) => [c.id, c]));
  if (frontend && !reg.has(frontend.primaryChainId)) out.push(`frontend primary chain ${frontend.primaryChainId} not in registry`);
  for (const n of protocol?.networks ?? []) {
    const f = fe.get(n.id); const r = reg.get(n.id);
    const pairs = [
      ['poolManager', n.infrastructure?.poolManager, f?.infrastructure?.poolManager, r?.poolManager],
      ['weth', n.infrastructure?.weth, f?.infrastructure?.weth, undefined],
      ['pegToken', n.pegToken?.address, f?.referenceToken?.address, r?.pegToken],
      ['pegTokenDecimals', n.pegToken?.decimals, f?.referenceToken?.decimals, r?.pegTokenDecimals],
      ['pegTokenSymbol', n.pegToken?.symbol, f?.referenceToken?.symbol, r?.pegTokenSymbol],
    ];
    for (const [key, a, b, c] of pairs) {
      const vals = [a, b, c].filter((v) => v !== undefined && v !== null).map(lc);
      if (new Set(vals).size > 1) out.push(`chain ${n.id} ${key} disagrees across manifests: ${vals.join(' / ')}`);
    }
  }
  return out;
}
