//! Program errors.

use anchor_lang::prelude::*;

#[error_code]
pub enum XtombError {
    #[msg("Caller is not the admin")]
    NotAdmin,
    #[msg("Caller is not the oracle authority or admin")]
    NotOracle,
    #[msg("Program is in maintenance mode")]
    Maintenance,
    #[msg("Invalid pass tier (must be 1 Genesis, 2 Pro, or 3 Ultra)")]
    InvalidTier,
    #[msg("Wallet already owns a pass (one per wallet)")]
    PassAlreadyOwned,
    #[msg("No pass found for this wallet")]
    NoPass,
    #[msg("Upgrade must move to a higher tier")]
    NotAnUpgrade,
    #[msg("Pass purchases and upgrades are closed (Genesis ended)")]
    PassSalesClosed,
    #[msg("Genesis has not started yet (Ultra pre-stake opens T-24h)")]
    GenesisNotStarted,
    #[msg("Genesis has ended; deposits and compounds are closed")]
    GenesisEnded,
    #[msg("LP staking opens on Day 2 (T+24h)")]
    LpNotOpen,
    #[msg("Pool is not active")]
    PoolInactive,
    #[msg("Pool kind does not match this operation")]
    WrongPoolKind,
    #[msg("Pool id does not match its canonical kind (1 standard, 2 LP, 3 ultra, 4 masonry, 10+ farm)")]
    WrongPoolId,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient staked balance")]
    InsufficientStake,
    #[msg("Insufficient token balance")]
    InsufficientBalance,
    #[msg("Compound or claim too soon: the 3h per-user-per-pool cap has not elapsed")]
    CompoundTooSoon,
    #[msg("Oracle data is stale (older than 30 min); withdrawals fail closed, buys stay available")]
    OracleStale,
    #[msg("TWAP is not below $1.00; xBOND buys are closed")]
    BondBuyClosed,
    #[msg("TWAP is not above $1.00; xBOND redemptions are closed")]
    BondRedeemClosed,
    #[msg("xBOND purchase would exceed the configured max outstanding")]
    BondMaxOutstanding,
    #[msg("Epoch 0 has not been triggered by the admin yet")]
    Epoch0NotTriggered,
    #[msg("No epoch is due yet")]
    EpochNotDue,
    #[msg("Mints have already been created")]
    MintsAlreadyCreated,
    #[msg("Operational fee split must sum to 10000 bps")]
    BadFeeSplit,
    #[msg("Rewards vault holds too little to pay this claim")]
    InsufficientRewards,
    #[msg("Ultra pass is already staked as an NFT position")]
    UltraAlreadyStaked,
    #[msg("Ultra NFT staking requires the Ultra pass")]
    RequiresUltraPass,
    #[msg("Keeper compounding requires a Pro or Ultra pass")]
    RequiresKeeperTier,
    #[msg("No liquid rewards to compound")]
    NothingToCompound,
    #[msg("Nothing accrued to claim")]
    NothingToClaim,
    #[msg("TWAP guard rejected the buyback (requires fresh TWAP at or below $1.01)")]
    BuybackGuard,
    #[msg("Caller is not the trading-bot wallet or admin")]
    NotBot,
    #[msg("Token account mint or owner does not match the config")]
    BadTokenAccount,
    #[msg("Vault account is not the expected program-derived address")]
    BadVaultPda,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid Fire Tax config (cap above the 12% ceiling, a baseline or resting rate above the cap, or a recovery window out of range)")]
    BadFireTaxConfig,
    #[msg("Bond pay-in asset is not accepted (pay with USDC, wrapped SOL, or xTOMB)")]
    BondPayinRejected,
    #[msg("No SOL price has been posted; SOL bond pay-ins are unavailable")]
    BondSolPriceMissing,
    #[msg("Bond LP mint is not registered yet (admin must call set_bond_config first)")]
    BondLpMintNotSet,
    #[msg("Invalid bond config (premium above 100%, or the LP mint is locked by existing backing)")]
    BadBondConfig,
    #[msg("Invalid pass config (a price of zero, or a deposit fee above 1000 bps)")]
    BadPassConfig,
    #[msg("Invalid boost config (percent above 25, or week length outside 1-30 days)")]
    BadBoostConfig,
    #[msg("Boost week length is locked once the farm has started")]
    BoostWeekLengthLocked,
    #[msg("Weekly boost is not initialized yet (admin must call initialize_boost)")]
    BoostNotInitialized,
    #[msg("Masonry stake/unstake must pass the weekly-boost accounts (boost-state, boost-user) once the boost is initialized")]
    BoostAccountsMissing,
}
