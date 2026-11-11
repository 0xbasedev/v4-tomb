import { getAddress, isAddress, zeroAddress } from "viem";
import type { BridgeNetwork, BridgePlan, MasonryPlan, ReleaseInput } from "../../../../config/create3-plan.mjs";
import { bridgeRoles, masonryRoles, validateAddressPatterns } from "../../../../config/create3-plan.mjs";
import { validateMasonryLaunch } from "../../../../config/masonry-launch.mjs";
import launchTemplate from "../../../../config/masonry-launch.template.json";
import bridgeTemplate from "../../../../config/xshare-bridge.json";

export const bridgeNetworks = bridgeTemplate.networks as BridgeNetwork[];
export const bridgeInput = bridgeTemplate;

export const supplyFields = [
  ["pegSupply", "xTOMB authorized launch supply"],
  ["pegTeam", "xTOMB owner, team and developer"],
  ["pegTreasury", "xTOMB Treasury"],
  ["pegArbitrage", "xTOMB arbitrage"],
  ["shareSupply", "xSHARE maximum supply"],
  ["shareFarm", "xSHARE farming"],
  ["shareSale", "xSHARE sale escrow"],
  ["shareDeployer", "xSHARE deployer"],
  ["shareTeam", "xSHARE owner, team and developer"],
  ["shareDeployerDao", "xSHARE deployer/DAO outright"],
  ["shareTreasury", "xSHARE Treasury"],
  ["shareArbitrage", "xSHARE arbitrage"],
  ["vestTeam", "xSHARE team vesting"],
  ["vestDeveloper", "xSHARE developer vesting"],
  ["vestTreasury", "xSHARE Treasury vesting"],
  ["vestArbitrage", "xSHARE arbitrage vesting"],
] as const;

const requiredInfrastructureFields = [
  ["usdc", "USDC"], ["poolManager", "Uniswap V4 PoolManager"],
  ["positionManager", "V4 PositionManager"], ["permit2", "Permit2"],
] as const;
const universalRouterField = ["universalRouter", "Uniswap V4 Universal Router"] as const;
export const infrastructureFields = [...requiredInfrastructureFields, universalRouterField] as const;

type InfrastructureField = typeof infrastructureFields[number][0];
const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
// https://developers.uniswap.org/docs/protocols/v4/deployments
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// Permit2 runtime and signing domains also checked on Sonic and PulseChain.
export const chainInfrastructure: Partial<Record<number, Partial<Record<InfrastructureField, string>>>> = {
  8453: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
    universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    permit2,
  },
  4663: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    permit2,
  },
  56: {
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
    universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
    permit2,
  },
  369: { permit2 },
  146: { usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", permit2 },
};

export const identityFields = [
  ["deployer", "Deployment signer"], ["governance", "Governance owner"], ["treasury", "Treasury recipient"],
] as const;

export const defaultFields = {
  network: "", chainId: "", chainName: "", rpcUrl: "", nativeSymbol: "",
  usdc: "", poolManager: "", positionManager: "", permit2: "", universalRouter: "",
  releaseId: "", deployer: "", governance: "", treasury: "", genesisStart: "",
  pegSupply: "", pegTeam: String(launchTemplate.level.initial.ownerTeamDeveloper),
  pegTreasury: String(launchTemplate.level.initial.treasury), pegArbitrage: String(launchTemplate.level.initial.arbitrage),
  shareSupply: String(launchTemplate.square.maxSupply), shareFarm: String(launchTemplate.square.farming),
  shareSale: String(launchTemplate.square.saleEscrow), shareDeployer: String(launchTemplate.square.deployer),
  shareTeam: String(launchTemplate.square.initial.ownerTeamDeveloper),
  shareDeployerDao: String(launchTemplate.square.initial.deployerDao),
  shareTreasury: String(launchTemplate.square.initial.treasury), shareArbitrage: String(launchTemplate.square.initial.arbitrage),
  vestTeam: String(launchTemplate.square.vesting.team), vestDeveloper: String(launchTemplate.square.vesting.developer),
  vestTreasury: String(launchTemplate.square.vesting.treasury), vestArbitrage: String(launchTemplate.square.vesting.arbitrage),
  bridge: "off",
  ...Object.fromEntries(bridgeNetworks.flatMap(({ id }) => [["owner" + id, ""], ["ism" + id, ""], ["cap" + id, ""]])),
  ...Object.fromEntries(masonryRoles.map((role) => ["hash-" + role, ""])),
  ...Object.fromEntries([...masonryRoles, ...bridgeRoles].flatMap((role) => [
    ["prefix-" + role, ""], ["suffix-" + role, ""],
  ])),
} satisfies Record<string, string>;

