# Solana xTOMB — Devnet Deploy Report

**Date:** 2026-11-06 23:47 EST → 2026-11-07 00:05 EST (overnight, Jess asleep)
**Status:** **DEPLOYED on devnet, initialized, mints created, Genesis funded, wallets + oracle set.**
NOT audited, NOT mainnet, no real funds. Devnet only.
**Tree:** `~/workspace/solana-xtomb/` (local only, no push)
**Program ID:** `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY`
**Deploy driver:** `scripts/deploy.ts` (501 lines, typechecks clean, reusable) — steps
`mock-usdc` → `init` → `mints` → `wallets` → `verify`, each with `--dry-run`.

## Pre-flight (all verified before spending anything)

| Check | Result |
|---|---|
| Tree / `.so` | `target/deploy/xtomb.so` 692,656 bytes, sha256 `ea086018ab7c9cbe8435f46c051c852b8898a6fc580cf9e5f5d845304ae7a7cf` (same bytes as the Nov 5 verified build) |
| Program keypair | `target/deploy/xtomb-keypair.json` pubkey = `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY` |
| `declare_id!` / IDL | `programs/xtomb/src/lib.rs:18` matches; `target/idl/xtomb.json` = 18 instructions, same program id |
| Toolchain | anchor-cli 0.30.1, solana-cli 1.18.26 (full path, not on default PATH) |
| Wallet | `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs`, devnet, **21.656209306 SOL** at start |
| Program state | Not found on devnet (undeployed) — confirmed before starting |
| `lodge-solana-v2` | Untouched (different tree, different program, side-chat lane) |
| USDC mint | Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` exists on-chain (6 decimals) — but the deployer holds none of it, so per Jess's 23:47 refinement a **mock USDC** was minted instead (step 0) |

## Step 0 — Mock USDC (Jess's 23:47 refinement)

Genesis takes USDC deposits and the deployer held no devnet USDC, so a mock
USDC SPL mint was created for testing. **This is a MOCK, not real USDC.**

| Item | Value |
|---|---|
| Mock USDC mint | `2EN7s2AMm9vjKxduHawr1Z9WySCCBbMdJKNaqvLimCbA` (6 decimals, mint authority = payer, no freeze authority, supply starts 0) |
| Payer ATA | `DwG1V57ERkwC5g6N4mbdDT8cdSiW1LeLcVUFYEuUdquJ` |
| Amount minted | **100,000 mock USDC** (100,000,000,000 base units) |
| Mint creation tx | `4ZWrUqz9hzgicA888Taxb8229u7c33KgYy11k5r2rCHsuZWputuCQaxF1DPuXaHo2hRqju12Urn7BufejJs8g7UC` (finalized) |
| ATA creation tx | `2UpbR5KDgrvNXVqHky4ZhpJNGXPLyK7VyphYVioNFon8hXKhNVTAi4ju8tMAYjuuRcSSgzNNDZ6UyYbU1YkNZo3n` (finalized) |
| Mint-to tx | `5Eqb5GecHVhTFd6k2A8JVN9DhMiU1qzH9C11JXS52e7uAux92gjEW6CwSCdbzmAHx65hBYsfZfhCgQF59rB8V9Gj` (finalized) |

**Honest note — the first attempt looked like a failure and wasn't:** the
mint-creation transaction's websocket confirmation timed out
(`TransactionExpiredBlockheightExceededError`), but the transaction had
actually landed (finalized, no error). The mint keypair was generated
ephemerally and was never saved, so the mint address was recovered from the
landed transaction's account keys and written to
`target/deploy/mock-usdc-mint.txt`. The mint authority is the payer wallet,
so the lost keypair is not needed for anything — minting is done by the
authority. The script was then fixed to save mint keypairs **before**
sending (the same save-before-send pattern already used for the xTOMB
mints), and to accept an address-only file. The mock USDC mint is the
`usdc_mint` in the on-chain config (step 2).

## Step 1 — Deploy the program

| Item | Value |
|---|---|
| Program | `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY` |
| ProgramData | `Df5GHtybNCQZasiU2Bq75SrVtRrsjSocTrjBZC7grXE3` |
| Deploy tx | `3RmpSJ4RiuvkC8zZAtrZckSUgJ6rRvd5js7a8b5KCXETJVegAEfBKHD1J1pj2XHWwVQSeaWw9yRYPfU6NdB7TNpw` (finalized, slot 519547971) |
| Deployed bytes | 692,656 — **sha256 of on-chain code matches the verified `.so` exactly** (`ea086018ab7c9cbe8435f46c051c852b8898a6fc580cf9e5f5d845304ae7a7cf`) |
| Authority | `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` (payer) |
| Program account rent | 3.51957132 SOL (held in the program account) |
| IDL account | `8JKUPwKP43fVbah2DxcQY6TNCz8mczMAcC3DcKjg7nv2` (10,740 bytes on-chain, fetches correctly with 18 instructions) |

**Honest note — the first deploy attempt failed partway and cost nothing
lost:** `solana program deploy` without `--use-rpc` panicked immediately
(`Should return a valid tpu client`) — the sandbox's devnet websocket is
broken (see Infrastructure notes). The buffer account had already been
created and funded (3.51957132 SOL) before the panic, so nothing was lost:
buffer `3c43mFNuDDzsKuLvW7ptzxYyTesNftmbsVTQ3bkbbPpD`, authority = payer.
The write phase then failed once more (`Data writes to account failed:
Max retries exceeded`) after writing 230,590 of 692,656 bytes — the public
devnet RPC dropping transactions under a sustained burst. The retry with
`--buffer <that address> --use-rpc` resumed, skipped the written chunks,
and deployed in 36 seconds. The buffer was closed by the deploy and its
rent went into the program account.

## Step 2 — `initialize_config`

| Item | Value |
|---|---|
| Signature | `2qSbGckX3tfeomDj1ouXR6jBXuBXbmAE4tE33NA1vohTuaRwn6QdpSrPNqNduWpZqYVfUtJcuK4fB6zZaqwTHXZo` (finalized, slot 519548404) |
| Config PDA | `4YSDCLocaTcSRrXGKjJd8Hm9uELnmEb3irSHeWnGrc6a` |
| Admin | `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` |
| Treasury / team / dev / bot wallets | All `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` (rehearsal — only funded wallet; changeable by `set_wallets`) |
| Oracle authority | `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` |
| USDC mint | `2EN7s2AMm9vjKxduHawr1Z9WySCCBbMdJKNaqvLimCbA` (the mock USDC) |
| Genesis window | 1794027802 → 1794632602 (2026-11-07 00:03:22 EST → 2026-11-14 00:03:22 EST, 7 days) |
| Genesis budget | 30,000,000,000 (30,000 xTOMB), emission 49,603/sec |
| Bond max outstanding | 1,000,000,000,000 (1,000,000 xBOND) |
| Fee split | Treasury 5000 / team 2000 / dev 1500 / bot 1500 bps; claim 200, keeper 200, LP 50 bps |

## Step 3 — `create_mints`

| Item | Value |
|---|---|
| Signature | `3rJLH6uzhMyTCS2TUwyeQNpsPwiMaxizQjU3eSYajxpGyf2SPSYF9F7c68yobFJqjFQKt3nv2pKQrX6v2vycwmip` (finalized, slot 519548486) |
| xTOMB mint | `9fW3YqmJGWqXMrVaRQRKpADtbG3W3Lo7uz6uZ4Yy9TZv` (6 dec, mint authority = config PDA, no freeze authority, supply 41,000,000,000) |
| xSHARE mint | `ABZ2f4UCuYWJNYYXfyiX2A74incgbaiUxrRG35476Dz6` (6 dec, mint authority = config PDA) |
| xBOND mint | `EZtQnHjCr2cHLMUNBz3cxrWkwNHiu4LcZ1W87x2TT3Yf` (6 dec, mint authority = config PDA, supply 0) |
| Mint keypairs | `target/deploy/{xtomb,xshare,xbond}-mint.json` (0600) + `.txt` address files |

## Step 4 — Genesis budget funded (by `create_mints`)

Vault balances read back on-chain after the step (all exact per spec §3):

| Vault (PDA) | Balance |
|---|---|
| rewards `Aou6Hq854gJ4aoFQRzadQGc5BBsaUhJLHaMnjwaV64aj` | **30,000,000,000** (30,000 xTOMB — the Genesis budget) |
| farm `DfTpsK7fznG5bT5D5afaF9oDqsCkQRvbZCVD7q94YvCP` | 25,641,000,000 (25,641 xSHARE) |
| treasury-xtomb `DEzcrg3wQLoSEiQXSy38RxH4jX6DfTMUwERA2xQpbzi1` | 11,000,000,000 (11,000 xTOMB launch bucket) |
| treasury-xshare `BmiXUkCr56vBGt2x6hz5pTsAKnGnnbjqWWKbxW5v5M8t` | 751,000,000 (751 xSHARE launch bucket) |
| vesting `DhiuqBF66eeDGtdJNfjz4uSEL9nfgEtrUkHeX1Wa5gA` | 6,941,000,000 (6,941 xSHARE) |
| masonry `5V7gAjMXuAfTUVyaeZJqvy8c7mdJGeDvy31YHsHd8Zs2` | 0 (correct — fills by expansion) |

Circulating xTOMB: 41,000,000,000 (30,000 rewards + 11,000 launch). The
11,000 xTOMB / 751 xSHARE sit as single buckets in the treasury vaults;
splitting them among the four wallets is operator work post-deploy (per
the morning report's decision 13).

## Step 5 — `set_wallets` + `set_oracle`

| Item | Value |
|---|---|
| `set_wallets` signature | `4aYKFtvXc9yGTKDQdttFPGmWCPJp8vLfpgrQzNwSZYp991Yowv3v7B7B59wjx9j85ECwxTjMmFSFVAiRtbqUnxjJ` (finalized, slot 519548651) |
| `set_oracle` signature | `2DmAjkWeY2SpWzFzbXyBD5hbKRHYvFMJGF9T1QtpyCDviUCPa8UGqYYA1amq8a9wSATWvhBQU71m6o7WKGmX8p6L` (finalized, slot 519548663) |
| Oracle TWAP | 1,000,000 e6 (**$1.00**), posted at ts 1794027861, authority unchanged (payer) |

## Final verification (read back on-chain)

`npx ts-node scripts/deploy.ts verify` — config, mints, vaults, oracle all
as above; `epoch0_open: false`, `maintenance: false`,
`critical_defense: false`, `genesis_rewards_distributed: 0`,
`expansion_allowance: 0`, `bond_outstanding: 0`.

Smoke tests against the live program (both dry-run, sent nothing):
- `scripts/keeper.ts --dry-run --once` — loads config, no owners file, exits clean (previously failed with "config not found").
- `scripts/peg-bot.ts --dry-run --once --twap 1000000` — reads config, TWAP $1.00, buyback guard open, bot balance 0.
- Frontend on port 3107 still serving: `/` and `/genesis` both 200 (still the
  simulated build — wiring it to the live program is follow-up work).

## Cost accounting

| Item | SOL |
|---|---|
| Wallet at start | 21.656209306 |
| Wallet at end | **18.056211346** |
| Total out | 3.59999796 |
| — of which program account rent (held, recoverable on close) | 3.51957132 |
| — of which IDL account rent (held, recoverable on close) | 0.05520944 |
| — of which tx fees + mock-USDC mint/ATA rents | ~0.02521720 |

The wallet is healthy for further devnet work (18.06 SOL). No top-up
needed for the next steps (pools, pass smoke test). If it ever runs low,
ask Jess — do not find other funds.

## Rehearsal choices (one-line correctable by admin instruction)

1. All four wallets + oracle authority = the payer wallet (only funded
   devnet wallet). Change with `set_wallets` / `set_oracle` any time.
2. USDC is the **mock** USDC `2EN7s...LimCbA`, not Circle devnet USDC.
   Consequence to know: `usdc_mint` is set at `initialize_config` and
   there is no `set_usdc_mint` instruction — this deployment is pinned to
   the mock. Switching to real devnet USDC would need a fresh deploy.
3. Genesis started at deploy time (2026-11-07 00:03:22 EST), so the 7-day
   window runs to 2026-11-14 00:03:22 EST.
4. Initial TWAP posted at $1.00 by the payer (oracle authority).
5. Mint authority for all three mints is the config PDA; no freeze
   authority on any mint.

## Still open / not done

- **No pools added yet** (`add_pool` not run). Genesis pools need asset
  mints: USDC pool = the mock USDC; SOL/JLP/WETH/WBTC pools need those
  mints on devnet. Next step before any deposit testing.
- **No pass bought / no stake tested on-chain yet.** `buy_pass` (Metaplex
  Core NFT + mock USDC payment) is the next live smoke test.
- Epoch 0 not triggered (manual admin action only, per spec).
- No vesting-release instruction for the 6,941 xSHARE / 11,000 xTOMB
  launch buckets (operator work post-deploy).
- No live TWAP feed for the peg-bot (takes `--twap` / `--twap-file`;
  Jupiter/Raydium integration still a TODO).
- Validator test suite never executed (local validator dies in the
  sandbox; bankrun 18/18 covers the cases in-process).
- No keeper allowlist / opt-in registry; no USD-value weighting for
  multi-asset staking; no on-chain AMM (compound settles in accounting
  units at TWAP).
- **No audit.** Nothing here is labeled production-ready.

## Infrastructure notes (for the next deploy)

- **Devnet websocket is broken from this sandbox** (wss to
  `api.devnet.solana.com` fails TLS/EPROTO). Consequences, all worked
  around: (a) Anchor `.rpc()` confirmation times out even when the tx
  lands — `scripts/deploy.ts` now sends via `sendRawTransaction` and
  polls `getSignatureStatuses` over HTTP; (b) `solana program deploy`
  panics creating a TPU client — always pass `--use-rpc`; (c) `anchor
  idl init` worked (it polls HTTP).
- `solana program deploy --buffer <existing>` resumes a partial buffer
  write; the buffer persists across failed attempts.
- Anchor 0.30 TS client: PDA accounts (`config`, vaults, pools) and
  fixed-address accounts (system/token programs, rent) are auto-derived
  and must NOT be passed in `.accounts()`; accounts with `relations`
  (e.g. `admin` in `create_mints`) are auto-resolved from the related
  account. `scripts/deploy.ts` follows this; the pre-existing test files
  still carry the old (type-error, runtime-fine) pattern.
- Ankr's public devnet RPC now requires an API key — not usable without
  one. `https://api.devnet.solana.com` is the working endpoint, but it
  drops transactions under sustained bursts; retries make progress
  because the buffer persists.

