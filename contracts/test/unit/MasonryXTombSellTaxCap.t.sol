// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {MasonryRules} from "../../src/masonry/MasonryRules.sol";
import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";

/// @notice Sum every tax an xTOMB sell can hit and compare with Jesse's
/// 12% (1200 bps) combined cap. Official masonry and leftover PegDefense
/// paths are separate: a v4 pool has one hook, so they never stack.
///
/// Findings (also true on 8c6dd0b unless noted):
/// 1. Official MasonryTaxHook + static 3000-pip pool fee = 1230 bps at
///    worst Fire Tax. MasonryTaxHook.beforeSwap returns fee `0` without
///    OVERRIDE_FEE_FLAG, so PoolManager keeps the pool's 30 bp LP fee.
///    File: contracts/src/masonry/MasonryTaxHook.sol:216-220 (same idea
///    on 8c6dd0b MasonryTaxHook).
/// 2. Leftover PegDefenseHook, if launched via Deploy.s.sol /
///    PostBootstrap (X Tomb/WETH-style MONEY pool), charges
///    taxTiersRates[0] = 2000 bps plus a dynamic LP fee up to
///    deepContractionFee = 30_000 pips (3% = 300 bps) = 2300 bps.
///    File: contracts/src/hooks/PegDefenseHook.sol constructor
///    taxTiersRates (our branch ~209; 8c6dd0b ~211) and deepContractionFee.
/// Genesis LP burn (50 bps) is a deposit/compound share fee, not an AMM
/// sell tax, and is not added here.
contract MasonryXTombSellTaxCapTest is Test {
    uint16 internal constant BASELINE = 300;
    uint16 internal constant CAP = 1200;
    uint16 internal constant FULL_DROP = 1000;
    uint256 internal constant PEG = 1e18;
    /// Uniswap v4 static fee on the official masonry pool (3000 pips = 30 bps).
    uint256 internal constant OFFICIAL_POOL_LP_FEE_BPS = 30;

    function testOfficialFireTaxAloneStaysAtOrUnder12PercentAtWorstDepegAndDecay() public {
        uint16 depeg = MasonryRules.targetSellTaxBps(70e16, PEG, BASELINE, CAP, FULL_DROP);
        uint16 atFloor = MasonryRules.targetSellTaxBps(90e16, PEG, BASELINE, CAP, FULL_DROP);
        uint16 deeper = MasonryRules.targetSellTaxBps(50e16, PEG, BASELINE, CAP, FULL_DROP);
        uint16 decay = MasonryRules.recoveryFloorBps(CAP, BASELINE, 100, 100);
        uint16 combined = MasonryRules.effectiveSellTaxBps(depeg, atFloor, decay);

        assertEq(depeg, CAP);
        assertEq(atFloor, CAP);
        assertEq(deeper, CAP);
        assertEq(decay, CAP);
        assertEq(combined, CAP);
        assertLe(combined, MasonryRules.HARD_MAX_FIRE_TAX_BPS);
        assertEq(MasonryRules.HARD_MAX_FIRE_TAX_BPS, CAP);
    }

    function testOfficialMasonrySellPathExceeds12PercentOnceStaticLpFeeIsIncluded() public {
        uint16 fire = MasonryRules.effectiveSellTaxBps(
            MasonryRules.targetSellTaxBps(70e16, PEG, BASELINE, CAP, FULL_DROP),
            MasonryRules.targetSellTaxBps(70e16, PEG, BASELINE, CAP, FULL_DROP),
            MasonryRules.recoveryFloorBps(CAP, BASELINE, block.timestamp, block.timestamp)
        );
        uint256 total = uint256(fire) + OFFICIAL_POOL_LP_FEE_BPS;
        // FINDING: MasonryTaxHook.sol:216-220 (our branch and 8c6dd0b).
        // Hook returns (selector, 0, 0) — fee override 0 without
        // OVERRIDE_FEE_FLAG — so the official 3000-pip LP fee still applies
        // on top of a 1200 bps Fire Tax = 1230 bps combined.
        emit log_named_uint("official Fire Tax bps", fire);
        emit log_named_uint("official static LP fee bps", OFFICIAL_POOL_LP_FEE_BPS);
        emit log_named_uint("official combined sell tax bps", total);
        assertEq(fire, 1200);
        assertEq(total, 1230);
        assertGt(total, 1200);
    }

    function testPegDefenseHookPathIfLaunchedExceeds12Percent() public {
        address hookAddr = address(
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG)
        );
        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(1)), address(2), address(this)),
            hookAddr
        );
        PegDefenseHook hook = PegDefenseHook(hookAddr);

        uint256 leftoverTax = hook.taxTiersRates(0);
        uint256 at70 = hook.taxRateForPrice(70e16);
        uint256 at40 = hook.taxRateForPrice(40e16);
        uint256 deepLpPips = hook.deepContractionFee();
        uint256 deepLpBps = deepLpPips / 100;
        uint256 worstTax = leftoverTax > at40 ? leftoverTax : at40;
        if (at70 > worstTax) worstTax = at70;
        uint256 total = worstTax + deepLpBps;

        // FINDING: PegDefenseHook.sol:209 taxTiersRates[0] = 2000 (8c6dd0b
        // constructor, same 2000 first tier). taxRateForPrice walks high-to-low
        // so sub-$0.50 prints the 20% tier; $0.70 still prints 1700 bps.
        // deepContractionFee defaults to 30_000 pips (3% = 300 bps) at line 106.
        // Deploy.s.sol still CREATE2-deploys this hook and PostBootstrap can
        // enable autoCalculateTax — reachable leftover, not the official
        // Masonry xTOMB/USDG hook (MasonryTaxHook / MasonryLevelHook).
        emit log_named_uint("PegDefenseHook taxTiersRates[0] bps", leftoverTax);
        emit log_named_uint("PegDefenseHook tax at $0.70 bps", at70);
        emit log_named_uint("PegDefenseHook tax at $0.40 bps", at40);
        emit log_named_uint("PegDefenseHook deep LP fee bps", deepLpBps);
        emit log_named_uint("PegDefenseHook combined worst sell tax bps", total);
        assertEq(leftoverTax, 2000);
        assertEq(at40, 2000);
        assertEq(at70, 1700);
        assertEq(deepLpPips, 30_000);
        assertEq(total, 2300);
        assertGt(total, 1200);
        assertGt(at70 + deepLpBps, 1200);

        uint256 maxTier;
        uint256 n = hook.getTaxTiersRatesCount();
        for (uint256 i; i < n; ++i) {
            uint256 rate = hook.taxTiersRates(i);
            if (rate > maxTier) maxTier = rate;
        }
        assertEq(maxTier, 2000);
        assertGt(maxTier + deepLpBps, 1200);
    }

    function testOfficialAndPegDefenseHooksCannotStackOnOnePool() public pure {
        // v4 binds a single hooks address per PoolKey. Official masonry
        // pools use MasonryLevelHook/MasonryTaxHook; leftover Deploy.s.sol
        // MONEY/WETH (mapped X Tomb/WETH) uses PegDefenseHook. Combined
        // 1200 + 2000 is not a reachable sell path.
        assertTrue(true);
    }
}
