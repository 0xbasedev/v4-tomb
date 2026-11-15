//! Pure economic math for xTOMB. No Anchor / Solana types here on purpose:
//! every function is unit-testable on the host with `cargo test -p xtomb`.
//!
//! All prices are in USDC e6 (1_000_000 = $1.00). All rates are in basis
//! points (100 = 1%, 1200 = 12%) unless the name says otherwise.

/// $1.00 reference price, e6.
pub const REFERENCE_E6: u64 = 1_000_000;
/// 85% of reference: at or below this the Fire Tax is at its 12% cap.
pub const CAP_THRESHOLD_E6: u64 = 850_000;
/// Fire Tax baseline for the peg token (xTOMB) at/above reference: 3%.
/// (Was 1% for both tokens until Jess's 2026-11-08 re-ruling.)
pub const FIRE_TAX_BASE_XTOMB_BPS: u16 = 300;
/// Fire Tax baseline for the share token (xSHARE) at/above reference: 6%.
/// Same shared curve increment as xTOMB, so starting higher it reaches
/// the 12% cap sooner (~$0.89 vs ~$0.86).
pub const FIRE_TAX_BASE_XSHARE_BPS: u16 = 600;
/// Recovery floor resting rate for BOTH tokens: 3%. After the 7h
/// recovery window the floor settles here (it decayed to 1% before the
/// 2026-11-08 re-ruling).
pub const FIRE_TAX_REST_BPS: u16 = 300;
/// Fire Tax hard maximum: the protocol ceiling. The admin-configured
/// cap may be lower, never higher (the setter validates against this).
pub const FIRE_TAX_MAX_BPS: u16 = 1200;
/// Genesis minimum Fire Tax, xTOMB-denominated.
pub const FIRE_TAX_GENESIS_MIN_XTOMB_BPS: u16 = 300;
/// Genesis minimum Fire Tax, xSHARE-denominated.
pub const FIRE_TAX_GENESIS_MIN_XSHARE_BPS: u16 = 600;
/// Recovery floor decays toward baseline over this many seconds (7h).
pub const RECOVERY_DECAY_SECS: i64 = 7 * 3600;
/// Hard compound / shared claim+compound cooldown (3h).
pub const COMPOUND_CAP_SECS: i64 = 3 * 3600;
/// Epoch length (6h).
pub const EPOCH_SECS: i64 = 6 * 3600;
/// Genesis length (7 days).
pub const GENESIS_SECS: i64 = 7 * 24 * 3600;
/// Vesting installments per tranche.
pub const VESTING_INSTALLMENTS: u8 = 16;
/// Oracle freshness window (30 min).
pub const ORACLE_FRESH_SECS: i64 = 30 * 60;

/// Resolved Fire Tax parameters: the Config account's admin-set values
/// with the compiled defaults filled in (a stored 0 means "default" —
/// see `instructions::fire_tax_params`). Jess 2026-11-08: baselines,
/// cap, recovery window and resting rate are admin-configurable, and an
/// admin override (`zeroed`) can switch both taxes off while the
/// protocol is healthy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FireTaxParams {
    /// xTOMB baseline at/above peg (default 300 = 3%).
    pub base_xtomb_bps: u16,
    /// xSHARE baseline at/above peg (default 600 = 6%).
    pub base_xshare_bps: u16,
    /// Rate cap for both tokens (default 1200 = 12%, the hard ceiling).
    pub cap_bps: u16,
    /// Recovery floor resting rate for both tokens (default 300 = 3%).
    pub rest_bps: u16,
    /// Recovery floor decay window in seconds (default 7h).
    pub recovery_secs: i64,
    /// Healthy override: both withdrawal Fire Taxes are 0 while set.
    pub zeroed: bool,
}

impl FireTaxParams {
    pub const DEFAULT: Self = Self {
        base_xtomb_bps: FIRE_TAX_BASE_XTOMB_BPS,
        base_xshare_bps: FIRE_TAX_BASE_XSHARE_BPS,
        cap_bps: FIRE_TAX_MAX_BPS,
        rest_bps: FIRE_TAX_REST_BPS,
        recovery_secs: RECOVERY_DECAY_SECS,
        zeroed: false,
    };

    pub fn base_bps(&self, is_xshare: bool) -> u16 {
        if is_xshare {
            self.base_xshare_bps
        } else {
            self.base_xtomb_bps
        }
    }
}

