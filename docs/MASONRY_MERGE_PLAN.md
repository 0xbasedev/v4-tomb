# Masonry — cautious v4 backend merge (work in progress)

> **Not production ready.** This branch is a staging area for selective backend
> ports into Uniswap v4. It is intentionally based on
> `feat/chain-agnostic-config`, not a wholesale merge of legacy branches.
> Existing Old Money runtime economics and frontend still exist here. **Do not
> deploy as Masonry** until the old runtime is replaced and the complete
> integration/security checklist passes.

## Scope and provenance

| Input | Reuse strategy | Disposition |
| --- | --- | --- |
| `0xbasedev/v4-tomb:feat/chain-agnostic-config` | Preserve PoolManager, hook salt/address mining, swap settlement, deployment manifests, network validation and existing tests | Inherited as base |
| `Lodge-Capital/Masonry:codex/genesis-passes` | Rework same-owner ULTRA bridge, non-transferable pass, explicit automation/migration approvals | Design donor only, pending port |
| `Lodge-Capital/Masonry:2026-10-22-plain-tomb-fork` | Rework automation, pool-specific cooldowns, owner-independent activation licenses and fee routing | Design donor only, pending port; old v2 router, bonds and fees excluded |
| `Lodge-Capital/Masonry:cursor/twap-fire-tax-treasury-fix-b57b` | Keep TWAP manipulation regressions, seven-hour recovery requirements and Treasury expansion failure cases | Security test donor, pending v4 rewrite |
| `Lodge-Capital/Masonry:cursor/chaos-adversarial-tests-6b47` | Keep adversarial scenarios for keeper/treasury abuse, oracle manipulation and liquidity withdrawal | Security test donor, pending v4 rewrite |
| `Lodge-Capital/Masonry:2026-10-16-2335-layerzero-maintenance` | Rework peg-depth guard, monitoring lens, liquidity milestones and LayerZero bridge governance | Source reference only: v2 state assumptions must be removed |
| `0xbasedev/Masonry:main` | Preserve audited economic intent, admin/deployment wizard concepts and LP-first-class UX requirements | Legacy main, not merged into v4 runtime |

Current implementation here:
- `contracts/src/masonry/MasonryRules.sol`: pure SQUARE allocation conservation,
  hard 1,200-bps Fire Tax rate calculations, nonlinear peg-sensitive target,
  projected-trade/recovery combination, fixed seven-hour recovery floor, and
  strict fresh-TWAP-above-1.01 expansion eligibility with a 2% epoch ceiling.
- `contracts/src/masonry/MasonryLinearVesting.sol`: separately funded upfront
  and non-revocable linear vesting (one immutable beneficiary/asset per vault),
  permissionless beneficiary-only release, no admin sweep and exact funding checks.
- `config/masonry-launch.template.json`: partial launch defaults; intentionally
  **invalid** while the four vested SQUARE amounts and authorized LEVEL launch
  supply remain unset.
- `config/masonry-launch.mjs`: whole-token-level launch reconciliation and
  invariant checks. It is not yet wired to a deployment script or browser wizard.
- Foundry unit/fuzz tests and Node launch validator tests; existing v4 CI
  remains active on the `merge` branch.

## Economic invariants already agreed

- SQUARE supply defaults to 33,333, configurable **before deployment** with
  immutable deployed cap; default Farming inventory 25,641 across one year.
- Default launch allocations: Owner/Team/Dev 100 SQUARE + 5,000 LEVEL;
  Treasury 500 SQUARE + 5,000 LEVEL; Arbitrage 50 SQUARE + 1,000 LEVEL;
  SQUARE sale escrow 100; deployer allocation 1.
- Remaining default SQUARE vesting inventory: **6,941**, split among Team,
  Developer, Treasury and Arbitrage in the Launch Wizard. Splits are not yet
  authorized; no invented allocation has been committed.
- Operational vesting: 180-day configured default, distinct streams even
  when the Team and Developer beneficiaries share an address. Farm emissions:
  one year. No bond token/debt mechanics.
- Masonry expansion: fresh validated TWAP **strictly > 1.01**, max 2% of
  circulating LEVEL per eligible six-hour epoch, no catch-up, no below-peg
  bootstrap exception and no spot-only mint authority.
