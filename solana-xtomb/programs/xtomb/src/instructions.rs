//! Instruction handlers + account structs for the xtomb program.
//!
//! Design notes (see BUILD-NOTES.md for the full list):
//! - Canonical pool ids: 1 standard, 2 LP, 3 Ultra-NFT, 4 Masonry, 10+ farm.
//! - Rewards accrue via a per-pool accumulator (MasterChef style). Genesis
//!   pools accrue xTOMB from the prefunded 30,000 budget; farm pools accrue
//!   xSHARE; the Masonry pool is funded only by advance_epoch.
//! - Compound has no on-chain AMM in this build: it settles in accounting
//!   units at the TWAP reference price. The swap leg is a documented
//!   upgrade path, not a silent fake.

use anchor_lang::prelude::*;
use anchor_spl::token::{
    self, Burn, Mint, MintTo, Token, TokenAccount, Transfer,
};
use mpl_core::types::{
    DataState, PermanentFreezeDelegate, Plugin, PluginAuthority,
    PluginAuthorityPair,
};

use crate::errors::XtombError;
use crate::events::*;
use crate::math::*;
use crate::state::*;

// ---------------------------------------------------------------- helpers

pub fn clock_now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

fn require_admin(config: &Config, signer: &Pubkey) -> Result<()> {
    require!(config.admin == *signer, XtombError::NotAdmin);
    Ok(())
}

fn require_not_maintenance(config: &Config) -> Result<()> {
    require!(!config.maintenance, XtombError::Maintenance);
    Ok(())
}

/// Freshness gate: withdrawals / sells fail closed on stale oracle data.
/// Buys (stake) do not call this.
fn require_fresh_oracle(config: &Config, now: i64) -> Result<()> {
    require!(
        oracle_is_fresh(config.oracle_ts, now),
        XtombError::OracleStale
    );
    Ok(())
}

/// Resolve the effective Fire Tax parameters from the Config account.
/// The fire-tax fields were appended to Config in the 2026-11-08
/// upgrade and live in the account's spare capacity; accounts written
/// by the pre-upgrade binary hold 0 there, and 0 means "compiled
/// default" (see state.rs). Once the admin calls set_fire_tax_config,
/// the stored values are real and used verbatim.
fn fire_tax_params(config: &Config) -> FireTaxParams {
    let d = FireTaxParams::DEFAULT;
    FireTaxParams {
        base_xtomb_bps: if config.fire_tax_base_xtomb_bps == 0 {
            d.base_xtomb_bps
        } else {
            config.fire_tax_base_xtomb_bps
        },
        base_xshare_bps: if config.fire_tax_base_xshare_bps == 0 {
            d.base_xshare_bps
        } else {
            config.fire_tax_base_xshare_bps
        },
        cap_bps: if config.fire_tax_cap_bps == 0 {
            d.cap_bps
        } else {
            config.fire_tax_cap_bps
        },
        rest_bps: if config.fire_tax_rest_bps == 0 {
            d.rest_bps
        } else {
            config.fire_tax_rest_bps
        },
        recovery_secs: if config.fire_tax_recovery_secs <= 0 {
            d.recovery_secs
        } else {
            config.fire_tax_recovery_secs
        },
        zeroed: config.fire_tax_zeroed,
    }
}

/// Compute the Fire Tax rate for a withdrawal and restart the recovery
/// floor when a higher ordinary rate is observed. While the admin
/// healthy override is set, the rate is 0 for both tokens (and the
/// floor is left untouched).
fn fire_tax_for(config: &mut Config, now: i64, is_xshare: bool) -> u16 {
    let params = fire_tax_params(config);
    if params.zeroed {
        return 0;
    }
    let genesis_active =
        now >= config.genesis_start_ts && now < config.genesis_end_ts;
    let twap_rate = fire_tax_twap_rate_bps(
        config.oracle_twap_e6,
        params.base_bps(is_xshare),
        params.cap_bps,
    );
    let floor_age = now - config.recovery_floor_ts;
    let decayed = recovery_floor_decayed_bps(
        config.recovery_floor_bps,
        floor_age,
        params.rest_bps,
        params.recovery_secs,
    );
    if twap_rate > decayed {
        config.recovery_floor_bps = twap_rate;
        config.recovery_floor_ts = now;
    }
    let mut rate = twap_rate.max(decayed);
    if genesis_active {
        let min = if is_xshare {
            FIRE_TAX_GENESIS_MIN_XSHARE_BPS
        } else {
            FIRE_TAX_GENESIS_MIN_XTOMB_BPS
        };
        rate = rate.max(min);
    }
    rate.min(params.cap_bps)
}

// ---------------------------------------------------------------- bonds
//
// LP-zap bond model (Jess, 2026-11-08): bonds are sold only under peg
// and are denominated in xTOMB LP. A buy takes custody of the pay-in
// in a per-mint bond pay-in vault and credits xBOND face at the TWAP
// price, with a premium when the pay-in is the chain's native token
// (wrapped SOL) or USDC. One exception (Jess, later the same day): an
// xTOMB pay-in is not custodied — it BURNS like a classic bond and
// earns its own smaller premium (default 3%). The market leg — spending the custodied
// pay-in to BUY xTOMB (never selling protocol tokens) and creating
// the LP — has no AMM to run against on devnet, so it is executed by
// the operator (bot wallet): withdraw_bond_payin takes the pay-in
// out, the operator performs the buy + LP creation off-chain, and
// deposit_bond_backing registers the resulting LP in the backing
// vault. Redemption (above peg) pays LP out of that backing,
// pro-rata by face; with insufficient backing the redemption queues
// on the buyer's BondPosition. The program never mints unbacked
// redemption claims.

/// The canonical wrapped-SOL mint (spl-token native mint), as raw
/// bytes to avoid a runtime base58 parse.
pub fn native_sol_mint() -> Pubkey {
    Pubkey::new_from_array([
        6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24,
        192, 53, 218, 196, 57, 220, 26, 235, 59, 85, 152, 160, 240, 0, 0,
        0, 0, 1,
    ])
}

/// Effective bond premium: a stored 0 means the compiled default
/// (same spare-capacity convention as the fire-tax fields).
fn bond_premium_bps_resolved(config: &Config) -> u16 {
    if config.bond_premium_bps == 0 {
        BOND_PREMIUM_DEFAULT_BPS
    } else {
        config.bond_premium_bps
    }
}

/// Effective xTOMB bond premium: a stored 0 means the compiled
/// default (300 bps = 3%).
fn bond_xtomb_premium_bps_resolved(config: &Config) -> u16 {
    if config.bond_xtomb_premium_bps == 0 {
        BOND_XTOMB_PREMIUM_DEFAULT_BPS
    } else {
        config.bond_xtomb_premium_bps
    }
}

/// Resolve the effective pass prices and tier deposit fees from the
/// Config account. The pass fields were appended to Config in the
/// 2026-11-08 configurability upgrade and live in the account's
/// spare capacity; accounts written by the pre-upgrade binary hold
/// 0 there, and 0 means "compiled default" (see state.rs). Once the
/// admin calls set_pass_config, the stored values are real and used
/// verbatim. The Ultra deposit fee's default is 0, so its stored
/// value is used as-is (0 is a real fee there, not a sentinel).
fn pass_params(config: &Config) -> PassParams {
    let d = PassParams::DEFAULT;
    PassParams {
        price_genesis_usdc: if config.pass_price_genesis_usdc == 0 {
            d.price_genesis_usdc
        } else {
            config.pass_price_genesis_usdc
        },
        price_pro_usdc: if config.pass_price_pro_usdc == 0 {
            d.price_pro_usdc
        } else {
            config.pass_price_pro_usdc
        },
        price_ultra_usdc: if config.pass_price_ultra_usdc == 0 {
            d.price_ultra_usdc
        } else {
            config.pass_price_ultra_usdc
        },
        deposit_fee_genesis_bps: if config.pass_deposit_fee_genesis_bps == 0 {
            d.deposit_fee_genesis_bps
        } else {
            config.pass_deposit_fee_genesis_bps
        },
        deposit_fee_pro_bps: if config.pass_deposit_fee_pro_bps == 0 {
            d.deposit_fee_pro_bps
        } else {
            config.pass_deposit_fee_pro_bps
        },
        deposit_fee_ultra_bps: config.pass_deposit_fee_ultra_bps,
    }
}

/// Effective weekly boost percent. Until the percent has been
/// explicitly written (initialize_config of this binary, or the
/// first set_boost_config), the Config resolves to the compiled
/// default of 5 — Jess 2026-11-09: the 5 is baked in. Once
/// configured, the stored value is used verbatim, so an admin can
/// still set a real 0 (boost off).
fn boost_percent(config: &Config) -> u16 {
    if config.boost_percent_configured {
        config.weekly_boost_percent
    } else {
        BOOST_DEFAULT_PERCENT
    }
}

/// Effective loyalty week length in seconds: a stored 0 resolves
/// to the compiled default of 7 days.
fn boost_week_secs(config: &Config) -> i64 {
    let days = if config.week_length_days == 0 {
        BOOST_WEEK_DEFAULT_DAYS
    } else {
        config.week_length_days
    };
    days as i64 * 24 * 3600
}

/// Read mint / owner / amount out of a raw SPL token account
/// (bytes 0..32 mint, 32..64 owner, 64..72 amount little-endian).
fn token_account_fields(info: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 72, XtombError::BadTokenAccount);
    let mut mint_bytes = [0u8; 32];
    mint_bytes.copy_from_slice(&data[0..32]);
    let mut owner_bytes = [0u8; 32];
    owner_bytes.copy_from_slice(&data[32..64]);
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    Ok((
        Pubkey::new_from_array(mint_bytes),
        Pubkey::new_from_array(owner_bytes),
        amount,
    ))
}

/// Create the PDA token vault at `seed_set` if it does not exist yet,
/// or validate an existing one (the manual InitializeAccount3 pattern
/// of create_vault_account, generalized to arbitrary seeds). The
/// vault's token authority is the config PDA.
fn ensure_pda_token_vault<'info>(
    vault: &AccountInfo<'info>,
    seed_set: &[&[u8]],
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    rent_lamports: u64,
) -> Result<()> {
    let (expected, bump) =
        Pubkey::find_program_address(seed_set, &crate::ID);
    require!(vault.key() == expected, XtombError::BadVaultPda);
    if vault.data_is_empty() {
        let mut seeds: Vec<&[u8]> = seed_set.to_vec();
        let bump_arr = [bump];
        seeds.push(&bump_arr);
        let signer_seeds = [seeds.as_slice()];
        let cpi = CpiContext::new_with_signer(
            system_program.clone(),
            anchor_lang::system_program::CreateAccount {
                from: payer.clone(),
                to: vault.clone(),
            },
            &signer_seeds,
        );
        anchor_lang::system_program::create_account(
            cpi,
            rent_lamports,
            TokenAccount::LEN as u64,
            &anchor_spl::token::ID,
        )?;
        let cpi = CpiContext::new(
            token_program.clone(),
            anchor_spl::token::InitializeAccount3 {
                account: vault.clone(),
                mint: mint.clone(),
                authority: authority.clone(),
            },
        );
        anchor_spl::token::initialize_account3(cpi)?;
    } else {
        let (vmint, vowner, _) = token_account_fields(vault)?;
        require!(
            vmint == mint.key() && vowner == authority.key(),
            XtombError::BadTokenAccount
        );
    }
    Ok(())
}

/// Validate an already-created PDA token vault and return its
/// balance. Fails closed if the vault was never created.
fn require_pda_token_vault(
    vault: &AccountInfo,
    seed_set: &[&[u8]],
    mint: &Pubkey,
    authority: &Pubkey,
) -> Result<u64> {
    let (expected, _) = Pubkey::find_program_address(seed_set, &crate::ID);
    require!(vault.key() == expected, XtombError::BadVaultPda);
    require!(!vault.data_is_empty(), XtombError::BadTokenAccount);
    let (vmint, vowner, amount) = token_account_fields(vault)?;
    require!(
        vmint == *mint && vowner == *authority,
        XtombError::BadTokenAccount
    );
    Ok(amount)
}

/// Pending rewards for a position against its pool accumulator.
///
/// MasterChef form: `reward_debt` is stored TOKEN-denominated
/// (`amount * acc_per_share / ACC_SCALE` at the last settle), so
/// pending is the position's current token entitlement minus that
/// debt. (A previous version subtracted the token-denominated debt
/// from the per-share accumulator directly, overstating every
/// repeat settle — fixed 2026-11-08.)
fn pending_rewards(position: &Position, pool: &Pool) -> u64 {
    let entitled =
        position.amount as u128 * pool.acc_per_share / ACC_SCALE;
    entitled.saturating_sub(position.reward_debt) as u64
}

/// Settle pending rewards into the position's accrued balances.
/// Genesis pools split 50/50 liquid/vested (odd unit to vesting);
/// farm and Masonry pay 100% liquid.
fn settle_pending(
    position: &mut Position,
    pool: &Pool,
    config: &Config,
) -> Result<()> {
    let pending = pending_rewards(position, pool);
    if pending == 0 {
        position.reward_debt =
            position.amount as u128 * pool.acc_per_share / ACC_SCALE;
        return Ok(());
    }
    match pool.kind {
        POOL_KIND_STANDARD | POOL_KIND_LP | POOL_KIND_ULTRA => {
            let liquid = pending / 2;
            let vested = pending - liquid;
            position.accrued_liquid = position
                .accrued_liquid
                .checked_add(liquid)
                .ok_or(XtombError::Overflow)?;
            position.accrued_vested = position
                .accrued_vested
                .checked_add(vested)
                .ok_or(XtombError::Overflow)?;
            position.vesting_total = position
                .vesting_total
                .checked_add(vested)
                .ok_or(XtombError::Overflow)?;
            if position.vesting_next_ts == 0 {
                position.vesting_next_ts =
                    config.genesis_end_ts + 6 * 3600;
            }
        }
        _ => {
            position.accrued_liquid = position
                .accrued_liquid
                .checked_add(pending)
                .ok_or(XtombError::Overflow)?;
        }
    }
    position.reward_debt =
        position.amount as u128 * pool.acc_per_share / ACC_SCALE;
    Ok(())
}