---

## Addendum — 2026-11-08: Ultra pass price $500 → $300 (redeploy)

**Change (Jess, 2026-11-08 ~08:37 EST — the EVM Ultra $300 change applies
to Solana too):** one constant in `programs/xtomb/src/math.rs` —
`pass_price_usdc` tier 3: `500` → `300`, plus its unit test. Upgrade
deltas derive from `pass_price_usdc`, so they moved automatically:
**Genesis→Ultra +$250** (was +$450), **Pro→Ultra +$200** (was +$400),
Genesis→Pro unchanged at +$50. `math.rs`'s other `500`
(`genesis_pool_share_bps` kind 4 = Ultra-NFT pool 5% share in bps) is NOT
a pass price and was not touched. No account layout change — constant
only. Also updated: `instructions.rs` buy-pass comment, `SOLANA-XTOMB-SPEC.md`
(§4 table + upgrade deltas), frontend `src/lib/xtomb.config.json`
(Ultra price + upgrade costs), wizard lock message + docs page (local
source only; frontend not deployed to Vercel), and the two bankrun/live
test treasury expectations that hard-coded the $500 price.

**Tests before deploy:** Rust unit tests **11/11 pass**. Bankrun suite
**18/18 pass**. (The old live-network `tests/xtomb.ts` cannot run in this
sandbox — its before-all hook does a devnet faucet airdrop and the faucet
now returns `410 Gone`; pre-existing environment failure, unrelated to
this change. Its stale $500 expectations were still updated.)

| Item | Value |
|---|---|
| New `.so` | 692,656 bytes, sha256 `066d3c19e4eaeb3096612d62f2b4863da34906c0b8070bd896aed5ca93557763` (old: `ea086018ab7c9cbe8435f46c051c852b8898a6fc580cf9e5f5d845304ae7a7cf`) |
| Upgrade tx | `5E3bNoKD2fJ29FqpfwgoRFw8Hu3n9gTGk3mpsLCaxRWd91iN1rne4X2GnDHSg1MUjmhKei1vFhwi1XJt1LYKbozH` (slot 520040276, no error) |
| Program ID | `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY` — **unchanged** |
| ProgramData | `Df5GHtybNCQZasiU2Bq75SrVtRrsjSocTrjBZC7grXE3` — unchanged; last deploy slot 519547971 → **520040276** |
| Authority | `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` — unchanged |
| On-chain code check | ProgramData account fetched over HTTP; code section (data after the 45-byte header) is **byte-identical to the new local `.so`** (sha256 match) |
| State check | `scripts/deploy.ts verify` read back after the upgrade: config PDA, Genesis window 1794027802 → 1794632602, budget 30,000,000,000 (distributed 0), TWAP $1.00, all three mints, and all six vault balances (30,000 / 25,641 / 11,000 / 751 / 6,941 / 0) — **all identical to the pre-upgrade values above** |
| Cost | Wallet 28.056051478 → 28.052386478 SOL (~0.0037 SOL in tx fees; buffer rent refunded) |

**Still in force:** devnet only, no audit, no pass bought / no stake
tested on-chain yet (smoke-test go still outstanding from Jess). Known
gap (separate follow-up, NOT this redeploy): pass prices are still
hardcoded in `pass_price_usdc` — making them config/wizard fields with
an admin setter per Jess's configurability rule is its own piece of work.

---

## Addendum — 2026-11-08: Genesis-tier deposit fee 3% → 2% (redeploy)

