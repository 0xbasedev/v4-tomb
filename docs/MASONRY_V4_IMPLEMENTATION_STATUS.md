# Masonry v4 integration status — Decision 83 tranche

**Branch:** `merge`, based on `feat/chain-agnostic-config`  
**Status:** isolated backend code committed; **not production ready**.  
**Frontend:** intentionally untouched.  
**Governance:** no new timelock or owner-activated trading pause.

## Committed source and behavior

| Component | Current behavior | Limitations |
| --- | --- | --- |
| `src/masonry/MasonryGenesisLPBurnFee.sol` | Receives exactly 50 bps of LEVEL/USDC LP vault shares from an authorized Genesis caller; redeems a bounded amount, burns LEVEL immediately, attempts bounded USDC->LEVEL buyback/burn via the existing v4 exact-input router; failed optional operations leave accounted shares/USDC for the **next authorized Genesis call only** | Requires a correct fungible v4 LP vault with proportional redemption, hardened validated oracle/executable-impact guard, and Genesis staking+auto-compound integration. Legacy wrapper cannot be used. |
| `src/masonry/MasonryFeeAllocation.sol` | Pure collection-time SQUARE tax buckets: normal 12% earmarked SQUARE for SQUARE/USDC POL, 20% earmarked SQUARE to convert into USDC reserve, 68% native SQUARE retained. Critical Defense routes 100% of **new eligible** fee revenue into SQUARE -> USDC -> LEVEL buy-and-burn | Not yet attached to an actual Uniswap v4 hook fee collector or vault. Existing earmarks must not be reallocated. |
| `src/masonry/MasonryCriticalDefense.sol` | Permissionless lazy mode: enter at fresh TWAP <=0.90, exit after two consecutive real six-hour checkpoints each with fresh TWAP strictly >1.01; stale data never ends defense | Needs audited fresh-TWAP adapter. Must synchronize on fee collection and maintain conservative allocations during oracle outage. |
| `src/masonry/MasonryRules.sol` | Existing pure SQUARE allocation, maximum 12% nonlinear Fire Tax and strict fresh >1.01 expansion predicates | Not yet enforcing executed v4 swap or mint path. |
| `src/masonry/MasonryCompoundGate.sol` | Existing per-user per-pool three-hour Genesis/Farm compounding cooldown | Not yet called by the actual Genesis auto-compounder. |

The LP burn module has no public `processFees()` entrypoint. Only an authorized Genesis deposit/compound can invoke `collectAndProcess()`. Nested helper functions are callable only by the module itself; optional external failures are caught so the deposit can continue. Explicit owner updates are immediate. Deferred burn reserves have **no owner sweep or Treasury reassignment path**.

## Required wiring — not yet implemented

1. Replace existing `V4PositionWrapper` with a **real fungible position vault** with proportional ERC20-share redemption. `wrappedBy[tokenId]` in the inherited wrapper prevents fungible redemption by a non-original depositor. The vault must actually remove proportional Uniswap v4 liquidity through the PositionManager, settle exact token balances and prevent donation/fee dilution.
2. Add a correct validated LEVEL/USDC TWAP feed and **execution guard**. `minimumLevelOut(usdcAmount)` MUST independently validate freshness, price manipulation, maximum swap impact, tick crossing, amount out and slippage, not trust only a router quote or untrusted caller input. Neither token/USDC decimal normalization nor v4 multi-tick simulation is implemented in this tranche.
3. Implement the **Masonry-specific LEVEL/USDC and SQUARE/USDC hooks**. The inherited `PegDefenseHook` is Old Money/WETH, has mutable legacy 100% tax tiers, and is NOT a Masonry hook. Enforce on-chain <=12% Fire Tax, sell-only, simulated price *after* the user's trade and seven-hour tax recovery. Exact-input and exact-output swaps, alternative routers, spoofed hook data and fee delta signs require adversarial integration tests.
4. Implement SQUARE fee collector: collection-time 12/20/68 earmarks, optional same-user-transaction routing on official v4 pools, safe fallback of already earmarked assets without blocking valid trades, and 100% eligible new revenue buy-and-burn in Critical Defense. No standalone `processFees()` or trading pause. Do not sell Treasury LEVEL for USDC.
5. Wire the Genesis deposit path: transfer gross vault shares, invoke `collectAndProcess(gross)`, credit **only net shares**, and have auto-compound call it on every successful eligible 3-hour compound. Prevent a second conversion-route fee on zap-to-Genesis. Do not modify the user's six-hour stake cooldown during authorized auto-compound.
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

Foundry unit tests added:
- `test/unit/MasonryGenesisLPBurnFee.t.sol`: immediate fee burning, defer-on-swap-failure, defer-on-redemption-failure, retry, bounded execution, authorization, low-value rounding.
- `test/unit/MasonryFeeAllocation.t.sol`: exact normal and critical splits, conserved token balances including rounding.
- `test/unit/MasonryCriticalDefense.t.sol`: trigger, two-epoch recovery, stale/missed checkpoints, re-entry.

**These tests are committed but have not been executed successfully in this session**: the local environment has no Foundry compiler, and GitHub reported no CI workflow runs on `merge` at inspection time. Do not describe them as passing without verification.

To validate in a Foundry-equipped working tree:

```sh
node scripts/install-contract-deps.mjs
cd contracts
forge fmt --check
forge build
forge test --match-path 'test/unit/Masonry*' -vv
forge test -vv
```

The next deliverable must integrate **real Uniswap v4** settlement and proportional LP redemption, then get passing CI/integration tests before merging to main.
