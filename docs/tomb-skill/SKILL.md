---
name: tomb-finance
description: >
  Deep technical knowledge of Tomb Finance's smart contract architecture, mechanics, and three-token
  system (TOMB, TSHARE, TBOND) on Fantom Opera. Use this skill whenever the user asks about how
  Tomb Finance works, wants to understand its contracts, asks about forking/cloning Tomb, needs help
  with algorithmic stablecoin mechanics (seigniorage, bond mechanics, expansion/contraction), or asks
  about any Tomb fork (2omb, 3omb, GrapeFinance, etc.). Also trigger for questions about Masonry
  staking, TWAP oracles, debt phase, bootstrap phase, TShareRewardPool, or any protocol-level Tomb
  mechanics.
---

# Tomb Finance — Complete Contract Reference

## Contract Addresses (Fantom Opera Mainnet)

| Contract | Address |
|---|---|
| TOMB token | `0x6c021Ae822BEa943b2E66552bDe1D2696a53fbB7` |
| TSHARE token | `0x4cdF39285D7Ca8eB3f090fDA0C069ba5F4145B37` |
| TBOND token | `0x24248CD1747348bDC971a5395f4b3cd7feE94ea0` |
| Treasury | `0xF50c6dAAAEC271B56FCddFBC38F0b56cA45E6f0d` |
| Masonry | `0x8764DE60236C5843D9faEB1B638fbCE962773B67` |
| Oracle | `0x55530fA1B042582D5FA3C313a7e02d21Af6B82f4` |
| TombGenesisRewardPool | `0x9A896d3c54D7e45B558BD5fFf26bF1E8C031F93b` |
| TombRewardPool | `0xa7b9123f4b15fE0fF01F469ff5Eab2b41296dC0E` |
| TShareRewardPool | `0xcc0a87F7e7c693042a9Cc703661F5060c80ACb43` |

Solidity version: `0.6.12`. All contracts are MIT-licensed.

---

## Architecture Overview

