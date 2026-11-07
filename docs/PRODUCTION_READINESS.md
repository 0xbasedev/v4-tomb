# Production readiness (local branch `chaos/aggressive-fire-tax`)

**Date:** 7 November 2026, America/New_York  
**Base:** local snapshot of `merge` plus the earlier Fire Tax, NFT upgrade, sale-open and Robinhood frontend commits (`db69caa` and parents).  
**Scope:** local checkout only. Nothing was pushed, launched, broadcast or signed.

Jesse's current rules take precedence over older handoff language: tokens are X Tomb, X Share and X Bond; Fire Tax is a 3% floor and 12% cap with an aggressive square-root curve that reaches 12% at 10% below peg, priced on the post-sale impact, decaying over 7 hours back to 3%; three soulbound Genesis NFTs at $50 / $100 / $500 are required, upgradable by paying the difference, with an admin sale-open switch and a 24-hour Ultra early lock drop; Robinhood Chain 4663 is first, pegged to USDG; an X Share/WETH Masonry stake token is acceptable.

## Structural fixes

| ID | Change | Test |
| --- | --- | --- |
| E1 | `Treasury.sol:617-628` no longer mints during bootstrap (or otherwise) unless `MasonryRules.eligibleForExpansion` sees a fresh TWAP strictly above 1.01 | `TreasuryProductionGates.t.sol` `test_E1_BootstrapDoesNotMintBelowOrAtPeg`, `test_E1_FreshTwapAboveCeilingMints` |
| O1 | `IOracle.isFresh` / `Oracle.sol` 30-minute freshness; Treasury `_oracleIsFresh` (`Treasury.sol:44`, `:666-670`) skips the mint when stale | `test_O1_StaleOracleSkipsMintAndAdvancesEpoch` |
| E2 | `checkEpoch` (`Treasury.sol:155-164`) fast-forwards `epoch` to the current wall-clock period so missed epochs cannot be minted one-by-one | `test_E2_MissedEpochsDoNotCatchUpMint` |
| Empty Masonry | `allocateSeigniorage` skips `_sendToBoardroom` when `IBoardroom.totalSupply() == 0` (`Treasury.sol:655-657`) instead of reverting | `test_EmptyMasonryDoesNotBrickEpoch` |
| G1 | Permissionless `MasonryGenesisLPBurnFee.retryDeferredBurn` (`MasonryGenesisLPBurnFee.sol:213`) retries stranded share redemption and USDG/USDC buyback-and-burn without a new Genesis deposit. The reserve still cannot be swept | `test_RetryDeferredBurnClearsStrandedUSDCWithoutGenesisDeposit`, `test_RetryDeferredBurnClearsStrandedSharesWithoutGenesisDeposit` |
| Initializers | Already bound to an immutable `_initializer` on Treasury and Boardroom; regression coverage added | `Treasury.t.sol` `test_Initialize_RejectsNonInitializer`; `Boardroom.t.sol` `test_Initialize_RejectsNonInitializer` |
| Bond bounds | Discount and premium percents capped at 100% (`MAX_BOND_DISCOUNT_PERCENT = 10_000`); max discount/premium rates capped at 2× peg | `test_SetDiscountPercent_Caps`, `test_SetMaxDiscountRate_Bounded` |

Legacy WETH/bond-era `Deploy.s.sol` is labeled as **not** Masonry launch logic. The dry-run path is `contracts/script/LaunchMasonryDryRun.s.sol` plus `contracts/test/integration/RobinhoodForkLaunch.t.sol`, which wires Masonry contracts (schedule, pass, hook, staking, Critical Defense, **MasonryTreasury, MasonryChamber, MasonryFarm, MasonryBond**) against Robinhood's PoolManager/USDG/WETH and does not construct Boardroom/TrustNote/PegDefenseHook or the legacy WETH Treasury as the launch graph.

The inherited WETH/bond `Treasury.sol` remains in the tree for the old test suite only.

## Frontend

- `frontend/src/lib/fireTax.ts` and `frontend/src/xtomb/policy.ts` now use the same integer square-root curve as `MasonryRules.targetSellTaxBps` (3% floor, 12% at 0.90 of peg, 7-hour linear decay).
- Launch policy invariants in `config/masonry-launch.template.json` / `config/masonry-launch.mjs`: `fireTaxBaselineBps = 300`, `fullTaxAtOrBelowPegBps = 9000`.
- Robinhood-facing copy reads the chain peg symbol from `config/frontend-networks.json` (`PEG.symbol` / `pegPair()`), so the live UI says USDG rather than USDC. Internal TokenIds such as `"USDC"` remain ABI-compatible keys.
- A 100 xTOMB preview sell at peg shows about **3.4%** because the hook taxes the projected post-sale price, not a flat 3%. That is expected.

## Launch readiness

- `config/validate-robinhood-launch.mjs` fails on missing deployment addresses, wei-looking whole-token fields, or a peg-decimals mismatch (USDG must be 6 decimals and match official infra). Current `masonry-deployments.json` is empty, so **readiness correctly fails** until verified addresses exist. Infrastructure-only validation of the current Robinhood config passes.
- Dry-run (no broadcast, no `PRIVATE_KEY`):

