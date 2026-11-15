# Solana xTOMB — build spec

**Commissioned:** 2026-11-05 ~12:08–12:10 EST, Jess to Bingo, main chat. Jess is asleep; no questions go back to him. Every decision below is Bingo's, correctable by Jess in one line when he wakes.
**Sources:** EVM v4 spec (`~/workspace/user/files/xTOMB-xSHARE-specification.md`, baseline Nov 4 2026, merge `7e3115f`); xTomb artifact UI zip (`~/workspace/user/files/xTomb_28_ytff.zip`, extracted at `~/workspace/solana-xtomb/ui-source/`); Jess's messages 2026-11-05 12:08–12:10 EST.
**Working tree:** `~/workspace/solana-xtomb/` — NEW tree, local only. Do NOT modify `~/workspace/lodge-solana-v2/` (side-chat lane), `~/workspace/v4-tomb-patch/`, or any repo `main`. No GitHub push (writes are 403-blocked anyway). No mainnet, no real funds, no spending Jess's money, no contacting anyone.
**Target for the morning:** a working tree + honest morning report (`MORNING-REPORT.md`) that Jess wakes up to: Anchor program compiling, frontend building and serving in the xTomb theme, tests run with real results, devnet deploy attempted only if the funded wallet suffices (it likely does not — see Funding). Never claim deployed/audited/live unless a check proves it.

## 0. How Jess's garbled messages were read (correct in one line if wrong)

- "I don't want talking 2020 too, I want regular SPL tokens" = **no Token-2022, regular SPL Token program** for xTOMB / xSHARE / xBOND. (Token-2022 transfer-fee extensions are out; that is why sales tax becomes a withdrawal fee — see §6.)
- "lots of Mcdowell Windows" = **lots of modal windows** — heavy modals for all flows (his standing Masonry UX rule).
- "JPL" in the Genesis asset list = **JLP (Jupiter LP token)**. If he meant something else, one line corrects it.
- "At your own optimizations but don't make it complicated" = **keep it simple**: single program, copy EVM specs where they translate, optimize only where it simplifies. No LayerZero, no OFT, no bridge, no cross-chain in this build.
- "fire tax withdraw fees or fire hose or something like that, we can name it in config" = the Solana exit fee's **display name is a config string** (default `Fire Tax`; `Fire Hose` is the alternative he floated — keep it as a config comment option, do not rename unilaterally).
- "ready for production / ready for live testing" = build to a **finished, testable state on devnet**; production deployment still needs a funded deploy rehearsal + independent audit. Do not label anything production-ready until those exist.

## 1. Theme — Obsidian Crypt, copied from the xTomb artifact

The zip is a **compiled Vite build** (minified `assets/index-YLiF0Btr.js`, ~1 MB), not editable source. Do not try to patch the bundle. Extract the theme and copy from it, rebuild the frontend from scratch in the same look.