/// Advance a pool's accumulator to `now`.
///
/// Genesis pools accrue from the prefunded budget (clamped so total
/// distributed never exceeds the budget). Farm pools accrue xSHARE at
/// their weight of the farm rate. The Masonry pool accrues only via
/// advance_epoch (its accumulator is credited there directly).
fn update_pool(pool: &mut Account<Pool>, config: &mut Config, now: i64) -> Result<()> {
    if !pool.active {
        return Ok(());
    }
    let last = pool.last_update_ts;
    if now <= last {
        return Ok(());
    }
    if pool.total_staked == 0 {
        pool.last_update_ts = now;
        return Ok(());
    }
    let mut minted: u64 = 0;
    match pool.kind {
        POOL_KIND_STANDARD | POOL_KIND_LP | POOL_KIND_ULTRA => {
            // Accrue in segments split at the Day-2 boundary and Genesis end,
            // because the pool share changes at T+24h and stops at T+7d.
            let bounds = [
                config.genesis_start_ts,
                config.genesis_start_ts + 24 * 3600,
                config.genesis_end_ts,
            ];
            let mut cursor = last.max(config.genesis_start_ts);
            let end = now.min(config.genesis_end_ts);
            while cursor < end {
                let next_bound = bounds
                    .iter()
                    .copied()
                    .find(|b| *b > cursor)
                    .unwrap_or(end);
                let seg_end = next_bound.min(end);
                let secs = seg_end - cursor;
                if secs > 0 {
                    let share =
                        genesis_pool_share_bps(pool.kind, cursor, config.genesis_start_ts);
                    let seg = config.genesis_emission_per_sec as u128
                        * share as u128
                        * secs as u128
                        / 10_000u128;
                    minted = minted
                        .checked_add(seg as u64)
                        .ok_or(XtombError::Overflow)?;
                }
                cursor = seg_end;
            }
            // Clamp to the remaining Genesis budget.
            let remaining = config
                .genesis_reward_budget
                .saturating_sub(config.genesis_rewards_distributed);
            if minted > remaining {
                minted = remaining;
            }
            config.genesis_rewards_distributed = config
                .genesis_rewards_distributed
                .checked_add(minted)
                .ok_or(XtombError::Overflow)?;
        }
        POOL_KIND_FARM => {
            let farm_start = config.genesis_end_ts;
            let farm_end = farm_start + FARM_SECS;
            let start = last.max(farm_start);
            let end = now.min(farm_end);
            if end > start {
                let secs = (end - start) as u128;
                // EVM-parity accrual (weekly boost build): the farm
                // pools' weights are relative alloc shares and the
                // boost takes a virtual weight against their total,
                // so a pool accrues rate * weight / (totalWeight +
                // boostWeight) — at 75/20 weights and the 5% boost
                // the emission divides exactly 75/20/5. With the
                // boost off and the historical single 10000-weight
                // pool this reduces to the full rate. Configs whose
                // farm weight total was never tracked (0) keep the
                // legacy absolute-bps formula.
                let total = config.farm_weight_total_bps as u128;
                if total > 0 {
                    let bw = boost_weight(
                        config.farm_weight_total_bps as u64,
                        boost_percent(config),
                    ) as u128;
                    minted = (config.farm_emission_per_sec as u128
                        * pool.weight_bps as u128
                        * secs
                        / (total + bw)) as u64;
                } else {
                    minted = (config.farm_emission_per_sec as u128
                        * pool.weight_bps as u128
                        * secs
                        / 10_000u128) as u64;
                }
            }
        }
        _ => {}
    }
    if minted > 0 {
        pool.acc_per_share = pool.acc_per_share.checked_add(
            minted as u128 * ACC_SCALE / pool.total_staked as u128,
        ).ok_or(XtombError::Overflow)?;
    }
    pool.last_update_ts = now;
    Ok(())
}

// ------------------------------------------------------- weekly boost
//
// Mirror of the EVM ShareRewardPool weekly loyalty boost
// (specs.md §8/§18), with Jess's 2026-11-09 rulings applied:
//   - The 5% is carved from FARM emissions (the 75/20/5 split is
//     realized by the renormalized farm accrual in update_pool plus
//     the bucket slicing here — both read the same percent).
//   - Eligibility keys off MASONRY stake only ("Just masonry
//     boost"): farm pools fund the boost, Masonry stake earns it.
//   - The percent defaults to 5 (baked in), admin-settable 0-25,
//     settling under the old percent first; week length defaults
//     to 7 days, settable 1-30 only before the farm start.
// Chain-forced differences from the EVM original, named:
//   - Loyalty weeks anchor at the farm start, which on this program
//     is genesis_end_ts (the farm accrual window's own start).
//   - Claims pay out of the pre-funded farm_vault xSHARE pot (the
//     full 25,641 xSHARE budget was minted there at create_mints),
//     so the carve-out is accounting, exactly like the EVM's
//     pre-funded operator pot.
//   - Week buckets live in fixed u64 tables in the BoostState
//     account's raw data tail instead of an unbounded mapping:
//     366 entries cover the 365-day farm window at the minimum
//     1-day week plus one roll-forward week. A remainder stranded
//     in the final week with no eligible staker stays in that
//     week's bucket (the EVM mapping would keep rolling it into
//     later weeks). Raw-tail storage is itself chain-forced:
//     borsh (de)serialization of a [u64; 366] account field
//     overflows the 4 KB BPF stack.
//   - The staking path takes the boost accounts as remaining
//     accounts (validated by PDA derivation in boost_hook_begin):
//     the pre-existing Stake/Unstake account lists — and every
//     client built on them — stay untouched. Once the boost is
//     initialized, Masonry stake/unstake REQUIRE the accounts
//     (BoostAccountsMissing otherwise), so eligibility cannot be
//     dodged by omitting them.
//   - A user's record starts earning at its first touch: weeks
//     that closed before the record existed are never credited
//     retroactively (the EVM tracks from deployment; here the
//     boost ships as an upgrade to a live program).

/// Week-table accessors over the BoostState account's raw data
/// tail (see state.rs for why the tables are not struct fields).
fn week_boost_get(data: &[u8], w: usize) -> u64 {
    let off = WEEK_BOOST_OFF + 8 * w;
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

fn week_boost_set(data: &mut [u8], w: usize, v: u64) {
    let off = WEEK_BOOST_OFF + 8 * w;
    data[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

fn week_elig_get(data: &[u8], w: usize) -> u64 {
    let off = WEEK_ELIG_OFF + 8 * w;
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

fn week_elig_set(data: &mut [u8], w: usize, v: u64) {
    let off = WEEK_ELIG_OFF + 8 * w;
    data[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

/// Slice the farm emission stream into weekly buckets and close
/// any weeks that have ended — the EVM _settleBoost. `data` is
/// the BoostState account's raw data (the week tables).
fn settle_boost_state(
    config: &Config,
    st: &mut BoostState,
    data: &mut [u8],
    now: i64,
) -> Result<()> {
    if st.anchor_ts == 0 {
        return Ok(()); // not initialized (defensive; callers gate)
    }
    let week_secs = boost_week_secs(config);
    if now > st.last_settle_ts {
        let percent = boost_percent(config);
        let total = config.farm_weight_total_bps as u64;
        if percent > 0 && total > 0 {
            let mut from = st.last_settle_ts;
            while from < now {
                let w = boost_week_index(st.anchor_ts, week_secs, from);
                let seg_end =
                    now.min(st.anchor_ts + (w as i64 + 1) * week_secs);
                let gen = farm_generated(
                    config.farm_emission_per_sec,
                    st.anchor_ts,
                    from,
                    seg_end,
                );
                if gen > 0 && (w as usize) < MAX_BOOST_WEEKS {
                    let slice = boost_slice(gen, total, percent);
                    let wi = w as usize;
                    week_boost_set(
                        data,
                        wi,
                        week_boost_get(data, wi)
                            .checked_add(slice)
                            .ok_or(XtombError::Overflow)?,
                    );
                    st.total_boost_accrued = st
                        .total_boost_accrued
                        .checked_add(slice)
                        .ok_or(XtombError::Overflow)?;
                }
                from = seg_end;
            }
        }
        st.last_settle_ts = now;
    }
    let w_now = boost_week_index(st.anchor_ts, week_secs, now);
    while st.closed_weeks < w_now
        && st.closed_weeks < MAX_BOOST_WEEKS as u64
    {
        let w = st.closed_weeks as usize;
        week_elig_set(data, w, st.open_eligible_total);
        emit!(BoostWeekClosed {
            week: w as u64,
            eligible_total: st.open_eligible_total,
            boost_amount: week_boost_get(data, w),
        });
        if st.open_eligible_total == 0
            && week_boost_get(data, w) > 0
            && w + 1 < MAX_BOOST_WEEKS
        {
            // Nobody earned this week: roll the whole bucket into
            // the next week. Nothing is lost or locked.
            let rolled = week_boost_get(data, w);
            week_boost_set(
                data,
                w + 1,
                week_boost_get(data, w + 1)
                    .checked_add(rolled)
                    .ok_or(XtombError::Overflow)?,
            );
            week_boost_set(data, w, 0);
        }
        st.closed_weeks += 1;
        st.open_eligible_total = st.total_masonry_staked;
    }
    Ok(())
}

/// A user's eligible amount for a closed week — the EVM
/// _eligibleAmountFor: a marked week pays its start-of-week
/// snapshot (0 if a withdrawal dirtied it); an unmarked week means
/// the stake stood untouched, so the current stake counts.
fn boost_eligible_amount(u: &BoostUser, week: u64) -> u64 {
    if u.marked {
        if u.mark_week == week {
            return if u.week_dirty { 0 } else { u.week_start_amount };
        }
        if u.mark_week > week {
            return 0;
        }
    }
    u.stake_total
}

/// Fold a user's closed-week entitlements into their credit —
/// the EVM _settleUserBoost. Credit never expires.
fn settle_user_boost_rec(
    st: &BoostState,
    data: &[u8],
    u: &mut BoostUser,
) -> Result<()> {
    while u.settled_week < st.closed_weeks {
        let w = u.settled_week as usize;
        let amt = boost_eligible_amount(u, u.settled_week);
        let elig = week_elig_get(data, w);
        if amt > 0 && elig > 0 {
            let gain = (week_boost_get(data, w) as u128 * amt as u128
                / elig as u128) as u64;
            u.credit = u
                .credit
                .checked_add(gain)
                .ok_or(XtombError::Overflow)?;
        }
        u.settled_week += 1;
    }
    Ok(())
}

/// Read-only pending boost: settled credit plus entitlements from
/// weeks already closed but not yet settled into the credit. The
/// EVM pendingBoost view; on Solana clients can equally compute it
/// from the two public accounts.
fn pending_boost_calc(st: &BoostState, data: &[u8], u: &BoostUser) -> u64 {
    let mut total = u.credit as u128;
    let mut w = u.settled_week;
    while w < st.closed_weeks {
        let amt = boost_eligible_amount(u, w);
        let wi = w as usize;
        let elig = week_elig_get(data, wi);
        if amt > 0 && elig > 0 {
            total += week_boost_get(data, wi) as u128 * amt as u128
                / elig as u128;
        }
        w += 1;
    }
    total as u64
}

/// Settle-before-change bookkeeping for a Masonry stake change —
/// the EVM _boostTouch. First event of a week snapshots the
/// pre-change stake; a withdrawal marks the week dirty and removes
/// that snapshot from the week's candidate eligible total.
fn boost_touch_rec(
    config: &Config,
    st: &mut BoostState,
    u: &mut BoostUser,
    is_withdrawal: bool,
    amount: u64,
    now: i64,
) {
    let week_secs = boost_week_secs(config);
    let w = boost_week_index(st.anchor_ts, week_secs, now);
    if !u.marked || u.mark_week != w {
        u.week_start_amount = u.stake_total;
        u.mark_week = w;
        u.marked = true;
        u.week_dirty = false;
    }
    if is_withdrawal && amount > 0 {
        u.last_lp_withdrawal_at = now;
        if now >= st.anchor_ts + (w as i64) * week_secs && !u.week_dirty {
            u.week_dirty = true;
            st.open_eligible_total =
                st.open_eligible_total.saturating_sub(u.week_start_amount);
        }
    }
}

/// The staking-path boost hook, as two free functions (Anchor's
/// AccountInfo lifetime invariance rules out storing the infos
/// across the caller's amount change). boost_hook_begin loads the
/// two boost accounts from remaining_accounts (PDA-validated) and
/// settles global + user state; the caller then runs
/// boost_touch_rec and, after its amount change,
/// boost_hook_finish to resync mirrors and write the accounts
/// back. Used by stake/unstake for the Masonry pool only, and
/// only once the boost is initialized.
///
/// remaining[0] = boost-state PDA, remaining[1] = boost-user PDA.
/// On a first touch the record is created (payer-funded), which
/// also needs remaining[2] = system program and remaining[3] =
/// the payer (the staking user, key-validated). All four ride as
/// remaining accounts because Anchor's typed-account infos live
/// at a different lifetime than remaining_accounts and cannot be
/// mixed into the same CPI.
fn boost_hook_begin(
    remaining: &[AccountInfo],
    config: &Config,
    user_key: &Pubkey,
    position_amount_pre: u64,
    now: i64,
) -> Result<(BoostState, BoostUser)> {
    require!(remaining.len() >= 2, XtombError::BoostAccountsMissing);
    let state_info = &remaining[0];
    let user_info = &remaining[1];
    let (state_pda, _) =
        Pubkey::find_program_address(&[b"boost-state"], &crate::ID);
    require!(state_info.key() == state_pda, XtombError::BadVaultPda);
    require!(
        state_info.owner == &crate::ID && !state_info.data_is_empty(),
        XtombError::BoostNotInitialized
    );
    let mut state = {
        let data = state_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        BoostState::try_deserialize(&mut slice)
            .map_err(|_| XtombError::BoostNotInitialized)?
    };
    // The week tables live in the account's raw data tail; one
    // mutable borrow serves the global settle and the user settle.
    let mut state_data = state_info.try_borrow_mut_data()?;
    settle_boost_state(config, &mut state, &mut state_data, now)?;

    let (user_pda, user_bump) = Pubkey::find_program_address(
        &[b"boost-user", user_key.as_ref()],
        &crate::ID,
    );
    require!(user_info.key() == user_pda, XtombError::BadVaultPda);
    let mut user = if user_info.data_is_empty() {
        require!(
            remaining.len() >= 4,
            XtombError::BoostAccountsMissing
        );
        let system_program = &remaining[2];
        require!(
            system_program.key() == anchor_lang::system_program::ID,
            XtombError::BoostAccountsMissing
        );
        let payer = &remaining[3];
        require!(payer.key() == *user_key, XtombError::BadTokenAccount);
        let rent_lamports = Rent::get()?.minimum_balance(BoostUser::SPACE);
        let bump_arr = [user_bump];
        let seed_set: [&[u8]; 3] =
            [b"boost-user", user_key.as_ref(), &bump_arr];
        let signer_seeds = [seed_set.as_slice()];
        let cpi = CpiContext::new_with_signer(
            system_program.clone(),
            anchor_lang::system_program::CreateAccount {
                from: payer.clone(),
                to: user_info.clone(),
            },
            &signer_seeds,
        );
        anchor_lang::system_program::create_account(
            cpi,
            rent_lamports,
            BoostUser::SPACE as u64,
            &crate::ID,
        )?;
        BoostUser {
            owner: *user_key,
            stake_total: 0,
            week_start_amount: 0,
            mark_week: 0,
            marked: false,
            week_dirty: false,
            // Weeks already closed are never credited
            // retroactively (see the section header).
            settled_week: state.closed_weeks,
            credit: 0,
            last_lp_withdrawal_at: 0,
            bump: user_bump,
        }
    } else {
        let data = user_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        BoostUser::try_deserialize(&mut slice)?
    };
    if !user.marked {
        // First touch: never earn weeks that closed before the
        // record saw a stake change, and sync the stake mirror
        // from the live position (exact backfill — the Masonry
        // venue is a single pool, so the position IS the stake).
        if user.settled_week < state.closed_weeks {
            user.settled_week = state.closed_weeks;
        }
        user.stake_total = position_amount_pre;
    }
    settle_user_boost_rec(&state, &state_data, &mut user)?;
    Ok((state, user))
}

/// After the caller's amount change: resync the stake mirrors
/// from the live pool/position, apply the EVM pre-farm-start
/// adjustments (stake moved before the anchor is week 0's
/// candidate stake), and write both boost accounts back.
fn boost_hook_finish(
    remaining: &[AccountInfo],
    state: &mut BoostState,
    user: &mut BoostUser,
    position_amount_post: u64,
    pool_total_post: u64,
    now: i64,
) -> Result<()> {
    require!(remaining.len() >= 2, XtombError::BoostAccountsMissing);
    let old_total = state.total_masonry_staked as i128;
    let delta = pool_total_post as i128 - old_total;
    user.stake_total = position_amount_post;
    state.total_masonry_staked = pool_total_post;
    if now < state.anchor_ts {
        user.week_start_amount = user.stake_total;
        if delta >= 0 {
            state.open_eligible_total = state
                .open_eligible_total
                .checked_add(delta as u64)
                .ok_or(XtombError::Overflow)?;
        } else {
            state.open_eligible_total = state
                .open_eligible_total
                .saturating_sub((-delta) as u64);
        }
    }
    {
        let mut data = remaining[0].try_borrow_mut_data()?;
        let mut slice: &mut [u8] = &mut data;
        state.try_serialize(&mut slice)?;
    }
    {
        let mut data = remaining[1].try_borrow_mut_data()?;
        let mut slice: &mut [u8] = &mut data;
        user.try_serialize(&mut slice)?;
    }
    Ok(())
}

/// Load a pass record for `owner` from an unchecked account. Returns
/// Err(NoPass) when the PDA is missing or uninitialized.
fn load_pass(pass_info: &AccountInfo, owner: &Pubkey) -> Result<Pass> {
    let (pda, _) =
        Pubkey::find_program_address(&[b"pass", owner.as_ref()], &crate::ID);
    require!(pass_info.key() == pda, XtombError::NoPass);
    let data = pass_info.try_borrow_data()?;
    if data.len() < 8 {
        return Err(XtombError::NoPass.into());
    }
    let mut slice: &[u8] = &data;
    Pass::try_deserialize(&mut slice).map_err(|_| XtombError::NoPass.into())
}

fn save_pass(pass_info: &AccountInfo, pass: &Pass) -> Result<()> {
    let mut data = pass_info.try_borrow_mut_data()?;
    let mut slice: &mut [u8] = &mut data;
    pass.try_serialize(&mut slice)?;
    Ok(())
}

fn token_burn<'info>(
    mint: AccountInfo<'info>,
    from: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let cpi = CpiContext::new(
        token_program,
        Burn {
            mint,
            from,
            authority,
        },
    );
    token::burn(cpi, amount)
}

fn token_transfer<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let cpi = CpiContext::new(
        token_program,
        Transfer {
            from,
            to,
            authority,
        },
    );
    token::transfer(cpi, amount)
}

fn token_transfer_signed<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let signer = &[seeds];
    let cpi = CpiContext::new_with_signer(
        token_program,
        Transfer {
            from,
            to,
            authority,
        },
        signer,
    );
    token::transfer(cpi, amount)
}

fn token_burn_signed<'info>(
    mint: AccountInfo<'info>,
    from: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let signer = &[seeds];
    let cpi = CpiContext::new_with_signer(
        token_program,
        Burn {
            mint,
            from,
            authority,
        },
        signer,
    );
    token::burn(cpi, amount)
}

fn token_mint_signed<'info>(
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let signer = &[seeds];
    let cpi = CpiContext::new_with_signer(
        token_program,
        MintTo {
            mint,
            to,
            authority,
        },
        signer,
    );
    token::mint_to(cpi, amount)
}

// ------------------------------------------------------- initialize_config

#[derive(Accounts)]
#[instruction(
    treasury_wallet: Pubkey,
    team_wallet: Pubkey,
    dev_wallet: Pubkey,
    bot_wallet: Pubkey,
    oracle_authority: Pubkey,
    usdc_mint: Pubkey,
    genesis_start_ts: i64,
    genesis_reward_budget: u64,
    bond_max_outstanding: u64,
)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    treasury_wallet: Pubkey,
    team_wallet: Pubkey,
    dev_wallet: Pubkey,
    bot_wallet: Pubkey,
    oracle_authority: Pubkey,
    usdc_mint: Pubkey,
    genesis_start_ts: i64,
    genesis_reward_budget: u64,
    bond_max_outstanding: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let mut name = [0u8; 32];
    let display = b"Fire Tax";
    name[..display.len()].copy_from_slice(display);
    config.admin = ctx.accounts.admin.key();
    config.treasury_wallet = treasury_wallet;
    config.team_wallet = team_wallet;
    config.dev_wallet = dev_wallet;
    config.bot_wallet = bot_wallet;
    config.oracle_authority = oracle_authority;
    config.xtomb_mint = Pubkey::default();
    config.xshare_mint = Pubkey::default();
    config.xbond_mint = Pubkey::default();
    config.usdc_mint = usdc_mint;
    config.genesis_start_ts = genesis_start_ts;
    config.genesis_end_ts = genesis_start_ts + GENESIS_SECS;
    config.genesis_reward_budget = genesis_reward_budget;
    config.genesis_rewards_distributed = 0;
    config.genesis_emission_per_sec =
        genesis_reward_budget / GENESIS_SECS as u64;
    // 25,641 xSHARE over 365 days.
    config.farm_emission_per_sec = 25_641_000_000u64 / (365 * 24 * 3600);
    config.oracle_twap_e6 = REFERENCE_E6;
    config.oracle_ts = 0; // stale until the oracle posts (fail-closed)
    config.current_epoch = 0;
    config.epoch0_open = false;
    config.last_epoch_ts = 0;
    config.critical_defense = false;
    config.defense_above_checkpoints = 0;
    config.circulating_xtomb = 0;
    config.expansion_allowance = 0;
    config.bond_outstanding = 0;
    config.bond_max_outstanding = bond_max_outstanding;
    config.recovery_floor_bps = FIRE_TAX_REST_BPS;
    config.recovery_floor_ts = 0;
    // Fire Tax parameters (Jess 2026-11-08): explicit compiled defaults;
    // admin-retunable via set_fire_tax_config / set_fire_tax_zeroed.
    config.fire_tax_base_xtomb_bps = FIRE_TAX_BASE_XTOMB_BPS;
    config.fire_tax_base_xshare_bps = FIRE_TAX_BASE_XSHARE_BPS;
    config.fire_tax_cap_bps = FIRE_TAX_MAX_BPS;
    config.fire_tax_rest_bps = FIRE_TAX_REST_BPS;
    config.fire_tax_recovery_secs = RECOVERY_DECAY_SECS;
    config.fire_tax_zeroed = false;
    config.maintenance = false;
    // Operational fee split (config §9): Treasury 50 / Team 20 / Dev 15 / Bot 15.
    config.treasury_bps = 5000;
    config.team_bps = 2000;
    config.dev_bps = 1500;
    config.bot_bps = 1500;
    config.claim_fee_bps = 200;
    config.keeper_fee_bps = 200;
    config.lp_fee_bps = 50;
    // Weekly loyalty boost (Jess 2026-11-09): the 5 is baked in;
    // week length 7 days. Admin-retunable via set_boost_config
    // after initialize_boost creates the boost state.
    config.weekly_boost_percent = BOOST_DEFAULT_PERCENT;
    config.boost_percent_configured = true;
    config.week_length_days = BOOST_WEEK_DEFAULT_DAYS;
    config.farm_weight_total_bps = 0;
    config.boost_initialized = false;
    config.fee_display_name = name;
    config.xshare_tax_pending_burn = 0;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        admin: config.admin,
        genesis_start_ts: config.genesis_start_ts,
        genesis_end_ts: config.genesis_end_ts,
        genesis_reward_budget: config.genesis_reward_budget,
    });
    Ok(())
}