**Change (Jess, 2026-11-08 ~09:47 EST — "SOL 1% deposit fee with Pro,
2% with regular Genesis NFT, 0% on all pools with Ultra"):** the Solana
deposit fee is per pass tier: **Genesis 2% / Pro 1% / Ultra 0%**.

**Where the fee lived:** a hardcoded constant function,
`deposit_fee_bps` in `programs/xtomb/src/math.rs` — NOT a config value
(`set_fee_config` covers only claim/keeper/LP fees and the split), so
this needed a code change + program upgrade, same playbook as the $300
change. It is applied in the single `stake` instruction: on
standard (Genesis single-stake) pools the fee is taken from the deposit
and transferred to the **config treasury wallet**; a caller with no
pass on file defaults to the Genesis tier.

**Exact changes (constants/logic only, no account layout change):**
1. `math.rs` — `deposit_fee_bps`: tier 1 (Genesis) `300` → `200`, and
   the no-pass default `300` → `200`. Pro stays `100`, Ultra stays `0`.
   Unit test updated.
2. `instructions.rs` — LP-pool arm of the same `stake` fee match: the
   flat `config.lp_fee_bps` (0.5%) is now **waived when the staker's
   pass tier is Ultra**, so Jess's "0% on all pools with Ultra" holds
   on the LP path too (previously Ultra holders paid the 0.5% LP fee).
   Genesis/Pro on LP pools are unchanged (flat 0.5%, its own separate
   mechanism per spec §5). Farm/Masonry pools charge no deposit fee to
   any tier — unchanged.
3. Records: `SOLANA-XTOMB-SPEC.md` (§4 table 3% → 2%, §5 fee text + LP
   Ultra exception), frontend `src/lib/xtomb.config.json` (Genesis
   pass fee + default fee 3 → 2), Genesis and Wizard page copy
   ("Genesis 2% / Pro 1% / Ultra 0%"). Local frontend rebuilds clean.

**Tests before deploy:** Rust unit **11/11 pass**, bankrun **18/18
pass** (against the new binary). `tests/xtomb.ts` still cannot run in
this sandbox (devnet faucet returns 410 in its before-all — pre-existing,
unrelated); its fee expectations were checked by eye — the standard-pool
assertion is the Pro 1% case and the LP assertion stakes as Pro, both
unaffected.

**Deploy path (three attempts, all documented):** the new `.so` is
692,704 bytes — 48 bytes LARGER than the deployed 692,656 — so attempt 1
failed at the final step ("account data too small for instruction").
Extending ProgramData first failed twice with a bare InvalidArgument;
simulating the loader instruction by hand surfaced the real rule from
the loader's own log: **"ExtendProgram requires a minimum of 10240
additional bytes"**. ProgramData was pre-funded (+0.10 SOL across two
transfers) and extended by 10,240 bytes (tx
`4J1XsUQ68jJDQuLoFjr627k6E8PPFVMMm3A5szbwwcb7uiXoP9gCu9qqXDYtccJQhVY53FsCfKF7nY9pC1mKyMiJ`),
taking it to 702,896 bytes. Attempt 2's buffer writes then died on the
public RPC ("Max retries exceeded" — the known burst-drop behavior);
the complete buffer was identified by hashing each candidate buffer's
payload against the local `.so` (buffer
`8e5dLTbonWerK5Z8uFWYMMMKefy53iSKgus3o3sqsJ4V` matched exactly) and the
deploy was resumed from it.

| Item | Value |
|---|---|
| New `.so` | 692,704 bytes, sha256 `6ffe3b7d75e0e640e8231d47a8a00071c1f9478a335d5d7aa615bf59cccab939` (previous: 692,656, `066d3c19…`) |
| Upgrade tx | `4p24BoJF5A2uP7SSmy63xHddpu74WRH7BEAyEizeUnVBtzDyGd2agSJjNTaWsUCEubcbZKVnG6byA9VHbkCC3EjN` (slot 520058941, no error) |
| Program ID | `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY` — **unchanged** |
| ProgramData | `Df5GHtybNCQZasiU2Bq75SrVtRrsjSocTrjBZC7grXE3` — extended 692,656 → 702,896 bytes; last deploy slot 520040276 → **520058941**; balance 3.57159052 SOL (includes the pre-funding; ~0.048 SOL of it is spare lamports above the original rent) |
| Authority | `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs` — unchanged |
| On-chain code check | ProgramData fetched over HTTP; code section's first 692,704 bytes are **byte-identical to the new local `.so`** (sha256 match), extension tail all zeros |
| State check | `scripts/deploy.ts verify` read back after the upgrade: config PDA, Genesis window 1794027802 → 1794632602, budget 30,000,000,000 (distributed 0), TWAP $1.00, all three mints, and all six vault balances (30,000 / 25,641 / 11,000 / 751 / 6,941 / 0) — **all identical to the pre-upgrade values**; epoch0_open / maintenance / critical_defense all false; expansion allowance and bond outstanding 0 |
| Cost | Wallet 28.052386478 → **27.993777278 SOL** (net ≈ 0.0586 SOL: extension rent now held in ProgramData + tx fees). The partial buffer from attempt 2 (`556PJTy7…`) was closed and its 3.51981516 SOL rent recovered. An older 657,093-byte buffer (`BojdyP6A5…`) under the same authority was left untouched — it is not this program's (size matches the Lodge lane's build) |

**Judgment call flagged (one line reverses it):** Jess's sentence sets
the tiered deposit fee and says Ultra is 0% "on all pools". The LP
pool's flat 0.5% is a separate fee that previously applied to Ultra
holders too; it is now waived for Ultra only (change 2 above). If Jess
meant the tier percentages to *replace* the LP fee outright (LP deposits
at 2%/1%/0% by tier), that is a further small change — not done here.

**Still in force:** devnet only, no audit, no pass bought / no stake
tested on-chain yet (smoke-test go still outstanding from Jess). Known
gap (same follow-up as pass prices): the tier deposit fees are still
hardcoded in `deposit_fee_bps` — making them config/wizard fields with
an admin setter per Jess's configurability rule is its own piece of
work. ProgramData now has 10,240 bytes of headroom, so the next upgrade
will not need another extension.


---

# Addendum — 2026-11-08: Fire Tax re-ruling LIVE (3% / 6% at peg, shared curve, admin-configurable)

Jess's re-ruling (2026-11-08): the peg token's withdrawal Fire Tax at peg is
**3%** (was a 1% baseline), the share token's is **6%** at peg; both rise on the
SAME quadratic curve; the share token hits the 12% cap sooner only because it
starts higher; after the recovery window BOTH taxes settle at **3%**; an admin
override can zero both taxes while the protocol is healthy; all of it
configurable in the admin section.

## What changed in the math (curve restructure)

The old code computed an ABSOLUTE curve — `100 + 1100·f²` bps for both tokens,
with the per-token difference living only in the Genesis minima (300/600). It
is now **baseline + shared increment**: `min(base + increment, cap)` where the
increment is unchanged in shape (0 at/above peg, +1100 bps at TWAP ≤ $0.85,
quadratic between), `base` is 300 (xTOMB) / 600 (xSHARE), cap 1200.

| TWAP | xTOMB before → after | xSHARE before → after |
|---|---|---|
| ≥ $1.00 | 1% (3% in Genesis) → **3%** | 1% (6% in Genesis) → **6%** |
| $0.925 | 3.75% → **5.75%** | 6% (Genesis min) → **8.75%** |
| $0.90 | 5.88% → **7.88%** | 6% → **10.88%** |
| cap reached | $0.85 | $0.85 → **~$0.889** (1199 bps at TWAP $0.889218) |
| ≤ $0.85 | 12% | 12% |

Recovery: the stored floor now decays linearly over the 7 h window to a
resting rate of **300 bps for both tokens** (was the 1% baseline). The Genesis
minima are unchanged (300/600 bps) and now equal the baselines — the
`max(curve, floor, genesis_min)` composition is untouched, no double-counting.
One debit, highest applicable, as before.

## Admin configurability — implemented, no state surgery

The Config account was serialized at 509 of its 1,032 allocated bytes, so the
six parameters were **tail-appended** after `bump` (bytes the old layout never
wrote): `fire_tax_base_xtomb_bps`, `fire_tax_base_xshare_bps`,
`fire_tax_cap_bps`, `fire_tax_rest_bps`, `fire_tax_recovery_secs`,
`fire_tax_zeroed` (17 bytes). No realloc, no migration: the pre-existing
account's zero tail deserializes to 0 = "unset", and the program resolves
unset fields to the compiled defaults (300/600/1200/300/25200/false). Two new
admin instructions (20 total): `set_fire_tax_config` (validates cap ≤ 1200,
bases/rest ≤ cap, window in (0, 30 days]) and `set_fire_tax_zeroed` (the
healthy override — while set, the charged tax is 0 at both collection points).
A stored recovery floor at/below the rest rate resolves to the rest rate, so
this deployment's stored floor of 100 bps needs no write either.

Off-chain proof on the live account (new IDL, read-only fetch): all six new
fields read `0 / false` and `recovery_floor_bps` still reads 100 — i.e. the
new defaults govern with zero on-chain writes beyond the code upgrade.

## Tests, build, deploy

- Rust unit tests **11/11** (curve boundaries incl. both cap crossings,
  one-debit composition incl. zeroed case, recovery decay to the 300 rest).
