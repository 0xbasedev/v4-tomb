/**
 * Uniswap V4 PoolManager — just enough surface to read pool state via extsload.
 * Avoids deploying a separate StateView for our own UI needs.
 */
export const poolManagerAbi = [
  {
    type: "function",
    name: "extsload",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;
