/**
 * Permit2 — Uniswap's token-approval contract.
 * Address supplied by the deployment manifest.
 *
 * Swap flow uses the AllowanceTransfer side of Permit2:
 *   1. user ERC-20.approve(permit2, max)              — one-time per token
 *   2. permit2.approve(token, universalRouter, amt, expiration) — one-time per
 *      (token, spender) pair, until expiration
 *   3. universalRouter.execute(...)                   — every swap
 *
 * We only need allowance + approve on the read/write surface. The richer
 * permit-by-signature flow (allowanceTransferDetails, permit{,Batch}) is out
 * of scope for this turn — a future polish lets users sign instead of approve.
 */
export const permit2Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;
