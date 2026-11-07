# Masonry / xTOMB — Complete next-agent handoff
**Snapshot:** 2026-11-07; repository `0xbasedev/v4-tomb`, branch `merge`.  
**Source:** https://github.com/0xbasedev/v4-tomb/tree/merge  
**Archive:** https://github.com/0xbasedev/v4-tomb/archive/refs/heads/merge.zip  
**Scope:** contracts, Foundry tests, config, deployment scripts, frontend, ABI handoff, bridge, docs, CI.  
**Priority:** newest explicit user decisions > this handoff > earlier design documents > inherited Old Money code.

## Read first
- `docs/CLAUDE_NEXT_STEPS.md` — most recent frontend/operator integration checkpoint.
- `docs/MASONRY_V4_IMPLEMENTATION_STATUS.md` — contract and economic implementation, limitations.
- `docs/MASONRY_MERGE_RECONCILIATION_2026-11-04.md` — legacy-vs-Masonry inventory and merge constraints.
- `frontend/abi-handoff/manifest.json` — compiler-generated ABI map (ABI snapshot commit `02858c6`).
- `config/masonry-deployments.json` — currently **empty**; no verified deployment.
- `frontend/README.md`, `contracts/foundry.toml`, `config/masonry-launch.template.json`.

## Snapshot contents
- `frontend/`: active React/TypeScript/Vite frontend (xTOMB / xSHARE visual language, responsive routes: Landing, Dashboard, Genesis, Farm, Masonry, Swap, Bridge, Docs, Wizard, Admin). `frontend/src/xtomb/setup/` retains a working prior operator/planning implementation for porting. Do NOT replace existing UI/UX wholesale or confuse preview data with live state.
- `frontend/abi-handoff/`: `current/`, `shared/`, `bridge/`, `legacy-reference/`, plus `manifest.json`. ABI files are a snapshot; regenerate if contract interfaces changed after ABI snapshot commit.
- `contracts/src/masonry/`: Genesis schedule/pass/staking/settlement, 0.5% LP burn module, fungible LP vaults, critical defense, TWAP/oracle, buyback guard, vesting, fee allocation, rules, compound gate.
- `contracts/src/hooks/`: Masonry LEVEL and SQUARE v4 hooks plus shared tax hook; inherited PegDefenseHook is **legacy**, not the Masonry launch hook.
- `contracts/src/bridge/`: xSHARE Hyperlane route and bridge components.
- `contracts/src/core/` and `contracts/src/distribution/`: substantial inherited WETH/bond-era Old Money contracts. They must NOT be mistaken for final Masonry Treasury/Farm/Masonry deployment logic.
- `contracts/test/`: unit, integration and fork tests; `contracts/script/`: scripts; `config/`, `scripts/`, `.github/`: launch configuration, CREATE3 planner, CI, operations.

## Current immutable/confirmed user decisions
1. **Three soulbound Genesis NFTs mandatory to participate**: Genesis $50 USDC, Pro $100 USDC, Ultra $500 USDC. No free Genesis participation; NFT proceeds go to Treasury USDC. Pro receives enhanced staking terms, Genesis automation, Harvest All / Compound All, automated migration. Ultra inherits Pro and gets early access, all Genesis pools, Robot Arms automation; **NO 4x cap, multiplier or reward**. Verify exact tier-specific perks against newer code and decisions; do not restore older 4x draft.
2. **Genesis lasts 7 days; LEVEL/USDC LP Genesis opens at start + 24 hours (Day 2)**. Genesis encourages LP depth over remaining days. NFT gate applies to deposits/rewards. ULTRA pre-stake may be allowed in the day before Genesis as explicitly implemented, without early reward emission.
3. **Genesis LEVEL sell-only tax minimum 3%**. Effective sale tax is max(3%, ordinary dynamic tax from fresh validated TWAP, conservative projected **post-sale LEVEL price**, seven-hour recovery floor), capped immutably at **12%**. It is a **single** tax, not additive. Genesis LEVEL tax proceeds burn immediately; buys and wallet transfers are untaxed. Protect exact-input/output and concentrated v4 tick-crossing paths.
4. **Genesis LEVEL/USDC LP deposit/compound fee exactly 0.5%**. Redeem LP fee shares into LEVEL + USDC, burn LEVEL directly, use USDC to buy and burn more LEVEL in same tx if safe; otherwise reserve USDC exclusively for later burn, retry on next eligible Genesis interaction. Zaps into Genesis pay this one 0.5% protocol fee, not a second 0.5% route fee. Successful auto-compounds every eligible three-hour period pay this burn fee. Display actual LP-fee LEVEL burned and cumulative protocol LEVEL burned separately, without double-counting.
5. **SQUARE Fire Tax normal collection-time split:** 12% of *collected tax* earmarked to official SQUARE/USDC POL, 20% of collected tax converted SQUARE→USDC and reserved, 68% retained as SQUARE. Fees earmarked at collection; delayed processing must preserve destination. Never sell Treasury LEVEL into USDC to fund reserves. LEVEL can burn or remain as LEVEL in Treasury/Arbitrage inventory.
6. **Critical Defense** begins at validated LEVEL TWAP <= $0.90; all newly collected eligible revenue routes 100% to LEVEL buyback/burn (protected capital and existing earmarks excluded). Ends after two consecutive actual six-hour checkpoints with fresh validated TWAP strictly > $1.01. Oracle failure never clears defense. Honor configured whitelist exemptions during defense.
7. **Fire Tax** sells only; no buy tax; immutable max 12%; post-sale impact determines rate, subject to validated TWAP and seven-hour recovery floor. No automatic protocol-owned LEVEL→USDC conversion for Treasury funding. Owner can update scoped EOAs/contracts whitelists immediately. No governance timelocks and **no owner-controlled pause of trading**.
8. **Masonry** SQUARE/USDC LP stake, 6h global manual-deposit reset lock, 6h claim cooldown, compound does not reset lock; no LEVEL expansion at/below peg (strict fresh TWAP > $1.01), 6h epoch, <=2% circulating LEVEL eligible expansion, no bonds, no catch-up. Exit Now returns 50% staked LP, transfers 50% to Treasury and pending unclaimed LEVEL to Arbitrage, as specified in existing docs.
9. **SQUARE** 33,333 supply cap, 25,641 farm inventory, 4,274 team, 3,417 dev, 1 deployer. Sale 100 SQUARE from Team/Dev, $50 starting price +$5 per purchase, max 10/wallet; airdrops cannot inflate cap. Existing 6,941 remainder vesting allocation is a known reconciliation requirement.
10. **Chain-agnostic/config-driven**, official v4 pools only, low-cost EVM targets (not Ethereum mainnet), no hardcoded chain routers/tokens, owner operations audit events, single owner permitted, no mandatory multisig. xSHARE bridge is an additional workstream; routes must stay disabled until verified.

