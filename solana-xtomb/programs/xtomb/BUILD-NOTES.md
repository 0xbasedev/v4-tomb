# xTOMB program — build notes

Decisions made where the spec was ambiguous, plus the dependency fixes
needed to build on this VM. Everything here is correctable by Jess in
one line.

## 1. What was built

Single Anchor 0.30.1 program `xtomb` (program id
`4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY`, devnet-only keypair in
`target/deploy/xtomb-keypair.json`). All 18 spec §11 instructions:
`initialize_config`, `create_mints`, `buy_pass`, `upgrade_pass`,
`stake`, `unstake`, `claim`, `compound`, `harvest`, `add_pool`,
`set_fee_config`, `set_wallets`, `set_oracle`, `buy_bond`,
`redeem_bond`, `advance_epoch`, `buyback_and_burn`, `set_maintenance`.

State: one Config PDA (every economic number lives there), Pass PDA
(one per wallet), Pool PDA + PDA-owned vault per pool, Position PDA
per user+pool, BondPosition PDA per user.

Pure math lives in `programs/xtomb/src/math.rs` (no Anchor types) and
is covered by host unit tests (`cargo test -p xtomb --lib`).

## 2. Decisions where the spec was ambiguous

1. **Compound has no on-chain AMM in this build.** The spec's
   compound sells xTOMB for USDC, adds xTOMB/USDC liquidity and stakes
   it. There is no AMM program on Solana in this tree, so compound
   settles in accounting units at the TWAP reference price: the liquid
   reward is debited the §6 Fire Tax (burned in Genesis, else to
   Treasury), the 2% keeper fee (keeper compounds only), and the 0.5%
   LP fee (burned immediately), and the net is credited as LP position
   units. The compounded xTOMB stays in the rewards vault as backing
   for that credit. The Raydium/Orca swap leg is the documented
   upgrade path, not a silent fake. Same treatment for the LP
   deposit fee: the full deposit goes to the pool vault and only the
   net is credited, so the fee portion sits in the vault as unclaimed
   fee shares; redeeming/burning those shares is a follow-up.
2. **Ultra-NFT 5% share.** "Ultra NFT receives 5% of Genesis
   emissions" is read as 5% of total emissions; the standard/LP split
   applies to the remaining 95% (Day 1: standard 95%; Day 2+: LP
   71.25% / standard 23.75%). The Ultra pool stakes 1 pseudo-unit
   per NFT (no token moves); unstaking it releases the NFT with no
   tax (there is no principal to tax).
3. **Epoch mint split.** Each eligible epoch's mint (3% bootstrap /
   2% expansion of circulating xTOMB) splits 50/50 between Masonry
   stakers (minted to the Masonry vault, credited to the pool
   accumulator) and the expansion allowance (bond-redemption budget).
   If no one is staked in Masonry, the whole mint goes to the
   allowance. This split is invented; correct in one line.
4. **xSHARE Fire Tax split (12/20/68) is accounting, not conversion.**
   `unstake` sends the whole xSHARE tax to the treasury token
   account and records the amount; the 12% POL / 20% USDC-reserve /
   68% Treasury conversion needs a swap and is bot work. In Critical
   Defense the amount is additionally recorded in
   `config.xshare_tax_pending_burn` as earmarked for buy-and-burn.
5. **Standard-pool reward weighting is by raw base units.** Genesis
   standard staking accepts USDC/SOL(wSOL)/JLP/WETH/WBTC, but there
   is no price feed for those assets in this build, so accrual
   weights staked base units equally. Production needs USD-value
   weighting via the oracle. Flagged, not hidden.
6. **Keeper compound authorization.** Any caller may keeper-compound
   a Pro/Ultra position (the 2% fee goes to Treasury, not the
   caller, so there is no rent-seeking incentive); the keeper
   allowlist/beneficiary opt-in registry is a follow-up. The 3h hard
   cap still applies to every caller.
7. **Pass required for Genesis pools only.** Farm/Masonry staking
   does not require a pass (the spec only gates Genesis on the NFT).
8. **Farm rewards are 100% liquid, 2% harvest fee.** The spec does
   not state a farm vesting or fee; harvest mirrors the claim fee
   and the shared 3h cooldown.
9. **Masonry rewards are 100% liquid** (the 50/50 split is a Genesis
   rule, not a Masonry rule).