- Bankrun **18/18** against the new binary. The shared expectation update:
  the $0.925 USDC unstake now taxes 5,750,000 (was 3,750,000), net 94,250,000.
  (`tests/xtomb.ts` updated identically; it still cannot execute in this
  sandbox — devnet faucet 410 in its before-all, pre-existing.)
- New `.so`: **698,952 bytes** (+6,248 over the fee build), sha256
  `a78995141617c348b1d8ac4f882854284bdf6032780ccc2d8d9782826e7cebf8` — fits
  the existing ProgramData (702,896 B) with no extension.
- Deploy path: the first attempt's buffer writes were dropped/corrupted by
  the public RPC under burst (184/699 chunks mismatched on read-back); the
  buffer (`12sUbKLxTpDT6SX3LD6Kvdt9QWurUDMxgMoVePcZbJHG`) was repaired with
  `write-buffer --use-rpc` to a byte-exact copy (hash-verified), then the
  upgrade deployed from it. The older Lodge-lane buffer was not touched.
- **Upgrade tx:
  `4q1irsbStY81VWCb4gbJ3ZzHZ82ZofW6iwthun6mK17GH7teJr5QpQN8MHNjnDXsntjufGANuVpHTjBmYygRZwvC`**
  (slot 520066818). On-chain ProgramData code section is byte-identical to
  the local `.so`. Program ID unchanged.
- **State verification: ALL IDENTICAL to the original DEPLOY-REPORT
  baseline** — Config PDA (Genesis 1794027802 → 1794632602, budget
  30,000,000,000, distributed 0, TWAP 1,000,000 @ 1794027861, all flags
  false), all mints, all six vault balances (30,000 / 25,641 / 11,000 / 751 /
  6,941 / 0), expansion and bond counters 0 — and the Config account now
  decodes under the new 20-instruction IDL.
- Wallet after: **27.990027278 SOL** (was 27.993777278; the buffer rent was
  recovered on deploy, so the net cost was fees only, ~0.00375 SOL).

Spec §6, both `xtomb.config.json` copies, the frontend fire-tax helper
(`fireTaxPercent` now takes the token and mirrors the on-chain
baseline+increment model), and the docs/admin/home/swap copy were updated.
No pass or stake smoke tests were run in this pass, per instructions.


---

# Addendum — 2026-11-08 (second upgrade): Genesis claims follow the Fire Tax

Jess's additional ruling (2026-11-08 ~10:20 EST), folded into the same job
as the Fire Tax re-ruling above: **"Genesis withdraw fees from claims
follow fire tax."** Deployed as a second upgrade; the values-only upgrade
from the addendum above is tx `4q1irsbS…` (slot 520066818), this one is
below.

## What changed

- **Claim fee during Genesis:** inside the Genesis window
  (`genesis_start_ts ≤ now < genesis_end_ts`), a claim on a Genesis pool
  (standard / LP / Ultra) no longer pays the flat `claim_fee_bps` (2%).
  It pays the **current xTOMB Fire Tax rate** from the same
  `fire_tax_for` helper the withdrawal path uses — baselines, shared
  curve, recovery floor, Genesis minimum, and the admin healthy override
  all included (while `set_fire_tax_zeroed` is on, a Genesis claim's fee
  is 0). Charged on liquid + any due vesting installment, one rate.
- **Routing:** the charged tax **burns 100%**, exactly like a Genesis
  xTOMB withdrawal — burned out of the rewards vault, nothing to
  Treasury. (The `Claim` context gained the `xtomb_mint` account for the
  burn; account list only, no account layout changed.)
- **Fail-closed oracle:** because the fee is TWAP-priced, a Genesis
  claim now requires a fresh oracle, mirroring unstake/compound.
  Post-Genesis claims never touch the oracle check.
- **Unchanged:** post-Genesis claims pay the flat 2% to Treasury
  (vesting installment claims included — installments only exist after
  Genesis end); **Masonry-pool claims pay the flat fee at any time**
  (the Masonry is not a Genesis position); the farm harvest fee is a
  different instruction and untouched; the 3h claim/compound cooldown
  is unchanged.

## Tests

- Rust unit **11/11** (rate math unchanged).
- Bankrun **19/19** (one new test). Exact-assertion coverage, measured
  from vault / mint-supply / balance deltas so no accrual simulation is
  involved:
  - "Genesis claim at peg pays the 3% Fire Tax (burned, not the flat
    2%)" — fee == floor(gross × 300 / 10_000), mint supply drops by
    exactly the fee, Treasury xTOMB balance unchanged.
  - "Genesis claim below peg pays the curve Fire Tax (7.88% at $0.90),
    burned" — fee == floor(gross × 788 / 10_000) at TWAP $0.90 (placed
    after a 4 h warp so the earlier $0.85 unstake's 12% recovery floor
    has decayed to ~6.85%, below the curve rate).
  - The pre-existing vesting test still passes on the post-Genesis flat
    fee path; the xBOND top-up claim (still inside Genesis) now posts a
    fresh oracle first, as the new fail-closed check requires.
  - `tests/xtomb.ts` mirrored (title, fresh oracle, `xtombMint`
    account); it still cannot execute in this sandbox (devnet faucet
    410 in its before-all, pre-existing).

## Build + deploy

- New `.so`: **701,104 bytes** (+2,152 over the Fire Tax build), sha256
  `1d3eadc952b835c3906b5dc2d93c75d1bc368bfb0a5a2ca51db7489b8cc12717` —
  fit the existing ProgramData (702,896 B) with no extension; ~1.7 KB of
  headroom remains.
- Deploy path: the first attempt's buffer writes were again dropped by
  the public RPC under burst ("Max retries exceeded"); the buffer
  (`5fNHiNvgacC4ZyKBD5kkXzsVLHwsZipnFEb5HGdXyWE1`, 43/702 chunks bad on
  read-back) was repaired with `write-buffer --use-rpc` to a byte-exact
  copy (hash-verified), then the upgrade deployed from it. The older
  Lodge-lane buffer was not touched.
- **Upgrade tx:
  `4BeocMs5oju6WUZi3v4mKhaoDGbVKJmCfe5BhdKL2cKkYRoaV5RyUDF6ryJXvZQeZs5uNvnFovEougx984p2c6KL`**
  (slot 520070178). On-chain ProgramData code section is byte-identical
  to the local `.so`. Program ID unchanged.
- **State verification: ALL IDENTICAL to the original DEPLOY-REPORT
  baseline** — Config PDA (Genesis 1794027802 → 1794632602, budget
  30,000,000,000, distributed 0, TWAP 1,000,000 @ 1794027861, all flags
  false), all mints, all six vault balances (30,000 / 25,641 / 11,000 /
  751 / 6,941 / 0), expansion and bond counters 0.
- Wallet after: **27.986227278 SOL** (was 27.990027278; buffer rent
  recovered on deploy, net cost ~0.0038 SOL in fees).

Spec §4/§5 claim-fee text and §6 updated (new Genesis-claims bullet);
both `xtomb.config.json` copies gained
`claim_fee_during_genesis: "Fire Tax rate (xTOMB schedule), burned 100%"`;
Genesis/Docs/Admin frontend copy updated; tracked IDL copy refreshed.
No pass or stake smoke tests were run in this pass, per instructions.

---

# Addendum — 2026-11-08 (third upgrade): Masonry claims follow the Fire Tax; liquidity-withdrawal verification

Jess's ruling (2026-11-08 ~10:47 EST): **"we tax liquidity withdraw at
the fire rates, claiming xTOMB from the Marony [Masonry] is taxed at
fire rates."** The second clause reverses the scoping call made in the
second upgrade above (Masonry-pool claims had kept the flat 2%).

## What changed

- **Masonry-pool claims of xTOMB now charge the current xTOMB Fire Tax
  rate at all times** — the same `fire_tax_for` helper the withdrawals
  and Genesis claims use (shared curve, recovery floor, Genesis
  minimum, and the admin zero-override all included), instead of the
  flat `claim_fee_bps`. Like the other Fire-Tax-priced actions, a
  Masonry claim now fails closed on stale oracle data.
- **Routing follows the xTOMB withdrawal-tax routing:** post-Genesis
  the tax goes to **Treasury** (no burn). The burn branch uses the same
  condition as the withdrawal path (xTOMB tax inside the Genesis
  window); Masonry rewards only exist once epochs run, so for the
  Masonry that branch is unreachable in practice and is kept only for
  code-path consistency.
- **Unchanged:** post-Genesis claims on Genesis pools — vesting
  installment claims included — keep the flat 2% to Treasury; Genesis
  claims inside the window still pay the Fire Tax and burn; the 3h
  claim/compound cooldown is unchanged. No account layout changed (the
  `Claim` context already carried every account this needs).

## Liquidity-withdrawal verification (Jess's first clause — checked, not assumed)

Every principal-exit path in the deployed code was re-read for this
upgrade:

- **`unstake` is the only principal-withdrawal instruction**, and it
  charges `fire_tax_for` for every pool kind — standard, **LP**,
  **farm**, and Masonry (`instructions.rs`, the `fire_tax_for` call in
  `unstake`). LP-pool unstakes and farm-position principal withdrawals
  therefore already pay the Fire Tax; nothing had to be brought onto
  it. The Ultra-NFT exit through the same instruction moves no
  principal (the NFT itself), so there is nothing to tax.
