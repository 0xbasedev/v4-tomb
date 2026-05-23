import { Q96 } from "./tickMath";

/**
 * V4 LiquidityAmounts port — getLiquidityForAmounts + getLiquidityForAmount0/1.
 *
 * Mirror of v4-periphery/src/libraries/LiquidityAmounts.sol. Returns the maximum
 * uint128 liquidity supported by the supplied amounts at the given sqrtPrice bounds.
 *
 * JS BigInt has unlimited precision, so the contract's 512-bit mulDiv reduces to
 * the obvious `(a * b) / c` here. The contract's `FullMath` would overflow at
 * intermediate * amount0 if intermediate were Q128.96-scaled — we only operate at
 * Q64.96 throughout, well within BigInt range.
 */

/** Liquidity supported by `amount0` between two sqrt-prices. */
export function getLiquidityForAmount0(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  const intermediate = (sqrtPriceAX96 * sqrtPriceBX96) / Q96;
  return (amount0 * intermediate) / (sqrtPriceBX96 - sqrtPriceAX96);
}

/** Liquidity supported by `amount1` between two sqrt-prices. */
export function getLiquidityForAmount1(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  return (amount1 * Q96) / (sqrtPriceBX96 - sqrtPriceAX96);
}

/**
 * Maximum liquidity supported by both amounts at the current sqrtPrice between
 * the tick bounds. Matches V4's three-case decomposition:
 *   sqrtPrice <= lower → all-token0 region: liquidity from amount0
 *   sqrtPrice >= upper → all-token1 region: liquidity from amount1
 *   in-range           → min(liquidity0, liquidity1)
 */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  if (sqrtPriceX96 <= sqrtPriceAX96) {
    return getLiquidityForAmount0(sqrtPriceAX96, sqrtPriceBX96, amount0);
  }
  if (sqrtPriceX96 < sqrtPriceBX96) {
    const l0 = getLiquidityForAmount0(sqrtPriceX96, sqrtPriceBX96, amount0);
    const l1 = getLiquidityForAmount1(sqrtPriceAX96, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(sqrtPriceAX96, sqrtPriceBX96, amount1);
}

/**
 * Inverse: given a liquidity figure, compute the amount0 + amount1 needed at the
 * current sqrtPrice between tick bounds. Useful for the "fill matching amount"
 * UX where the user types one side and the other auto-populates.
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  if (sqrtPriceX96 <= sqrtPriceAX96) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceAX96, sqrtPriceBX96, liquidity),
      amount1: 0n,
    };
  }
  if (sqrtPriceX96 < sqrtPriceBX96) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtPriceBX96, liquidity),
      amount1: getAmount1ForLiquidity(sqrtPriceAX96, sqrtPriceX96, liquidity),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1ForLiquidity(sqrtPriceAX96, sqrtPriceBX96, liquidity),
  };
}

function getAmount0ForLiquidity(a: bigint, b: bigint, liquidity: bigint): bigint {
  // amount0 = L * (sqrtB - sqrtA) * 2^96 / (sqrtA * sqrtB)
  return (((liquidity << 96n) * (b - a)) / b) / a;
}

function getAmount1ForLiquidity(a: bigint, b: bigint, liquidity: bigint): bigint {
  // amount1 = L * (sqrtB - sqrtA) / 2^96
  return (liquidity * (b - a)) / Q96;
}
