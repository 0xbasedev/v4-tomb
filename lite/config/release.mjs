const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ZERO = /^0x0{40}$/i;
const UINT = /^(0|[1-9][0-9]*)$/;
export const SHARE_CAP = 333333n;

function object(v, path) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${path}: expected object`);
  }
  return v;
}
function address(v, path, optional = false) {
  if (optional && v == null) return null;
  if (typeof v !== "string" || !ADDRESS.test(v) || ZERO.test(v)) {
    throw new Error(`${path}: expected nonzero EVM address`);
  }
  return v;
}
function uint(v, path, optional = false) {
  if (optional && v == null) return null;
  const s = typeof v === "string" ? v : (Number.isSafeInteger(v) ? String(v) : "");
  if (!UINT.test(s) || BigInt(s) > (2n ** 256n - 1n)) {
    throw new Error(`${path}: expected unsigned decimal integer`);
  }
  return BigInt(s);
}
function same(v, expected, path) {
  if (v !== expected) throw new Error(`${path}: must equal ${expected}`);
}
const allocationKeys = [
  "farmLevelLp", "farmShareLp", "saleEscrow", "deployer",
  "teamUpfront", "devUpfront", "treasuryUpfront", "arbitrageUpfront",
  "teamVested", "devVested", "treasuryVested", "arbitrageVested",
];

/** Validate all deployment parameters; incomplete templates MUST fail in strict mode.
 * Addresses are deliberately network-specific DATA, not contract source constants.
 */
export function validateLiteRelease(input, { strict = true, now = Math.floor(Date.now() / 1000) } = {}) {
  const plan = object(input, "plan");
  same(plan.schemaVersion, 2, "schemaVersion");
  same(plan.protocol, "xtomb-lite", "protocol");
  const network = object(plan.network, "network");
  const chainId = uint(network.chainId, "network.chainId");
  if (chainId === 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("network.chainId: out of range");
  if (typeof network.rpcUrl !== "string" ||
      !/^https?:\/\//.test(network.rpcUrl)) throw new Error("network.rpcUrl invalid");
  if (network.testnet !== true) throw new Error("release limited to audited testnet rehearsals");
  const infra = object(network.infrastructure, "network.infrastructure");
  const fields = ["v2Factory", "v2Router", "stableToken", "stableUsdFeed"];
  for (const field of fields) address(infra[field], `network.infrastructure.${field}`, !strict);
  address(infra.nativeUsdFeed, "network.infrastructure.nativeUsdFeed", true);
  if (strict && !infra.quoteTokenVerified) throw new Error("stable token must be independently verified");
  if (strict && !infra.oracleFeedVerified) throw new Error("stable USD feed must be independently verified");
  const configuration = object(plan.mechanics, "mechanics");
  for (const [key, value] of Object.entries({
    maxShareSupply: "333333",
    masonryLp: "xtomb/xshare",
    farmLpPairs: "xtomb/stable,xshare/stable",
    bondsEnabled: false,
    epochSeconds: 21600,
    maximumEpochExpansionBps: 200,
    mintRequiresStrictlyAboveUsdE18: "1010000000000000000",
    fireTaxHardCapBps: 1200,
    fireTaxRecoverySeconds: 25200,
    shareGenesisFloorBps: 600,
    farmRewardSeconds: 31536000,
    vestingSeconds: 15552000,
    exitNowTreasuryLpBps: 5000,
    advanceEpochFeeUsd: "25",
    allowCatchup: false,
    manualPriceSourceAllowed: false
  })) same(configuration[key], value, `mechanics.${key}`);

  const launch = object(plan.launch, "launch");
  const genesisStart = uint(launch.genesisStart, "launch.genesisStart", !strict);
  const farmStart = uint(launch.farmStart, "launch.farmStart", !strict);
  const supply = uint(launch.levelLaunchSupplyWei, "launch.levelLaunchSupplyWei", !strict);
  if (strict && (genesisStart <= BigInt(now + 7200) ||
      farmStart < genesisStart + 604800n ||
      supply <= 0n)) throw new Error("launch clock/supply not approved or not in future");
  if (strict && launch.levelSupplyApproved !== true) throw new Error("LEVEL launch supply not approved");
  if (strict && launch.distributionApproved !== true) throw new Error("xSHARE distribution not approved");
  for (const field of ["deployer", "treasury", "arbitrage", "team", "developer", "saleEscrow"]) {
    address(launch[field], `launch.${field}`, !strict);
  }
  const allocations = object(launch.shareAllocations, "launch.shareAllocations");
  let total = 0n;
  const amounts = {};
  for (const key of allocationKeys) {
    const value = uint(allocations[key], `launch.shareAllocations.${key}`, !strict);
    if (value !== null) { total += value; amounts[key] = value; }
  }
  if (strict && total !== SHARE_CAP) {
    throw new Error(`xSHARE distribution mismatch: ${total} allocated vs ${SHARE_CAP} hard cap`);
  }
  if (strict && (amounts.farmLevelLp === 0n || amounts.farmShareLp === 0n)) {
    throw new Error("both one-year farm budgets must be positive");
  }
  const guards = object(plan.guards, "guards");
  const pegReserve = uint(guards.minPegReserveWei, "guards.minPegReserveWei", !strict);
  const quoteReserve = uint(guards.minQuoteReserveUnits, "guards.minQuoteReserveUnits", !strict);
  const swapFeeBps = uint(guards.v2SwapFeeBps, "guards.v2SwapFeeBps", !strict);
  if (strict && (pegReserve <= 0n || quoteReserve <= 0n ||
      pegReserve > (2n ** 112n - 1n) || quoteReserve > (2n ** 112n - 1n) ||
      swapFeeBps > 1000n)) throw new Error("pool guard parameters invalid");
  if (strict && plan.testnetDeploymentApproved !== true) throw new Error("explicit testnet approval required");
  return { chainId: String(chainId), sharesAllocated: String(total), sharesCap: String(SHARE_CAP),
    allocationsApproved: launch.distributionApproved === true,
    productionReady: false };
}

export function exportPublicEnv(plan, opts) {
  validateLiteRelease(plan, opts);
  const { network: n, launch: l, guards: g } = plan;
  const a = l.shareAllocations;
  return {
    EXPECTED_CHAIN_ID: n.chainId,
    TESTNET_DEPLOYMENT_APPROVED: "1",
    ALLOCATION_PLAN_APPROVED: "1",
    LEVEL_LAUNCH_SUPPLY_APPROVED: "1",
    DEPLOYER_ADDRESS: l.deployer,
    TREASURY_ADDRESS: l.treasury,
    ARBITRAGE_ADDRESS: l.arbitrage,
    TEAM_ADDRESS: l.team,
    DEVELOPER_ADDRESS: l.developer,
    SALE_ESCROW_ADDRESS: l.saleEscrow,
    V2_FACTORY: n.infrastructure.v2Factory,
    V2_ROUTER: n.infrastructure.v2Router,
    USD_STABLE: n.infrastructure.stableToken,
    STABLE_USD_FEED: n.infrastructure.stableUsdFeed,
    NATIVE_USD_FEED: n.infrastructure.nativeUsdFeed || "0x0000000000000000000000000000000000000000",
    GENESIS_START: l.genesisStart,
    FARMS_START: l.farmStart,
    APPROVED_LEVEL_LAUNCH_WEI: l.levelLaunchSupplyWei,
    SHARE_FARM_LEVEL_LP: a.farmLevelLp,
    SHARE_FARM_SHARE_LP: a.farmShareLp,
    SHARE_SALE_ESCROW: a.saleEscrow,
    SHARE_DEPLOYER: a.deployer,
    SHARE_TEAM_UPFRONT: a.teamUpfront,
    SHARE_DEV_UPFRONT: a.devUpfront,
    SHARE_TREASURY_UPFRONT: a.treasuryUpfront,
    SHARE_ARBITRAGE_UPFRONT: a.arbitrageUpfront,
    SHARE_TEAM_VESTED: a.teamVested,
    SHARE_DEV_VESTED: a.devVested,
    SHARE_TREASURY_VESTED: a.treasuryVested,
    SHARE_ARBITRAGE_VESTED: a.arbitrageVested,
    MIN_PEG_RESERVE_WEI: g.minPegReserveWei,
    MIN_STABLE_RESERVE_UNITS: g.minQuoteReserveUnits,
    V2_SWAP_FEE_BPS: g.v2SwapFeeBps
  };
}
