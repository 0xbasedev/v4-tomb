# Masonry v4 integration status

**Branch:** `merge`, based on `feat/chain-agnostic-config`  
**Status:** Genesis settlement and compounding, both official v4 hooks, native TWAP, and fee routing are integrated and tested locally. Target-chain calibration and deployment wiring remain open.
**Governance:** no new timelock or owner-activated trading pause.

## Genesis contracts

- The hook and staking deployment must share one immutable Genesis clock. Rewards and the LEVEL sell tax window begin at the start timestamp and end exactly seven days later. The official LP staking and compounding entry points open at start + 24 hours and close at Genesis end. Accrued claims and principal withdrawals remain callable after Genesis. Ultra may pre-stake in the standard pool during the 24 hours before Genesis, with rewards starting at the same time and rate for every tier.
- Genesis, Pro and Ultra passes are soulbound and cost 50, 100 and 500 USDC respectively. Treasury receives the USDC directly. All staking and reward entry points require membership. Pro and Ultra can opt in to a chosen keeper with a minimum net LP output. Manual and keeper compounding share the same per-beneficiary, per-source-pool three-hour clock. All tiers use the same reward formula and position accounting.
- The staking implementation accepts one standard stake asset plus the LP vault shares. It allocates 75% of scheduled emissions from Day 2 onward to LP, using the master spec's emission split. It credits only net shares after one 50-bps fee on each deposit or compound. The bound settlement adapter handles vesting, guarded conversion and liquidity minting.
- `MasonryLevelHook` binds to one static-fee LEVEL/USDC v4 pool. Every sell selects the maximum of the ordinary TWAP target, projected execution target, recovery floor and (during Genesis) 300 bps. The ceiling is 1,200 bps. A single LEVEL debit is burned immediately during Genesis. Outside Genesis, the ordinary tax goes to the immutable fee recipient. Genesis floor activation never changes the ordinary recovery state. Buys and wallet transfers incur zero LEVEL tax.
- The hook previews the sale in the actual PoolManager and rolls the preview back. For exact input it projects using the largest net input possible at the applicable tax floor, which can be more conservative than the final fill. Exact output uses the simulated LEVEL input to gross up the debit. Partial previews revert. Genesis dust that cannot satisfy both integer fee bounds also reverts. The hook rejects sells when its native oracle cannot supply a valid price. Pools created independently without this hook are outside its enforcement.

## Genesis reward settlement

- Every settled reward is split 50/50 into liquid LEVEL and a beneficiary-owned escrow tranche, with any odd base unit assigned to escrow. Vesting uses the newer four-day schedule as sixteen claim-gated six-hour installments. The first installment opens at Genesis end plus six hours, and each subsequent interval starts when the prior installment is claimed. This implementation uses the same schedule for all three tiers and has no early unlock.
- The 2% claim-to-wallet fee goes to Treasury and applies to liquid claims, vesting releases and any LEVEL refund from compounding. The 2% keeper performance fee applies only to the liquid amount processed by authorized automation. Manual compounding carries no performance fee. Claims and compounds share the existing per-beneficiary, per-source-pool three-hour cooldown.
- Manual and opted-in keeper compounds submit the LEVEL sell amount and desired gross LP shares, with a minimum net share floor. The pool-bound guard verifies the conversion. The swap pays the applicable single LEVEL sell tax. The vault mints shares to staking, where the separate 0.5% LP fee is assessed once and only net shares are credited to the beneficiary. Unused inputs go to the beneficiary and are capped at 3% plus rounding dust. Failed compounds revert reward, escrow, trade, fee and cooldown changes together.

## Native LEVEL TWAP and guarded buyback

