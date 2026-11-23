# PegDefenseHook accounting repair: review and verification gates

Status: **draft / unverified**. This branch proposes a focused repair to the original `PegDefenseHook`. It does **not** complete the approved LEVEL/SQUARE economic redesign. No deployment or security validation is claimed.

## Contract-level accounting repairs

**Exact-input sell** (MONEY is specified input): `beforeSwap` calculates tax on the specified MONEY input, takes that MONEY from the PoolManager and returns a positive *specified* `BeforeSwapDelta` so the swap only uses net input. `afterSwap` returns zero for this swap type.

**Exact-output sell** (paired asset is specified output): `beforeSwap` does not levy a tax based on the output denomination. `afterSwap` reads the actual negative MONEY input from `BalanceDelta.amount0/amount1`, calculates the MONEY-denominated tax using the pre-swap rate, calls `poolManager.take` for MONEY and returns a positive *unspecified* MONEY delta. Uniswap v4 charges that amount to the swap caller when it settles its pool delta.

**Tick accumulator**: `beforeSwap` integrates the previous post-swap tick over the elapsed window and records the current pre-swap tick. `afterSwap` saves the newly observed pool tick as `lastTick` for future idle-time projection. `getCurrentTickCumulative` then integrates the true last traded price across idle periods.

This is a hybrid tax path that **preserves the existing MONEY-input tax denomination**. It does not implement the suggested `afterSwap` quote-output-only tax, because v4's unspecified currency is output on exact-input swaps but input on exact-output swaps. The two cannot be treated as the same asset.

## Hook deployment and migration

- Permission bits changed from `0x1088` to **`0x10CC`**: afterInitialize, beforeSwap, afterSwap, beforeSwapReturnDelta and afterSwapReturnDelta.
- Mine a new CREATE2 salt and deploy a new hook address. Do not attempt to attach the old hook address to a pool expecting the new callback permissions.
- Config validation accepts **only `0x10CC`**. The historical Base Sepolia example retains its original address as a nondeployable archive and intentionally fails the current deployment schema.
- Historical pools cannot change their hook association in place: prepare a controlled liquidity migration and update oracle, deployment manifest, wrappers, Treasury references, frontends and keepers.
- Current fork integration tests are skipped when `BASE_RPC_URL` is unset. A green local unit suite alone is **not** sufficient validation.

## Economic requirements still missing from this old v4-tomb implementation

The original `PegDefenseHook` uses Tomb's legacy 14-tier table (up to 20%) and permits setters to reach 100%. The latest approved xTomb target is different:

- **12% immutable maximum sell tax**, including every administrative setter and rate path.
- **6% at 1.12x configured peg; 3% at 1.20x configured peg**.
- **7-hour floor for tax decreases** while increases can respond immediately.
- Fire Tax quote-unit normalization, including non-18-decimal paired assets, and strict policy for pegged thresholds.
- Policy-level review of buy/sell exemption semantics and alternative, hookless pools. LEVEL/SQUARE stay permissionless.
- v4 exact-output and exact-input taxed-swap accounting under real PoolManager, plus multicall/multi-hop, price limits, zero-liquidity, LP/zap and callback-reentrancy tests.

**Do not claim the 12% cap, 6%/3% curve, or seven-hour recovery are already implemented in this branch.** They require a follow-up economic-policy patch with its own tests before production deployment.

## Commands for reviewers

Run with the repository's pinned Foundry dependencies in a network-capable environment:

```sh
forge build
forge test --match-contract PegDefenseHookTest -vvv
forge test --match-contract PegDefenseHookInvariants -vvv
forge test --match-contract BaseForkHookTaxTest -vvv --fork-url "$BASE_RPC_URL"
node --test config/schema.test.mjs
```

The fork tests require `BASE_RPC_URL`. Record the actual test results and review `afterSwap` settlement deltas before merging. No real user funds should be deployed on the strength of source inspection alone.