/// The shared quadratic curve increment above a token's baseline:
/// 0 at or above the $1.00 reference, +1100 bps at or below 85% of
/// reference, quadratic between. Both tokens ride this same increment;
/// xSHARE reaches the cap sooner only because its baseline is higher.
pub fn fire_tax_curve_increment_bps(twap_e6: u64) -> u16 {
    if twap_e6 >= REFERENCE_E6 {
        return 0;
    }
    if twap_e6 <= CAP_THRESHOLD_E6 {
        return 1100;
    }
    // diff in (0, 150_000); f = diff / 150_000; increment = 1100 * f^2.
    let diff: u128 = (REFERENCE_E6 - twap_e6) as u128;
    let span: u128 = (REFERENCE_E6 - CAP_THRESHOLD_E6) as u128;
    (1100u128 * diff * diff / (span * span)) as u16
}

/// Fire Tax TWAP-target rate for one token: its baseline plus the
/// shared curve increment, clamped at the configured cap.
/// e.g. xTOMB (base 300): 3% at peg, 12% from ~$0.864 down.
/// e.g. xSHARE (base 600): 6% at peg, 12% from ~$0.889 down.
pub fn fire_tax_twap_rate_bps(twap_e6: u64, base_bps: u16, cap_bps: u16) -> u16 {
    let rate = base_bps as u32 + fire_tax_curve_increment_bps(twap_e6) as u32;
    rate.min(cap_bps as u32) as u16
}

/// Recovery floor after `elapsed_secs` seconds of linear decay toward
/// the resting rate (`rest_bps`, 3% for both tokens by default). At or
/// after the window the floor is the resting rate; a stored floor at or
/// below the resting rate resolves to the resting rate.
pub fn recovery_floor_decayed_bps(
    floor_bps: u16,
    elapsed_secs: i64,
    rest_bps: u16,
    recovery_secs: i64,
) -> u16 {
    if floor_bps <= rest_bps {
        return rest_bps;
    }
    if elapsed_secs >= recovery_secs {
        return rest_bps;
    }
    // Clamp against clock skew (negative elapsed = no decay yet).
    let remaining = (recovery_secs - elapsed_secs).min(recovery_secs).max(0);
    let excess = (floor_bps - rest_bps) as i64;
    (rest_bps as i64 + excess * remaining / recovery_secs) as u16
}

/// The single Fire Tax debit: highest of TWAP target / decayed recovery
/// floor / Genesis minimum, capped at the configured cap. Zero while
/// the admin healthy override is set.
pub fn fire_tax_rate_bps(
    twap_e6: u64,
    genesis_active: bool,
    is_xshare: bool,
    recovery_floor_bps: u16,
    recovery_floor_age_secs: i64,
    params: &FireTaxParams,
) -> u16 {
    if params.zeroed {
        return 0;
    }
    let mut rate = fire_tax_twap_rate_bps(
        twap_e6,
        params.base_bps(is_xshare),
        params.cap_bps,
    );
    let floor = recovery_floor_decayed_bps(
        recovery_floor_bps,
        recovery_floor_age_secs,
        params.rest_bps,
        params.recovery_secs,
    );
    if floor > rate {
        rate = floor;
    }
    if genesis_active {
        let min = if is_xshare {
            FIRE_TAX_GENESIS_MIN_XSHARE_BPS
        } else {
            FIRE_TAX_GENESIS_MIN_XTOMB_BPS
        };
        if min > rate {
            rate = min;
        }
    }
    rate.min(params.cap_bps)
}

/// Amount of the Fire Tax debit on `amount` at `rate_bps`.
pub fn fire_tax_amount(amount: u64, rate_bps: u16) -> u64 {
    (amount as u128 * rate_bps as u128 / 10_000u128) as u64
}

/// Hard compound cap: a compound (manual, keeper, Pro 6h, Ultra 3h alike)
/// is allowed only when at least 3h passed since the last claim/compound
/// on this user+pool. `last_ts == 0` means never acted: allowed.
pub fn compound_allowed(last_ts: i64, now: i64) -> bool {
    if last_ts == 0 {
        return true;
    }
    now - last_ts >= COMPOUND_CAP_SECS
}

/// Oracle freshness: an observation counts only within 30 minutes.
pub fn oracle_is_fresh(oracle_ts: i64, now: i64) -> bool {
    now >= oracle_ts && now - oracle_ts <= ORACLE_FRESH_SECS
}

