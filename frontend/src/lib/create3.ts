import type { Address, Hex } from "viem";

import bridgeJson from "@config/xshare-bridge.json" with { type: "json" };

/**
 * CreateX CREATE3 address planning, in the browser.
 *
 * Every address comes from config/create3-plan.mjs — the same planner the
 * deploy scripts and CLI use (merge @ 02858c6) — so the Wizard can't drift
 * from the scripts. Searches for hook permission bits and per-role prefix /
 * suffix patterns run in a Web Worker (create3.worker.ts) so the page stays
 * smooth. Everything here is a prediction: nothing is deployed or verified
 * by computing it.
 */
import * as viem from "viem";
import { create3Planner, masonryRoles, validateAddressPatterns, type AddressPatterns, type MasonryPlan as SharedMasonryPlan } from "@config/create3-plan.mjs";

export const CREATEX_FACTORY: Address = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
export const HOOK_MASK = 0x3fffn;
/** Required v4 permission bits per hook role (fixed by the contracts). */
export const HOOK_FLAGS: Record<string, bigint> = { masonryTaxHook: 0x35c8n, masonryShareTaxHook: 0x35c8n };
export const MASONRY_HOOK_FLAGS = 0x35c8n;

export const MASONRY_ROLES = masonryRoles as readonly MasonryRole[];
export type MasonryRole =
  | "masonryPeg" | "masonryShare" | "masonrySwapRouter" | "masonryGenesisPass" | "masonryGenesisSchedule" | "masonryGenesisStaking"
  | "masonryGenesisSettlement" | "masonryGenesisLPBurnFee" | "masonryLevelUsdcVault" | "masonrySquareUsdcVault"
  | "masonryBuybackGuard" | "masonryCompoundGate" | "masonryCriticalDefense" | "masonryLevelOracle"
  | "masonryTaxHook" | "masonryShareTaxHook" | "masonryShareOracle"
  | "masonryVestingTeam" | "masonryVestingDeveloper" | "masonryVestingTreasury" | "masonryVestingArbitrage";
export type PlannedRole = MasonryRole | "xshareBridge" | "bridgedShare";
export const PATTERN_ROLES: PlannedRole[] = [...MASONRY_ROLES, "xshareBridge", "bridgedShare"];

export const ROLE_LABEL: Record<PlannedRole, string> = {
  masonryPeg: "xTOMB token",
  masonryShare: "xSHARE token (bridge home asset)",
  masonrySwapRouter: "Swap router (exact-input v4)",
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

export type { AddressPatterns };
export interface ReleaseInput {
  releaseId: Hex;
  deployer: Address;
  addressPatterns?: AddressPatterns;
}

const planner = create3Planner(viem);

export function releaseProblems(r: { releaseId?: string; deployer?: string }): string[] {
  const out: string[] = [];
  if (!r.releaseId || !/^0x[\da-f]{64}$/i.test(r.releaseId) || BigInt(r.releaseId) === 0n) out.push("Release ID must be a nonzero 32-byte hex value.");
  if (!r.deployer || !viem.isAddress(r.deployer, { strict: false }) || BigInt(r.deployer) === 0n) out.push("Deployment signer must be a nonzero address.");
  return out;
}

/** The shared validator's message for a bad pattern set (hex only, length limits, hook-bit conflicts), or null. */
export function patternProblem(patterns: AddressPatterns): string | null {
  try {
    validateAddressPatterns(patterns);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** One role's address at a given nonce (no search). */
export function create3Address(plan: ReleaseInput & { addressNonces?: Record<string, number> }, role: string, nonce?: number) {
  return planner.create3Address({ factory: CREATEX_FACTORY, deployer: viem.getAddress(plan.deployer), releaseId: plan.releaseId, addressNonces: plan.addressNonces }, role, nonce);
}

export interface MasonryPlan extends SharedMasonryPlan {
  addresses: Record<MasonryRole, Address>;
  addressNonces?: Record<string, number>;
  patterns: AddressPatterns;
}

/** Synchronous plan (tests, CLI parity). The UI uses planInWorker. */
export function planMasonrySync(release: ReleaseInput & { chainId: number }, onSearch?: (role: string) => void): MasonryPlan {
  const p = planner.planMasonry({ releaseId: release.releaseId, deployer: release.deployer, canonicalDomain: release.chainId, addressPatterns: release.addressPatterns }, onSearch);
  return { ...p, patterns: release.addressPatterns ?? {} } as MasonryPlan;
}

export interface FullPlan {
  masonry: MasonryPlan;
  bridge: BridgePlan | null;
}

/**
 * Plan in a Web Worker. Resolves with both plans, or rejects with the
 * planner's own error message. `onSearch` reports which role is being mined.
 */
export function planInWorker(release: ReleaseInput & { chainId: number }, onSearch?: (role: string) => void, signal?: AbortSignal): Promise<FullPlan> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./create3.worker.ts", import.meta.url), { type: "module" });
    const stop = () => worker.terminate();
    signal?.addEventListener("abort", () => (stop(), reject(new DOMException("aborted", "AbortError"))), { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ searching?: string; plan?: FullPlan; error?: string }>) => {
      if (data.searching) return onSearch?.(data.searching);
      stop();
      if (data.error) reject(new Error(data.error));
      else resolve(data.plan!);
    };
    worker.onerror = (e) => (stop(), reject(new Error(e.message || "The address planner stopped unexpectedly.")));
    worker.postMessage(release);
  });
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

// The shared planBridge also validates operators and caps for the deploy
// script. For address prediction only, those are filled with inert
// placeholders here and then discarded; the exported release keeps the real
// inputs and the repository planner checks them.
const PLACEHOLDER = "0x0000000000000000000000000000000000000001";

export function planBridge(release: ReleaseInput, canonicalDomain: number, canonicalTokenRole: "estate" | "masonryShare" = "masonryShare", onSearch?: (role: string) => void): BridgePlan | null {
  if (!BRIDGE_DOMAINS.includes(canonicalDomain)) return null;
  const satellites = BRIDGE_DOMAINS.filter((id) => id !== canonicalDomain);
  const doc = planner.planBridge(
    BRIDGE,
    {
      releaseId: release.releaseId,
      deployer: release.deployer,
      canonicalDomain,
      canonicalTokenRole,
      addressPatterns: release.addressPatterns,
      routeCaps: Object.fromEntries(satellites.map((id) => [id, "1"])),
      bridgeOperators: Object.fromEntries(BRIDGE_DOMAINS.map((id) => [id, { owner: PLACEHOLDER, ism: PLACEHOLDER }])),
    },
    onSearch,
  );
  const home = doc.networks.find((n) => n.id === canonicalDomain)!;
  const sat = doc.networks.find((n) => n.id !== canonicalDomain)!;
  return {
    canonicalDomain,
    canonicalTokenRole,
    bridge: home.bridge as Address,
    bridgedShare: sat.token as Address,
    canonicalToken: home.token as Address,
    tokens: Object.fromEntries(doc.networks.map((n) => [n.id, n.token as Address])),
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

const KEY = "xtomb.release-plan.v2";
export interface StoredRelease {
  releaseId: Hex;
  deployer: Address;
  canonicalDomain: number;
  canonicalTokenRole: "estate" | "masonryShare";
  addressPatterns?: AddressPatterns;
  /** Predicted bridge addresses at save time (null when home isn't a bridge network). */
  bridge?: BridgePlan | null;
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
