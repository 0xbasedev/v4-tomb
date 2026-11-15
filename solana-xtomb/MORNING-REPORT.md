# Solana xTOMB — Morning Report

**Date:** 2026-11-05 (overnight build, Jess asleep)
**Status:** Built and verified locally. **NOT deployed, NOT audited, NOT live.** Nothing on any chain, no real funds touched, no GitHub push, `lodge-solana-v2` untouched.
**Tree:** `~/workspace/solana-xtomb/` (local only)
**Program ID (fresh, devnet-only):** `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY` (keypair `target/deploy/xtomb-keypair.json`)

## What was built

- **Anchor program `xtomb`** (Anchor 0.30.1, Solana 1.18.26): all 18 spec instructions — `initialize_config`, `create_mints`, `buy_pass`, `upgrade_pass`, `stake`, `unstake`, `claim`, `compound`, `harvest`, `add_pool`, `set_fee_config`, `set_wallets`, `set_oracle`, `buy_bond`, `redeem_bond`, `advance_epoch`, `buyback_and_burn`, `set_maintenance`. Regular SPL tokens (NOT Token-2022), Metaplex Core for pass NFTs only.
- **Frontend** (Next.js 15.5 App Router + Tailwind, Obsidian Crypt theme rebuilt from the artifact zip): 10 routes — Dashboard, Genesis, Farm, Masonry, Swap, Bonds, Docs, Admin, Launch Wizard, Bridge (PLANNED). One TokenPicker, zero native selects, Zap everywhere, heavy modals, GSAP tweens, Lottie in the swap-confirm modal only, 0px overflow at 390px.
- **Keeper scripts** (`scripts/keeper.ts` compound crank, `scripts/peg-bot.ts` oracle poster + buyback-and-burn), typechecked, with `--dry-run`. Never run against a live program.
- **Shared config** `config/xtomb.config.json` — every number from the spec (xSHARE cap 33,333, farm 25,641/365d, vesting 6,941, passes 50/100/500, fee split Treasury 50 / Team 20 / Dev 15 / Arb 15, etc.). The frontend imports an identical copy (`frontend/src/lib/xtomb.config.json`, verified identical by `diff`).

## What was verified (by the coordinator, re-run independently — not taken on the builders' word)

| Check | Command (run by coordinator) | Result |
|---|---|---|
| `anchor build` | artifacts inspected | `target/deploy/xtomb.so` **692,656 bytes**, built 18:43 EST; `target/idl/xtomb.json` = **18 instructions**, program id correct |
| Rust unit tests | `cargo test --offline -p xtomb --lib` | **11/11 passed** (Fire Tax boundaries, one-debit-highest, 7h recovery decay, compound hard cap, pass prices/upgrades, vesting, bond pricing, Genesis shares, epoch gating, oracle freshness) |
| On-chain tests | `npx ts-mocha tests/bankrun.ts` | **18/18 passed in 3s** — real compiled `.so` executed in-process via solana-bankrun (clock warps for epochs/vesting). Watched live logs: `BuybackAndBurn` burn, maintenance blocking `Stake` with error 6002, compound-again-within-3h failing with `CompoundTooSoon` |
| Frontend build | `npm run build` (re-run by coordinator) | **Clean pass**, 13/13 static pages, First Load JS 104–110 kB/route |
| Frontend serving | production server on port 3107, curl | `/`, `/genesis`, `/swap`, `/wizard`, `/docs` all **200** |
| Mobile overflow | headless Chromium 390×844 (builder) | **0px horizontal overflow on all 10 routes** |
| Swap modal + Lottie | headless Chromium CDP click test (builder) | Modal opens, Lottie mounts (1 SVG), **zero console errors** |
| UX laws | `grep -rn '<select' src/` / `grep -rni 'unavailable' src/` | **Zero matches** both |
| Keeper scripts | `npx tsc --noEmit scripts/keeper.ts scripts/peg-bot.ts` | **Clean (exit 0)** after fixing 2 real Anchor-0.30 typing issues (PDA accounts auto-derived, `Program(idl, provider)`) |
| Keeper smoke test | `ts-node scripts/keeper.ts --dry-run --once` | Loads, reports "No owners file", exits clean |
| Peg-bot smoke test | `ts-node scripts/peg-bot.ts --dry-run --once --twap 990000` | Fails cleanly with "Config account … not found — the program is not deployed/initialized yet" (correct: nothing is deployed) |
| Devnet wallet | `solana balance G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` | **1.65693948 SOL** (re-verified 2026-11-05 evening) |
| Deploy rent | `solana rent 692656` | **3.51934272 SOL** (program account alone) |
| `lodge-solana-v2` untouched | `find … -newer SOLANA-XTOMB-SPEC.md` | **No files modified** |
| Mainnet guard | `Anchor.toml` | `[programs.mainnet]` still placeholder `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` with NOT DEPLOYED comment |

## Two real bugs found and fixed during testing

1. **`create_mints` BPF stack crash** — nine Anchor `init` accounts blew the 4KB BPF stack (`Access violation in stack frame 3`). Fixed by creating mints/vaults via system + token CPIs instead of Anchor `init` (instruction name, args, IDL unchanged). `.so` shrank 757,008 → 692,656 bytes.
2. **Ultra `pass` read-only in Stake/Unstake** — the Ultra stake path writes `pass.ultra_staked` but the account was passed read-only; `#[account(mut)]` added.

## Deploy: BLOCKED on SOL — exact numbers

