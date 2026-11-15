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
- **Robinhood Chain is a Wizard chain choice only, not a bridge destination (owner decision 2026-11-11).** xSHARE does not bridge there, and deposits stay per-chain. **BUILT 2026-11-11:** `XTombShareBridge` and its deploy script reject domain 4663 as a route and as a home; `config/xshare-bridge.json` and the CREATE3 planner list four bridge networks (Base, BSC, PulseChain, Sonic); the Setup Wizard still offers Robinhood Chain as a home network, with the bridge option off.
- xBOND after launch. No bond mechanics in the Masonry runtime.
- **Fee destinations are wallets, never a Treasury contract (locked rule; POL ruling 2026-11-11).** Pass proceeds, the pool-0 deposit fee, the wallet-claim fee, the keeper performance fee and the LP-fee shares all go to one address: the **DAO wallet**. In code this is the single `treasury` address given to `MasonryGenesisPass`, `MasonryGenesisSettlement` and `MasonryGenesisLPBurnFee` at deploy (the Wizard's "Treasury recipient" field), so the rule is met by entering the DAO wallet there; no contract enforces that it is a wallet. The LP-fee shares are protocol-owned liquidity by designation, held in that same wallet. Contract and config identifiers keep the name `treasury`. "Treasury" elsewhere in this file means the xTOMB/xSHARE Treasury allocations and the unbuilt Treasury expansion engine, not a fee destination.
- **Genesis pool 0 asset: USDC** (6 decimals). Read on-chain via `staking.standardAsset()`.
- **Automation: as implemented.** Pro/Ultra only, opt-in keeper with a minimum-net-output floor, 2% performance fee on the liquid amount, no $50 fee. Manual compounding has no performance fee. Farm/Masonry automation pricing is decided with those modules.
- **Unused Genesis emissions: swept to the DAO wallet (owner decision 2026-11-11, NOT YET BUILT).** Today `MasonryGenesisStaking` has no sweep: when a pool has no stakers, `_checkpoint` advances `lastEmitted` without crediting anyone, so that slice of the reward budget is never emitted and stays in the contract for good (Day 1 strands nothing for the LP pool, because all Day 1 emission goes to pool 0; the loss comes from any stretch in which a pool that is emitting has no stakers). The sweep to build: **permissionless, callable only after Genesis ends, recipient fixed at deploy (the same `treasury` address as every fee), amount computed by the contract and never passed in.** That needs a new counter that adds the skipped emission in the no-stakers branch, and a final checkpoint of both pools at the end; the sweep then sends exactly that counter, once. It must never touch rewards owed to stakers, who can claim after Genesis with no deadline. It must not become an owner-discretionary withdrawal: no owner-only caller, no amount argument, no recipient argument. **Rounding dust is a separate, smaller thing:** the per-share division leaves wei-scale remainders that cannot be totalled without walking every position, so dust stays in the contract unless a later decision says otherwise. Page copy must not mention the sweep until the contract has it.
- **Launch scope: full protocol** (Genesis, Treasury expansion, Farm, Masonry). Longest path. Suggested build order: G1 deploy graph, G3 tokens, G2 Treasury, G5 Farm/Masonry, then G6–G8.
- CreateX/CREATE3 for every project address. Chain selection lives in the Wizard. Genesis may deploy unscheduled; the scheduler sets the date once after funding and wiring.

## Genesis

- 7 days. Official LP pool and compounding open at start + 24h and close at Genesis end. Claims and principal withdrawals stay open afterwards. Ultra may pre-stake in pool 0 up to 24h before start.
- Passes (soulbound, not transferable; USDC to the DAO wallet): Genesis $50, Pro $100, Ultra $500 total. Everyone needs a pass to take part in Genesis; the $50 Genesis pass has no perks beyond participation. Buy any tier outright, or start lower and `upgrade()` in place for only the difference ($50 to Pro, $400 more to Ultra); the total paid is identical either way, and the same token is kept. Upgrades close when Genesis ends. Equal reward weight for every tier. All staking and reward entry points require a pass.
- Perks (owner decisions 2026-11-05; all BUILT as of 2026-11-11):
  - **Genesis:** no perks; 3% Genesis deposit fee.
  - **Pro:** opt-in keeper auto-compound **every 3 hours** (owner ruling 2026-11-14: every pass waits the same hard-coded 3 hours, by hand or by keeper; was 6 hours); **2%** deposit fee.
  - **Ultra:** everything in Pro (same 3-hour keeper interval); **0%** deposit fee; 24h early pre-stake in pool 0 at the same rate and start time as everyone else.
  - Page copy (PassPicker perks in `launch.ts`, Docs, Genesis visuals) must change with the contract work, not before, so the UI never advertises something the contracts don't do. Ultra: everything in Pro plus pool-0 pre-stake up to 24h before start, at the same rate and start time as everyone else. (Perks as shown in the Genesis UI; unconfirmed beyond that.)
- Emissions: 100% to pool 0 on Day 1; from Day 2, 75% LP / 25% pool 0.
- Rewards: 50% liquid, 50% escrow in 16 claim-gated 6-hour installments, first at end + 6h. Same schedule for all tiers.
- **Deposit fees (owner decisions 2026-11-05, NOT YET BUILT):**
  - **Single stakes (pool 0, USDC):** 3% base; Pro 2%; Ultra 0%. Goes to the **DAO wallet as USDC**. Net amount is credited as shares.
  - **LP pool deposits and compounds into LP:** flat **0.5%** for every tier (Ultra's 0% and Pro's 2% do not apply). The 0.5% in LP shares goes to the **DAO wallet, held as POL** (owner decision 2026-11-11: same wallet as every other fee; there is no separate POL vault contract). **This replaces the old burn mechanic**: no redeem-and-burn of xTOMB and no USDC buyback from this fee.
  - Contradicts the older text that says "no deposit fees" (Docs, Genesis visuals) and "Genesis LP burn fee" (specs, template `genesisLevelUsdcLpBurnFeeBps`, `MasonryGenesisLPBurnFee`, `genesisLevelBurned`, dashboard burn counters, tests). Those all need reworking in one change.
  - Open: exact fee-collection mechanics for the LP shares (the DAO wallet receives vault shares directly), the `authorized Genesis caller` and escrow-retry logic become unnecessary, and the Treasury address must be bound before Genesis.
- Fees: see deposit fees above (this replaces the older "one 50 bps LP-share fee that burns xTOMB"). 2% claim-to-wallet fee to the DAO wallet. 2% keeper performance fee to the DAO wallet. Shared 3-hour claim/compound cooldown per beneficiary per pool today; **Keeper cadence per tier is BUILT (2026-11-11):** `MasonryGenesisStaking` tracks `lastKeeperCompoundAt` per source pool and a keeper run must clear both the shared 3-hour cooldown and the tier interval (`PRO_KEEPER_INTERVAL` 6h, `ULTRA_KEEPER_INTERVAL` 3h); the interval follows the tier held at the time, so an upgrade to Ultra applies from the next run. **Manual claims and compounds stay at 3h for every tier** — built that way because the owner left it open; change it only with an owner decision.
- Compound: caller supplies xTOMB sell amount and gross LP shares plus a net-share floor. Unused inputs return to the beneficiary, capped at 3% plus dust.

## Taxes and defense

- xTOMB sell tax: max of ordinary TWAP target, projected execution target, recovery floor, and 3% during Genesis. 12% hard cap. Single debit, burned during Genesis; outside Genesis it goes to the fee recipient. Buys and transfers 0%.
- xSHARE sell tax: same engine, 6% Genesis floor, 12% cap. Normal split of collected tax: 12% POL, 20% USDC reserve, 68% retained xSHARE.
- Critical Defense: enters at fresh TWAP ≤ 0.90; 100% of new eligible xSHARE fees go to xTOMB buy-and-burn; earlier earmarks unchanged. Exits after two consecutive real 6-hour checkpoints with fresh TWAP > 1.01. Stale data never ends it.
- No owner/keeper trading pause. No governance timelocks. Optional secondary operations must never revert the original sale or deposit.

## Supply

- xSHARE: cap 33,333, farming 25,641 over 365 days, sale escrow 100, deployer 1, owner/team/dev 100, treasury 500, arbitrage 50.
- **Vesting remainder (6,941), owner decision 2026-11-05:** team 1,000; developer 1,000; Treasury 2,940; arbitrage bot 1,901 (the rest) — all on 180-day linear streams. Plus **100 xSHARE minted outright to the deployer/DAO address** (the dev address), so that address starts with 101 liquid xSHARE (the deployer's 1 plus this 100). Check: 1,000 + 1,000 + 2,940 + 1,901 = 6,841 vesting, plus 100 outright = 6,941. Arbitrage holds 1,951 in total with its initial 50. **BUILT 2026-11-11:** the template carries `square.vesting` = 1,000 / 1,000 / 2,940 / 1,901 and `square.initial.deployerDao` = 100; the validator requires and counts `deployerDao`; `DeployMasonryLocal` escrows the four buckets in separate `MasonryLinearVesting` streams (180 days, no upfront release) and records them under `vesting` in the deployment record.
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

**Advance-epoch fee (owner decisions 2026-11-11, NOT YET BUILT):** anyone may advance the epoch once it is due, and every caller pays **$5** to do it. There is no free path and no caller reward; the protocol's own keeper pays the same fee. Policy key `epochAdvanceFeeUsd` = 5 is a release invariant. It is spec and policy only until G2 is built: no contract charges it yet, so page copy must not advertise it before then.
- **Payment:** the chain's stablecoin or ETH. The stablecoin is **USDC on Base and USDG on Robinhood Chain**.
- **Destination:** the **DAO wallet**. Fee destinations are wallets, never the Treasury contract (locked rule).
- **ETH pricing:** the fee is denominated in USD, so an ETH payment converts at the protocol's own TWAP/oracle price with a staleness check; a stale price rejects the ETH route and leaves the stablecoin route open. Never a fixed ETH amount, which drifts from $5 as ETH moves. Build note: the Masonry oracle today prices xTOMB in the stablecoin only, so G2 has to add the ETH/stablecoin read.
- **USDG on Robinhood Chain:** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (Paxos-issued, 6 decimals), recorded under `pendingStablecoins` in `config/official-infrastructure.json`. Pin and verify on-chain before mainnet wiring. Robinhood Chain is not yet a launch chain in that registry, and it is not a bridge destination.
- **Who advances:** the expected caller is a positioned user, anyone whose expansion print, claim window or vesting release keys off the new epoch; they pay because advancing pays them. The protocol keeper is the backstop, and its worst case is about $20 a day (four epochs). A missed epoch gets no catch-up, as above.

## Safe Mode, the Fire Pit and Keep Printing (owner decision 2026-11-15, NOT YET BUILT)

**The peg is $1 and does not move.** Fire Tax, Critical Defense, expansion eligibility and every other defense keep measuring from $1. What this section adds is a **premium target: a TWAP of 1.20**. The protocol rallies its users while the TWAP is still far above peg and expansion is still printing, instead of waiting for an underpeg to fight. That is the point of difference from Tomb, and page copy should say so plainly: "We don't wait for the underpeg to fight."

Why it works on the user: fighting for a fork that has already lost its peg feels like wasted time and money. Sacrificing while the interface is still healthy, the TWAP is well over $1 and rewards are still printing feels good, and the reward is visible: Safe Mode ends and the full green interface and health bar come back.

Nothing in this section may be advertised before the contract behind it exists (same rule as every other perk). It depends on Treasury expansion (G2) and Masonry (G5).

### Safe Mode

- **Enters at a TWAP of 1.19** (fresh validated TWAP at or below 1.19). Returns to normal once the TWAP is back at 1.20.
- The interface is responsive to conditions. Normal state: full green interface and a full health bar. Safe Mode: a visibly different state that sends users to the Fire Pit and to Keep Printing. Expansion is **still printing** in Safe Mode, and the copy says so.
- Safe Mode is a rally, not a restriction on trading. The standing rules hold: no owner/keeper trading pause, and nothing optional may revert a sale or deposit.

### Fire Pit (new page)

Animated fire and a couple of cards. Users are encouraged to visit whenever Safe Mode is on.

- **USDC card:** deposit USDC; it buys LEVEL through the official pool and burns it.
- **LEVEL card:** throw LEVEL into the pit; it is burned.
- **Nothing is given in return** except the feeling of helping (and the lodge status below). The page must say this before the user signs.
- Burns count toward the token's cumulative total burned.

### Keep Printing (new page)

Shows every way the protocol deploys capital to keep printing, and explains that we act above peg.

- Two deposit boxes, USDC and LEVEL. The USDC box is called **the Overpegger**.
- **Under each box, show exactly what happens when you deposit**, step by step, from the contract's real behavior.
- The LEVEL side can simply link out: "Burn some LEVEL in the Fire Pit".
- **In the middle, a live list of actions**, read from on-chain events, in this voice:
  - "0x8t5.. threw 364 LEVEL in the Fire Pit"
  - "0x844 threw a hefty $500 USDC in the Overpegger."

### Masonry claim during Safe Mode

At a TWAP of 1.19, a modal appears **before** the usual claim confirmation:

> We're rallying the community to keep our nice premium 1.2 TWAP. Consider participating by sacrificing this claim to the Fire Pit, dumping some USDC into the Overpegger, or manually throwing LEVEL into the pit. Participating is rewarded with a higher status in the lodge and frees up your rewards once we're back at 1.2, among other looser policy.

- **Green button, "Fight!":** the pending LEVEL is claimed and burned in one action, shown in the same modal: "Claiming and…" then "Burned 164 LEVEL" with a link to the transaction.
- **Red button, "I'm Claiming":** the modal fades into the usual claim confirmation. Claiming is never blocked.

### Lodge status

Participating (sacrificing a claim, using the Overpegger, throwing LEVEL in the pit) earns a **higher status in the lodge**. Per the modal copy it also "frees up your rewards once we're back at 1.2, among other looser policy".

### What has to be built

- **Fire Pit contract:** `burn LEVEL` and `spend USDC → buy LEVEL on the official pool → burn`, with a caller-supplied minimum output. Buys are untaxed, so the full USDC amount buys LEVEL. It holds no balance between calls and has no owner withdrawal. Sacrificed USDC is not a fee, so the "fees go to the DAO wallet" rule does not apply to it.
- **Masonry `claim and burn`:** one call that burns the caller's pending LEVEL instead of paying it out. It must emit the burned amount for the modal and the feed.
- **Events** for every sacrifice (who, which path, amount), so the live list and lodge status come from chain data and never from a database.
- **Safe Mode read:** one view that returns the current state from the fresh validated TWAP, used by every page. A stale TWAP must never switch Safe Mode off (same principle as Critical Defense).
- **Frontend:** the Fire Pit and Keep Printing routes, the health bar, the Safe Mode theme, the Masonry pre-claim modal, and a "Your next move" entry that points to the Fire Pit while Safe Mode is on.

### Open (owner to decide; do not build on a guess)

- **Token name in copy.** The owner's copy above says LEVEL. The public name elsewhere in this file is xTOMB (LEVEL is the older source name). Pick one for these pages.
- **What the Overpegger does with USDC.** Stated: it is the USDC box on Keep Printing. Not stated: whether it is the same buy-and-burn as the Fire Pit's USDC card or a different deployment of capital (for example buying and holding as protocol-owned liquidity). Recommendation: make it the same contract call as the Fire Pit's USDC card, so there is one audited path and one feed.
- **What "frees up your rewards" means.** It implies some reward policy tightens during Safe Mode and loosens for participants once the TWAP is back at 1.20. No tightening rule has been decided. Until one is, the modal copy promises something no contract does, so that sentence cannot ship.
- **Lodge status:** the ranks, how sacrifices are scored (USDC value, LEVEL count, or count of actions), whether status expires, and what "looser policy" each rank unlocks.
- **Entry and exit:** one line at 1.20, or a gap (enter at 1.19, exit only after a full six-hour checkpoint at or above 1.20) so the interface does not flicker between states. Recommendation: the checkpoint rule.
- **Lower bound.** What the interface shows between $1.01 and 1.19 versus below $1.01 (expansion off) and at or below $0.90 (Critical Defense). Recommendation: Safe Mode covers 1.01–1.19; below that, the existing defense states take over.
- **"1.9" in the owner's note** ("twap is well over 1 (1.9)") is read here as 1.19.
- **Limits:** a minimum or maximum per sacrifice, and whether the Fire Pit accepts deposits when Safe Mode is off.

### In the same spirit (PROPOSED, not approved)

- **Rally meter:** on the Fire Pit and the health bar, show how much has been burned this rally and how far the TWAP is from 1.20, so a sacrifice visibly moves something.
- **"Safe Mode ended" moment:** when the TWAP is back at 1.20, the interface turns green for everyone at once, and participants see what they personally burned during that rally.
- **Claim half, burn half:** a third option in the Masonry modal between "Fight!" and "I'm Claiming".
- **Rally prompt on the sell preview:** during Safe Mode, the Swap page shows a quiet line beside a LEVEL sell: "Selling now lengthens Safe Mode. Burn a little in the Fire Pit instead?" It never blocks the sale.

## Still open

Home chain (Base first vs Robinhood Chain); 6,941 split; `authorizedLaunchSupply`; reward budget; Genesis deposit-fee policy (the 50 bps LP fee is separate); multi-pool Genesis; tier perks beyond the base; Harvest All / Compound All / Robot Arms; Farm migration; target-chain calibration (liquidity floor, TWAP cadence, guard tolerances, tick range).
