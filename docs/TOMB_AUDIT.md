# Tomb Audit — Old Money vs Tomb Finance, line-by-line

Systematic comparison of every claim in `docs/tomb-skill/SKILL.md` and `docs/tomb-skill/references/*` against our implementation in `contracts/src/`. Per `memory/feedback_tomb_reference_first.md`, this is the canonical pre-launch sanity check.

Classification:

- ✓ **MATCH** — our code matches Tomb's documented behavior
- ⊕ **ADDITIVE** — we have something Tomb doesn't, but Tomb's behavior is preserved (e.g., ERC20Permit on tokens)
- ⚠️ **DEVIATION** — we deliberately differ from Tomb; documented justification
- ❌ **BUG** — we differ from Tomb without justification; **must fix or document why**
- ❓ **TBD** — needs deeper verification or operator decision

Each finding cross-references `docs/GAP_AUDIT.md` where applicable.

---

## Treasury

### `initialize()` defaults

| Variable | Tomb (SKILL) | Tomb (HOW_IT_WORKED) | Our value | Status |
|---|---|---|---|---|
| `tombPriceOne` / `moneyPriceOne` | `1e18` | — | `1e18` | ✓ MATCH |
| `tombPriceCeiling` / `moneyPriceCeiling` | `1.01e18` | — | `moneyPriceOne * 101 / 100` = `1.01e18` | ✓ MATCH |
| Supply tiers (9 entries) | `0, 500K, 1M, 1.5M, 2M, 5M, 10M, 20M, 50M` ether | — | Exactly same | ✓ MATCH |
| Max expansion tiers (9 entries) | `4.50%, 4.00%, 3.50%, 3.00%, 2.50%, 2.00%, 1.50%, 1.25%, 1.00%` | — | `450, 400, 350, 300, 250, 200, 150, 125, 100` (basis-points-of-percent) | ✓ MATCH |
| `maxSupplyExpansionPercent` | (not stated) | — | `400` initial cap | ❓ verify — likely operator-set later |
| `maxSupplyContractionPercent` | `300` (3%) | — | `300` | ✓ MATCH |
| `bondDepletionFloorPercent` | `10000` (100%) | — | `10_000` | ✓ MATCH |
| `seigniorageExpansionFloorPercent` | `3500` (35%) | — | `3500` | ✓ MATCH |
| `premiumThreshold` | `110` (1.10) | — | `110` | ✓ MATCH |
| `premiumPercent` | `7000` (70%) | — | `7000` | ✓ MATCH |
| `bootstrapEpochs` | **`12`** (3 days at 6h) | **`28`** (7 days) | **`0`** | ❌ **BUG #1** — see below |
| `bootstrapSupplyExpansionPercent` | `500` (5%) | `450` (4.5%) | `450` (4.5%) | ⚠️ Matches HOW_IT_WORKED, not SKILL — likely SKILL describes init defaults, HOW_IT_WORKED describes live operator-set value. **Document choice.** |
| `maxDebtRatioPercent` | **`3500`** (35%) | `3500` (35%) | **`4500`** (45%) | ❌ **BUG #2** — see below |
| `bondSupplyExpansionPercent` | **`500`** (5%) | — | **NOT IMPLEMENTED** | ❌ **BUG #3** — see below |

### `allocateSeigniorage()` flow

| Step | Tomb | Ours | Status |
|---|---|---|---|
| 1. `oracle.update()` | ✓ | `_updateMoneyPrice()` calls it | ✓ MATCH |
| 2. Read `previousEpochPrice` | ✓ | ✓ | ✓ MATCH |
| 3. Calculate circulating supply | ✓ | `getMoneyCirculatingSupply() - seigniorageSaved` | ✓ MATCH |
| 4. **`_sendToBondTreasury(supply * bondSupplyExpansionPercent / 10000)`** | ✓ Tomb does this every epoch | **MISSING** | ❌ Part of BUG #3 |
| 5. Bootstrap branch (epoch < bootstrap): `_sendToBoardroom(supply * bootstrapPct / 10000)` | ✓ | ✓ but bootstrapEpochs=0 so branch is dead | ❌ Part of BUG #1 |
| 6. Expansion branch (price > ceiling): tier-capped mint + debt-phase split | ✓ | ✓ correct math + `_sendToBoardroom` | ✓ MATCH |
| 7. Debt-free path: full to boardroom | ✓ | ✓ | ✓ MATCH |
| 8. Debt path: 35%/65% split (with `mintingFactorForPayingDebt`) | ✓ | ✓ | ✓ MATCH |

