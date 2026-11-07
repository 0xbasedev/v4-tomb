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

Legacy WETH/bond-era `Deploy.s.sol` is labeled as **not** Masonry launch logic. The dry-run path is `contracts/script/LaunchMasonryDryRun.s.sol` plus `contracts/test/integration/RobinhoodForkLaunch.t.sol`, which wires Masonry contracts (schedule, pass, hook, staking, Critical Defense) against Robinhood's PoolManager/USDG/WETH and does not deploy Boardroom/TrustNote/PegDefenseHook as the launch graph.

This legacy Treasury is still present for the inherited test suite. A modern Masonry expansion Treasury is not yet a separate runtime contract; expansion eligibility is enforced here and in `MasonryRules`.

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

The test also accepts the public RPC directly via `vm.createSelectFork`. It mines the LEVEL hook, seeds the official pool from anvil/`deal` balances, buys an Ultra pass with real USDG, deposits into Genesis, warms the native TWAP, sells through the hook, and ticks Critical Defense / the expansion gate.

## Validation (7 November 2026, America/New_York)

- Foundry: **422 passed, 0 failed, 7 skipped** (network-gated Base fork tests without `BASE_RPC_URL`). Includes the Robinhood dry-run (`test_DryRunMasonryLaunchAgainstRobinhoodInfra` passed against live chain 4663).
- Config: `node --test config/*.test.mjs` — **58 passed**, including the new Robinhood readiness tests.
- Frontend: `pnpm typecheck` and `pnpm build` passed (existing Vite chunk-size warning). Playwright: **77 passed**.

No private keys, no broadcast, no push, no live launch.

## Remaining blockers only Jesse can resolve

1. **Independent security audit** of the Masonry hooks, oracle, vaults, Genesis stack and the patched Treasury gates.
2. **Real launch keys and operator/scheduler signers**, plus a rehearsed key ceremony. This branch must not ship with an implicit first-caller operator.
3. **Verified on-chain addresses** written into `config/masonry-deployments.json` after a reviewed launch. Until then the UI stays on "Not launched yet".
4. **Official USDG vs USDC decision is settled for Robinhood (USDG)** but other chains still need their own official 6-decimal reference token before they can be enabled.
5. **Modern Masonry Treasury / Farm / Exit Now / distributor wiring** is still incomplete relative to the master product list. Legacy Treasury must not be launched as the Robinhood graph.
6. **X Bond** is named in the product, but merge has only the legacy TrustNote path, now bounded — not a Masonry X Bond contract.
7. **Oracle / liquidity calibration** on Robinhood (min active liquidity, vault ranges, hook gas, warmup procedure) before users can sell safely at launch.
8. **Placeholder chain icons** (including the Robinhood logo) and expansion networks marked coming soon until those forks are live.
9. **Explicit go-ahead to push or launch.** Nothing in this work is a production launch.