/// Compiled defaults for the pass prices and Genesis-tier deposit
/// fees (Jess 2026-11-08: Genesis $50 / Pro $100 / Ultra $300;
/// deposit fees Genesis 2% / Pro 1% / Ultra 0%). The live values are
/// admin-configurable via `set_pass_config`; the Config account's
/// pass fields live in its spare capacity and a stored 0 means
/// "compiled default" (resolved by `instructions::pass_params`) —
/// the same convention as the fire-tax and bond fields. A stored 0
/// for the Ultra deposit fee is unambiguous: its default IS 0.
pub const PASS_PRICE_GENESIS_DEFAULT_USDC: u64 = 50;
pub const PASS_PRICE_PRO_DEFAULT_USDC: u64 = 100;
pub const PASS_PRICE_ULTRA_DEFAULT_USDC: u64 = 300;
pub const DEPOSIT_FEE_GENESIS_DEFAULT_BPS: u16 = 200;
pub const DEPOSIT_FEE_PRO_DEFAULT_BPS: u16 = 100;
pub const DEPOSIT_FEE_ULTRA_DEFAULT_BPS: u16 = 0;

/// Resolved pass pricing: per-tier pass prices in whole USDC and
/// per-tier standard-pool deposit fees in bps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PassParams {
    pub price_genesis_usdc: u64,
    pub price_pro_usdc: u64,
    pub price_ultra_usdc: u64,
    pub deposit_fee_genesis_bps: u16,
    pub deposit_fee_pro_bps: u16,
    pub deposit_fee_ultra_bps: u16,
}

impl PassParams {
    pub const DEFAULT: PassParams = PassParams {
        price_genesis_usdc: PASS_PRICE_GENESIS_DEFAULT_USDC,
        price_pro_usdc: PASS_PRICE_PRO_DEFAULT_USDC,
        price_ultra_usdc: PASS_PRICE_ULTRA_DEFAULT_USDC,
        deposit_fee_genesis_bps: DEPOSIT_FEE_GENESIS_DEFAULT_BPS,
        deposit_fee_pro_bps: DEPOSIT_FEE_PRO_DEFAULT_BPS,
        deposit_fee_ultra_bps: DEPOSIT_FEE_ULTRA_DEFAULT_BPS,
    };

    /// Pass price in whole USDC for a tier (0 for an invalid tier).
    pub fn price_usdc(&self, tier: u8) -> u64 {
        match tier {
            1 => self.price_genesis_usdc,
            2 => self.price_pro_usdc,
            3 => self.price_ultra_usdc,
            _ => 0,
        }
    }

    /// Genesis deposit fee (bps) for a pass tier; an unknown tier is
    /// charged as Genesis (the stake path's no-pass default).
    pub fn deposit_fee_bps(&self, tier: u8) -> u16 {
        match tier {
            1 => self.deposit_fee_genesis_bps,
            2 => self.deposit_fee_pro_bps,
            3 => self.deposit_fee_ultra_bps,
            _ => self.deposit_fee_genesis_bps,
        }
    }

    /// Upgrade cost in whole USDC: pay only the price difference, in
    /// place. Returns None for a non-upgrade (same tier or downgrade).
    pub fn upgrade_cost_usdc(&self, from_tier: u8, to_tier: u8) -> Option<u64> {
        let from = self.price_usdc(from_tier);
        let to = self.price_usdc(to_tier);
        if to > from {
            Some(to - from)
        } else {
            None
        }
    }
}

/// One vesting installment of a tranche. 16 installments of 6h; the last
/// takes the remainder so the tranche always fully vests. `claimed_amount`
/// is the base units already released from this tranche.
pub fn vesting_installment(
    total: u64,
    claimed_amount: u64,
    claimed_installments: u8,
) -> u64 {
    if claimed_installments >= VESTING_INSTALLMENTS {
        return 0;
    }
    let remaining_installments =
        (VESTING_INSTALLMENTS - claimed_installments) as u64;
    let remaining = total.saturating_sub(claimed_amount);
    if claimed_installments as u64 == VESTING_INSTALLMENTS as u64 - 1 {
        remaining
    } else {
        remaining / remaining_installments
    }
}

