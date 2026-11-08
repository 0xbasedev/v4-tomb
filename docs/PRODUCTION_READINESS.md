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

## Modern Masonry runtime (8 November 2026, America/New_York)

Configurable tokenomics live in `config/masonry-launch.template.json` and are
checked by `validateMasonryLaunch` and the Solidity constructors /
`MasonryLaunchConfig.load`. Whole-token amounts (`square.farming`,
`policy.bondMaxSupply`) are scaled by on-chain decimals in the dry-run.
The launch dry-run and `RobinhoodForkLaunch` read that file.

| Knob | Default | Bounds |
| --- | --- | --- |
| `policy.maximumExpansionPerEpochBps` | 200 | 1–200 (2% hard cap) |
| `square.farming` | 25,641 whole X Share | > 0; must reconcile with SQUARE cap |
| `policy.farmEmissionDays` | 365 | 1–3650 |
| `policy.farmShareWethLpAllocPoints` | 1000 | ≥ 1 |
| `policy.bondMaxDiscountBps` | 10000 | 0–10000 (2×) |
| `policy.bondMaxDebtRatioBps` | 3500 | 1–10000 |
| `policy.bondMaxSupply` | 1,000,000 whole xBOND | ≥ 1 |
| `policy.bondRedeemPremiumBps` | 0 | 0–10000 |
| `policy.criticalOracleMaxAgeSeconds` | 1800 | 1–1800 |
| `policy.fireTaxBaselineBps` | 300 | ≥ 300 (3% floor) and ≤ hard cap |
| `policy.fireTaxHardCapBps` | 1200 | ≥ baseline and ≤ 1200 (12% max) |
| `policy.fullTaxAtOrBelowPegBps` | 9000 | fixed (12% at 10% below peg) |


### Protocol-owned range manager (8 November 2026, America/New_York)

Official POL for xTOMB/USDG and xSHARE/USDG is a concentrated Uniswap v4
position that recenters with spot, not a full-range or fixed-tick book.

- `MasonryRangeLib.sol` — width, alignment, inner-band and TWAP-deviation math.
- `MasonryRangeManager.sol` — one instance per official pool. Permissionless
  `rebalance()` / `nudge()`; `donate()` and hook `depositFromHook` add
  inventory. There is no admin withdrawal; leftovers stay idle until they
  can be deployed again.
- Defaults are now **per pool** (see `docs/RANGE_OPTIMIZATION.md`): xTOMB/USDG
  half-width **2000 bps (±20%)**, recenter **1600 bps (±16%)**; xSHARE/USDG
  half-width **800 bps (±8%)**, recenter **640 bps (±6.4%)**. Both use
  cooldown **1800s** and max TWAP deviation **300 bps**. Bounds: width 500–3000,
  recenter 100–width, cooldown 60–86400, deviation 1–1000.
- Safety: valid TWAP, spot within max deviation, pool liquidity floor,
  cooldown, same-block guard. Recentering uses the current tick only after
  those checks (spot ≈ TWAP). After removing the old band the manager
  swaps leftover inventory through the official pool (price-limited to the
  TWAP-deviation band) so the new range can be two-sided. Inventory value
  at the pre-rebalance spot cannot fall more than 100 bps
  (`MAX_INVENTORY_LOSS_BPS`). The swap pays the pool LP fee, never Fire Tax:
  `MasonryTaxHook` skips tax and nested `nudge` when the swap sender is the
  bound range manager.
- SquareHook `bindPolVault` now takes `IMasonryPolSink`, so POL deposits
  go into the managed position when that is bound. `MasonryTaxHook` can
  one-shot `bindRangeManager` and will try `nudge()` after a swap without
  reverting the user swap (500k gas stipend; skipped if the swap is low on
  gas or `nudge` would revert).
- User Genesis `MasonryLevelUsdcVault` / redeemable `MasonrySquareUsdcVault`
  stay fixed-range so Genesis redeem/burn and `V4PositionWrapper` exact-tick
  wrapping stay compatible. MasonryChamber continues to stake user
  X Share/WETH LP — not the protocol-owned SQUARE/USDG range.

