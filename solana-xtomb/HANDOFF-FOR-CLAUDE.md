# Handoff for Claude — from Bingo

Jess asked me to put my Solana repo on GitHub where you can see it, write down
everything I've done, and ask you a question at the end. This is that note.
Straight facts; where something is unverified or not done, it says so.

## What this repo is

The Solana xTOMB program: a single Anchor program (Anchor 0.30.1, Solana
1.18.26) implementing the Masonry / v4-tomb design on Solana, built by me from
`SOLANA-XTOMB-SPEC.md`. Regular SPL tokens (not Token-2022): **xTOMB**,
**xSHARE**, **xBOND**, 6 decimals. Passes (Genesis / Pro / Ultra) are Metaplex
Core NFTs, frozen at mint (soulbound), upgraded in place for the price
difference. 18 instructions. Keeper scripts (`scripts/keeper.ts`,
`scripts/peg-bot.ts`) support `--dry-run`.

Status: **deployed to devnet and initialized.**

- Program: `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY`
- Genesis funded with the full 30,000 xTOMB budget; test Genesis window
  **Nov 7 → Nov 14, 2026** (it is a test window, not the launch).
- Full addresses — config PDA, mints, vaults, mock USDC — are in
  `DEPLOY-REPORT.md`, which is the verified record.
- The config's `usdc_mint` is a mock USDC, permanently for this deployment
  (there is no `set_usdc_mint` instruction; a real stable means a fresh
  deploy).
- **Ultra pass price already changed $500 → $300** and the program was
  redeployed and verified on-chain Nov 8 (upgrade tx and state checks in the
  `DEPLOY-REPORT.md` addendum). Upgrade deltas derive from the price function:
  Genesis→Pro +$50, Pro→Ultra +$200, Genesis→Ultra +$250.
- Tests: Rust unit **11/11**, bankrun **18/18**, frontend builds clean.
- Reports in the repo: `SOLANA-XTOMB-SPEC.md` (the spec),
  `MORNING-REPORT.md` (the build), `DEPLOY-REPORT.md` (the deployment).

Key design points in the program: deposit fee, LP fee, and withdrawal Fire Tax
are **three separate implementations** (Jess corrected an earlier reading of
mine — the standard-pool deposit-fee logic is *not* reusable for the LP fee);
hard on-chain cap of one compound per user per pool per 3 hours; withdrawal
Fire Tax (1% baseline, quadratic to a 12% cap, Genesis minima 3%/6%);
bootstrap of 2 epochs at 3% only when TWAP is above $0.90; expansion only on a
fresh TWAP strictly above $1.01, capped at 2% per epoch; xBOND buy/redeem
gated on TWAP; lazy epochs; four-wallet fee split.

## What is NOT done on the Solana side

- **No pools added yet.** Jess's call (Nov 8): pools come from the launch
  config wizard, not manual `add_pool` calls.
- **No pass bought and no stake tested on-chain yet.** Nothing has transacted
  against the live program beyond deployment, initialization, and the price
  redeploy. Live ≠ exercised.
- **No vesting-release instruction.** The 6,941 xSHARE vesting bucket is
  funded and sitting in its vault; there is no instruction to release it.
- **No live TWAP feed.** A designated oracle authority posts the TWAP
  (30-minute freshness, fails closed when stale); the initial $1.00 was posted
  at deploy. `peg-bot.ts` has no live price source wired.
- **Pass prices are still hardcoded constants** (`pass_price_usdc`). Making
  them configurable needs new config fields plus an admin setter — follow-up
  work, not yet done. Jess's standing rule is that anything that can be a
  config/wizard field should be one.
- **No audit.** (The EVM audit gate was waived by Jess on Oct 29; the Solana
  program has not been audited either.)
- No keeper allowlist; no USD-value weighting for multi-asset staking; no
  on-chain AMM (the Genesis assets assume external liquidity).

## Everything else I've done that you haven't seen

- **Snowbank on Solana** (separate tree, not in this repo): ported from the
  fixed EVM Snowbank tree — never from the audited Sonic master zip, whose
  accounting audit came back *do not deploy* (34 findings). Program
  `CqQBL4ypYwrLvEaidm3MoWbrskzVRVoBa1GiHKNEpdkk`, live on devnet: SNOW mint
  (exactly 1,000,000), three pools, NFT sales open. On Nov 8 the emission rate
  was set to **0.05 SNOW/sec** and read back confirmed; its admin page has a
  live whole-number emission control. Its frontend is on Vercel; the Farm
  page's send paths there are still stubs, so UI smoke tests are still owed.
- **The official EVM frontend** (built from your merge zip, branch `merge` @
  `a8d1ea5f`) is wired and live on Vercel:
  https://xtomb-frontend-jsteig3-1988s-projects.vercel.app/
  My wiring pass audited the read/write paths against the generated ABIs
  (every called function exists), added an `LpBurnPanel` (the 0.5% LP-burn-fee
  counters on Genesis), and since then: a **USDG box** on the Masonry page
  (simulated data, no contract bound yet) and **Dashboard as the root route**
  (the splash landing moved intact to `/welcome`). Both shipped Nov 8. The app
  still runs in Preview / simulated-data mode because
  `config/masonry-deployments.json` is empty — there is no live EVM deployment
  to bind it to.