export type Fields = Record<string, string>;

export function addressPatternsFrom(fields: Fields, roles: readonly string[]) {
  return validateAddressPatterns(Object.fromEntries(roles.map((role) => [
    role, { prefix: fields["prefix-" + role], suffix: fields["suffix-" + role] },
  ])));
}
export type Draft = { schemaVersion: 1; type: "xtomb-release-draft"; fields: Fields };
const key = "xtomb:release-draft:v1";
export const makeDraft = (fields: Fields): Draft => ({ schemaVersion: 1, type: "xtomb-release-draft", fields });

export function importDraft(value: unknown): Fields {
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1
    || !("type" in value) || value.type !== "xtomb-release-draft"
    || !("fields" in value) || !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) {
    throw new Error("Choose an xTOMB release draft exported by this Wizard.");
  }
  const input = value.fields as Record<string, unknown>;
  const fields: Fields = { ...defaultFields };
  for (const field of Object.keys(defaultFields)) {
    if (typeof input[field] === "string" && input[field].length <= 1024) fields[field] = input[field];
  }
  return fields;
}

export function loadDraft(): Fields {
  try {
    const value = localStorage.getItem(key);
    if (value) return importDraft(JSON.parse(value));
  } catch { /* The browser can disable storage or hold an older draft. */ }
  return { ...defaultFields };
}

export function saveDraft(fields: Fields) {
  try { localStorage.setItem(key, JSON.stringify(makeDraft(fields))); }
  catch { /* Export remains available when local storage is disabled. */ }
}

export function download(name: string, data: unknown) {
  const blob = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = blob;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(blob), 1000);
}

function address(value: string, label: string) {
  if (!isAddress(value.trim(), { strict: false }) || value.trim().toLowerCase() === zeroAddress) {
    throw new Error(label + " needs a nonzero Ethereum address.");
  }
  return getAddress(value.trim().toLowerCase());
}

function whole(fields: Fields, field: string, label: string) {
  const value = fields[field].trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(label + " needs a whole, nonnegative amount.");
  }
  return Number(value);
}

export function networkFrom(fields: Fields) {
  if (fields.network !== "custom" && !bridgeNetworks.some(({ id }) => String(id) === fields.network)) {
    throw new Error("Select a home network.");
  }
  const id = whole(fields, "chainId", "Chain ID");
  const name = fields.chainName.trim();
  const nativeSymbol = fields.nativeSymbol.trim();
  if (!id || !name || name.length > 64 || !/^[a-z0-9]{1,12}$/i.test(nativeSymbol)) {
    throw new Error("Enter a positive chain ID, network name, and native currency symbol.");
  }
  if (fields.network !== "custom" && String(id) !== fields.network) throw new Error("Chain ID does not match the selected network.");
  let rpc: URL;
  try { rpc = new URL(fields.rpcUrl.trim()); }
  catch { throw new Error("Enter a public RPC URL."); }
  if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname))) {
    throw new Error("Use an HTTPS RPC URL or a local development RPC.");
  }
  if (rpc.username || rpc.password || rpc.search || rpc.hash) throw new Error("Use a public RPC URL without embedded credentials or query parameters.");
  const entries = fields.universalRouter.trim() ? infrastructureFields : requiredInfrastructureFields;
  return {
    id, name, nativeSymbol, rpcUrl: rpc.toString(),
    infrastructure: Object.fromEntries(entries.map(([field, label]) => [field, address(fields[field], label)])),
  };
}

