// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

struct MasonryLaunchParams {
    uint256 expansionRateBps;
    uint256 farmEmissionDays;
    uint256 farmWholeTokens;
    uint256 farmShareWethLpAllocPoints;
    uint256 bondMaxDiscountBps;
    uint256 bondMaxDebtRatioBps;
    uint256 bondMaxSupplyWholeTokens;
    uint256 bondRedeemPremiumBps;
    uint256 oracleMaxAgeSeconds;
    uint256 fireTaxBaselineBps;
    uint256 fireTaxHardCapBps;
    uint256 rangeLevelHalfWidthBps;
    uint256 rangeLevelRecenterBps;
    uint256 rangeLevelCooldownSeconds;
    uint256 rangeLevelMaxTwapDeviationBps;
    uint256 rangeSquareHalfWidthBps;
    uint256 rangeSquareRecenterBps;
    uint256 rangeSquareCooldownSeconds;
    uint256 rangeSquareMaxTwapDeviationBps;
    address daoWallet;
    bool farmClaimToWallet;
    uint256 farmWithdrawCooldownSeconds;
}

/// @notice Reads `config/masonry-launch.template.json` and scales whole-token
/// amounts by on-chain decimals. Used by the local dry-run only.
library MasonryLaunchConfig {
    using stdJson for string;

    error InvalidLaunchConfig(string reason);

    function load(
        Vm vm
    ) internal view returns (MasonryLaunchParams memory p) {
        string memory raw = vm.readFile(string.concat(vm.projectRoot(), "/../config/masonry-launch.template.json"));
        p.expansionRateBps = raw.readUint(".policy.maximumExpansionPerEpochBps");
        p.farmEmissionDays = raw.readUint(".policy.farmEmissionDays");
        p.farmWholeTokens = raw.readUint(".square.farming");
        p.farmShareWethLpAllocPoints = raw.readUint(".policy.farmShareWethLpAllocPoints");
        p.bondMaxDiscountBps = raw.readUint(".policy.bondMaxDiscountBps");
        p.bondMaxDebtRatioBps = raw.readUint(".policy.bondMaxDebtRatioBps");
        p.bondMaxSupplyWholeTokens = raw.readUint(".policy.bondMaxSupply");
        p.bondRedeemPremiumBps = raw.readUint(".policy.bondRedeemPremiumBps");
        p.oracleMaxAgeSeconds = raw.readUint(".policy.criticalOracleMaxAgeSeconds");
        p.fireTaxBaselineBps = raw.readUint(".policy.fireTaxBaselineBps");
        p.fireTaxHardCapBps = raw.readUint(".policy.fireTaxHardCapBps");
        p.rangeLevelHalfWidthBps = raw.readUint(".policy.rangeLevel.halfWidthBps");
        p.rangeLevelRecenterBps = raw.readUint(".policy.rangeLevel.recenterBps");
        p.rangeLevelCooldownSeconds = raw.readUint(".policy.rangeLevel.cooldownSeconds");
        p.rangeLevelMaxTwapDeviationBps = raw.readUint(".policy.rangeLevel.maxTwapDeviationBps");
        p.rangeSquareHalfWidthBps = raw.readUint(".policy.rangeSquare.halfWidthBps");
        p.rangeSquareRecenterBps = raw.readUint(".policy.rangeSquare.recenterBps");
        p.rangeSquareCooldownSeconds = raw.readUint(".policy.rangeSquare.cooldownSeconds");
        p.rangeSquareMaxTwapDeviationBps = raw.readUint(".policy.rangeSquare.maxTwapDeviationBps");
        p.daoWallet = raw.readAddress(".daoWallet");
        p.farmClaimToWallet = raw.readBool(".policy.farmClaimToWallet");
        p.farmWithdrawCooldownSeconds = raw.readUint(".policy.farmWithdrawCooldownSeconds");
        validate(p);
    }

    function scaleWhole(
        uint256 whole,
        uint8 decimals
    ) internal pure returns (uint256) {
        return whole * (10 ** uint256(decimals));
    }

    function validate(
        MasonryLaunchParams memory p
    ) internal pure {
        if (p.fireTaxBaselineBps < 300) revert InvalidLaunchConfig("fireTaxBaselineBps");
        if (p.fireTaxHardCapBps > 1200 || p.fireTaxBaselineBps > p.fireTaxHardCapBps) {
            revert InvalidLaunchConfig("fireTaxHardCapBps");
        }
        if (p.expansionRateBps == 0 || p.expansionRateBps > 200) revert InvalidLaunchConfig("expansionRateBps");
        if (p.farmEmissionDays == 0 || p.farmEmissionDays > 3650) revert InvalidLaunchConfig("farmEmissionDays");
        if (p.farmWholeTokens == 0) revert InvalidLaunchConfig("farmWholeTokens");
        if (p.oracleMaxAgeSeconds == 0 || p.oracleMaxAgeSeconds > 1800) {
            revert InvalidLaunchConfig("oracleMaxAgeSeconds");
        }
        if (p.farmShareWethLpAllocPoints == 0) revert InvalidLaunchConfig("farmShareWethLpAllocPoints");
        if (p.bondMaxDiscountBps > 10_000) revert InvalidLaunchConfig("bondMaxDiscountBps");
        if (p.bondMaxDebtRatioBps == 0 || p.bondMaxDebtRatioBps > 10_000) {
            revert InvalidLaunchConfig("bondMaxDebtRatioBps");
        }
        if (p.bondMaxSupplyWholeTokens == 0) revert InvalidLaunchConfig("bondMaxSupply");
        if (p.bondRedeemPremiumBps > 10_000) revert InvalidLaunchConfig("bondRedeemPremiumBps");
        if (p.daoWallet == address(0)) revert InvalidLaunchConfig("daoWallet");
        if (p.farmWithdrawCooldownSeconds < 60 || p.farmWithdrawCooldownSeconds > 1 days) {
            revert InvalidLaunchConfig("farmWithdrawCooldownSeconds");
        }
        _validateRange(
            p.rangeLevelHalfWidthBps, p.rangeLevelRecenterBps, p.rangeLevelCooldownSeconds,
            p.rangeLevelMaxTwapDeviationBps, "rangeLevel"
        );
        _validateRange(
            p.rangeSquareHalfWidthBps, p.rangeSquareRecenterBps, p.rangeSquareCooldownSeconds,
            p.rangeSquareMaxTwapDeviationBps, "rangeSquare"
        );
    }

    function _validateRange(
        uint256 halfWidthBps,
        uint256 recenterBps,
        uint256 cooldownSeconds,
        uint256 maxTwapDeviationBps,
        string memory label
    ) private pure {
        if (halfWidthBps < 500 || halfWidthBps > 3000) revert InvalidLaunchConfig(label);
        if (recenterBps < 100 || recenterBps >= halfWidthBps) revert InvalidLaunchConfig(label);
        if (cooldownSeconds < 60 || cooldownSeconds > 1 days) revert InvalidLaunchConfig(label);
        if (maxTwapDeviationBps == 0 || maxTwapDeviationBps > 1000) revert InvalidLaunchConfig(label);
    }
}