// ------------------------------------------------------------ create_mints

#[derive(Accounts)]
pub struct CreateMints<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: new xTOMB mint keypair (signer). Created by this instruction;
    /// Anchor `init` is deliberately NOT used here: nine `init` accounts
    /// blow the 4KB BPF stack in `try_accounts` (Access violation in
    /// stack frame 3). Creation is done explicitly in the handler.
    #[account(mut)]
    pub xtomb_mint: Signer<'info>,
    /// CHECK: new xSHARE mint keypair (signer). See xtomb_mint.
    #[account(mut)]
    pub xshare_mint: Signer<'info>,
    /// CHECK: new xBOND mint keypair (signer). See xtomb_mint.
    #[account(mut)]
    pub xbond_mint: Signer<'info>,
    /// CHECK: rewards vault PDA `["vault", "rewards"]`; verified and
    /// created by this instruction.
    #[account(mut)]
    pub rewards_vault: UncheckedAccount<'info>,
    /// CHECK: farm vault PDA `["vault", "farm"]`; verified and created here.
    #[account(mut)]
    pub farm_vault: UncheckedAccount<'info>,
    /// CHECK: treasury xTOMB vault PDA; verified and created here.
    #[account(mut)]
    pub treasury_vault_xtomb: UncheckedAccount<'info>,
    /// CHECK: treasury xSHARE vault PDA; verified and created here.
    #[account(mut)]
    pub treasury_vault_xshare: UncheckedAccount<'info>,
    /// CHECK: vesting vault PDA; verified and created here.
    #[account(mut)]
    pub vesting_vault: UncheckedAccount<'info>,
    /// CHECK: masonry vault PDA; verified and created here.
    #[account(mut)]
    pub masonry_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Create a fresh SPL mint account (keypair signer) and initialize it with
/// 6 decimals, mint authority = `mint_authority`, no freeze authority.
fn create_mint_account<'info>(
    mint: &AccountInfo<'info>,
    admin: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    mint_authority: &Pubkey,
    rent_lamports: u64,
) -> Result<()> {
    require!(mint.data_is_empty(), XtombError::MintsAlreadyCreated);
    let cpi = CpiContext::new(
        system_program.clone(),
        anchor_lang::system_program::CreateAccount {
            from: admin.clone(),
            to: mint.clone(),
        },
    );
    anchor_lang::system_program::create_account(
        cpi,
        rent_lamports,
        Mint::LEN as u64,
        &anchor_spl::token::ID,
    )?;
    let cpi = CpiContext::new(
        token_program.clone(),
        anchor_spl::token::InitializeMint {
            mint: mint.clone(),
            rent: rent.clone(),
        },
    );
    anchor_spl::token::initialize_mint(cpi, 6, mint_authority, None)?;
    Ok(())
}

/// Create a PDA token vault (`["vault", name]`, owner = `authority`) and
/// initialize it as a token account for `mint` via InitializeAccount3
/// (no signer needed for the account itself, which is what makes PDA
/// vaults possible).
fn create_vault_account<'info>(
    vault: &AccountInfo<'info>,
    name: &[u8],
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    admin: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    rent_lamports: u64,
) -> Result<()> {
    let (expected, bump) =
        Pubkey::find_program_address(&[b"vault", name], &crate::ID);
    require!(vault.key() == expected, XtombError::BadVaultPda);
    require!(vault.data_is_empty(), XtombError::MintsAlreadyCreated);
    let seeds: &[&[u8]] = &[b"vault", name, &[bump]];
    let signer_seeds = [seeds];
    let cpi = CpiContext::new_with_signer(
        system_program.clone(),
        anchor_lang::system_program::CreateAccount {
            from: admin.clone(),
            to: vault.clone(),
        },
        &signer_seeds,
    );
    anchor_lang::system_program::create_account(
        cpi,
        rent_lamports,
        TokenAccount::LEN as u64,
        &anchor_spl::token::ID,
    )?;
    let cpi = CpiContext::new(
        token_program.clone(),
        anchor_spl::token::InitializeAccount3 {
            account: vault.clone(),
            mint: mint.clone(),
            authority: authority.clone(),
        },
    );
    anchor_spl::token::initialize_account3(cpi)?;
    Ok(())
}

/// Create the three mints (mint authority = config PDA) and fund the
/// launch vaults per the spec §3 allocations:
/// - xTOMB: 30,000 Genesis budget -> rewards vault; 11,000 launch
///   (5,000 team/dev + 5,000 treasury + 1,000 arb) -> treasury vault.
///   The 11,000 split among the four wallets is the operator's job
///   post-deploy; the vault holds it as one bucket.
/// - xSHARE: 25,641 farm emissions -> farm vault; 751 (550 treasury +
///   100 team/dev + 100 sale escrow + 1 deployer) -> treasury vault;
///   6,941 operational vesting -> vesting vault.
/// xBOND starts at zero supply; it is minted only by buy_bond.
pub fn create_mints(ctx: Context<CreateMints>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.xtomb_mint == Pubkey::default()
            && config.xshare_mint == Pubkey::default()
            && config.xbond_mint == Pubkey::default(),
        XtombError::MintsAlreadyCreated
    );
    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    let config_key = config.key();
    let admin_info = ctx.accounts.admin.to_account_info();
    let system_info = ctx.accounts.system_program.to_account_info();
    let token_info = ctx.accounts.token_program.to_account_info();
    let rent_info = ctx.accounts.rent.to_account_info();
    let mint_rent = ctx.accounts.rent.minimum_balance(Mint::LEN);
    let vault_rent = ctx.accounts.rent.minimum_balance(TokenAccount::LEN);

    let xtomb_info = ctx.accounts.xtomb_mint.to_account_info();
    let xshare_info = ctx.accounts.xshare_mint.to_account_info();
    let xbond_info = ctx.accounts.xbond_mint.to_account_info();
    create_mint_account(
        &xtomb_info,
        &admin_info,
        &system_info,
        &token_info,
        &rent_info,
        &config_key,
        mint_rent,
    )?;
    create_mint_account(
        &xshare_info,
        &admin_info,
        &system_info,
        &token_info,
        &rent_info,
        &config_key,
        mint_rent,
    )?;
    create_mint_account(
        &xbond_info,
        &admin_info,
        &system_info,
        &token_info,
        &rent_info,
        &config_key,
        mint_rent,
    )?;

    let config_info = config.to_account_info();
    create_vault_account(
        &ctx.accounts.rewards_vault.to_account_info(),
        b"rewards",
        &xtomb_info,
        &config_info,
        &admin_info,
        &system_info,
        &token_info,
        vault_rent,
    )?;
    create_vault_account(
        &ctx.accounts.farm_vault.to_account_info(),
        b"farm",
        &xshare_info,
        &config_info,
        &admin_info,
        &system_info,
        &token_info,
        vault_rent,
    )?;
    create_vault_account(
        &ctx.accounts.treasury_vault_xtomb.to_account_info(),
        b"treasury-xtomb",
        &xtomb_info,
        &config_info,
        &admin_info,
        &system_info,
        &token_info,
        vault_rent,
    )?;
    create_vault_account(
        &ctx.accounts.treasury_vault_xshare.to_account_info(),
        b"treasury-xshare",
        &xshare_info,
        &config_info,
        &admin_info,
        &system_info,
        &token_info,
        vault_rent,
    )?;
    create_vault_account(
        &ctx.accounts.vesting_vault.to_account_info(),
        b"vesting",
        &xshare_info,
        &config_info,
        &admin_info,
        &system_info,
        &token_info,
        vault_rent,
    )?;
    create_vault_account(
        &ctx.accounts.masonry_vault.to_account_info(),
        b"masonry",
        &xtomb_info,
        &config_info,
        &admin_info,
        &system_info,
        &token_info,
        vault_rent,
    )?;

    token_mint_signed(
        ctx.accounts.xtomb_mint.to_account_info(),
        ctx.accounts.rewards_vault.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        30_000_000_000,
        seeds,
    )?;
    token_mint_signed(
        ctx.accounts.xtomb_mint.to_account_info(),
        ctx.accounts.treasury_vault_xtomb.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        11_000_000_000,
        seeds,
    )?;
    token_mint_signed(
        ctx.accounts.xshare_mint.to_account_info(),
        ctx.accounts.farm_vault.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        25_641_000_000,
        seeds,
    )?;
    token_mint_signed(
        ctx.accounts.xshare_mint.to_account_info(),
        ctx.accounts.treasury_vault_xshare.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        751_000_000,
        seeds,
    )?;
    token_mint_signed(
        ctx.accounts.xshare_mint.to_account_info(),
        ctx.accounts.vesting_vault.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        6_941_000_000,
        seeds,
    )?;

    config.xtomb_mint = ctx.accounts.xtomb_mint.key();
    config.xshare_mint = ctx.accounts.xshare_mint.key();
    config.xbond_mint = ctx.accounts.xbond_mint.key();
    // Minted xTOMB supply: 30,000 budget + 11,000 launch.
    config.circulating_xtomb = 41_000_000_000;

    emit!(MintsCreated {
        xtomb_mint: config.xtomb_mint,
        xshare_mint: config.xshare_mint,
        xbond_mint: config.xbond_mint,
    });
    Ok(())
}

