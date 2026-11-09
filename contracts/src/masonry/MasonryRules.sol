// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Pure economic rules to be wired into the Masonry-specific v4 hook,
/// Treasury and launch allocator. This module does not modify Old Money runtime.
library MasonryRules {
    uint16 internal constant HARD_MAX_FIRE_TAX_BPS = 1200;
    uint16 internal constant HARD_MAX_EXPANSION_BPS = 200;
    uint16 internal constant DEFAULT_BASE_FIRE_TAX_BPS = 300;
    uint16 internal constant DEFAULT_MAX_FIRE_TAX_BPS = 1200;
    uint16 internal constant DEFAULT_FULL_TAX_DROP_BPS = 1000;
    uint16 internal constant EXPANSION_THRESHOLD_BPS = 10_100;
    uint256 internal constant FIRE_TAX_RECOVERY = 7 hours;
    uint256 internal constant COMPOUND_COOLDOWN = 3 hours;

    error InvalidParameters();
    error SupplyNotReconciled(uint256 allocated, uint256 maximum);

    /// @dev Amounts use token-native whole units or token-base units consistently;
    /// the wizard is responsible for applying the configured token decimals.
    /// The four vesting buckets are Team, Developer, Treasury and Arbitrage.
    function validateSquareAllocations(
        uint256 maximum,
        uint256 farming,
        uint256 saleEscrow,
        uint256 deployer,
        uint256 ownerLaunch,
        uint256 treasuryLaunch,
        uint256 arbitrageLaunch,
        uint256[4] memory vested
    ) internal pure {
        if (maximum == 0) revert InvalidParameters();
        uint256 allocated = farming + saleEscrow + deployer + ownerLaunch + treasuryLaunch + arbitrageLaunch;
        for (uint256 i; i < vested.length; ++i) {
            allocated += vested[i];
        }
        if (allocated != maximum) revert SupplyNotReconciled(allocated, maximum);
    }

    /// @notice Aggressive (square-root) sell tax as LEVEL falls toward the configured full-tax
    /// price. At/above peg the baseline applies; at the full-drop price and
    /// below the hard maximum applies. All prices must share one precision.
    function targetSellTaxBps(
        uint256 price,
        uint256 peg,
        uint16 baselineBps,
        uint16 maximumBps,
        uint16 fullTaxDropBps
    ) internal pure returns (uint16) {
        if (
            peg == 0 || baselineBps > maximumBps || maximumBps > HARD_MAX_FIRE_TAX_BPS || fullTaxDropBps == 0
                || fullTaxDropBps > 10_000
        ) revert InvalidParameters();
        if (price >= peg) return baselineBps;
        uint256 bottom = peg * (10_000 - fullTaxDropBps) / 10_000;
        if (price <= bottom) return maximumBps;
        uint256 span = peg - bottom;
        uint256 progress = (peg - price) * 10_000 / span;
        // Square-root curve: escalates fast just below peg, reaches max at full drop.
        uint256 nonlinear = Math.sqrt(progress * 10_000);
        return baselineBps + uint16(uint256(maximumBps - baselineBps) * nonlinear / 10_000);
    }

    /// @notice Floor after an observed higher Fire Tax target. A new sale
    /// must not reset raisedAt unless a genuinely higher rate is observed.
    function recoveryFloorBps(
        uint16 raisedBps,
        uint16 baselineBps,
        uint256 raisedAt,
        uint256 nowTs
    ) internal pure returns (uint16) {
        if (raisedBps > HARD_MAX_FIRE_TAX_BPS || baselineBps > raisedBps) revert InvalidParameters();
        if (nowTs <= raisedAt) return raisedBps;
        uint256 elapsed = nowTs - raisedAt;
        if (elapsed >= FIRE_TAX_RECOVERY) return baselineBps;
        return
            baselineBps + uint16(uint256(raisedBps - baselineBps) * (FIRE_TAX_RECOVERY - elapsed) / FIRE_TAX_RECOVERY);
    }

    /// @notice Combine separately validated TWAP, guarded execution-price
    /// and recovery-floor rates. Never accept a rate beyond 12%.
    function effectiveSellTaxBps(
        uint16 twapRate,
        uint16 projectedRate,
        uint16 recoveryFloor
    ) internal pure returns (uint16) {
        if (
            twapRate > HARD_MAX_FIRE_TAX_BPS || projectedRate > HARD_MAX_FIRE_TAX_BPS
                || recoveryFloor > HARD_MAX_FIRE_TAX_BPS
        ) revert InvalidParameters();
        uint16 selected = twapRate > projectedRate ? twapRate : projectedRate;
        return selected > recoveryFloor ? selected : recoveryFloor;
    }

    /// @notice Liquidity withdraw fee: Fire Tax curve on the validated TWAP
    /// only (no spot / projected execution price), floored by 7-hour recovery.
    /// Spot is omitted so a single-block sandwich cannot spike the withdraw fee.
    function withdrawFeeBps(
        uint256 twapPrice,
        uint256 peg,
        uint16 baselineBps,
        uint16 maximumBps,
        uint16 fullTaxDropBps,
        uint16 raisedBps_,
        uint256 raisedAt,
        uint256 nowTs
    ) internal pure returns (uint16) {
        if (twapPrice == 0) revert InvalidParameters();
        uint16 recovery = recoveryFloorBps(raisedBps_, baselineBps, raisedAt, nowTs);
        uint16 twapRate = targetSellTaxBps(twapPrice, peg, baselineBps, maximumBps, fullTaxDropBps);
        return effectiveSellTaxBps(twapRate, twapRate, recovery);
    }

    /// @notice Expansion only from a fresh validated TWAP strictly above
    /// 1.01 of the configured peg. Never authorize expansion via spot alone.
    function eligibleForExpansion(
        uint256 twapPrice,
        uint256 pegPrice,
        bool hasFreshValidatedTwap
    ) internal pure returns (bool) {
        if (!hasFreshValidatedTwap || pegPrice == 0) return false;
        return twapPrice > pegPrice * EXPANSION_THRESHOLD_BPS / 10_000;
    }

    /// @notice Upper bound per eligible epoch. Callers must separately
    /// enforce the six-hour epoch, no catch-up and circulating-supply rules.
    function expansionUpperBound(
        uint256 circulatingSupply,
        uint16 requestedRateBps,
        uint256 twapPrice,
        uint256 pegPrice,
        bool fresh
    ) internal pure returns (uint256) {
        if (requestedRateBps > HARD_MAX_EXPANSION_BPS) revert InvalidParameters();
        if (!eligibleForExpansion(twapPrice, pegPrice, fresh)) return 0;
        return circulatingSupply * requestedRateBps / 10_000;
    }
}
