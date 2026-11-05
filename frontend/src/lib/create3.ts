import { concatHex, encodeAbiParameters, encodePacked, getAddress, isAddress, keccak256, sliceHex, type Address, type Hex } from "viem";

import bridgeJson from "@config/xshare-bridge.json" with { type: "json" };

/**
 * CreateX CREATE3 address planning, in the browser.
 *
 * A line-for-line port of scripts/create3.mjs (merge @ 484c279): the same
 * release ID, deployment signer and role give the same address on every chain
 * where the canonical CreateX factory is deployed. Hook roles are mined for
 * the Uniswap v4 permission bits. Everything here is a prediction — nothing
 * is deployed or verified by computing it. test/model.spec.ts checks this
 * port against the repository script.
 */

export const CREATEX_FACTORY: Address = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
const PROXY_HASH: Hex = "0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f";

/** Masonry hooks: before/after initialize, after add/remove liquidity, before/after swap, before swap delta. */
export const MASONRY_HOOK_FLAGS = 0x35c8n;
export const HOOK_MASK = 0x3fffn;

export const MASONRY_ROLES = [
  "masonryPeg",
  "masonryShare",
  "masonryGenesisPass",
  "masonryGenesisSchedule",
  "masonryGenesisStaking",
  "masonryGenesisSettlement",
  "masonryGenesisLPBurnFee",
  "masonryLevelUsdcVault",
  "masonrySquareUsdcVault",
  "masonryBuybackGuard",
  "masonryCompoundGate",
  "masonryCriticalDefense",
  "masonryLevelOracle",
  "masonryTaxHook",
  "masonryShareTaxHook",
  "masonryShareOracle",
  "masonryVestingTeam",
  "masonryVestingDeveloper",
  "masonryVestingTreasury",
  "masonryVestingArbitrage",
] as const;
export type MasonryRole = (typeof MASONRY_ROLES)[number];
const HOOK_ROLES: MasonryRole[] = ["masonryTaxHook", "masonryShareTaxHook"];

export const ROLE_LABEL: Record<MasonryRole | "xshareBridge" | "bridgedShare", string> = {
  masonryPeg: "xTOMB token",
  masonryShare: "xSHARE token (bridge home asset)",
  masonryGenesisPass: "Genesis pass",
  masonryGenesisSchedule: "Genesis schedule",
  masonryGenesisStaking: "Genesis staking",
  masonryGenesisSettlement: "Genesis settlement",
  masonryGenesisLPBurnFee: "Genesis LP burn fee",
  masonryLevelUsdcVault: "xTOMB/USDC vault",
  masonrySquareUsdcVault: "xSHARE/USDC vault",
  masonryBuybackGuard: "Buyback guard",
  masonryCompoundGate: "Compound gate (3h)",
  masonryCriticalDefense: "Critical Defense",
  masonryLevelOracle: "xTOMB oracle",
  masonryTaxHook: "xTOMB/USDC hook",
  masonryShareTaxHook: "xSHARE/USDC hook",
  masonryShareOracle: "xSHARE oracle",
  masonryVestingTeam: "Vesting · team",
  masonryVestingDeveloper: "Vesting · developer",
  masonryVestingTreasury: "Vesting · treasury",
  masonryVestingArbitrage: "Vesting · arbitrage",
  xshareBridge: "xSHARE bridge (every network)",
  bridgedShare: "Bridged xSHARE (satellites)",
};

export interface ReleaseInput {
  releaseId: Hex;
  deployer: Address;
}

export function releaseProblems(r: { releaseId?: string; deployer?: string }): string[] {
  const out: string[] = [];
  if (!r.releaseId || !/^0x[\da-f]{64}$/i.test(r.releaseId) || BigInt(r.releaseId) === 0n) out.push("Release ID must be a nonzero 32-byte hex value.");
  if (!r.deployer || !isAddress(r.deployer, { strict: false }) || BigInt(r.deployer) === 0n) out.push("Deployment signer must be a nonzero address.");
  return out;
}

export function create3Address(plan: ReleaseInput, role: string, nonce = 0) {
  const deployer = getAddress(plan.deployer);
  const digest = keccak256(encodePacked(["bytes32", "string", "uint256"], [plan.releaseId, role, BigInt(nonce)]));
  const salt = concatHex([deployer, "0x00", sliceHex(digest, 0, 11)]);
  const guarded = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [deployer, salt]));
  const proxy = sliceHex(keccak256(concatHex(["0xff", CREATEX_FACTORY, guarded, PROXY_HASH])), 12);
  const address = getAddress(sliceHex(keccak256(concatHex(["0xd694", proxy, "0x01"])), 12));
  return { address, salt, guarded, proxy };
}

/** Same search as the script: the first nonce whose address carries the hook's permission bits. */
export async function mineHook(plan: ReleaseInput, role: string, flags: bigint, onProgress?: (tried: number) => void, signal?: AbortSignal) {
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const { address } = create3Address(plan, role, nonce);
    if ((BigInt(address) & HOOK_MASK) === flags) return { address, nonce };
    // Yield to the UI every few thousand tries so the page stays smooth.
    if (nonce % 2_000 === 1_999) {
      onProgress?.(nonce + 1);
      await new Promise((r) => setTimeout(r, 0));
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    }
  }
  throw new Error(`No hook salt found for ${role}`);
}

