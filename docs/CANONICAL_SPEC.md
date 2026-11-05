# Canonical Masonry spec (xTOMB / xSHARE)

Synthesized 2026-11-05 from the docs below plus the owner's decisions. Where documents disagree, this file says which wins. Change it only with an owner decision.

## Precedence

1. Owner decisions (section below).
2. `MASONRY_V4_IMPLEMENTATION_STATUS.md`: economics backed by code.
3. `MASONRY_MERGE_RECONCILIATION_2026-11-04.md`: status, gates G1–G8, constraints.
4. `config/masonry-launch.template.json`: parameter values.
5. `HANDOFF_LOCAL_LAUNCH.md`, `CLAUDE_NEXT_STEPS.md`: process.
6. `MASONRY_MERGE_PLAN.md`: historical. Unbuilt ideas only (Farm, Exit Now, arbitrage, wallet limits); none approved.

## Owner decisions

- Public names xTOMB / xSHARE. Source names PegToken / ShareToken. Older docs say LEVEL / SQUARE: naming only.
- Base first. BSC later as a bridge satellite (Bridged xSHARE, one 33,333 cap). Bridge stays off until peers, ISMs, limits and relayers are verified.
- xBOND after launch. No bond mechanics in the Masonry runtime.
- **Genesis pool 0 asset: USDC** (6 decimals). Read on-chain via `staking.standardAsset()`.
- **Automation: as implemented.** Pro/Ultra only, opt-in keeper with a minimum-net-output floor, 2% performance fee on the liquid amount, no $50 fee. Manual compounding has no performance fee. Farm/Masonry automation pricing is decided with those modules.
- **Unused Genesis emissions and rounding dust: Treasury.** Not yet implemented in `MasonryGenesisStaking`; it must be a visible, documented Treasury sweep. Do not let it become an owner-discretionary withdrawal.
- **Launch scope: full protocol** (Genesis, Treasury expansion, Farm, Masonry). Longest path. Suggested build order: G1 deploy graph, G3 tokens, G2 Treasury, G5 Farm/Masonry, then G6–G8.
- CreateX/CREATE3 for every project address. Chain selection lives in the Wizard. Genesis may deploy unscheduled; the scheduler sets the date once after funding and wiring.

## Genesis

- 7 days. Official LP pool and compounding open at start + 24h and close at Genesis end. Claims and principal withdrawals stay open afterwards. Ultra may pre-stake in pool 0 up to 24h before start.
- Passes (soulbound, not transferable; USDC to Treasury): Genesis $50, Pro $100, Ultra $500 total. Everyone needs a pass to take part in Genesis; the $50 Genesis pass has no perks beyond participation. Buy any tier outright, or start lower and `upgrade()` in place for only the difference ($50 to Pro, $400 more to Ultra); the total paid is identical either way, and the same token is kept. Upgrades close when Genesis ends. Equal reward weight for every tier. All staking and reward entry points require a pass.
- Perks (owner decisions 2026-11-05; deposit-fee and cadence perks are NOT BUILT yet):
  - **Genesis:** no perks; 3% Genesis deposit fee.
  - **Pro:** opt-in keeper auto-compound **every 6 hours**; **2%** deposit fee.
  - **Ultra:** everything in Pro, but keeper auto-compound **every 3 hours**; **0%** deposit fee; 24h early pre-stake in pool 0 at the same rate and start time as everyone else.
  - Page copy (PassPicker perks in `launch.ts`, Docs, Genesis visuals) must change with the contract work, not before, so the UI never advertises something the contracts don't do. Ultra: everything in Pro plus pool-0 pre-stake up to 24h before start, at the same rate and start time as everyone else. (Perks as shown in the Genesis UI; unconfirmed beyond that.)
- Emissions: 100% to pool 0 on Day 1; from Day 2, 75% LP / 25% pool 0.
- Rewards: 50% liquid, 50% escrow in 16 claim-gated 6-hour installments, first at end + 6h. Same schedule for all tiers.
- **Deposit fees (owner decisions 2026-11-05, NOT YET BUILT):**
  - **Single stakes (pool 0, USDC):** 3% base; Pro 2%; Ultra 0%. Goes to **Treasury as USDC**. Net amount is credited as shares.
  - **LP pool deposits and compounds into LP:** flat **0.5%** for every tier (Ultra's 0% and Pro's 2% do not apply). The 0.5% in LP shares goes to **Treasury as POL**. **This replaces the old burn mechanic**: no redeem-and-burn of xTOMB and no USDC buyback from this fee.
  - Contradicts the older text that says "no deposit fees" (Docs, Genesis visuals) and "Genesis LP burn fee" (specs, template `genesisLevelUsdcLpBurnFeeBps`, `MasonryGenesisLPBurnFee`, `genesisLevelBurned`, dashboard burn counters, tests). Those all need reworking in one change.
  - Open: exact fee-collection mechanics for the LP shares (Treasury receives vault shares directly), the `authorized Genesis caller` and escrow-retry logic become unnecessary, and the Treasury address must be bound before Genesis.