## What is NOT finished / release blockers
- No verified live deployment: `config/masonry-deployments.json` is empty.
- Modern USDC-based Masonry Treasury, Farms and boardroom must replace or isolate inherited WETH/bond-era runtime; enforce the strict expansion gate in actual production execution.
- End-to-end deployment/wiring, funding, LP mint/redeem, v4 hook permissions/CREATE3 salts, owner and pool configuration must be verified on selected target chains.
- The active frontend is a substantial design and preview; some routes/buttons remain non-transactional until verified contracts. Preserve design and add live ABI/address-driven transaction states, zaps, LP-first-class swap, Masonry/Farm controls and actual counters. Do not present simulated values as live.
- ABI bundle `frontend/abi-handoff/manifest.json` references compiler snapshot `02858c6`; confirm ABI freshness against source before shipping.
- Bridge peer/route activation and cross-chain delivery verification are pending.
- Full adversarial Foundry fork/invariant and browser E2E suites, gas calibration, independent security audit, and a deployment runbook rehearsal required before launch.
- Old docs mentioning Old Money, WETH, bonds, timelock, 4x Ultra, alternate NFT prices or different Genesis length are **historical only**, not requirements.

## Practical next-agent sequence
1. Check HEAD and working tree; inspect latest `merge` commits and any separate Claude/Work branches for unmerged work. Do not assume other agents' local changes are present in this archive.
2. Run `node scripts/install-contract-deps.mjs`, `node scripts/protocol.mjs validate`, `node --test config/*.test.mjs`, `cd contracts && forge build && forge test`.
3. In `frontend`, use pinned pnpm version: `corepack pnpm install --frozen-lockfile`, `corepack pnpm gen:abis` (if ABI source changed), `corepack pnpm build`, `corepack pnpm test:browser`. Check scripts and lockfile before invoking.
4. Reconcile and bind active v5 Wizard/Admin to shared CREATE3 planner and deferred Genesis scheduler as described in `docs/CLAUDE_NEXT_STEPS.md`. Preserve verified hooks/permission-bit address mining, chain and signer checks, simulation, receipt confirmation.
5. Complete Masonry-specific Treasury/Farm/Masonry deployment and owner operations. Preserve principal/fee/escrow separation and never enable inherited bonds or legacy timelock.
6. Run actual Uniswap v4 fork tests for post-sale Fire Tax simulation and no fee stacking; validate burn accounting, 6-decimal USDC, pool depth, hook recursion, failed buybacks, recovery hysteresis, malicious routing and stale oracles.
7. Refresh compiler ABIs, frontend bindings and deploy manifest only after actual verified deployment; then test user transactions and bridge activation separately.
8. Produce test reports with commands and commit SHAs, audit findings, and remaining launch blockers. Never claim tests pass based solely on older handoff documents.

## Archive provenance
This file is committed into `merge` so the GitHub branch ZIP includes it with all tracked frontend source, ABI JSON, Solidity source, tests, config and docs. GitHub branch archives are snapshots of **tracked files only**; they do not include uncommitted work from another agent, installed dependencies, generated build outputs, or private credentials.