- The LEVEL hook creates a pool-bound oracle and records initialized state, completed swaps, and changes to active liquidity. The oracle computes a geometric time-weighted price from cumulative ticks and normalizes LEVEL/USDC to 18-decimal price units. It requires a checkpoint 30–60 minutes back, continuously adequate active liquidity throughout that measured interval, and a real price-moving swap within the last 30 minutes. Permissionless checkpoints preserve history but do not refresh the last swap time. Same-timestamp swaps cannot add time at their new tick.
- The buyback guard verifies spot deviation from TWAP, checks active liquidity at both endpoints, and previews the exact USDC swap in the real v4 PoolManager with a gas cap. The preview crosses initialized ticks, requires full input and positive output, and reverts to discard state changes. The guard checks post-swap impact and TWAP-implied execution loss, then returns the preview output as the execution minimum. Compounding uses the corresponding guarded LEVEL sale, which budgets for the immutable maximum Fire Tax and uses the same preview and exact settlement checks. The collector verifies real USDC spend and LEVEL receipt before burning. The vault, guard and collector must agree on the pool key.
- Startup and oracle outages use the existing fail-closed sell policy. Buys continue, and optional USDC conversion defers without blocking Genesis deposits or reversing the LEVEL portion's burn. Deployment must maintain sufficient liquidity, checkpoint the seeded pool and verify warmup before launch. Thin or inactive markets can cause automatic sell rejection. No spot-only fallback is implemented.
- The active-liquidity floor and the guard's three tolerances are immutable deployment choices. Guard tolerances are capped at 5% each. These checks require target-chain calibration and adversarial review. Endpoint checks do not certify minimum active liquidity at every intermediate tick.

## Official LEVEL/USDC LP vault

`MasonryLevelUsdcVault` owns a single immutable tick range directly in the v4 PoolManager. Each share represents one unit of liquidity and a pro-rata share of collected fees. Any holder can redeem their shares for the underlying assets. Deposit caps and redemption floors apply independently to LEVEL and USDC, and direct transfers into the vault do not enter the fee ledger. Deposits collect outstanding position fees first and contribute a proportional amount toward those reserves, which preserves earlier holders' claims.

The vault checks its pool key against the LEVEL hook's bound pool. The Genesis LP burn collector checks that the vault and buyback target use the same pool key. Redemption and buyback execute in separate PoolManager unlocks. The fixed range is a deployment choice and requires range and liquidity sizing before launch.

## SQUARE Fire Tax and Treasury routing

- The separate SQUARE/USDC hook uses the same sell-only tax engine, with a SQUARE reference price supplied at deployment. The 6% bootstrap floor applies during the seven-day Genesis window. One charge applies per sell, capped at 12%. Buys and ordinary token transfers remain untaxed.
- Normal collections earmark 12% of the fee for Treasury POL, 20% for the Treasury USDC reserve and 68% as native SQUARE. Fresh LEVEL TWAP can activate or clear Critical Defense under its existing epoch rules. Critical mode assigns 100% of new SQUARE tax to LEVEL buy-and-burn, while existing allocations retain their purpose. An unavailable LEVEL oracle preserves the last confirmed mode and prevents unsafe routes.
- Guarded optional processing runs during eligible SQUARE sells, with capped input and gas. The reserve leg sells SQUARE for Treasury USDC. The critical leg sells SQUARE, purchases LEVEL and immediately burns the output. The POL leg adds to the bound fixed-range SQUARE/USDC vault and mints redeemable LP shares to Treasury. SQUARE and USDC leftovers stay in their earmarked balances. Failed legs roll back independently so the original sell can settle. No separate public fee processing entry point is available.
- If a router prepays SQUARE against a synced PoolManager balance, the hook collects that sale's tax as v4 currency claims to preserve settlement. Treasury receives its retained portion as redeemable v4 SQUARE claims in that case, and protocol claims are materialized on later eligible sells.

## Committed source and behavior

