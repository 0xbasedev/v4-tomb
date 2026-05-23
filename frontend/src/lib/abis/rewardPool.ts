/**
 * Shared MasterChef-style reward pool surface. Used by Genesis (rewards MONEY),
 * Main (rewards MONEY), and Share (rewards ESTATE). The accessors return identical
 * shapes; only the reward-name view (`pendingMoney` vs `pendingShare`) differs.
 *
 * The two pendingX views are exported as separate ABIs so wagmi narrows the
 * type to the correct return value at the call site.
 */

const POOL_INFO_OUTPUTS = [
  { name: "token", type: "address" },
  { name: "allocPoint", type: "uint256" },
  { name: "lastRewardTime", type: "uint256" },
  { name: "accPerShare", type: "uint256" },
  { name: "isStarted", type: "bool" },
] as const;

const USER_INFO_OUTPUTS = [
  { name: "amount", type: "uint256" },
  { name: "rewardDebt", type: "uint256" },
] as const;

/** Money-emitting reward pool (Genesis + Main). */
export const moneyRewardPoolAbi = [
  {
    type: "function",
    name: "poolInfo",
    stateMutability: "view",
    inputs: [{ name: "pid", type: "uint256" }],
    outputs: POOL_INFO_OUTPUTS,
  },
  {
    type: "function",
    name: "userInfo",
    stateMutability: "view",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: USER_INFO_OUTPUTS,
  },
  {
    type: "function",
    name: "pendingMoney",
    stateMutability: "view",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalAllocPoint",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "poolStartTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "poolEndTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ----- Writes -----
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "emergencyWithdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "pid", type: "uint256" }],
    outputs: [],
  },
] as const;

/** Share-emitting reward pool (Share pool — emits ESTATE). */
export const shareRewardPoolAbi = [
  {
    type: "function",
    name: "poolInfo",
    stateMutability: "view",
    inputs: [{ name: "pid", type: "uint256" }],
    outputs: POOL_INFO_OUTPUTS,
  },
  {
    type: "function",
    name: "userInfo",
    stateMutability: "view",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: USER_INFO_OUTPUTS,
  },
  {
    type: "function",
    name: "pendingShare",
    stateMutability: "view",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalAllocPoint",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "poolStartTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ----- Writes -----
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pid", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "emergencyWithdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "pid", type: "uint256" }],
    outputs: [],
  },
] as const;
