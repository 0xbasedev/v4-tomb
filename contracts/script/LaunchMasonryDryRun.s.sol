// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {MasonryBond} from "../src/masonry/MasonryBond.sol";
import {MasonryChamber} from "../src/masonry/MasonryChamber.sol";
import {MasonryFarm} from "../src/masonry/MasonryFarm.sol";
import {MasonryTreasury} from "../src/masonry/MasonryTreasury.sol";
import {MasonryLaunchConfig, MasonryLaunchParams} from "./MasonryLaunchConfig.sol";

/// @notice Masonry-only dry-run launcher documentation.
/// @dev This script never broadcasts and refuses to run if PRIVATE_KEY is set.
///      It reads config/masonry-launch.template.json (whole-token amounts)
///      and prints the values the fork test will scale by token decimals.
contract LaunchMasonryDryRun is Script {
    error BroadcastCredentialsPresent();

    function run() external view {
        if (vm.envOr("PRIVATE_KEY", uint256(0)) != 0) revert BroadcastCredentialsPresent();
        MasonryLaunchParams memory cfg = MasonryLaunchConfig.load(vm);
        console2.log("Masonry dry-run only. No broadcast.");
        console2.log("Launch graph: MasonryTreasury, MasonryFarm, MasonryBond, MasonryChamber.");
        console2.log("expansionRateBps", cfg.expansionRateBps);
        console2.log("farmWholeTokens", cfg.farmWholeTokens);
        console2.log("farmEmissionDays", cfg.farmEmissionDays);
        console2.log("farmShareWethLpAllocPoints", cfg.farmShareWethLpAllocPoints);
        console2.log("bondMaxDiscountBps", cfg.bondMaxDiscountBps);
        console2.log("bondMaxDebtRatioBps", cfg.bondMaxDebtRatioBps);
        console2.log("bondMaxSupplyWholeTokens", cfg.bondMaxSupplyWholeTokens);
        console2.log("bondRedeemPremiumBps", cfg.bondRedeemPremiumBps);
        console2.log("oracleMaxAgeSeconds", cfg.oracleMaxAgeSeconds);
        console2.log("fireTaxBaselineBps", cfg.fireTaxBaselineBps);
        console2.log("fireTaxHardCapBps", cfg.fireTaxHardCapBps);
        console2.log("Legacy Deploy.s.sol is not launch logic.");
        console2.log("  MasonryTreasury", type(MasonryTreasury).creationCode.length);
        console2.log("  MasonryFarm", type(MasonryFarm).creationCode.length);
        console2.log("  MasonryBond", type(MasonryBond).creationCode.length);
        console2.log("  MasonryChamber", type(MasonryChamber).creationCode.length);
    }
}
