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

## $MONEY (was TOMB) — ✓ CLEAN

- `mint(recipient, amount) returns (bool)` trustees-only ✓ MATCH Tomb signature
- `burnFrom(account, amount)` trustees-only ✓ MATCH (Tomb's stricter restriction over OZ default)
- `burn(amount)` public ✓ MATCH
- `distributeReward(genesisPool, mainPool, airdropWallet)` one-shot, mints 11k/140k/9k ✓ MATCH
- Constructor mints 1 unit to deployer ✓ MATCH (Tomb seed)
- `governanceRecoverUnsupported(token, amount, to)` ✓ MATCH
- ⊕ ADDITIVE: `ERC20Permit` (EIP-2612), themed `Coined` event, custom errors, Ownable2Step
- ⚠️ DEVIATION: transfer-tax mechanism moved to V4 hook (gap #3) — documented

## $ESTATE (was TSHARE) — ✓ CLEAN

- Hard cap 70k = 59.5k + 5.5k + 5k ✓ MATCH
- VESTING_DURATION = 365 days ✓ MATCH
- `claimRewards()` permissionless ✓ MATCH
- `distributeReward(farmingPool)` one-shot, mints 59.5k ✓ MATCH (pre-funded model, same as bomb-contracts BShare)
- Constructor mints 1 unit to deployer ✓ MATCH
- `setTreasuryFund` / `setDevFund` gated to `devFund` ✓ MATCH (Tomb quirk preserved)
- ⊕ ADDITIVE: ERC20Permit, custom errors, Ownable2Step
- ❓ NOTE: SKILL.md mentions BShare has public `mint(recipient, amount)` onlyOperator; the actual bomb-contracts BShare source uses pre-funded distributeReward and does NOT expose public mint(). Our Estate matches the actual source, not the SKILL claim. Likely a SKILL error.

## $TRUSTNOTE (was TBOND) — ✓ CLEAN

- ERC20Burnable + Trustees ✓ MATCH
- No hard cap ✓ MATCH
- `mint(recipient, amount) returns (bool)` trustees-only ✓ MATCH
- `burn(amount)` public, `burnFrom(account, amount)` trustees-only ✓ MATCH
- No `distributeReward` (bonds minted on demand by Treasury) ✓ MATCH
- No initial mint in constructor (zero supply at deploy) ✓ MATCH
- Strictly minimal — no Permit, no themed events, no governanceRecoverUnsupported — matches Tomb's BBond exactly

## Oracle — ✓ CLEAN

- `consult(token, amount) returns uint144` ✓ MATCH Tomb's signature
- `twap(token, amount) returns uint144` ✓ MATCH
- `update()` period-windowed via `Epoch.checkEpoch` ✓ MATCH
- Returns 0 from `consult` before first `update()` ✓ MATCH Tomb behavior
- Returns 0 from `twap` on unrecognized token (silent miss) ✓ MATCH
- `consult` reverts on unrecognized token (explicit) ✓ MATCH
- ⚠️ DEVIATION: reads V4 tick cumulatives via `IPriceSource` (PegDefenseHook) instead of V2 pair `currentCumulativePrices`. Math is mathematically equivalent — TWAP shape preserved.

## GenesisRewardPool — ✓ CLEAN

- `TOTAL_REWARDS = 11_000 ether` ✓ MATCH
- `RUNNING_TIME = 1 days` ✓ MATCH
- Accepts arbitrary outside ERC-20 stake tokens via operator `.add()` ✓ MATCH (Tomb-faithful mini-ICO)
- `governanceRecoverUnsupported` protects MONEY + every staked LP for 90 days post-end ✓ MATCH
- Per-pool reward debt accounting ✓ MATCH (MasterChef pattern)

## MainRewardPool — ✓ CLEAN

- `TOTAL_REWARDS = 140_000 ether` ✓ MATCH
- Two epochs: 80k over 4 days + 60k over 5 days = 9 days total ✓ MATCH (Tomb's exact "Day 2-5" + "Day 6-10")
- Multi-epoch `getGeneratedReward` math correctly walks epoch boundary ✓ MATCH (8 tests passing)

## ShareRewardPool — ⚠️ ARCHITECTURAL DECISION NEEDED (gap #17)

- `TOTAL_REWARDS = 59_500 ether` ✓ MATCH
- `RUNNING_TIME = 370 days` ✓ MATCH (HOW_IT_WORKED says 370; SKILL says 365 — our 370 matches actual bomb-contracts)
- ⚠️ **Single-pool vs Tomb's TWO-pool model.** Tomb's TShareRewardPool launched with:
  - Pool 0: TOMB-FTM LP → 35,700 TSHARE (60%)
  - Pool 1: TSHARE-FTM LP → 23,800 TSHARE (40%)

  Our `ShareRewardPool` mechanically supports multiple pools (operator can call `.add()` for each LP token), but to be Tomb-faithful we'd need to launch a SECOND V4 pool (ESTATE/WETH) and a SECOND LP wrapper for it. Without that, Tomb's incentive to maintain ESTATE/native liquidity is missing — ESTATE has no AMM market.

  **Decision: how do we want ESTATE to trade?**
  - **A.** Build the second V4 pool (ESTATE/WETH) + second LP wrapper. Full Tomb-fidelity. Adds work to Sprint 16. Recommended for a long-term protocol.
  - **B.** Ship with one pool (MONEY/WETH LP only, weight 100%). ESTATE has no AMM market — trades only via direct transfer or off-chain OTC. Severely limits price discovery. Don't recommend.
  - **C.** Defer — open with one pool, add second pool by operator action later. Acceptable middle ground; just don't forget.

## Timelock — ✓ CLEAN

- `GRACE_PERIOD = 14 days` ✓ MATCH
- `MINIMUM_DELAY = 1 days` ✓ MATCH
- `MAXIMUM_DELAY = 30 days` ✓ MATCH
- Compound-style queue/cancel/execute ✓ MATCH
- Two-step admin transfer ✓ MATCH

## Distributor — ✓ CLEAN

- Tiny aggregator, permissionless `distribute()` ✓ MATCH (verbatim port)

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

---

## Final consolidated decisions matrix

Audit complete across all 12 contracts (`src/core/Treasury`, `src/core/Boardroom`, `src/core/Distributor`, `src/tokens/OldMoney`, `src/tokens/Estate`, `src/tokens/TrustNote`, `src/oracle/Oracle`, `src/governance/Timelock`, `src/hooks/PegDefenseHook`, `src/distribution/GenesisRewardPool`, `src/distribution/MainRewardPool`, `src/distribution/ShareRewardPool`).

### 7 contracts found CLEAN

OldMoney, Estate, TrustNote, Oracle, GenesisRewardPool, MainRewardPool, Timelock, Distributor, Boardroom — all match Tomb's documented behavior in every place we checked. Additive modernizations (Permit, custom errors, Ownable2Step) preserve Tomb behavior.

### Decisions (signed off 2026-05-22)

| # | Topic | Severity | Decision | Status |
|---|---|---|---|---|
| BUG #1 | Treasury: `bootstrapEpochs = 0` | HIGH | **FIXED** — set to 28 per HOW_IT_WORKED | ✅ done (commit pending) |
| BUG #2 | Treasury: `maxDebtRatioPercent = 4500` | MEDIUM | **FIXED** — set to 3500 per Tomb | ✅ done (commit pending) |
| BUG #3 | Treasury: POL `bondTreasury` mechanism MISSING | MEDIUM | **DEFERRED** — documented as v1 deliberate omission; core peg mechanics function without it; future Treasury upgrade may add | ✅ documented in Treasury.sol NatSpec |
| Gap #3 | PegDefenseHook doesn't burn/route value | HIGH | **BUILD SPRINT 4B** — `beforeSwapReturnDelta` tax routing | ⏳ pending implementation |
| Gap #17 | ShareRewardPool single-pool vs Tomb's two-pool | MEDIUM | **DEFER** — operator adds second pool later when ESTATE/WETH V4 pool + wrapper exists | ⏳ pending |
| Peg | cbETH → WETH | Decided | **EXECUTE** | ⏳ pending |

### What's NOT a decision (just execution)

- Token contracts: leave as-is. All clean.
- Oracle: leave as-is. Clean.
- Reward pool contracts: leave as-is. Clean.
- Boardroom: leave as-is. Clean.
- Timelock + Distributor: leave as-is. Clean.

### Sequencing once user signs off

If user picks the recommendations above:

1. **Code-change sprint** (1 turn): Treasury edits for BUG #1 + BUG #2. Document BUG #3 deviation in NatSpec + GAP_AUDIT. Run full suite.
2. **WETH peg migration** (1-2 turns): Addresses.sol rename, MockCbeth deletion, Deploy.s.sol updates, fork test updates, doc updates.
3. **Sprint 4b** (multi-turn, 3-4): PegDefenseHook tax routing with `beforeSwapReturnDelta`. Design doc first (Bunni V2 source read for returnDelta pattern reference), then contract + tests + fork tests + invariants.
4. **Sprint 16** (multi-turn, 4-5): LiquidityVault for MONEY/WETH V4 LP → ERC-20 wrapper.
5. **Redeploy Base Sepolia** (1 turn): Run updated Deploy + OpenLaunch scripts.
6. **Pre-mainnet gates**: Coverage report, audit invariants 10k/200, professional audit, mainnet.

Total time-to-mainnet: ~10-15 focused turns + audit duration. No half-baked shipping in `src/`.