- Fees: see deposit fees above (this replaces the older "one 50 bps LP-share fee that burns xTOMB"). 2% claim-to-wallet fee to Treasury. 2% keeper performance fee. Shared 3-hour claim/compound cooldown per beneficiary per pool today; the owner now wants keeper cadence per tier (Pro 6h, Ultra 3h), which changes how the keeper clock works (open: whether manual compounding stays at 3h for every tier).
- Compound: caller supplies xTOMB sell amount and gross LP shares plus a net-share floor. Unused inputs return to the beneficiary, capped at 3% plus dust.

## Taxes and defense

- xTOMB sell tax: max of ordinary TWAP target, projected execution target, recovery floor, and 3% during Genesis. 12% hard cap. Single debit, burned during Genesis; outside Genesis it goes to the fee recipient. Buys and transfers 0%.
- xSHARE sell tax: same engine, 6% Genesis floor, 12% cap. Normal split of collected tax: 12% POL, 20% USDC reserve, 68% retained xSHARE.
- Critical Defense: enters at fresh TWAP ≤ 0.90; 100% of new eligible xSHARE fees go to xTOMB buy-and-burn; earlier earmarks unchanged. Exits after two consecutive real 6-hour checkpoints with fresh TWAP > 1.01. Stale data never ends it.
- No owner/keeper trading pause. No governance timelocks. Optional secondary operations must never revert the original sale or deposit.

## Supply

- xSHARE: cap 33,333, farming 25,641 over 365 days, sale escrow 100, deployer 1, owner/team/dev 100, treasury 500, arbitrage 50.
- **Vesting remainder (6,941), owner decision 2026-11-05:** team 1,000; developer 1,000; Treasury 2,940; arbitrage bot 1,901 (the rest) — all on 180-day linear streams. Plus **100 xSHARE minted outright to the deployer/DAO address** (the dev address), so that address starts with 101 liquid xSHARE (the deployer's 1 plus this 100). Check: 1,000 + 1,000 + 2,940 + 1,901 = 6,841 vesting, plus 100 outright = 6,941. Arbitrage holds 1,951 in total with its initial 50. Not yet written into `masonry-launch.template.json`, which needs a "deployer/DAO outright" entry and the four vesting amounts; the validator must be updated in the same change.
- xTOMB initial: owner/team/dev 5,000, treasury 5,000, arbitrage 1,000.
- **xTOMB launch supply, reward budget and seed liquidity: PROPOSED, not approved.** Draft for the owner to edit (confidence low–medium; the economics need a simulation before this is final):
  - Seed liquidity 10,000 xTOMB + 10,000 USDC at the $1.00 peg (also sets the oracle's active-liquidity floor and guard tolerances; thin pools make the oracle reject sells).
  - Genesis reward budget 25,000 xTOMB (about 3,570/day over 7 days; half liquid, half escrowed).
  - `authorizedLaunchSupply` = 11,000 initial + 10,000 seed + 25,000 rewards = **46,000 xTOMB**. Expansion mints come later under the Treasury rules, not from this number.
  - Trade-off: a bigger budget draws more stakers but more sell pressure into the 3–12% burn tax; the local placeholder (1,050,000) is far too large for a 10k-seed pool.
  - Open: who funds the 10,000 seed USDC.

## Control

The **dev address is Owner, Operator and Admin** and has the privileged Admin-page functions that keep the protocol under control. It also holds the Genesis scheduler role unless the Wizard sets another. Treasury and fee-recipient addresses: not yet stated; the Wizard must require them explicitly. Constraints that still hold regardless: no owner/keeper trading pause on the v4 pools, no governance timelocks, Admin invisible to non-owners, only controls backed by real deployed methods. Single-key custody of all of these is the largest centralization risk in the design; a multisig for the dev address is strongly recommended but is the owner's call.

- Token contracts must expose cumulative total burned. The Genesis LP-fee burn counter is a subset, never added twice.

## Treasury expansion (not built; blocker G2)

Mint only on fresh TWAP strictly > 1.01, max 2% of circulating xTOMB per 6-hour epoch, no catch-up for missed epochs, no stale-oracle bypass. The inherited `core/Treasury.sol` is WETH/bond-era and must not ship as Masonry.

## Still open

6,941 split; `authorizedLaunchSupply`; reward budget; Genesis deposit-fee policy (the 50 bps LP fee is separate); multi-pool Genesis; tier perks beyond the base; Harvest All / Compound All / Robot Arms; Farm migration; target-chain calibration (liquidity floor, TWAP cadence, guard tolerances, tick range).
