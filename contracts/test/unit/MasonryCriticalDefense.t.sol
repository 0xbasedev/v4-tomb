// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MasonryCriticalDefense, IMasonryValidatedLevelTwap} from "../../src/masonry/MasonryCriticalDefense.sol";

contract MockMasonryValidatedTwap is IMasonryValidatedLevelTwap {
    uint256 public price;
    uint256 public observedAt;
    bool public valid;

    function set(
        uint256 p,
        uint256 t,
        bool v
    ) external {
        price = p;
        observedAt = t;
        valid = v;
    }

    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (price, observedAt, valid);
    }
}

contract MasonryCriticalDefenseTest is Test {
    MockMasonryValidatedTwap internal twap;
    MasonryCriticalDefense internal defense;
    uint256 internal firstEpoch;

    function setUp() public {
        vm.warp(1_700_000_000);
        firstEpoch = block.timestamp / 6 hours;
        twap = new MockMasonryValidatedTwap();
        defense = new MasonryCriticalDefense(twap);
    }

    function _observed(
        uint256 price
    ) internal {
        twap.set(price, block.timestamp, true);
        defense.sync();
    }

    function _nextEpoch(
        uint256 offset
    ) internal {
        vm.warp((firstEpoch + offset) * 6 hours + 60);
    }

    function test_EntersAtOrBelowNinetyCents() public {
        _observed(90e16);
        assertTrue(defense.active());
        assertEq(defense.recoveryCheckpoints(), 0);
    }

    function test_DoesNotEnterAboveNinetyCents() public {
        _observed(90e16 + 1);
        assertFalse(defense.active());
    }

    function test_TwoConsecutiveFreshEpochsStrictlyAboveOnePointZeroOne() public {
        _observed(88e16);
        assertTrue(defense.active());

        _nextEpoch(1);
        _observed(101e16);
        assertTrue(defense.active());
        assertEq(defense.recoveryCheckpoints(), 0);

        _observed(101e16 + 1);
        assertEq(defense.recoveryCheckpoints(), 1);
        assertTrue(defense.active());

        // Replaying the same epoch cannot count twice.
        _observed(102e16);
        assertEq(defense.recoveryCheckpoints(), 1);

        _nextEpoch(2);
        _observed(102e16);
        assertFalse(defense.active());
        assertEq(defense.recoveryCheckpoints(), 0);
    }

    function test_SkippedRecoveryEpochCannotBeCounted() public {
        _observed(88e16);
        _nextEpoch(1);
        _observed(102e16);
        assertEq(defense.recoveryCheckpoints(), 1);

        _nextEpoch(3); // Skip epoch +2 entirely.
        _observed(102e16);
        assertTrue(defense.active());
        assertEq(defense.recoveryCheckpoints(), 1);

        _nextEpoch(4);
        _observed(102e16);
        assertFalse(defense.active());
    }

    function test_StaleOracleCannotReleaseDefense() public {
        _observed(88e16);
        _nextEpoch(1);
        _observed(102e16);
        assertEq(defense.recoveryCheckpoints(), 1);

        _nextEpoch(2);
        twap.set(102e16, block.timestamp - 31 minutes, true);
        defense.sync();
        assertTrue(defense.active());
        assertEq(defense.recoveryCheckpoints(), 0);

        // Fresh observation in this epoch starts a new two-epoch streak.
        _observed(102e16);
        assertTrue(defense.active());
        assertEq(defense.recoveryCheckpoints(), 1);
    }

    function test_PriceDeteriorationBreaksRecovery() public {
        _observed(88e16);
        _nextEpoch(1);
        _observed(102e16);
        assertEq(defense.recoveryCheckpoints(), 1);

        _nextEpoch(2);
        _observed(99e16);
        assertEq(defense.recoveryCheckpoints(), 0);
        assertTrue(defense.active());
    }

    function test_InvalidOracleCannotTurnOffDefense() public {
        _observed(88e16);
        _nextEpoch(1);
        twap.set(150e16, block.timestamp, false);
        defense.sync();
        assertTrue(defense.active());
    }
}
