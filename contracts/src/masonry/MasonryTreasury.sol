// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMasonryValidatedLevelTwap} from "./MasonryCriticalDefense.sol";
import {IMasonryBondSettler, IMasonryMintableLevel, IMasonrySeigniorageSink} from "./IMasonryRuntime.sol";
import {MasonryRules} from "./MasonryRules.sol";

/// @notice Modern Masonry expansion Treasury quoted against the peg-token TWAP
/// (USDG on Robinhood). Gates: fresh validated TWAP strictly above 1.01 of peg,
/// no missed-epoch catch-up, skip when the Masonry stake room is empty.
contract MasonryTreasury is IMasonryBondSettler, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 18-decimal peg (1 X Tomb = 1 USDG in oracle units).
    uint256 public constant PEG_PRICE = 1e18;
    /// @notice Six-hour epochs (`policy.epochSeconds` = 21600).
    uint256 public constant PERIOD = 6 hours;
    /// @notice Oracle freshness window (`policy.criticalOracleMaxAgeSeconds` = 1800).
    uint256 public constant ORACLE_MAX_AGE = 30 minutes;

    IMasonryMintableLevel public immutable level;
    IMasonrySeigniorageSink public immutable masonry;
    IMasonryValidatedLevelTwap public immutable oracle;
    uint256 public immutable startTime;
    /// @notice PLACEHOLDER expansion rate. Must be > 0 and ≤ `HARD_MAX_EXPANSION_BPS` (200).
    /// Not approved tokenomics — pass the value Jesse signs off on at launch.
    uint16 public immutable requestedRateBps;
    address public immutable admin;

    uint256 public epoch;
    address public bond;

    event Expansion(uint256 indexed epochId, uint256 minted, uint256 twapPrice);
    event ExpansionSkipped(uint256 indexed epochId, uint256 twapPrice, bool fresh, bytes32 reason);
    event BondSet(address indexed bond);

    error ZeroAddress();
    error InvalidConfiguration();
    error Unauthorized();
    error AlreadySet();
    error NotStarted();
    error EpochNotElapsed();
    error StaleOracle();
    error NotAbovePeg();

    constructor(
        IMasonryMintableLevel level_,
        IMasonrySeigniorageSink masonry_,
        IMasonryValidatedLevelTwap oracle_,
        uint256 startTime_,
        uint16 requestedRateBps_,
        address admin_
    ) {
        if (
            address(level_) == address(0) || address(masonry_) == address(0) || address(oracle_) == address(0)
                || admin_ == address(0)
        ) revert ZeroAddress();
        if (startTime_ == 0) revert InvalidConfiguration();
        if (requestedRateBps_ == 0 || requestedRateBps_ > MasonryRules.HARD_MAX_EXPANSION_BPS) {
            revert InvalidConfiguration();
        }
        level = level_;
        masonry = masonry_;
        oracle = oracle_;
        startTime = startTime_;
        requestedRateBps = requestedRateBps_;
        admin = admin_;
    }

    function setBond(
        address bond_
    ) external {
        if (msg.sender != admin) revert Unauthorized();
        if (bond != address(0)) revert AlreadySet();
        if (bond_ == address(0)) revert ZeroAddress();
        bond = bond_;
        emit BondSet(bond_);
    }

    function nextEpochPoint() public view returns (uint256) {
        return startTime + epoch * PERIOD;
    }

    function previewTwap() public view returns (uint256 price, bool fresh) {
        (uint256 observedPrice, uint256 observedAt, bool valid) = oracle.latestValidatedTwap();
        price = observedPrice;
        fresh =
            valid && observedAt != 0 && observedAt <= block.timestamp && block.timestamp - observedAt <= ORACLE_MAX_AGE;
    }

    function allocateExpansion() external nonReentrant {
        if (block.timestamp < startTime) revert NotStarted();
        if (block.timestamp < nextEpochPoint()) revert EpochNotElapsed();
        // Fast-forward to the current wall-clock epoch. Missed periods are not minted.
        epoch = (block.timestamp - startTime) / PERIOD + 1;

        (uint256 price, bool fresh) = previewTwap();
        if (!MasonryRules.eligibleForExpansion(price, PEG_PRICE, fresh)) {
            emit ExpansionSkipped(epoch, price, fresh, "not-eligible");
            return;
        }
        if (masonry.totalSupply() == 0) {
            emit ExpansionSkipped(epoch, price, fresh, "empty-masonry");
            return;
        }

        uint256 circulating = level.totalSupply();
        uint256 minted = MasonryRules.expansionUpperBound(circulating, requestedRateBps, price, PEG_PRICE, fresh);
        if (minted == 0) {
            emit ExpansionSkipped(epoch, price, fresh, "zero-mint");
            return;
        }

        level.mint(address(this), minted);
        IERC20(address(level)).safeIncreaseAllowance(address(masonry), minted);
        masonry.allocateSeigniorage(minted);
        emit Expansion(epoch, minted, price);
    }

    /// @notice Pays X Bond redemptions 1:1 in newly minted X Tomb only when
    /// the peg-token TWAP is fresh and strictly above peg. 1:1 is a PLACEHOLDER
    /// redemption price — no premium is applied until Jesse sets one.
    function settleBondRedemption(
        address to,
        uint256 tombAmount
    ) external nonReentrant {
        if (msg.sender != bond) revert Unauthorized();
        if (to == address(0) || tombAmount == 0) revert InvalidConfiguration();
        (uint256 price, bool fresh) = previewTwap();
        if (!fresh) revert StaleOracle();
        if (price <= PEG_PRICE) revert NotAbovePeg();
        level.mint(to, tombAmount);
    }
}
