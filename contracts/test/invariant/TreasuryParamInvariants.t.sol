// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {Treasury} from "../../src/core/Treasury.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";

/**
 * @title TreasuryParamHandler
 * @notice Drives every Trustees-only setter on the Treasury with fuzzer-bounded inputs.
 *         Inputs are bounded to both valid AND invalid ranges so the handler sees a mix of
 *         accept/reject cases (fail_on_revert=false in foundry.toml absorbs the reverts).
 *
 *         The invariants below assert that no SUCCESSFUL setter sequence can push any
 *         parameter out of its declared range — the Treasury's input validation is the
 *         only barrier between an operator and a broken peg.
 */
contract TreasuryParamHandler is Test {
    Treasury public treasury;

    address public daoFund = makeAddr("dao");
    address public devFund = makeAddr("dev");

    constructor(
        Treasury _treasury
    ) {
        treasury = _treasury;
    }

    function setPegPriceCeiling(
        uint256 v
    ) external {
        // pegPriceOne is 1e18. Setter accepts [1e18, 1.2e18]. Bound generously to cover
        // both accept and reject.
        v = bound(v, 0.5e18, 2e18);
        treasury.setPegPriceCeiling(v);
    }

    function setMaxSupplyExpansionPercents(
        uint256 v
    ) external {
        v = bound(v, 0, 2000);
        treasury.setMaxSupplyExpansionPercents(v);
    }

    function setExtraFunds(
        uint256 dao,
        uint256 dev
    ) external {
        dao = bound(dao, 0, 5000);
        dev = bound(dev, 0, 2000);
        treasury.setExtraFunds(daoFund, dao, devFund, dev);
    }

    function setSupplyTiersEntry(
        uint8 idx,
        uint256 v
    ) external {
        idx = uint8(bound(idx, 0, 8));
        v = bound(v, 1, 100_000_000 ether);
        treasury.setSupplyTiersEntry(idx, v);
    }

    function setMaxExpansionTiersEntry(
        uint8 idx,
        uint256 v
    ) external {
        idx = uint8(bound(idx, 0, 8));
        v = bound(v, 0, 2000);
        treasury.setMaxExpansionTiersEntry(idx, v);
    }
}

/**
 * @title TreasuryParamInvariants
 * @notice Param-bound invariants on the Treasury setter surface. The handler drives every
 *         setter with mixed accept/reject inputs; invariants here verify that no successful
 *         sequence ever leaves a parameter outside its documented range.
 *
 *         Setters NOT covered (intentionally — they have no numeric bound to verify):
 *           setOperator, setMasonry, setOracle, setMaxDiscountRate, setMaxPremiumRate.
 *           These rotate addresses or set unbounded rates that the bond-math caps on read.
 */
contract TreasuryParamInvariants is StdInvariant, Test {
    Treasury public treasury;
    TreasuryParamHandler public handler;
    PegToken public peg;

    address constant SHARE = address(0xA3);
    address constant ORACLE = address(0xA4);
    address constant MASONRY = address(0xA5);

    function setUp() public {
        vm.warp(1_700_000_000);
        treasury = new Treasury();
        peg = new PegToken("Peg Token", "PEG"); // needed for initialize()'s balanceOf snapshot

        address[] memory excluded = new address[](0);
        treasury.initialize(address(peg), SHARE, ORACLE, MASONRY, block.timestamp + 1 hours, excluded);

        handler = new TreasuryParamHandler(treasury);
        treasury.setOperator(address(handler));

        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // Bounds — verified after any handler-driven setter sequence
    // ---------------------------------------------------------------------

    function invariant_PegPriceCeilingInBand() public view {
        uint256 c = treasury.pegPriceCeiling();
        uint256 one = treasury.pegPriceOne();
        assertGe(c, one);
        assertLe(c, one * 120 / 100);
    }

    function invariant_MaxSupplyExpansionPercentInBand() public view {
        uint256 v = treasury.maxSupplyExpansionPercent();
        assertGe(v, 10);
        assertLe(v, 1000);
    }

    function invariant_FundSharesInBand() public view {
        assertLe(treasury.daoFundSharedPercent(), 3000);
        assertLe(treasury.devFundSharedPercent(), 1000);
    }

    function invariant_SupplyTiersMonotonic() public view {
        uint256 prev = treasury.supplyTiers(0);
        for (uint256 i = 1; i < 9; ++i) {
            uint256 cur = treasury.supplyTiers(i);
            assertGt(cur, prev, "supplyTiers must be strictly increasing");
            prev = cur;
        }
    }

    function invariant_MaxExpansionTiersInBand() public view {
        for (uint256 i = 0; i < 9; ++i) {
            uint256 v = treasury.maxExpansionTiers(i);
            assertGe(v, 10);
            assertLe(v, 1000);
        }
    }

    function invariant_InitializedSticky() public view {
        assertTrue(treasury.isInitialized());
    }
}
