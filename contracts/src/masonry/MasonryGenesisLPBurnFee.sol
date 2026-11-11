// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

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

interface IMasonryBurnableLevel is IERC20 {
    function burn(
        uint256 amount
    ) external;
}

interface IMasonryExactInputV4Router {
    function swapExactIn(
        PoolKey calldata poolKey,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient
    ) external returns (uint256 amountOut);
}

/// @notice The guard MUST verify a fresh validated oracle, conservative
/// expected output, projected impact, pool liquidity and slippage; returning
/// a positive min output is the explicit authorization for a buyback.
/// Implementations MUST NOT rely only on the current manipulable spot tick.
/// @dev No longer used by the LP fee module (see below). Kept here because
/// MasonryBuybackGuard and Genesis settlement still implement/consume it.
interface IMasonryBuybackExecutionGuard {
    function officialPool() external view returns (PoolId);

    function minimumLevelOut(
        uint256 usdcAmount
    ) external returns (uint256);
}

/// @notice Genesis LEVEL/USDC LP deposit/auto-compound fee: collect exactly
/// 50 bps of the LP shares and forward them, untouched, to the Treasury as
/// protocol-owned liquidity (POL).
///
/// The module never redeems, swaps or burns. It holds no balance between
/// calls, so there is nothing to defer, retry or rescue: a collection either
/// lands the full fee in the Treasury or reverts the whole deposit.
///
/// The contract keeps its historical name (and the `DEPOSIT_BURN_FEE_BPS`
/// constant) so deployment keys, ABIs and the Genesis pool need no renaming;
/// nothing is burned any more.
contract MasonryGenesisLPBurnFee is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DEPOSIT_BURN_FEE_BPS = 50;
    uint256 public constant BPS = 10_000;

    IMasonryRedeemableLPVault public immutable lpVault;
    IMasonryBurnableLevel public immutable level;
    IERC20 public immutable usdc;
    /// @notice Fixed POL destination. Immutable on purpose: the owner can
    /// re-point the Genesis caller but can never redirect the fee.
    address public immutable treasury;

    address public genesis;

    // Only fees collected by the authorized Genesis pool enter these totals.
    // Unsolicited share transfers to this module are never forwarded or counted.
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
        address genesis_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(lpVault_).code.length == 0 || address(level_).code.length == 0 || address(usdc_).code.length == 0
                || treasury_ == address(0) || treasury_ == address(this) || genesis_ == address(0)
        ) revert InvalidConfiguration();

        lpVault = lpVault_;
        level = level_;
        usdc = usdc_;
        treasury = treasury_;
        genesis = genesis_;
    }

    /// @notice Immediate owner-controlled integration change. Only moves who
    /// may call `collectAndProcess`; it can never move the fee destination.
    function setGenesis(
        address newGenesis
    ) external onlyOwner {
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
            IERC20 shares = IERC20(address(lpVault));
            uint256 beforeBalance = shares.balanceOf(address(this));
            shares.safeTransferFrom(msg.sender, address(this), feeShares);
            if (shares.balanceOf(address(this)) - beforeBalance != feeShares) revert InvalidFeeReceipt();

            totalFeeSharesCollected += feeShares;
            totalSharesSentToTreasury += feeShares;
            shares.safeTransfer(treasury, feeShares);
            emit FeeSharesSentToTreasury(feeShares, totalSharesSentToTreasury);
        }
        emit FeeSharesCollected(grossShares, feeShares);
    }
}