- Dark-only. Background `#050507`; panels `#0b0c10` / `#111319`; text `#ffffff` / muted `#9ca3af` / `#7c7a74`; warm paper `#ece8df` for display text where the artifact uses it.
- Primary orange `#ff6a2b`; accents `#ff4d6a` (red-pink), `#3ee7ff` (cyan), `#ffc24b` / `#ffb547` (amber), `#b48cff` (violet), `#34e3a0` (green).
- Fonts: **Unbounded** (display/headings), **Inter** (body), **JetBrains Mono** (numbers/labels). All three are bundled as woff2 in the zip's `assets/` — reuse them.
- Layout: bottom nav **Dashboard / Genesis / Swap / Bridge / More**; top bar with xTOMB wordmark + sample-wallet pill; `Sim` / `SIMULATED` / `PLANNED` badges wherever data is simulated; orange gradient CTAs with the clipped-corner shape; Docs sections I–XII with interactive sliders/explorers.
- Motion: GSAP tweens on tab/route change, slow ambient animation, Lottie in the swap-confirm modal only (dot → ring → green check, same sequence as the Snowbank app). Mobile-first; 0px overflow at 390px.
- UX laws (Jess's standing rules): **one TokenPicker everywhere, zero native selects**; **Zap first-class** (zap in/out of LP and farms from a single token); **heavy modals for all flows**; never ship a field as "Unavailable" — show the honest state (Simulated / Planned / Not in the contracts) instead.

## 2. Tokens — regular SPL, 6 decimals

| Token | Role | Decimals | Supply / cap |
| --- | --- | --- | --- |
| **xTOMB** | Peg asset, Genesis reward | 6 | Authorized launch supply: see §3. Targets 1 USDC. |
| **xSHARE** | Capped share asset | 6 | **Cap 33,333** (33,333,000,000 base units), immutable at deploy. |
| **xBOND** | Bond (new on Solana; EVM v4 excluded bonds) | 6 | Uncapped, mint-gated by TWAP + config max outstanding (see §7). |
| **USDC** | Quote + payment | 6 | Native USDC (devnet USDC for testing). |

Mint authorities: program PDA for all three. No freeze authority on xTOMB/xSHARE/xBOND (transfers are free; the tax lives on exits, §6). Pass NFTs are the only frozen assets (§4).

### 3. Supply and allocations — copy the EVM numbers exactly

**xSHARE (33,333 total):**

| Allocation | xSHARE |
| --- | ---: |
| Farm emissions over 365 days | 25,641 |
| Sale escrow | 100 |
| Deployer | 1 |
| Owner / Team / Developer launch | 100 |
| Treasury launch | 550 (see note) |
| Arbitrage launch | 0 (see note) |
| Remaining operational vesting (180-day linear) | 6,941 |
| **Total** | **33,333** |

- Note — **Jess override, Solana only:** the arbitrage bot gets **no xSHARE** ("it never needs to do anything to square"). The EVM template's 50 xSHARE arbitrage launch allocation moves to Treasury (500 → 550). The 6,941 vesting split **excludes Arbitrage**; Bingo's proposed split (correctable in one line): **Team 2,500 / Developer 2,000 / Treasury 2,441 = 6,941**. Vesting is 180-day linear, non-revocable, separately funded tranches.
- Farm emissions 25,641 xSHARE over 365 days, pool weights in config.

**xTOMB launch (copy EVM template):** Owner/Team/Dev **5,000**, Treasury **5,000**, Arbitrage **1,000** (total 11,000, 180-day linear vesting for all four buckets including the arb bot's xTOMB). **Genesis reward budget: 30,000 xTOMB** — the EVM historical reference figure, adopted as the lock (the artifact's "2,625,000 xTOMB" is preview sample copy, NOT a lock). Authorized launch supply beyond budget + launch allocations stays a launch input in config, unset until Jess sets it.

## 4. Passes — three tiers, soulbound NFTs, upgrades in place

| Pass | Price (USDC) | Deposit fee (Genesis stake) | Auto-compounder |
| --- | --- | --- | --- |
| **Genesis** | 50 | 2% | None (manual only) |
| **Pro** | 100 | 1% | Every **6 hours** (opt-in keeper) |
| **Ultra** | 300 | 0% (Bingo's decision) | Every **3 hours** (opt-in keeper) + 24h early standard staking |

**Configurability (2026-11-08):** the prices and deposit fees in this table are the compiled defaults of an admin-configurable table, not constants — `set_pass_config` rewrites all six values in the Config account (validation: prices > 0, fees ≤ 1000 bps), and buys, upgrade deltas, and the standard-pool deposit fee all read the stored table. A stored 0 resolves to the compiled default shown here.

- Passes are **Metaplex Core NFTs**, soulbound by design: frozen at mint with a permanent freeze delegate held by the program PDA; no transfer path exists. One pass per wallet. Purchase proceeds go to the **config treasury wallet** (not a treasury contract).
- **Upgrades in place** (carry the EVM `76a89ef` rule to Solana): pay only the price difference, same NFT kept, tier changes on-chain, closes at Genesis end. Genesis→Pro +$50, Pro→Ultra +$200, Genesis→Ultra +$250. (Ultra price $500 → $300, Jess 2026-11-08.)
- **Ultra NFT is stakable in Genesis by itself** and receives **5% of Genesis emissions** (Jess said "maybe 5%" — locked at 5%, configurable). The Ultra pass stakes as its own position; it is not a token deposit.
- **Hard compound cap (on-chain, Jess's lock):** no user, program, or script can compound a pool for a given user more than **once every 3 hours**. Enforced in the program as a per-user-per-pool `last_compound_ts`; any compound (manual, keeper, Pro 6h cadence, Ultra 3h cadence) that would violate it **reverts**. This is what stops a fast script from outperforming everyone on cheap Solana fees. The Pro 6h / Ultra 3h cadences are the *keeper's* schedule; the 3h cap is the *program's* floor — a keeper may never compound faster than the cap allows.

## 5. Genesis — 7 days, same calendar as EVM

- **T** = immutable Genesis start. **T − 24h:** Ultra pre-stake opens (standard asset only; rewards begin at T for all tiers). **Day 1 (T → T+24h):** standard staking receives 100% of scheduled emissions; LP staking/compound closed. **Day 2 (T+24h):** xTOMB/USDC LP staking + compounding open; LP receives **75%**, standard **25%**. **T + 7 days:** Genesis ends exactly; new deposits/compounds close, emissions stop, Genesis fee floors expire; accrued claims + principal withdrawals remain available.
- **Genesis stake assets (single-stake, each with the deposit fee):** **USDC, SOL (wSOL), JLP, WETH (Wormhole), WBTC (Wormhole)**. The deposit fee goes to the **treasury wallet indicated in the config file, not a treasury contract** (Jess's explicit instruction). Standard-pool deposit fees by tier are the §4 table (Genesis 2% / Pro 1% / Ultra 0%) — tier rates apply per the holder's pass. (History: Jess originally named a flat 3%, the Genesis-tier rate; on 2026-11-08 he ruled Genesis 2% / Pro 1% / Ultra 0% on all pools, and the Genesis tier changed 3% → 2% on-chain the same day.)
- **Rewards:** xTOMB from the prefunded 30,000 budget. **50/50 split:** half liquid, half vested. **Vesting:** 16 installments of 6h each; first claimable at Genesis end + 6h; each subsequent installment opens only when the previous one is claimed (fastest full vest = 4 days from Genesis end). **Claim fee:** post-Genesis, **2% to Treasury** on liquid wallet claims and on each vesting release; **during the Genesis window, Genesis-pool claims instead pay the current Fire Tax rate, burned 100%**; **Masonry-pool claims pay the current Fire Tax rate at all times, to Treasury post-Genesis** (§6). **Shared 3h cooldown** per user per pool across claims and compounds (same clock as the §4 hard cap).
- **LP deposit/compound fee:** **0.5% of gross LP shares**, routed to the **config treasury wallet as protocol-owned liquidity (POL)** (Q8, Jess 2026-11-08 — "Solana matches EVM — LP fee to Treasury as POL"): the fee LP tokens are transferred to the treasury wallet's token account for the LP mint and held as LP — never redeemed or burned by the fee path, and the LP mint supply does not change because of the fee. On the compound path (which credits pseudo-LP 1:1 from xTOMB in this AMM-less build) the fee leg is the xTOMB equivalent, likewise transferred to Treasury. This replaces the original burn routing (redeem fee shares → burn recovered xTOMB), which the code never fully implemented: stake fee shares previously sat in the pool vault as unclaimed shares and the compound leg burned its fee; both charge points now transfer to Treasury. Live on devnet 2026-11-08. **Ultra exception (Jess, 2026-11-08 — "0% on all pools with Ultra"):** the LP deposit fee is waived for Ultra pass holders; Genesis/Pro holders still pay the flat 0.5% (the tier percentages apply to standard pools; the LP fee stays its own separate mechanism per the note below).
  - **Note (Jess, Nov 5 — "the logic is not reusable"):** the standard-pool deposit-fee logic is NOT reusable for the LP-pool fee. They are separate implementations with different bases (deposit amount vs LP shares) and different routing — do not build one generic fee path and assume it covers both. The withdrawal Fire Tax (§6) is a third, separate mechanism. Same separation applies on the EVM side, which is why the 0.5% LP-pool fee (now Treasury-as-POL, replacing the burn) is still its own unbuilt item there.
- **Compounding:** only liquid xTOMB compounds; compound sells xTOMB for USDC, adds xTOMB/USDC liquidity, stakes it. The compound's sell leg pays the §6 withdrawal Fire Tax. Manual compound: 0 keeper fee. Keeper compound (Pro/Ultra opt-in): **2% of the liquid amount to Treasury**. Minimum-net-shares guard on every compound; failed conversion reverts the whole compound (debit, fee, cooldown) together.

## 6. Withdrawal Fire Tax — replaces the EVM sales tax

Solana regular-SPL transfers cannot be taxed, so the entire Fire Tax moves to **exits**. The fee's display name is a **config string** (default `Fire Tax`; `Fire Hose` kept as a config-comment alternative).

- Applies to **every withdrawal from a staking position**: Genesis unstake (standard + LP + Ultra-NFT position), Farm withdrawals, Masonry exits. Buys and wallet-to-wallet transfers: **0%**.
- Rate (re-ruled by Jess, 2026-11-08): **baselines at or above the 1 USDC reference are 3% xTOMB / 6% xSHARE** (both were effectively 1% + Genesis minima before). Both tokens ride **one shared quadratic curve increment**: rate = baseline + 11% × ((ref − TWAP) / (0.15 × ref))². Because xSHARE starts higher, it reaches the **12% cap sooner (~$0.89)**; xTOMB caps from **~$0.86** down; both are at the cap at or below 85% of reference. **Genesis minima 3% xTOMB / 6% xSHARE** — now identical to the baselines, so they no longer bind separately (the max() still applies them). **Maximum 12%**; **one debit** (highest applicable of TWAP target / recovery floor / Genesis minimum). The recovery floor decays linearly toward a **resting rate of 3% for BOTH tokens** over **7 hours** (it decayed to 1% before); a higher observed rate can restart it.
- **Admin configurability (Jess, 2026-11-08 — "configurable in the admin section"):** the two baselines, the cap, the resting rate and the recovery window are Config fields, retuned by `set_fire_tax_config` (validated: cap and everything under it stay at or below the 12% hard ceiling). `set_fire_tax_zeroed` is the healthy override: while set, **both withdrawal Fire Taxes are 0%**; clearing it restores the configured rates. The values ship as compiled defaults (3% / 6% / 12% / 3%, 7h). On the Nov 7 devnet deployment the Config fields read 0, which the program resolves to those defaults — the 2026-11-08 upgrade appended the fields into the Config account's pre-allocated spare capacity, so no account was resized or migrated.
- Routing (copy EVM): xTOMB-denominated tax **burns 100% during Genesis**, else to Treasury. xSHARE-denominated tax, normal mode: **12% to protocol-owned xSHARE/USDC liquidity, 20% to the Treasury USDC reserve (after conversion), 68% stays in xSHARE for Treasury**. Critical Defense (§8) reroutes 100% to buy-and-burn.
- **Genesis claims follow the Fire Tax (Jess, 2026-11-08):** during the Genesis window, claiming rewards from a Genesis pool (standard / LP / Ultra) charges the **current xTOMB Fire Tax rate** — the schedule above, recovery floor and healthy override included — instead of the flat 2% claim fee, and the charged tax **burns 100%**, routed exactly like a Genesis xTOMB withdrawal. The claim fails closed on stale oracle data while this applies (same as unstake/compound). Post-Genesis Genesis-pool claims (vesting installments included) keep the flat 2% claim fee to Treasury. The 3h claim/compound cooldown is unchanged.
- **Masonry claims follow the Fire Tax at ALL times (Jess, 2026-11-08 — "claiming xTOMB from the Marony [Masonry] is taxed at fire rates"):** claiming xTOMB rewards from the Masonry pool charges the **current xTOMB Fire Tax rate** (same helper as withdrawals and Genesis claims — curve, recovery floor, healthy override) instead of the flat 2% claim fee, at any time. Routing follows the xTOMB withdrawal-tax routing: post-Genesis (the only case that exists in practice — Masonry rewards accrue only once epochs run) the tax goes to **Treasury**; the code keeps the during-Genesis burn branch under the same condition the withdrawal path uses, for consistency. Masonry claims likewise fail closed on stale oracle data while the Fire Tax prices the fee. This reverses the flat-fee scoping for Masonry claims made earlier the same day.
- This is the same shape as the October 28 Fire Extinguisher (Solana exit-fee peg defence), now with the EVM v4 numbers.

## 7. xBOND — Solana bond, LP-denominated zap model (re-ruled by Jess, 2026-11-08; EVM v4 excluded bonds)

Bonds are denominated in **xTOMB LP**: a bond's face is xTOMB-denominated at issue and redeems into xTOMB LP paid out of a protocol-held backing vault. This replaces the original model (pay TWAP × 1 xTOMB per xBOND, paid xTOMB burned; redeem 1 xBOND → 1 xTOMB minted from the expansion allowance) wholesale. Devnet xBOND supply and `bond_outstanding` were both 0 at the switch, so no live position migrated. One piece of the original model returned by amendment later the same day (Jess): the xTOMB pay-in branch burns like a classic bond, at a 3% premium — see the pay-in rules below.

- **Gates (unchanged):** buys only when fresh TWAP < $1.00; redemptions only when fresh TWAP > $1.00. Max outstanding in config (`bond_max_outstanding`). No time lock beyond the TWAP gates.
- **Buy = 100% zap into the LP:** the buyer's pay-in value goes entirely into creating xTOMB LP that the program holds as the bond's backing. Accepted pay-ins are only the assets the program can price on-chain — anything else is rejected (`BondPayinRejected`):
  - **USDC** (the config `usdc_mint`): valued at $1. **Premium asset.**
  - **Wrapped SOL** (the canonical native mint): valued at the oracle-posted SOL price (`set_sol_price` — USD e6 per whole SOL, posted by the oracle authority or admin; SOL pay-ins fail closed on an unset or stale (>30 min) price, `BondSolPriceMissing` / `OracleStale`). **Premium asset.**
  - **xTOMB**: valued at TWAP. **Premium asset at its own, smaller premium — 1.03× at the default 300 bps** (`bond_xtomb_premium_bps`, set by `set_bond_xtomb_premium`; a stored 0 resolves to the 300 bps compiled default). Because the pay-in is already TWAP-denominated, the USD-value ÷ TWAP round trip cancels the price: face credited = paid × 1.03 exactly (paying 1,000 xTOMB credits 1,030 face at any TWAP).
  Face credited = pay-in USD value ÷ TWAP, with the **premium** on premium assets: **1.10× at the default 1,000 bps** for USDC / wrapped SOL (e.g. $1,000 of USDC at TWAP $0.90 credits 1,222.22 face). The premium is an admin Config field (`bond_premium_bps`, set by `set_bond_config`; a stored 0 resolves to the 1,000 bps compiled default — the Config fields ride the same spare-capacity tail-append as the Fire Tax fields). The USDC and SOL pay-ins are **custodied — never burned, never sold by the program**: they move into a per-mint bond pay-in vault (PDA `["bond-payin", mint]`, token authority = config PDA), created on first use. **The xTOMB pay-in is the exception (Jess, amended 2026-11-08): the paid xTOMB BURNS like a classic bond** — contraction, with `circulating_xtomb` reduced by the burned amount — and it never enters the custody vault.
- **The market leg is OPERATOR-EXECUTED (interim, stated plainly):** no AMM is integrated on devnet (no xTOMB pool exists yet; a Jupiter/AMM CPI zap is unbuilt), so the program itself does not swap. The bot wallet (or admin) runs the leg: (1) `withdraw_bond_payin` pulls custodied pay-ins out of a pay-in vault; (2) **off-chain, the operator spends the stable/native pay-in to BUY xTOMB on the market — the protocol buys xTOMB to make the LP, it never sells protocol tokens — and creates the LP** (the buy is itself peg support); (3) `deposit_bond_backing` deposits the resulting LP into the bond backing vault (PDA `["bond-lp-vault"]`, created by `set_bond_config`, which also registers the LP mint) and registers it in the `bond_backing_lp` counter. LP that reaches the vault any other way does not raise the counter and is not redeemable against. When an AMM exists, this leg becomes an on-chain zap; the custody/face/backing accounting does not change.
- **Redeem:** only above $1.00. Burning face pays LP from the backing vault **pro-rata**: entitlement = face × min(`bond_backing_lp`, vault balance) ÷ `bond_outstanding`, so the last outstanding face drains the backing exactly. If the entitlement is 0 — LP mint not registered yet, or the operator leg has not deposited backing — the whole amount **queues** on the holder's BondPosition (no partial fill, no IOU token; the xBOND stays in the wallet) and a later call settles the queue first; passing amount 0 settles the queue only. **The expansion allowance plays no part in bonds under this model** (`advance_epoch` still accrues it; nothing spends it), and **no xTOMB is minted by either bond instruction** (redemption burns xBOND, never xTOMB; the only xTOMB burn in the bond flow is the xTOMB pay-in branch above).
- xBOND has no farm, no Masonry stake, no vote — it is a pure discount/redeem instrument. Instructions: `buy_bond`, `redeem_bond`, plus admin/operator `set_bond_config`, `set_bond_xtomb_premium`, `set_sol_price`, `withdraw_bond_payin`, `deposit_bond_backing`. On the Nov 7 devnet deployment the bond fields read defaults (premium 1,000 bps resolved, xTOMB premium 300 bps resolved, LP mint unset, backing 0, SOL price unset) — `set_bond_config` is called only once a real LP mint exists, so bonds there can be bought (custody + face for USDC/SOL, burn + face for xTOMB) but redemptions queue until the operator leg runs.

## 8. Farm, Masonry, Critical Defense

- **Farm:** 25,641 xSHARE over 365 days, pool weights in config, 3h compound gate (same hard cap). Admin adds pools from the Admin section; pools are also set up in the launch wizard (§10). Farm migration terms are post-launch work, not in this build.
- **Masonry (expansion):** **lazy epochs** (Jess's Oct 30 lock — epochs advance on user interaction, no keeper crank; Epoch 0 opens only on manual Admin trigger). 6h epochs. **Bootstrap: 2 epochs at 3% of circulating xTOMB per epoch to the Masonry, only when above $0.90, none at or below $0.90** (Jess's Nov 4 lock). Then price-aware expansion on a **fresh TWAP strictly above $1.01, capped at 2% per eligible epoch**. No catch-up issuance, no spot-only authorization.
- **Critical Defense:** enter at fresh validated xTOMB TWAP **≤ $0.90** (100% of newly collected xSHARE tax → xSHARE → USDC → xTOMB buy-and-burn); exit after fresh TWAP **strictly above $1.01 in two consecutive 6h epoch checkpoints**. Stale data preserves the last confirmed mode; missed/stale observations cannot fill checkpoints retroactively.
- **Oracle / TWAP:** a designated **oracle authority** (keeper key in config, rotatable by admin) posts TWAP + timestamp. Program validates freshness (observations older than 30 min do not count for defense checkpoints; sells/withdrawals fail closed during oracle warmup or staleness, buys stay available). This is the accepted interim from the Lodge Solana work (trusted oracle key until a pool is parsed on-chain) — on-chain Raydium/Orca pool parsing is a documented upgrade path, not this build. A Pyth sanity check is optional only if it does not complicate the build.

## 9. Fees and the four wallets

All fee proceeds and launch allocations route among four recipients, all **wallet addresses in config** (not contracts): **team wallet, dev wallet, treasury wallet, trading-bot (peg-keeper) wallet**.

- **Operational fee split (Bingo's decision, config values, correctable in one line):** Treasury **50%**, Team **20%**, Dev **15%**, Arb/trading bot **15%**. Applies to: Genesis deposit fees, claim fees (2% — the post-Genesis flat fee on Genesis-pool claims; a Genesis-window claim's Fire Tax burns instead and never enters this split, and Masonry claims pay the Fire Tax to Treasury directly as a tax routing, not via this split), keeper fees (2%), and any other operational fee not otherwise routed. The xSHARE Fire Tax keeps the EVM 12/20/68 split (§6); the four-way split applies to the operational fees.
- **Trading bot (peg keeper):** an off-chain keeper (TypeScript crank script in the repo) that monitors TWAP and executes buyback-and-burn / peg-defence calls through the program's guarded instructions. It is funded by its xTOMB launch allocation (1,000, 180-day vesting) + its 15% operational fee share, so it holds xTOMB when TWAP flies over $1.01. The bot script is part of the deliverable if time permits; otherwise its on-chain interface is fully specified and the script is a documented stub. It never custodies user funds.

## 10. Launch wizard + Admin

- **Launch wizard (config-first, all variables — Masonry pattern):** steps 1 Chain/Network, 2 Tokens & Supply, 3 Allocations & Vesting, 4 Passes & Fees, 5 Pools, 6 Genesis Schedule, 7 Review & Deploy. Whole numbers and percentages only in config, never lamports/bps; comments carry worked examples; deploy scripts convert. Wizard validates hostile-ly (bad addresses, bad splits, missing vesting splits all rejected with plain messages) and refuses deployable output behind gates (no audit, no live-chain verification) until the operator acknowledges them. **The wizard DEPLOYS** (Jess, Nov 5 — "The wizard deploys. Admin is maintaining." Do not repeat the old preview line that the wizard never deploys). Dry-run first, then deploy to devnet.
- **Admin section:** add pools, set fee config, set the four wallets, set/rotate the oracle authority, set expansion cap, set epoch time / next epoch time, set TWAP, set reserve, operator/role controls, bond actions, maintenance toggle. All live parameters are admin-page configurable (Jess, Nov 5). Admin is owner-gated in the UI.

## 11. Program architecture (Anchor)

- Toolchain: Anchor **0.30.1**, Solana **1.18.26** (same as the verified lodge-solana-v2 toolchain), Rust stable. Single program `xtomb`. Deps: SPL Token, Metaplex Core (`mpl-core`) for pass NFTs only. No other program deps.
- Instructions (keep the surface small): `initialize_config`, `create_mints`, `buy_pass`, `upgrade_pass`, `stake`, `unstake` (applies §6 fee), `claim`, `compound` (manual + keeper, enforces §4 hard cap), `harvest`, `add_pool` (admin), `set_fee_config` (admin), `set_wallets` (admin), `set_oracle` (admin), `buy_bond`, `redeem_bond`, `advance_epoch` (lazy, permissionless settle), `buyback_and_burn` (guarded, keeper/bot), `set_maintenance` (admin). Lazy epochs: any Masonry interaction first settles every due epoch, then executes.
- Config is a single PDA; every economic number lives in it (whole numbers/percentages in the TypeScript config layer, converted at deploy). Config hash discipline: any config change after deploy goes through admin instructions with events, never silent edits.
- Tests: Anchor test suite (local validator if the sandbox allows it — the lodge-solana-v2 work found the local validator blocked by the sandbox, not by code; if blocked here too, run `anchor build` + unit tests that do not need a validator and **report exactly what ran and what did not**). Never fake a green test run.

## 12. Frontend architecture

- Next.js (App Router) + Tailwind, Solana wallet adapter (Phantom + Solflare), devnet default. Routes: Dashboard, Genesis, Farm, Masonry, Swap, Bonds, Docs, Admin, Launch Wizard. Rebuild the theme from §1 (do not reuse the minified bundle).
- Swap: one TokenPicker (xTOMB, xSHARE, xBOND, USDC, SOL, JLP, WETH, WBTC, xTOMB·USDC LP, xSHARE·USDC LP); Zap in/out everywhere; Fire Tax shown before signing with pool fees itemized separately; route chips (Buy / Sell / Enter LP / Exit LP / Add LP / Remove LP).
- Genesis: pass purchase + upgrade modals, stake/claim/compound modals, 3h cooldown countdowns, vesting tracker (16 installments), Ultra-NFT stake card.
- Docs: interactive sections with the Fire Tax explorer, TWAP slider, epoch wheel, claim-settle visual — same interactive treatment as the artifact.
- Bridge page: **Planned** (same honest copy as the artifact: soulbound passes, no xSHARE bridge, needs new audited contracts). No omnichain promises.
- All on-chain actions go through real wallet transactions once a program is deployed; until then every number is labeled Simulated and nothing is sent to a wallet.

## 13. Funding / deploy (read carefully)

- The existing devnet deploy wallet `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` holds **~1.657 SOL** (verified Nov 3) — almost certainly **not enough for a fresh full program deploy** (the .so will be large). **Do NOT ask Jess for more SOL overnight and do NOT touch the funds tied up in the lodge-solana-v2 safety-flagged attempt.** Build + test locally; if a devnet deploy is attempted, first check the balance and the program size, and only proceed if the wallet covers it with margin. Otherwise report the exact shortfall in the morning report so Jess can fund it with one send.
- Devnet only. Never mainnet. Never real funds. Never a mainnet key in the repo.

## 14. Out of scope for this build

Bridge/omnichain, LayerZero, Solana Token-2022, Farm migration, Robot Arms / batch automation beyond the Pro/Ultra keeper, sale-escrow pricing/execution, independent audit, mainnet deploy. Each is a named follow-up, not a silent omission — list them in the morning report.

## 15. Morning report

Write `~/workspace/solana-xtomb/MORNING-REPORT.md` for Jess: what was built, what runs, what was verified (with commands + real output), what is still open or blocked, what he needs to decide (with the one-line-correctable decisions from §0 listed), and the exact devnet SOL needed if a deploy is pending. No hype, no inflated claims.
