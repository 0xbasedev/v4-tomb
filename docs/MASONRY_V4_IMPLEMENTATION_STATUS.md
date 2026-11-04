# Masonry v4 integration status

**Branch:** `merge`, based on `feat/chain-agnostic-config`  
**Status:** Genesis staking, LEVEL hook and LEVEL/USDC vault tested locally. Production adapters and deployment wiring remain open.
**Governance:** no new timelock or owner-activated trading pause.

## Genesis contracts

- The hook and staking deployment must share one immutable Genesis clock. Rewards and the LEVEL sell tax window begin at the start timestamp and end exactly seven days later. The official LP staking and compounding entry points open at start + 24 hours and close at Genesis end. Accrued claims and principal withdrawals remain callable after Genesis. Ultra may pre-stake in the standard pool during the 24 hours before Genesis, with rewards starting at the same time and rate for every tier.
- Genesis, Pro and Ultra passes are soulbound and cost 50, 100 and 500 USDC respectively. Treasury receives the USDC directly. All staking and reward entry points require membership. Pro and Ultra can opt in to a chosen keeper with a minimum net LP output. Manual and keeper compounding share the same per-beneficiary, per-source-pool three-hour clock. All tiers use the same reward formula and position accounting.
- The staking implementation accepts one standard stake asset plus the LP vault shares. It allocates 75% of scheduled emissions from Day 2 onward to LP, using the master spec's emission split. It credits only net shares after one 50-bps fee on each deposit or compound. The external settlement adapter handles vesting, conversion and liquidity minting.
- `MasonryLevelHook` binds to one static-fee LEVEL/USDC v4 pool. Every sell selects the maximum of the ordinary TWAP target, projected execution target, recovery floor and (during Genesis) 300 bps. The ceiling is 1,200 bps. A single LEVEL debit is burned immediately during Genesis. Outside Genesis, the ordinary tax goes to the immutable fee recipient. Genesis floor activation never changes the ordinary recovery state. Buys and wallet transfers incur zero LEVEL tax.
- The hook previews the sale in the actual PoolManager and rolls the preview back. For exact input it projects using the largest net input possible at the applicable tax floor, which can be more conservative than the final fill. Exact output uses the simulated LEVEL input to gross up the debit. Partial previews revert. Genesis dust that cannot satisfy both integer fee bounds also reverts. The hook rejects sells when the oracle adapter cannot supply a valid price. Pools created independently without this hook are outside its enforcement.

## Official LEVEL/USDC LP vault

`MasonryLevelUsdcVault` owns a single immutable tick range directly in the v4 PoolManager. Each share represents one unit of liquidity and a pro-rata share of collected fees. Any holder can redeem their shares for the underlying assets. Deposit caps and redemption floors apply independently to LEVEL and USDC, and direct transfers into the vault do not enter the fee ledger. Deposits collect outstanding position fees first and contribute a proportional amount toward those reserves, which preserves earlier holders' claims.

The vault checks its pool key against the LEVEL hook's bound pool. The Genesis LP burn collector checks that the vault and buyback target use the same pool key. Redemption and buyback execute in separate PoolManager unlocks. The fixed range is a deployment choice and requires range and liquidity sizing before launch.

## Committed source and behavior

| Component | Current behavior | Limitations |
| --- | --- | --- |
| `src/masonry/MasonryGenesisLPBurnFee.sol` | Receives exactly 50 bps of LEVEL/USDC LP vault shares from an authorized Genesis caller; redeems a bounded amount, burns LEVEL immediately, attempts bounded USDC->LEVEL buyback/burn via the existing v4 exact-input router; failed optional operations leave accounted shares/USDC for the **next authorized Genesis call only** | Direct staking uses the new vault in local integration tests. Production buyback guard and the compound settlement adapter remain open. |
| `src/masonry/MasonryFeeAllocation.sol` | Pure collection-time SQUARE tax buckets: normal 12% earmarked SQUARE for SQUARE/USDC POL, 20% earmarked SQUARE to convert into USDC reserve, 68% native SQUARE retained. Critical Defense routes 100% of **new eligible** fee revenue into SQUARE -> USDC -> LEVEL buy-and-burn | Not yet attached to an actual Uniswap v4 hook fee collector or vault. Existing earmarks must not be reallocated. |
| `src/masonry/MasonryCriticalDefense.sol` | Permissionless lazy mode: enter at fresh TWAP <=0.90, exit after two consecutive real six-hour checkpoints each with fresh TWAP strictly >1.01; stale data never ends defense | Needs audited fresh-TWAP adapter. Must synchronize on fee collection and maintain conservative allocations during oracle outage. |
| `src/masonry/MasonryRules.sol` | Existing pure SQUARE allocation, maximum 12% nonlinear Fire Tax and strict fresh >1.01 expansion predicates | LEVEL hook uses the tax rules. Mint and SQUARE enforcement remain open. |
| `src/masonry/MasonryCompoundGate.sol` | Existing per-user per-pool three-hour Genesis/Farm compounding cooldown | Not yet called by the actual Genesis auto-compounder. |

