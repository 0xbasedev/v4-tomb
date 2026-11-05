export type Hex = `0x${string}`;
export type AddressPatterns = Record<string, { prefix?: string; suffix?: string }>;
export interface AddressPlan {
  factory: Hex;
  deployer: Hex;
  releaseId: Hex;
  addressNonces?: Record<string, number>;
}
export interface ReleaseInput {
  releaseId: string;
  deployer: string;
  canonicalDomain?: number;
  canonicalTokenRole?: "estate" | "masonryShare";
  routeCaps?: Record<number, string>;
  bridgeOperators?: Record<number, { owner: string; ism: string }>;
  masonryInitCodeHashes?: Record<string, string>;
  addressPatterns?: AddressPatterns;
}
export interface MasonryPlan extends AddressPlan {
  chainId: number;
  addresses: Record<string, Hex>;
  initCodeHashes: Record<string, string>;
  hookNonces: Record<string, number>;
}
export interface BridgeNetwork {
  id: number;
  name: string;
  domain: number;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  mailbox: Hex;
  observedMailboxDefaultIsm: Hex;
  registryAvailability?: { status: string };
}
export interface BridgePlan {
  create3: AddressPlan;
  canonicalDomain: number;
  networks: Array<BridgeNetwork & {
    bridge: Hex;
    token: Hex;
    bridgeIsm: Hex;
    bridgeOwner: Hex;
    enabled: boolean;
    routes: Array<{ domain: number; peer: Hex; limit: string }>;
  }>;
}
export const factory: Hex;
export const factoryCodeHash: Hex;
export const masonryRoles: readonly string[];
export const bridgeRoles: readonly string[];
export function validateAddressPatterns(input?: AddressPatterns): Record<string, { prefix: string; suffix: string }>;
export function create3Planner(viem: Pick<typeof import('viem'),
  'concatHex' | 'encodeAbiParameters' | 'encodePacked' | 'getAddress' | 'keccak256' | 'sliceHex'>): {
  create3Address(plan: AddressPlan, role: string, nonce?: number): { address: Hex; salt: Hex; guarded: Hex; proxy: Hex };
  planCore(template: unknown, release: ReleaseInput, index: number): unknown;
  planMasonry(release: ReleaseInput, onSearch?: (role: string) => void): MasonryPlan;
  planBridge(template: unknown, release: ReleaseInput, onSearch?: (role: string) => void): BridgePlan;
};