```sh
anvil --fork-url https://rpc.mainnet.chain.robinhood.com
cd contracts
forge test --match-contract RobinhoodForkLaunch --fork-url http://127.0.0.1:8545 -vvv
```

The test also accepts the public RPC directly via `vm.createSelectFork`. It mines the LEVEL hook, seeds the official pool from anvil/`deal` balances, buys an Ultra pass with real USDG, deposits into Genesis, warms the native TWAP, sells through the hook, ticks Critical Defense / the expansion gate, then launches MasonryTreasury + MasonryChamber + MasonryFarm + MasonryBond and exercises expansion, farm harvest and a below-peg buy / above-peg redeem.

## Modern Masonry runtime (7 November 2026, America/New_York)

| Piece | What it does | Key lines |
| --- | --- | --- |
| MasonryTreasury | Peg-token (USDG) TWAP expansion. Fresh validated TWAP strictly above 1.01; 30-minute freshness; fast-forward `epoch` so missed periods are not minted; skip when MasonryChamber `totalSupply() == 0`. Rate is a constructor PLACEHOLDER capped by `HARD_MAX_EXPANSION_BPS` (200). | `MasonryTreasury.sol:19-23`, `:29-31`, `:95-121` |
| MasonryChamber | Stake room for the configured X Share/WETH LP. Receives minted X Tomb. | `MasonryChamber.sol:53-61`, `:64-73` |
| MasonryFarm | Linear X Share emissions. First pool is X Share/WETH LP. Budget/duration PLACEHOLDERS from `square.farming` (25,641 whole tokens) and `policy.farmEmissionDays` (365). Empty periods do not catch up later stakers. | `MasonryFarm.sol:51-72`, `:78-84`, `:202-228` |
| MasonryBond | Buy below peg by burning X Tomb; redeem above peg 1:1 (PLACEHOLDER, no premium). Discount extra capped at `maxDiscountBps` ≤ 10_000 (2×). Debt cap `totalSupply <= circulating * maxDebtRatioBps / 10_000`. Absolute `maxBondSupply`. | `MasonryBond.sol:17-21`, `:82-118` |

PLACEHOLDER values used in tests and the fork dry-run (not approved tokenomics):

- `requestedRateBps = 200` (`policy.maximumExpansionPerEpochBps`)
- Farm budget `25_641 ether`, duration `365 days`
- Bond `maxDiscountBps = 10_000`, `maxDebtRatioBps = 3_500`, `maxBondSupply = 1_000_000 ether`
- Redemption price 1:1

Frontend: `treasury` / new keys `chamber`, `farm`, `xBond` in `config/masonry-deployment.mjs`; ABIs `masonryTreasuryAbi`, `masonryFarmAbi`, `masonryBondAbi`, `masonryChamberAbi`. Bond Office and Docs describe MasonryBond but keep actions disabled until a verified address exists.

## Validation (7 November 2026, America/New_York)

- Foundry: **442 passed, 0 failed, 7 skipped** (network-gated Base fork tests without `BASE_RPC_URL`). Includes the Robinhood dry-run (`test_DryRunMasonryLaunchAgainstRobinhoodInfra` passed against live chain 4663) and:
  - `MasonryTreasury.t.sol` (6)
  - `MasonryFarm.t.sol` (4)
  - `MasonryBond.t.sol` (6)
  - `MasonryProductionInvariants.t.sol` fuzz: no mint at/below peg, emissions ≤ schedule, bond debt ≤ cap, tax ≤ 12% (4 tests × 256 runs)
- Config: `node --test config/*.test.mjs` — **58 passed**.
- Frontend: `pnpm typecheck` and `pnpm build` passed (existing Vite chunk-size warning). Playwright: **77 passed**.

No private keys, no broadcast, no push, no live launch.

## Remaining blockers only Jesse can resolve

1. **Independent security audit** of the Masonry hooks, oracle, vaults, Genesis stack and the patched Treasury gates.
2. **Real launch keys and operator/scheduler signers**, plus a rehearsed key ceremony. This branch must not ship with an implicit first-caller operator.
3. **Verified on-chain addresses** written into `config/masonry-deployments.json` after a reviewed launch. Until then the UI stays on "Not launched yet".
4. **Official USDG vs USDC decision is settled for Robinhood (USDG)** but other chains still need their own official 6-decimal reference token before they can be enabled.
5. **Tokenomics numbers that this branch only placeholders:** bond `maxDebtRatioBps` / `maxBondSupply` / whether redemption should pay a premium; farm alloc-point splits beyond the required X Share/WETH LP pool; any expansion rate below the 2% hard cap. `requestedRateBps = 200`, farm `25_641` over 365 days, bond debt 35% and 1:1 redeem are test/dry-run fixtures, not signed policy.
6. **Exit Now / extra distributor wiring** is still open relative to the broader product list.
7. **Oracle / liquidity calibration** on Robinhood (min active liquidity, vault ranges, hook gas, warmup procedure) before users can sell safely at launch.
8. **Placeholder chain icons** (including the Robinhood logo) and expansion networks marked coming soon until those forks are live.
9. **Explicit go-ahead to push or launch.** Nothing in this work is a production launch.