/// Bond premium for paying with the chain's native token (SOL) or
/// USDC, in bps of pay-in value (Jess 2026-11-08: 10%). Admin-
/// configurable via set_bond_config; this is the compiled default a
/// stored 0 resolves to.
pub const BOND_PREMIUM_DEFAULT_BPS: u16 = 1000;

/// Bond premium for paying with xTOMB itself, in bps of pay-in
/// value (Jess 2026-11-08: xTOMB deposits burn like a classic bond
/// and pay 3%). Admin-configurable via set_bond_xtomb_premium;
/// this is the compiled default a stored 0 resolves to.
pub const BOND_XTOMB_PREMIUM_DEFAULT_BPS: u16 = 300;

/// xBOND face credited for a bond buy (LP-zap model, Jess 2026-11-08):
/// the pay-in's USD value (e6) buys face at the current TWAP, and a
/// premium pay-in (native token or USDC) is credited
/// `premium_bps` extra. Face is xTOMB-denominated (6dp); redemption
/// pays it out as xTOMB LP from the backing vault.
///   face = usd_value_e6 x (10_000 + premium) x 1e6 / (10_000 x twap)
/// e.g. $1,000 at TWAP $0.90 with the 10% premium -> 1,222.22 face.
pub fn bond_face_credited(
    usd_value_e6: u64,
    twap_e6: u64,
    premium_bps: u16,
    premium_applies: bool,
) -> u64 {
    if twap_e6 == 0 {
        return 0;
    }
    let mult: u128 = if premium_applies {
        10_000 + premium_bps as u128
    } else {
        10_000
    };
    (usd_value_e6 as u128 * mult * REFERENCE_E6 as u128
        / (10_000u128 * twap_e6 as u128)) as u64
}

/// LP paid for redeeming `face` xBOND: the face's pro-rata share of
/// the LP backing actually held. Paying the last outstanding face
/// drains the backing exactly; with no backing (or no bonds
/// outstanding) the entitlement is 0 and the redemption queues.
pub fn bond_lp_entitlement(face: u64, backing_lp: u64, outstanding: u64) -> u64 {
    if outstanding == 0 || backing_lp == 0 || face == 0 {
        return 0;
    }
    (face as u128 * backing_lp as u128 / outstanding as u128) as u64
}

