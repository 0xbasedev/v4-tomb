import type { Address } from "viem";
import { networks } from "./networks";

export interface LegacyProtocolDeployment {
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
const deployments = new Map<number, LegacyProtocolDeployment | null>(networks.map((network) => [
  network.id,
  network.deployment ? { ...network.deployment, deployBlock: BigInt(network.deployment.deployBlock) } : null,
]));

/** A missing deployment disables all protocol interactions. */
export function getDeployment(chainId: number): LegacyProtocolDeployment | null {
  return deployments.get(chainId) ?? null;
}
