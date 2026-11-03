export type Address = `0x${string}`;
export type InfrastructureKey = 'weth' | 'poolManager' | 'positionManager' | 'permit2' | 'universalRouter' | 'create2Deployer';
export type DeploymentKey = Exclude<InfrastructureKey, 'create2Deployer'> | 'money' | 'estate' | 'trustNote' | 'treasury' | 'boardroom' | 'oracle' | 'hook' | 'lpWrapper' | 'genesisRewardPool' | 'mainRewardPool' | 'shareRewardPool' | 'timelock' | 'miniSwapRouter';
export type Deployment = Record<DeploymentKey, Address> & { deployBlock: string };
export interface Network {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
  rpcUrl: string;
  explorerUrl: string | null;
  testnet: boolean;
  infrastructure: Record<InfrastructureKey, Address | null>;
  deployment: Deployment | null;
}
export const infrastructureKeys: InfrastructureKey[];
export const deploymentKeys: DeploymentKey[];
export function parseNetworks(document: unknown): Network[];
export function transactionUrl(networks: Network[], chainId: number, hash?: string): string | undefined;
export function pegReserves(money: Address, weth: Address, amount0: bigint, amount1: bigint): { money: bigint; weth: bigint };
