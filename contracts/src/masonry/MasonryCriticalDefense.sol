// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Trusted TWAP adapter must return a validated 18-decimal USDC/LEVEL
/// price (not raw 6-decimal USDC units), the observation time, and validity.
interface IMasonryValidatedLevelTwap {
    function latestValidatedTwap()
        external view returns (uint256 priceUsdcPerLevel1e18, uint256 observedAt, bool valid);
}

/// @notice Permissionless, lazy Critical Defense state for fee-routing decisions.
/// Enter immediately on a fresh <=0.90 TWAP. Exit only after fresh >1.01
/// observations at two consecutive actual six-hour epoch checkpoints.
/// There is NO owner pause or trading-disable authority in this contract.
/// Caller should sync before categorizing new eligible fee collections.
/// Integrator MUST defer allocation changes when the oracle is stale.
contract MasonryCriticalDefense {
    uint256 public constant EPOCH = 6 hours;
    uint256 public constant ENTER_PRICE = 0.90e18;
    uint256 public constant EXIT_PRICE = 1.01e18;
    uint256 public constant MAX_ORACLE_AGE = 30 minutes;
    uint256 internal constant NO_RECOVERY = type(uint256).max;

    IMasonryValidatedLevelTwap public immutable oracle;

    bool public active;
    uint8 public recoveryCheckpoints;
    uint256 public lastRecoveryEpoch = NO_RECOVERY;
    uint256 public lastRecoveryObservedAt;

    error InvalidOracle();

    event CriticalDefenseEntered(uint256 price, uint256 observedAt);
    event CriticalDefenseExited(uint256 price, uint256 observedAt);
    event RecoveryCheckpoint(uint256 indexed epochIndex, uint8 consecutive, uint256 observedAt);
    event RecoveryInvalidated(uint256 indexed epochIndex);

    constructor(IMasonryValidatedLevelTwap oracle_) {
        if (address(oracle_).code.length == 0) revert InvalidOracle();
        oracle = oracle_;
    }

    function validNow() public view returns (bool) {
        (, uint256 observedAt, bool valid) = oracle.latestValidatedTwap();
        return valid && observedAt != 0 && observedAt <= block.timestamp
            && block.timestamp - observedAt <= MAX_ORACLE_AGE;
    }

    /// @notice This is a free-to-call state sync (excluding network gas).
    /// Invalid oracle data never turns defense off. Missed recovery epoch
    /// checkpoints cannot be counted retroactively.
    function sync() external returns (bool) {
        (uint256 price, uint256 observedAt, bool valid) = oracle.latestValidatedTwap();
        uint256 epochIndex = block.timestamp / EPOCH;

        if (
            !valid || observedAt == 0 || observedAt > block.timestamp
                || block.timestamp - observedAt > MAX_ORACLE_AGE
        ) {
            // Stale observations break an unfinished recovery streak.
            if (active && recoveryCheckpoints > 0 && lastRecoveryEpoch != epochIndex) {
                _clearRecovery(epochIndex);
            }
            return active;
        }

        if (price <= ENTER_PRICE) {
            if (!active) {
                active = true;
                emit CriticalDefenseEntered(price, observedAt);
            }
            if (recoveryCheckpoints != 0) _clearRecovery(epochIndex);
            return active;
        }

        if (!active) return false;

        // Below or at 1.01 is not recovery.
        if (price <= EXIT_PRICE) {
            if (recoveryCheckpoints != 0) _clearRecovery(epochIndex);
            return true;
        }

        // A recovery observation from a previous epoch is not an eligible
        // checkpoint even if it is still inside the oracle freshness window.
        if (observedAt < epochIndex * EPOCH) return true;
        if (lastRecoveryEpoch == epochIndex) return true;

        if (
            lastRecoveryEpoch != NO_RECOVERY && lastRecoveryEpoch + 1 == epochIndex
                && observedAt > lastRecoveryObservedAt
        ) {
            recoveryCheckpoints += 1;
        } else {
            recoveryCheckpoints = 1;
        }

        lastRecoveryEpoch = epochIndex;
        lastRecoveryObservedAt = observedAt;
        emit RecoveryCheckpoint(epochIndex, recoveryCheckpoints, observedAt);

        if (recoveryCheckpoints >= 2) {
            active = false;
            recoveryCheckpoints = 0;
            lastRecoveryEpoch = NO_RECOVERY;
            lastRecoveryObservedAt = 0;
            emit CriticalDefenseExited(price, observedAt);
        }
        return active;
    }

    function _clearRecovery(uint256 epochIndex) internal {
        recoveryCheckpoints = 0;
        lastRecoveryEpoch = NO_RECOVERY;
        lastRecoveryObservedAt = 0;
        emit RecoveryInvalidated(epochIndex);
    }
}
