import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";

import type { PoolKey } from "./encodeV4Swap";

/**
 * Encode the V4 PositionManager.modifyLiquidities calldata for a full-range
 * MINT_POSITION + SETTLE_PAIR sequence. Mirrors SeedLiquidity.s.sol exactly.
 *
 * Actions: bytes("\x02\x0d")
 *   MINT_POSITION = 0x02
 *   SETTLE_PAIR   = 0x0d
 *
 * MINT_POSITION params:
 *   (PoolKey, int24 tickLower, int24 tickUpper, uint256 liquidity,
 *    uint128 amount0Max, uint128 amount1Max, address recipient, bytes hookData)
 *
 * SETTLE_PAIR params:
 *   (Currency currency0, Currency currency1)
 *
 * Note: PositionManager.modifyLiquidities takes (bytes unlockData, uint256 deadline).
 * The unlockData is abi.encode(actions, params[]) — that's what this returns.
 */

const MINT_POSITION = 0x02;
const SETTLE_PAIR = 0x0d;

export interface MintPositionArgs {
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  recipient: Address;
  hookData?: Hex;
}

/** Returns the `unlockData` bytes for PositionManager.modifyLiquidities(unlockData, deadline). */
export function encodeMintPosition(args: MintPositionArgs): Hex {
  const hookData: Hex = args.hookData ?? "0x";

  const params0 = encodeAbiParameters(
    parseAbiParameters(
      "(address,address,uint24,int24,address) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address recipient, bytes hookData",
    ),
    [
      [args.poolKey.currency0, args.poolKey.currency1, args.poolKey.fee, args.poolKey.tickSpacing, args.poolKey.hooks],
      args.tickLower,
      args.tickUpper,
      args.liquidity,
      args.amount0Max,
      args.amount1Max,
      args.recipient,
      hookData,
    ],
  );

  const params1 = encodeAbiParameters(parseAbiParameters("address, address"), [
    args.poolKey.currency0,
    args.poolKey.currency1,
  ]);

  const actions: Hex = `0x${[MINT_POSITION, SETTLE_PAIR]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  return encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [
    actions,
    [params0, params1],
  ]);
}
