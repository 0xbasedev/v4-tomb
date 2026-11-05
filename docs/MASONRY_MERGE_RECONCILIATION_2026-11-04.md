# Masonry v4 — merge reconciliation checkpoint

**Verified:** 2026-11-04 (US Eastern), GitHub PR #2 head `dcf5d464095be982f1866ae1b566b3988a2b73ce`, branch `merge`.

**Decision:** This is a development integration branch, **not production-ready**, and must remain a draft until runtime deployment, end-to-end verification, and independent security review are complete. GitHub marks the branches mergeable; this means **no Git history conflict**, not safe economic integration.

## Canonical branch graph

1. `main` — upstream legacy Old Money v4 WETH/bond-era runtime; do not label a deployment of this code Masonry.
2. `feat/chain-agnostic-config` — PR #1, exactly **4 ahead / 0 behind** `main` at review; validated manifests and portable legacy deployment infrastructure.
3. `merge` — PR #2, exactly **37 ahead / 0 behind** `feat/chain-agnostic-config` (41 ahead of `main`). PR #2 targets PR #1's branch. Neither PR is merged to `main`.

**Safe order when approved:** PR #1 into `main`, retarget/recompare PR #2 against `main`, run complete checks, then merge PR #2 only when its economic/deployment gates pass. No force push, squash-away of provenance, or wholesale merge from Lodge-Capital/Masonry.

## Reconciled feature inventory

| Feature | Evidence in current `merge` source | Verdict |
| --- | --- | --- |
| Seven-day Genesis / Day-2 LP opening | `MasonryGenesisSchedule`: 7 days, LP opens start + 1 day | Implemented |
| Genesis NFTs | `MasonryGenesisPass`: soulbound Genesis/Pro/Ultra at 50/100/500 six-decimal USDC | Base tiers implemented; advanced perks and migration unfinished |
| Genesis reward settlement | `MasonryGenesisStaking` + `MasonryGenesisSettlement`: 50/50 liquid/escrow; 16 gated six-hour installments; shared three-hour claim/compound cooldown | Local code and tests; needs deployed settlement/adversarial checks |
| LEVEL sell tax | `MasonryLevelHook` + `MasonryTaxHook`: Genesis 300-bps minimum, burn on Genesis sells, <=1,200-bps single tax, no buy tax | Hook exists; official pool binding and execution needed |
| Genesis LP burn fee | `MasonryGenesisLPBurnFee`: one 50-bps share collection on deposit/compound, redeem and burn LEVEL; USDC buy/burn when guard permits, otherwise dedicated escrow retry on authorized Genesis activity | Code and local regression tests exist; target-chain gas/liquidity calibration pending |
| LEVEL/USDC fungible LP shares | `MasonryLevelUsdcVault` | Exists; downstream Farm/Masonry consumption still pending |
| SQUARE sell tax and Critical Defense | `MasonrySquareHook`, `MasonryFeeAllocation`, `MasonryCriticalDefense`: normal 12% POL / 20% USDC reserve / 68% native SQUARE **of collected tax**, or 100% new eligible fees to LEVEL burn in defense | Code exists; all reserve/POL paths need deployment rehearsal |
| Native oracle and guarded swaps | `MasonryLevelOracle` and `MasonryBuybackGuard` | Local evidence exists; oracle manipulation, live tick behavior, execution and gas require independent tests |
| SQUARE max supply allocation | `config/masonry-launch.template.json`, `config/masonry-launch.mjs` | Unfinalized by design: 33,333 cap; 25,641 farming; 6,941 remaining vesting allocation unresolved |
| Strict above-peg seigniorage | `MasonryRules` has >1.01 eligibility predicates | **NOT enforced by new production Treasury yet**; inherited `contracts/src/core/Treasury.sol` still has old WETH/bond mechanics |
| Live Genesis, Farm, Masonry launch | `contracts/script/Deploy.s.sol` deploys inherited WETH protocol, whereas `DeployMasonryComponent.s.sol` is a component deployer only | **BLOCKED**: complete Masonry-specific deployment/wiring and funding are missing |
| Setup Wizard / Admin | `frontend/src/xtomb/setup/SetupPages.tsx`, `configuration.ts`, `planner.worker.ts`, `verifyLaunch.ts`, `GenesisScheduling.tsx` and `frontend/test/setup.spec.ts` | **Implemented four-step release-planning UI**; live deployment is a separate, still-blocked release gate |
| Public dApp | xTOMB/xSHARE frontend preview | Live balances, minting, swaps, staking and Farm/Masonry bindings remain unavailable until verified deployment |

