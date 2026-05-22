# Gap audit — 2026-05-22

End-to-end user-flow audit done after Base Sepolia deploy surfaced a critical missing piece (V4 LP token bridge). This document is the record of every cross-contract assumption gap found by walking through the user flow from "user has cbETH in their wallet" to "user claims MONEY rewards."

Sprints not yet started (14+) close most of these. The point of this doc is to make every gap explicit BEFORE more code ships, instead of discovering them after deploy.

For severity, "Critical" = blocks mainnet launch on a chain that holds real user money. "Important" = should fix before audit handoff. "Polish" = track in `SECURITY.md` / `SPRINTS.md`.

## Critical

### 1. V4 position NFT → ERC-20 wrapper missing
**Found:** 2026-05-22, after Base Sepolia deploy.

The reward pools (`GenesisRewardPool`, `MainRewardPool`, `ShareRewardPool`) expect ERC-20 LP tokens. V4 issues ERC-721 position NFTs via `PositionManager`. The pools sit empty until a wrapper exists.

**Status:** Sprint 16 (in progress). Building a V4 position wrapper — owns one position NFT, issues ERC-20 receipts. Multi-turn focused effort per the production quality bar.

### 2. Initial V4 pool liquidity is zero
The V4 MONEY/cbETH pool initializes with `sqrtPriceX96 = TickMath.getSqrtPriceAtTick(0)` but no actual liquidity. First swap would fail. Team must seed initial LP from the airdrop wallet's MONEY allocation + team-owned cbETH before genesis pool opens.

**Status:** Manual step documented in `DEPLOY.md`. Should be automated as `script/SeedLiquidity.s.sol` before mainnet. Sprint 16b or 17.

### 3. PegDefenseHook is materially weaker than Tomb's TaxOffice on fund flow
Tomb's `TaxOffice` did two things during contraction:
1. Burned MONEY directly (reducing supply, aggressive peg defense).
2. Routed tax revenue to a collector wallet that could feed Treasury reserves.

Our `PegDefenseHook` only sets a dynamic LP fee. The higher fee goes to LPs, nothing is burned, nothing flows to Treasury. **The deterrent on selling is preserved (higher cost = less selling), but the value capture for the protocol is gone.**

Original commit (`078947a feat(hooks): add PegDefenseHook`) flagged "sell tax with returnDelta routing to Treasury" as Sprint 4b deferred. **That deferral is a real Tomb-fidelity gap, not just a polish item.**

**Status:** Decision needed. Either (a) accept the softening as a deliberate design choice — document and move on; (b) build the `beforeSwapReturnDelta` tax routing properly before mainnet, restoring Tomb's burn-during-deep-contraction mechanic.

### 4. Deployer is the operator of everything pre-Timelock
After the Sepolia deploy, the deployer EOA is `operator` / `trustees` of: Treasury, Boardroom, OldMoney, Estate, TrustNote, Oracle, PegDefenseHook, GenesisRewardPool, MainRewardPool, ShareRewardPool. They can mint MONEY, pause epoch ticks, drain reward pools (after the 90-day governance window), rotate operators, etc.

**Status:** Sprint 14 was supposed to deploy the Timelock and rotate ownership of every contract to it. Until that ships, do NOT advertise Sepolia as testnet-ready for outside users.

### 5. No automated seed-liquidity / governance-rotation scripts
Tied to #2 and #4. The post-deploy ceremony is currently undocumented as a script.

**Status:** Two scripts to write before mainnet: `SeedLiquidity.s.sol` (closes #2) and `RotateGovernance.s.sol` (closes #4 once Timelock deploys).

## Important

### 6. No coverage report run
Pre-deploy gate (1) from `feedback_pre_deploy_gates.md`. Easy: `FOUNDRY_PROFILE=coverage forge coverage --report summary`. Should be ≥95% on `src/core/` + `src/oracle/`, 100% on `src/tokens/`.

### 7. Audit invariant sweep (10k runs × 200 depth) never run
Pre-deploy gate (1). Should run once via `FOUNDRY_PROFILE=audit forge test --match-path "test/invariant/*"` before audit handoff.

### 8. Reward pools deployed empty of LP-token entries
After the wrapper deploys, operator must call `pool.add(allocPoint, lpToken, false, 0)` on each. Tracked in `DEPLOYED.md` pending-steps section.

### 9. MainRewardPool / ShareRewardPool thin test coverage vs GenesisRewardPool
`GenesisRewardPool` has 20 dedicated unit tests; the other two have ~8 and ~3 respectively. Same MasterChef shape, but new code paths in `MainRewardPool` (epoch boundary math) deserve their own coverage. Sprint 15.

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
