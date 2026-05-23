# Sprint roadmap

Single-page map of every sprint shipped to date plus the work that remains. Read this first if you've been away from the project for a while or if a new contributor joins.

For per-finding security triage, see [SECURITY.md](SECURITY.md).
For deploy commands and env vars, see [DEPLOY.md](DEPLOY.md).

## ✅ Shipped (in order)

| # | Sprint | Commit | What landed |
|---|---|---|---|
| 0 | Bootstrap | `c1aa943` | Foundry workspace + OZ v5 + Solady + V4 core/periphery + CI workflow + .gitignore |
| 1 | $MONEY token | `4bea848` (later refactored to `69ef6e0` for Tomb fidelity) | `OldMoney.sol` — ERC20Burnable + ERC20Permit + Trustees base, mint gated to trustees, public burn / trustees-only burnFrom, `distributeReward` one-shot mint of 11k/140k/9k |
| 1 | $ESTATE token | `0dc660d` (later refactored to `69ef6e0`) | `Estate.sol` — 70k cap, 59.5k/5.5k/5k allocation split, internal linear vesting over 365 days via `claimRewards`, devFund-controlled rotation quirk preserved |
| 1 | $TRUSTNOTE token | `69ef6e0` | `TrustNote.sol` — minimal bond token, mint+burnFrom trustees-only, no Permit (Tomb-faithful) |
| 2 | Oracle | `0a1d76b` | `Oracle.sol` + `Epoch.sol` + `IOracle` + `IPriceSource` — period-windowed TWAP, Tomb's exact interface, tick-cumulative source instead of V2 pair cumulative (only internal deviation) |
| 3 | Treasury + Boardroom | `70de0a5` | `Treasury.sol` (the engine, 18.5KB) + `Boardroom.sol` (TheClub) + `ContractGuard` + interfaces. Full Tomb mechanics including 9-tier expansion table, bond discount/premium math, 6h epochs |
| 4 | PegDefenseHook (V4) | `078947a` | `PegDefenseHook.sol` + `BaseV4Hook.sol` — V4 hook replacing Tomb's TaxOffice. afterInitialize binds the hook to one pool; beforeSwap records tick cumulatives (implementing IPriceSource for Oracle) AND returns a dynamic fee based on signed deviation from peg |
| 5 | Distributor | `363fa50` | `Distributor.sol` — tiny aggregator that calls `distribute()` on a list (Tomb-faithful) |
| 6 | Timelock | `882557c` | `Timelock.sol` — direct port of Compound/Tomb. 14d grace, 1d-30d delay, two-step admin transfer |
| 7 | Integration test: full epoch cycle | `d2b4e82` | `test/integration/EpochCycle.t.sol` — deploy full stack, expansion → staker claim → contraction → bond purchase → recovery → bond redemption at premium. Uses MockOracle. |
| 8 | Invariant tests | `33d7305` | OldMoney + Estate + Boardroom handler-style invariants. 250k+ random calls per invariant at the default profile, 0 reverts |
| ~ | Tuning + cleanup | `b336811`, `e14962b`, `4b6a7c2`, `860125c` | YAML CI fix, gas-snapshot tracking, deep/audit profile split, **$OLDM → $MONEY rename** |
| 9 | Slither | `9f95adc` | 0 HIGH / 0 MEDIUM after fixes. ReentrancyGuard added to Treasury, CEI applied to buyBonds, divide-before-multiply reordered, every mint() return checked via `require`. Full triage in [SECURITY.md](SECURITY.md) |
| 10 | Gas optimization | `6ae9eba` | Five state vars marked `immutable` (Epoch._startTime + Estate timing rates). `via_ir` profile evaluated and rejected (mixed wins on this codebase). Gas snapshot committed as regression baseline |
| 11 | Base mainnet fork test | `206f9c1`, `6e23eb6` | `test/integration/BaseFork.t.sol` (MockOracle) + `BaseForkHook.t.sol` (real PegDefenseHook + real V4 PoolManager init). 12 fork tests against live Base infrastructure |
| 12a-c | Deploy script | `3dcad41`, `5c0acfa` | `Deploy.s.sol` + `MockCbeth.sol` + `Addresses.sol` (per-chain V4 + cbETH) + `HookMiner.sol` (CREATE2 salt) + `DEPLOY.md`. Wired with reward pools in 13c |
| 13a | GenesisRewardPool | `5bc1754` | 24h MasterChef farm, 11k MONEY, 20 unit tests |
| 13b | MainRewardPool + ShareRewardPool | `69b5aa2` | Multi-epoch 140k MONEY + 370d 59.5k ESTATE pools, smoke tests |
| 13c | Wire pools into deploy | `5c0acfa` | Deploy.s.sol now deploys the three reward pool contracts itself and uses them as distributeReward recipients. Drops GENESIS_POOL/MAIN_POOL/FARMING_POOL env vars |

**Current totals:** 253 tests across 18 suites in ~5s. 0 Slither HIGH/MED. 25 commits on `main`.

## 🚧 Remaining (in suggested order)

