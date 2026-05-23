/**
 * Deployed contract addresses, per chain.
 *
 * Base Sepolia deployment of 2026-05-22 — clean redeploy after the Tomb-faithfulness
 * fixes (bootstrapEpochs=28, maxDebtRatioPercent=3500, WETH peg migration, 14-tier
 * tax surface, LP wrapper, Timelock, seed liquidity).
 *
 * Frontend imports this map to look up the right contracts for the active chain.
 * Sprint B wires wagmi reads/writes against these.
 *
 * Pool initialized at tick 0 (1:1 MONEY/WETH price). Seed liquidity: 0.1 MONEY +
 * 0.1 WETH at full range (tick -887220 to 887220).
 */

import type { Address } from "viem";

export const CHAIN_IDS = {
  baseSepolia: 84532,
  base: 8453,
} as const;

export type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export interface OldMoneyDeployment {
  /** $MONEY token (peg target: 1 MONEY = 1 WETH). */
  money: Address;
  /** $ESTATE share token. */
  estate: Address;
  /** $TRUSTNOTE bond token. */
  trustNote: Address;
  /** Treasury — seigniorage engine, bond office. */
  treasury: Address;
  /** Boardroom — ESTATE staking, MONEY rewards. */
  boardroom: Address;
  /** TWAP oracle. */
  oracle: Address;
  /** PegDefenseHook — V4 hook with 14-tier tax surface. */
  hook: Address;
  /** V4PositionWrapper — wraps the MONEY/WETH LP NFT into an ERC-20. */
  lpWrapper: Address;
  /** Genesis reward pool (24h window, accepts outside ERC-20s). */
  genesisRewardPool: Address;
  /** Main reward pool (9d, accepts lpWrapper). */
  mainRewardPool: Address;
  /** Share reward pool (370d, accepts lpWrapper). */
  shareRewardPool: Address;
  /** Compound-style Timelock for governance rotations. */
  timelock: Address;
  /** Canonical WETH on this chain. */
  weth: Address;
  /** V4 PoolManager on this chain. */
  poolManager: Address;
  /** V4 PositionManager on this chain. */
  positionManager: Address;
  /** Canonical Permit2 (same address every chain). */
  permit2: Address;
  /** UniversalRouter v2 (V4-capable variant) on this chain. */
  universalRouter: Address;
  /** First block of the deploy. Used to bound event-log scans. */
  deployBlock: bigint;
}

export const DEPLOYMENTS: Record<ChainId, OldMoneyDeployment | null> = {
  [CHAIN_IDS.baseSepolia]: {
    money: "0xb650e095c528fAc0f7DBC57121c60176323d8177",
    estate: "0xaA5f51352c6D6fD4367dc00C0DA86f54E4f824BD",
    trustNote: "0x4B5DD3A4b6Ba475eecC8307bb9d2932c71D14588",
    treasury: "0x928B72a3E734d6D07606d9655c55289D3a224c20",
    boardroom: "0x4ef5Af1bAB5Ed063b08fB951da9218ed82B3EaF4",
    oracle: "0x943FDa4b6e8eC63a944873FfE6e352c0F0e20ca6",
    hook: "0x8FF87C2B51eE70cA39B3ECD72B60db13ad86D088",
    lpWrapper: "0x4B81e81B8aC495D399f636c013F5cfa414d6e10c",
    genesisRewardPool: "0xBf511845D6252E622734681f2713131EF39a6487",
    mainRewardPool: "0x3190962F3f0F50f3D486B3fa81D61088a06FAb2D",
    shareRewardPool: "0x5193Ce115BA7df3d25c7f5dA4c29DA2CD7c890bC",
    timelock: "0x216452DeD9bB3eDc618A40E6BCf84c33167F03d1",
    weth: "0x4200000000000000000000000000000000000006",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    positionManager: "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    // UniversalRouter v2 (V4-capable). Source: developers.uniswap.org/contracts/v4/deployments.
    // VERIFY before any mainnet wiring — Uniswap may rotate addresses between versions.
    universalRouter: "0x492E6456D9528771018DeB9E87ef7750EF184104",
    deployBlock: 41_868_762n,
  },
  [CHAIN_IDS.base]: null, // Mainnet deploy pending the testnet shakedown.
};

/** Convenience lookup. Returns null if the chain has no deployment yet. */
export function getDeployment(chainId: number): OldMoneyDeployment | null {
  return DEPLOYMENTS[chainId as ChainId] ?? null;
}
