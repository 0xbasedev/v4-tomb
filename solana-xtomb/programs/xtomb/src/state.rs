//! On-chain state. Single Config PDA holds every economic number; admin
//! changes go through instructions with events, never silent edits.

use anchor_lang::prelude::*;

/// Pool kinds. Canonical pool ids (see instructions::add_pool):
/// 1 = standard, 2 = LP, 3 = Ultra-NFT, 4 = Masonry, 10+ = farm.
pub const POOL_KIND_STANDARD: u8 = 0;
pub const POOL_KIND_LP: u8 = 1;
pub const POOL_KIND_FARM: u8 = 2;
pub const POOL_KIND_MASONRY: u8 = 3;
pub const POOL_KIND_ULTRA: u8 = 4;

/// Canonical pool ids.
pub const POOL_ID_STANDARD: u64 = 1;
pub const POOL_ID_LP: u64 = 2;
pub const POOL_ID_ULTRA: u64 = 3;
pub const POOL_ID_MASONRY: u64 = 4;

/// Pass tiers: 1 = Genesis, 2 = Pro, 3 = Ultra.
pub const TIER_GENESIS: u8 = 1;
pub const TIER_PRO: u8 = 2;
pub const TIER_ULTRA: u8 = 3;

/// Accumulator scale for per-share reward accounting (MasterChef style).
pub const ACC_SCALE: u128 = 1_000_000_000_000;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub treasury_wallet: Pubkey,
    pub team_wallet: Pubkey,
    pub dev_wallet: Pubkey,
    pub bot_wallet: Pubkey,
    pub oracle_authority: Pubkey,
    pub xtomb_mint: Pubkey,
    pub xshare_mint: Pubkey,
    pub xbond_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub genesis_start_ts: i64,
    pub genesis_end_ts: i64,
    /// Prefunded Genesis reward budget (base units of xTOMB).
    pub genesis_reward_budget: u64,
    /// xTOMB already settled out of the Genesis budget (accounting).
    pub genesis_rewards_distributed: u64,
    /// Genesis emission rate, base units of xTOMB per second.
    pub genesis_emission_per_sec: u64,
    /// Farm emission rate, base units of xSHARE per second (25,641 / 365d).
    pub farm_emission_per_sec: u64,
    /// Latest oracle TWAP, USDC e6 (1_000_000 = $1.00).
    pub oracle_twap_e6: u64,
    pub oracle_ts: i64,
    pub current_epoch: u64,
    pub epoch0_open: bool,
    pub last_epoch_ts: i64,
    pub critical_defense: bool,
    pub defense_above_checkpoints: u8,
    /// Minted xTOMB supply tracked by the program (mint - burn).
    pub circulating_xtomb: u64,
    /// xTOMB mint budget available for bond redemptions.
    pub expansion_allowance: u64,
    pub bond_outstanding: u64,
    pub bond_max_outstanding: u64,
    pub recovery_floor_bps: u16,
    pub recovery_floor_ts: i64,
    pub maintenance: bool,
    /// Operational fee split (bps, must sum to 10_000).
    pub treasury_bps: u16,
    pub team_bps: u16,
    pub dev_bps: u16,
    pub bot_bps: u16,
    pub claim_fee_bps: u16,
    pub keeper_fee_bps: u16,
    pub lp_fee_bps: u16,
    /// Display name of the exit fee ("Fire Tax"); "Fire Hose" is the
    /// config-comment alternative Jess floated.
    pub fee_display_name: [u8; 32],
    /// xSHARE Fire Tax collected while in Critical Defense, earmarked for
    /// buy-and-burn conversion (conversion itself is off-chain/bot work).
    pub xshare_tax_pending_burn: u64,
    pub bump: u8,
    // --- Fire Tax parameters (appended 2026-11-08) ---
    // Config::SPACE was already over-allocated (8 + 1024) against a
    // ~501-byte serialized struct, so these fields live in the account's
    // pre-existing spare capacity: NO realloc, NO migration. Accounts
    // written by the pre-upgrade binary deserialize them from the zero
    // tail, and a stored 0 means "compiled default" (resolved by
    // instructions::fire_tax_params). Set via set_fire_tax_config /
    // set_fire_tax_zeroed.
    /// xTOMB withdrawal Fire Tax baseline at/above peg, bps (default 300).
    pub fire_tax_base_xtomb_bps: u16,
    /// xSHARE withdrawal Fire Tax baseline at/above peg, bps (default 600).
    pub fire_tax_base_xshare_bps: u16,
    /// Fire Tax cap for both tokens, bps (default 1200; never above the
    /// 1200 hard ceiling — the setter validates).
    pub fire_tax_cap_bps: u16,
    /// Recovery floor resting rate for both tokens, bps (default 300).
    pub fire_tax_rest_bps: u16,
    /// Recovery floor decay window, seconds (default 25_200 = 7h).
    pub fire_tax_recovery_secs: i64,
    /// Healthy override: while true, both withdrawal Fire Taxes are 0.
    pub fire_tax_zeroed: bool,
    // --- Bond parameters (appended 2026-11-08, LP-zap model) ---
    // Same spare-capacity pattern as the fire-tax fields: accounts
    // written by the pre-upgrade binary deserialize them from the zero
    // tail. A stored premium of 0 means "compiled default" (1,000 bps
    // = 10%, resolved by instructions::bond_premium_bps_resolved);
    // a default LP mint means bonds are not yet registered.
    /// Premium credited on native-token / USDC bond pay-ins, bps of
    /// pay-in value (default 1000 = 10%). Set via set_bond_config.
    pub bond_premium_bps: u16,
    /// The xTOMB LP mint bonds are denominated in. Redemption pays LP
    /// of this mint out of the bond backing vault. Set (once the LP
    /// exists) via set_bond_config, which also creates the vault.
    pub bond_lp_mint: Pubkey,
    /// LP the operator has deposited into the bond backing vault via
    /// deposit_bond_backing. Redemption entitlements are computed
    /// against this counter (capped by the vault's real balance).
    pub bond_backing_lp: u64,
    /// Oracle-posted SOL price, USD e6 per whole SOL (0 = unset).
    /// Prices the wrapped-SOL bond pay-in leg; posted with
    /// set_sol_price by the oracle authority or admin.
    pub sol_price_e6: u64,
    /// Timestamp of the last SOL price post (freshness-gated like
    /// the TWAP: SOL pay-ins fail closed on a stale price).
    pub sol_price_ts: i64,
    /// Premium credited on xTOMB bond pay-ins, bps of pay-in value
    /// (default 300 = 3%; a stored 0 resolves to the compiled
    /// default, same convention as bond_premium_bps). xTOMB
    /// pay-ins BURN like a classic bond (Jess 2026-11-08) instead
    /// of custoding in the pay-in vault. Set via
    /// set_bond_xtomb_premium. Appended 2026-11-08 (tail-append,
    /// same spare-capacity pattern).
    pub bond_xtomb_premium_bps: u16,
    // --- Pass prices + tier deposit fees (appended 2026-11-08) ---
    // Same spare-capacity pattern as the fire-tax and bond fields:
    // accounts written by the pre-upgrade binary deserialize them
    // from the zero tail. A stored 0 means "compiled default"
    // (resolved by instructions::pass_params): prices 50 / 100 /
    // 300 USDC, deposit fees 200 / 100 bps. The Ultra deposit fee's
    // default IS 0, so its stored value needs no resolution and is
    // used verbatim. Set via set_pass_config (Jess's standing rule:
    // prices and fees are config fields, never hardcoded).
    /// Genesis pass price, whole USDC (default 50).
    pub pass_price_genesis_usdc: u64,
    /// Pro pass price, whole USDC (default 100).
    pub pass_price_pro_usdc: u64,
    /// Ultra pass price, whole USDC (default 300).
    pub pass_price_ultra_usdc: u64,
    /// Standard-pool deposit fee for Genesis pass holders, bps
    /// (default 200 = 2%).
    pub pass_deposit_fee_genesis_bps: u16,
    /// Standard-pool deposit fee for Pro pass holders, bps
    /// (default 100 = 1%).
    pub pass_deposit_fee_pro_bps: u16,
    /// Standard-pool deposit fee for Ultra pass holders, bps
    /// (default 0).
    pub pass_deposit_fee_ultra_bps: u16,
    // --- Weekly loyalty boost parameters (appended 2026-11-09) ---
    // Same spare-capacity pattern as the pass fields above. The
    // percent resolves through instructions::boost_percent: until
    // `boost_percent_configured` is set (by initialize_config of this
    // binary, or the first set_boost_config), a stored value is
    // ignored and the compiled default of 5 applies — Jess
    // 2026-11-09: the 5 is baked in, admin-settable 0-25 (0 = off,
    // storable once configured). Week length resolves 0 -> 7 days.
    // Set via set_boost_config (settle-under-old first for percent;
    // week length locks at the farm start).
    /// Weekly boost percent of farm emissions (default 5).
    pub weekly_boost_percent: u16,
    /// True once the boost percent has been explicitly written.
    pub boost_percent_configured: bool,
    /// Loyalty week length, days (default 7; valid 1-30).
    pub week_length_days: u16,
    /// Sum of all farm pool weights (bps), maintained by add_pool.
    /// The boost carve-out weights against this total, EVM-style.
    pub farm_weight_total_bps: u16,
    /// True once initialize_boost has created the BoostState PDA.
    /// Masonry stake/unstake require the boost accounts from then on.
    pub boost_initialized: bool,
}

