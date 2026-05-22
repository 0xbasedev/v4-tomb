# Security Triage

This document tracks the Slither static-analysis triage for Old Money. Each finding category from `slither contracts/ --filter-paths "lib/|test/|script/"` is listed with either a code fix, an inline justification, or a written-acceptance rationale.

Per `feedback_pre_deploy_gates.md`: **HIGH and MEDIUM severity findings must be fixed or explicitly justified inline. LOW / INFO findings get a written triage here.**

## Slither version

`slither-analyzer 0.11.5` (pip).

## Current state

```
High:           0
Medium:         0
Low:           44   (all accepted with rationale below)
Informational: 46   (mostly naming-convention false positives; rationale below)
Optimization:   5   (deferred to gas-optimization sprint)
```

Re-run command:

```bash
slither contracts/ --filter-paths "lib/|test/|script/"
```

---

## HIGH

None.

---

## MEDIUM

All 11 original Medium findings have been resolved.

| Original count | Detector | Resolution |
|---|---|---|
| 4 | `uninitialized-local` | Added explicit `= 0` initializers in Treasury (`daoShare`, `devShare`, `excluded`, `savedForBond`, `savedForBoardroom`). |
| 3 | `unused-return` on `IBasisAsset.mint()` | Wrapped all three callsites (`buyBonds`, `_sendToBoardroom`, `allocateSeigniorage`) in `require(...)`. Tomb-faithful: `mint` returns true for any nonzero amount, and we always pass nonzero — `require` is defensive and removes the warning. |
| 1 | `unused-return` on `getSlot0` destructuring | `// slither-disable-next-line unused-return` immediately above the destructuring assignment. We legitimately only need the tick. |
| 1 | `divide-before-multiply` in `allocateSeigniorage` | Rewrote the boardroom share to do multiplications first: `savedForBoardroom = supply * percentage * floorPercent / moneyPriceOne / 10_000`. Algebraically equivalent to Tomb's two-step at sub-wei precision (meaningless at our 1e23+ wei scales) but linear. |
| 1 | `reentrancy-no-eth` in `buyBonds` | Added `nonReentrant` modifier; moved `epochSupplyContractionLeft -= moneyAmount` BEFORE the external burn/mint calls (CEI). |
| 1 | `reentrancy-no-eth` in `allocateSeigniorage` | Added `nonReentrant` modifier; moved `seigniorageSaved += savedForBond` BEFORE the mint. The remaining cross-call ordering is governed by `nonReentrant` (Slither does not model OZ ReentrancyGuard's protection, so we suppress with an inline `// slither-disable-next-line reentrancy-no-eth` directive above the function). |

`ReentrancyGuard` and `nonReentrant` are pure additive defenses — they don't change Tomb's behavior under non-attack flows.

---

## LOW

All 44 LOW findings are accepted with rationale. They fall into 8 categories.

### `events-maths` (13 findings)

State variables modified inside computations without dedicated events. E.g., `epochSupplyContractionLeft -= moneyAmount` in `buyBonds`.

**Accepted.** Tomb-faithful: high-level events (`BoughtBonds`, `RedeemedBonds`, `BoardroomFunded`, etc.) cover the meaningful state transitions. Indexers reconstruct the math-derived state from those rather than emitting an event on every individual math step. Adding per-update events would bloat bytecode and indexer overhead without informing any new offchain decision.

### `missing-zero-check` (13 findings)

Setters that accept `address` without `if (addr == address(0)) revert ZeroAddress()`.

**Accepted.** Three reasons:

1. Most accept-an-address setters live on Treasury/Boardroom and the caller is the Timelock (`admin`); the Timelock's two-step queue → execute flow gives the admin multisig 1 day minimum to catch a mistyped zero address before it lands.
2. A few are intentional — e.g., `setOperator(address)` could be used to rotate operator to zero as a last-resort renounce (no future privileged calls succeed). Adding a hard zero-check forecloses that escape hatch.
3. Where Tomb specifically check-zeros (e.g., `setExtraFunds.daoFund`, `setExtraFunds.devFund`, `oracle != address(0)` in `_getOldmPrice`), we match Tomb.

### `timestamp` (6 findings)

`block.timestamp` used in comparisons (epoch boundary, vesting math).

**Accepted.** Required by the epoch model. Base block times are ~2 seconds; manipulation window is in seconds. Our epoch is 6 hours. The exploitable delta is < 0.05% of an epoch — too small to matter for our mechanisms.

### `calls-loop` (5 findings)

External calls inside `for` loops (e.g., `getMoneyCirculatingSupply` iterates `excludedFromTotalSupply`).

**Accepted.** All such loops are bounded:
- `supplyTiers[]` and `maxExpansionTiers[]` are fixed at 9 entries.
- `excludedFromTotalSupply[]` is set once in `initialize` and contains a small handful of pool addresses (genesis pool, main pool, airdrop wallet — 3 entries in our deploy).
- `Distributor.distribute` iterates a fixed list passed at construction.

DoS via runaway loop is impossible — the loop bound is set at deploy or under Timelock.

### `events-access` (3 findings)

Access-control state changes that don't emit. E.g., `setOperator` on Treasury doesn't emit `OperatorTransferred`.

**Accepted with TODO.** Tomb's Treasury also doesn't emit; we're matching. Polish pass before mainnet should add `OperatorTransferred(prev, next)` events on `Treasury.setOperator` and `Boardroom.setOperator`. Tracked separately; not load-bearing for security.

### `shadowing-local` (2 findings)

A local variable in an inner scope shadows an outer-scope variable name.

**Accepted.** Cosmetic. The shadowing is obvious in context. Fix in a polish pass.

### `reentrancy-benign` (1 finding)

State changes happen after an external call, but no security consequence follows.

**Accepted.** Function is also guarded by `onlyOneBlock`; the post-call state changes only affect events / non-load-bearing storage.

### `reentrancy-events` (1 finding)

An event emit happens after an external call. Reentry could observe inconsistent log ordering.

**Accepted.** No security consequence. Slither's lowest-confidence reentrancy class.

---

## INFORMATIONAL

### `naming-convention` (41 findings)

Function parameters use `_camelCase` (e.g., `_money`, `_trustnote`, `_devFund`). Slither expects bare `camelCase`.

**Rejected as false positive.** The `_param` convention is standard Solidity style for differentiating constructor / setter parameters from same-named storage variables. Used by OpenZeppelin, Compound, Uniswap, and Tomb itself. Deliberate.

### `missing-inheritance` (3 findings)

`Distributor`, `OldMoney`, and `TrustNote` should declare `is IDistributor` / `is IBasisAsset`.

**Accepted with TODO.** Cosmetic — adding the explicit `is IBasisAsset` annotation is good practice and helps offchain tooling resolve the interface. Will add in a polish pass. The contracts DO implement the interfaces in practice; the declarations are just missing.

### `low-level-calls` (1 finding)

`Timelock.executeTransaction` uses `target.call{value: value}(callData)`.

**Accepted.** This is the entire point of the Timelock contract. It must invoke arbitrary target / arbitrary calldata — that's not possible without `call`. Compound's original audit accepts this same pattern.

### `unimplemented-functions` (1 finding)

`PegDefenseHook` reportedly doesn't implement `BaseV4Hook.getHookPermissions()`.

**False positive.** `PegDefenseHook` DOES override `getHookPermissions()` at the top of the contract (`public pure override returns (Hooks.Permissions memory)`). Slither's analysis of `BaseV4Hook` as an abstract intermediate isn't catching the concrete override.

---

## OPTIMIZATION

### `immutable-states` (5 findings)

`Epoch._startTime`, `Estate.startTime`, `Estate.endTime`, `Estate.communityFundRewardRate`, `Estate.devFundRewardRate` could be `immutable`.

**Deferred to Sprint 10 (gas optimization).** All five are set once in the constructor and never written again. Adding `immutable` is a free gas win (~2100 gas per read). Will do in the gas-optimization sweep along with other low-hanging optimizations like `cache-array-length`.

### `cache-array-length` (was 1 finding, now 0)

`for (uint256 i = 0; i < array.length; ...)` — caching `array.length` saves SLOADs.

**Already fixed in this sprint.** Added `uint256 len = excludedFromTotalSupply.length;` in `getMoneyCirculatingSupply`.

---

## Outstanding TODOs (polish-pass items)

1. Emit `OperatorTransferred(prev, next)` on `Treasury.setOperator` and `Boardroom.setOperator`.
2. Add explicit `is IBasisAsset` / `is IDistributor` annotations to `OldMoney`, `TrustNote`, `Distributor`.
3. Mark `Epoch._startTime`, `Estate.startTime` / `endTime` / `communityFundRewardRate` / `devFundRewardRate` as `immutable`.
4. Resolve two `shadowing-local` cases by renaming the inner variable.

None of these are security-load-bearing; all are quality-of-life polish before audit handoff.