export function launchFrom(fields: Fields, requireFuture = true) {
  const addresses = Object.fromEntries(identityFields.map(([field, label]) => [field, address(fields[field], label)]));
  const releaseId = fields.releaseId.trim();
  if (!/^0x[\da-f]{64}$/i.test(releaseId) || BigInt(releaseId) === 0n) throw new Error("Enter a 32-byte release ID or generate one.");
  const start = fields.genesisStart ? Math.floor(Date.parse(fields.genesisStart) / 1000) : 0;
  if (fields.genesisStart && (!Number.isSafeInteger(start) || start <= 0 || (requireFuture && start * 1000 <= Date.now()))) {
    throw new Error(requireFuture ? "Choose a future Genesis start time." : "Enter the configured Genesis start time.");
  }
  const amounts = Object.fromEntries(supplyFields.map(([field, label]) => [field, whole(fields, field, label)]));
  const launch = {
    ...launchTemplate,
    note: "Release configuration. Confirm deployment inputs and on-chain wiring before activating the app.",
    genesisStart: start,
    governance: addresses.governance,
    treasury: addresses.treasury,
    square: {
      maxSupply: amounts.shareSupply, farming: amounts.shareFarm, saleEscrow: amounts.shareSale, deployer: amounts.shareDeployer,
      initial: { ownerTeamDeveloper: amounts.shareTeam, deployerDao: amounts.shareDeployerDao, treasury: amounts.shareTreasury, arbitrage: amounts.shareArbitrage },
      vesting: { team: amounts.vestTeam, developer: amounts.vestDeveloper, treasury: amounts.vestTreasury, arbitrage: amounts.vestArbitrage },
    },
    level: {
      authorizedLaunchSupply: amounts.pegSupply,
      initial: { ownerTeamDeveloper: amounts.pegTeam, treasury: amounts.pegTreasury, arbitrage: amounts.pegArbitrage },
    },
  };
  try { validateMasonryLaunch(launch); }
  catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).replaceAll("SQUARE", "xSHARE").replaceAll("LEVEL", "xTOMB"));
  }
  return { launch, releaseId, deployer: addresses.deployer };
}

export function buildInputs(fields: Fields, requireFuture = true) {
  const network = networkFrom(fields);
  const { launch, releaseId, deployer } = launchFrom(fields, requireFuture);
  const withBridge = fields.bridge === "on";
  if (withBridge && !bridgeNetworks.some(({ id }) => id === network.id)) throw new Error("Bridge planning requires one of the five supported home networks.");
  const addressPatterns = addressPatternsFrom(fields, withBridge ? [...masonryRoles, ...bridgeRoles] : masonryRoles);
  const release: ReleaseInput = {
    releaseId, deployer, canonicalDomain: network.id, canonicalTokenRole: "masonryShare",
    ...(Object.keys(addressPatterns).length ? { addressPatterns } : {}),
    masonryInitCodeHashes: Object.fromEntries(masonryRoles.flatMap((role) => {
      const hash = fields["hash-" + role].trim();
      return hash ? [[role, hash]] : [];
    })),
    ...(withBridge ? {
      routeCaps: Object.fromEntries(bridgeNetworks.filter(({ id }) => id !== network.id).map(({ id }) => [id, fields["cap" + id].trim()])),
      bridgeOperators: Object.fromEntries(bridgeNetworks.map(({ id }) => [id, {
        owner: fields["owner" + id].trim(), ism: fields["ism" + id].trim(),
      }])),
    } : {}),
  };
  return { network, launch, release, withBridge };
}

export type LaunchPlan = ReturnType<typeof buildInputs> & { masonry: MasonryPlan; bridge: BridgePlan | null };