impl Config {
    pub const SPACE: usize = 8 + 1024;
}

#[account]
pub struct Pass {
    pub owner: Pubkey,
    /// 1 = Genesis, 2 = Pro, 3 = Ultra.
    pub tier: u8,
    /// Metaplex Core asset (soulbound NFT) for this pass.
    pub asset: Pubkey,
    pub purchased_ts: i64,
    /// True while the Ultra NFT itself is staked in Genesis.
    pub ultra_staked: bool,
    pub bump: u8,
}

impl Pass {
    pub const SPACE: usize = 8 + 128;
}

#[account]
pub struct Pool {
    pub pool_id: u64,
    /// 0 standard, 1 LP, 2 farm, 3 masonry, 4 ultra-NFT.
    pub kind: u8,
    pub asset_mint: Pubkey,
    /// PDA-owned token vault holding staked principal.
    pub vault: Pubkey,
    pub total_staked: u64,
    /// Accumulated xTOMB (or xSHARE for farm pools) per staked unit, x ACC_SCALE.
    pub acc_per_share: u128,
    pub last_update_ts: i64,
    /// Farm pool weight in bps of the farm emission rate (farm pools only).
    pub weight_bps: u16,
    pub active: bool,
    pub bump: u8,
}

impl Pool {
    pub const SPACE: usize = 8 + 192;
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub pool_kind: u8,
    pub asset_mint: Pubkey,
    /// Staked principal (base units). Ultra-NFT positions hold 1 pseudo-unit.
    pub amount: u64,
    /// Reward debt, TOKEN-denominated: `amount * acc_per_share /
    /// ACC_SCALE` at the last settle. Pending rewards are the
    /// position's current token entitlement minus this debt — the
    /// debt is NOT a per-share quantity.
    pub reward_debt: u128,
    /// Settled rewards awaiting claim: liquid half (xTOMB, or xSHARE on
    /// farm positions).
    pub accrued_liquid: u64,
    /// Settled rewards awaiting vesting (xTOMB, Genesis pools only).
    pub accrued_vested: u64,
    /// Total vested rewards in the current tranche (base units).
    pub vesting_total: u64,
    /// Base units of the tranche already released.
    pub vesting_claimed_amount: u64,
    /// Installments already released (0..16).
    pub vesting_claimed_installments: u8,
    /// Unix time the next vesting installment opens.
    pub vesting_next_ts: i64,
    /// Shared 3h claim+compound clock (last claim or compound, 0 = never).
    pub last_cooldown_ts: i64,
    pub genesis: bool,
    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8 + 256;
}

