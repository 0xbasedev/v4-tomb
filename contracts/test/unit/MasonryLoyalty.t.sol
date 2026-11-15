// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {MasonryLoyalty} from "../../src/masonry/MasonryLoyalty.sol";

contract MasonryLoyaltyTest is Test {
    uint256 internal constant T0 = 1_700_000_000;

    function test_NoDiscountWithoutAClock() public pure {
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, 0, T0)), 600, "never staked");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0, T0)), 600, "staked this second");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0 + 1, T0)), 600, "clock in the future");
    }

    function test_DiscountGrowsSmoothlyToHalfAtThreeWeeks() public pure {
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0, T0 + 7 days)), 500, "one week: a third of the way");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0, T0 + 10.5 days)), 450, "half way");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0, T0 + 14 days)), 400, "two weeks");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0, T0 + 21 days)), 300, "three weeks: half");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, T0, T0 + 365 days)), 300, "never below half");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(150, T0, T0 + 21 days)), 75, "base fee halves too");
    }

    function test_DepositMovesTheClockByItsShareOfTheStake() public pure {
        uint256 nowTs = T0 + 20 days;
        assertEq(MasonryLoyalty.afterDeposit(0, 0, 100 ether, nowTs), nowTs, "first deposit starts now");
        assertEq(MasonryLoyalty.afterDeposit(T0, 0, 100 ether, nowTs), nowTs, "empty stake starts over");
        assertEq(MasonryLoyalty.afterDeposit(T0, 100 ether, 100 ether, nowTs), T0 + 10 days, "doubling halves time in");
        assertEq(MasonryLoyalty.afterDeposit(T0, 100 ether, 0, nowTs), T0, "nothing added, nothing moved");
    }

    /// A late, large deposit cannot ride an old small stake to the full discount.
    function test_LateLargeDepositEarnsAlmostNothing() public pure {
        uint256 nowTs = T0 + 21 days;
        uint256 since = MasonryLoyalty.afterDeposit(T0, 1 ether, 999 ether, nowTs);
        assertEq(nowTs - since, 1814, "one thousandth of the 1,814,400 seconds in");
        assertEq(uint256(MasonryLoyalty.discountedFeeBps(600, since, nowTs)), 600, "discount rounds to nothing");
    }

    function testFuzz_FeeStaysBetweenHalfAndFull(uint16 feeBps, uint256 since, uint256 nowTs) public pure {
        feeBps = uint16(bound(feeBps, 0, 600));
        nowTs = bound(nowTs, 1, type(uint64).max);
        since = bound(since, 0, type(uint64).max);
        uint16 fee = MasonryLoyalty.discountedFeeBps(feeBps, since, nowTs);
        assertLe(uint256(fee), uint256(feeBps));
        assertGe(uint256(fee), uint256(feeBps - feeBps / 2));
    }

    function testFuzz_DepositNeverAgesTheClock(uint256 since, uint256 balance, uint256 amount, uint256 nowTs)
        public
        pure
    {
        nowTs = bound(nowTs, 1, type(uint64).max);
        since = bound(since, 0, nowTs);
        balance = bound(balance, 0, type(uint128).max);
        amount = bound(amount, 0, type(uint128).max);
        uint256 next = MasonryLoyalty.afterDeposit(since, balance, amount, nowTs);
        assertGe(next, since, "a deposit never adds time in");
        assertLe(next, nowTs);
    }
}