The LP burn module has no public `processFees()` entrypoint. Only an authorized Genesis deposit/compound can invoke `collectAndProcess()`. Nested helper functions are callable only by the module itself; optional external failures are caught so the deposit can continue. Explicit owner updates are immediate. Deferred burn reserves have **no owner sweep or Treasury reassignment path**.

## Required wiring — not yet implemented

1. Wire the new fixed-range vault into deployment and the downstream LP-based Farm and Masonry flows. Validate range sizing and rounding, direct-pool donation handling, one-sided positions, and the interaction between spot movement and fee redemption on the target chain.
2. Add a correct validated LEVEL/USDC TWAP feed and **execution guard**. `minimumLevelOut(usdcAmount)` MUST independently validate freshness, price manipulation, maximum swap impact, tick crossing, amount out and slippage, not trust only a router quote or untrusted caller input. Neither token/USDC decimal normalization nor v4 multi-tick simulation is implemented in this tranche.
3. Complete the production LEVEL oracle adapter and fee recipient. Bind deployment to the same official pool, LEVEL token, USDC, schedule and vault used by Genesis and fee buybacks. Validate oracle startup/liveness, warmup and guarded spot fallback policy, miner/deployer wiring, initialization price, alternate routers, gas across sparse tick ranges, sell limits and bypass via unofficial pools. Deploy the separate SQUARE hook.
4. Implement SQUARE fee collector: collection-time 12/20/68 earmarks, optional same-user-transaction routing on official v4 pools, safe fallback of already earmarked assets without blocking valid trades, and 100% eligible new revenue buy-and-burn in Critical Defense. No standalone `processFees()` or trading pause. Do not sell Treasury LEVEL for USDC.
5. Implement and audit the Genesis reward settlement adapter. Enforce reward vesting, claim/deposit fee and tier terms, the stake/claim cooldowns, slippage, the separate 0.5% conversion fee exclusion on Genesis LP routes, and keeper performance-fee accounting. Complete multi-pool support, Harvest All, Compound All, Robot Arms and migration to Farm. Finalize the funding allocation and disposition of unused emissions and rounding dust. Configure the production LP fee collector and validate guarded buyback within the staking transaction on the target chain.
6. Wire correct token burn accounting (the new LEVEL token must expose cumulative total burned; Genesis's LP-fee counter is a subset, never added twice).
7. Fork-test **actual** v4 PoolManager/PositionManager actions, USDC six decimals, tick crossing, malicious hooks, zero/dust fees, exact LP redeem costs, dead zones and unsafe oracle transitions. Existing unit tests use explicit mocks and **do not prove deployed AMM behavior**.

## Non-negotiable economics and owner control

- Normal SQUARE Fire Tax: **12% SQUARE/USDC protocol-owned auto-LP; 20% SQUARE -> USDC reserve; 68% retained SQUARE**. All allocations are **shares of collected tax**, not percentages of gross user sales.
- Critical Defense: verified LEVEL TWAP <=0.90 automatically redirects 100% of **new eligible** fee revenue to LEVEL buy-and-burn, without reassigning prior earmarks, user capital, Treasury principal, LP positions or Arbitrage principal.
- Exit Critical Defense only on validated >1.01 readings in consecutive six-hour checkpoints; missed/stale samples never count retroactively.
- Never convert Treasury-held LEVEL into USDC for general fee routing. LEVEL from LP-fee redemption burns; the collected USDC purchases additional LEVEL then burns it.
- Genesis LEVEL/USDC LP burn fee: exactly **50 bps of deposited receipt shares** per deposit or successful auto-compound. A zap ending in this pool pays this fee *instead of* a second 50-bps protocol conversion-route fee. The LP fee is not the separate Genesis pool deposit fee routed to Treasury.
- Normal v4 pool trading must NOT have an owner/keeper pause switch. Onchain safety checks may reject unsafe individual operations; optional secondary buyback must not revert a valid original sale/deposit.
- No governance timelocks. Whitelists are configurable and take effect immediately; no whitelisted router permits arbitrary users to borrow exemptions.
- Existing user reward escrow, protected assets and the owner's one-call Treasury withdrawal requirement remain intact and distinct.

## Testing status

The Foundry suite covers the Genesis window, Day 2 boundary, tier prices and nontransferability, equal reward weight, keeper authorization and cooldown, one LP fee, and post-end claims and withdrawals. Reward settlement uses a mock. The unit tests use mock LP redemption.

The LEVEL hook suite uses a locally deployed Uniswap v4 PoolManager, six-decimal USDC and a mock TWAP. It covers exact-input and exact-output sells, tick crossing, the same-sale ceiling, recovery across Genesis end, immediate burn, buys, transfers and partial-fill rejection. A local integration test also stakes real vault shares, redeems the fee into LEVEL and USDC, verifies immediate LEVEL burn, and retries the deferred USDC through MiniSwapRouter after a mock guard allows execution. Vault tests cover transferable redemption, fee dilution, direct donations, slippage, and pool-key matching. The existing Base fork tests require `BASE_RPC_URL`.

To reproduce locally:

```sh
node scripts/install-contract-deps.mjs
node --test config/*.test.mjs
cd contracts
forge test
```
