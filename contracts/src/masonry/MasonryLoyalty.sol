// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Time-in discount on the liquidity withdraw fee (owner rule 2026-11-14).
/// A staker who has not withdrawn pays less: the discount grows every second from nothing
/// at deposit to half the fee after three weeks. The clock counts time in, weighted by size:
/// a withdrawal restarts it, and a new deposit moves it forward in proportion to the amount
/// added, so a large late deposit earns almost no discount.
library MasonryLoyalty {
    uint256 internal constant FULL_DISCOUNT_AFTER = 21 days;
    uint256 internal constant MAX_DISCOUNT_BPS = 5000;
    uint256 internal constant BPS = 10_000;

    /// @notice The clock after `amount` is added to a stake of `balanceBefore` held since `since`.
    function afterDeposit(
        uint256 since,
        uint256 balanceBefore,
        uint256 amount,
        uint256 nowTs
    ) internal pure returns (uint256) {
        if (since == 0 || balanceBefore == 0 || since >= nowTs) return nowTs;
        return nowTs - (nowTs - since) * balanceBefore / (balanceBefore + amount);
    }

    /// @notice `feeBps` after the time-in discount. Never below half of `feeBps`.
    function discountedFeeBps(
        uint16 feeBps,
        uint256 since,
        uint256 nowTs
    ) internal pure returns (uint16) {
        if (since == 0 || since >= nowTs) return feeBps;
        uint256 held = nowTs - since;
        if (held > FULL_DISCOUNT_AFTER) held = FULL_DISCOUNT_AFTER;
        uint256 discount = uint256(feeBps) * MAX_DISCOUNT_BPS * held / (FULL_DISCOUNT_AFTER * BPS);
        return feeBps - uint16(discount);
    }
}