export interface MasonryPlan {
  deployer: Address;
  releaseId: Hex;
  factory: Address;
  chainId: number;
  addresses: Record<MasonryRole, Address>;
  hookNonces: Record<string, number>;
}

export async function planMasonry(release: ReleaseInput & { chainId: number }, onProgress?: (role: string, tried: number) => void, signal?: AbortSignal): Promise<MasonryPlan> {
  const hooks: Record<string, { address: Address; nonce: number }> = {};
  for (const role of HOOK_ROLES) hooks[role] = await mineHook(release, role, MASONRY_HOOK_FLAGS, (n) => onProgress?.(role, n), signal);
  const addresses = Object.fromEntries(MASONRY_ROLES.map((role) => [role, hooks[role]?.address ?? create3Address(release, role).address])) as Record<MasonryRole, Address>;
  return {
    deployer: getAddress(release.deployer),
    releaseId: release.releaseId,
    factory: CREATEX_FACTORY,
    chainId: release.chainId,
    addresses,
    hookNonces: Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.nonce])),
  };
}

// ---------------------------------------------------------------------------
// xSHARE bridge (Hyperlane) — config/xshare-bridge.json
// ---------------------------------------------------------------------------

export interface BridgeNetwork {
  id: number;
  domain: number;
  slug: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl: string | null;
  mailbox: Address;
  observedMailboxDefaultIsm: Address;
  registryAvailability?: { status: string; reasons: string[] };
  abacusWorksLastSupportedDate?: string;
  abacusWorksSupportSource?: string;
  bridge: Address | null;
  token: Address | null;
  bridgeIsm: Address | null;
  bridgeOwner: Address | null;
  enabled: boolean;
  registryUrl: string;
}

export const BRIDGE = bridgeJson as unknown as {
  schemaVersion: number;
  asset: "xSHARE";
  transport: "hyperlane";
  canonicalDomain: number | null;
  canonicalTokenRole: "estate" | "masonryShare" | null;
  create3: ReleaseInput | null;
  routeCaps: Record<string, string> | null;
  registryCommit: string;
  networks: BridgeNetwork[];
};
export const BRIDGE_DOMAINS = BRIDGE.networks.map((n) => n.id);
export const bridgeNetwork = (id: number | undefined) => BRIDGE.networks.find((n) => n.id === id) ?? null;

/** Why a network can't carry a live route yet, in one line (null once enabled). */
export function bridgeNetworkStatus(n: BridgeNetwork): string | null {
  if (n.enabled && n.bridge && n.token) return null;
  if (n.registryAvailability?.status === "disabled") return "Awaiting relayer and verifier setup";
  return "Bridge unavailable";
}

export interface BridgePlan {
  canonicalDomain: number;
  canonicalTokenRole: "estate" | "masonryShare";
  bridge: Address;
  bridgedShare: Address;
  canonicalToken: Address;
  /** Each network's token address: the canonical xSHARE at home, Bridged xSHARE elsewhere. */
  tokens: Record<number, Address>;
  satellites: number[];
}

export function planBridge(release: ReleaseInput, canonicalDomain: number, canonicalTokenRole: "estate" | "masonryShare" = "masonryShare"): BridgePlan | null {
  if (!BRIDGE_DOMAINS.includes(canonicalDomain)) return null;
  const bridge = create3Address(release, "xshareBridge").address;
  const bridgedShare = create3Address(release, "bridgedShare").address;
  const canonicalToken = create3Address(release, canonicalTokenRole).address;
  const satellites = BRIDGE_DOMAINS.filter((id) => id !== canonicalDomain);
  return {
    canonicalDomain,
    canonicalTokenRole,
    bridge,
    bridgedShare,
    canonicalToken,
    tokens: Object.fromEntries(BRIDGE_DOMAINS.map((id) => [id, id === canonicalDomain ? canonicalToken : bridgedShare])),
    satellites,
  };
}

/** A random nonzero release ID. */
export function randomReleaseId(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  if (b.every((x) => x === 0)) b[31] = 1;
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}

// ---------------------------------------------------------------------------
// The Wizard's working release plan, kept per browser so the Bridge page can
// show the same predictions. It is a convenience copy — the reviewed release
// JSON in the repository is the source of truth.
// ---------------------------------------------------------------------------

const KEY = "xtomb.release-plan.v1";
export interface StoredRelease {
  releaseId: Hex;
  deployer: Address;
  canonicalDomain: number;
  canonicalTokenRole: "estate" | "masonryShare";
  savedAt: number;
}
export function loadRelease(): StoredRelease | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as StoredRelease;
    return releaseProblems(r).length === 0 && Number.isSafeInteger(r.canonicalDomain) ? r : null;
  } catch {
    return null;
  }
}
export function saveRelease(r: StoredRelease | null) {
  try {
    if (r) localStorage.setItem(KEY, JSON.stringify(r));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage can be unavailable (private mode); the plan still works in memory */
  }
}
