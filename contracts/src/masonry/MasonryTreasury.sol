// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMasonryValidatedLevelTwap} from "./MasonryCriticalDefense.sol";
import {IMasonryMintableLevel, IMasonrySeigniorageSink} from "./IMasonryRuntime.sol";
import {MasonryRules} from "./MasonryRules.sol";

/// @notice Modern Masonry expansion Treasury quoted against the peg-token TWAP
/// (USDG on Robinhood). Gates: fresh validated TWAP strictly above 1.01 of peg,
/// skip when the Masonry stake room is empty.
///
/// Epochs do not start themselves. Whoever calls `allocateExpansion` pays
/// `epochFee` of the fee token (20 USDG at launch) to `feeRecipient`, and the
/// epoch counter moves by exactly one. The next epoch can start one `PERIOD`
/// after the last one was started, not on a wall-clock grid: if nobody pays
/// for three days the counter simply stands still, nothing is minted, and
/// the first call afterwards starts the single next epoch (no catch-up, no
/// skipped numbers).
contract MasonryTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 18-decimal peg (1 X Tomb = 1 USDG in oracle units).
    uint256 public constant PEG_PRICE = 1e18;
    /// @notice Six-hour epochs (`policy.epochSeconds` = 21600).
    uint256 public constant PERIOD = 6 hours;
    /// @notice Hard cap on the oracle freshness window (default and maximum: 30 minutes).
    uint256 public constant HARD_MAX_ORACLE_AGE = 30 minutes;

    IMasonryMintableLevel public immutable level;
    IMasonrySeigniorageSink public immutable masonry;
    IMasonryValidatedLevelTwap public immutable oracle;
    uint256 public immutable startTime;
    /// @notice PLACEHOLDER expansion rate. Must be > 0 and ≤ `HARD_MAX_EXPANSION_BPS` (200).
    /// Not approved tokenomics — pass the value Jesse signs off on at launch.
    uint16 public immutable requestedRateBps;
    uint256 public immutable oracleMaxAge;
    address public immutable admin;
    /// @notice Token the epoch fee is paid in (the chain's peg token).
    IERC20 public immutable feeToken;
    /// @notice Flat fee the caller pays to start an epoch.
    uint256 public immutable epochFee;
    address public immutable feeRecipient;

    uint256 public epoch;
    /// @notice When the current epoch was started (0 before the first).
    uint256 public lastEpochAt;

    event EpochStarted(uint256 indexed epochId, address indexed payer, uint256 fee);
    event Expansion(uint256 indexed epochId, uint256 minted, uint256 twapPrice);
    event ExpansionSkipped(uint256 indexed epochId, uint256 twapPrice, bool fresh, bytes32 reason);

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
        uint256 oracleMaxAge_,
        address admin_,
        IERC20 feeToken_,
        uint256 epochFee_,
        address feeRecipient_
    ) {
        if (
            address(level_) == address(0) || address(masonry_) == address(0) || address(oracle_) == address(0)
                || admin_ == address(0) || address(feeToken_) == address(0) || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (startTime_ == 0) revert InvalidConfiguration();
        if (requestedRateBps_ == 0 || requestedRateBps_ > MasonryRules.HARD_MAX_EXPANSION_BPS) {
            revert InvalidConfiguration();
        }
        if (oracleMaxAge_ == 0 || oracleMaxAge_ > HARD_MAX_ORACLE_AGE) revert InvalidConfiguration();
        level = level_;
        masonry = masonry_;
        oracle = oracle_;
        startTime = startTime_;
        requestedRateBps = requestedRateBps_;
        oracleMaxAge = oracleMaxAge_;
        admin = admin_;
        feeToken = feeToken_;
        epochFee = epochFee_;
        feeRecipient = feeRecipient_;
    }

    /// @notice Earliest time the next epoch can be started.
    function nextEpochPoint() public view returns (uint256) {
        return epoch == 0 ? startTime : lastEpochAt + PERIOD;
    }

    function previewTwap() public view returns (uint256 price, bool fresh) {
        (uint256 observedPrice, uint256 observedAt, bool valid) = oracle.latestValidatedTwap();
        price = observedPrice;
        fresh =
            valid && observedAt != 0 && observedAt <= block.timestamp && block.timestamp - observedAt <= oracleMaxAge;
    }

    function allocateExpansion() external nonReentrant {
        if (block.timestamp < startTime) revert NotStarted();
        if (block.timestamp < nextEpochPoint()) revert EpochNotElapsed();
        // One paid call, one epoch. Time nobody paid for is not counted.
        epoch += 1;
        lastEpochAt = block.timestamp;
        if (epochFee != 0) feeToken.safeTransferFrom(msg.sender, feeRecipient, epochFee);
        emit EpochStarted(epoch, msg.sender, epochFee);

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
}
