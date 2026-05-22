# Tomb Finance — How It Worked From Genesis

Step-by-step operational walkthrough authored by brandon (via another Claude conversation) on 2026-05-22. Treat this as the **operational complement** to `SKILL.md` — `SKILL.md` covers contract internals, this covers how the protocol actually ran from deployment forward.

---

## Pre-Launch: Deployment Sequence

Before anything went live, the team deployed the contracts in a specific order because each one needs the others' addresses.

1. Deploy TOMB with an initial tax rate and tax collector address → mints 1 TOMB to deployer (needed to seed the first liquidity pool)
2. Deploy TSHARE with start time, community fund, dev fund addresses → mints 1 TSHARE to deployer
3. Deploy TBOND → empty, no supply
4. Deploy Masonry → initialize with TOMB, TSHARE, Treasury addresses; sets 6-epoch withdraw lockup, 3-epoch reward lockup
5. Deploy Oracle pointing at the TOMB/WFTM SpookySwap pair
6. Deploy Treasury → `initialize()` wires everything together and sets all the default parameters
7. **Treasury takes operator role over TOMB, TBOND, TSHARE, and Masonry** — this is the `checkOperator` requirement; nothing works until this is done
8. Deploy `TombGenesisRewardPool`, `TombRewardPool`, `TShareRewardPool`
9. `TOMB.distributeReward(genesisPool, tombPool, airdropWallet)` — callable once, mints the initial supply:
   - 11,000 TOMB → Genesis Pool
   - 140,000 TOMB → TOMB-WFTM LP Pool
   - 9,000 TOMB → airdrop wallet
10. `TSHARE.distributeReward(tshareRewardPool)` — callable once, mints 59,500 TSHARE into the farming pool

**The deployer used that 1 TOMB + 1 TSHARE to seed initial liquidity on SpookySwap so the Oracle had reserves to read from** (`reserve0 != 0 && reserve1 != 0` is enforced in the Oracle constructor).