10. **Launch allocations in `create_mints`.** The 11,000 xTOMB launch
    allocation (5,000 team/dev + 5,000 treasury + 1,000 arb) is
    minted as one bucket to the treasury xTOMB vault; splitting it
    among the four wallets is the operator's job post-deploy. The
    751 xSHARE (550 treasury + 100 team/dev + 100 sale escrow + 1
    deployer) is likewise one bucket. The 180-day linear vesting
    release of the 6,941 xSHARE vesting vault is operator work (no
    vesting instruction in the spec's list).
11. **Canonical pool ids.** 1 = standard, 2 = LP, 3 = Ultra-NFT,
    4 = Masonry, 10+ = farm. `add_pool` enforces this so
    `advance_epoch` can find the Masonry pool.
12. **Bond redemption queue.** Queued xBOND stays in the user's
    wallet (not burned) until a later `redeem_bond` call settles it
    from a replenished allowance. No partial fill, no IOU token.
13. **Recovery floor.** Implemented as a stored rate + timestamp
    with linear decay to 1% over 7h; a higher observed TWAP rate
    restarts it. The Genesis minimum does not restart it (per EVM).
14. **Oracle.** Trusted-authority posts (admin or the configured
    oracle authority) via `set_oracle`; the admin may rotate the
    authority by passing a non-default `new_authority`. Withdrawals
    fail closed on >30 min staleness; buys (stake) stay available.
    On-chain pool parsing is the documented upgrade path.
15. **Buyback guard.** `buyback_and_burn` requires fresh TWAP at or
    below $1.01 and a caller of bot wallet or admin.
16. **Pass NFT metadata URI is empty.** `buy_pass` sets name only
    ("xTOMB Genesis/Pro/Ultra Pass"); the operator sets the URI
    later via the Core program. The NFT is created with a permanent
    freeze delegate (`PermanentFreezeDelegate { frozen: true }`)
    whose authority is the config PDA — frozen at mint, no transfer
    path exists in this program.

## 3. Dependency fixes (build only, no protocol change)

- **Vendored `anchor-syn`** (copied read-only from
  `~/workspace/lodge-solana-v2/vendor/anchor-syn`): anchor-syn
  0.30.1 calls `proc-macro2 Span::source_file()`, removed in
  proc-macro2 1.0.107, so the IDL step fails even when the SBF
  program compiles. The vendored copy uses `local_file()/file()`.
- **Vendored `anchor-derive-serde`** (`vendor/anchor-derive-serde`,
  one-line Cargo.toml change: `borsh-derive-internal = "=0.10.4"`):
  the registry 0.30.1 requires `borsh-derive-internal ">=0.9,
  <0.11"`, and Cargo's resolver reused the 0.9.3 instance (forced
  by `borsh-derive 0.9.3`, itself forced by solana-program 1.18.26's
  borsh 0.9.3). The 0.9.3 derive emits only `deserialize`, but
  borsh 0.10's `BorshDeserialize` trait requires
  `deserialize_reader`, so anchor-lang failed with E0046. The
  0.10.4 derive emits `deserialize_reader`, which borsh 0.10 and
  1.x both accept. This is the same edge lodge's Cargo.lock already
  had (anchor-derive-serde -> borsh-derive-internal 0.10.4); my
  fresh resolve picked 0.9.3 because mpl-core changed traversal
  order. No code changed in the vendored crate.
- **mpl-core 0.8.1** (not 0.9.x): 0.9.1 depends on solana-program
  2.3.0, which cannot coexist with anchor 0.30.1 / solana 1.18.
  0.8.1's `>1.14` requirement unifies to 1.18.26 after
  `cargo update -p solana-program@2.0.25 --precise 1.18.26`.
- **Pins** (same family as lodge, in
  `programs/xtomb/Cargo.toml`): proc-macro2 =1.0.107, blake3
  =1.6.1, borsh =1.5.7, digest =0.10.7, sha2 =0.10.8, block-buffer
  =0.10.4, indexmap =2.5.0, unicode-segmentation =1.12.0,
  zeroize_derive =1.4.2, proc-macro-crate =3.1.0, jobserver
  =0.1.32, rmp-serde =1.1.2, rmp =0.8.14, wasm-bindgen =0.2.92,
  rayon =1.10.0, rayon-core =1.12.1, anchor-attribute-* /
  anchor-derive-* =0.30.1. Host cargo 1.79 / SBF platform rustc
  1.75 cannot build edition2024 crates or crates requiring newer
  rustc.
- `/tmp` is a 512MB tmpfs: `TMPDIR=~/tmp-build` for all cargo work.

## 4. Known gaps / follow-ups (not silent omissions)

- No on-chain AMM: compound and the LP-fee burn settle in
  accounting units (see §2.1). Needs a Raydium/Orca CPI.
- No USD-value weighting for multi-asset standard staking (§2.5).
- xSHARE tax 12/20/68 conversion is accounting-only (§2.4).
- No keeper allowlist / opt-in registry (§2.6).
- No vesting-release instruction for the 6,941 xSHARE / 11,000
  xTOMB launch buckets (§2.10).