- `compound`'s sell leg already pays the Fire Tax at all times
  (burn inside Genesis, Treasury after).
- `harvest` (farm xSHARE rewards — a reward claim, not a principal
  withdrawal) keeps the flat claim fee on the xSHARE leg; it is not a
  liquidity withdrawal and was left as designed.
- `redeem_bond` is a TWAP-gated mint from the expansion allowance, not
  a staking exit; no fee by design.

## Tests

- Rust unit **11/11** (rate math untouched).
- Bankrun **21/21** (two new tests, exact-assertion style, measured
  from vault / Treasury / supply deltas):
  - "Masonry claim at peg pays the 3% Fire Tax to Treasury (not the
    flat 2%)" — fee == floor(gross × 300 / 10,000), paid to Treasury,
    mint supply unchanged.
  - "Masonry claim below peg pays the curve Fire Tax (7.88% at $0.90)
    to Treasury" — fee == floor(gross × 788 / 10,000), same routing.
  - Scaffolding note: the second test claims on a second position
    (userPro's) opened before the first Masonry epoch minted, so its
    first claim settles both epoch batches in one go — a position's
    *second* claim is not exercised, because of the pre-existing
    `pending_rewards` unit mismatch flagged below.
  - `tests/xtomb.ts` mirrored with the reachable wall-clock path
    (Masonry stake + NothingToClaim), with the payout assertions
    pointed at bankrun (a 6h epoch cannot be waited out there); it
    still cannot execute in this sandbox (devnet faucet 410 in its
    before-all, pre-existing).

## Flagged, NOT fixed here (pre-existing, found during test scaffolding)

`pending_rewards` (instructions.rs) mixes units: it subtracts
`position.reward_debt` — stored as `amount × acc_per_share / ACC_SCALE`
(token-denominated) — directly from `pool.acc_per_share`
(per-share-denominated). A position's FIRST settle is unaffected
(debt is 0 or small), but once `acc_per_share` grows large relative to
the stored debt, a repeat settle overstates pending rewards (measured
in bankrun: a second Masonry claim computed pending ≈ 9,027,421,611
against a true accrual of 985,722,293 in the vault, and reverted with
InsufficientRewards). This predates today's upgrades and affects every
pool kind's repeat claim/harvest/compound settle path. It was left
untouched in this job — Jess's ruling here was fee routing only, and
the fix changes reward accounting program-wide, so it needs its own
go-ahead and its own test pass.

## Build + deploy

- New `.so`: **701,120 bytes** (+16 over the Genesis-claims build),
  sha256 `5e99278650dc067c6aec4eaf7ecd4577fd973dbda0bdb552dabd330967af88b5`
  — fit the existing ProgramData (702,896 B) with **no extension**;
  **~1.7 KB of headroom remains**, so the next feature-sized upgrade
  will need the loader-minimum extension again.
- Deploy: a single `solana program deploy --use-rpc` pass; no buffer
  repair was needed this time.
- **Upgrade tx:
  `51cb3Yy3fvteox2jmbK3ET9UAg9RfBKLgH64GS3vBkzxuVS2cAUeV1MMRBgUi7LMA7LYYJUUWE6iuSACG9YuP3t`**
  (slot 520073493). On-chain ProgramData code section is byte-identical
  to the local `.so`. Program ID unchanged.
- **State verification: ALL IDENTICAL to the original DEPLOY-REPORT
  baseline** — Config PDA (Genesis 1794027802 → 1794632602, budget
  30,000,000,000, distributed 0, TWAP 1,000,000 @ 1794027861, all flags
  false, fire-tax config fields still 0 = compiled defaults), all
  mints, all six vault balances (30,000 / 25,641 / 11,000 / 751 /
  6,941 / 0), expansion and bond counters 0.
- Wallet after: **27.982452278 SOL** (was 27.986227278; buffer rent
  refunded on deploy, net cost ~0.0038 SOL in fees).

Spec §6 gained the Masonry-claims bullet (and §5/§9 claim-fee text
corrected — the earlier flat-fee scoping is superseded); both
`xtomb.config.json` copies gained `masonry.claim_fee`; the tracked IDL
copy was refreshed (no account/argument changes — the Claim context
already carried the accounts). No pass or stake smoke tests were run
in this pass, per instructions.

---

# Addendum — 2026-11-08 (fourth upgrade): pending_rewards unit bug FIXED (Jess-approved)

Jess approved this fix explicitly (2026-11-08 ~11:01 EST): **"Fix it
now — own test pass, then redeploy."** It is the pre-existing bug
flagged at the end of the third-upgrade addendum above. Fee routing,
Fire Tax values, and every other behavior are unchanged — this job is
the accounting fix only.

## The bug and the fix

`pending_rewards` (programs/xtomb/src/instructions.rs) mixed units:
`reward_debt` is stored TOKEN-denominated
(`amount * acc_per_share / ACC_SCALE` at the last settle), but the
function subtracted it directly from `pool.acc_per_share`
(PER-SHARE-denominated) and multiplied the difference by the
position amount. A position's first settle is unaffected (debt 0 or
small); every repeat settle overstates pending, roughly by the
position's whole previous entitlement once the accumulator grows.

Fix (one site — see the audit below): MasterChef form.

```rust
let entitled = position.amount as u128 * pool.acc_per_share / ACC_SCALE;
entitled.saturating_sub(position.reward_debt) as u64
```

`reward_debt`'s doc comment in state.rs, which wrongly described the
field as "(x ACC_SCALE)", is corrected (that wording is also the
only IDL delta — a docs string, no structural change). No account
layout changed; no fee/tax/economic parameter changed.

## Settle-surface audit (why one site is the whole fix)

