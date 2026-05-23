import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";

import { V4_ACTIONS } from "@/lib/abis";

/**
 * Encode a single-hop exact-input V4 swap for UniversalRouter.execute().
 *
 * The encoding is two layers:
 *
 *   Outer (UR.execute):
 *     commands = bytes("\x10")           — V4_SWAP
 *     inputs[0] = abi.encode(actions, params[])
 *
 *   Inner (V4_SWAP input):
 *     actions = bytes("\x06\x0c\x0f")    — SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
 *     params[0] = abi.encode(ExactInputSingleParams)
 *     params[1] = abi.encode(currencyIn,  maxAmountIn)   — for SETTLE_ALL
 *     params[2] = abi.encode(currencyOut, minAmountOut)  — for TAKE_ALL
 *
 * ExactInputSingleParams (matches v4-periphery IV4Router):
 *   {
 *     poolKey: { currency0, currency1, fee, tickSpacing, hooks },
 *     zeroForOne: bool,
 *     amountIn: uint128,
 *     amountOutMinimum: uint128,
 *     minHopPriceX36: uint256,   // per-hop price slippage (0 = disabled)
 *     hookData: bytes
 *   }
 *
 * Notes on slippage:
 *   - amountOutMinimum guards the total output. Pass `0n` to skip; pass a tight
 *     value if you want slippage protection. Sprint C polish can compute this
 *     from spot price * (1 - slippageBps/10_000) - hook tax estimate.
 *   - minHopPriceX36 guards per-hop pricing. Single-hop swaps usually leave it 0.
 *
 * Notes on the hook tax:
 *   - PegDefenseHook applies its tax in beforeSwap when (autoCalculateTax &&
 *     selling MONEY && price < peg). The net output already accounts for that
 *     deduction by the time TAKE_ALL fires — caller doesn't need extra encoding.
 */

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface V4SwapArgs {
  poolKey: PoolKey;
  /** True = swap currency0 → currency1, false = currency1 → currency0. */
  zeroForOne: boolean;
  /** Wei of the input token. */
  amountIn: bigint;
  /** Minimum wei of the output token. 0n disables overall slippage. */
  amountOutMinimum: bigint;
  /** Optional hook bytes; defaults to empty. */
  hookData?: Hex;
}

/** Returns (commands, inputs) ready to pass to UniversalRouter.execute(commands, inputs, deadline). */
export function encodeV4Swap(args: V4SwapArgs): { commands: Hex; inputs: Hex[] } {
  const { poolKey, zeroForOne, amountIn, amountOutMinimum } = args;
  const hookData: Hex = args.hookData ?? "0x";

  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  // Inner action params.
  // 6 top-level params: tuple(PoolKey), bool, uint128, uint128, uint256, bytes.
  // The outer parens around all 6 would make viem parse this as a single 6-tuple
  // param — which is wrong; we want 6 distinct params.
  const params0 = encodeAbiParameters(
    parseAbiParameters(
      "(address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData",
    ),
    [
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      zeroForOne,
      amountIn,
      amountOutMinimum,
      0n /* minHopPriceX36 = 0 disables per-hop check */,
      hookData,
    ],
  );

  const params1 = encodeAbiParameters(parseAbiParameters("address, uint256"), [
    currencyIn,
    amountIn,
  ]);

  const params2 = encodeAbiParameters(parseAbiParameters("address, uint256"), [
    currencyOut,
    amountOutMinimum,
  ]);

  // Actions byte-string: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
  const actions: Hex = `0x${[
    V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
    V4_ACTIONS.SETTLE_ALL,
    V4_ACTIONS.TAKE_ALL,
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  // Outer input for V4_SWAP command: abi.encode(actions, params[]).
  const v4SwapInput = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [
    actions,
    [params0, params1, params2],
  ]);

  // UR commands: single V4_SWAP byte.
  const commands: Hex = `0x10`;
  const inputs: Hex[] = [v4SwapInput];

  return { commands, inputs };
}
