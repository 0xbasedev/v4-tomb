// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMasonryValidatedLevelTwap} from "./MasonryCriticalDefense.sol";
import {IMasonryBondSettler} from "./IMasonryRuntime.sol";

/// @notice X Bond: buy below peg by burning X Tomb; redeem above peg for X Tomb.
/// Discounts are bounded and outstanding debt is capped.
///
/// Configured tokenomics (defaults in masonry-launch.template.json; bounded here):
/// - `maxDiscountBps`: extra bonds above 1:1, hard-capped at 10_000 (2×).
/// - `maxDebtRatioBps`: outstanding bonds vs circulating X Tomb, 1–10_000.
/// - `maxBondSupply`: absolute bond supply cap (base units).
/// - `redeemPremiumBps`: extra X Tomb on redeem, default 0, hard-capped at 10_000.
contract MasonryBond is ERC20, ERC20Burnable, ERC20Permit, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PEG_PRICE = 1e18;
    uint256 public constant HARD_MAX_ORACLE_AGE = 30 minutes;
    uint16 public constant HARD_MAX_DISCOUNT_BPS = 10_000;
    uint16 public constant HARD_MAX_DEBT_RATIO_BPS = 10_000;
    uint16 public constant HARD_MAX_PREMIUM_BPS = 10_000;

    IERC20 public immutable level;
    IMasonryBondSettler public immutable treasury;
    IMasonryValidatedLevelTwap public immutable oracle;
    uint16 public immutable maxDiscountBps;
    uint16 public immutable maxDebtRatioBps;
    uint256 public immutable maxBondSupply;
    uint16 public immutable redeemPremiumBps;
    uint256 public immutable oracleMaxAge;

    event Bought(address indexed buyer, uint256 tombIn, uint256 bondsOut, uint256 twapPrice);
    event Redeemed(address indexed redeemer, uint256 bondsIn, uint256 tombOut, uint256 twapPrice);

    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidAmount();
    error StaleOracle();
    error NotBelowPeg();
    error NotAbovePeg();
    error DebtCap();
    error SupplyCap();

    constructor(
        IERC20 level_,
        IMasonryBondSettler treasury_,
        IMasonryValidatedLevelTwap oracle_,
        uint16 maxDiscountBps_,
        uint16 maxDebtRatioBps_,
        uint256 maxBondSupply_,
        uint16 redeemPremiumBps_,
        uint256 oracleMaxAge_
    ) ERC20("X Bond", "xBOND") ERC20Permit("X Bond") {
        if (address(level_) == address(0) || address(treasury_) == address(0) || address(oracle_) == address(0)) {
            revert ZeroAddress();
        }
        if (
            maxDiscountBps_ > HARD_MAX_DISCOUNT_BPS || maxDebtRatioBps_ == 0
                || maxDebtRatioBps_ > HARD_MAX_DEBT_RATIO_BPS || redeemPremiumBps_ > HARD_MAX_PREMIUM_BPS
        ) {
            revert InvalidConfiguration();
        }
        if (maxBondSupply_ == 0) revert InvalidConfiguration();
        if (oracleMaxAge_ == 0 || oracleMaxAge_ > HARD_MAX_ORACLE_AGE) revert InvalidConfiguration();
        level = level_;
        treasury = treasury_;
        oracle = oracle_;
        maxDiscountBps = maxDiscountBps_;
        maxDebtRatioBps = maxDebtRatioBps_;
        maxBondSupply = maxBondSupply_;
        redeemPremiumBps = redeemPremiumBps_;
        oracleMaxAge = oracleMaxAge_;
    }

    function previewTwap() public view returns (uint256 price, bool fresh) {
        (uint256 observedPrice, uint256 observedAt, bool valid) = oracle.latestValidatedTwap();
        price = observedPrice;
        fresh =
            valid && observedAt != 0 && observedAt <= block.timestamp && block.timestamp - observedAt <= oracleMaxAge;
    }

    function previewBuy(
        uint256 tombAmount
    ) public view returns (uint256 bondsOut) {
        (uint256 price, bool fresh) = previewTwap();
        if (!fresh || price == 0 || price >= PEG_PRICE || tombAmount == 0) return 0;
        uint256 atFair = tombAmount * PEG_PRICE / price;
        uint256 capped = tombAmount * (uint256(10_000) + maxDiscountBps) / 10_000;
        bondsOut = atFair < capped ? atFair : capped;
    }

    function buy(
        uint256 tombAmount
    ) external nonReentrant {
        if (tombAmount == 0) revert InvalidAmount();
        (uint256 price, bool fresh) = previewTwap();
        if (!fresh) revert StaleOracle();
        if (price == 0 || price >= PEG_PRICE) revert NotBelowPeg();

        uint256 bondsOut = previewBuy(tombAmount);
        if (bondsOut == 0) revert InvalidAmount();
        if (totalSupply() + bondsOut > maxBondSupply) revert SupplyCap();

        uint256 circulatingAfter = level.totalSupply() - tombAmount;
        uint256 debtCap = circulatingAfter * maxDebtRatioBps / 10_000;
        if (totalSupply() + bondsOut > debtCap) revert DebtCap();

        level.safeTransferFrom(msg.sender, address(this), tombAmount);
        ERC20Burnable(address(level)).burn(tombAmount);
        _mint(msg.sender, bondsOut);
        emit Bought(msg.sender, tombAmount, bondsOut, price);
    }

    function redeem(
        uint256 bondAmount
    ) external nonReentrant {
        if (bondAmount == 0) revert InvalidAmount();
        (uint256 price, bool fresh) = previewTwap();
        if (!fresh) revert StaleOracle();
        if (price <= PEG_PRICE) revert NotAbovePeg();
        uint256 tombOut = bondAmount * (uint256(10_000) + redeemPremiumBps) / 10_000;
        _burn(msg.sender, bondAmount);
        treasury.settleBondRedemption(msg.sender, tombOut);
        emit Redeemed(msg.sender, bondAmount, tombOut, price);
    }
}
