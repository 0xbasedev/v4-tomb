import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from "viem";

import type { ProtocolDeployment } from "@/lib/addresses";

/** A Uniswap V4 pool key. currency0 < currency1 by address, on every chain. */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** LPFeeLibrary.DYNAMIC_FEE_FLAG — the peg pool's fee is set by its hook per swap. */
export const DYNAMIC_FEE_FLAG = 0x800000;
/** Every protocol pool uses tick spacing 60; wrappers accept only the full range at that spacing. */
export const TICK_SPACING = 60;
/** The share pool's static LP fee (contracts/script/Deploy.s.sol: SHARE_POOL_FEE). */
export const SHARE_POOL_FEE = 3000;

export type PoolId = "peg" | "share" | "pair";

const sorted = (a: Address, b: Address): [Address, Address] => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);

/**
 * The three pools the deploy script initialises, rebuilt from the manifest
 * (contracts/script/Deploy.s.sol):
 *   peg    peg token / paired asset   dynamic fee   PegDefenseHook
 *   share  share token / paired asset 0.30%         ShareBuybackHook
 *   pair   peg token / share token    0 fee         LpOnlyHook (every swap reverts)
 */
export function poolKeys(d: ProtocolDeployment): Record<PoolId, PoolKey> {
  const [p0, p1] = sorted(d.peg, d.weth);
  const [s0, s1] = sorted(d.share, d.weth);
  const [x0, x1] = sorted(d.peg, d.share);
  return {
    peg: { currency0: p0, currency1: p1, fee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING, hooks: d.hook },
    share: { currency0: s0, currency1: s1, fee: SHARE_POOL_FEE, tickSpacing: TICK_SPACING, hooks: d.shareBuybackHook },
    pair: { currency0: x0, currency1: x1, fee: 0, tickSpacing: TICK_SPACING, hooks: d.pairLpHook },
  };
}

/** PoolIdLibrary.toId: keccak256(abi.encode(poolKey)) — five padded 32-byte words. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** v4-core PoolManager keeps `mapping(PoolId => Pool.State) _pools` at storage slot 6. */
const POOLS_SLOT = 6n;

/** Storage slots for slot0 and in-range liquidity, read through PoolManager.extsload. */
export function poolStateSlots(key: PoolKey): { slot0: Hex; liquidity: Hex } {
  const base = keccak256(encodePacked(["bytes32", "uint256"], [poolIdOf(key), POOLS_SLOT]));
  return { slot0: base, liquidity: `0x${(BigInt(base) + 3n).toString(16).padStart(64, "0")}` };
}

export interface PoolState {
  key: PoolKey;
  /** 0 until the pool is initialised. */
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

/** Decode the two extsload words. slot0 packs sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24). */
export function decodePoolState(key: PoolKey, slot0Word: Hex | undefined, liquidityWord: Hex | undefined): PoolState | null {
  if (!slot0Word || !liquidityWord) return null;
  const s = BigInt(slot0Word);
  const sqrtPriceX96 = s & ((1n << 160n) - 1n);
  const raw = Number((s >> 160n) & 0xffffffn);
  return {
    key,
    sqrtPriceX96,
    tick: raw >= 1 << 23 ? raw - (1 << 24) : raw,
    liquidity: BigInt(liquidityWord) & ((1n << 128n) - 1n),
  };
}

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

/** currency1 per 1 currency0, 1e18-scaled (both tokens have 18 decimals in this protocol's pools when `scale` is 1e18). */
export function priceX18(sqrtPriceX96: bigint, zeroPerOne = false): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return zeroPerOne ? (Q192 * 10n ** 18n) / sq : (sq * 10n ** 18n) / Q192;
}

/**
 * Estimated output of an exact-input swap against the pool's in-range liquidity
 * (SwapMath for a single tick range). It is an ESTIMATE: the liquidity can change
 * across ticks and the hook can change the fee. The amount the chain guarantees
 * is the minimum the transaction carries, never this number.
 *
 * @param feePips LP fee in hundredths of a bip (3000 = 0.30%).
 */
export function estimateExactIn(state: PoolState, zeroForOne: boolean, amountIn: bigint, feePips: number): bigint {
  const { sqrtPriceX96: p, liquidity: L } = state;
  if (p === 0n || L === 0n || amountIn <= 0n) return 0n;
  const net = (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n;
  if (zeroForOne) {
    // sqrtP' = L·sqrtP / (L + net·sqrtP/2^96); out1 = L·(sqrtP − sqrtP')/2^96
    const next = (L * Q96 * p) / (L * Q96 + net * p);
    return (L * (p - next)) / Q96;
  }
  // sqrtP' = sqrtP + net·2^96/L; out0 = L·2^96·(sqrtP' − sqrtP)/(sqrtP'·sqrtP)
  const next = p + (net * Q96) / L;
  return (L * Q96 * (next - p)) / next / p;
}