Tomb Finance is a three-token seigniorage system modeled after Basis Cash, forked from bDollar/soup. Unlike pure USD-pegged algostables, TOMB targets a **1:1 peg to FTM** (Fantom's native token).

```
TOMB   ← algorithmic token pegged to FTM
TSHARE ← governance/share token; earns TOMB emissions in Masonry
TBOND  ← bond token; burned/minted to defend the peg (below-peg only)
```

The four core contracts: **Treasury**, **Masonry**, **Oracle**, and the **Reward Pools**.

---

## 1. TOMB Token

Standard `ERC20Burnable` + `Operator` pattern. Key properties:
- The **Treasury** is set as its operator, giving Treasury the right to `mint()` and `burnFrom()`.
- No hard cap; supply is algorithmically expanded/contracted by Treasury.
- Transfer tax mechanism via `TaxOfficeV2` (separate contract, not always active).

---

## 2. TSHARE Token

- Hard cap: **70,000 TSHARE** total.
- Allocations:
  - `FARMING_POOL_REWARD_ALLOCATION = 59,500` (distributed via TShareRewardPool over 365 days)
  - `COMMUNITY_FUND_POOL_ALLOCATION = 5,500` (vested linearly over 365 days)
  - `DEV_FUND_POOL_ALLOCATION = 5,000` (vested linearly over 365 days)
- Community and dev fund amounts accrue at a per-second rate and can be `claimRewards()` any time.
- TSHARE is **not minted by Treasury**; it is pre-allocated and distributed through the farming pool.

---

## 3. TBOND Token

- Standard `ERC20Burnable` + `Operator`. Treasury is operator.
- No hard supply cap; bonds are minted on demand during contraction.
- Treasury calls `mint()` when users buy bonds and `burnFrom()` when they redeem.
- Key constraint: total TBOND supply cannot exceed `maxDebtRatioPercent` (35%) of TOMB circulating supply.

---

## 4. Treasury Contract (Core Logic)

Read the full Treasury source in `references/Treasury.sol.md` for code-level detail.

### Constants
```
PERIOD = 6 hours   // one epoch
```

### Key State Variables

| Variable | Default Value | Meaning |
|---|---|---|
| `tombPriceOne` | 1e18 | The peg target (1 FTM in wei) |
| `tombPriceCeiling` | 1.01e18 | Above this → expansion phase |
| `bootstrapEpochs` | 12 | First 12 epochs always expand at bootstrap rate |
| `bootstrapSupplyExpansionPercent` | 500 (5%) | Expansion rate during bootstrap |
| `maxSupplyContractionPercent` | 300 (3%) | Max TOMB burnable per epoch for bonds |
| `maxDebtRatioPercent` | 3500 (35%) | Max TBOND supply as % of TOMB circulating supply |
| `seigniorageExpansionFloorPercent` | 3500 (35%) | Min % of seigniorage to Masonry during debt phase |
| `bondDepletionFloorPercent` | 10000 (100%) | Treasury must hold ≥ full bond supply before normal expansion |
| `premiumThreshold` | 110 | TOMB price must be > 1.10 FTM for premium redemption bonus |
| `premiumPercent` | 7000 (70%) | Bonus multiplier applied to price premium for bond redeem rate |
| `daoFundSharedPercent` | ~2000 (20%) | % of Masonry emissions routed to DAO fund |
| `devFundSharedPercent` | ~1000 (10%) | % of Masonry emissions routed to dev fund |
| `bondSupplyExpansionPercent` | 500 (5%) | Max % of circulating supply minted to bondTreasury per epoch |

### Supply Expansion Tiers

Treasury uses a dynamic expansion rate based on TOMB circulating supply:

| Supply Tier (TOMB) | Max Expansion % |
|---|---|
| 0 – 500K | 4.50% |
| 500K – 1M | 4.00% |
| 1M – 1.5M | 3.50% |
| 1.5M – 2M | 3.00% |
| 2M – 5M | 2.50% |
| 5M – 10M | 2.00% |
| 10M – 20M | 1.50% |
| 20M – 50M | 1.25% |
| 50M+ | 1.00% |

### `allocateSeigniorage()` — The Epoch Heartbeat

Called once per epoch (every 6 hours). Anyone can call it once the epoch timer is up.

**Flow:**
1. Updates the TWAP oracle.
2. Saves `previousEpochTombPrice` from oracle.
3. Calculates circulating supply: `totalSupply - seigniorageSaved - excludedAddresses`.
4. Sends `bondSupplyExpansionPercent` (5%) of supply to the `bondTreasury` (POL bonds).
5. **Bootstrap phase** (epoch < 12): mints 5% of circulating supply and sends to Masonry unconditionally.
6. **Normal phase** (epoch ≥ 12):
   - If `previousEpochTombPrice > tombPriceCeiling` (above peg):
     - Compute `_percentage = price - 1e18` (the deviation above peg).
     - Cap `_percentage` at `maxSupplyExpansionPercent * 1e14` from the supply tier table.
     - **Debt-free path** (treasury holds enough for all outstanding bonds): all seigniorage → Masonry.
     - **Debt phase** (treasury underfunded): split seigniorage:
       - 35% → Masonry (`seigniorageExpansionFloorPercent`)
       - 65% → Treasury reserve (`seigniorageSaved`), optionally multiplied by `mintingFactorForPayingDebt`
   - If price ≤ ceiling: no expansion, no TOMB minted.

### `buyBonds(uint256 _tombAmount, uint256 targetPrice)` — Contraction Mechanism

Called by users to burn TOMB and receive TBOND.

**Requirements:**
- `tombPrice < tombPriceOne` (TOMB is below peg)
- `tombPrice == targetPrice` (price slippage protection; exact TWAP match required)
- `_tombAmount <= epochSupplyContractionLeft` (max 3% of supply burnable per epoch)
- New TBOND supply would not exceed 35% of TOMB circulating supply

**Pricing (discount rate):**
- If `discountPercent == 0`: 1 TOMB → 1 TBOND (1:1)
- If `discountPercent > 0`: `rate = 1 + (bondAmount_for_1_TOMB - 1) * discountPercent / 10000`
  - `bondAmount_for_1_TOMB = 1e18 / tombPrice` (more bonds if TOMB is cheaper)
  - Capped at `maxDiscountRate` if set

**Effect:** Burns `_tombAmount` TOMB from caller; mints `_bondAmount` TBOND to caller.

### `redeemBonds(uint256 _bondAmount, uint256 targetPrice)` — Expansion Mechanism

Called by users to burn TBOND and receive TOMB.

**Requirements:**
- `tombPrice > tombPriceCeiling` (TOMB is above peg, i.e., > 1.01 FTM)
- `tombPrice == targetPrice` (exact TWAP match)
- Treasury must hold enough TOMB (`seigniorageSaved >= _tombAmount`)

**Pricing (premium rate):**
- If `tombPrice < premiumThreshold` (1.10 FTM): 1 TBOND → 1 TOMB (no bonus)
- If `tombPrice >= 1.10 FTM`: `rate = 1 + (price - 1) * premiumPercent / 10000`
  - Default: `premiumPercent = 7000` → at 1.20 FTM, rate ≈ 1.14 (14% bonus)
  - Capped at `maxPremiumRate` if set

**Effect:** Burns `_bondAmount` TBOND from caller; transfers `_tombAmount` TOMB from Treasury to caller.

---

## 5. Masonry Contract

The Masonry is where TSHARE stakers earn TOMB emissions. Think of it as a staking pool that receives periodic "dividends" from the Treasury's epoch expansion.

### Key State

```solidity
struct Masonseat {
    uint256 lastSnapshotIndex;  // which snapshot the user last interacted at
    uint256 rewardEarned;       // accrued but unclaimed TOMB
    uint256 epochTimerStart;    // epoch when user last interacted (resets lockups)
}
```

### Lockup Rules

- **Reward lockup**: 3 epochs (18 hours) — must wait 3 epochs after last interaction before claiming TOMB rewards.
- **Withdraw lockup**: 6 epochs (36 hours) — must wait 6 epochs after last interaction before unstaking TSHARE.
- **Any interaction** (stake, withdraw, claimReward) resets **both** timers.

### `stake(uint256 amount)` 
- Transfers TSHARE from user to Masonry.
- Claims any pending TOMB rewards first (if lockup allows), then updates snapshot.
- Resets epoch timer.

### `withdraw(uint256 amount)`
- Requires `epochTimerStart + withdrawLockupEpochs <= treasury.epoch()`.
- Claims pending rewards first (if reward lockup allows).
- Transfers TSHARE back to user.

### `claimReward()`
- Requires `epochTimerStart + rewardLockupEpochs <= treasury.epoch()`.
- Transfers accrued TOMB to user.
- Resets epoch timer.

### `allocateSeigniorage(uint256 amount)` (called by Treasury)
- Only callable by operator (Treasury).
- Creates a new `MasonrySnapshot` with `rewardPerShare = amount * 1e18 / totalSupply`.
- Each staker's pending rewards are calculated lazily from snapshots on their next interaction.

### Reward Calculation

```
earned = balanceOf(user) 
       * (latestRewardPerShare - userLastRewardPerShare) / 1e18 
       + rewardEarned (already accrued)
```

---

## 6. Oracle Contract

Uses a **TWAP (Time-Weighted Average Price)** via Uniswap V2-style price accumulators.

- `update()`: Called each epoch by Treasury. Records cumulative price0/price1 from the LP pair.
- `consult(token, amount)`: Returns the TWAP price over the last period. Used by Treasury for all price checks.
- `twap(token, amount)`: Same but uses `BlockTimestampLast` for live TWAP.
- The LP pair consulted is the TOMB-FTM SpookySwap pair.

**Important**: All Treasury price checks use `getTombPrice()` which calls `oracle.consult()` — the **last updated TWAP**, not the live spot price. This prevents flash loan manipulation but means there's always a lag.

---

## 7. Reward Pools

### TombGenesisRewardPool
- Distributed TOMB to early liquidity providers (short-lived genesis phase).
- Pools: various single-asset staking (FTM, USDC, ETH, BTC, etc.).
- Now mostly historical/ended.

### TombRewardPool
- Distributes TOMB to TOMB-FTM LP stakers.
- Standard MasterChef-style: tracks `rewardPerShare` with each deposit/withdraw/claim.
- Uses a `REWARD_DURATION` with a flat per-second emission rate.

### TShareRewardPool
- Distributes TSHARE to LP stakers (TOMB-FTM LP and TSHARE-FTM LP pools).
- Runs for **365 days** from `poolStartTime`.
- Pool 0 (TOMB-FTM LP): 35,700 TSHARE (60%)
- Pool 1 (TSHARE-FTM LP): 23,800 TSHARE (40%)
- Also MasterChef-style with `rewardDebt` accounting and withdrawal fee (if set).

---

## 8. Phase Summary

### Bootstrap Phase (Epochs 0–11)
- Fixed 5% expansion every epoch regardless of price.
- 100% of emissions go to Masonry (no debt deductions).
- Helps bootstrap liquidity and initial staking before peg mechanics activate.

### Expansion Phase (TOMB > 1.01 FTM, after bootstrap)
- Treasury mints new TOMB proportional to price deviation, capped by supply tier table.
- **No debt**: all minted TOMB → Masonry (via DAO/dev fee deductions first).
- **In debt** (bondDepletionFloor not met): 35% → Masonry, 65% → Treasury reserve.
- Users can redeem TBOND for TOMB.

### Contraction Phase (TOMB < 1.00 FTM)
- No new TOMB minted; Masonry receives nothing.
- Users can burn TOMB to get TBOND (up to 3% of supply per epoch).
- `epochSupplyContractionLeft` decrements with each bond purchase and resets each epoch.

### Debt Phase
- Occurs during expansion when `seigniorageSaved < totalTbondSupply * bondDepletionFloorPercent`.
- Treasury is underfunded relative to outstanding bonds.
- During debt phase, 65% of new seigniorage goes to Treasury to rebuild reserves.
- Phase ends when Treasury holds enough TOMB to cover all outstanding TBONDs.

---

## 9. Key Gotchas / Edge Cases

1. **Price slippage revert**: `buyBonds` and `redeemBonds` require `tombPrice == targetPrice` exactly. If the TWAP moves between when the user calls and when the tx lands, it reverts. Front-ends must pass the current TWAP as `targetPrice`.

2. **Oracle lag**: TWAP is only updated once per epoch. A spike in the last 6 hours of an epoch may not be reflected until the next `allocateSeigniorage()` call.

3. **Masonry interaction resets BOTH lockups**: Staking more TSHARE while waiting to claim rewards resets the reward lockup. Users should claim before staking more.

4. **Excluded supply**: Genesis pool and bond treasury addresses are excluded from circulating supply calculations. This inflates effective expansion percentages slightly vs. raw `totalSupply`.

5. **`checkOperator` modifier**: Treasury's core functions require Treasury to be the operator of TOMB, TBOND, TSHARE, and Masonry. If operator is ever rotated away, these functions revert.

6. **Zero expansion below ceiling**: TOMB at exactly 1.005 FTM (above peg but below ceiling of 1.01) triggers no expansion. Ceiling is configurable by operator.

7. **Bond premium not active below 1.10**: Between 1.01–1.10, bond holders redeem at 1:1. The premium kicks in above `premiumThreshold` (default 1.10 FTM). This prevents large redemption if TOMB only slightly exceeds peg.

---

## 10. Forking Tomb Finance

When forking, these are the parameters to configure in Treasury `initialize()`:
- Token addresses (your algo token, bond token, share token)
- Oracle address (deploy a new TWAP oracle for your token/peg pair)
- `tombPriceOne`: peg target (1e18 if pegging to a 1:1 asset, or use the target asset's price)
- `tombPriceCeiling`: slightly above peg (e.g., 1.01e18)
- Bootstrap epochs and rate
- Supply tiers and expansion tiers
- DAO/dev fund addresses and percentages

The Masonry and reward pools are token-agnostic and require only swapping token addresses.

---

## Reference Files

- `references/Treasury.sol.md` — Full annotated Treasury source
- `references/Masonry.sol.md` — Full annotated Masonry source
- `references/TShare.sol.md` — TShare token source