| # | Sprint | Status | What it adds |
|---|---|---|---|
| 4b | PegDefenseHook tax routing (Tomb burn-during-contraction) | **DONE** 2026-05-22 (`72a1c3d` + `a296c11` + `f2ed8dd` + `06ed22a`) | Tomb-faithful 14-tier tax slice on sells; burn below 1.10e18 or route to Treasury above. 28 unit + 5 fork + 4 fuzz tests. Permission bits `0x1088`. Closes gap #3 / BUG #3. |
| 16 | V4 LP wrapper for Main + Share reward pools | **DONE** 2026-05-22 (`d0b9f75` + `c809217` + `2d6586f`) | `V4PositionWrapper.sol` — wraps V4 position NFTs into ERC-20 shares stakeable in MasterChef pools. 15 unit + 4 fork tests. Deploy script wires it into Main + Share pools as 100-weight entry. Closes gap #1. |
| 14 | Timelock deploy + governance rotation | **DONE** 2026-05-22 (`f05fdb2`) | Three scripts (`DeployTimelock`, `RotateGovernanceQueue`, `RotateGovernanceExecute`) walk the deployer through transferring ownership of every admin-bearing contract to a Compound-style Timelock. 6 ceremony tests in `GovernanceRotation.t.sol` verify every role transfers correctly and the former deployer can no longer mutate. `docs/GOVERNANCE.md` documents the model. Closes gap #4 (single-EOA admin risk pre-launch). |
| 17 | Initial V4 pool seed-liquidity script | **DONE** 2026-05-22 (this commit) | `SeedLiquidity.s.sol` pulls MONEY + WETH from operator wallet via Permit2, mints a full-range V4 position via PositionManager. 3 fork tests verify the seed works end-to-end against real Base V4. Resulting NFT is wrappable via V4PositionWrapper. Closes gap #2. |
| 14 | Timelock deploy + ownership transfer ceremony | not started | `script/DeployTimelock.s.sol` + a separate `transferOwnership` script that walks every contract: token Ownable2Step transfers, hook trustees transfer, Treasury setOperator, etc. Plus a `docs/GOVERNANCE.md` checklist |
| 15 | MainRewardPool + ShareRewardPool full test coverage | partial | Bring those two up to GenesisRewardPool's 20-test level. Multi-staker + multi-pool + pro-rata + emergency withdraw + governance recovery. Less critical but nice for audit completeness |
| 16 | Merkle airdrop contract (OPTIONAL) | not started | If you want on-chain proof-based airdrop claims for the 9k MONEY allocation. Tomb didn't have this — purely a modernization choice |
| 17 | Frontend bootstrap | not started | Vite + React + Viem + Wagmi + Tailwind workspace. Pages: Dashboard, TheClub (Boardroom), TheVault (reward pools), TrustNotes (bonds), Swap, Docs. Aesthetic per `memory/reference_eighties_skill` |
| 18 | Frontend integration | not started | Wire pages to deployed contracts, read epoch state, render peg, build stake/withdraw/buyBonds/redeemBonds flows |
| 19 | Audit prep | not started | Run `FOUNDRY_PROFILE=audit forge test` (10k invariant runs), `forge coverage --report summary`, write `docs/ARCHITECTURE.md` + `docs/PEG_MECHANICS.md` + `docs/HOOKS.md` |
| 20 | Mainnet deploy | gated | Pre-deploy gate checklist green; multisig in place; audit done |

## 📋 Outstanding TODOs (small, polish-pass)

From `docs/SECURITY.md`:
- Emit `OperatorTransferred(prev, next)` on `Treasury.setOperator` and `Boardroom.setOperator`
- Add explicit `is IBasisAsset` / `is IDistributor` annotations on `OldMoney`, `TrustNote`, `Distributor`
- Resolve two `shadowing-local` cases by renaming the inner variable

From `docs/DEPLOY.md`:
- After deploy: operator must call `.add(allocPoint, lpToken, false, 0)` on each reward pool for each LP token pair to support (e.g., MONEY/cbETH V4 LP, USDC/cbETH)
- Seed initial liquidity into the V4 MONEY/cbETH pool from the airdrop wallet allocation BEFORE genesis pool opens

## 🛑 Things we explicitly chose NOT to do

- **Presale.** Tomb did fair launch via genesis pool. We're matching that. (Decision: 2026-05-22, locked in `memory/project_old_money.md`.)
- **Pausable on tokens.** Tomb didn't have it; would be censorship vector concentrated in one key per `ETHSKILLS/security/`.
- **Aggressive storage packing in Treasury.** Would require uint256 → uint16 type changes on settable percentages, breaking the ABI shape that auditors expect from a Tomb fork.
- **`via_ir` build profile by default.** Mixed wins (Treasury +3%, Boardroom +12%, Timelock -12%) — not worth the build-time cost.
- **Per-mint event spam** (`events-maths` Slither LOW findings) — high-level events cover what indexers actually need.

## 📚 Where to look for context

- **Why a decision was made:** `git log --oneline` + commit body
- **Tomb-fidelity rationale:** `memory/feedback_tomb_fidelity.md`
- **Pre-deploy gate definitions:** `memory/feedback_pre_deploy_gates.md`
- **Per-chain V4/cbETH addresses:** `memory/reference_v4_deployments.md` + `src/libs/Addresses.sol`
- **Frontend aesthetic:** `memory/reference_eighties_skill.md`