- Both token Fire Tax schedules: 1% at peg or above, quadratic default
  escalation, 12% at/below 0.85, **immutable 12% maximum**. SQUARE's
  separate 6% bootstrap override and native-asset fee destinations still
  need integration into new hooks/fee collectors.
- Fire Tax recovery: seven hours from a genuinely higher rate. Validated
  TWAP + projected execution price + recovery floor; guarded spot only as
  emergency fallback, not permission for minting.
- Genesis/Farm manual and automatic compounding: fixed three-hour
  cooldown **per beneficiary per pool**, never one global wallet cooldown.
- Genesis Pro/ULTRA: free Genesis automation (including Harvest All,
  Compound All and eligible Genesis-to-Farm migration); other Genesis users
  pay $50 once. Farms and Masonry automation cost a separate $50 each.
- Performance fees: 2% default per automation module, charged only on
  successfully processed claimable rewards; manual compounding exempt
  from automation performance fees.
- Arbitrage: native-asset shares of collected fees, initially 50 SQUARE
  and 1,000 LEVEL, no autonomous withdrawals from Treasury. LP/position
  receipts belong to Treasury, never the bot.
- Masonry Exit Now: instant bypass of stake/claim locks; 50% staked
  SQUARE/USDC LP forfeited to Treasury and 100% pending LEVEL rewards
  forfeited to Arbitrage.
- Each pool's max wallet/max sell automatically scales from verified,
  sustained pool liquidity, with bounded owner governance and launch
  anti-sniper restrictions.

## Mandatory port and integration gates (NOT complete)

1. Create `MasonryPegDefenseHook` for each official LEVEL/USDC and SQUARE/USDC
   v4 pool; validate mined hook flags, token ordering, 6-decimal USDC
   normalization, dynamic tax curve, actual trade-induced price impact,
   7-hour floor, bootstrap override, safe tax settlement and LP exemptions.
   Old Money's current PegDefenseHook still allows legacy economic settings
   and must NOT be deployed as Masonry.
2. Implement a v4 tick observation oracle, guarded spot fallback, donation
   resistance and fresh-data failure states. The strict expansion gate must
   be enforced on-chain in the new Treasury and Masonry reward modules.
3. Replace `V4PositionWrapper`: the inherited wrapper permits redemption
   only by the original NFT depositor. Deliver proportionally redeemable
   fungible v4 vault receipts with explicit tick-range accounting before
   migrating LP-based Farms/Masonry.
4. Port a reviewed Genesis Pro/ULTRA entitlement and same-owner bridge,
   fully funded reward budgets, 50/50 immediate/vested rewards, four-day
   configurable vesting, Fast Track, Harvest All / Compound All and
   automatic migration executor. The legacy pass branch explicitly lacks
   its auto-migration executor and uses incompatible reward economics.
5. Rebuild the native-asset fee collector and inventory accounting:
   separate protected Treasury, POL, Arbitrage and user assets; split
   exactly once by fee category; never route LP receipts to Arbitrage.
6. Implement official-v4-only adaptive Treasury arbitrage and autonomous
   multi-range POL, bounded position management, on-chain risk-controller,
   min liquidity/rebalance budgets and off-chain keeper with audited events.
7. Implement LEVEL/SQUARE max-wallet and v4 sell-size limits with exact
   protocol exemptions and multi-wallet/economic bypass analysis.
8. Wire the Launch Wizard to validated config, on-chain reconciliation,
   owner-only trading activation and per-chain deployment checks. No
   mainnet-ready defaults or silent authorization.
9. Add integration, invariant, adversarial and fork tests; run Foundry,
   static analysis, donation and oracle-manipulation scenarios, full
   frontend-independent deployment simulation and external audit.
10. **Frontend:** preserve only useful technical references. User explicitly
    requested a brand-new mobile-first frontend designed separately once
    backend and economics are final. Do not cherry-pick legacy page designs.

## Safety and release policy

No rebases or force pushes to `main`, `feat/chain-agnostic-config`, or
either Masonry repository. Every port must have a narrow, reviewable diff,
a provenance note and tests. Old Money legacy runtime and docs are preserved
only to avoid breaking upstream; they do not represent Masonry's approved
economics. This branch is a **backend integration workbench**, not a launch
candidate.

Deployment must remain blocked while the `MasonryPegDefenseHook`,
USDC-denominated oracle and real v4 LP receipt/fee settlement are absent.
