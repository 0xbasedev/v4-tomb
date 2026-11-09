//! Solana xTOMB fork — single Anchor program.
//!
//! Regular SPL tokens (no Token-2022), Metaplex Core soulbound pass NFTs,
//! Genesis with 7-day calendar, withdrawal Fire Tax, xBOND, lazy-epoch
//! Masonry with Critical Defense. See SOLANA-XTOMB-SPEC.md (governing
//! spec) and BUILD-NOTES.md (decisions where the spec was ambiguous).

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY");

#[program]
pub mod xtomb {
    use super::*;

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
        instructions::initialize_config(
            ctx,
            treasury_wallet,
            team_wallet,
            dev_wallet,
            bot_wallet,
            oracle_authority,
            usdc_mint,
            genesis_start_ts,
            genesis_reward_budget,
            bond_max_outstanding,
        )
    }

    pub fn create_mints(ctx: Context<CreateMints>) -> Result<()> {
        instructions::create_mints(ctx)
    }

    pub fn buy_pass(ctx: Context<BuyPass>, tier: u8) -> Result<()> {
        instructions::buy_pass(ctx, tier)
    }

    pub fn upgrade_pass(ctx: Context<UpgradePass>, new_tier: u8) -> Result<()> {
        instructions::upgrade_pass(ctx, new_tier)
    }

    pub fn stake(
        ctx: Context<Stake>,
        pool_id: u64,
        amount: u64,
        is_ultra_nft: bool,
    ) -> Result<()> {
        instructions::stake(ctx, pool_id, amount, is_ultra_nft)
    }

    pub fn unstake(ctx: Context<Unstake>, pool_id: u64, amount: u64) -> Result<()> {
        instructions::unstake(ctx, pool_id, amount)
    }

    pub fn claim(ctx: Context<Claim>, pool_id: u64) -> Result<()> {
        instructions::claim(ctx, pool_id)
    }

    pub fn compound(
        ctx: Context<Compound>,
        pool_id: u64,
        is_keeper: bool,
    ) -> Result<()> {
        instructions::compound(ctx, pool_id, is_keeper)
    }

    pub fn harvest(ctx: Context<Harvest>, pool_id: u64) -> Result<()> {
        instructions::harvest(ctx, pool_id)
    }

    pub fn add_pool(
        ctx: Context<AddPool>,
        pool_id: u64,
        kind: u8,
        asset_mint: Pubkey,
        weight_bps: u16,
    ) -> Result<()> {
        instructions::add_pool(ctx, pool_id, kind, asset_mint, weight_bps)
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
        instructions::set_fee_config(
            ctx,
            claim_fee_bps,
            keeper_fee_bps,
            lp_fee_bps,
            treasury_bps,
            team_bps,
            dev_bps,
            bot_bps,
        )
    }

    pub fn set_fire_tax_config(
        ctx: Context<AdminConfig>,
        base_xtomb_bps: u16,
        base_xshare_bps: u16,
        cap_bps: u16,
        rest_bps: u16,
        recovery_secs: i64,
    ) -> Result<()> {
        instructions::set_fire_tax_config(
            ctx,
            base_xtomb_bps,
            base_xshare_bps,
            cap_bps,
            rest_bps,
            recovery_secs,
        )
    }

    pub fn set_fire_tax_zeroed(
        ctx: Context<AdminConfig>,
        zeroed: bool,
    ) -> Result<()> {
        instructions::set_fire_tax_zeroed(ctx, zeroed)
    }

    pub fn set_pass_config(
        ctx: Context<AdminConfig>,
        price_genesis_usdc: u64,
        price_pro_usdc: u64,
        price_ultra_usdc: u64,
        deposit_fee_genesis_bps: u16,
        deposit_fee_pro_bps: u16,
        deposit_fee_ultra_bps: u16,
    ) -> Result<()> {
        instructions::set_pass_config(
            ctx,
            price_genesis_usdc,
            price_pro_usdc,
            price_ultra_usdc,
            deposit_fee_genesis_bps,
            deposit_fee_pro_bps,
            deposit_fee_ultra_bps,
        )
    }

    pub fn set_wallets(
        ctx: Context<AdminConfig>,
        treasury_wallet: Pubkey,
        team_wallet: Pubkey,
        dev_wallet: Pubkey,
        bot_wallet: Pubkey,
    ) -> Result<()> {
        instructions::set_wallets(ctx, treasury_wallet, team_wallet, dev_wallet, bot_wallet)
    }

    /// Create the weekly loyalty boost state (anchored at the farm
    /// start) and activate the Masonry staking-path boost hooks.
    pub fn initialize_boost(ctx: Context<InitializeBoost>) -> Result<()> {
        instructions::initialize_boost(ctx)
    }

    /// Set the weekly boost percent (0-25) and week length in days
    /// (1-30, locked at the farm start); percent changes settle
    /// accrual under the old percent first.
    pub fn set_boost_config(
        ctx: Context<SetBoostConfig>,
        percent: u16,
        week_length_days: u16,
    ) -> Result<()> {
        instructions::set_boost_config(ctx, percent, week_length_days)
    }

    /// Permissionless boost settle: slice farm emissions into
    /// weekly buckets and close ended weeks.
    pub fn settle_boost(ctx: Context<SettleBoost>) -> Result<()> {
        instructions::settle_boost(ctx)
    }

    /// Pull-claim settled weekly boost credit (xSHARE, no fee).
    pub fn claim_boost(ctx: Context<ClaimBoost>) -> Result<()> {
        instructions::claim_boost(ctx)
    }

    /// Read-only pending weekly boost for a user.
    pub fn pending_boost(ctx: Context<PendingBoost>) -> Result<u64> {
        instructions::pending_boost(ctx)
    }

    pub fn set_oracle(
        ctx: Context<SetOracle>,
        twap_e6: u64,
        ts: i64,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::set_oracle(ctx, twap_e6, ts, new_authority)
    }

    pub fn set_bond_config(
        ctx: Context<SetBondConfig>,
        premium_bps: u16,
    ) -> Result<()> {
        instructions::set_bond_config(ctx, premium_bps)
    }

    pub fn set_bond_xtomb_premium(
        ctx: Context<SetBondXtombPremium>,
        premium_bps: u16,
    ) -> Result<()> {
        instructions::set_bond_xtomb_premium(ctx, premium_bps)
    }

    pub fn set_sol_price(
        ctx: Context<SetSolPrice>,
        price_e6: u64,
        ts: i64,
    ) -> Result<()> {
        instructions::set_sol_price(ctx, price_e6, ts)
    }

    pub fn buy_bond(ctx: Context<BuyBond>, payin_amount: u64) -> Result<()> {
        instructions::buy_bond(ctx, payin_amount)
    }

    pub fn redeem_bond(ctx: Context<RedeemBond>, amount: u64) -> Result<()> {
        instructions::redeem_bond(ctx, amount)
    }

    pub fn withdraw_bond_payin(
        ctx: Context<WithdrawBondPayin>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_bond_payin(ctx, amount)
    }

    pub fn deposit_bond_backing(
        ctx: Context<DepositBondBacking>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_bond_backing(ctx, amount)
    }

    pub fn advance_epoch(
        ctx: Context<AdvanceEpoch>,
        trigger_epoch0: bool,
    ) -> Result<()> {
        instructions::advance_epoch(ctx, trigger_epoch0)
    }

    pub fn buyback_and_burn(
        ctx: Context<BuybackAndBurn>,
        amount: u64,
    ) -> Result<()> {
        instructions::buyback_and_burn(ctx, amount)
    }

    pub fn set_maintenance(
        ctx: Context<AdminConfig>,
        maintenance: bool,
    ) -> Result<()> {
        instructions::set_maintenance(ctx, maintenance)
    }
}
