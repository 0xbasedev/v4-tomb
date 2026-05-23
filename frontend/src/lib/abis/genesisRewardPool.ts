/**
 * GenesisRewardPool — operator-only `add()` for registering stake tokens before
 * the Genesis window opens. The rest of the surface is shared with the other
 * MasterChef pools and lives in rewardPool.ts.
 */
export const genesisRewardPoolAbi = [
  {
    type: "function",
    name: "operator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "add",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_allocPoint", type: "uint256" },
      { name: "_token", type: "address" },
      { name: "_withUpdate", type: "bool" },
      { name: "_lastRewardTime", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "poolStartTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
