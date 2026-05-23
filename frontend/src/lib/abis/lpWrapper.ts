/**
 * V4PositionWrapper — wraps a MONEY-WETH V4 LP NFT into ERC-20 share certificates
 * that can be staked in Main/Share reward pools.
 *
 * The wrapper validates the position's pool ID + exact tick range (full range only)
 * before pulling the NFT. Shares are minted 1:1 with the position's liquidity
 * (uint128). Unwrap is gated to the original wrapper of each tokenId.
 */
export const lpWrapperAbi = [
  // ----- Config reads -----
  {
    type: "function",
    name: "tickLower",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    type: "function",
    name: "tickUpper",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    type: "function",
    name: "wrappedBy",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "wrappedLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  // ----- ERC-20 surface (the share certificate) -----
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ----- Writes -----
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    type: "function",
    name: "unwrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;
