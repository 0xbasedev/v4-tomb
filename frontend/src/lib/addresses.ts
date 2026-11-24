import type { Address } from "viem";
import { networks } from "./networks";

export interface PegTokenDeployment {
  /** $LEVEL token (peg target: 1 LEVEL = 1 WETH). */
  peg: Address;
  /** $SQUARE share token. */
  share: Address;
  /** $BOND bond token. */
  bond: Address;
  /** Treasury — seigniorage engine, bond office. */
  treasury: Address;
  /** Boardroom — SQUARE staking, LEVEL rewards. */
  boardroom: Address;
  /** TWAP oracle. */
  oracle: Address;
  /** PegDefenseHook — V4 hook with the TWAP-keyed sell tax. */
  hook: Address;
  /** ShareBuybackHook — taxes SQUARE sells in WETH, buys LEVEL with it and burns it. */
  shareBuybackHook: Address;
  /** V4PositionWrapper — wraps the LEVEL/WETH LP NFT into an ERC-20. */
  lpWrapper: Address;
  /** LpOnlyHook — makes the LEVEL/SQUARE pool untradeable (liquidity only). */
  pairLpHook: Address;
  /** V4PositionWrapper for the LEVEL/SQUARE LP NFT. */
  pairLpWrapper: Address;
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
  /** Permit2 configured for this deployment. */
  permit2: Address;
  /** UniversalRouter v2 (V4-capable variant) on this chain. */
  universalRouter: Address;
  /**
   * In-house V4 swap router. Bypasses UniversalRouter's calldata version drift
   * by exposing a single exact-input swap entry that wraps the V4 unlock+callback
   * pattern. See src/swap/MiniSwapRouter.sol for the design rationale.
   */
  miniSwapRouter: Address;
  /** First block of the deploy. Used to bound event-log scans. */
  deployBlock: bigint;
}

// Stable objects prevent polling effects from restarting on every render.
const deployments = new Map<number, PegTokenDeployment | null>(networks.map((network) => [
  network.id,
  network.deployment ? { ...network.deployment, deployBlock: BigInt(network.deployment.deployBlock) } : null,
]));

/** A missing deployment disables all protocol interactions. */
export function getDeployment(chainId: number): PegTokenDeployment | null {
  return deployments.get(chainId) ?? null;
}