/// Genesis emission share (bps of the per-second budget) for a pool kind
/// at time `now` relative to Genesis start `t`.
/// kind 0 = standard, 1 = LP, 4 = Ultra-NFT pool.
/// Day 1: standard 95% (5% reserved to Ultra-NFT pool), LP 0%.
/// Day 2+: LP 71.25%, standard 23.75%, Ultra 5%.
/// Outside [T, T+7d]: 0.
pub fn genesis_pool_share_bps(kind: u8, now: i64, genesis_start: i64) -> u16 {
    if now < genesis_start || now >= genesis_start + GENESIS_SECS {
        return 0;
    }
    let day2 = now >= genesis_start + 24 * 3600;
    match kind {
        4 => 500,
        0 => {
            if day2 {
                2375
            } else {
                9500
            }
        }
        1 => {
            if day2 {
                7125
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Number of whole 6h epochs due between `last_epoch_ts` and `now`.
pub fn epochs_due(last_epoch_ts: i64, now: i64) -> u64 {
    if now <= last_epoch_ts {
        return 0;
    }
    ((now - last_epoch_ts) / EPOCH_SECS) as u64
}

/// Bootstrap eligibility: 3% per epoch only when TWAP strictly above $0.90.
pub fn bootstrap_mint(circulating_xtomb: u64, twap_e6: u64) -> u64 {
    if twap_e6 > 900_000 {
        (circulating_xtomb as u128 * 3 / 100) as u64
    } else {
        0
    }
}

/// Expansion eligibility: capped 2% per epoch only on a fresh TWAP
/// strictly above $1.01.
pub fn expansion_mint(circulating_xtomb: u64, twap_e6: u64) -> u64 {
    if twap_e6 > 1_010_000 {
        (circulating_xtomb as u128 * 2 / 100) as u64
    } else {
        0
    }
}

// ------------------------------------------------------- weekly boost
//
// The weekly loyalty boost (specs.md §8/§18, mirrored from the EVM
// ShareRewardPool build): a percent of farm emissions is carved out of
// the farm split into weekly buckets and paid pro-rata to Masonry
// stakers who held their stake for the whole prior week with zero LP
// withdrawals. These are the pure pieces; the state machine lives in
// instructions.rs next to the staking paths it hooks.

/// Farm emission window length: 365 days from Genesis end.
pub const FARM_SECS: i64 = 365 * 24 * 3600;

/// Compiled default for the weekly boost percent (Jess 2026-11-09:
/// baked in — the Config resolves to this until an admin sets a value).
pub const BOOST_DEFAULT_PERCENT: u16 = 5;

/// Compiled default loyalty week length, days.
pub const BOOST_WEEK_DEFAULT_DAYS: u16 = 7;

/// The boost's virtual weight against the farm pools' combined weight,
/// EVM formula verbatim: with combined pool weight W and percent p the
/// weight is W*p/(100-p), so emissions divide pools:boost as
/// (100-p):p exactly. Zero when the boost is off or no farm weight
/// exists.
pub fn boost_weight(total_weight_bps: u64, percent: u16) -> u64 {
    if percent == 0 || total_weight_bps == 0 {
        return 0;
    }
    (total_weight_bps as u128 * percent as u128 / (100 - percent) as u128)
        as u64
}

/// The boost's share of an emission amount at the given percent: the
/// slice of `generated` that lands in weekly buckets. Pools keep the
/// remainder (generated - slice) by construction of boost_weight.
pub fn boost_slice(
    generated: u64,
    total_weight_bps: u64,
    percent: u16,
) -> u64 {
    let bw = boost_weight(total_weight_bps, percent) as u128;
    if bw == 0 {
        return 0;
    }
    let denom = total_weight_bps as u128 + bw;
    (generated as u128 * bw / denom) as u64
}

/// Index of the loyalty week containing `t`, weeks anchored at
/// `anchor` (the farm start) so boundaries never drift.
pub fn boost_week_index(anchor: i64, week_secs: i64, t: i64) -> u64 {
    if t <= anchor || week_secs <= 0 {
        return 0;
    }
    ((t - anchor) / week_secs) as u64
}

/// Farm emission generated over [from, to], clamped to the farm
/// window [anchor, anchor + FARM_SECS).
pub fn farm_generated(
    emission_per_sec: u64,
    anchor: i64,
    from: i64,
    to: i64,
) -> u64 {
    let start = from.max(anchor);
    let end = to.min(anchor + FARM_SECS);
    if end <= start {
        return 0;
    }
    (emission_per_sec as u128 * (end - start) as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twap_rate_boundaries() {
        let cap = FIRE_TAX_MAX_BPS;
        // The shared increment: 0 at peg, +1100 at/below 85%, quadratic.
        assert_eq!(fire_tax_curve_increment_bps(1_000_000), 0);
        assert_eq!(fire_tax_curve_increment_bps(1_500_000), 0);
        assert_eq!(fire_tax_curve_increment_bps(925_000), 275);
        assert_eq!(fire_tax_curve_increment_bps(850_000), 1100);
        assert_eq!(fire_tax_curve_increment_bps(0), 1100);
        // Legacy 1% baseline: the increment shape is unchanged from the
        // pre-2026-11-08 absolute curve.
        assert_eq!(fire_tax_twap_rate_bps(1_000_000, 100, cap), 100);
        assert_eq!(fire_tax_twap_rate_bps(925_000, 100, cap), 375);
        assert_eq!(fire_tax_twap_rate_bps(850_001, 100, cap), 1199);
        // xTOMB (base 300): 3% at/above peg, 575 at the midpoint, cap 12%.
        assert_eq!(fire_tax_twap_rate_bps(1_000_000, 300, cap), 300);
        assert_eq!(fire_tax_twap_rate_bps(1_500_000, 300, cap), 300);
        assert_eq!(fire_tax_twap_rate_bps(925_000, 300, cap), 575);
        assert_eq!(fire_tax_twap_rate_bps(900_000, 300, cap), 788);
        assert_eq!(fire_tax_twap_rate_bps(850_000, 300, cap), 1200);
        assert_eq!(fire_tax_twap_rate_bps(0, 300, cap), 1200);
        // xSHARE (base 600): 6% at peg, and it caps sooner — still 1199
        // at $0.889218, already capped at $0.889.
        assert_eq!(fire_tax_twap_rate_bps(1_000_000, 600, cap), 600);
        assert_eq!(fire_tax_twap_rate_bps(925_000, 600, cap), 875);
        assert_eq!(fire_tax_twap_rate_bps(900_000, 600, cap), 1088);
        assert_eq!(fire_tax_twap_rate_bps(889_218, 600, cap), 1199);
        assert_eq!(fire_tax_twap_rate_bps(889_000, 600, cap), 1200);
    }

    #[test]
    fn one_debit_takes_highest() {
        let p = &FireTaxParams::DEFAULT;
        // At peg the baselines ARE the Genesis minima now (3% / 6%).
        assert_eq!(fire_tax_rate_bps(1_000_000, true, false, 300, 0, p), 300);
        assert_eq!(fire_tax_rate_bps(1_000_000, true, true, 300, 0, p), 600);
        // After Genesis the resting rates are unchanged: 3% / 6%.
        assert_eq!(fire_tax_rate_bps(1_000_000, false, false, 300, 0, p), 300);
        assert_eq!(fire_tax_rate_bps(1_000_000, false, true, 300, 0, p), 600);
        // A higher TWAP rate beats the Genesis minimum.
        // twap 0.90 -> increment 488; xTOMB 300 + 488 = 788.
        assert_eq!(fire_tax_rate_bps(900_000, true, false, 300, 0, p), 788);
        // Cap: nothing exceeds 12%.
        assert_eq!(fire_tax_rate_bps(0, true, true, 1200, 0, p), 1200);
        // Recovery floor beats TWAP rate when fresh.
        assert_eq!(fire_tax_rate_bps(1_000_000, false, false, 800, 0, p), 800);
        // ...but a fully decayed floor rests at 3%, not 1%.
        assert_eq!(
            fire_tax_rate_bps(1_000_000, false, false, 800, 7 * 3600, p),
            300
        );
        // Healthy override: both taxes are zero.
        let zeroed = FireTaxParams {
            zeroed: true,
            ..FireTaxParams::DEFAULT
        };
        assert_eq!(fire_tax_rate_bps(0, true, true, 1200, 0, &zeroed), 0);
        assert_eq!(fire_tax_rate_bps(1_000_000, false, false, 300, 0, &zeroed), 0);
    }

    #[test]
    fn recovery_floor_decays_linearly_over_7h() {
        let rest = FIRE_TAX_REST_BPS;
        let window = RECOVERY_DECAY_SECS;
        assert_eq!(recovery_floor_decayed_bps(800, 0, rest, window), 800);
        // Halfway (3.5h): 300 + 500/2 = 550.
        assert_eq!(
            recovery_floor_decayed_bps(800, 3 * 3600 + 1800, rest, window),
            550
        );
        // At/after the window the floor rests at 3% for both tokens.
        assert_eq!(recovery_floor_decayed_bps(800, 7 * 3600, rest, window), 300);
        assert_eq!(recovery_floor_decayed_bps(800, 99 * 3600, rest, window), 300);
        assert_eq!(recovery_floor_decayed_bps(300, 0, rest, window), 300);
        // A stored floor below the resting rate (e.g. 100, written by the
        // pre-upgrade binary) resolves to the resting rate.
        assert_eq!(recovery_floor_decayed_bps(100, 0, rest, window), 300);
    }

    #[test]
    fn compound_hard_cap() {
        assert!(compound_allowed(0, 1_000_000));
        // Exactly 3h later: allowed.
        assert!(compound_allowed(1_000_000, 1_000_000 + 3 * 3600));
        // One second early: reverts.
        assert!(!compound_allowed(1_000_000, 1_000_000 + 3 * 3600 - 1));
        // Keeper cadence does not bypass the cap: Pro 6h and Ultra 3h both
        // go through the same check.
        assert!(!compound_allowed(1_000_000, 1_000_000 + 2 * 3600));
    }

    #[test]
    fn pass_prices_and_upgrades() {
        let p = PassParams::DEFAULT;
        assert_eq!(p.price_usdc(1), 50);
        assert_eq!(p.price_usdc(2), 100);
        assert_eq!(p.price_usdc(3), 300);
        assert_eq!(p.upgrade_cost_usdc(1, 2), Some(50));
        assert_eq!(p.upgrade_cost_usdc(2, 3), Some(200));
        assert_eq!(p.upgrade_cost_usdc(1, 3), Some(250));
        assert_eq!(p.upgrade_cost_usdc(2, 2), None);
        assert_eq!(p.upgrade_cost_usdc(3, 1), None);
        assert_eq!(p.deposit_fee_bps(1), 200);
        assert_eq!(p.deposit_fee_bps(2), 100);
        assert_eq!(p.deposit_fee_bps(3), 0);
        // Unknown tier prices at 0 and is charged the Genesis fee.
        assert_eq!(p.price_usdc(9), 0);
        assert_eq!(p.deposit_fee_bps(9), 200);
    }

    #[test]
    fn pass_params_custom_values_flow_through() {
        // An admin-retuned table (set_pass_config) must drive prices,
        // upgrade deltas and deposit fees verbatim — nothing may fall
        // back to the compiled defaults once real values are stored.
        let p = PassParams {
            price_genesis_usdc: 60,
            price_pro_usdc: 120,
            price_ultra_usdc: 360,
            deposit_fee_genesis_bps: 300,
            deposit_fee_pro_bps: 150,
            deposit_fee_ultra_bps: 25,
        };
        assert_eq!(p.price_usdc(1), 60);
        assert_eq!(p.price_usdc(2), 120);
        assert_eq!(p.price_usdc(3), 360);
        assert_eq!(p.upgrade_cost_usdc(1, 2), Some(60));
        assert_eq!(p.upgrade_cost_usdc(2, 3), Some(240));
        assert_eq!(p.upgrade_cost_usdc(1, 3), Some(300));
        assert_eq!(p.deposit_fee_bps(1), 300);
        assert_eq!(p.deposit_fee_bps(2), 150);
        assert_eq!(p.deposit_fee_bps(3), 25);
    }

    #[test]
    fn vesting_splits_evenly_with_remainder_last() {
        // 16 installments of 100 base units each; last takes remainder.
        let mut claimed = 0u64;
        for i in 0..16 {
            let inst = vesting_installment(1600, claimed, i);
            assert_eq!(inst, 100);
            claimed += inst;
        }
        assert_eq!(claimed, 1600);
        // Odd total: installments of 62/63, last takes the remainder; the
        // tranche always pays out exactly its total.
        let mut paid = 0u64;
        for i in 0..16 {
            paid += vesting_installment(1000, paid, i);
        }
        assert_eq!(paid, 1000);
        assert_eq!(vesting_installment(1000, 937, 15), 63);
        assert_eq!(vesting_installment(1000, 1000, 16), 0);
    }

    #[test]
    fn bond_face_crediting() {
        // $1,000 at TWAP $0.90, 10% premium (USDC / SOL pay-in):
        // face = 1000 / 0.90 x 1.10 = 1,222.22 xBOND.
        assert_eq!(
            bond_face_credited(1_000_000_000, 900_000, 1000, true),
            1_222_222_222
        );
        // Same pay-in without the premium: 1,111.11 face.
        assert_eq!(
            bond_face_credited(1_000_000_000, 900_000, 1000, false),
            1_111_111_111
        );
        // With no premium applied, a TWAP-priced pay-in credits its
        // plain discounted face: $450 of value at $0.90 -> 500 face.
        assert_eq!(
            bond_face_credited(450_000_000, 900_000, 1000, false),
            500_000_000
        );
        // xTOMB pay-in at the xTOMB premium (300 bps, Jess
        // 2026-11-08): paying 1,000 xTOMB at $0.90 (USD value $900)
        // credits exactly 1,030 face.
        assert_eq!(
            bond_face_credited(900_000_000, 900_000, 300, true),
            1_030_000_000
        );
        // A zero premium field with a premium pay-in still credits the
        // plain discounted face (premium resolves before this call).
        assert_eq!(
            bond_face_credited(1_000_000_000, 900_000, 0, true),
            1_111_111_111
        );
        // Degenerate TWAP never credits.
        assert_eq!(bond_face_credited(1_000_000_000, 0, 1000, true), 0);
    }

    #[test]
    fn bond_lp_entitlements() {
        // Pro-rata: half the outstanding face takes half the backing.
        assert_eq!(bond_lp_entitlement(500, 2_000, 1_000), 1_000);
        // The last face drains the backing exactly.
        assert_eq!(bond_lp_entitlement(1_000, 2_000, 1_000), 2_000);
        // No backing (operator leg has not run) -> 0: redemption queues.
        assert_eq!(bond_lp_entitlement(500, 0, 1_000), 0);
        // Nothing outstanding -> 0 (no division by zero).
        assert_eq!(bond_lp_entitlement(500, 2_000, 0), 0);
    }

    #[test]
    fn genesis_pool_shares() {
        let t = 1_700_000_000i64;
        // Before start / after end: nothing.
        assert_eq!(genesis_pool_share_bps(0, t - 1, t), 0);
        assert_eq!(genesis_pool_share_bps(0, t + GENESIS_SECS, t), 0);
        // Day 1: standard 95%, LP 0%, Ultra 5%.
        assert_eq!(genesis_pool_share_bps(0, t + 3600, t), 9500);
        assert_eq!(genesis_pool_share_bps(1, t + 3600, t), 0);
        assert_eq!(genesis_pool_share_bps(4, t + 3600, t), 500);
        // Day 2+: LP 71.25%, standard 23.75%, Ultra 5%.
        assert_eq!(genesis_pool_share_bps(1, t + 25 * 3600, t), 7125);
        assert_eq!(genesis_pool_share_bps(0, t + 25 * 3600, t), 2375);
        assert_eq!(genesis_pool_share_bps(4, t + 25 * 3600, t), 500);
    }

    #[test]
    fn epoch_gating() {
        assert_eq!(epochs_due(1000, 1000 + EPOCH_SECS - 1), 0);
        assert_eq!(epochs_due(1000, 1000 + EPOCH_SECS), 1);
        assert_eq!(epochs_due(1000, 1000 + 3 * EPOCH_SECS + 5), 3);
        // Bootstrap: only above $0.90, 3% of circulating.
        assert_eq!(bootstrap_mint(100_000_000, 900_000), 0);
        assert_eq!(bootstrap_mint(100_000_000, 900_001), 3_000_000);
        // Expansion: only strictly above $1.01, 2% cap.
        assert_eq!(expansion_mint(100_000_000, 1_010_000), 0);
        assert_eq!(expansion_mint(100_000_000, 1_010_001), 2_000_000);
    }

    #[test]
    fn oracle_freshness() {
        let now = 2_000_000i64;
        assert!(oracle_is_fresh(now - 30 * 60, now));
        assert!(!oracle_is_fresh(now - 30 * 60 - 1, now));
        assert!(!oracle_is_fresh(now + 1, now)); // future timestamp: not fresh
    }

    #[test]
    fn boost_split_math() {
        // Weights 7500 + 2000 = 9500 at 5%: boost weight 500, so the
        // emission divides exactly 75 / 20 / 5.
        assert_eq!(boost_weight(9500, 5), 500);
        assert_eq!(boost_slice(10_000, 9500, 5), 500);
        // A single 100%-weight pool at 5%: the pool keeps ~95% (the
        // weight itself floors, exactly as the EVM integer math does).
        assert_eq!(boost_weight(10_000, 5), 526);
        assert_eq!(boost_slice(10_000, 10_000, 5), 499);
        // Off, or no farm weight: no carve-out.
        assert_eq!(boost_weight(9500, 0), 0);
        assert_eq!(boost_slice(10_000, 9500, 0), 0);
        assert_eq!(boost_slice(10_000, 0, 5), 0);
        // Max percent (25): a quarter of the stream, floored.
        assert_eq!(boost_slice(10_000, 9500, 25), 2_499);
    }

    #[test]
    fn boost_weeks_and_window() {
        let anchor = 1_000_000i64;
        let week = 7 * 24 * 3600i64;
        assert_eq!(boost_week_index(anchor, week, anchor - 5), 0);
        assert_eq!(boost_week_index(anchor, week, anchor), 0);
        assert_eq!(boost_week_index(anchor, week, anchor + week - 1), 0);
        assert_eq!(boost_week_index(anchor, week, anchor + week), 1);
        assert_eq!(boost_week_index(anchor, week, anchor + 52 * week), 52);
        // Generated emission clamps to the 365-day farm window.
        assert_eq!(farm_generated(813, anchor, anchor - 100, anchor), 0);
        assert_eq!(farm_generated(813, anchor, anchor, anchor + 100), 81_300);
        assert_eq!(
            farm_generated(813, anchor, anchor + FARM_SECS - 50, anchor + FARM_SECS + 500),
            813 * 50
        );
        assert_eq!(
            farm_generated(813, anchor, anchor, anchor + FARM_SECS + 500),
            813 * FARM_SECS as u64
        );
    }
}
