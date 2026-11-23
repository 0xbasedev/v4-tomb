import source from "../../../lite/config/deployment.json" with { type: "json" };
import { parseAbi, type Address, type Chain } from "viem";

export type LiteContractKey =
  | "peg" | "share" | "stable" | "masonryLp" | "pegFarmLp" | "shareFarmLp"
  | "masonry" | "pegFarm" | "shareFarm" | "twap" | "stableUsd" | "pegTax" | "shareTax";

export interface LiteDeployment {
  schemaVersion: 1;
  status: "verified";
  network: {
    chainId: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
  };
  verification: {
    receiptsReviewed: true;
    bytecodeVerified: true;
    sourceVerified: true;
  };
  addresses: Record<LiteContractKey, Address>;
}

const ADDRESS = /^0x[a-f0-9]{40}$/i;
const keys: LiteContractKey[] = [
  "peg", "share", "stable", "masonryLp", "pegFarmLp", "shareFarmLp",
  "masonry", "pegFarm", "shareFarm", "twap", "stableUsd", "pegTax", "shareTax",
];

/** Fail closed: no contract wallet actions until a reviewed deployment has been published. */
export function validateLiteDeployment(raw: unknown): LiteDeployment | null {
  if (raw == null || typeof raw !== "object") return null;
  const d = raw as Partial<LiteDeployment>;
  const n = d.network;
  if (d.schemaVersion !== 1 || d.status !== "verified" ||
      d.verification?.receiptsReviewed !== true ||
      d.verification?.bytecodeVerified !== true ||
      d.verification?.sourceVerified !== true ||
      !n || !Number.isSafeInteger(n.chainId) || n.chainId <= 0 ||
      !n.name || !/^https?:\/\//.test(n.rpcUrl || "") ||
      !/^https?:\/\//.test(n.explorerUrl || "") ||
      !n.nativeCurrency || n.nativeCurrency.decimals !== 18) return null;

  const a = d.addresses;
  if (!a || keys.some((key) => !ADDRESS.test(a[key] || "") ||
      /^0x0{40}$/i.test(a[key] || ""))) return null;
  return d as LiteDeployment;
}

export const liteDeployment = validateLiteDeployment(source);

export function liteChain(d: LiteDeployment): Chain {
  return {
    id: d.network.chainId,
    name: d.network.name,
    nativeCurrency: d.network.nativeCurrency,
    rpcUrls: { default: { http: [d.network.rpcUrl] } },
    blockExplorers: {
      default: { name: `${d.network.name} Explorer`, url: d.network.explorerUrl }
    },
    testnet: true
  };
}

export const liteTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)"
]);

export const liteMasonryAbi = parseAbi([
  "function deposit(uint128 amount)",
  "function withdraw(uint256 index, uint128 amount)",
  "function exitNow(uint256 index, uint128 amount)",
  "function claim()",
  "function advanceEpochStable()",
  "function advanceEpochNative() payable",
  "function earned(address account) view returns (uint256)",
  "function stakedBalance(address account) view returns (uint256)",
  "function trancheCount(address account) view returns (uint256)",
  "function tranche(address account,uint256 index) view returns ((uint128 amount,uint64 unlockAt))",
  "function nextEpochAt() view returns (uint256)",
  "function totalStaked() view returns (uint256)"
]);

export const liteFarmAbi = parseAbi([
  "function stake(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function claim()",
  "function emergencyWithdraw()",
  "function pending(address account) view returns (uint256)",
  "function staked(address account) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function endAt() view returns (uint256)",
  "function withdrawalFeeBps() view returns (uint256)"
]);

export const litePriceAbi = parseAbi([
  "function latestPrice() view returns (uint256 priceE18,uint256 observedAt)"
]);
