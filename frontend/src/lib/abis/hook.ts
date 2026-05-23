/**
 * PegDefenseHook read surface used by the frontend for the live price + tier display
 * on the Swap page. Writes (setTreasury, setAutoCalculateTax, etc.) are operator-only
 * and run via the contracts/script/PostBootstrap.s.sol — not exposed to the frontend.
 */
export const hookAbi = [
  {
    type: "function",
    name: "lastTick",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    type: "function",
    name: "priceFromTick",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "taxRateForPrice",
    stateMutability: "view",
    inputs: [{ name: "price", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "autoCalculateTax",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "bound",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "moneyIsCurrency0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