// --------------------------------------------------------------- buy_pass

#[derive(Accounts)]
#[instruction(tier: u8)]
pub struct BuyPass<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = buyer,
        space = Pass::SPACE,
        seeds = [b"pass", buyer.key().as_ref()],
        bump
    )]
    pub pass: Account<'info, Pass>,
    /// Fresh keypair: the new Metaplex Core asset (the soulbound NFT).
    #[account(mut)]
    pub asset: Signer<'info>,
    #[account(mut)]
    pub buyer_usdc: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_usdc: Account<'info, TokenAccount>,
    /// CHECK: Metaplex Core program, checked against mpl_core::ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Buy a pass at the config pass price (defaults Genesis 50 / Pro
/// 100 / Ultra 300 USDC, admin-retunable via set_pass_config) to the
/// treasury wallet. Mints a Metaplex Core NFT with a permanent freeze delegate
/// held by the config PDA: frozen at mint, no transfer path exists.
pub fn buy_pass(ctx: Context<BuyPass>, tier: u8) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        tier == TIER_GENESIS || tier == TIER_PRO || tier == TIER_ULTRA,
        XtombError::InvalidTier
    );
    let now = clock_now()?;
    require!(now < config.genesis_end_ts, XtombError::PassSalesClosed);
    require!(
        ctx.accounts.buyer_usdc.mint == config.usdc_mint,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.treasury_usdc.mint == config.usdc_mint
            && ctx.accounts.treasury_usdc.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );

    let params = pass_params(config);
    let price = params.price_usdc(tier) * 1_000_000;
    token_transfer(
        ctx.accounts.buyer_usdc.to_account_info(),
        ctx.accounts.treasury_usdc.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        price,
    )?;

    // Metaplex Core CPI: create the soulbound asset.
    let name: &str = match tier {
        TIER_GENESIS => "xTOMB Genesis Pass",
        TIER_PRO => "xTOMB Pro Pass",
        _ => "xTOMB Ultra Pass",
    };
    let create_ix = mpl_core::instructions::CreateV1 {
        asset: ctx.accounts.asset.key(),
        collection: None,
        authority: None,
        payer: ctx.accounts.buyer.key(),
        owner: Some(ctx.accounts.buyer.key()),
        update_authority: Some(config.key()),
        system_program: ctx.accounts.system_program.key(),
        log_wrapper: None,
    }
    .instruction(mpl_core::instructions::CreateV1InstructionArgs {
        data_state: DataState::AccountState,
        name: name.to_string(),
        uri: String::new(),
        plugins: Some(vec![PluginAuthorityPair {
            plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {
                frozen: true,
            }),
            authority: Some(PluginAuthority::Address {
                address: config.key(),
            }),
        }]),
    });
    anchor_lang::solana_program::program::invoke(
        &create_ix,
        &[
            ctx.accounts.asset.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            config.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ],
    )?;

    let pass = &mut ctx.accounts.pass;
    pass.owner = ctx.accounts.buyer.key();
    pass.tier = tier;
    pass.asset = ctx.accounts.asset.key();
    pass.purchased_ts = now;
    pass.ultra_staked = false;
    pass.bump = ctx.bumps.pass;

    emit!(PassBought {
        owner: ctx.accounts.buyer.key(),
        tier,
        asset: ctx.accounts.asset.key(),
        price_usdc: params.price_usdc(tier),
    });
    Ok(())
}

// ----------------------------------------------------------- upgrade_pass

#[derive(Accounts)]
#[instruction(new_tier: u8)]
pub struct UpgradePass<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"pass", buyer.key().as_ref()],
        bump = pass.bump
    )]
    pub pass: Account<'info, Pass>,
    #[account(mut)]
    pub buyer_usdc: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Upgrade in place: pay only the price difference, same NFT kept.
pub fn upgrade_pass(ctx: Context<UpgradePass>, new_tier: u8) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        new_tier == TIER_GENESIS || new_tier == TIER_PRO || new_tier == TIER_ULTRA,
        XtombError::InvalidTier
    );
    let now = clock_now()?;
    require!(now < config.genesis_end_ts, XtombError::PassSalesClosed);
    let from_tier = ctx.accounts.pass.tier;
    let cost = pass_params(config)
        .upgrade_cost_usdc(from_tier, new_tier)
        .ok_or(XtombError::NotAnUpgrade)?;
    require!(
        ctx.accounts.buyer_usdc.mint == config.usdc_mint
            && ctx.accounts.treasury_usdc.mint == config.usdc_mint
            && ctx.accounts.treasury_usdc.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );
    token_transfer(
        ctx.accounts.buyer_usdc.to_account_info(),
        ctx.accounts.treasury_usdc.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        cost * 1_000_000,
    )?;
    ctx.accounts.pass.tier = new_tier;
    emit!(PassUpgraded {
        owner: ctx.accounts.buyer.key(),
        from_tier,
        to_tier: new_tier,
        paid_usdc: cost,
    });
    Ok(())
}

// --------------------------------------------------------------- add_pool

#[derive(Accounts)]
#[instruction(pool_id: u64, kind: u8, asset_mint: Pubkey, weight_bps: u16)]
pub struct AddPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        space = Pool::SPACE,
        seeds = [b"pool", pool_id.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"pool-vault", pool_id.to_le_bytes().as_ref()],
        bump,
        token::mint = asset_mint_account,
        token::authority = config,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: the pool's stake asset mint.
    pub asset_mint_account: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Admin adds a pool. Canonical ids are enforced: 1 standard, 2 LP,
/// 3 Ultra-NFT, 4 Masonry, 10+ farm.
pub fn add_pool(
    ctx: Context<AddPool>,
    pool_id: u64,
    kind: u8,
    asset_mint: Pubkey,
    weight_bps: u16,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_admin(config, &ctx.accounts.admin.key())?;
    require!(
        ctx.accounts.asset_mint_account.key() == asset_mint,
        XtombError::WrongPoolKind
    );
    let canonical = match kind {
        POOL_KIND_STANDARD => pool_id == POOL_ID_STANDARD,
        POOL_KIND_LP => pool_id == POOL_ID_LP,
        POOL_KIND_ULTRA => pool_id == POOL_ID_ULTRA,
        POOL_KIND_MASONRY => pool_id == POOL_ID_MASONRY,
        POOL_KIND_FARM => pool_id >= 10,
        _ => false,
    };
    require!(canonical, XtombError::WrongPoolId);
    require!(weight_bps <= 10_000, XtombError::BadFeeSplit);

    // The boost carve-out weights against the combined farm
    // weight (EVM alloc-point style); track the running total.
    if kind == POOL_KIND_FARM {
        config.farm_weight_total_bps = config
            .farm_weight_total_bps
            .checked_add(weight_bps)
            .ok_or(XtombError::Overflow)?;
    }

    let pool = &mut ctx.accounts.pool;
    pool.pool_id = pool_id;
    pool.kind = kind;
    pool.asset_mint = asset_mint;
    pool.vault = ctx.accounts.vault.key();
    pool.total_staked = 0;
    pool.acc_per_share = 0;
    pool.last_update_ts = clock_now()?;
    pool.weight_bps = weight_bps;
    pool.active = true;
    pool.bump = ctx.bumps.pool;

    emit!(PoolAdded {
        pool_id,
        kind,
        asset_mint,
        weight_bps,
    });
    Ok(())
}

// --------------------------------------------------------- admin setters

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn set_fee_config(
    ctx: Context<AdminConfig>,
    claim_fee_bps: u16,
    keeper_fee_bps: u16,
    lp_fee_bps: u16,
    treasury_bps: u16,
    team_bps: u16,
    dev_bps: u16,
    bot_bps: u16,
) -> Result<()> {
    require!(
        treasury_bps as u32 + team_bps as u32 + dev_bps as u32 + bot_bps as u32
            == 10_000,
        XtombError::BadFeeSplit
    );
    require!(
        claim_fee_bps <= 10_000 && keeper_fee_bps <= 10_000 && lp_fee_bps <= 10_000,
        XtombError::BadFeeSplit
    );
    let config = &mut ctx.accounts.config;
    config.claim_fee_bps = claim_fee_bps;
    config.keeper_fee_bps = keeper_fee_bps;
    config.lp_fee_bps = lp_fee_bps;
    config.treasury_bps = treasury_bps;
    config.team_bps = team_bps;
    config.dev_bps = dev_bps;
    config.bot_bps = bot_bps;
    emit!(FeeConfigSet {
        claim_fee_bps,
        keeper_fee_bps,
        lp_fee_bps,
        treasury_bps,
        team_bps,
        dev_bps,
        bot_bps,
    });
    Ok(())
}

/// Retune the withdrawal Fire Tax (Jess 2026-11-08: "let them be
/// configurable in the admin section"). Writes the real values into the
/// Config account's fire-tax fields; from then on they are used
/// verbatim (a stored 0 would mean "compiled default", so the setter
/// rejects 0 caps/windows outright). The configured cap may be lower
/// than 12% but never above the protocol's 12% hard ceiling.
pub fn set_fire_tax_config(
    ctx: Context<AdminConfig>,
    base_xtomb_bps: u16,
    base_xshare_bps: u16,
    cap_bps: u16,
    rest_bps: u16,
    recovery_secs: i64,
) -> Result<()> {
    require!(
        cap_bps > 0
            && cap_bps <= FIRE_TAX_MAX_BPS
            && base_xtomb_bps <= cap_bps
            && base_xshare_bps <= cap_bps
            && rest_bps <= cap_bps
            && recovery_secs > 0
            && recovery_secs <= 30 * 24 * 3600,
        XtombError::BadFireTaxConfig
    );
    let config = &mut ctx.accounts.config;
    config.fire_tax_base_xtomb_bps = base_xtomb_bps;
    config.fire_tax_base_xshare_bps = base_xshare_bps;
    config.fire_tax_cap_bps = cap_bps;
    config.fire_tax_rest_bps = rest_bps;
    config.fire_tax_recovery_secs = recovery_secs;
    emit!(FireTaxConfigSet {
        base_xtomb_bps,
        base_xshare_bps,
        cap_bps,
        rest_bps,
        recovery_secs,
    });
    Ok(())
}

/// Healthy override (Jess 2026-11-08): while the protocol is doing
/// "very well and healthy" the admin can zero BOTH withdrawal Fire
/// Taxes, and restore them by clearing the flag. The curve parameters
/// are untouched; clearing the flag resumes the configured rates.
pub fn set_fire_tax_zeroed(
    ctx: Context<AdminConfig>,
    zeroed: bool,
) -> Result<()> {
    ctx.accounts.config.fire_tax_zeroed = zeroed;
    emit!(FireTaxZeroedSet { zeroed });
    Ok(())
}

/// Retune the pass price table and the per-tier standard-pool
/// deposit fees (Jess's standing configurability rule: prices and
/// fees are config fields, never hardcoded constants). All six
/// values are written verbatim and take effect on the next buy /
/// upgrade / stake. Validation: every price must be > 0 (a stored 0
/// is the "compiled default" sentinel, so a real 0 price can never
/// be expressed — by design), and every deposit fee is capped at
/// 1000 bps (10%).
pub fn set_pass_config(
    ctx: Context<AdminConfig>,
    price_genesis_usdc: u64,
    price_pro_usdc: u64,
    price_ultra_usdc: u64,
    deposit_fee_genesis_bps: u16,
    deposit_fee_pro_bps: u16,
    deposit_fee_ultra_bps: u16,
) -> Result<()> {
    require!(
        price_genesis_usdc > 0 && price_pro_usdc > 0 && price_ultra_usdc > 0,
        XtombError::BadPassConfig
    );
    require!(
        deposit_fee_genesis_bps <= 1000
            && deposit_fee_pro_bps <= 1000
            && deposit_fee_ultra_bps <= 1000,
        XtombError::BadPassConfig
    );
    let config = &mut ctx.accounts.config;
    config.pass_price_genesis_usdc = price_genesis_usdc;
    config.pass_price_pro_usdc = price_pro_usdc;
    config.pass_price_ultra_usdc = price_ultra_usdc;
    config.pass_deposit_fee_genesis_bps = deposit_fee_genesis_bps;
    config.pass_deposit_fee_pro_bps = deposit_fee_pro_bps;
    config.pass_deposit_fee_ultra_bps = deposit_fee_ultra_bps;
    emit!(PassConfigSet {
        price_genesis_usdc,
        price_pro_usdc,
        price_ultra_usdc,
        deposit_fee_genesis_bps,
        deposit_fee_pro_bps,
        deposit_fee_ultra_bps,
    });
    Ok(())
}

// -------------------------------------------------------- weekly boost

#[derive(Accounts)]
pub struct InitializeBoost<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        space = BoostState::SPACE,
        seeds = [b"boost-state"],
        bump
    )]
    pub boost_state: Box<Account<'info, BoostState>>,
    pub system_program: Program<'info, System>,
}

/// Admin creates the weekly-boost state, anchored at the farm
/// start (Genesis end). Separate from initialize_config because
/// the boost ships as an upgrade to a live program; the Config
/// flag it sets is what activates the staking-path hooks.
pub fn initialize_boost(ctx: Context<InitializeBoost>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_admin(config, &ctx.accounts.admin.key())?;
    let st = &mut ctx.accounts.boost_state;
    st.anchor_ts = config.genesis_end_ts;
    st.last_settle_ts = config.genesis_end_ts;
    st.bump = ctx.bumps.boost_state;
    config.boost_initialized = true;
    emit!(BoostInitialized {
        anchor_ts: st.anchor_ts,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetBoostConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"boost-state"], bump = boost_state.bump)]
    pub boost_state: Box<Account<'info, BoostState>>,
}

/// Admin sets the weekly boost parameters (human units, like the
/// EVM config: percent 0-25, week length 1-30 days). A percent
/// change settles accrual under the OLD percent first; the week
/// length cannot change once the farm has started.
pub fn set_boost_config(
    ctx: Context<SetBoostConfig>,
    percent: u16,
    week_length_days: u16,
) -> Result<()> {
    require!(percent <= 25, XtombError::BadBoostConfig);
    require!(
        (1..=30).contains(&week_length_days),
        XtombError::BadBoostConfig
    );
    let now = clock_now()?;
    let config = &mut ctx.accounts.config;
    let state_info = ctx.accounts.boost_state.to_account_info();
    let st = &mut ctx.accounts.boost_state;
    let current_days = if config.week_length_days == 0 {
        BOOST_WEEK_DEFAULT_DAYS
    } else {
        config.week_length_days
    };
    if week_length_days != current_days {
        require!(now < st.anchor_ts, XtombError::BoostWeekLengthLocked);
        config.week_length_days = week_length_days;
    }
    // Settle accrual under the OLD percent before applying the new.
    let mut state_data = state_info.try_borrow_mut_data()?;
    settle_boost_state(config, st, &mut state_data, now)?;
    config.weekly_boost_percent = percent;
    config.boost_percent_configured = true;
    emit!(BoostConfigSet {
        percent,
        week_length_days,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleBoost<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"boost-state"], bump = boost_state.bump)]
    pub boost_state: Box<Account<'info, BoostState>>,
}