### `buyBonds()` flow

| Step | Tomb | Ours | Status |
|---|---|---|---|
| Check `tombPrice == targetPrice` | ✓ | ✓ | ✓ MATCH |
| Check `tombPrice < tombPriceOne` | ✓ | ✓ | ✓ MATCH |
| Check `_tombAmount <= epochSupplyContractionLeft` | ✓ | ✓ | ✓ MATCH |
| Check `newBondSupply <= circulatingSupply * maxDebtRatioPercent / 10000` | ✓ | ✓ but uses 4500 not 3500 | Inherits BUG #2 |
| Burn user MONEY, mint user TRUSTNOTE | ✓ | ✓ | ✓ MATCH |
| Decrement `epochSupplyContractionLeft` | ✓ | ✓ | ✓ MATCH |

### `redeemBonds()` flow

| Step | Tomb | Ours | Status |
|---|---|---|---|
| Check `tombPrice == targetPrice` | ✓ | ✓ | ✓ MATCH |
| Check `tombPrice > tombPriceCeiling` | ✓ | ✓ | ✓ MATCH |
| Treasury has enough TOMB | ✓ | ✓ | ✓ MATCH |
| Burn user TRUSTNOTE, transfer MONEY | ✓ | ✓ | ✓ MATCH |
| Decrement `seigniorageSaved` | ✓ | ✓ via `Math.min` | ✓ MATCH |

### `checkOperator` modifier

Tomb requires Treasury is operator of: TOMB, TBOND, TSHARE, Masonry.
Ours requires Treasury is operator of: MONEY, TRUSTNOTE, ESTATE, Boardroom.
✓ MATCH.

### `_sendToBoardroom` (= Tomb's `_sendToMasonry`)

| Step | Tomb | Ours | Status |
|---|---|---|---|
| Mint amount to Treasury self | ✓ | ✓ via `IBasisAsset(money).mint(address(this), amount)` | ✓ MATCH |
| DAO fund cut | ✓ | ✓ via `daoFundSharedPercent` | ✓ MATCH |
| Dev fund cut | ✓ | ✓ via `devFundSharedPercent` | ✓ MATCH |
| Remainder to Boardroom | ✓ | ✓ via `forceApprove` + `boardroom.allocateSeigniorage()` | ✓ MATCH |

---

### 🛑 Treasury bugs/deviations needing decision

#### BUG #1 — `bootstrapEpochs = 0`

**What it does:** With `bootstrapEpochs = 0`, the bootstrap branch in `allocateSeigniorage` is dead code. The protocol immediately enters the expansion/contraction logic, requiring TWAP-driven price action to mint anything to the Boardroom.

