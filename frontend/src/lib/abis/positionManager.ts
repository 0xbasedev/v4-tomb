/**
 * Uniswap V4 PositionManager — minimal read+write surface for the wrap flow.
 *
 * Read calls:
 *   - balanceOf(owner)            → number of LP NFTs held
 *   - ownerOf(tokenId)            → current owner of a tokenId
 *   - getApproved(tokenId)        → currently-approved operator (for single-NFT
 *                                    approve, the V4PositionWrapper needs this)
 *   - getPositionLiquidity        → liquidity (uint128) of the position
 *   - getPoolAndPositionInfo      → pool key + packed info (incl. tickLower/Upper)
 *
 * Writes:
 *   - approve(operator, tokenId)  → grant the wrapper permission to pull this one NFT
 */

export const positionManagerAbi = [
  // ----- Reads -----
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "info", type: "uint256" },
    ],
  },
  // ----- Writes -----
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
