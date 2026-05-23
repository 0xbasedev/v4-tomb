# Old Money — Audit Handoff

Package for an external security auditor. Compiled 2026-05-23 against commit `02b6975` (and successor commits on the same branch).

## 1 · Protocol summary

Old Money is a Tomb-Finance-style algorithmic stablecoin on Base, deployed against Uniswap V4. The economic mechanics are a direct port of Tomb (`bombmoney/bomb-contracts`); the *only* deliberate architectural deviation is replacing Tomb's TaxOfficeV2 / transferFrom-tax mechanism with a Uniswap V4 hook (`PegDefenseHook`). All other contracts are minimal-modification ports.

Three tokens:

| Token | Role | Tomb analog |
|---|---|---|
| `$MONEY` (`OldMoney.sol`) | Stable token, pegged 1:1 to WETH | `$TOMB` |
| `$ESTATE` (`Estate.sol`) | Share / governance token, hard-capped 70k | `$TSHARE` |
| `$TRUSTNOTE` (`TrustNote.sol`) | Bond token, issued at contraction, redeemed at premium | `$TBOND` |

Peg = 1 MONEY ≡ 1 WETH (1e18-scaled). This is one of two changes from Tomb's `moneyPriceOne=1e14`; the other is the V4 hook. Every other parameter is Tomb-faithful by reference to `docs/tomb-skill/`.

## 2 · In-scope contracts

```
src/
├── core/
│   ├── Boardroom.sol          ESTATE stakers earn MONEY each expansion epoch
│   ├── Distributor.sol        Genesis distributor (initial MONEY mint to reward pools)
│   └── Treasury.sol           Seigniorage engine. Epoch tick, bond office,
│                              expansion/contraction logic. The protocol's brain.
│
├── distribution/
│   ├── GenesisRewardPool.sol  24h window, accepts outside ERC-20s, distributes 11k MONEY
│   ├── MainRewardPool.sol     9d, accepts LP wrapper shares, distributes 140k MONEY
│   ├── ShareRewardPool.sol    370d, accepts LP wrapper shares, distributes 59.5k ESTATE
│   └── V4PositionWrapper.sol  ERC-721 → ERC-20 wrapper for V4 LP positions
│
├── governance/
│   ├── Trustees.sol           OpenZeppelin Ownable2Step-derived role
│   ├── Timelock.sol           Compound-style queue/execute with 1d–30d delay
│
├── hooks/
│   ├── base/BaseV4Hook.sol    Minimal V4 hook base (replaces v4-periphery's old BaseHook)
│   └── PegDefenseHook.sol     **THE NEW SURFACE.** Replaces Tomb's TaxOffice +
│                               tax-on-transferFrom mechanism with a V4 hook that:
│                                 a) records tick cumulative for Oracle TWAP
│                                 b) applies a dynamic LP fee per peg distance
│                                 c) applies a 14-tier Tomb-faithful sell tax,
│                                    burning below burnThreshold / routing to
│                                    Treasury above. Only sells through this pool
│                                    are taxed — wallet-to-wallet transfers are free.
│
├── interfaces/                Standard interfaces; no logic
│
├── libs/
│   ├── Addresses.sol          Per-chain canonical V4 + WETH + Permit2 addresses
│   ├── ContractGuard.sol      onlyOneBlock (anti-flash-loan helper)
│   └── Epoch.sol              Period-windowed epoch counter (Tomb port)
│
├── oracle/
│   └── Oracle.sol             Fixed-window TWAP. Reads tick cumulatives from
│                              PegDefenseHook (via IPriceSource) instead of a V2
│                              pair's price0CumulativeLast. Math equivalent.
│
└── tokens/
    ├── OldMoney.sol           $MONEY — ERC-20 + Trustees-mint + public burn
    ├── Estate.sol             $ESTATE — ERC-20 + 5.5k+5k linear vesting to community/dev
    └── TrustNote.sol          $TRUSTNOTE — ERC-20 + Trustees-mint + Trustees-burnFrom
```

Out of scope (third-party, audited elsewhere):
- Uniswap V4 core + periphery (lib/v4-core, lib/v4-periphery)
- Permit2 (canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3)
- OpenZeppelin v5 (lib/openzeppelin-contracts)
- Solady (lib/solady) — not currently imported, kept for future use

## 3 · Test surface

