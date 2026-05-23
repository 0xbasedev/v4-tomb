# Gap audit — 2026-05-22

End-to-end user-flow audit done after Base Sepolia deploy surfaced a critical missing piece (V4 LP token bridge). This document is the record of every cross-contract assumption gap found by walking through the user flow from "user has cbETH in their wallet" to "user claims MONEY rewards."

Sprints not yet started (14+) close most of these. The point of this doc is to make every gap explicit BEFORE more code ships, instead of discovering them after deploy.

For severity, "Critical" = blocks mainnet launch on a chain that holds real user money. "Important" = should fix before audit handoff. "Polish" = track in `SECURITY.md` / `SPRINTS.md`.

## Critical

### 1. V4 position NFT → ERC-20 wrapper missing — ✅ CLOSED 2026-05-22
**Found:** 2026-05-22, after Base Sepolia deploy. **Scope clarified:** 2026-05-22 (same day). **Closed:** 2026-05-22 (commits `d0b9f75` + `c809217` + this commit).

`MainRewardPool` and `ShareRewardPool` expect ERC-20 LP tokens. V4 issues ERC-721 position NFTs via `PositionManager`. Sprint 16 closed the gap with `V4PositionWrapper.sol`:

- Bound to one specific `(poolId, tickLower, tickUpper)` per wrapper instance
- `wrap(tokenId)` pulls the NFT, mints ERC-20 equal to position liquidity
- `unwrap(tokenId)` burns shares, returns NFT — gated to original wrapper
- ERC-20 freely transferable (so it's stakeable in MasterChef pools)
- 15 mock-based unit tests + 4 real-V4 Base-fork integration tests

The deploy script now deploys the wrapper bound to the full-range MONEY/WETH pool, and registers it as a 100-weight stake entry in both Main and Share reward pools. End-to-end Sepolia dry-run completes cleanly (32M gas estimate).

**GenesisRewardPool was never blocked on the wrapper** — it accepts outside ERC-20 tokens (WETH, USDC) directly as the mini-ICO stake.

### 2. Initial V4 pool liquidity is zero
The V4 MONEY/cbETH pool initializes with `sqrtPriceX96 = TickMath.getSqrtPriceAtTick(0)` but no actual liquidity. First swap would fail. Team seeds initial LP from the airdrop wallet's 9k MONEY allocation + team-owned cbETH **simultaneously with the genesis pool opening**, so that genesis stakers who earn MONEY have a place to swap it.

**Status:** Manual step documented in `DEPLOY.md`. Should be automated as `script/SeedLiquidity.s.sol` before mainnet. Sprint 16b or 17.

### 3. PegDefenseHook is materially weaker than Tomb's TaxOffice on fund flow — ✅ CLOSED 2026-05-22
Tomb's `TaxOffice` did two things during contraction:
1. Burned MONEY directly (reducing supply, aggressive peg defense).
2. Routed tax revenue to a collector wallet that could feed Treasury reserves.

Our `PegDefenseHook` originally only set a dynamic LP fee. Sprint 4b extended it with `beforeSwapReturnDelta` to take a slice of MONEY swap input and either burn (below `burnThreshold = 1.10e18`) or route to Treasury (at or above).

**Closed by:**
- Design doc: `docs/HOOK_TAX_DESIGN.md` (commit `8befc42`)
- Contract: extension to `PegDefenseHook.sol` (commit `72a1c3d`) with 14-tier Tomb-exact table, burnThreshold + treasury + excludedAddresses, autoCalculateTax master switch off by default
- Unit tests: 28 new tests in `PegDefenseHook.t.sol` (commit `a296c11`)
- Fork integration tests: 5 new tests against real Base V4 PoolManager (commit `f2ed8dd`)
- Fuzz invariants: 4 new tests (commit `b6d31cd` / pending)

### 4. Deployer is the operator of everything pre-Timelock — ✅ CLOSED 2026-05-22
After the Sepolia deploy, the deployer EOA was `operator` / `trustees` of: Treasury, Boardroom, OldMoney, Estate, TrustNote, Oracle, PegDefenseHook, GenesisRewardPool, MainRewardPool, ShareRewardPool.

**Closed by Sprint 14.** `DeployTimelock.s.sol` + `RotateGovernanceQueue.s.sol` + `RotateGovernanceExecute.s.sol` walk the deployer through transferring every admin role to a Compound-style Timelock with a 24h delay (configurable). 6 integration tests in `test/integration/GovernanceRotation.t.sol` verify the ceremony works end-to-end. Final state: deployer EOA has no admin power; Timelock controls everything via queue/execute. See `docs/GOVERNANCE.md` for the full ceremony.

### 5. No automated seed-liquidity / governance-rotation scripts
Tied to #2 and #4. The post-deploy ceremony is currently undocumented as a script.

**Status:** Two scripts to write before mainnet: `SeedLiquidity.s.sol` (closes #2) and `RotateGovernance.s.sol` (closes #4 once Timelock deploys).

## Important

### 6. No coverage report run
Pre-deploy gate (1) from `feedback_pre_deploy_gates.md`. Easy: `FOUNDRY_PROFILE=coverage forge coverage --report summary`. Should be ≥95% on `src/core/` + `src/oracle/`, 100% on `src/tokens/`.

### 7. Audit invariant sweep (10k runs × 200 depth) never run
Pre-deploy gate (1). Should run once via `FOUNDRY_PROFILE=audit forge test --match-path "test/invariant/*"` before audit handoff.

### 8. Reward pools deployed empty of pool entries
Operator must call `pool.add(allocPoint, stakeToken, false, 0)` to make each pool functional. Breakdown:
- `GenesisRewardPool.add(allocPoint, cbETH, false, 0)` — **CAN BE DONE NOW** on Sepolia. cbETH is the outside-asset stake token. No wrapper dependency.
- `MainRewardPool.add(allocPoint, wrappedLp, false, 0)` — blocked on Sprint 16 wrapper.
- `ShareRewardPool.add(allocPoint, wrappedLp, false, 0)` — blocked on Sprint 16 wrapper.

Should be automated as `script/OpenPools.s.sol` (one script that does all three calls once the wrapper exists, or run in phases as each gets unblocked).

### 9. MainRewardPool / ShareRewardPool thin test coverage vs GenesisRewardPool
`GenesisRewardPool` has 20 dedicated unit tests; the other two have ~8 and ~3 respectively. Same MasterChef shape, but new code paths in `MainRewardPool` (epoch boundary math) deserve their own coverage. Sprint 15.

### 16. Boardroom-empty bricks expansion
**Found:** 2026-05-22 during the post-launch user-flow re-walk.

When `Treasury.allocateSeigniorage()` enters the expansion branch (price > ceiling), it calls `_sendToBoardroom` → `Boardroom.allocateSeigniorage(amount)`. Boardroom requires `totalSupply() > 0` (matches Tomb). **If no ESTATE has been staked yet, this reverts — and since `checkEpoch`'s postfix runs AFTER the body, the epoch never advances.** Treasury is bricked until someone stakes.

At launch the only ESTATE in circulation is 1 unit on the deployer (constructor seed) + slow vesting drips to community/dev funds. The 59.5k ESTATE in `ShareRewardPool` is locked and only emits to stakers of that pool's stake tokens, which require the LP wrapper. So the brick window is real.

**Status:** Operational fix — the launch ceremony must include staking at least 1 wei of ESTATE into the Boardroom from the deployer. Tomb handled this the same way (not a contract change, a ceremony step). Closed by `script/OpenLaunch.s.sol`.

## Polish (tracked in `SECURITY.md`)

### 10-12. Slither LOW / INFO findings
- `OperatorTransferred` events missing on `Treasury.setOperator` / `Boardroom.setOperator` (LOW)
- `is IBasisAsset` annotations not declared on tokens (INFO)
- Two `shadowing-local` cases (LOW)

### 13-14. Documentation gaps
- `docs/ARCHITECTURE.md` not written
- `docs/PEG_MECHANICS.md` not written
- `docs/HOOKS.md` not written

## What was validated (no gap)

| Concern | Verified |
|---|---|
| Oracle period matches Treasury PERIOD | ✓ Both 6h |
| `seigniorageSaved` starts at 0 because distribute happens after init | ✓ |
| `epochStart = vestingStart` default sequencing | ✓ |
| `Addresses.hasCbeth()` returns false on testnet → MockCbeth path used | ✓ |
| Hook permission bits encoded in deployed address (`0x...1080`) | ✓ |
| All token decimals are 18 (cbETH, MONEY, ESTATE, TRUSTNOTE) — no USDC-6-decimal trap | ✓ |
| `LPFeeLibrary.DYNAMIC_FEE_FLAG` set on pool init so dynamic-fee override actually applies | ✓ |
| Treasury `excludedFromTotalSupply` includes the reward pool addresses post-Sprint-13c | ✓ |

## Process change to prevent recurrence

Saved as `memory/feedback_user_flow_walkthrough.md`. Required before every sprint that modifies `src/`:

1. User-flow walkthrough first, code second.
2. Cross-contract assumption sweep — explicitly enumerate every assumption each new/modified contract makes about the surrounding ecosystem.
3. Tomb-fidelity audit on every ported contract: does V4/Base produce the same shapes Tomb assumed?
4. End-of-sprint cross-check: re-run the walkthrough including the just-shipped code.