#[account]
pub struct BondPosition {
    pub owner: Pubkey,
    pub xbond: u64,
    /// Redemptions queued when the expansion allowance was exhausted
    /// (xBOND stays in the user's wallet until settled; no partial fill).
    pub queued_redeem: u64,
    pub bump: u8,
}

impl BondPosition {
    pub const SPACE: usize = 8 + 128;
}

/// Loyalty weeks that can hold a boost bucket. The farm window is
/// 365 days and the shortest week is 1 day, so weeks 0..=364 can
/// accrue; index 365 is the roll-forward landing week past the
/// window. (EVM keeps an unbounded mapping; the fixed table is the
/// chain-forced bound — see the boost notes in instructions.rs.)
pub const MAX_BOOST_WEEKS: usize = 366;

/// Global weekly-boost state (PDA ["boost-state"]), the mirror of
/// the EVM ShareRewardPool's boost bookkeeping. Weekly buckets are
/// anchored at `anchor_ts` (the farm start = Genesis end) and never
/// drift. Created by initialize_boost.
#[account]
pub struct BoostState {
    /// Farm start the loyalty weeks are anchored at.
    pub anchor_ts: i64,
    /// Last timestamp boost accrual was sliced at.
    pub last_settle_ts: i64,
    /// Cumulative xSHARE earmarked for the boost (all weeks).
    pub total_boost_accrued: u64,
    /// Weeks [0, closed_weeks) are closed (eligible totals frozen).
    pub closed_weeks: u64,
    /// Candidate eligible Masonry stake for the currently open week:
    /// opens at the total staked when the week opens; a first
    /// withdrawal during the week subtracts that staker's
    /// start-of-week amount.
    pub open_eligible_total: u64,
    /// Running total of LP staked in the Masonry pool (mirrored on
    /// every Masonry stake/unstake; equals the pool's total_staked).
    pub total_masonry_staked: u64,
    pub bump: u8,
    // The two week tables (week_boost / week_eligible_total, one
    // u64 per week) are NOT struct fields: they live in this
    // account's raw data tail at WEEK_BOOST_OFF / WEEK_ELIG_OFF
    // and are read/written by the offset helpers in
    // instructions.rs. Borsh (de)serialization of a [u64; 366]
    // field overflows the 4 KB BPF stack (measured: the account
    // loads fine at 40 entries and faults at 366), so the tables
    // never pass through the serializer. The serialized struct
    // above is ~65 bytes and ends well before WEEK_BOOST_OFF.
}