| Category | Count | Profile | Status |
|---|---|---|---|
| Unit tests | ~290 | default | green |
| Fork tests (Base mainnet) | 24 | requires `BASE_RPC_URL` | green |
| Integration tests | ~36 | default | green |
| Invariants | 42 across 7 suites | default (256×50) | green |
| Invariants | 42 | deep (2500×100) | green, 684s wall |
| Invariants | 42 | audit (10000×200) | run before signing off |

**Total: 350 tests passing as of commit `02b6975`.**

Invariant suites cover:
- `OldMoneyInvariants` — MONEY token supply integrity
- `EstateInvariants` — ESTATE cap + fund allocation
- `BoardroomInvariants` — Masonry stake/withdraw conservation
- `EpochInvariants` — Epoch counter monotonicity, period bounds, immutability
- `OracleInvariants` — TWAP timestamp monotonicity, sticky-init, error paths
- `PegDefenseHookInvariants` — Tax tier table monotonicity, rate caps, immutables
- `TreasuryParamInvariants` — Every Trustees-settable param stays in declared bounds across any setter sequence

## 4 · Static analysis

Slither (medium+ severity): **0 findings.**

12 medium findings were triaged and annotated as known-benign MasterChef false positives — all 12 are in `src/distribution/*RewardPool.sol`:
- 6× `divide-before-multiply` on the accumulator math (`accPerShare * 1e18 / tokenSupply`). Tomb / SushiSwap MasterChef use this exact pattern; the alternative ordering overflows for large `(generated * allocPoint)` products.
- 6× `incorrect-equality` on `tokenSupply == 0` and `bal == 0` sentinel guards.

Each `slither-disable-next-line` annotation has a one-line rationale comment.

## 5 · Architectural decisions

### 5.1 V4 hook replaces Tomb's TaxOffice

**Tomb behaviour:** every `transferFrom` of TOMB triggers a 14-tier price-based tax. Implemented as an override of OZ's `_transfer` plus a `taxCollectorAddress` settable by `TaxOffice`.

**Old Money behaviour:** sells through the MONEY/WETH V4 pool trigger the same 14-tier tax. Wallet-to-wallet MONEY transfers are free. Implemented as a `beforeSwap` hook that:
1. Reads the current tick from the pool.
2. Computes the 1e18-scaled MONEY/WETH price via `TickMath.getSqrtPriceAtTick`.
3. Looks up the tax rate from the same 14-tier table Tomb uses.
4. Takes the tax slice from the input side via `BeforeSwapDelta`, then either burns (below `burnThreshold=1.10e18`) or routes to `treasury` (above).

**Rationale:** the economic intent in Tomb was always sell-side. The transferFrom-taxes-everything implementation was a side-effect of intercepting at the token level. V4 hooks let us tax exactly the sell path — same economic effect, no friction on protocol movements (e.g. reward-pool deposits/withdrawals).

See `docs/HOOK_TAX_DESIGN.md` for the full design rationale and tier table justification.

### 5.2 WETH peg (not cbETH, not USDC)

**Tomb behaviour:** `tombPriceOne = 1e14`, against BTC at $10k. Cents-level scale.

**Old Money behaviour:** `moneyPriceOne = 1e18`, against WETH. 1 MONEY = 1 WETH. Same algebra at a different scale; all `1e14` literals in Tomb's math replaced with `moneyPriceOne`.

**Rationale:** WETH is the deepest-liquidity asset on Base. Canonical pre-deploy at the OP-stack slot `0x4200…0006`, no mock needed on testnets, no Coinbase-only restriction (which cbETH had). USDC was considered but introduces an additional oracle (USDC depeg risk) and a centralization vector.

### 5.3 LP wrapper for Main + Share staking

**Tomb behaviour:** Main/Share reward pools accept LP tokens from PancakeSwap/SpookySwap directly (those are V2 pairs, which are ERC-20).

**Old Money behaviour:** V4 LPs are NFTs, not fungible. The `V4PositionWrapper` accepts a full-range MONEY/WETH V4 LP NFT, validates the pool + exact tick range, and mints ERC-20 shares 1:1 with the position's liquidity. Unwrap is gated to the original wrapper of each tokenId. Reward pools stake the ERC-20 shares.

**Rationale:** preserves the MasterChef stake-fungible-tokens model without rewriting the reward pools. The exact-range requirement means all stakers commit identical full-range positions, eliminating the "what tick range does the operator accept" governance question.

### 5.4 Treasury bug fixes versus Tomb

Two Tomb-fidelity bugs were found pre-deploy and fixed:

- **BUG #1**: `bootstrapEpochs` was 7. Tomb uses 28 (= 7 days at 6h epochs). Fixed.
- **BUG #2**: `maxDebtRatioPercent` was 4500. Tomb uses 3500 (35%). Fixed.

Both documented in `docs/TOMB_AUDIT.md`.

### 5.5 Intentional Tomb deviations to note

- **No `bondTreasury` / `_sendToBondTreasury`** — Tomb's POL-bond mechanism (5%/epoch to a separate POL bond contract) is omitted from v1. Rationale: the core peg-defense mechanism functions identically without it; POL is a long-term durability layer that can be added in a future Treasury upgrade. Documented in `docs/TOMB_AUDIT.md` BUG #3 and `docs/GAP_AUDIT.md`.
- **`autoCalculateTax = false` at deploy** — Tomb-faithful launch pattern. Trustees flips it to true post-bootstrap (the post-launch operator decision is captured in `docs/LAUNCH_RUNBOOK.md` §4.1).
- **`daoFundSharedPercent` and `devFundSharedPercent` = 0 at deploy** — Tomb-faithful zero-rake at launch. Operator sets via `setExtraFunds` post-bootstrap (`docs/LAUNCH_RUNBOOK.md` §4.2).

## 6 · Threat model

What we'd ask the auditor to focus on:

1. **`PegDefenseHook.beforeSwap` tax delta math.** This is the only contract that uses `BeforeSwapDelta` to extract value mid-swap. Sign conventions on `deltaSpecified` vs `deltaUnspecified` for exact-in vs exact-out swaps are subtle. The unit + integration tests cover both paths, but a careful eye on the sign handling at L319-325 is warranted.

2. **`Treasury.allocateSeigniorage` boundaries.** The bootstrap/expansion/contraction branching is faithful to Tomb but is doing arithmetic on percentages, supplies, and a TWAP that may revert. We rely on `_updateMoneyPrice`'s try/catch to absorb a pre-init oracle. Confirm: no path mints MONEY beyond `maxSupplyExpansionPercent`; no path under-funds the Boardroom; no path advances the epoch without invoking the modifier's update loop.

3. **`V4PositionWrapper` unwrap gating.** `unwrap` is gated to `wrappedBy[tokenId] == msg.sender`. The mapping is set in `wrap()` before the NFT pull (CEI). Confirm no path lets a non-wrapper redeem.

4. **`Oracle` math.** Tick-cumulative-delta → average-tick → sqrtPriceX96 → amount conversion uses two FullMath.mulDiv passes to avoid 512-bit overflow at high-tick magnitudes. Confirm the two-pass decomposition is overflow-safe across the full int24 tick range.

5. **`Timelock` re-entry surface.** Compound-style timelock with `queue`/`execute`. Confirm an executed transaction can't be re-queued during execution; confirm cross-target callbacks can't drain the queue.

## 7 · Known operational hazards

Documented in `docs/LAUNCH_RUNBOOK.md` §9. Summary:

- `getMoneyPrice()` reverts before the first `oracle.update()` with non-zero time elapsed. `_updateMoneyPrice` swallows this in `allocateSeigniorage`.
- Genesis pool stake tokens must be registered before `poolStartTime`. Unregistered emission is lost.
- `buyBonds` / `redeemBonds` use strict price equality. Race window between user read and broadcast inclusion can revert.
- Bootstrap supply expansion is unconditional — even at sub-peg, the protocol mints 4.5% to Boardroom for the first 28 epochs.

## 8 · Communication

- Repo: this checkout. Tag the audit start commit before changes.
- Findings format: standard SLITHER-style severity (Critical / High / Medium / Low / Informational) with PoC where applicable. Markdown in `docs/audit-findings/` if it makes sense.
- Questions: open issues against the repo or a shared Slack channel — auditor's call.

## 9 · Pre-audit checklist (operator side)

Before signing off on handoff to the auditor:

- [ ] `forge test --profile audit --match-path "test/invariant/*"` runs to green (10000×200 fuzz)
- [ ] `forge test` runs to green (350 tests, ~25s)
- [ ] `forge test --match-path "test/integration/BaseFork*"` runs to green against live Base mainnet
- [ ] `slither src --filter-paths "lib|test" --exclude-low --exclude-informational` returns 0 medium+
- [ ] All commits since deploy are documented (`git log --oneline` between the deploy commit and now)
- [ ] No private keys committed (`.env`, `cache/`, `broadcast/` checked)
- [ ] Auditor has read access to this repo
