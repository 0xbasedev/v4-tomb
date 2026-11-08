export type Address = `0x${string}`;
export type MasonryContractKey =
  | 'level' | 'square' | 'usdc' | 'poolManager' | 'treasury'
  | 'chamber' | 'farm' | 'xBond'
  | 'schedule' | 'pass' | 'staking' | 'settlement' | 'lpBurnFee'
  | 'levelHook' | 'levelOracle' | 'buybackGuard' | 'levelVault'
  | 'squareHook' | 'squareVault' | 'levelRangeManager' | 'squareRangeManager' | 'criticalDefense' | 'miniSwapRouter';
export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface MasonryDeployment {
  chainId: number;
  deployBlock: string;
  contracts: Record<MasonryContractKey, Address>;
  pools: { level: PoolKey; square: PoolKey };
}
export interface OfficialChain { id: number; name: string; testnet: boolean; poolManager: Address; usdc: Address }
export interface OfficialRegistry { schemaVersion: 1; note: string; sources: Record<string, string>; chains: OfficialChain[] }
export const masonryContractKeys: MasonryContractKey[];
export const masonryContractLabels: Record<MasonryContractKey, string>;
export function parseMasonryDeployment(record: unknown, registry?: OfficialRegistry): MasonryDeployment;
export function officialChain(registry: OfficialRegistry, chainId: number): OfficialChain | undefined;