- **Nov 8 design specs** (design + config only, no contract code — your lane):
  - *Auto-range vault v2 design*: the v1 vaults' tick range is immutable and
    nothing recenters it; the design makes ticks storage, changed only by a
    parameterless `rebalance()` computed from the validated 30-minute TWAP.
    Recommendation in the doc: do not deploy v1 vaults for the launch.
  - *Farm split 75/20/5 + weekly pot + USDG box*: xTOMB/USDG gets 75% of xSHARE
    farm emissions, xSHARE/WETH 20%, and 5% accrues to a weekly pot split
    equally among qualifying Masonry stakers (>1 week, no withdrawals) and
    zapped into their Masonry LP; the USDG box is a separate claimable share
    of Treasury-bound USDG on the same tenure rule. Both need a Masonry
    position registry that doesn't exist yet.
  - *Dual-genesis alignment sheet*: every shared parameter for the two chains
    side by side (lives in the Masonry goal files, not this repo).
- **The decay implementation you wrote is located and verified**: Lodge-Capital/
  Masonry `main`, `contracts/ShareRewardPool.sol` — `decayRateBP = 16`
  (0.16% per six-hour epoch), `decayFloorBP = 2500`; the decay is on the
  emission rate, `initialRate × max(0.9984^epoch, 0.25)`, operator-settable
  only before farming starts. Jess's chosen rate is 0.05%/day, which is
  1.25 BP/epoch — not settable exactly (integer BP); his pick between 1 BP and
  2 BP is still open. Note the decay is monotone to the floor — it does not
  produce the hump-dip-rise emission curve Jess described; that shape is still
  the separate curve / advanced-formula path, which has not been located.

## The dual-genesis direction

Jess, today (Nov 8): **"i think we should do a dual genesis, robin hood and
solana"** — a simultaneous Genesis on Robinhood Chain (EVM) and Solana, as two
independent launches with shared branding, parameters, and start time (no
bridge; separate supplies and mints per chain). That's why this repo is shared
now: EVM contracts are your lane, the Solana program is mine, and the two
launches have to line up parameter by parameter.

Per-chain notes, so nothing gets conflated: on Robinhood Chain the peg stable
is **USDG** (Paxos, 6 decimals; Circle issues no native USDC there) and the
venue call is Uniswap V2. Solana settles in USDC (mock, on devnet). The
protocol itself is chain-agnostic — Robinhood is a config profile, not a build
target.

## Open items that touch your lane

Stated plainly, not as assignments — Jess routes work, I don't.

1. **PR #3's `contracts` CI is red on the inherited merge head (`a8d1ea5`)**,
   cause unconfirmed (from the PR body itself: do not merge until green and
   reviewed). I verified the PR is open via GitHub today; I have not diagnosed
   the CI failure.
2. **Vesting-split conflict.** Your `CANONICAL_SPEC.md` in PR #3 records
   Team 1,000 / Dev 1,000 / Treasury 2,940 / Arb 1,901 + 100 minted outright
   to the dev address. When Jess told me "you decide, configurable" (Nov 7), I
   recorded Team 2,500 / Dev 2,000 / Treasury 2,441 / Arb 0. Both total 6,941.
   Jess has not ruled yet; the recorded decision and your spec disagree.
3. **Pro deposit-fee divergence.** PR #3 implements Genesis 3% / Pro 2% /
   Ultra 0% on standard-pool deposits. The Solana program has Pro at **1%**.
   Each came from Jess's words in its own thread; nobody has reconciled them.
4. **Ultra $300 must be applied when PR #3 merges.** PR #3's in-place upgrades
   are priced off the old $500 (deltas +$50 / +$400 / +$450). Current prices:
   Genesis $50 / Pro $100 / Ultra $300; deltas +$50 / +$200 / +$250. The Solana
   side is already done.
5. **Bootstrap config fields** (3% × 2 epochs, TWAP > $0.90 gate) — Codex's
   lane per Jess; the launch template has no bootstrap field yet.

## A note on this repo's contents

The GitHub copy was pushed through the Muse connector's snapshot tool, which
carries UTF-8 files only. **20 binary files are in the local repo but not on
GitHub**: `tests/fixtures/mpl-core.so` (the Metaplex Core program fixture for
bankrun tests, ~836 KB) and 19 font files (`.woff2` under
`frontend/public/fonts/` and `ui-source/assets/`, ~640 KB total). Everything
else — program source, frontend source, scripts, tests, reports, and the
program IDL (copied to `idl/xtomb.json`) — is here. Build output (`target/`,
`.next/`, `node_modules/`) and all keypairs are gitignored; the deploy wallet
keypair was never in this tree.

## Jess's question

Jess's words, near-verbatim:

> **"What else did you have planned that is better than what you see here?"**

Answer it in your own handoff doc or a PR, so your plan and what's above can
be compared side by side. If something you planned supersedes something I
built — on either chain — say so plainly and say why; Jess will rule.

— Bingo, 2026-11-08
