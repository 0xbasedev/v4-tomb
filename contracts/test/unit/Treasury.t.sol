// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Estate} from "../../src/tokens/Estate.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Trustees} from "../../src/governance/Trustees.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TreasuryTest is BaseTest {
    Treasury internal treasury;
    Boardroom internal boardroom;
    OldMoney internal money;
    Estate internal estate;
    TrustNote internal trustnote;
    MockOracle internal oracle;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    address internal daoFund = makeAddr("daoFund");

    uint256 internal startTime;

    function setUp() public override {
        super.setUp();
        vm.label(communityFund, "communityFund");
        vm.label(devFund, "devFund");
        vm.label(daoFund, "daoFund");

        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;

        // 1. Deploy tokens (deployer = owner becomes trustees on each).
        vm.startPrank(owner);
        money = new OldMoney();
        estate = new Estate(startTime, communityFund, devFund);
        trustnote = new TrustNote();
        vm.stopPrank();

        // 2. Deploy oracle (mocked) — initialize at parity.
        oracle = new MockOracle(1e18);

        // 3. Deploy Treasury and Boardroom.
        vm.startPrank(owner);
        treasury = new Treasury();
        boardroom = new Boardroom();

        // 4. Initialize Boardroom (owner becomes operator).
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        // 5. Initialize Treasury (owner becomes operator).
        address[] memory excluded = new address[](0);
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            startTime,
            excluded
        );

        // 6. Transfer mint authority on every token + boardroom to the Treasury.
        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Initialize / wiring
    // ---------------------------------------------------------------------

    function test_Initialize_StoresAddresses() public view {
        assertEq(treasury.money(), address(money));
        assertEq(treasury.trustnote(), address(trustnote));
        assertEq(treasury.estate(), address(estate));
        assertEq(treasury.oracle(), address(oracle));
        assertEq(treasury.boardroom(), address(boardroom));
        assertEq(treasury.startTime(), startTime);
        assertEq(treasury.operator(), owner);
        assertTrue(treasury.isInitialized());
    }

    function test_Initialize_SetsPegToCbethParity() public view {
        assertEq(treasury.moneyPriceOne(), 1e18); // 1 MONEY = 1 cbETH
        assertEq(treasury.moneyPriceCeiling(), 1.01e18);
    }

    function test_Initialize_SetsTombSupplyTiers() public view {
        assertEq(treasury.supplyTiers(0), 0);
        assertEq(treasury.supplyTiers(8), 50_000_000 ether);
        assertEq(treasury.maxExpansionTiers(0), 450);
        assertEq(treasury.maxExpansionTiers(8), 100);
    }

    function test_Initialize_SetsTombFaithfulBootstrap() public view {
        // Per docs/TOMB_AUDIT.md BUG #1 fix: bootstrapEpochs = 28, bootstrapSupplyExpansionPercent = 450.
        // Mirrors Tomb's actual launch behavior per docs/tomb-skill/references/HOW_IT_WORKED.md.
        assertEq(treasury.bootstrapEpochs(), 28);
        assertEq(treasury.bootstrapSupplyExpansionPercent(), 450);
    }

    function test_Initialize_SetsTombFaithfulMaxDebtRatio() public view {
        // Per docs/TOMB_AUDIT.md BUG #2 fix: 3500 bps (35%) matches Tomb. Previously was 4500.
        assertEq(treasury.maxDebtRatioPercent(), 3500);
    }

    function test_Initialize_OneShot() public {
        address[] memory excluded = new address[](0);
        vm.prank(owner);
        vm.expectRevert(Treasury.AlreadyInitialized.selector);
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            startTime,
            excluded
        );
    }

    function test_CheckOperator_PassesAfterHandoff() public view {
        // All four operator handoffs done in setUp(). The treasury can read its own
        // status via the public storage views; checkOperator is implicitly exercised
        // by any function call that uses it (covered below).
        assertEq(money.operator(), address(treasury));
        assertEq(estate.operator(), address(treasury));
        assertEq(trustnote.operator(), address(treasury));
        assertEq(boardroom.operator(), address(treasury));
    }

    // ---------------------------------------------------------------------
    // Pricing views
    // ---------------------------------------------------------------------

    function test_GetMoneyPrice_PassesThroughOracle() public {
        oracle.setPrice(1.05e18);
        assertEq(treasury.getMoneyPrice(), 1.05e18);

        oracle.setPrice(0.9e18);
        assertEq(treasury.getMoneyPrice(), 0.9e18);
    }

    function test_GetBondDiscountRate_ZeroWhenAtPeg() public {
        oracle.setPrice(1e18);
        // discountPercent default 0 → rate = moneyPriceOne (no discount)
        assertEq(treasury.getBondDiscountRate(), 1e18);
    }

    function test_GetBondDiscountRate_AppliesDiscountBelowPeg() public {
        // Set 10% discount factor, 10% below peg.
        vm.prank(owner);
        treasury.setDiscountPercent(1000);
        oracle.setPrice(0.9e18);

        // Tomb math: bondAmount = moneyPriceOne * 1e18 / price = 1e18 * 1e18 / 9e17 = 1.111e18
        //             discountAmount = (bondAmount - moneyPriceOne) * discountPercent / 10000
        //                             = (1.111e18 - 1e18) * 1000 / 10000 = 0.0111e18
        //             rate = moneyPriceOne + discountAmount ≈ 1.0111e18
        assertApproxEqRel(treasury.getBondDiscountRate(), 1.0111e18, 0.001e18);
    }

    function test_GetBondPremiumRate_ZeroAtPeg() public view {
        // price not above ceiling → 0
        assertEq(treasury.getBondPremiumRate(), 0);
    }

    function test_GetBondPremiumRate_AboveThreshold() public {
        // premiumThreshold = 110 → premiumThresholdAbs = 1.1e18
        oracle.setPrice(1.15e18);
        // premiumPercent = 7000 → premiumAmount = (1.15e18 - 1e18) * 7000 / 10000 = 0.105e18
        // rate = 1e18 + 0.105e18 = 1.105e18
        assertApproxEqRel(treasury.getBondPremiumRate(), 1.105e18, 0.001e18);
    }

    // ---------------------------------------------------------------------
    // Governance setters
    // ---------------------------------------------------------------------

    function test_SetOperator_OnlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setOperator(alice);
    }

    function test_SetOperator_Rotates() public {
        vm.prank(owner);
        treasury.setOperator(alice);
        assertEq(treasury.operator(), alice);
    }

    function test_SetMoneyPriceCeiling_BoundsChecked() public {
        // Must be in [moneyPriceOne, 1.20 * moneyPriceOne].
        vm.prank(owner);
        vm.expectRevert(Treasury.CeilingOutOfRange.selector);
        treasury.setMoneyPriceCeiling(0.99e18);

        vm.prank(owner);
        vm.expectRevert(Treasury.CeilingOutOfRange.selector);
        treasury.setMoneyPriceCeiling(1.21e18);

        vm.prank(owner);
        treasury.setMoneyPriceCeiling(1.05e18);
        assertEq(treasury.moneyPriceCeiling(), 1.05e18);
    }

    function test_SetDiscountPercent_Caps() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.DiscountPercentTooHigh.selector);
        treasury.setDiscountPercent(20_001);

        vm.prank(owner);
        treasury.setDiscountPercent(5000);
        assertEq(treasury.discountPercent(), 5000);
    }

    function test_SetExtraFunds_StoresAddressesAndShares() public {
        vm.prank(owner);
        treasury.setExtraFunds(daoFund, 2000, devFund, 500);
        assertEq(treasury.daoFund(), daoFund);
        assertEq(treasury.daoFundSharedPercent(), 2000);
        assertEq(treasury.devFund(), devFund);
        assertEq(treasury.devFundSharedPercent(), 500);
    }

    function test_SetExtraFunds_RejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.setExtraFunds(address(0), 1000, devFund, 500);

        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.setExtraFunds(daoFund, 1000, address(0), 500);
    }

    function test_SetExtraFunds_RejectsExcessiveShares() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.FundShareOutOfRange.selector);
        treasury.setExtraFunds(daoFund, 3001, devFund, 500);

        vm.prank(owner);
        vm.expectRevert(Treasury.FundShareOutOfRange.selector);
        treasury.setExtraFunds(daoFund, 1000, devFund, 1001);
    }

    // ---------------------------------------------------------------------
    // governanceRecoverUnsupported: protected tokens
    // ---------------------------------------------------------------------

    function test_GovernanceRecoverUnsupported_BlocksCoreTokens() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ProtectedToken.selector);
        treasury.governanceRecoverUnsupported(IERC20(address(money)), 1, alice);

        vm.prank(owner);
        vm.expectRevert(Treasury.ProtectedToken.selector);
        treasury.governanceRecoverUnsupported(IERC20(address(trustnote)), 1, alice);

        vm.prank(owner);
        vm.expectRevert(Treasury.ProtectedToken.selector);
        treasury.governanceRecoverUnsupported(IERC20(address(estate)), 1, alice);
    }

    // ---------------------------------------------------------------------
    // checkCondition: not started yet
    // ---------------------------------------------------------------------

    function test_BuyBonds_RevertsBeforeStartTime() public {
        // startTime is block.timestamp + 1 hours per setUp(); we're before it.
        oracle.setPrice(0.9e18);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotStarted.selector);
        treasury.buyBonds(1 ether, 0.9e18);
    }
}