## Existing Setup Wizard and Admin — preserve this work

**Status: implemented as a release planning, review and admin UI on `merge`.** It is incorrect to describe the Setup Wizard itself as unfinished. The separate remaining work is executing a safe, wired, funded Masonry deployment from its reviewed release plan.

- **Network:** choose Base, Robinhood Chain, BSC, PulseChain, Sonic, or custom EVM; expose chain-specific dependencies and preserve overrides.
- **Launch settings:** release ID, signer/governance/Treasury recipients, token supply and SQUARE vesting conservation, fixed Genesis economics, optional Genesis start now or later, and per-transaction burn execution limits.
- **Optional xSHARE bridge:** export Hyperlane route/verifier/owner/cap plans; bridge routes remain disabled until separately verified.
- **Review:** worker-derived CreateX/CREATE3 deterministic addresses, draft autosave and import/export, separate address/release/launch/bridge JSON exports.
- **Admin:** import/read a plan, compare expected chain IDs, confirm CreateX bytecode and deployed code presence, and use the authorized governance wallet to schedule a deferred Genesis only after verifying funding and staking connection.
- **Source/test evidence:** `frontend/src/xtomb/setup/SetupPages.tsx`, `configuration.ts`, `planner.worker.ts`, `verifyLaunch.ts`, `GenesisScheduling.tsx` and `frontend/test/setup.spec.ts`. Browser automation exists in source, but **was not rerun as part of this reconciliation**.
- **Boundary:** the wizard currently generates and verifies deployment plans; it does not itself execute the complete Masonry contract deployment pipeline. Avoid calling the implemented planning wizard missing simply because the deployer and live user contract integrations remain blocked.

These classifications reflect checked source and repository documentation, **not** a fresh Foundry execution in this review environment. Prior local-passing claims require reproducible clean CI/fork output at the exact release SHA.

## Unresolved integration order (blocking)

