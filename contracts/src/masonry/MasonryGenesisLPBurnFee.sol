// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Interface for a genuinely fungible v4 LP vault: shares must be
/// redeemable pro-rata by ANY holder, not only the original NFT depositor.
/// @dev The legacy V4PositionWrapper in this repo does NOT implement this.
interface IMasonryRedeemableLPVault is IERC20 {
    function poolKey() external view returns (PoolKey memory);

    function redeem(
        uint256 shares,
        address recipient
    ) external returns (uint256 levelReceived, uint256 usdcReceived);
}

/// @dev Forward declaration — only needed for the vault interface above.
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @notice Kept for backward compatibility — staking reads level() from this contract.
interface IMasonryBurnableLevel is IERC20 {
    function burn(
        uint256 amount
    ) external;
}

/// @notice Genesis LEVEL/USDC LP deposit fee: collect exactly 50 bps of shares
/// and send them directly to the Treasury as protocol-owned liquidity (POL).
///
/// Replaces the former buy-and-burn model. No redemption, no LEVEL burning,
/// no USDC buyback. Fee shares stay as LP tokens in the Treasury.
///
/// IMPORTANT: This is a modular integration component. Production deployment
/// requires a redeemable v4 LP vault and a Genesis pool that credits net
/// (gross - fee) shares only.
contract MasonryGenesisLPBurnFee is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DEPOSIT_BURN_FEE_BPS = 50;
    uint256 public constant BPS = 10_000;

    IMasonryRedeemableLPVault public immutable lpVault;
    /// @notice Kept as a public getter — MasonryGenesisStaking reads it in its constructor.
    IMasonryBurnableLevel public immutable level;
    /// @notice Kept as a public getter — MasonryGenesisStaking reads it in its constructor.
    IERC20 public immutable usdc;
    address public immutable treasury;

    address public genesis;

    uint256 public totalFeeSharesCollected;
    uint256 public totalSharesSentToTreasury;

    error UnauthorizedGenesis();
    error InvalidConfiguration();
    error InvalidFeeReceipt();

    event GenesisUpdated(address indexed previousGenesis, address indexed newGenesis);
    event FeeSharesCollected(uint256 grossShares, uint256 feeShares);
    event FeeSharesSentToTreasury(uint256 feeShares, uint256 cumulativeSent);

    modifier onlyGenesis() {
        if (msg.sender != genesis) revert UnauthorizedGenesis();
        _;
    }

    constructor(
        IMasonryRedeemableLPVault lpVault_,
        IMasonryBurnableLevel level_,
        IERC20 usdc_,
        address treasury_,
        address genesis_
    ) {
        if (
            address(lpVault_).code.length == 0 || address(level_).code.length == 0 || address(usdc_).code.length == 0
                || treasury_ == address(0) || genesis_ == address(0)
        ) revert InvalidConfiguration();

        lpVault = lpVault_;
        level = level_;
        usdc = usdc_;
        treasury = treasury_;
        genesis = genesis_;
    }

    /// @notice One-time genesis wiring by the deployer. After this the deployer
    /// has no further administrative control.
    function setGenesis(
        address newGenesis
    ) external {
        // Only callable before genesis is a contract (i.e. during deploy setup)
        // or by the current genesis for migration.
        if (msg.sender != genesis) revert UnauthorizedGenesis();
        if (newGenesis == address(0) || newGenesis.code.length == 0) revert InvalidConfiguration();
        emit GenesisUpdated(genesis, newGenesis);
        genesis = newGenesis;
    }

    /// @notice Called by the Genesis LP staking pool AFTER it receives the gross
    /// shares and BEFORE it credits net shares to a depositor/auto-compounder.
    /// Genesis MUST approve this module to transfer the fee from its balance.
    function collectAndProcess(
        uint256 grossShares
    ) external onlyGenesis nonReentrant returns (uint256 feeShares) {
        if (grossShares == 0) revert InvalidConfiguration();
        feeShares = grossShares * DEPOSIT_BURN_FEE_BPS / BPS;
        if (feeShares > 0) {
            uint256 beforeBalance = lpVault.balanceOf(address(this));
            IERC20(address(lpVault)).safeTransferFrom(msg.sender, address(this), feeShares);
            if (lpVault.balanceOf(address(this)) - beforeBalance != feeShares) revert InvalidFeeReceipt();

            totalFeeSharesCollected += feeShares;

            IERC20(address(lpVault)).safeTransfer(treasury, feeShares);
            totalSharesSentToTreasury += feeShares;
            emit FeeSharesSentToTreasury(feeShares, totalSharesSentToTreasury);
        }
        emit FeeSharesCollected(grossShares, feeShares);
    }

    // ---- Removed in POL rework ----
    // The following have been removed as part of the burn → POL transition:
    // - pendingFeeShares, pendingBurnUSDC, totalLevelBurnedFromLPFees
    // - redeemPendingShares(), buyAndBurnPendingUSDC()
    // - router, guard, buybackPoolKey, usdcIsCurrency0
    // - maxFeeSharesPerCall, maxUsdcPerCall, setExecutionLimits()
    // - IMasonryExactInputV4Router, IMasonryBuybackExecutionGuard interfaces
    // - Ownable inheritance (setGenesis is now guarded by onlyGenesis)
    //
    // LP shares are sent directly to Treasury as protocol-owned liquidity.
}