/// Permissionless crank: slice farm emissions into weekly buckets
/// and close ended weeks. The same settle also runs inside Masonry
/// stake/unstake, claim_boost and set_boost_config, so this exists
/// for keepers/frontends that want weeks closed on schedule.
pub fn settle_boost(ctx: Context<SettleBoost>) -> Result<()> {
    let now = clock_now()?;
    let state_info = ctx.accounts.boost_state.to_account_info();
    let mut state_data = state_info.try_borrow_mut_data()?;
    settle_boost_state(
        &ctx.accounts.config,
        &mut ctx.accounts.boost_state,
        &mut state_data,
        now,
    )
}

#[derive(Accounts)]
pub struct ClaimBoost<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"boost-state"], bump = boost_state.bump)]
    pub boost_state: Box<Account<'info, BoostState>>,
    #[account(
        init_if_needed,
        payer = user,
        space = BoostUser::SPACE,
        seeds = [b"boost-user", user.key().as_ref()],
        bump
    )]
    pub boost_user: Box<Account<'info, BoostUser>>,
    /// Farm rewards vault: xSHARE pot owned by the config PDA.
    #[account(mut)]
    pub farm_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_xshare: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Pull-claim settled boost credit from the farm vault — the EVM
/// claimBoost. No claim fee (EVM parity); credit never expires;
/// claiming with zero credit is a silent no-op (EVM parity).
pub fn claim_boost(ctx: Context<ClaimBoost>) -> Result<()> {
    let now = clock_now()?;
    let user_key = ctx.accounts.user.key();
    require_not_maintenance(&ctx.accounts.config)?;
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.farm_vault.mint == config.xshare_mint
            && ctx.accounts.farm_vault.owner == config.key(),
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.user_xshare.mint == config.xshare_mint
            && ctx.accounts.user_xshare.owner == user_key,
        XtombError::BadTokenAccount
    );
    let rec = &mut ctx.accounts.boost_user;
    if rec.owner == Pubkey::default() {
        rec.owner = user_key;
        rec.bump = ctx.bumps.boost_user;
    }
    let state_info = ctx.accounts.boost_state.to_account_info();
    let st = &mut ctx.accounts.boost_state;
    let mut state_data = state_info.try_borrow_mut_data()?;
    settle_boost_state(config, st, &mut state_data, now)?;
    settle_user_boost_rec(st, &state_data, rec)?;
    let amount = rec.credit;
    if amount == 0 {
        return Ok(());
    }
    require!(
        ctx.accounts.farm_vault.amount >= amount,
        XtombError::InsufficientRewards
    );
    rec.credit = 0;
    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    token_transfer_signed(
        ctx.accounts.farm_vault.to_account_info(),
        ctx.accounts.user_xshare.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount,
        seeds,
    )?;
    emit!(BoostClaimed {
        owner: user_key,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PendingBoost<'info> {
    /// CHECK: record owner — used only as a seed for the record PDA.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"boost-state"], bump = boost_state.bump)]
    pub boost_state: Box<Account<'info, BoostState>>,
    #[account(
        seeds = [b"boost-user", user.key().as_ref()],
        bump = boost_user.bump
    )]
    pub boost_user: Box<Account<'info, BoostUser>>,
}

/// Read-only pending boost for a user (settled credit plus
/// closed-but-unsettled week entitlements) — the EVM pendingBoost.
pub fn pending_boost(ctx: Context<PendingBoost>) -> Result<u64> {
    let state_info = ctx.accounts.boost_state.to_account_info();
    let state_data = state_info.try_borrow_data()?;
    Ok(pending_boost_calc(
        &ctx.accounts.boost_state,
        &state_data,
        &ctx.accounts.boost_user,
    ))
}

pub fn set_wallets(
    ctx: Context<AdminConfig>,
    treasury_wallet: Pubkey,
    team_wallet: Pubkey,
    dev_wallet: Pubkey,
    bot_wallet: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.treasury_wallet = treasury_wallet;
    config.team_wallet = team_wallet;
    config.dev_wallet = dev_wallet;
    config.bot_wallet = bot_wallet;
    emit!(WalletsSet {
        treasury_wallet,
        team_wallet,
        dev_wallet,
        bot_wallet,
    });
    Ok(())
}

pub fn set_maintenance(ctx: Context<AdminConfig>, maintenance: bool) -> Result<()> {
    ctx.accounts.config.maintenance = maintenance;
    emit!(MaintenanceSet { maintenance });
    Ok(())
}

// -------------------------------------------------------------- set_oracle

#[derive(Accounts)]
#[instruction(twap_e6: u64, ts: i64, new_authority: Pubkey)]
pub struct SetOracle<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Post TWAP + timestamp (oracle authority or admin). The admin may also
/// rotate the oracle authority by passing a non-default `new_authority`.
pub fn set_oracle(
    ctx: Context<SetOracle>,
    twap_e6: u64,
    ts: i64,
    new_authority: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let caller = ctx.accounts.caller.key();
    if new_authority != Pubkey::default() {
        // Rotation is admin-only.
        require_admin(config, &caller)?;
        config.oracle_authority = new_authority;
    } else {
        require!(
            caller == config.admin || caller == config.oracle_authority,
            XtombError::NotOracle
        );
    }
    config.oracle_twap_e6 = twap_e6;
    config.oracle_ts = ts;
    emit!(OracleSet {
        twap_e6,
        ts,
        authority: config.oracle_authority,
    });
    Ok(())
}

// ------------------------------------------------------------------ stake