| Knob | Default | Bounds |
| --- | --- | --- |
| `policy.rangeLevel.halfWidthBps` | 2000 | 500–3000 |
| `policy.rangeLevel.recenterBps` | 1600 | 100–(half width − 1) |
| `policy.rangeLevel.cooldownSeconds` | 1800 | 60–86400 |
| `policy.rangeLevel.maxTwapDeviationBps` | 300 | 1–1000 |
| `policy.rangeSquare.halfWidthBps` | 800 | 500–3000 |
| `policy.rangeSquare.recenterBps` | 640 | 100–(half width − 1) |
| `policy.rangeSquare.cooldownSeconds` | 1800 | 60–86400 |
| `policy.rangeSquare.maxTwapDeviationBps` | 300 | 1–1000 |

### Exit Now (handoff 2026-11-07)

`MasonryChamber.exitNow` (`MasonryChamber.sol`): bypasses the 6-hour
manual-deposit stake lock and the independent 6-hour claim lock. Returns
50% of that user's staked X Share/WETH LP, sends the other 50% to the
protocol treasury, and forfeits 100% of pending X Tomb to Arbitrage.
Ordinary withdraw after the stake cooldown still returns 100% of remaining
LP and does not pay LEVEL. Exit Now does not redeem LP or transfer X Tomb
to the user, so it is not a tax-free Fire Tax exit.

### Wrong-chain UI

`ChainGate` no longer replaces the page. Off Robinhood (or a wallet on
another chain) the current page stays visible in read-only mode under a
banner: “Coming soon on {chain}” plus “Switch back to Robinhood Chain”.
Writes stay disabled until the user is on live Robinhood with a verified
deployment. On Robinhood without a deployment the pages also stay visible
under a “Not launched yet” banner.

## Validation (8 November 2026, America/New_York)

- Foundry: **465 passed, 0 failed, 7 skipped**. Includes the Robinhood fork dry-run and:
  - `MasonryTreasury.t.sol` (7)
  - `MasonryFarm.t.sol` (4)
  - `MasonryBond.t.sol` (7)
  - `MasonryChamber.t.sol` (4, including Exit Now / no LEVEL paid to the user)
  - `MasonryProductionInvariants.t.sol` fuzz (4 × 256)
  - `MasonryRangeLib.t.sol` (7, including follow vs fixed-peg vs peg-anchor coverage at a depeg) and `MasonryRangeManager.t.sol` (6, both official pool shapes, plus nudge stipend / thin-pool / unauthorized deposit, and RangeRebalanced principal/fee/swap accounting)
  - `MasonryPooledRangeVault.t.sol` (4, local share-vault prototype: two-user redeem, depeg redemption wave, follow abandoning peg, fixed band staying on peg)
- Config: `node --test config/*.test.mjs` — **61 passed**, including per-pool range-manager bound checks.
- Frontend: `pnpm typecheck` passed. Playwright: **79 passed** (desktop + mobile, including protocol range status).

No private keys, no broadcast, no push, no live launch.

## Remaining blockers only Jesse can resolve

1. **Independent security audit** of the Masonry hooks, oracle, vaults, Genesis stack, Treasury, Farm, Bond and Chamber.
2. **Real launch keys and operator/scheduler signers**, plus a rehearsed key ceremony.
3. **Verified on-chain addresses** written into `config/masonry-deployments.json`. Until then writes stay disabled.
4. **Other-chain peg tokens**: Robinhood uses USDG; other chains still need their own official 6-decimal reference token before they can be enabled.
5. **Sign off or replace the configurable defaults** in the table above (especially bond debt ratio / supply, redeem premium, farm alloc splits beyond the required X Share/WETH LP pool, and any expansion rate below 2%).
6. **Oracle / liquidity calibration** on Robinhood before users can sell safely at launch.
7. **Placeholder chain icons** (including the official Robinhood logo).
8. **Explicit go-ahead to push or launch.** Nothing in this work is a production launch.
