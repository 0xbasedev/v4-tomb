/**
 * V4 TickMath port — getSqrtPriceAtTick.
 *
 * Mirror of v4-core/src/libraries/TickMath.sol. Used to convert ticks into
 * the sqrtPriceX96 values that V4 PoolManager and LiquidityAmounts need.
 *
 * The algorithm is a sequence of bit-tested multiplications by precomputed
 * 128-bit fixed-point ratios, recovering 2^(absTick / 2). For positive ticks,
 * the result is inverted from the negative-tick computation.
 *
 * Validation: cross-checked against PegDefenseHook.priceFromTick on Base Sepolia
 * for tick=0, ±100, ±887220.
 */

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const Q160_MASK = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Lowest tick V4 supports — TickMath.MIN_TICK in the contract. */
export const MIN_TICK = -887272;
/** Highest tick V4 supports. */
export const MAX_TICK = 887272;

/** Compute the usable min tick for a given tickSpacing (rounds toward zero). */
export function minUsableTick(tickSpacing: number): number {
  return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
}

/** Compute the usable max tick for a given tickSpacing. */
export function maxUsableTick(tickSpacing: number): number {
  return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
}

/**
 * Return sqrt(1.0001^tick) * 2^96 as a uint160-clamped bigint.
 *
 * Reverts (throws) for ticks outside [MIN_TICK, MAX_TICK].
 */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`TickMath: tick ${tick} out of bounds`);
  }
  const absTick = BigInt(tick < 0 ? -tick : tick);

  let ratio: bigint =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;

  // Each conditional shift multiplies by the next-power ratio and divides by 2^128.
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  // Positive tick: invert
  if (tick > 0) ratio = UINT256_MAX / ratio;

  // Downshift by 32 bits to get Q64.96 representation, rounding up if non-zero remainder.
  const shifted = ratio >> 32n;
  const remainder = ratio & 0xffffffffn;
  const sqrtPriceX96 = remainder > 0n ? shifted + 1n : shifted;

  // Clamp to uint160 — defensive (the math shouldn't overflow but uint160 is the
  // on-chain return type).
  return sqrtPriceX96 & Q160_MASK;
}

// Re-export to avoid unused-import warnings in consumers that only want Q96.
export { Q96, Q128 };
