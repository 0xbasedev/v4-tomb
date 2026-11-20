// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @dev MockOracle plus the sorted pair a real Oracle exposes. Quotes are in the peg
///      token's own decimals, like the real Oracle.
contract PairMockOracle is MockOracle {
    address public token0;
    address public token1;

    constructor(
        uint256 initialPrice,
        address a,
        address b
    ) MockOracle(initialPrice) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }
}

/// @notice The oracle quotes 1 MONEY in raw peg-token units. With a 6-decimal stablecoin at
///         $1.00 that is 1e6. Before the fix the Treasury compared it to 1e18 and saw
///         MONEY at $0.000000000001: permanent contraction, no printing.
contract TreasuryPegDecimalsTest is BaseTest {
    address[] internal none;

    function _treasuryWith(
        uint8 pegDecimals,
        uint256 rawQuote
    ) internal returns (Treasury treasury) {
        vm.startPrank(owner);
        PegToken money = new PegToken(owner);
        MockERC20 peg = new MockERC20("Peg", "PEG", pegDecimals);
        PairMockOracle oracle = new PairMockOracle(rawQuote, address(money), address(peg));
        treasury = new Treasury(owner);
        treasury.initialize(
            address(money),
            makeAddr("note"),
            makeAddr("share"),
            address(oracle),
            makeAddr("room"),
            block.timestamp,
            none
        );
        vm.stopPrank();
    }

    function test_SixDecimalPeg_AtOneDollar_ReadsAsPeg() public {
        Treasury treasury = _treasuryWith(6, 1e6);
        assertEq(treasury.pegPriceScale(), 1e12);
        assertEq(treasury.getMoneyPrice(), treasury.moneyPriceOne(), "$1.00 reads as the peg");
        assertEq(treasury.getMoneyUpdatedPrice(), 1e18);
    }

    function test_SixDecimalPeg_AboveCeiling_ReadsAsExpansion() public {
        Treasury treasury = _treasuryWith(6, 1.05e6);
        assertGt(treasury.getMoneyPrice(), treasury.moneyPriceCeiling(), "$1.05 is above the ceiling");
    }

    function test_EighteenDecimalPeg_Unchanged() public {
        Treasury treasury = _treasuryWith(18, 1e18);
        assertEq(treasury.pegPriceScale(), 1);
        assertEq(treasury.getMoneyPrice(), 1e18);
    }
}