**Tomb behavior:** Bootstrap of 12 (or 28, depending on version) epochs gives early Boardroom stakers guaranteed 4.5%-5% APY on their first interaction with the protocol — buys them in regardless of where MONEY trades vs peg. **This is load-bearing for getting ESTATE staked in Boardroom early**, which is required for the Treasury to function at all (gap #16, Boardroom-empty bricks expansion).

**Decision needed:**
- **A.** Set `bootstrapEpochs = 28` and `bootstrapSupplyExpansionPercent = 450` (Tomb-faithful per `HOW_IT_WORKED.md`). Recommended.
- **B.** Set `bootstrapEpochs = 12` per `SKILL.md` initialize defaults.
- **C.** Keep `bootstrapEpochs = 0` and document why (no recommendation — this is just a bug).

#### BUG #2 — `maxDebtRatioPercent = 4500` (45%) vs Tomb's 3500 (35%)

**What it does:** Allows more TRUSTNOTE to be issued during contraction (up to 45% of MONEY circulating supply vs Tomb's 35%).

**Risk:** A higher debt cap means the Treasury has to refill more before bondholders can redeem at peg. During sustained contraction, this means bondholders wait longer / risk Treasury insolvency. Tomb already had issues with this in 2022 bear market.

**Decision needed:**
- **A.** Set to Tomb's `3500` (35%). Recommended.
- **B.** Document why we chose 45%.

#### BUG #3 — `bondSupplyExpansionPercent` / POL bondTreasury MISSING

**What it does:** Tomb mints `5% of circulating supply` to a separate `bondTreasury` address each epoch in `_sendToBondTreasury`. This funds **Protocol-Owned Liquidity** bonds — a parallel bond mechanism distinct from the contraction-bond TRUSTNOTE flow. (Reference: `docs/tomb-skill/references/Treasury.sol.md`, `_sendToBondTreasury(amount)`.)

**Our state:** We don't implement this at all. The `Genesis` struct doesn't have a `bondTreasury` field, `_sendToBondTreasury` doesn't exist, no field for `bondSupplyExpansionPercent`.

**Decision needed:**
- **A.** Build it. Add `bondTreasury` parameter, `_sendToBondTreasury` step in `allocateSeigniorage`, `bondSupplyExpansionPercent = 500` default. Real new contract surface (the POL bond treasury itself). Multi-turn work.
- **B.** Document as a deliberate Tomb deviation. Old Money's peg defense uses only the contraction-bond + (Sprint 4b hook tax) mechanism, no POL bonds.

This is a strategic call. POL bonds (à la Olympus) accumulate protocol-controlled liquidity over time and can be used to backstop the peg from a separate reserve. They're a real defensive lever. Recommend **A** if we want full Tomb-fidelity + maximum peg defense.

---

## Boardroom (was Masonry)

### Defaults

| Variable | Tomb | Ours | Status |
|---|---|---|---|
| `withdrawLockupEpochs` | `6` | `6` | ✓ MATCH |
| `rewardLockupEpochs` | `3` | `3` | ✓ MATCH |
| Genesis snapshot pushed in init | ✓ | (verify) | ❓ TBD |

### Mechanics

| Behavior | Tomb | Ours | Status |
|---|---|---|---|
| Any interaction (stake/withdraw/claimReward) resets `epochTimerStart` | ✓ | ✓ | ✓ MATCH |
| `allocateSeigniorage` is operator-only | ✓ | ✓ via `onlyOperator` | ✓ MATCH |
| `allocateSeigniorage` reverts if `totalSupply() == 0` | ✓ — and this is load-bearing for gap #16 | ✓ via `CannotAllocateWhenTotalSupplyZero` | ✓ MATCH |
| Snapshot-based cumulative rewardPerShare | ✓ | ✓ via `boardroomHistory` array | ✓ MATCH |
| `earned` = `balance * (latestRPS - storedRPS) / 1e18 + rewardEarned` | ✓ | (verify) | ❓ TBD |
| `claimReward` requires `epochTimerStart + rewardLockupEpochs <= epoch()` | ✓ | ✓ | ✓ MATCH |
| `withdraw` requires `epochTimerStart + withdrawLockupEpochs <= epoch()` | ✓ | ✓ | ✓ MATCH |

**No bugs found in Boardroom so far. Continue audit on full file in next pass.**

---

## $MONEY (was TOMB)

❓ TBD — audit pending. Quick check items:

- [ ] `mint() returns (bool)` matches Tomb's interface
- [ ] `burn` / `burnFrom` permissioning matches Tomb
- [ ] `distributeReward(genesisPool, mainPool, airdropWallet)` one-shot, mints 11k/140k/9k
- [ ] Constructor mints 1 unit to deployer (for initial LP seeding)
- [ ] **Transfer-tax** mechanism: documented deviation (moved to V4 hook). Gap #3 in `GAP_AUDIT.md`.

## $ESTATE (was TSHARE)

❓ TBD — audit pending. Quick check items:

- [ ] Hard cap: 70k total = 59.5k + 5.5k + 5k
- [ ] Vesting linear over 365 days
- [ ] `claimRewards()` permissionless
- [ ] Constructor mints 1 unit to deployer
- [ ] Trustees can mint (used by ShareRewardPool — though our share pool is pre-funded, so the mint() path is rarely invoked)
- [ ] **Quirk:** `setTreasuryFund` / `setDevFund` rotation gated to **devFund**, not operator. Confirm preserved.

## $TRUSTNOTE (was TBOND)

❓ TBD — audit pending. Quick check items:

- [ ] No hard cap
- [ ] mint/burn by Treasury only
- [ ] No transfer tax
- [ ] No `distributeReward` (bonds are minted on demand during contraction)

## Oracle

❓ TBD — audit pending. Key check:

- [ ] `consult(token, amount)` returns price as `uint144` (per Tomb's interface) or compatible
- [ ] `twap` and `update` match Tomb interface signatures
- [ ] Period-windowed update (call only after `nextEpochPoint`)
- ⚠️ **Known deviation:** Tomb reads V2 pair cumulatives via `currentCumulativePrices`. We read V4 tick cumulatives via `PegDefenseHook` as `IPriceSource`. Same TWAP shape, different source.

## GenesisRewardPool

❓ TBD — audit pending. Key check:

- [ ] `TOTAL_REWARDS = 11_000 ether` ✓ (verified earlier)
- [ ] `RUNNING_TIME = 1 days` ✓ (verified earlier)
- [ ] Accepts arbitrary outside ERC-20 stake tokens (operator `.add()` decides)
- [ ] `governanceRecoverUnsupported` protects MONEY + every staked LP for 90 days post-end

## MainRewardPool

❓ TBD — audit pending. Key check:

- [ ] `TOTAL_REWARDS = 140_000 ether`
- [ ] Two epochs: 80k over 4 days + 60k over 5 days = 9 days total
- [ ] Multi-epoch `getGeneratedReward` math

## ShareRewardPool

❓ TBD — audit pending. Key check:

- [ ] `TOTAL_REWARDS = 59_500 ether`
- [ ] `RUNNING_TIME = 370 days`
- ⚠️ **Potential gap #17:** Tomb's TShareRewardPool had TWO pools (TOMB-FTM LP 60%, TSHARE-FTM LP 40%). Our `ShareRewardPool` supports multiple pools via `add()`, but to be Tomb-faithful we'd need a second V4 pool (ESTATE/cbETH or ESTATE/WETH) and its own LP wrapper. **Operator decision: do we ship with both pools, or just MONEY/WETH LP initially?**

## PegDefenseHook (replaces TaxOffice)

⚠️ **Known deviation, documented in gap #3:**

- Tomb's TaxOffice applied a transfer-tax on ALL `transferFrom` of TOMB, with the rate dynamically chosen from a 14-tier price table.
- Tax was BURNED if `price < 1.10 FTM` (premiumThreshold) — load-bearing deflationary lever
- Tax went to `taxCollectorAddress` if `price >= 1.10 FTM`
- `transfer()` calls (no `From`) were not taxed
- Excluded addresses (LPs, contracts) paid no tax

Our `PegDefenseHook`:
- Only applies on V4 pool swaps (not all transfers — narrower scope)
- Returns a dynamic LP fee — higher cost discourages selling
- **No MONEY burned. No revenue to Treasury.** All proceeds go to LPs.

**Decision needed (gap #3):**
- **A.** Accept the softening, document in `HOOKS.md`, ship.
- **B.** Build Sprint 4b — extend the hook with `beforeSwapReturnDelta` to take a slice of swap input as MONEY, burn it (matches Tomb's burn-during-deep-contraction), or route to Treasury (matches Tomb's tax-collector flow). **Recommended** for production safety; restores Tomb's strongest peg-defense lever.

---

## Distributor / Timelock / Hook permissions

❓ TBD — audit pending in next pass.

---

## Summary of decisions needed (so far)

| # | Topic | Recommendation | Cost |
|---|---|---|---|
| BUG #1 | `bootstrapEpochs = 0` | Set to `28` per HOW_IT_WORKED | 1 line + redeploy |
| BUG #2 | `maxDebtRatioPercent = 4500` | Set to `3500` per Tomb | 1 line + redeploy |
| BUG #3 | POL `bondTreasury` missing | Decide: build it (Tomb-fidelity) or document deviation | Build = multi-turn; document = 1 doc commit |
| Gap #3 | Hook tax not burning / routing | Build Sprint 4b (`beforeSwapReturnDelta`) | Multi-turn |
| Gap #17 | Share pool double-LP (MONEY-WETH + ESTATE-WETH) | Need operator decision: ship with one pool or both | Build second wrapper + V4 pool if both |
| Peg | cbETH → WETH | Decided (proceed) | 1-2 turns |
| Token audit | Money / Estate / TrustNote vs Tomb | Continue audit | 1 turn |
| Oracle / reward pools / Timelock audit | Continue audit | 1 turn each |

---

## Next steps

1. Continue audit: tokens (Money, Estate, TrustNote), Oracle, reward pools (full), Timelock, Distributor — one focused turn for each.
2. After audit complete, surface ALL decisions to user.
3. User picks A or B for each.
4. THEN execute: code changes + WETH migration + redeploy in one consolidated sprint.
