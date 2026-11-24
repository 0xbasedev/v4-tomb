import type { Address } from "viem";
import { networks } from "./networks";

/** One network's deployment, exactly as published in config/networks.json. */
export interface ProtocolDeployment {
  /** Chain this deployment lives on. Every read and write is pinned to it. */
  chainId: number;
  /** PegToken — on screen "xTOMB". Targets 1 unit of the paired asset. */
  peg: Address;
  /** ShareToken — on screen "xSHARE". */
  share: Address;
  /** Treasury — emissions only: mints expansion to the Masonry above the 1.01 ceiling. */
  treasury: Address;
  /** Masonry — on screen "xROOM". Stake a token, earn the peg token each expansion. */
  masonry: Address;
  /** TWAP oracle read by the Treasury and the hooks. */
  oracle: Address;
  /** PegDefenseHook — the peg pool's hook, with the TWAP-keyed sell tax. */
  hook: Address;
  /** ShareBuybackHook — taxes share-token sells in the paired asset, buys the peg token and burns it. */
  shareBuybackHook: Address;
  /** V4PositionWrapper for the peg / paired-asset pool. */
  lpWrapper: Address;
  /** LpOnlyHook — makes the peg/share pool untradeable (liquidity only). */
  pairLpHook: Address;
  /** V4PositionWrapper for the peg/share pool. The Masonry's default stake token. */
  pairLpWrapper: Address;
  /** V4PositionWrapper for the share / paired-asset pool. */
  shareLpWrapper: Address;
  /** GenesisRewardPool — 24 hours, runs before epoch 0, pays the peg token. */
  genesisRewardPool: Address;
  /** PegFarm — pays the peg token to the peg LP wrapper. */
  pegFarm: Address;
  /** ShareFarm — pays the share token (pool 0 peg LP, pool 1 share LP). */
  shareFarm: Address;
  /** Timelock that governance roles rotate to. */
  timelock: Address;
  /** The paired asset (the manifest key is `weth`; it is whatever wrapped asset the chain uses). */
  weth: Address;
  poolManager: Address;
  positionManager: Address;
  permit2: Address;
  universalRouter: Address;
  /** MiniSwapRouter — single exact-input swap entry with a deadline. */
  miniSwapRouter: Address;
  /** First block of the deployment. */
  deployBlock: bigint;
}

// Stable objects prevent polling effects from restarting on every render.
const deployments = new Map<number, ProtocolDeployment | null>(
  networks.map((network) => [
    network.id,
    network.deployment ? { ...network.deployment, chainId: network.id, deployBlock: BigInt(network.deployment.deployBlock) } : null,
  ]),
);

/** A missing deployment disables every protocol read and write. */
export function getDeployment(chainId: number | undefined): ProtocolDeployment | null {
  return chainId === undefined ? null : (deployments.get(chainId) ?? null);
}