/// Byte offset of the week_boost table in the BoostState account
/// data (u64 LE per week, MAX_BOOST_WEEKS entries).
pub const WEEK_BOOST_OFF: usize = 128;
/// Byte offset of the week_eligible_total table.
pub const WEEK_ELIG_OFF: usize = WEEK_BOOST_OFF + 8 * MAX_BOOST_WEEKS;

impl BoostState {
    pub const SPACE: usize = 8 + 6144;
}

/// Per-user weekly-boost record (PDA ["boost-user", owner]), the
/// mirror of the EVM BoostInfo. Tracks the user's Masonry stake for
/// eligibility: eligibility keys off Masonry stake ONLY (Jess
/// 2026-11-09, "Just masonry boost") — farm stake funds the boost
/// through the emission carve-out but never earns it.
#[account]
pub struct BoostUser {
    pub owner: Pubkey,
    /// LP staked in the Masonry pool (mirrored on every stake
    /// change; synced from the position on the first touch).
    pub stake_total: u64,
    /// Stake in force at the start of `mark_week`.
    pub week_start_amount: u64,
    /// Week of the user's last stake-changing event.
    pub mark_week: u64,
    /// Whether a snapshot exists.
    pub marked: bool,
    /// A Masonry LP withdrawal landed during `mark_week`.
    pub week_dirty: bool,
    /// Weeks < settled_week are settled into `credit`.
    pub settled_week: u64,
    /// Settled, claimable boost (xSHARE). Never expires.
    pub credit: u64,
    /// Loyalty clock (§7): last Masonry LP withdrawal time (0 =
    /// never). The gauge reads this.
    pub last_lp_withdrawal_at: i64,
    pub bump: u8,
}

impl BoostUser {
    pub const SPACE: usize = 8 + 128;
}
