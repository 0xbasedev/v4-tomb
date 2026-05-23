/**
 * UniversalRouter v2 — Uniswap's multi-protocol router. The V4-capable version
 * exposes a `V4_SWAP` command (0x10) that wraps the V4 PoolManager's
 * unlock+callback pattern in a single external call.
 *
 * Address per chain is canonical — see `addresses.ts`. The `execute` signature
 * is stable across the v2 series.
 */
export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** UniversalRouter command codes — V4-capable variant. */
export const UR_COMMANDS = {
  V4_SWAP: 0x10 as const,
} as const;

/** V4Router action codes (matches lib/v4-periphery/src/libraries/Actions.sol). */
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06 as const,
  SETTLE_ALL: 0x0c as const,
  TAKE_ALL: 0x0f as const,
} as const;