| Component | Current behavior | Limitations |
| --- | --- | --- |
| `src/masonry/MasonryGenesisLPBurnFee.sol` | Receives exactly 50 bps of LEVEL/USDC LP vault shares from an authorized Genesis caller; redeems a bounded amount, burns LEVEL immediately, attempts bounded USDC->LEVEL buyback/burn via the existing v4 exact-input router; failed optional operations leave accounted shares/USDC for the **next authorized Genesis call only** | Direct staking uses the new vault in local integration tests. Native guard, real v4 buyback and compound settlement tested locally. |
| `src/masonry/MasonryFeeAllocation.sol` | Pure collection-time SQUARE tax buckets: normal 12% earmarked SQUARE for SQUARE/USDC POL, 20% earmarked SQUARE to convert into USDC reserve, 68% native SQUARE retained. Critical Defense routes 100% of **new eligible** fee revenue into SQUARE -> USDC -> LEVEL buy-and-burn | Used by the SQUARE hook and fixed-range POL vault. Existing earmarks are preserved across defense changes. |
| `src/masonry/MasonryCriticalDefense.sol` | Permissionless lazy mode: enter at fresh TWAP <=0.90, exit after two consecutive real six-hour checkpoints each with fresh TWAP strictly >1.01; stale data never ends defense | SQUARE fee collection synchronizes against the native LEVEL oracle and preserves mode on stale data. |
| `src/masonry/MasonryRules.sol` | Existing pure SQUARE allocation, maximum 12% nonlinear Fire Tax and strict fresh >1.01 expansion predicates | Both hooks use the tax rules. Treasury expansion mint wiring remains open. |
| `src/masonry/MasonryCompoundGate.sol` | Existing per-user per-pool three-hour Genesis/Farm compounding cooldown | Genesis shares one native claim/compound clock. The standalone gate remains available for future Farm integration. |

The LP burn module has no public `processFees()` entrypoint. Only an authorized Genesis deposit/compound can invoke `collectAndProcess()`. Nested helper functions are callable only by the module itself; optional external failures are caught so the deposit can continue. Explicit owner updates are immediate. Deferred burn reserves have **no owner sweep or Treasury reassignment path**.

## Required wiring — not yet implemented

1. Wire the new fixed-range vault into deployment and the downstream LP-based Farm and Masonry flows. Validate range sizing and rounding, direct-pool donation handling, one-sided positions, and the interaction between spot movement and fee redemption on the target chain.
2. Calibrate oracle minimum active liquidity, buyback tolerances, liquidity sizing and keeper checkpoint cadence. Adversarially test sustained manipulation of the single-pool feed, liquidity withdrawal, tick gaps, inactive markets and chain timing. Benchmark preview gas on the target chain and verify startup and recovery procedures.
3. Configure the official LEVEL and SQUARE pool prices, mined hook deployment, shared schedule, vault ranges, route bounds, Treasury, and immutable binder addresses. Bind the settlement and SQUARE POL vault once, authorize Genesis in the LP fee collector, and fund the verified reward budget before Genesis starts. Validate alternate routers, sell limits and bypass via unofficial pools on the target chain.
4. Wire SQUARE Treasury destinations and exercise reserve conversion and POL redemption in a deployment rehearsal. Multi-range autonomous POL and Treasury arbitrage are outside the fixed-range implementation.
5. Complete multi-pool Genesis support, any additional tier terms, Harvest All, Compound All, Robot Arms and Farm migration. Finalize unused emissions and rounding-dust handling, plus any separately approved deposit fee policy. Verify guarded buyback and compound plans on the target chain.
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

The Foundry suite covers the Genesis window, Day 2 boundary, tier prices and nontransferability, equal reward weight, keeper authorization and cooldown, one LP fee, and post-end claims and withdrawals. Unit tests use mock settlement and LP redemption. Local integration exercises real claims and vesting, manual and keeper compounds, rollback on minimum-share failure, and one fee assessment per compound.

The LEVEL hook suite uses a locally deployed Uniswap v4 PoolManager and six-decimal USDC. Controlled-price cases cover exact-input and exact-output sells, tick crossing, the same-sale ceiling, recovery across Genesis end, immediate burn, buys, transfers and partial-fill rejection. Native oracle cases cover warmup, staleness, thin liquidity, and same-timestamp price changes. Guard tests cover spot deviation, execution loss, price impact, preview rollback and exact settlement across an initialized tick. A local integration test also stakes real vault shares, verifies immediate LEVEL burn when the oracle is stale, and retries the deferred USDC through the native guard and MiniSwapRouter once the oracle is ready. Vault tests cover transferable redemption, fee dilution, direct donations, slippage, and pool-key matching. SQUARE integration exercises reserve conversions, Treasury POL mint and redemption, prepaid router settlement, unsafe-route deferral, and critical burns that preserve earlier earmarks. The existing Base fork tests require `BASE_RPC_URL`.

To reproduce locally:

```sh
node scripts/install-contract-deps.mjs
node --test config/*.test.mjs
cd contracts
forge test
```
