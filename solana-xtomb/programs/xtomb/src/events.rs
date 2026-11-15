//! Program events. Every admin change and every economic action emits one.

use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub genesis_start_ts: i64,
    pub genesis_end_ts: i64,
    pub genesis_reward_budget: u64,
}

#[event]
pub struct MintsCreated {
    pub xtomb_mint: Pubkey,
    pub xshare_mint: Pubkey,
    pub xbond_mint: Pubkey,
}

#[event]
pub struct PassBought {
    pub owner: Pubkey,
    pub tier: u8,
    pub asset: Pubkey,
    pub price_usdc: u64,
}

#[event]
pub struct PassUpgraded {
    pub owner: Pubkey,
    pub from_tier: u8,
    pub to_tier: u8,
    pub paid_usdc: u64,
}

#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub pool_id: u64,
    pub amount: u64,
    pub fee: u64,
    pub credited: u64,
}

#[event]
pub struct Unstaked {
    pub owner: Pubkey,
    pub pool_id: u64,
    pub amount: u64,
    pub tax: u64,
    pub tax_rate_bps: u16,
    pub net: u64,
}

#[event]
pub struct Claimed {
    pub owner: Pubkey,
    pub pool_id: u64,
    pub liquid_net: u64,
    pub liquid_fee: u64,
    pub vesting_released: u64,
    pub vesting_fee: u64,
}

#[event]
pub struct Compounded {
    pub owner: Pubkey,
    pub pool_id: u64,
    pub liquid_compounded: u64,
    pub fire_tax: u64,
    pub keeper_fee: u64,
    pub lp_fee: u64,
    pub credited_lp: u64,
    pub keeper: bool,
}

#[event]
pub struct Harvested {
    pub owner: Pubkey,
    pub pool_id: u64,
    pub amount_net: u64,
    pub fee: u64,
}

#[event]
pub struct PoolAdded {
    pub pool_id: u64,
    pub kind: u8,
    pub asset_mint: Pubkey,
    pub weight_bps: u16,
}

#[event]
pub struct FeeConfigSet {
    pub claim_fee_bps: u16,
    pub keeper_fee_bps: u16,
    pub lp_fee_bps: u16,
    pub treasury_bps: u16,
    pub team_bps: u16,
    pub dev_bps: u16,
    pub bot_bps: u16,
}

#[event]
pub struct FireTaxConfigSet {
    pub base_xtomb_bps: u16,
    pub base_xshare_bps: u16,
    pub cap_bps: u16,
    pub rest_bps: u16,
    pub recovery_secs: i64,
}

#[event]
pub struct FireTaxZeroedSet {
    pub zeroed: bool,
}

#[event]
pub struct WalletsSet {
    pub treasury_wallet: Pubkey,
    pub team_wallet: Pubkey,
    pub dev_wallet: Pubkey,
    pub bot_wallet: Pubkey,
}

#[event]
pub struct OracleSet {
    pub twap_e6: u64,
    pub ts: i64,
    pub authority: Pubkey,
}

#[event]
pub struct BondBought {
    pub owner: Pubkey,
    pub payin_mint: Pubkey,
    pub payin_amount: u64,
    pub usd_value_e6: u64,
    pub premium_applied: bool,
    pub xbond_face: u64,
    pub twap_e6: u64,
}

#[event]
pub struct BondRedeemed {
    pub owner: Pubkey,
    pub xbond_amount: u64,
    pub lp_received: u64,
    pub queued: u64,
}

#[event]
pub struct BondConfigSet {
    pub premium_bps: u16,
    pub lp_mint: Pubkey,
}

#[event]
pub struct BondXtombPremiumSet {
    pub premium_bps: u16,
}

#[event]
pub struct SolPriceSet {
    pub price_e6: u64,
    pub ts: i64,
}

#[event]
pub struct BondPayinWithdrawn {
    pub caller: Pubkey,
    pub payin_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BondBackingDeposited {
    pub caller: Pubkey,
    pub amount: u64,
    pub backing_total: u64,
}

#[event]
pub struct EpochSettled {
    pub epochs_processed: u64,
    pub current_epoch: u64,
    pub minted_to_masonry: u64,
    pub added_to_allowance: u64,
    pub critical_defense: bool,
}

#[event]
pub struct BuybackBurned {
    pub caller: Pubkey,
    pub amount: u64,
    pub twap_e6: u64,
}

#[event]
pub struct MaintenanceSet {
    pub maintenance: bool,
}

#[event]
pub struct PassConfigSet {
    pub price_genesis_usdc: u64,
    pub price_pro_usdc: u64,
    pub price_ultra_usdc: u64,
    pub deposit_fee_genesis_bps: u16,
    pub deposit_fee_pro_bps: u16,
    pub deposit_fee_ultra_bps: u16,
}

#[event]
pub struct BoostInitialized {
    /// Farm start the loyalty weeks are anchored at.
    pub anchor_ts: i64,
}

#[event]
pub struct BoostConfigSet {
    pub percent: u16,
    pub week_length_days: u16,
}

#[event]
pub struct BoostWeekClosed {
    pub week: u64,
    pub eligible_total: u64,
    pub boost_amount: u64,
}

#[event]
pub struct BoostClaimed {
    pub owner: Pubkey,
    pub amount: u64,
}