Every read/write of `reward_debt` and `acc_per_share` was re-read:
`settle_pending` is the ONLY pending computation, and every caller
(stake, unstake, claim, compound, harvest) funnels through it. Every
`reward_debt` WRITE stores the same token denomination
(`amount * acc / ACC_SCALE`): settle_pending itself, stake (token
and Ultra-NFT paths), unstake, compound, and the position-init /
full-exit zeroings (paired with amount = 0). Accumulator credits are
uniformly per-share (update_pool's Genesis/farm minting,
advance_epoch's Masonry credit). No second instance of the unit
error exists. (The LP pool-1 position-init in `compound` also zeroes
debt with amount 0 — consistent.)

## Reproduction (against the pre-fix build, new regression suite)

`tests/bankrun-repeat-settle.ts` (new, permanent) settles the same
position repeatedly on every path, asserting exact deltas against an
independent BigInt mirror of the accumulator math. Pre-fix results:

- **Genesis standard claim #2:** liquid overpaid — vault paid
  **106,005,419** vs the correct **84,821,130** (phantom pending
  212,010,838 gross vs the true 169,642,260 for the window).
- **LP compound #2:** Fire Tax + LP fee burns of **11,219,380** vs
  the correct **8,868,048** (overstated pending over-credited the
  position and overcharged the burns).
- **Masonry claim #2:** **reverted `InsufficientRewards`
  (0x178a)** — the vault held 1,239,225,000 against a phantom
  pending in the billions. (Same failure the third-upgrade job
  measured at ≈9.03B pending vs ≈0.99B true accrual.)
- **Farm harvest #2:** paid **105,294,556** vs the correct
  **35,121,600** for the window.

First settles passed their exact assertions in every scenario, as
expected (debt 0).

## Test pass (post-fix)

- **Rust unit: 14/14** (11 pre-existing + 3 new `pending_rewards`
  tests in instructions.rs: first settle, the repeat-settle
  regression values above, and the debt-covers/saturating cases).
- **Bankrun, existing suite: 21/21.** One stale assertion was
  corrected in tests/bankrun.ts (vesting): it bounded cumulative
  claimed installments by a vesting_total snapshot taken BEFORE the
  first post-Genesis claim — but that claim's settle legitimately
  books the Genesis tail accrual (the pool settles lazily up to
  Genesis end), growing vesting_total past the snapshot. The
  assertion now bounds claimed by the CURRENT vestingTotal (and
  asserts the total did grow). No program behavior was changed to
  satisfy it.
- **Bankrun, new regression suite: 4/4** — Genesis claim x2, LP
  compound x2, Masonry claim x3 (three epoch batches of exactly
  615,000,000 / 624,225,000 / 422,392,250), farm harvest x2, all
  exact-delta. Conservation: per-pool cumulative vault outflow never
  exceeds the emissions credited to that pool (Genesis: cumulative
  entitlement 212,052,824 vs 212,052,825 minted across the two
  windows — 1 unit of accumulator dust remains; farm vault ends at
  exactly 25,641,000,000 - 105,364,800; Masonry vault ends at
  exactly 0). Split settles sum to the single-settle entitlement:
  exactly in the farm and Masonry scenarios (arithmetic is exact at
  those magnitudes); in the Genesis/LP scenarios the only slack is
  the standard two floor roundings (accumulator increment, then
  entitlement), each < 1 unit per settle — the tests assert exact
  equality against a mirror performing the same two floors, so the
  bound is enforced, not estimated.
- `tests/xtomb.ts` was not extended: its payout assertions already
  defer to bankrun (it cannot execute in this sandbox — devnet
  faucet 410, pre-existing); the regression coverage lives in the
  executable suite.

## Build + deploy

- New `.so`: **699,952 bytes** (**1,168 bytes SMALLER** than the
  previous build), sha256
  `f9ded622d056d6f6a2a9b7f606a7f16d387804f5e67db3c8364f603c614292fd`
  — fit the existing ProgramData (702,896 B) with **no extension**;
  **headroom is now 2,944 bytes**.
- Deploy: a single `solana program deploy --use-rpc` pass; no
  buffer repair was needed.
- **Upgrade tx:
  `2zAGVkokpYcYWNRYSavtrNADyhEHy6cUgNyAhLpHxHCu8dbnHhUsU1irHrfg5jNnCiGkrimnuXVp9j14FFvWxXHn`**
  (slot 520077985, finalized). On-chain ProgramData code is
  byte-identical to the local `.so` (the 2,944-byte tail beyond the
  ELF is zero padding). Program ID unchanged.
- **State verification: ALL IDENTICAL to the original DEPLOY-REPORT
  baseline, read before and after the upgrade** — Config PDA
  (Genesis 1794027802 -> 1794632602, budget 30,000,000,000,
  distributed 0, TWAP 1,000,000 @ 1794027861, all flags false), all
  mints, all six vault balances (30,000 / 25,641 / 11,000 / 751 /
  6,941 / 0), expansion and bond counters 0.
- Wallet after: **27.978777278 SOL** (was 27.982452278; net cost
  ~0.003675 SOL in fees, buffer rent refunded).

Spec note: SOLANA-XTOMB-SPEC.md does not describe the
accumulator/reward-debt mechanic anywhere, so nothing in it needed
correction. Git: the working tree still carries ALL of today's
upgrades (including this fix and the new test file) uncommitted on
top of the founding commit `1bdbf17` — nothing was committed or
pushed in this job, per instructions.

# Addendum — 2026-11-08 (fifth upgrade): xBOND reworked to the LP-denominated zap model

Jess's rulings (2026-11-08): bonds only come under peg (gates unchanged);
bonds are **denominated in xTOMB LP**; buying is a **100% zap into the
LP**; paying with the chain's native token (SOL) or USDC credits face at
**1.10x**; the protocol **buys xTOMB to make the LP** (never sells
protocol tokens). The burn-at-buy / expansion-allowance model is
replaced wholesale. Verified on-chain before the work: xBOND supply 0,
`bond_outstanding` 0 — no live positions migrated.

## What the program now does (on-chain enforced)

- **Config tail-append** (spare capacity, same pattern as the Fire Tax
  fields; stored 0/default = compiled default): `bond_premium_bps`
  (default 1000), `bond_lp_mint` (default unset), `bond_backing_lp`,
  `sol_price_e6`, `sol_price_ts`.
- **`buy_bond(payin_amount)`** — gate: fresh TWAP < $1.00
  (`BondBuyClosed` at/above). Accepted pay-ins are only the assets the
  program can price on-chain; anything else -> `BondPayinRejected`:
  USDC (config mint, $1, **premium**), wrapped SOL (canonical native
  mint, valued at the oracle-posted SOL price — unset -> 
  `BondSolPriceMissing`, stale >30 min -> `OracleStale`, **premium**),
  xTOMB (TWAP, no premium). Face = USD value / TWAP x (1 + premium if
  premium asset), u128 math (`math::bond_face_credited`); capped by
  `bond_max_outstanding`. The pay-in moves into a per-mint custody
  vault (PDA `["bond-payin", mint]`, authority = config PDA, created
  on first use) and the face xBOND is minted. **Nothing is burned.**
- **`redeem_bond(amount)`** — gate: fresh TWAP > $1.00
  (`BondRedeemClosed` at/below). Pays xTOMB LP from the backing vault
  pro-rata: entitlement = face x min(`bond_backing_lp`, vault
  balance) / `bond_outstanding` (`math::bond_lp_entitlement`; the
  last face drains the backing exactly). Entitlement 0 -> the whole
  amount queues on the BondPosition (no partial fill, xBOND stays in
  the wallet); queued amounts settle first; amount 0 settles the
  queue only. **The expansion allowance is no longer used by bonds;
  no xTOMB is minted or burned in either direction.**
- **`set_bond_config(premium_bps)`** (admin): sets the premium
  (<= 10,000 else `BadBondConfig`), registers the LP mint and creates
  the backing vault (PDA `["bond-lp-vault"]`). The LP mint cannot be
  changed once set.
- **`set_sol_price(price_e6, ts)`** (oracle authority or admin):
  posts the SOL price for the wSOL pay-in leg.
- **`withdraw_bond_payin(amount)`** / **`deposit_bond_backing(amount)`**
  (bot wallet or admin, else `NotBot`): the operator ends of the
  market leg (below).
- Errors appended (existing codes unchanged): `BondPayinRejected`,
  `BondSolPriceMissing`, `BondLpMintNotSet`, `BadBondConfig`. Events:
  `BondBought` / `BondRedeemed` reworked; `BondConfigSet`,
  `SolPriceSet`, `BondPayinWithdrawn`, `BondBackingDeposited` added.
  `math::bond_buy_cost_xtomb` removed with its test.

## Operator-executed (the honest interim)

There is no AMM on devnet (no xTOMB pool exists; a Jupiter/AMM CPI
zap is unbuilt), so the program does not swap. The market leg runs
off-chain under the bot wallet: `withdraw_bond_payin` takes the
custodied pay-in out, the operator **buys xTOMB with the
stable/native leg and creates the LP**, then `deposit_bond_backing`
registers the LP in the backing vault/counter. Until that leg runs,
redemptions queue — the program never pays out unbacked claims.
Spec S7 states this plainly.

## Tests

- Unit: **15/15** (old `bond_pricing` test replaced by
  `bond_face_crediting` + `bond_lp_entitlements`: $1,000 @ $0.90 with
  premium -> face 1,222,222,222; without -> 1,111,111,111; xTOMB
  pay-in at TWAP credits 1:1; pro-rata + last-face-drains-exactly).
- Bankrun: **22/22** in tests/bankrun.ts (+ the 4/4 repeat-settle
  suite). The old bond segment was rewritten (xTOMB pay-in custodied,
  supply unchanged, vault holds the pay-in; `set_bond_config`
  registers the mock LP; redeem at $1.05 queues with zero backing)
  and the allowance-settle test now settles against deposited
  backing, draining all 600,000 LP to the sole holder. New test:
  premium crediting (USDC $10 -> 12,222,222 face; wSOL 0.1 SOL @
  $150 -> 18,333,333; xSHARE pay-in -> `BondPayinRejected`), buy gate
  at exactly $1.00, queue-then-settle pro-rata in LP (expected payout
  computed from chain state), last holder drains the remainder,
  final outstanding/backing/vault all 0, and `withdraw_bond_payin`
  bot-gating (`NotBot` for a user; bot pulls the full $10 USDC).
  tests/xtomb.ts mirrors the rewritten segment (not executable here —
  devnet faucet 410, pre-existing).

## Build + deploy

- New `.so`: **752,120 bytes**, sha256
  `bf99670405ef3981e818a81a3e9f442065130e5ecb1e0e8c2dc85259dd5fd3d1`.
  It did not fit the 2,944-byte headroom: ProgramData was extended
  4 x 10,240 bytes first (pre-fund + ExtendProgram, the established
  way): extends `5rvLqHYeq5bgvM1rSXnoGjrDsmmDP3zGWF6c3zxevkfZA7TZQ5h8DmETyC3Vgnj4Eodff5D9wcv7Z1eRFbeFKo6Y`,
  `sEcjMpb5M1XUZC1qwHw3yHuzRJ9m4tYkkwdz451V5PELzbGPnWtbXhzeNZzAJ91XCtHC67orSrL2GSpL8rCYvUJ`,
  `3r8Gm4wzZVM8K3XRjckZQg3dUxnBd9q2ag93TR4AnmkCvBfPWzYYswspvunJxnqXWxgVifRiFNLLcquLueaUAzv7`,
  `64rYQpmG8i9Qof7NkhBu2mg488y5Evoqtxnpb29nwLygdY8xeXwwX6aRVbSMVwcwquv9n1WHt3jNY9iUqdJ1bsAA`
  (pre-funds `jjiNShYb...`, `3C98FA9U...`, `5kcfuptL...`,
  `5cAMdWv1...`), 713,181 -> 754,141 bytes total.
- The first `solana program deploy --use-rpc` attempt FAILED on
  buffer writes ("Max retries exceeded") and never upgraded —
  verified: the on-chain code still hashed to the previous build.
  Repaired per the playbook: `write-buffer --use-rpc` rewrote the
  failed deploy's buffer `CPUrt2HuNKzbCUMiDvgbHfJMqk1YSRTtsXXHDrf6dq5f`
  to a byte-identical copy of the `.so` (sha256 verified against the
  buffer account), then deployed from that buffer. (The Lodge-lane
  buffer `BojdyP6A...` was not touched.)
- **Upgrade tx:
  `hmEzqC3X8zfqjuPnBKcfuhmWdHnbQjnbgYHbTcbt13N5ndeTgXs5SjTfnQvLB3umaMgk3bFkynH1TB1CHahPnar`**
  (slot 520085628). On-chain ProgramData code is byte-identical to
  the local `.so`; **headroom after: 1,976 bytes**. Program ID
  unchanged.
- **State verification: ALL IDENTICAL to the pre-job baseline** —
  Config (Genesis 1794027802 -> 1794632602, budget 30,000,000,000,
  distributed 0, TWAP 1,000,000 @ 1794027861, fee splits, fire-tax
  fields 0 = defaults), all six vault balances (30,000 / 25,641 /
  11,000 / 751 / 6,941 / 0), supplies, counters (bond outstanding 0,
  expansion allowance 0). New bond fields at defaults:
  `bond_premium_bps` 0 (= 1,000 resolved), `bond_lp_mint` UNSET,
  `bond_backing_lp` 0, `sol_price_e6` 0, `sol_price_ts` 0.
  `set_bond_config` was deliberately NOT called on devnet — no LP
  mint exists there yet.
- Wallet after: **27.714686278 SOL** (net spend ~0.264 SOL: five
  10,240-byte ProgramData extensions' rent now locked in ProgramData
  plus tx fees; the deploy buffer's rent was refunded on upgrade).
- Records updated: spec S7 rewritten to the LP-zap model (operator
  leg marked interim), `xbond` sections of
  `config/xtomb.config.json` + `frontend/src/lib/xtomb.config.json`,
  `idl/xtomb.json` refreshed from the build. Git: working tree
  uncommitted on top of `1bdbf17` — nothing committed or pushed.

---

# Addendum — 2026-11-08: LP deposit fee to Treasury as POL (Q8) LIVE

Jess's Q8 ruling ("Solana matches EVM — LP fee to Treasury as POL"):
the LP deposit fee no longer burns or strands — it is **transferred
to the config treasury wallet as protocol-owned liquidity**. Claim /
keeper fees and the operational fee split are untouched, as are the
rate (50 bps via `lp_fee_bps`) and who is charged (Genesis/Pro pay,
Ultra exempt in Genesis).

## Charge-point audit (every `lp_fee_bps` charge in the program)

Exactly two charge points exist; both changed, destination only:

1. **`stake`, Genesis LP pool deposits** — before: NOT literally
   burned (the spec's burn path was never implemented here): the
   full gross amount entered the pool vault and the fee portion sat
   in the vault as unclaimed fee shares, with redemption/burn a
   documented follow-up. After: the fee LP tokens transfer to the
   treasury wallet's token account for the LP mint (the `treasury_token`
   account the stake already validated), only the net enters the
   vault. LP mint supply unchanged by the fee.
2. **`compound`, Genesis LP compounds** — before: the fee leg
   (xTOMB-denominated in this AMM-less build, which credits pseudo-LP
   1:1 from xTOMB) was literally **burned** from the rewards vault.
   After: transferred to the treasury wallet's xTOMB account as POL,
   same signed-transfer pattern as the keeper fee above it. xTOMB
   supply no longer changes because of the fee.

No other path charges `lp_fee_bps`: farm LP stakes (`stake` kind
FARM) and Masonry stakes charge 0 today and still do.

## Tests

- Unit: **15/15**.
- Bankrun: **22/22** + repeat-settle **4/4** (26 total in one run).
  New/updated assertions: Pro LP deposit of 1,000,000,000 -> treasury
  LP balance **+5,000,000 exactly**, LP mint supply unchanged,
  position credited 995,000,000 (bankrun + repeat-settle); Ultra LP
  deposit of 1,000,000,000 in Genesis -> credited in full, treasury
  LP balance unmoved, supply unchanged (bankrun); repeat-settle LP
  compounds -> rewards vault still funds Fire Tax + LP fee, but the
  xTOMB supply now drops by the Fire Tax **only**, and the treasury
  xTOMB balance rises by exactly the LP fee each compound.
  `tests/xtomb.ts` encodes no LP-fee burn expectation — unchanged.

## Build + deploy

- New `.so`: **752,072 bytes** (48 B SMALLER than the bond build),
  sha256 `b0fb08673cc2463c326ed10b87f598de274d9db9303f01d1b94264482d6ea3a0`.
  Fit the existing ProgramData (754,141 B) — no extension needed;
  **headroom after: 2,024 bytes**. IDL unchanged (no surface change).
- The public devnet RPC oscillated through the deploy window: three
  direct `solana program deploy --use-rpc` attempts died on buffer
  writes ("Max retries exceeded" / version-query timeouts) without
  upgrading (verified each time). Two `write-buffer` runs completed;
  both buffers were hash-verified byte-identical to the local `.so`
  before use. Deployed from buffer
  `Mpg2e51EStob3a1FMo9r3AcwUMiNsvUFXwYh4roTDRz`.
- **Upgrade tx:
  `5mVy51AssogH2JGVUtJd78tuWcmkmBNZRgBNXis8oCgsqzgCL8SFuzN8iVn7iJhNJ1bc2bXehY5Zweo8vyX68XhP`**
  (slot 520092745). On-chain ProgramData code byte-identical to the
  local `.so`. Program ID unchanged.
- **State verification: ALL IDENTICAL to the pre-job baseline** —
  Config (Genesis 1794027802 -> 1794632602, budget 30,000,000,000,
  distributed 0, TWAP 1,000,000 @ 1794027861, lp/claim/keeper fees
  50/200/200, fire-tax fields 0 = defaults, zeroed false), all six
  vault balances (30,000 / 25,641 / 11,000 / 751 / 6,941 / 0),
  circulating 41,000,000,000, bond fields at defaults
  (`bond_premium_bps` 0, `bond_lp_mint` UNSET, `bond_backing_lp` 0,
  `sol_price_e6` 0, outstanding 0).
- The three orphan buffers this job's failed attempts created
  (incl. the duplicate verified buffer) were closed, recovering
  11.464212 SOL of rent; the Lodge lane's buffer (`BojdyP6A...`) was
  left untouched. Wallet after: **27.701896278 SOL** (net spend
  ~0.0128 SOL, all tx fees).
- Records updated: spec S5 LP-fee bullet rewritten to the POL
  routing (with the before-state stated honestly),
  `lp_deposit_fee_destination` added to `config/xtomb.config.json`
  + `frontend/src/lib/xtomb.config.json`, and the Genesis page copy
  in `frontend/src/app/genesis/page.tsx` ("burned" -> "to Treasury
  as POL" — source only; takes effect on the frontend's next
  deploy). Git: working tree uncommitted on top of `1bdbf17` —
  nothing committed or pushed.

---

# Addendum — 2026-11-08: xTOMB bond pay-in burns at a 3% premium LIVE

Jess's amendment to the LP-zap bond (same day): **xTOMB deposits
should burn like normal bonds and pay 3% premium.** The xTOMB
pay-in branch of `buy_bond` is carved back out of the custody
model; the USDC and wrapped-SOL branches are untouched (custodied,
10% premium).

## The change

- **`buy_bond`, xTOMB pay-in only:** the paid xTOMB is **burned**
  from the buyer's account (classic-bond contraction) instead of
  transferred to the per-mint pay-in vault — the vault is never
  created for the xTOMB mint — and `circulating_xtomb` decreases
  by the burned amount, restoring the pre-rework bookkeeping.
- **Face credited = paid x 1.03:** the pay-in is already
  TWAP-denominated, so value / TWAP x (1 + premium) = paid x 1.03
  exactly (1,000 xTOMB at $0.90 credits exactly 1,030 face — unit
  test asserted). `bond_max_outstanding` still caps the credited
  face.
- **New Config field** `bond_xtomb_premium_bps` (tail-appended,
  same spare-capacity pattern; stored 0 = compiled default **300**)
  with its own admin instruction **`set_bond_xtomb_premium`**
  (validated <= 10,000, `BondXtombPremiumSet` event). The 10%
  stable/native premium field (`bond_premium_bps`) is separate and
  unchanged. `BuyBond.payin_mint` is now writable (the burn CPI
  needs it) — the only other surface change; IDL refreshed.

## Tests

- Unit: **15/15** (new case in `bond_face_crediting`: 900,000,000
  e6 value at TWAP 900,000 with 300 bps -> exactly 1,030,000,000
  face).
- Bankrun: **22/22** + repeat-settle **4/4** (26 in one run). The
  first bond test now asserts: face = pay-in x 1.03
  (integer-mirrored), xTOMB total supply drops by **exactly** the
  pay-in, and the xTOMB pay-in custody vault stays empty (never
  created); the queue/settle chain downstream runs on the credited
  face. The LP-zap test's xTOMB leg asserts the same burn +
  premium and redeems the full credited face, draining backing
  and outstanding to 0 as before. `tests/xtomb.ts` segment
  mirrored (not executable here — faucet 410, pre-existing).

## Build + deploy

- New `.so`: **757,976 bytes**, sha256
  `6d8fd00227233f3495d30856f419af4a76abb09f4b7d2e0d52decefadefb5030`.
  It exceeded the 2,024-byte headroom, so ProgramData was extended
  by the 10,240-byte minimum first (extend tx
  `3AsFsGv5wyVmKF5nSd3KNUwm7ErhFssGae7RKGGgzPMrvko7LvnBiKtH6urMWCuWFg3J359PypfLWvZLrtF1shCU`,
  slot 520095695; 754,096 -> 764,336 bytes shown length). Deployed
  with `solana program deploy --use-rpc` on the first attempt.
- **Upgrade tx:
  `2f6LFtBHNEpsCXKQ8AFNm2D9KCv9GeEa13EXqCW83VUkPGaLuhvdCavp4LyETeGW8eWuKMfaiCBo6J1E6uv66JDu`**
  (slot 520096594). On-chain ProgramData code byte-identical to
  the local `.so` (sha256 match), extension tail all zeros.
  Program ID unchanged. **Headroom after: 6,360 bytes.**
- **State verification: ALL IDENTICAL to the pre-job baseline** —
  full Config field diff (snapshot before/after, empty diff):
  Genesis 1794027802 -> 1794632602, budget 30,000,000,000,
  distributed 0, TWAP 1,000,000 @ 1794027861, circulating
  41,000,000,000, fee fields 50/200/200, fire-tax fields 0 =
  defaults, bond fields at defaults (`bond_premium_bps` 0,
  `bond_xtomb_premium_bps` 0 = 300 resolved, `bond_lp_mint`
  UNSET, `bond_backing_lp` 0, `sol_price_e6` 0, outstanding 0),
  and all six vault balances (30,000 / 25,641 / 11,000 / 751 /
  6,941 / 0). `set_bond_xtomb_premium` was NOT called on devnet —
  the default is the intended value.
- Wallet after: **27.645322078 SOL** (net spend ~0.0566 SOL: the
  extension's ~0.052 SOL rent now held in ProgramData + tx fees;
  the deploy buffer's rent was refunded on upgrade).
- Records updated: spec S7 xTOMB pay-in bullet, premium /
  custody paragraphs, market-leg and redemption wording, and the
  instruction list rewritten for the burn branch; `xbond`
  sections of `config/xtomb.config.json` +
  `frontend/src/lib/xtomb.config.json` (`buy_burns_xtomb: true`,
  xTOMB premium keys added); `idl/xtomb.json` refreshed from the
  build. Known stale copy (pre-existing, NOT touched): the
  frontend bonds page still describes the original classic model
  wholesale (it was never updated for the LP-zap rework). Git:
  working tree uncommitted on top of `1bdbf17` — nothing committed
  or pushed.

---

# Addendum — 2026-11-08 (sixth upgrade): pass prices + tier deposit fees are config fields LIVE

Jess's standing configurability rule applied to the last two hardcoded
economic tables in the program: **pass prices** (`math.rs
pass_price_usdc`: Genesis 50 / Pro 100 / Ultra 300 USDC) and the
**standard-pool deposit fees by tier** (`math.rs deposit_fee_bps`:
Genesis 200 / Pro 100 / Ultra 0 bps). Both were constants; both are
now read from the Config account, retunable by ONE new admin
instruction. Behavior at the current values is unchanged — this job
moves the values, it does not change them.

## What changed

- **Config tail-append** (spare capacity, same pattern as the
  fire-tax and bond fields; the account's raw bytes were untouched
  by the upgrade and its stored tail deserializes to 0): six fields
  after `bond_xtomb_premium_bps` — `pass_price_genesis_usdc`,
  `pass_price_pro_usdc`, `pass_price_ultra_usdc` (u64, whole USDC),
  `pass_deposit_fee_genesis_bps`, `pass_deposit_fee_pro_bps`,
  `pass_deposit_fee_ultra_bps` (u16). A stored 0 resolves to the
  compiled default (50/100/300; 200/100) in
  `instructions::pass_params` — the Ultra deposit fee's default IS
  0, so its stored value is used verbatim and is unambiguous.
- **`set_pass_config`** (new instruction, 26 total; `AdminConfig`
  context, `has_one = admin`): writes all six values and emits
  `PassConfigSet`. Validation: every price > 0 (a real 0 price is
  inexpressible by design — 0 is the default sentinel), every
  deposit fee ≤ 1000 bps; violations revert with the new appended
  error `BadPassConfig` (6042). Existing error codes unchanged.
- **Call sites**: the hardcoded math functions are gone. `buy_pass`
  charges `pass_params(config).price_usdc(tier)` (and reports it in
  `PassBought`); `upgrade_pass` derives its delta from the same
  stored table; `stake`'s standard-pool arm charges
  `pass_params(config).deposit_fee_bps(tier)`. `math.rs` now holds
  `PassParams` (defaults + the table math), mirroring
  `FireTaxParams`. The LP-pool fee (config `lp_fee_bps`, Ultra
  waiver), farm/Masonry (no fee) are untouched.
- **`set_pass_config` was deliberately NOT called on devnet** — the
  stored zeros resolve to exactly the intended current table, same
  as every prior tail-append upgrade in this report.

## Tests

- **Rust unit: 16/16** (15 prior + `pass_params_custom_values_flow_through`:
  a retuned table — 60/120/360, 300/150/25 — drives prices, upgrade
  deltas (60/240/300) and fees verbatim).
- **Bankrun, existing suites: 22/22 + repeat-settle 4/4** — unchanged
  economics at the defaults, confirmed against the new binary.
- **Bankrun, new suite `tests/bankrun-pass-config.ts`: 5/5** —
  self-contained (own config/mints/pool, the repeat-settle pattern):
  fresh config stores all zeros and the defaults govern (Genesis buy
  $50; 1,000-USDC stake credited 980 at the 2% default fee);
  `set_pass_config(60,120,360 / 300,150,25)` reprices a Pro buy to
  $120, the Genesis→Pro upgrade delta to $60, the Pro stake fee to
  1.5% (985 credited), an Ultra buy to $360 and the Ultra stake fee
  to 0.25% (997.5 credited — a nonzero Ultra fee the hardcoded table
  could never express); zero-price and 1001-bps calls revert with
  `BadPassConfig` and write nothing; a non-admin call fails;
  restoring (50,100,300 / 200,100,0) reprices the Pro→Ultra upgrade
  back to $200. All assertions are exact treasury/position deltas.
  (`tests/xtomb.ts` still cannot execute in this sandbox — devnet
  faucet 410 in its before-all, pre-existing; it exercises no
  pass-config surface that bankrun does not cover.)

## Build + deploy

- New `.so`: **765,440 bytes**, sha256
  `fa8a2dd72eac2aa1e9513226de980c113b4f0db43c77c59227490e7a51d07cb8`
  — 1,104 bytes over the ProgramData capacity, so ProgramData was
  extended by the 10,240-byte loader minimum first, via the new
  `scripts/extend-programdata.ts` (pre-fund tx
  `4UMKuqhsjwkxm8rrYxhKHs8t8ozzJsBdVMam7xQGCFKwCNsF5p2rxucSN2P7jeLdK84zD9jzEWgvzqLAc2g1pqDX`,
  52,019,200 lamports; extend tx
  `5gDqHMeWibFMRyaFuQyiq2gZ5Y7mDpVrEUVdcu5CQa4P88hRPuMojCZUHe2K8qM4UPmZZMhVHVvooJsVycr2tctZ`,
  slot 520191308; 764,381 → 774,621 bytes).
- Deploy: a single `solana program deploy --use-rpc` pass; no buffer
  repair was needed.
- **Upgrade tx:
  `3Veo8wWG1u15s77pouzcFLhjcvhnUzpZpsGTXHya4Uw2YHRTyDNi4Y84H8oFE68am3xQ9DH2nVjms4vegK1uLM9w`**
  (slot 520192550). On-chain ProgramData code is byte-identical to
  the local `.so`. Program ID unchanged. **Headroom after: 9,136
  bytes.**
- **State verification: ALL IDENTICAL to the pre-job baseline** —
  full snapshot diff (`scripts/snapshot.ts`;
  `state-snapshots/before-pass-config.json` /
  `after-pass-config.json`): all 52 pre-existing Config fields equal
  (Genesis 1794027802 -> 1794632602, budget 30,000,000,000,
  distributed 0, TWAP 1,000,000 @ 1794027861, fee fields 50/200/200,
  fire-tax and bond fields 0 = defaults), the Config account's raw
  bytes are byte-identical, all six vault balances (30,000 / 25,641
  / 11,000 / 751 / 6,941 / 0), all mint supplies (41,000,000,000 /
  33,333,000,000 / 0 / mock USDC 100,000,000,000), and the only
  Config delta is the six new fields reading 0 (= the defaults
  above).
- Wallet after: **27.587797878 SOL** (was 27.645322078; net spend
  0.0575242 SOL: the extension's ~0.052 SOL rent now held in
  ProgramData + tx fees; the deploy buffer's rent was refunded on
  upgrade).

Records updated: spec §4 configurability note (the table is the
default table; `set_pass_config` owns the live values),
`idl/xtomb.json` refreshed from the build (26 instructions).
Frontend/wizard copy still quotes the default prices and fees —
now labeled defaults in the spec; wiring the wizard to
`set_pass_config` is follow-up work, not part of this upgrade.
Git: this addendum's commit lands the whole working tree (all of
today's previously uncommitted upgrades plus this one) on top of
`1bdbf17` — local only, nothing pushed.
