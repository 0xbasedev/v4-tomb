export type Address = `0x${string}`;
export type MasonryContractKey =
  | 'level' | 'square' | 'usdc' | 'poolManager' | 'treasury'
  | 'schedule' | 'pass' | 'staking' | 'settlement' | 'lpBurnFee'
  | 'levelHook' | 'levelOracle' | 'buybackGuard' | 'levelVault'
  | 'squareHook' | 'squareVault' | 'criticalDefense' | 'miniSwapRouter';
export type MasonryVestingKey = 'team' | 'developer' | 'treasury' | 'arbitrage';
export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface MasonryDeployment {
  chainId: number;
  deployBlock: string;
  contracts: Record<MasonryContractKey, Address>;
  pools: { level: PoolKey; square: PoolKey };
  /** xSHARE vesting streams (MasonryLinearVesting); absent on records written before they existed. */
  vesting?: Record<MasonryVestingKey, Address>;
}
export interface OfficialChain { id: number; name: string; testnet: boolean; poolManager: Address; usdc: Address }
export interface OfficialRegistry { schemaVersion: 1; note: string; sources: Record<string, string>; chains: OfficialChain[] }
export const masonryContractKeys: MasonryContractKey[];
export const masonryVestingKeys: MasonryVestingKey[];
export const masonryContractLabels: Record<MasonryContractKey, string>;
export function parseMasonryDeployment(record: unknown, registry?: OfficialRegistry): MasonryDeployment;
export function officialChain(registry: OfficialRegistry, chainId: number): OfficialChain | undefined;
