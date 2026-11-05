# Handoff — Masonry local launch (for Cursor / Copilot)

Branch `claude/local-launch` · base `merge` @ a8d1ea5 · written 2026-11-05 by Claude.

## User decisions (latest — take precedence over older docs)

- **xBOND:** later, after launch. Keep the Bonds page as a labelled planned preview. No bond behavior in Treasury for this launch.
- **Chains:** Base first. BSC joins later as an xSHARE bridge satellite (Bridged xSHARE), one xSHARE and one 33,333 cap. No simultaneous BSC Genesis, which also avoids BSC's 18-decimal Binance-Peg USDC (the Masonry contracts require 6).
- **xSHARE supply:** parameterize `ShareToken` (done here). xTOMB uses `PegToken` as-is.
- Public names xTOMB / xSHARE; source names PegToken / ShareToken. Everything else is as in `docs/CLAUDE_NEXT_STEPS.md` (7-day Genesis, LP at +24h, 50/100/500 USDC passes with equal weighting, Genesis xTOMB sell tax 3%–12% burned, buys and transfers untaxed, Genesis may deploy unscheduled, CreateX/CREATE3 for every project address).

## Done in this branch

`contracts/src/tokens/ShareToken.sol` now takes `ShareToken.Config` in its constructor:

- `name`, `symbol`, `maxSupply` (hard cap on cumulative minting, enforced in `_update`)
- `initial[]` allocations minted at deploy
- `farmingAllocation` minted once via `distributeReward`
- optional legacy linear drip (`communityFundAllocation`, `devFundAllocation`, `vestingStart`, `vestingDuration`)
- new `totalMinted` and `totalBurned` counters

Old getters (`FARMING_POOL_REWARD_ALLOCATION`, `VESTING_DURATION`, …) remain as immutables. `ShareTokenProfiles.legacy(...)` reproduces the Tomb-exact ESTATE schedule (cap 70,001). `script/Deploy.s.sol` and all 14 legacy call sites use it.

**Tests actually run:** `forge test --no-match-path 'test/integration/BaseFork*'` gave 425 passed, 1 skipped, 0 failed. One test needs `mkdir -p contracts/deployment-output` in a fresh checkout. **Not run:** Base fork suites (need `BASE_RPC_URL`).

## Not done — next steps, in order

1. **Masonry xSHARE profile + test.** Add `ShareTokenProfiles.masonry(...)` built from `config/masonry-launch.template.json`:
   - name/symbol `xSHARE`, cap 33,333e18
   - initial: sale escrow 100, deployer 1, ownerTeamDeveloper 100, treasury 500, arbitrage 50, and the vesting buckets minted to `MasonryLinearVesting` contracts (amounts still `null` in the template; the Wizard sets them)
   - farming 25,641 via `distributeReward` to the Farm
   - no legacy drip

   Unit-test: cap enforcement, sum == cap, `distributeReward` once, `totalBurned`.
2. **xTOMB.** `PegToken` works as-is: ERC20 + `burn` (satisfies `IMasonryBurnableLevel`), owner `mint`. Never call its legacy `distributeReward`. Launch mints launch funding (template `level.initial`), the Genesis reward budget and seed liquidity. Open: the template's `authorizedLaunchSupply` and the Genesis reward budget are unset, so pick them. PegToken has no `totalBurned` counter (status-doc item 6). Either add one like ShareToken's, or track burns from events.
3. **`script/DeployMasonryLocal.s.sol`** for anvil. The inherited `Deploy.s.sol` is WETH-era. Copy the assembly order from `test/integration/MasonryLevelHook.t.sol` (setUp and the helpers around lines 700–830):
   1. 6-decimal mock USDC
   2. v4 `PoolManager`
   3. PegToken + ShareToken
   4. `MasonryGenesisSchedule(0, scheduler)` (unscheduled)
   5. mined `MasonryLevelHook` (creates the oracle)
   6. `MasonryLevelUsdcVault`
   7. `MasonryBuybackGuard`
   8. `MiniSwapRouter`
   9. `MasonryGenesisLPBurnFee`
   10. `MasonryGenesisPass`
   11. `MasonryGenesisSettlement`
   12. `MasonryGenesisStaking`
   13. `MasonryCriticalDefense`
   14. `MasonrySquareHook` + `MasonrySquareUsdcVault`
   15. seed liquidity and checkpoint the oracle
   16. `settlement.bind(staking)`, `lpBurnFee.setGenesis(staking)`, `squareHook.bindPolVault`, `staking.fund()`

   For CREATE3 on anvil, `vm.etch` the CreateX runtime at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` (verify against `factoryCodeHash` in `config/create3-plan.mjs`), then deploy through `DeployMasonryComponent`-style calls so planned addresses match. Write the result in the `config/masonry-deployments.json` shape (parser: `config/masonry-deployment.mjs`, chain 31337 must be allowed for local runs).
4. **UI against anvil.** With a deployment entry the app leaves Preview automatically (`src/lib/hooks/useNetworkStatus.ts`). Then add a Playwright profile that runs against anvil to cover the paths not yet tested: a confirmed transaction, a rejected signature, a wrong chain mid-flow and Admin `schedule(uint256)`. The write path is `src/lib/hooks/useActions.ts`.
5. **Regenerate ABIs** after contract changes. Recompile, export to `frontend/abi-handoff`, then `cd frontend && node scripts/gen-abis.mjs abi-handoff`. Typecheck and fix callers.
6. **Bridge activation** stays off until reciprocal peers, ISMs, route limits and relayer support are verified. Keep unavailable routes greyed out.

## Known facts that bite

- `MasonryGenesisPass.purchase` reverts while Genesis is unscheduled (`end() == 0`). Pass sales and staking open only after `schedule()`. The UI already says so.
- Staking `fund()` must happen before Genesis starts, and `schedule()` requires staking funded and settlement bound (Admin checks this).
- PulseChain needs the bridge compiled for Shanghai (`foundry.toml` restriction already set).
- Frontend: `pnpm install --frozen-lockfile && pnpm test:browser` (65 tests, all Preview mode).