- Pass NFT metadata URI is empty (§2.16).
- No audit, no mainnet, no devnet deploy yet. Final .so is 692,656
  bytes (2026-11-05 ~18:43 EST); program-account rent-exempt minimum
  3.51934272 SOL vs devnet wallet 1.65693948 SOL — shortfall
  1.86240324 SOL (program account alone), ~5.38 SOL vs the ~7.04 SOL
  peak (program + buffer) at deploy time. No deploy attempted.

## 5. Stack fixes found by bankrun (2026-11-05 evening)

- **`create_mints` BPF stack crash.** The first bankrun runs died
  with `Access violation in stack frame 3 ... at BPF instruction
  #22780` at 3,663 CU, before any CPI log. Nine Anchor `init`
  accounts (3 mints + 6 token vaults) blow the 4KB BPF stack inside
  `try_accounts`. Boxing the `Account` fields (`Box<Account<...>>`,
  now applied to the 10 largest account structs) saved ~2KB but
  was NOT enough — the crash persisted at the same CU count. Fix:
  `create_mints` no longer uses Anchor `init` at all. The 3 mints
  are `Signer` accounts and the 6 vaults are `UncheckedAccount`s;
  the handler verifies each vault PDA
  (`["vault", name]`, new error `BadVaultPda`), creates the mint
  accounts via system-program `create_account` + token
  `initialize_mint` CPIs, and creates the vaults via
  `create_account` (PDA signer seeds) + token
  `initialize_account3` CPIs (helpers `create_mint_account` /
  `create_vault_account` in `instructions.rs`). Instruction name,
  args and IDL account list are unchanged. .so shrank 757,008 ->
  692,656 bytes.
- **Ultra `pass` must be writable in Stake/Unstake.** The Ultra
  stake path sets `pass.ultra_staked`, but the `pass` account was
  passed read-only (`UncheckedAccount` without `mut`), so the
  runtime rejected the write (`instruction modified data of a
  read-only account`). `#[account(mut)]` added to `pass` in the
  Stake and Unstake structs (Compound's `pass` stays read-only —
  it only reads the tier).

## 6. Bankrun test notes (`tests/bankrun.ts`, 18/18 green)

- The sandbox blocks the UDP gossip the local validator needs, so
  the validator dies after ~90–165s — too short to deploy + test.
  `tests/bankrun.ts` runs the real compiled .so in-process via
  `solana-bankrun` 0.2.0 + `anchor-bankrun` 0.2.0 (plain
  `npx ts-mocha`, NOT `anchor test`). Clock warps via
  `context.setClock` let epochs/vesting/farm windows run without
  real waits. `tests/xtomb.ts` (the validator suite) was never
  executed; bankrun covers the same cases plus epoch/vesting/farm
  warps.
- **Bankrun swallows real errors.** `anchor-bankrun`'s
  `sendAndConfirm` reports every failed tx as `Unknown action
  'undefined'` with no logs. All test txs therefore go through a
  local `rpcRaw` helper that signs the tx and calls
  `banksClient.tryProcessTransaction` directly, throwing the real
  program logs on failure (negative tests assert on the Anchor
  error name in those logs).
- **Bankrun connection proxy is minimal.** It implements only
  `getAccountInfo` / `getAccountInfoAndContext` /
  `getMinimumBalanceForRentExemption`. spl-token's send-based
  helpers (`createMint`, `mintTo`, `transfer`,
  `getOrCreateAssociatedTokenAccount`) fail on it; the suite builds
  those instructions manually (`createMintManual`,
  `mintToManual`, `transferManual`, `ata`) and sends them through
  the provider.
- **`Clock` is a napi class, not a plain object.**
  `setClock` needs `new Clock(slot, epochStartTimestamp, epoch,
  leaderScheduleEpoch, unixTimestamp)` (all bigints); a spread
  object fails with `Failed to recover 'Clock' type`.
- **`PublicKey.default` is a static property, not a method**
  (web3.js 1.x here); `PublicKey.default()` throws.
- **`target/types/xtomb.ts` exports only the `Xtomb` type, no
  `IDL` const.** The suite loads `target/idl/xtomb.json` with
  `fs.readFileSync` at runtime.
- **Oracle freshness vs warps.** A `set_oracle` post goes stale
  after 30 min of warped time, so tests post the oracle AFTER
  each warp, immediately before the call that needs it.
- `tests/probe.ts` (temporary raw-client debugging) was deleted
  after the stack fix landed; the probe findings above are kept
  here.