#[derive(Accounts)]
#[instruction(pool_id: u64, amount: u64, is_ultra_nft: bool)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"pool", &pool_id.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init_if_needed,
        payer = user,
        space = Position::SPACE,
        seeds = [b"position", user.key().as_ref(), &pool_id.to_le_bytes()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: pass PDA for the user. Required for Genesis pools
    /// (standard / LP / Ultra-NFT); ignored for farm / Masonry.
    #[account(mut)]
    pub pass: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn stake(
    ctx: Context<Stake>,
    pool_id: u64,
    amount: u64,
    is_ultra_nft: bool,
) -> Result<()> {
    let now = clock_now()?;
    let user_key = ctx.accounts.user.key();
    require_not_maintenance(&ctx.accounts.config)?;
    require!(ctx.accounts.pool.active, XtombError::PoolInactive);
    let kind = ctx.accounts.pool.kind;
    let is_genesis_pool = matches!(
        kind,
        POOL_KIND_STANDARD | POOL_KIND_LP | POOL_KIND_ULTRA
    );

    // Timing gates + pass requirement for Genesis pools.
    let mut pass_opt: Option<Pass> = None;
    if is_genesis_pool {
        let config = &ctx.accounts.config;
        require!(
            now >= config.genesis_start_ts - 24 * 3600,
            XtombError::GenesisNotStarted
        );
        if now < config.genesis_start_ts {
            // Ultra pre-stake window (T-24h..T): Ultra pass only.
            let pass = load_pass(
                &ctx.accounts.pass.to_account_info(),
                &user_key,
            )?;
            require!(pass.tier == TIER_ULTRA, XtombError::GenesisNotStarted);
            pass_opt = Some(pass);
        } else {
            require!(now < config.genesis_end_ts, XtombError::GenesisEnded);
            pass_opt = Some(load_pass(
                &ctx.accounts.pass.to_account_info(),
                &user_key,
            )?);
        }
        if kind == POOL_KIND_LP {
            require!(
                now >= config.genesis_start_ts + 24 * 3600,
                XtombError::LpNotOpen
            );
        }
    }

    let config = &mut ctx.accounts.config;
    let pool = &mut ctx.accounts.pool;
    update_pool(pool, config, now)?;

    // Fresh position: initialize base fields.
    let position = &mut ctx.accounts.position;
    if position.owner == Pubkey::default() {
        position.owner = user_key;
        position.pool = pool.key();
        position.pool_kind = kind;
        position.asset_mint = pool.asset_mint;
        position.amount = 0;
        position.reward_debt = 0;
        position.accrued_liquid = 0;
        position.accrued_vested = 0;
        position.vesting_total = 0;
        position.vesting_claimed_amount = 0;
        position.vesting_claimed_installments = 0;
        position.vesting_next_ts = 0;
        position.last_cooldown_ts = 0;
        position.genesis = is_genesis_pool;
        position.bump = ctx.bumps.position;
    }
    settle_pending(position, pool, config)?;

    if is_ultra_nft {
        // The Ultra NFT stakes as its own position: 1 pseudo-unit, no
        // token movement. 5% of Genesis emissions flow to this pool.
        require!(kind == POOL_KIND_ULTRA, XtombError::WrongPoolKind);
        require!(amount == 0, XtombError::ZeroAmount);
        let mut pass = pass_opt.ok_or(XtombError::NoPass)?;
        require!(pass.tier == TIER_ULTRA, XtombError::RequiresUltraPass);
        require!(!pass.ultra_staked, XtombError::UltraAlreadyStaked);
        pass.ultra_staked = true;
        save_pass(&ctx.accounts.pass.to_account_info(), &pass)?;
        position.amount = position
            .amount
            .checked_add(1)
            .ok_or(XtombError::Overflow)?;
        pool.total_staked = pool
            .total_staked
            .checked_add(1)
            .ok_or(XtombError::Overflow)?;
        position.reward_debt =
            position.amount as u128 * pool.acc_per_share / ACC_SCALE;
        emit!(Staked {
            owner: user_key,
            pool_id,
            amount: 0,
            fee: 0,
            credited: 1,
        });
        return Ok(());
    }

    // Weekly boost (Masonry stakes only): settle-before-change
    // eligibility bookkeeping. Inert until the admin initializes
    // the boost; from then on the boost accounts are required as
    // remaining accounts (see boost_hook_begin).
    let mut boost_hook =
        if kind == POOL_KIND_MASONRY && config.boost_initialized {
            let (mut st, mut ur) = boost_hook_begin(
                ctx.remaining_accounts,
                config,
                &user_key,
                position.amount,
                now,
            )?;
            boost_touch_rec(config, &mut st, &mut ur, false, amount, now);
            Some((st, ur))
        } else {
            None
        };

    require!(amount > 0, XtombError::ZeroAmount);
    require!(
        ctx.accounts.user_token.mint == pool.asset_mint
            && ctx.accounts.user_token.owner == user_key,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.vault.key() == pool.vault,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.treasury_token.mint == pool.asset_mint
            && ctx.accounts.treasury_token.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );

    // Deposit fee: standard pools by tier (config table, defaults
    // 2/1/0%); LP pools 0.5% of
    // gross shares to the treasury wallet as protocol-owned liquidity
    // (Q8, Jess 2026-11-08), waived for Ultra pass holders — 0% on
    // all pools with Ultra (Jess, 2026-11-08); farm / Masonry: no fee.
    let fee_bps = match kind {
        POOL_KIND_STANDARD => pass_params(config)
            .deposit_fee_bps(pass_opt.map(|p| p.tier).unwrap_or(TIER_GENESIS)),
        POOL_KIND_LP => {
            if pass_opt.map(|p| p.tier).unwrap_or(TIER_GENESIS) == TIER_ULTRA {
                0
            } else {
                config.lp_fee_bps
            }
        }
        _ => 0,
    };
    let fee = amount * fee_bps as u64 / 10_000;
    let net = amount - fee;
    if fee > 0 && (kind == POOL_KIND_STANDARD || kind == POOL_KIND_LP) {
        // Standard-pool fee goes to the treasury wallet. The LP-pool
        // fee goes to the treasury wallet too, as LP tokens held as
        // protocol-owned liquidity (Q8, Jess 2026-11-08: "Solana
        // matches EVM — LP fee to Treasury as POL"): transferred, not
        // redeemed or burned, so the LP mint supply does not change.
        token_transfer(
            ctx.accounts.user_token.to_account_info(),
            ctx.accounts.treasury_token.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            fee,
        )?;
    }
    // Only the net amount enters the pool vault. (Historically the LP
    // fee portion rode along into the vault as unclaimed fee shares;
    // it now leaves with the fee transfer above.) Farm / Masonry have
    // no fee, so net == amount there.
    token_transfer(
        ctx.accounts.user_token.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        net,
    )?;

    position.amount = position
        .amount
        .checked_add(net)
        .ok_or(XtombError::Overflow)?;
    pool.total_staked = pool
        .total_staked
        .checked_add(net)
        .ok_or(XtombError::Overflow)?;
    position.reward_debt =
        position.amount as u128 * pool.acc_per_share / ACC_SCALE;

    if let Some((st, ur)) = &mut boost_hook {
        boost_hook_finish(
            ctx.remaining_accounts,
            st,
            ur,
            position.amount,
            pool.total_staked,
            now,
        )?;
    }

    emit!(Staked {
        owner: user_key,
        pool_id,
        amount,
        fee,
        credited: net,
    });
    Ok(())
}

// ---------------------------------------------------------------- unstake

#[derive(Accounts)]
#[instruction(pool_id: u64, amount: u64)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"pool", &pool_id.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [b"position", user.key().as_ref(), &pool_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: pass PDA. Needed to clear ultra_staked for Ultra-NFT exits.
    #[account(mut)]
    pub pass: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub tax_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub xtomb_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Withdraw staked principal. Applies the §6 withdrawal Fire Tax as one
/// debit: xTOMB tax burns 100% during Genesis, else to Treasury;
/// xSHARE / other-asset tax goes to the treasury token account (the
/// 12/20/68 split and Critical Defense reroute are recorded in the
/// event + config counter; conversion is bot work).
pub fn unstake(ctx: Context<Unstake>, pool_id: u64, amount: u64) -> Result<()> {
    let now = clock_now()?;
    let user_key = ctx.accounts.user.key();
    require_not_maintenance(&ctx.accounts.config)?;
    require!(ctx.accounts.pool.active, XtombError::PoolInactive);
    require!(amount > 0, XtombError::ZeroAmount);
    require!(
        ctx.accounts.position.amount >= amount,
        XtombError::InsufficientStake
    );
    let kind = ctx.accounts.pool.kind;

    let config = &mut ctx.accounts.config;
    let pool = &mut ctx.accounts.pool;
    update_pool(pool, config, now)?;
    let position = &mut ctx.accounts.position;
    settle_pending(position, pool, config)?;

    if kind == POOL_KIND_ULTRA {
        // Ultra-NFT exit: no principal, no tax; just release the NFT.
        require!(
            amount == 1 && position.amount == 1,
            XtombError::InsufficientStake
        );
        let mut pass =
            load_pass(&ctx.accounts.pass.to_account_info(), &user_key)?;
        pass.ultra_staked = false;
        save_pass(&ctx.accounts.pass.to_account_info(), &pass)?;
        position.amount = 0;
        position.reward_debt = 0;
        pool.total_staked = pool.total_staked.saturating_sub(1);
        emit!(Unstaked {
            owner: user_key,
            pool_id,
            amount: 1,
            tax: 0,
            tax_rate_bps: 0,
            net: 0,
        });
        return Ok(());
    }

    // Weekly boost (Masonry withdrawals only): any withdrawal —
    // even dust — voids the week's eligibility, so settle + touch
    // before the balance moves.
    let mut boost_hook =
        if kind == POOL_KIND_MASONRY && config.boost_initialized {
            let (mut st, mut ur) = boost_hook_begin(
                ctx.remaining_accounts,
                config,
                &user_key,
                position.amount,
                now,
            )?;
            boost_touch_rec(config, &mut st, &mut ur, true, amount, now);
            Some((st, ur))
        } else {
            None
        };

    // Withdrawals fail closed on stale oracle data; buys stay available.
    require_fresh_oracle(config, now)?;
    require!(
        ctx.accounts.vault.key() == pool.vault,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.user_token.mint == pool.asset_mint
            && ctx.accounts.user_token.owner == user_key,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.tax_destination.mint == pool.asset_mint
            && ctx.accounts.tax_destination.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.xtomb_mint.key() == config.xtomb_mint,
        XtombError::BadTokenAccount
    );

    let is_xshare = pool.asset_mint == config.xshare_mint;
    let is_xtomb = pool.asset_mint == config.xtomb_mint;
    let rate = fire_tax_for(config, now, is_xshare);
    let tax = fire_tax_amount(amount, rate);
    let net = amount - tax;

    position.amount -= amount;
    pool.total_staked = pool.total_staked.saturating_sub(amount);
    position.reward_debt =
        position.amount as u128 * pool.acc_per_share / ACC_SCALE;

    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    token_transfer_signed(
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.user_token.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        net,
        seeds,
    )?;
    if tax > 0 {
        if is_xtomb && now < config.genesis_end_ts {
            // Genesis xTOMB tax burns 100%.
            token_burn_signed(
                ctx.accounts.xtomb_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                tax,
                seeds,
            )?;
        } else {
            token_transfer_signed(
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.tax_destination.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                tax,
                seeds,
            )?;
        }
    }
    if is_xshare && config.critical_defense {
        config.xshare_tax_pending_burn = config
            .xshare_tax_pending_burn
            .checked_add(tax)
            .ok_or(XtombError::Overflow)?;
    }

    if let Some((st, ur)) = &mut boost_hook {
        boost_hook_finish(
            ctx.remaining_accounts,
            st,
            ur,
            position.amount,
            pool.total_staked,
            now,
        )?;
    }

    emit!(Unstaked {
        owner: user_key,
        pool_id,
        amount,
        tax,
        tax_rate_bps: rate,
        net,
    });
    Ok(())
}

// ------------------------------------------------------------------ claim

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"pool", &pool_id.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [b"position", user.key().as_ref(), &pool_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    /// Rewards vault paying this pool: the Genesis rewards vault for
    /// standard/LP/Ultra pools, the Masonry vault for the Masonry pool.
    /// Must be xTOMB and owned by the config PDA.
    #[account(mut)]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_xtomb: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_xtomb: Box<Account<'info, TokenAccount>>,
    /// xTOMB mint — needed to burn the Genesis claim Fire Tax.
    #[account(mut)]
    pub xtomb_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Claim settled liquid rewards plus any due vesting installment
/// (16 x 6h; first at Genesis end + 6h; each next opens only when the
/// previous is claimed). Shares the 3h cooldown clock with compound.
/// Fee: during the Genesis window, claims on Genesis pools (standard /
/// LP / Ultra) pay the CURRENT xTOMB Fire Tax rate instead of the flat
/// claim fee, and the tax burns 100% like Genesis xTOMB withdrawal tax
/// (Jess, 2026-11-08). Masonry-pool claims pay the Fire Tax at ALL
/// times, routed like the withdrawal tax — to Treasury post-Genesis
/// (Jess, 2026-11-08, reversing the earlier flat-fee scoping for the
/// Masonry). All other post-Genesis claims pay the configured flat
/// claim fee to Treasury.
pub fn claim(ctx: Context<Claim>, pool_id: u64) -> Result<()> {
    let now = clock_now()?;
    let user_key = ctx.accounts.user.key();
    require_not_maintenance(&ctx.accounts.config)?;
    let kind = ctx.accounts.pool.kind;
    require!(
        matches!(
            kind,
            POOL_KIND_STANDARD | POOL_KIND_LP | POOL_KIND_MASONRY | POOL_KIND_ULTRA
        ),
        XtombError::WrongPoolKind
    );

    let config = &mut ctx.accounts.config;
    let pool = &mut ctx.accounts.pool;
    update_pool(pool, config, now)?;
    let position = &mut ctx.accounts.position;
    settle_pending(position, pool, config)?;

    require!(
        compound_allowed(position.last_cooldown_ts, now),
        XtombError::CompoundTooSoon
    );

    let liquid = position.accrued_liquid;
    let mut installment: u64 = 0;
    if position.vesting_total > position.vesting_claimed_amount
        && now >= position.vesting_next_ts
        && position.vesting_claimed_installments < VESTING_INSTALLMENTS
    {
        installment = vesting_installment(
            position.vesting_total,
            position.vesting_claimed_amount,
            position.vesting_claimed_installments,
        );
    }
    require!(
        liquid + installment > 0,
        XtombError::NothingToClaim
    );

    require!(
        ctx.accounts.rewards_vault.mint == config.xtomb_mint
            && ctx.accounts.rewards_vault.owner == config.key(),
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.treasury_xtomb.mint == config.xtomb_mint
            && ctx.accounts.treasury_xtomb.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.user_xtomb.mint == config.xtomb_mint
            && ctx.accounts.user_xtomb.owner == user_key,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.rewards_vault.amount >= liquid + installment,
        XtombError::InsufficientRewards
    );
    require!(
        ctx.accounts.xtomb_mint.key() == config.xtomb_mint,
        XtombError::BadTokenAccount
    );

    // Genesis claims follow the Fire Tax (Jess, 2026-11-08): inside the
    // Genesis window, a Genesis-pool claim charges the current xTOMB
    // Fire Tax rate (TWAP-priced, so fail closed on stale oracle data,
    // like unstake/compound) and the tax burns 100%, routed exactly
    // like a Genesis xTOMB withdrawal. Masonry-pool claims pay the
    // Fire Tax at ALL times (Jess, 2026-11-08: "claiming xTOMB from the
    // Masonry is taxed at fire rates" — reversing the flat-fee scoping
    // made earlier the same day): same helper, same routing rule as a
    // withdrawal, so post-Genesis the tax lands in Treasury (the
    // during-Genesis burn branch below mirrors unstake's; Masonry
    // rewards only exist once epochs run, i.e. after Genesis, so in
    // practice that branch is unreachable for the Masonry). Outside the
    // window, Genesis-pool claims (vesting installments included) keep
    // the flat claim fee to Treasury.
    let in_genesis_window =
        now >= config.genesis_start_ts && now < config.genesis_end_ts;
    let genesis_claim = in_genesis_window
        && matches!(
            kind,
            POOL_KIND_STANDARD | POOL_KIND_LP | POOL_KIND_ULTRA
        );
    let fire_taxed_claim = genesis_claim || kind == POOL_KIND_MASONRY;
    let (liquid_fee, vest_fee);
    if fire_taxed_claim {
        require_fresh_oracle(config, now)?;
        let rate = fire_tax_for(config, now, false);
        liquid_fee = fire_tax_amount(liquid, rate);
        vest_fee = fire_tax_amount(installment, rate);
    } else {
        let claim_fee_bps = config.claim_fee_bps;
        liquid_fee = liquid * claim_fee_bps as u64 / 10_000;
        vest_fee = installment * claim_fee_bps as u64 / 10_000;
    }
    let user_payout = (liquid - liquid_fee) + (installment - vest_fee);
    let fee_payout = liquid_fee + vest_fee;

    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    if user_payout > 0 {
        token_transfer_signed(
            ctx.accounts.rewards_vault.to_account_info(),
            ctx.accounts.user_xtomb.to_account_info(),
            config.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            user_payout,
            seeds,
        )?;
    }
    if fee_payout > 0 {
        if fire_taxed_claim && now < config.genesis_end_ts {
            // Genesis xTOMB Fire Tax burns 100% (the same condition the
            // withdrawal path uses: xTOMB tax inside the Genesis window).
            token_burn_signed(
                ctx.accounts.xtomb_mint.to_account_info(),
                ctx.accounts.rewards_vault.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee_payout,
                seeds,
            )?;
        } else {
            token_transfer_signed(
                ctx.accounts.rewards_vault.to_account_info(),
                ctx.accounts.treasury_xtomb.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee_payout,
                seeds,
            )?;
        }
    }

    position.accrued_liquid = 0;
    if installment > 0 {
        position.accrued_vested = position.accrued_vested.saturating_sub(installment);
        position.vesting_claimed_amount += installment;
        position.vesting_claimed_installments += 1;
        // The next 6h interval starts when this installment is claimed.
        position.vesting_next_ts = now + 6 * 3600;
    }
    position.last_cooldown_ts = now;

    emit!(Claimed {
        owner: user_key,
        pool_id,
        liquid_net: liquid - liquid_fee,
        liquid_fee,
        vesting_released: installment - vest_fee,
        vesting_fee: vest_fee,
    });
    Ok(())
}

// --------------------------------------------------------------- compound

#[derive(Accounts)]
#[instruction(pool_id: u64, is_keeper: bool)]
pub struct Compound<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: position owner (beneficiary). The caller may be the owner
    /// (manual) or any keeper (keeper compound, Pro/Ultra only).
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"pool", &pool_id.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init_if_needed,
        payer = caller,
        space = Position::SPACE,
        seeds = [b"position", owner.key().as_ref(), &pool_id.to_le_bytes()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: pass PDA for the owner.
    pub pass: UncheckedAccount<'info>,
    #[account(mut)]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_xtomb: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub xtomb_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Compound liquid xTOMB rewards into the LP pool. Enforces the §4 hard
/// cap: any compound sooner than 3h after the last claim/compound on
/// this user+pool REVERTS (manual, keeper, Pro 6h, Ultra 3h alike).
/// The sell leg pays the §6 Fire Tax; keeper compounds pay 2% to
/// Treasury; the LP fee is 0.5% of gross, also to Treasury as POL
/// (Q8, Jess 2026-11-08). No on-chain AMM exists in this
/// build: the conversion settles in accounting units at the TWAP
/// reference price (see BUILD-NOTES.md).
pub fn compound(ctx: Context<Compound>, pool_id: u64, is_keeper: bool) -> Result<()> {
    let now = clock_now()?;
    let owner_key = ctx.accounts.owner.key();
    require_not_maintenance(&ctx.accounts.config)?;
    require!(
        ctx.accounts.pool.kind == POOL_KIND_LP,
        XtombError::WrongPoolKind
    );
    {
        let config = &ctx.accounts.config;
        require!(now < config.genesis_end_ts, XtombError::GenesisEnded);
        require!(
            now >= config.genesis_start_ts + 24 * 3600,
            XtombError::LpNotOpen
        );
    }

    let pass = load_pass(&ctx.accounts.pass.to_account_info(), &owner_key)?;
    if is_keeper {
        require!(
            pass.tier == TIER_PRO || pass.tier == TIER_ULTRA,
            XtombError::RequiresKeeperTier
        );
    }

    let config = &mut ctx.accounts.config;
    let pool = &mut ctx.accounts.pool;
    update_pool(pool, config, now)?;
    let position = &mut ctx.accounts.position;
    if position.owner == Pubkey::default() {
        position.owner = owner_key;
        position.pool = pool.key();
        position.pool_kind = POOL_KIND_LP;
        position.asset_mint = pool.asset_mint;
        position.amount = 0;
        position.reward_debt = 0;
        position.accrued_liquid = 0;
        position.accrued_vested = 0;
        position.vesting_total = 0;
        position.vesting_claimed_amount = 0;
        position.vesting_claimed_installments = 0;
        position.vesting_next_ts = 0;
        position.last_cooldown_ts = 0;
        position.genesis = true;
        position.bump = ctx.bumps.position;
    }
    settle_pending(position, pool, config)?;

    // Hard compound cap.
    require!(
        compound_allowed(position.last_cooldown_ts, now),
        XtombError::CompoundTooSoon
    );
    let liquid = position.accrued_liquid;
    require!(liquid > 0, XtombError::NothingToCompound);

    // The compound's sell leg pays the Fire Tax: fail closed on stale data.
    require_fresh_oracle(config, now)?;
    require!(
        ctx.accounts.rewards_vault.mint == config.xtomb_mint
            && ctx.accounts.rewards_vault.owner == config.key(),
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.treasury_xtomb.mint == config.xtomb_mint
            && ctx.accounts.treasury_xtomb.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.xtomb_mint.key() == config.xtomb_mint,
        XtombError::BadTokenAccount
    );

    let rate = fire_tax_for(config, now, false);
    let fire_tax = fire_tax_amount(liquid, rate);
    let keeper_fee = if is_keeper {
        liquid * config.keeper_fee_bps as u64 / 10_000
    } else {
        0
    };
    let gross = liquid - fire_tax - keeper_fee;
    let lp_fee = gross * config.lp_fee_bps as u64 / 10_000;
    let net = gross - lp_fee;

    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    let genesis_active = now < config.genesis_end_ts;
    if fire_tax > 0 {
        if genesis_active {
            token_burn_signed(
                ctx.accounts.xtomb_mint.to_account_info(),
                ctx.accounts.rewards_vault.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fire_tax,
                seeds,
            )?;
        } else {
            token_transfer_signed(
                ctx.accounts.rewards_vault.to_account_info(),
                ctx.accounts.treasury_xtomb.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fire_tax,
                seeds,
            )?;
        }
    }
    if keeper_fee > 0 {
        token_transfer_signed(
            ctx.accounts.rewards_vault.to_account_info(),
            ctx.accounts.treasury_xtomb.to_account_info(),
            config.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            keeper_fee,
            seeds,
        )?;
    }
    if lp_fee > 0 {
        // LP fee goes to the treasury wallet as protocol-owned
        // liquidity (Q8, Jess 2026-11-08). The compound credits
        // pseudo-LP 1:1 from xTOMB in this AMM-less build, so the fee
        // leg is the xTOMB equivalent — transferred to Treasury, NOT
        // burned (it previously burned here); the xTOMB supply does
        // not change because of the fee.
        token_transfer_signed(
            ctx.accounts.rewards_vault.to_account_info(),
            ctx.accounts.treasury_xtomb.to_account_info(),
            config.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            lp_fee,
            seeds,
        )?;
    }

    position.amount = position
        .amount
        .checked_add(net)
        .ok_or(XtombError::Overflow)?;
    pool.total_staked = pool
        .total_staked
        .checked_add(net)
        .ok_or(XtombError::Overflow)?;
    position.accrued_liquid = 0;
    position.reward_debt =
        position.amount as u128 * pool.acc_per_share / ACC_SCALE;
    position.last_cooldown_ts = now;

    emit!(Compounded {
        owner: owner_key,
        pool_id,
        liquid_compounded: liquid,
        fire_tax,
        keeper_fee,
        lp_fee,
        credited_lp: net,
        keeper: is_keeper,
    });
    Ok(())
}

// --------------------------------------------------------------- harvest

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct Harvest<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"pool", &pool_id.to_le_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [b"position", user.key().as_ref(), &pool_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut)]
    pub farm_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_xshare: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_xshare: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Harvest farm xSHARE rewards: 100% liquid, 2% claim fee to Treasury,
/// same 3h shared cooldown as claim/compound.
pub fn harvest(ctx: Context<Harvest>, pool_id: u64) -> Result<()> {
    let now = clock_now()?;
    let user_key = ctx.accounts.user.key();
    require_not_maintenance(&ctx.accounts.config)?;
    require!(
        ctx.accounts.pool.kind == POOL_KIND_FARM,
        XtombError::WrongPoolKind
    );

    let config = &mut ctx.accounts.config;
    let pool = &mut ctx.accounts.pool;
    update_pool(pool, config, now)?;
    let position = &mut ctx.accounts.position;
    settle_pending(position, pool, config)?;

    require!(
        compound_allowed(position.last_cooldown_ts, now),
        XtombError::CompoundTooSoon
    );
    let amount = position.accrued_liquid;
    require!(amount > 0, XtombError::NothingToClaim);

    require!(
        ctx.accounts.farm_vault.mint == config.xshare_mint
            && ctx.accounts.farm_vault.owner == config.key(),
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.treasury_xshare.mint == config.xshare_mint
            && ctx.accounts.treasury_xshare.owner == config.treasury_wallet,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.user_xshare.mint == config.xshare_mint
            && ctx.accounts.user_xshare.owner == user_key,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.farm_vault.amount >= amount,
        XtombError::InsufficientRewards
    );

    let fee = amount * config.claim_fee_bps as u64 / 10_000;
    let net = amount - fee;
    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    if net > 0 {
        token_transfer_signed(
            ctx.accounts.farm_vault.to_account_info(),
            ctx.accounts.user_xshare.to_account_info(),
            config.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            net,
            seeds,
        )?;
    }
    if fee > 0 {
        token_transfer_signed(
            ctx.accounts.farm_vault.to_account_info(),
            ctx.accounts.treasury_xshare.to_account_info(),
            config.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            fee,
            seeds,
        )?;
    }
    position.accrued_liquid = 0;
    position.last_cooldown_ts = now;

    emit!(Harvested {
        owner: user_key,
        pool_id,
        amount_net: net,
        fee,
    });
    Ok(())
}

// --------------------------------------------------------- set_bond_config

#[derive(Accounts)]
pub struct SetBondConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub lp_mint: Box<Account<'info, Mint>>,
    /// CHECK: PDA token vault ["bond-lp-vault"], created (or
    /// validated) manually in the instruction.
    #[account(mut)]
    pub bond_lp_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Admin: set the bond premium (bps of pay-in value credited on
/// native-token / USDC pay-ins; 0 = the compiled default of 1000)
/// and register the xTOMB LP mint, creating the bond backing vault
/// the operator deposits redeemable LP into. The LP mint is
/// set-once in practice: it cannot be swapped for a different mint
/// afterwards (that would orphan outstanding bonds).
pub fn set_bond_config(ctx: Context<SetBondConfig>, premium_bps: u16) -> Result<()> {
    require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
    require!(premium_bps <= 10_000, XtombError::BadBondConfig);
    let lp_mint_key = ctx.accounts.lp_mint.key();
    {
        let config = &ctx.accounts.config;
        if config.bond_lp_mint != Pubkey::default() {
            require!(
                config.bond_lp_mint == lp_mint_key,
                XtombError::BadBondConfig
            );
        }
    }
    let rent_lamports = Rent::get()?.minimum_balance(TokenAccount::LEN);
    ensure_pda_token_vault(
        &ctx.accounts.bond_lp_vault.to_account_info(),
        &[b"bond-lp-vault"],
        &ctx.accounts.lp_mint.to_account_info(),
        &ctx.accounts.config.to_account_info(),
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        rent_lamports,
    )?;
    let config = &mut ctx.accounts.config;
    if config.bond_lp_mint == Pubkey::default() {
        config.bond_lp_mint = lp_mint_key;
    }
    config.bond_premium_bps = premium_bps;
    emit!(BondConfigSet {
        premium_bps,
        lp_mint: lp_mint_key,
    });
    Ok(())
}

// ------------------------------------------------- set_bond_xtomb_premium

#[derive(Accounts)]
pub struct SetBondXtombPremium<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// Admin: set the premium credited on xTOMB bond pay-ins, bps of
/// pay-in value (0 = the compiled default of 300 = 3%). Kept
/// separate from bond_premium_bps: xTOMB pay-ins burn like a
/// classic bond, so their premium is ruled separately (Jess
/// 2026-11-08) from the native-token / USDC premium.
pub fn set_bond_xtomb_premium(
    ctx: Context<SetBondXtombPremium>,
    premium_bps: u16,
) -> Result<()> {
    require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
    require!(premium_bps <= 10_000, XtombError::BadBondConfig);
    let config = &mut ctx.accounts.config;
    config.bond_xtomb_premium_bps = premium_bps;
    emit!(BondXtombPremiumSet { premium_bps });
    Ok(())
}

// ------------------------------------------------------------ set_sol_price

#[derive(Accounts)]
pub struct SetSolPrice<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// Oracle authority (or admin): post the SOL price used to value
/// wrapped-SOL bond pay-ins. price_e6 is USD per whole SOL in e6
/// (e.g. $150 = 150_000_000); ts is the observation time — SOL
/// pay-ins fail closed once the post goes stale (30 min, same
/// window as the TWAP).
pub fn set_sol_price(ctx: Context<SetSolPrice>, price_e6: u64, ts: i64) -> Result<()> {
    let caller = ctx.accounts.caller.key();
    let config = &mut ctx.accounts.config;
    require!(
        caller == config.oracle_authority || caller == config.admin,
        XtombError::NotOracle
    );
    config.sol_price_e6 = price_e6;
    config.sol_price_ts = ts;
    emit!(SolPriceSet { price_e6, ts });
    Ok(())
}

// -------------------------------------------------------------- buy_bond

#[derive(Accounts)]
#[instruction(payin_amount: u64)]
pub struct BuyBond<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// Mutable: an xTOMB pay-in burns against this mint.
    #[account(mut)]
    pub payin_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub buyer_payin: Box<Account<'info, TokenAccount>>,
    /// CHECK: per-mint bond pay-in vault PDA ["bond-payin", mint],
    /// created (or validated) manually in the instruction.
    #[account(mut)]
    pub payin_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer_xbond: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub xbond_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Buy xBOND, only when fresh TWAP < $1.00 (LP-zap model, Jess
/// 2026-11-08). Accepted pay-ins — only assets the program can
/// price on-chain: USDC (config usdc_mint, $1), wrapped SOL
/// (oracle-posted SOL price), and xTOMB (TWAP). Face credited =
/// pay-in USD value / TWAP plus a premium: the bond premium
/// (default +10%) on USDC and SOL pay-ins, the xTOMB premium
/// (default +3%) on xTOMB pay-ins. USDC and SOL pay-ins go
/// ENTIRELY into the per-mint bond pay-in vault as custody for
/// the operator's LP-creation leg (the protocol buys xTOMB with
/// them and pairs the LP). xTOMB pay-ins are the exception: the
/// paid xTOMB BURNS like a classic bond — contraction, with
/// circulating-supply bookkeeping to match — and never enters
/// custody. The xBOND face is xTOMB-denominated and redeems
/// into xTOMB LP paid from the backing vault.
pub fn buy_bond(ctx: Context<BuyBond>, payin_amount: u64) -> Result<()> {
    let now = clock_now()?;
    let buyer_key = ctx.accounts.buyer.key();
    require_not_maintenance(&ctx.accounts.config)?;
    require!(payin_amount > 0, XtombError::ZeroAmount);
    let config = &ctx.accounts.config;
    require_fresh_oracle(config, now)?;
    let twap = config.oracle_twap_e6;
    require!(twap < REFERENCE_E6, XtombError::BondBuyClosed);

    let payin_mint_key = ctx.accounts.payin_mint.key();
    let is_usdc = payin_mint_key == config.usdc_mint;
    let is_wsol = payin_mint_key == native_sol_mint();
    let is_xtomb = payin_mint_key == config.xtomb_mint;
    require!(
        is_usdc || is_wsol || is_xtomb,
        XtombError::BondPayinRejected
    );
    require!(
        ctx.accounts.payin_mint.decimals == if is_wsol { 9 } else { 6 },
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.buyer_payin.mint == payin_mint_key
            && ctx.accounts.buyer_payin.owner == buyer_key
            && ctx.accounts.buyer_payin.amount >= payin_amount,
        XtombError::InsufficientBalance
    );
    require!(
        ctx.accounts.buyer_xbond.mint == config.xbond_mint
            && ctx.accounts.buyer_xbond.owner == buyer_key,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.xbond_mint.key() == config.xbond_mint,
        XtombError::BadTokenAccount
    );

    // USD value of the pay-in, e6 (USDC is 6dp, so amount == e6).
    let usd_value_e6: u64 = if is_usdc {
        payin_amount
    } else if is_wsol {
        require!(config.sol_price_e6 > 0, XtombError::BondSolPriceMissing);
        require!(
            oracle_is_fresh(config.sol_price_ts, now),
            XtombError::OracleStale
        );
        (payin_amount as u128 * config.sol_price_e6 as u128 / 1_000_000_000u128)
            as u64
    } else {
        (payin_amount as u128 * twap as u128 / REFERENCE_E6 as u128) as u64
    };
    // Every accepted pay-in earns a premium: USDC / wrapped SOL
    // at bond_premium_bps (default 10%), xTOMB at
    // bond_xtomb_premium_bps (default 3%).
    let premium_bps = if is_xtomb {
        bond_xtomb_premium_bps_resolved(config)
    } else {
        bond_premium_bps_resolved(config)
    };
    let premium_applies = true;
    let face = bond_face_credited(usd_value_e6, twap, premium_bps, premium_applies);
    require!(face > 0, XtombError::ZeroAmount);
    require!(
        config
            .bond_outstanding
            .checked_add(face)
            .ok_or(XtombError::Overflow)?
            <= config.bond_max_outstanding,
        XtombError::BondMaxOutstanding
    );

    if is_xtomb {
        // Classic-bond branch (Jess 2026-11-08): the paid xTOMB is
        // BURNED, not custodied — contraction — and the circulating
        // bookkeeping below follows the burn. (The buyer is the
        // authority on their own account.)
        token_burn(
            ctx.accounts.payin_mint.to_account_info(),
            ctx.accounts.buyer_payin.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            payin_amount,
        )?;
    } else {
        // Custody the pay-in in the per-mint bond pay-in vault
        // (created on first use; the buyer funds its rent).
        let rent_lamports = Rent::get()?.minimum_balance(TokenAccount::LEN);
        let mint_seed = payin_mint_key.as_ref();
        let vault_seeds: [&[u8]; 2] = [b"bond-payin", mint_seed];
        ensure_pda_token_vault(
            &ctx.accounts.payin_vault.to_account_info(),
            &vault_seeds,
            &ctx.accounts.payin_mint.to_account_info(),
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            rent_lamports,
        )?;
        token_transfer(
            ctx.accounts.buyer_payin.to_account_info(),
            ctx.accounts.payin_vault.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            payin_amount,
        )?;
    }
    // Mint the xBOND face (mint authority is the config PDA).
    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    token_mint_signed(
        ctx.accounts.xbond_mint.to_account_info(),
        ctx.accounts.buyer_xbond.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        face,
        seeds,
    )?;
    let config = &mut ctx.accounts.config;
    config.bond_outstanding = config
        .bond_outstanding
        .checked_add(face)
        .ok_or(XtombError::Overflow)?;
    if is_xtomb {
        // The xTOMB pay-in burned above: circulating supply falls
        // by the burned amount (classic-bond bookkeeping).
        config.circulating_xtomb = config.circulating_xtomb.saturating_sub(payin_amount);
    }

    emit!(BondBought {
        owner: buyer_key,
        payin_mint: payin_mint_key,
        payin_amount,
        usd_value_e6,
        premium_applied: premium_applies,
        xbond_face: face,
        twap_e6: twap,
    });
    Ok(())
}

// ------------------------------------------------------------ redeem_bond

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct RedeemBond<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = user,
        space = BondPosition::SPACE,
        seeds = [b"bond", user.key().as_ref()],
        bump
    )]
    pub bond_position: Box<Account<'info, BondPosition>>,
    #[account(mut)]
    pub user_xbond: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_lp: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub xbond_mint: Box<Account<'info, Mint>>,
    /// CHECK: bond backing vault PDA ["bond-lp-vault"], created by
    /// set_bond_config; validated manually in the instruction (it may
    /// legitimately not exist yet, in which case redemptions queue).
    #[account(mut)]
    pub bond_lp_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Redeem xBOND, only when fresh TWAP > $1.00: burn the face and
/// pay out xTOMB LP from the bond backing vault, pro-rata by face
/// against the backing actually held (the last outstanding face
/// drains the backing exactly). If the entitlement is 0 — no LP
/// registered yet, or the operator leg has not deposited backing —
/// the whole amount queues on the BondPosition (no partial fill,
/// no IOU token, the xBOND stays in the user's wallet) and a later
/// call settles the queue first. Passing amount 0 settles the
/// queue only. The expansion allowance plays no part in bonds
/// under this model; no xTOMB is minted or burned here.
pub fn redeem_bond(ctx: Context<RedeemBond>, amount: u64) -> Result<()> {
    let now = clock_now()?;
    let user_key = ctx.accounts.user.key();
    require_not_maintenance(&ctx.accounts.config)?;
    let config = &mut ctx.accounts.config;
    require_fresh_oracle(config, now)?;
    require!(
        config.oracle_twap_e6 > REFERENCE_E6,
        XtombError::BondRedeemClosed
    );
    require!(
        ctx.accounts.user_xbond.mint == config.xbond_mint
            && ctx.accounts.user_xbond.owner == user_key,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.xbond_mint.key() == config.xbond_mint,
        XtombError::BadTokenAccount
    );

    let bond_position = &mut ctx.accounts.bond_position;
    if bond_position.owner == Pubkey::default() {
        bond_position.owner = user_key;
        bond_position.xbond = 0;
        bond_position.queued_redeem = 0;
        bond_position.bump = ctx.bumps.bond_position;
    }

    // Backing actually available: the operator-deposited counter,
    // capped by the vault's real balance. Zero until the LP mint is
    // registered AND the operator leg has deposited LP.
    let mut backing: u64 = 0;
    if config.bond_lp_mint != Pubkey::default() {
        let vault_balance = require_pda_token_vault(
            &ctx.accounts.bond_lp_vault.to_account_info(),
            &[b"bond-lp-vault"],
            &config.bond_lp_mint,
            &config.key(),
        )?;
        backing = config.bond_backing_lp.min(vault_balance);
    }

    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    let mut face_redeemed: u64 = 0;
    let mut lp_paid: u64 = 0;

    // Settle any queued redemption first.
    let queued = bond_position.queued_redeem;
    if queued > 0 {
        let entitlement =
            bond_lp_entitlement(queued, backing, config.bond_outstanding);
        if entitlement > 0 {
            require!(
                ctx.accounts.user_lp.mint == config.bond_lp_mint
                    && ctx.accounts.user_lp.owner == user_key,
                XtombError::BadTokenAccount
            );
            require!(
                ctx.accounts.user_xbond.amount >= queued,
                XtombError::InsufficientBalance
            );
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.xbond_mint.to_account_info(),
                        from: ctx.accounts.user_xbond.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                queued,
            )?;
            token_transfer_signed(
                ctx.accounts.bond_lp_vault.to_account_info(),
                ctx.accounts.user_lp.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                entitlement,
                seeds,
            )?;
            config.bond_outstanding =
                config.bond_outstanding.saturating_sub(queued);
            config.bond_backing_lp =
                config.bond_backing_lp.saturating_sub(entitlement);
            backing -= entitlement;
            bond_position.queued_redeem = 0;
            face_redeemed += queued;
            lp_paid += entitlement;
        }
    }

    if amount > 0 {
        let entitlement =
            bond_lp_entitlement(amount, backing, config.bond_outstanding);
        if entitlement > 0 {
            require!(
                ctx.accounts.user_lp.mint == config.bond_lp_mint
                    && ctx.accounts.user_lp.owner == user_key,
                XtombError::BadTokenAccount
            );
            require!(
                ctx.accounts.user_xbond.amount >= face_redeemed + amount,
                XtombError::InsufficientBalance
            );
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.xbond_mint.to_account_info(),
                        from: ctx.accounts.user_xbond.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount,
            )?;
            token_transfer_signed(
                ctx.accounts.bond_lp_vault.to_account_info(),
                ctx.accounts.user_lp.to_account_info(),
                config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                entitlement,
                seeds,
            )?;
            config.bond_outstanding =
                config.bond_outstanding.saturating_sub(amount);
            config.bond_backing_lp =
                config.bond_backing_lp.saturating_sub(entitlement);
            face_redeemed += amount;
            lp_paid += entitlement;
        } else {
            // Queue the whole amount; no partial fill.
            bond_position.queued_redeem = bond_position
                .queued_redeem
                .checked_add(amount)
                .ok_or(XtombError::Overflow)?;
        }
    }

    emit!(BondRedeemed {
        owner: user_key,
        xbond_amount: face_redeemed,
        lp_received: lp_paid,
        queued: bond_position.queued_redeem,
    });
    Ok(())
}

