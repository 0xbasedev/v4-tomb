/**
 * Ownable2Step minimal read surface — owner() + pendingOwner() — used by the
 * Rotation Status panel to detect ceremony state. Every admin-bearing contract
 * in the protocol inherits Ownable2Step via Trustees, so the same ABI works
 * for PegToken, ShareToken, TrustNote, and PegDefenseHook.
 */
export const ownable2StepAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "pendingOwner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