> **Old Money mapping:** Our `Deploy.s.sol` covers steps 1-10. The deployer's 1 MONEY + 1 ESTATE from constructor seeds — plus the airdrop wallet's 9k MONEY allocation — should be used as the initial V4 pool liquidity (gap #2 in `GAP_AUDIT.md`).

---

## Hour 0–24: Genesis Pool

The `TombGenesisRewardPool` ran for exactly 24 hours. It accepted **single-asset deposits (not LP)** — things like DAI, USDC, wBTC, ETH — and distributed 11,000 TOMB at a flat rate across all pools weighted by allocPoint.

This was the "free money" phase. You deposited stablecoins or blue chips, you got TOMB. No peg mechanism running yet, no epochs ticking. **This bootstrapped TOMB holders who would go on to provide liquidity.**

The Oracle was NOT yet the source of truth for price — TOMB was being traded freely on SpookySwap and the TWAP was just accumulating.

> **Old Money mapping:** Our `GenesisRewardPool` accepts the same model — outside ERC-20 tokens (cbETH on mainnet, MockCbeth on testnet, optionally USDC). This was the gap-#1 clarification — the genesis pool is NOT blocked on an LP wrapper.

---

## Days 2–5: TOMB-WFTM LP Pool Starts

Once genesis ended, the `TombRewardPool` kicked in. This distributed 140,000 TOMB to people who provided TOMB/WFTM liquidity on SpookySwap. **This was the incentive to build the liquidity the protocol needed for the Oracle to function well.**

At the same time, the `TShareRewardPool` was live, distributing 59,500 TSHARE over 370 days (~0.00186 TSHARE/second) to LP stakers — originally TOMB/FTM and TSHARE/FTM pairs.

> **Old Money mapping:** Our `MainRewardPool` is the analog (140k MONEY, 9-day window with two epochs at 80k/60k split — slightly different shape than Tomb's flat 140k). Our `ShareRewardPool` is the analog (59.5k ESTATE, 370 days). **TShareRewardPool had TWO pools** (Pool 0 TOMB-FTM 60%, Pool 1 TSHARE-FTM 40%) — if we want full Tomb-fidelity we need to support both MONEY/cbETH LP AND ESTATE/cbETH LP, which requires a second V4 pool and a second wrapper. **Flagging as gap #17.**

---

## The Epoch Clock Starts: Treasury Goes Live

Once `startTime` was reached, the Treasury epoch clock began. Every 6 hours = 1 epoch.

Anyone could call `allocateSeigniorage()` after the 6-hour window elapsed — **there was no keeper bot requirement**, though in practice the team or community members did it. Calling it:

1. Triggers `checkEpoch` modifier — increments epoch counter, resets `epochSupplyContractionLeft`
2. Calls `oracle.update()` to snapshot the latest TWAP
3. Reads `previousEpochTombPrice` from the oracle
4. Decides what to do

---

## Epochs 0–27: Bootstrap Period (First 7 Days)

The first **28 epochs** (7 days) ran in "bootstrap mode." Regardless of what TOMB's price was doing, the Treasury always minted and sent seigniorage to the Masonry at a flat **4.5% of circulating supply per epoch**.

This meant:
- Masonry stakers (TSHARE stakers) got paid even if TOMB was below peg
- It gave early TSHARE stakers a strong guaranteed return to incentivize staking
- It helped build Masonry TVL before the real mechanism engaged

The circulating supply calculation during this phase excluded the balances sitting in the reward pools (Genesis, old and new TOMB pools), so the 4.5% was applied only to TOMB actually in circulation.

> **Discrepancy to verify:** This walkthrough says 28 epochs at 4.5%. `SKILL.md` says `bootstrapEpochs = 12` and `bootstrapSupplyExpansionPercent = 500` (5%). These can't both describe the same protocol. Likely the walkthrough describes the **live deployed defaults after operator-set overrides**, while `SKILL.md` describes the `initialize()` defaults. Our Treasury currently has `bootstrapEpochs = 28` (verify) and `bootstrapSupplyExpansionPercent = 450` (verified, line 312). Operator can update via `setBootstrap()`.

---

## Post-Bootstrap: The Real Mechanism

After epoch 27, the full algorithmic system engaged. Every 6 hours, one of three scenarios played out:

### Scenario A: TOMB > 1.01 FTM (Expansion)

The protocol minted new TOMB and distributed it. The expansion percentage was:

```
percentage = min(tombPrice - 1.0, maxExpansionForCurrentTier)
```

So if TOMB was at 1.05 FTM, percentage = 0.05 — but then capped by the supply tier. For example at 800k circulating supply, the cap was 4.0%, so expansion would be 4.0% not 5%.

Then the critical split happened based on whether the Treasury had saved enough to cover all outstanding TBOND:

**Case 1 — Treasury reserve ≥ total TBOND supply (debt fully covered):**
All expansion goes to the Masonry. TSHARE stakers collect 100% of new TOMB.

**Case 2 — Treasury reserve < total TBOND supply (debt not yet covered):**
- 35% of expansion → Masonry (the `seigniorageExpansionFloorPercent`)
- 65% → saved in Treasury reserve (minted to the contract itself) — potentially multiplied by `mintingFactorForPayingDebt` if set, to accelerate debt repayment

In either case, **before TOMB reached Masonry stakers, the DAO and Dev fund cuts were taken**:
- `daoFundSharedPercent` of the Masonry allocation → DAO fund
- `devFundSharedPercent` → Dev fund
- Remainder → `Masonry.allocateSeigniorage()`

When `allocateSeigniorage(amount)` was called on the Masonry, it pushed a new snapshot:
```
nextRPS = prevRPS + (amount * 1e18 / totalTSHAREStaked)
```

Each TSHARE staker's pending rewards = `staked * (latestRPS - theirStoredRPS) / 1e18`.

### Scenario B: TOMB < 1.00 FTM (Contraction — Bond Phase)

No seigniorage was minted. Instead, the protocol offered users a deal: burn your TOMB, get TBOND.

The `epochSupplyContractionLeft` limited how much TOMB could be burned per epoch:
```
epochSupplyContractionLeft = circulatingSupply * 3% (maxSupplyContractionPercent)
```

To buy bonds, a user called `buyBonds(tombAmount, targetPrice)`:
- They had to pass the current oracle price as `targetPrice` — if the price moved between their tx and execution, it reverted. This prevented sandwich attacks.
- Their TOMB was **burned (permanently destroyed)**
- They received TBOND at the discount rate

By default there was **no discount** (`discountPercent = 0`), so it was 1:1 — burn 1 TOMB, get 1 TBOND. If `discountPercent` was set, users got slightly more TBOND per TOMB burned, making it more attractive to participate.

There was also a hard ceiling: new TBOND supply couldn't exceed 35% of circulating TOMB supply (`maxDebtRatioPercent`). Once that cap was hit, no more bonds could be purchased that epoch.

> **Discrepancy to verify:** Our Treasury has `maxDebtRatioPercent = 4500` (45%), not Tomb's 3500 (35%). Need to confirm whether this was a deliberate divergence or a typo. Either fix or document the reason.

### Scenario C: 1.00 ≤ TOMB ≤ 1.01 FTM (Dead Zone)

Nothing happened. Price was at or just above peg but below the ceiling. No expansion, no contraction. The epoch would tick over but `allocateSeigniorage()` would execute and do nothing.

---

## Redeeming TBonds (TBOND → TOMB)

Once TOMB was back above 1.01 FTM, TBOND holders could redeem via `redeemBonds(bondAmount, targetPrice)`:

- Same slippage protection — must pass current price
- **If price ≥ 1.10 FTM (`premiumThreshold`):**
  ```
  rate = 1.0 + (price - 1.0) * 70% (premiumPercent)
  ```
  So at 1.20 FTM: rate = 1.0 + 0.20 * 0.70 = 1.14 → redeem 1 TBOND, get 1.14 TOMB
- **If 1.01 < price < 1.10:** No premium — 1 TBOND = 1 TOMB
- Premium capped at `maxPremiumRate` if set

The TOMB paid out came from the **Treasury's reserve balance** (`seigniorageSaved`), not freshly minted. This meant the Treasury had to actually accumulate TOMB from the 65% "saved for bond" allocations during expansion before bonds could be fully redeemed. If the Treasury ran dry, redemption halted until the next expansion epoch refilled it.

---

## Masonry Lifecycle (TSHARE Staking)

Throughout all of the above, TSHARE stakers were the passive beneficiaries — they sat in the Masonry and collected TOMB whenever epochs expanded.

- **To stake:** Call `stake(amount)` — resets your `epochTimerStart` to current epoch.
- **To claim rewards:** Call `claimReward()` — requires you've been staked for at least 3 epochs (18 hours). Resets your timer.
- **To unstake:** Call `withdraw(amount)` — requires 6 epochs (36 hours) since last stake or claim. Automatically claims pending rewards first.

The lockup meant if you staked right before an epoch and the price dumped, you were stuck for 18–36 hours. **This was intentional** — it prevented a hit-and-run dynamic where people staked just to collect one epoch's rewards then dumped.

The reward calculation used a global `rewardPerShare` that accumulated over all snapshots. When you staked later than epoch 0, you only earned from the snapshot at your entry point forward — you didn't get back-dated rewards.

---

## TOMB Transfer Tax in Practice ⚠️ CRITICAL

Whenever TOMB moved via `transferFrom` (i.e. through a DEX, a contract interaction, etc.):

1. **Oracle was consulted for current TWAP**
2. **Tax tier was looked up from the table** (20% at deep below-peg, 1% at strong above-peg)
3. **If price < 1.10 FTM → tax was BURNED** (deflationary pressure when near/below peg)
4. **If price ≥ 1.10 FTM → tax went to `taxCollectorAddress`**
5. Excluded addresses (contracts, LPs, etc.) paid no tax

This created a self-reinforcing effect: **the further below peg TOMB traded, the higher the tax, and the more was burned on every transaction — adding buy pressure mechanically on every transfer.**

Direct `transfer()` calls (e.g. sending TOMB wallet-to-wallet) were **not taxed** — only `transferFrom`.

> **THIS IS GAP #3 IN PROPER DETAIL.** Our `PegDefenseHook` only raises the LP fee during contraction. It does NOT burn MONEY, and the deterrent only applies to V4 swaps, not other transfers. Tomb's tax was a load-bearing deflationary lever in the peg-defense mechanism — the further below peg, the harder it pulled supply down. Our hook softens this materially. **Strong argument for building Sprint 4b (`beforeSwapReturnDelta` tax routing).**

---

## TSHARE Emission (Farming Pools)

In parallel to all the above, the `TShareRewardPool` was continuously emitting TSHARE at 0.00186 TSHARE/second to LP stakers (TOMB/FTM and TSHARE/FTM pools). This ran for 370 days regardless of the peg status.

The Community Fund and Dev Fund were also continuously vesting TSHARE — anyone could call `claimRewards()` on the TShare contract at any time to release the pending vested portion to those addresses.

---

## The Full Flywheel (When Working)

```
TOMB price > 1.01 FTM
      ↓
Treasury mints new TOMB each epoch
      ↓
TSHARE stakers in Masonry earn TOMB → sell some TOMB
      ↓
Selling pressure brings price back toward 1.0 FTM
      ↓
As it falls, tax rate rises (more burns) → slows descent

TOMB price < 1.00 FTM
      ↓
Contraction: users burn TOMB for TBOND (supply shrinks)
      ↓
Transfer tax burns even more on every trade
      ↓
Reduced supply → price recovers toward 1.0 FTM
      ↓
Once > 1.01 FTM, TBOND holders redeem (sell pressure)
      ↓
But premium incentive kept holders waiting for > 1.10 FTM
```

The system worked well when FTM itself was rising — since the peg was to FTM (not USD), a rising FTM meant TOMB was also rising in USD terms, which attracted new buyers and kept TOMB above peg organically.

When FTM's price crashed in 2022, the peg target was falling in USD terms, liquidity dried up, and the bond mechanism couldn't burn supply fast enough to compensate. The 35% debt-coverage split also meant that during sustained downturns, the Treasury never refilled enough to make TBOND redemption attractive, **trapping late buyers**.

> **Lesson for Old Money:** cbETH-pegged means we inherit ETH/cbETH dynamics. If cbETH crashes, MONEY crashes with it (in USD terms). Our peg defense (especially Sprint 4b — restoring the burn-during-contraction lever) is the protocol's only safety against this. **Without that, we have less defense than Tomb did in their bear market.**
