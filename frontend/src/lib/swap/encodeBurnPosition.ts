import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";

/**
 * Encode the V4 PositionManager.modifyLiquidities calldata for a
 * BURN_POSITION + TAKE_PAIR sequence — removes ALL liquidity from a
 * position, burns the NFT, and transfers the underlying tokens to a recipient.
 *
 * Actions: bytes("\x03\x11")
 *   BURN_POSITION = 0x03
 *   TAKE_PAIR     = 0x11
 *
 * BURN_POSITION params:
 *   (uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData)
 *
 * TAKE_PAIR params:
 *   (address currency0, address currency1, address recipient)
 *
 * Returns the `unlockData` bytes for PositionManager.modifyLiquidities(unlockData, deadline).
 */

const BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;

export interface BurnPositionArgs {
  tokenId: bigint;
  /** Minimum amount0 the caller will accept back (slippage cap). 0n disables. */
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}

export function encodeBurnPosition(args: BurnPositionArgs): Hex {
  const hookData: Hex = args.hookData ?? "0x";

  const params0 = encodeAbiParameters(
    parseAbiParameters(
      "uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData",
    ),
    [args.tokenId, args.amount0Min, args.amount1Min, hookData],
  );

  const params1 = encodeAbiParameters(
    parseAbiParameters("address currency0, address currency1, address recipient"),
    [args.currency0, args.currency1, args.recipient],
  );

  const actions: Hex = `0x${[BURN_POSITION, TAKE_PAIR]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  return encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [
    actions,
    [params0, params1],
  ]);
}