// ----------------------------------------------------- withdraw_bond_payin

#[derive(Accounts)]
pub struct WithdrawBondPayin<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub payin_mint: Box<Account<'info, Mint>>,
    /// CHECK: per-mint bond pay-in vault PDA ["bond-payin", mint];
    /// validated manually in the instruction.
    #[account(mut)]
    pub payin_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub caller_payin: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Operator leg of the bond zap (bot wallet or admin): withdraw
/// custodied bond pay-ins from a pay-in vault. This is where the
/// off-chain market leg starts — the operator spends the withdrawn
/// stable/native to BUY xTOMB on the market (peg support; the
/// protocol never sells its own tokens), pairs it with the xTOMB
/// side of the pay-in, and deposits the resulting LP back via
/// deposit_bond_backing. Until an AMM exists on-chain this step is
/// operator-executed by design (see spec §7).
pub fn withdraw_bond_payin(
    ctx: Context<WithdrawBondPayin>,
    amount: u64,
) -> Result<()> {
    require_not_maintenance(&ctx.accounts.config)?;
    require!(amount > 0, XtombError::ZeroAmount);
    let config = &ctx.accounts.config;
    let caller_key = ctx.accounts.caller.key();
    require!(
        caller_key == config.bot_wallet || caller_key == config.admin,
        XtombError::NotBot
    );
    let payin_mint_key = ctx.accounts.payin_mint.key();
    require!(
        payin_mint_key == config.usdc_mint
            || payin_mint_key == native_sol_mint()
            || payin_mint_key == config.xtomb_mint,
        XtombError::BondPayinRejected
    );
    let mint_seed = payin_mint_key.as_ref();
    let vault_seeds: [&[u8]; 2] = [b"bond-payin", mint_seed];
    let vault_balance = require_pda_token_vault(
        &ctx.accounts.payin_vault.to_account_info(),
        &vault_seeds,
        &payin_mint_key,
        &config.key(),
    )?;
    require!(amount <= vault_balance, XtombError::InsufficientBalance);
    require!(
        ctx.accounts.caller_payin.mint == payin_mint_key
            && ctx.accounts.caller_payin.owner == caller_key,
        XtombError::BadTokenAccount
    );
    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    token_transfer_signed(
        ctx.accounts.payin_vault.to_account_info(),
        ctx.accounts.caller_payin.to_account_info(),
        config.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount,
        seeds,
    )?;
    emit!(BondPayinWithdrawn {
        caller: caller_key,
        payin_mint: payin_mint_key,
        amount,
    });
    Ok(())
}