- Program account rent-exempt minimum: **3.51934272 SOL**
- Devnet wallet balance: **1.65693948 SOL**
- **Shortfall (program account alone): 1.86240324 SOL**
- Peak at deploy (program + buffer account; buffer rent is refunded after a successful deploy): **7.03868544 SOL** + tx fees → **shortfall vs peak: 5.38174596 SOL**
- **No deploy was attempted. No funds were touched.** The funds tied up in the lodge-solana-v2 safety-flagged attempt were not touched either.
- To deploy: send **~1.87 SOL more** (net) to `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs`, or **~5.39 SOL more** to cover the deploy-time peak comfortably. One send from you unlocks the deploy rehearsal.

## How to look at it now

Frontend server is running on port 3107 (started with nohup; restart with `cd ~/workspace/solana-xtomb/frontend && PORT=3107 npm run start`). Open http://localhost:3107/ — every number is labeled **Simulated** and nothing sends a transaction until a program is deployed.

## What is still open / not done (honest list)

- **No devnet deploy** (SOL shortfall above). No `initialize_config`, no `create_mints`, no funded Genesis budget on any chain.
- **Validator test suite never executed** — `tests/xtomb.ts` was written but the local validator dies after ~90–165s in this sandbox (UDP gossip blocked, not a code problem). The bankrun suite (18/18) covers the same cases in-process plus clock-warp cases; a validator run on a machine where it stays up is still owed.
- **No on-chain AMM** — compound settles in accounting units at TWAP; the LP-fee burn and xSHARE tax 12/20/68 conversion are accounting-only. Raydium/Orca CPI is the documented upgrade path.
- **No USD-value weighting** for multi-asset Genesis staking (rewards weight raw base units equally across USDC/SOL/JLP/WETH/WBTC). Production needs oracle-based weighting.
- **No keeper allowlist / opt-in registry** — any caller may keeper-compound a Pro/Ultra position (2% fee goes to Treasury, so no rent-seeking incentive, but the registry is still a follow-up).
- **No vesting-release instruction** for the 6,941 xSHARE / 11,000 xTOMB launch buckets (operator work post-deploy).
- **Pass NFT metadata URI is empty** (name only; operator sets the URI later).
- **No live TWAP feed for the peg-bot** — it takes `--twap` / `--twap-file`; Jupiter/Raydium price-feed integration is a TODO.
- **Lottie dot→ring→check timing and the GSAP route tween were not watched by a human eye** (verified as mounted SVG + no console errors only).
- **No audit.** Production deployment needs a funded deploy rehearsal + independent audit. Nothing here is labeled production-ready.

## Decisions for you to correct in one line

These are Bingo's (and the builders') calls where your messages or the spec were ambiguous. Say the word and any one flips:

1. "talking 2020" = **no Token-2022, regular SPL tokens** (that's why sales tax became a withdrawal Fire Tax).
2. "Mcdowell Windows" = **modal windows** (heavy modals for all flows).
3. "JPL" = **JLP (Jupiter LP token)** as a Genesis stake asset.
4. Withdrawal fee display name is a config string, default **`Fire Tax`** (`Fire Hose` kept as a config-comment alternative).
5. **Ultra deposit fee 0%** (you set Genesis 3% / Pro 1%; Ultra was unstated).
6. **Arbitrage bot gets xTOMB only, no xSHARE** (its 50 xSHARE moved to Treasury: 500 → 550). Vesting split proposed: **Team 2,500 / Developer 2,000 / Treasury 2,441 = 6,941**.
7. **Operational fee split: Treasury 50 / Team 20 / Dev 15 / Arb 15**.
8. **Ultra NFT = 5% of total Genesis emissions**; the 75/25 LP/standard split applies to the remaining 95%.
9. **Epoch mint split (invented):** each eligible epoch's mint splits 50/50 between Masonry stakers and the bond-redemption allowance; if nobody is staked in Masonry, all of it goes to the allowance.
10. **Genesis budget locked at 30,000 xTOMB** (the EVM historical reference figure; the artifact's 2,625,000 is preview sample copy, not a lock).
11. **Farm rewards 100% liquid with a 2% harvest fee; Masonry rewards 100% liquid** (the 50/50 split is Genesis-only).
12. **Standard-pool rewards weight raw base units** (no USD weighting yet — see open items).
13. **Launch allocations mint as single buckets** (11,000 xTOMB / 751 xSHARE to the treasury vault; splitting among the four wallets is operator work post-deploy).
14. **Wizard deploys; Admin maintains** (your correction, Nov 5 — the old preview line that the wizard never deploys is gone).
15. Frontend: simulated TWAP values used for previews (Swap $0.97, Bonds default $0.90, Docs $0.92); simulated pool fee 0.30% shown itemized; Genesis cooldown countdowns are a live ticking preview, not real per-user state.

## Out of scope (named follow-ups, not silent omissions)

Bridge/omnichain, LayerZero, Token-2022, Farm migration, Robot Arms beyond the Pro/Ultra keeper, sale-escrow pricing/execution, independent audit, mainnet deploy.

## Next steps when you wake up

1. **Look at the frontend** (port 3107) and tell me what to change — theme, copy, flows.
2. **Correct any decision above in one line** — each is a one-line flip.
3. **If you want the devnet deploy:** send ~1.87 SOL (net) / ~5.39 SOL (peak) to the devnet wallet above and say go — deploy rehearsal is `initialize_config` → `create_mints` → fund Genesis budget → set wallets/oracle → frontend points at the real program.
4. **Audit** before anything touches mainnet or real funds.