- [ ] **G1 — Build/deployment graph:** produce a complete Masonry v4 deploy entrypoint using the verified shared chain manifest. Wire official LEVEL+SQUARE hooks, respective PoolKeys, USDC (6 decimals), immutable Genesis clock, bound oracle/guards, both LP vaults, Genesis staking/settlement, fee collector, owner/DAO and treasury. The inherited `Deploy.s.sol` must not silently become a Masonry deploy path. Add deploy-only smoke tests and publication receipts.
- [ ] **G2 — Treasury and boardroom:** replace the WETH/bond-era runtime with bonds-free LEVEL/USDC Masonry economics. Enforce fresh 6-hour observations, strictly >1.01 mint eligibility, max 2% circulating LEVEL per eligible epoch, no catch-up/missed-epoch mint, no stale-oracle bypass. This is a consensus-critical blocker.
- [ ] **G3 — Token implementation:** deploy correct LEVEL/SQUARE supply, mints, approvals, cumulative totalBurned events, peg accounting, SQUARE allocation/vesting and immutable max supply. Genesis LP-fee burn count is a **subset** of actual token burns and must not be double counted in the dashboard.
- [ ] **G4 — Genesis economics:** review NFT tier perks, optional upgrade/migration and automation executor, delayed unused-emission rules, min-out/cooldowns, no duplicate 0.5% fee on LP zaps; test seven-day/Day-2 boundaries, 3% Genesis sell burn, 50/50 reward vesting and auto-compound accounting against a real v4 PoolManager and six-decimal USDC.
- [ ] **G5 — Farm/Masonry LP interfaces:** use transferable/redeemable official vault shares end-to-end; add farms, boardroom, automation, withdraw/exit mechanics, and owner-safe fee distribution. Eliminate direct legacy `V4PositionWrapper` assumptions.
- [ ] **G6 — Risk calibration:** determine the actual chain, real PoolManager/USDC, tick range/spacing, liquidity floor, TWAP cadence, guard maximum output/input, stablecoin decimals, gas and exposed unofficial-pool bypass. Perform adversarial oracle-manipulation, tick crossing, dust, failure/escrow and immutable-boundary tests.
- [ ] **G7 — Live dApp integration, not a Wizard rebuild:** **preserve the already implemented four-step Setup Wizard and Admin**. Connect its validated launch files / predicted CREATE3 addresses to the completed Masonry deployer and verified deployed manifest; then wire live Genesis passes, staking, claims, zaps, swaps, burn dashboard, farms, Masonry and owner operations. Keep the existing draft import/export and deferred on-chain Genesis scheduling intact. Keep mobile-first UX and never present mock balances as live.
- [ ] **G8 — Release gate:** clean checkout, pinned dependencies, `node --test config/*.test.mjs`, `forge build`, `forge test`, full Foundry invariant/fork tests with fork RPCs, frontend build and Playwright, contract sizes, static/security review, external audit and chain-specific rehearsal. No funded deployment or live keeper until all pass.

## Confirmed constraints to preserve

- Protocol tokens LEVEL/SQUARE; UI may brand xTOMB/xSHARE through config, but token role mapping must remain explicit.
- No bond issuance, trading pause or governance timelock in the Masonry runtime.
- Both token sell taxes quadratic/config-driven with 12% hard ceiling; Genesis LEVEL sells have a 3% floor and burn their tax; buys and ordinary transfers are free.
- LP deposit and eligible compounding charge **one** 0.5% LP-share fee. Redeem LEVEL burns immediately; USDC is exclusively escrowed for future LEVEL buy/burn when unsafe, retried only through subsequent authorized Genesis activity. No second fee for conversion.
- Critical Defense triggers at fresh LEVEL TWAP <=0.90; exits only on two consecutive valid six-hour >1.01 observations; cannot reassign protected Treasury/user principal.
- Never hardcode chain-specific token/router addresses or assume Uniswap v2 LP tokens; use audited official Uniswap v4 PoolManager and fungible vault shares.
- SQUARE supply and vesting quantities in template remain intentionally incomplete until authorized; do not invent a split to make deployment pass.

## Reproduction and verification

From a clean checkout of `merge` (not an inherited legacy deployment):

`node scripts/install-contract-deps.mjs`
`node --test config/*.test.mjs`
`(cd contracts && forge build && forge test)`
`(cd frontend && npm ci && npm run build && npm run test:browser)`

Target-chain fork tests and CI receipts must accompany the eventual release commit. This reconciliation was based on branch diffs, source inspection and documented test claims; **Foundry was not installed in the current execution environment**, and direct git network access was unavailable.

## Provenance

The prior `docs/MASONRY_MERGE_PLAN.md` was written earlier in the porting process. Its statements that v4 hooks, native oracle and fungible LP vault **do not yet exist** are historical. The current component status above supersedes those specific old claims; the release blockers remain live until the full deployed system is validated.

Related: [PR #1](https://github.com/0xbasedev/v4-tomb/pull/1) · [PR #2](https://github.com/0xbasedev/v4-tomb/pull/2) · [current implementation detail](MASONRY_V4_IMPLEMENTATION_STATUS.md).