// ---------------------------------------------------- deposit_bond_backing

#[derive(Accounts)]
pub struct DepositBondBacking<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub caller_lp: Box<Account<'info, TokenAccount>>,
    /// CHECK: bond backing vault PDA ["bond-lp-vault"], created by
    /// set_bond_config; validated manually in the instruction.
    #[account(mut)]
    pub bond_lp_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Operator leg, return half (bot wallet or admin): deposit xTOMB
/// LP created from custodied bond pay-ins into the bond backing
/// vault and register it in the backing counter that redemption
/// entitlements are computed against. LP deposited any other way
/// (a raw transfer into the vault) does not raise the counter and
/// is not redeemable against — deposits must come through here.
pub fn deposit_bond_backing(
    ctx: Context<DepositBondBacking>,
    amount: u64,
) -> Result<()> {
    require_not_maintenance(&ctx.accounts.config)?;
    require!(amount > 0, XtombError::ZeroAmount);
    let config = &mut ctx.accounts.config;
    let caller_key = ctx.accounts.caller.key();
    require!(
        caller_key == config.bot_wallet || caller_key == config.admin,
        XtombError::NotBot
    );
    require!(
        config.bond_lp_mint != Pubkey::default(),
        XtombError::BondLpMintNotSet
    );
    require!(
        ctx.accounts.caller_lp.mint == config.bond_lp_mint
            && ctx.accounts.caller_lp.owner == caller_key
            && ctx.accounts.caller_lp.amount >= amount,
        XtombError::InsufficientBalance
    );
    require_pda_token_vault(
        &ctx.accounts.bond_lp_vault.to_account_info(),
        &[b"bond-lp-vault"],
        &config.bond_lp_mint,
        &config.key(),
    )?;
    token_transfer(
        ctx.accounts.caller_lp.to_account_info(),
        ctx.accounts.bond_lp_vault.to_account_info(),
        ctx.accounts.caller.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount,
    )?;
    config.bond_backing_lp = config
        .bond_backing_lp
        .checked_add(amount)
        .ok_or(XtombError::Overflow)?;
    let backing_total = config.bond_backing_lp;
    emit!(BondBackingDeposited {
        caller: caller_key,
        amount,
        backing_total,
    });
    Ok(())
}

// ----------------------------------------------------------- advance_epoch

/// Max epochs settled in one call (compute budget). Unprocessed due
/// epochs are skipped permanently: no catch-up issuance.
pub const MAX_EPOCHS_PER_CALL: u64 = 52;

#[derive(Accounts)]
#[instruction(trigger_epoch0: bool)]
pub struct AdvanceEpoch<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"pool", &POOL_ID_MASONRY.to_le_bytes()],
        bump = masonry_pool.bump
    )]
    pub masonry_pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub xtomb_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub masonry_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Lazy, permissionless epoch settlement. Epoch 0 opens only on a manual
/// admin trigger (`trigger_epoch0 = true`, caller must be admin). Each
/// due epoch: bootstrap (first 2 epochs, 3% of circulating, only above
/// $0.90) or expansion (fresh TWAP strictly above $1.01, capped 2%).
/// Each epoch's mint splits 50/50 between Masonry stakers (minted to
/// the Masonry vault and credited to the pool accumulator) and the
/// expansion allowance (bond redemption budget). Critical Defense
/// enters at fresh TWAP <= $0.90 and exits after 2 consecutive 6h
/// checkpoints > $1.01. Stale oracle data settles time only: no mint,
/// no checkpoints.
pub fn advance_epoch(ctx: Context<AdvanceEpoch>, trigger_epoch0: bool) -> Result<()> {
    let now = clock_now()?;
    let config = &mut ctx.accounts.config;

    if !config.epoch0_open {
        require!(trigger_epoch0, XtombError::Epoch0NotTriggered);
        require_admin(config, &ctx.accounts.caller.key())?;
        config.epoch0_open = true;
        config.last_epoch_ts = now;
        config.current_epoch = 0;
        emit!(EpochSettled {
            epochs_processed: 0,
            current_epoch: 0,
            minted_to_masonry: 0,
            added_to_allowance: 0,
            critical_defense: false,
        });
        return Ok(());
    }

    let due = epochs_due(config.last_epoch_ts, now);
    require!(due > 0, XtombError::EpochNotDue);
    require!(
        ctx.accounts.xtomb_mint.key() == config.xtomb_mint,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.masonry_vault.mint == config.xtomb_mint
            && ctx.accounts.masonry_vault.owner == config.key(),
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.masonry_pool.pool_id == POOL_ID_MASONRY
            && ctx.accounts.masonry_pool.kind == POOL_KIND_MASONRY,
        XtombError::WrongPoolKind
    );

    let fresh = oracle_is_fresh(config.oracle_ts, now);
    let process = due.min(MAX_EPOCHS_PER_CALL);
    let mut minted_to_masonry: u64 = 0;
    let mut added_to_allowance: u64 = 0;

    let bump = config.bump;
    let seeds: &[&[u8]] = &[b"config", &[bump]];
    for _ in 0..process {
        let idx = config.current_epoch;
        let twap = config.oracle_twap_e6;
        let mint = if !fresh {
            0
        } else if idx < 2 {
            bootstrap_mint(config.circulating_xtomb, twap)
        } else {
            expansion_mint(config.circulating_xtomb, twap)
        };
        if mint > 0 {
            let masonry_share = mint / 2;
            let allowance_share = mint - masonry_share;
            if ctx.accounts.masonry_pool.total_staked > 0 {
                token_mint_signed(
                    ctx.accounts.xtomb_mint.to_account_info(),
                    ctx.accounts.masonry_vault.to_account_info(),
                    config.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    masonry_share,
                    seeds,
                )?;
                let pool = &mut ctx.accounts.masonry_pool;
                pool.acc_per_share = pool.acc_per_share.checked_add(
                    masonry_share as u128 * ACC_SCALE
                        / pool.total_staked as u128,
                ).ok_or(XtombError::Overflow)?;
                config.circulating_xtomb = config
                    .circulating_xtomb
                    .checked_add(masonry_share)
                    .ok_or(XtombError::Overflow)?;
                minted_to_masonry += masonry_share;
                config.expansion_allowance = config
                    .expansion_allowance
                    .checked_add(allowance_share)
                    .ok_or(XtombError::Overflow)?;
                added_to_allowance += allowance_share;
            } else {
                // No Masonry stakers: the whole epoch mint goes to the
                // bond-redemption allowance instead of being lost.
                config.expansion_allowance = config
                    .expansion_allowance
                    .checked_add(mint)
                    .ok_or(XtombError::Overflow)?;
                added_to_allowance += mint;
            }
        }
        if fresh {
            if twap <= 900_000 {
                config.critical_defense = true;
                config.defense_above_checkpoints = 0;
            } else if twap > 1_010_000 {
                config.defense_above_checkpoints += 1;
                if config.defense_above_checkpoints >= 2 {
                    config.critical_defense = false;
                    config.defense_above_checkpoints = 0;
                }
            } else {
                config.defense_above_checkpoints = 0;
            }
        }
        config.current_epoch += 1;
    }

    // Advance the clock; unprocessed due epochs are skipped (no catch-up).
    let mut new_last = config.last_epoch_ts + (process as i64) * EPOCH_SECS;
    if due > process {
        let remainder = (now - new_last) % EPOCH_SECS;
        new_last = now - remainder;
    }
    config.last_epoch_ts = new_last;
    ctx.accounts.masonry_pool.last_update_ts = new_last;

    emit!(EpochSettled {
        epochs_processed: process,
        current_epoch: config.current_epoch,
        minted_to_masonry,
        added_to_allowance,
        critical_defense: config.critical_defense,
    });
    Ok(())
}

// -------------------------------------------------------- buyback_and_burn

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct BuybackAndBurn<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub caller_xtomb: Account<'info, TokenAccount>,
    #[account(mut)]
    pub xtomb_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

/// Guarded buyback-and-burn for the trading-bot (peg keeper) or admin:
/// burns xTOMB from the caller's own account. Guarded to fresh TWAP at
/// or below $1.01 (buybacks above peg are rejected).
pub fn buyback_and_burn(ctx: Context<BuybackAndBurn>, amount: u64) -> Result<()> {
    let now = clock_now()?;
    require_not_maintenance(&ctx.accounts.config)?;
    require!(amount > 0, XtombError::ZeroAmount);
    let config = &mut ctx.accounts.config;
    let caller_key = ctx.accounts.caller.key();
    require!(
        caller_key == config.bot_wallet || caller_key == config.admin,
        XtombError::NotBot
    );
    require_fresh_oracle(config, now)?;
    require!(
        config.oracle_twap_e6 <= 1_010_000,
        XtombError::BuybackGuard
    );
    require!(
        ctx.accounts.caller_xtomb.mint == config.xtomb_mint
            && ctx.accounts.caller_xtomb.owner == caller_key
            && ctx.accounts.caller_xtomb.amount >= amount,
        XtombError::BadTokenAccount
    );
    require!(
        ctx.accounts.xtomb_mint.key() == config.xtomb_mint,
        XtombError::BadTokenAccount
    );

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.xtomb_mint.to_account_info(),
                from: ctx.accounts.caller_xtomb.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        amount,
    )?;
    config.circulating_xtomb = config.circulating_xtomb.saturating_sub(amount);

    emit!(BuybackBurned {
        caller: caller_key,
        amount,
        twap_e6: config.oracle_twap_e6,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_with_acc(acc: u128) -> Pool {
        Pool {
            pool_id: 1,
            kind: POOL_KIND_STANDARD,
            asset_mint: Pubkey::default(),
            vault: Pubkey::default(),
            total_staked: 0,
            acc_per_share: acc,
            last_update_ts: 0,
            weight_bps: 0,
            active: true,
            bump: 0,
        }
    }

    fn position_with(amount: u64, reward_debt: u128) -> Position {
        Position {
            owner: Pubkey::default(),
            pool: Pubkey::default(),
            pool_kind: POOL_KIND_STANDARD,
            asset_mint: Pubkey::default(),
            amount,
            reward_debt,
            accrued_liquid: 0,
            accrued_vested: 0,
            vesting_total: 0,
            vesting_claimed_amount: 0,
            vesting_claimed_installments: 0,
            vesting_next_ts: 0,
            last_cooldown_ts: 0,
            genesis: true,
            bump: 0,
        }
    }

    #[test]
    fn pending_first_settle_from_zero_debt() {
        // Sole staker of 990,000,000; window-1 accumulator from the
        // bankrun regression scenario (minted 42,410,565 over the
        // window; the entitlement rounds 1 unit below the mint).
        let pool = pool_with_acc(42_838_954_545);
        let pos = position_with(990_000_000, 0);
        assert_eq!(pending_rewards(&pos, &pool), 42_410_564);
    }

    #[test]
    fn pending_repeat_settle_is_incremental_only() {
        // After the first settle the stored debt is the token
        // entitlement at that accumulator (42,410,564). The
        // accumulator then grows by a second window whose true
        // accrual for this position is exactly 169,642,260. The old
        // unit-mixed formula returned 212,010,838 here (it
        // subtracted the token-denominated debt from the per-share
        // accumulator).
        let acc1: u128 = 42_838_954_545;
        let debt_after_first =
            990_000_000u128 * acc1 / ACC_SCALE;
        assert_eq!(debt_after_first, 42_410_564);
        let pool = pool_with_acc(214_194_772_726);
        let pos = position_with(990_000_000, debt_after_first);
        assert_eq!(pending_rewards(&pos, &pool), 169_642_260);
    }

    #[test]
    fn pending_zero_when_debt_covers_accumulator() {
        let acc: u128 = 42_838_954_545;
        let pool = pool_with_acc(acc);
        let pos = position_with(990_000_000, 990_000_000u128 * acc / ACC_SCALE);
        assert_eq!(pending_rewards(&pos, &pool), 0);
        // Defensive: a debt above the entitlement saturates to 0
        // rather than underflowing.
        let pos = position_with(990_000_000, u128::MAX / 2);
        assert_eq!(pending_rewards(&pos, &pool), 0);
    }
}
