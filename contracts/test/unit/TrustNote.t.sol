// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TrustNoteTest is BaseTest {
    TrustNote internal bond;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        bond = new TrustNote();
        vm.prank(owner);
        bond.transferTrustees(trustees);
    }

    // ---------------------------------------------------------------------
    // Constructor / metadata
    // ---------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(bond.name(), "Trust Note");
        assertEq(bond.symbol(), "TRUSTNOTE");
        assertEq(bond.decimals(), 18);
    }

    function test_Constructor_NoInitialSupply() public {
        vm.prank(alice);
        TrustNote fresh = new TrustNote();
        assertEq(fresh.totalSupply(), 0);
        assertEq(fresh.balanceOf(alice), 0);
        assertEq(fresh.owner(), alice);
        assertEq(fresh.trustees(), alice);
    }

    // ---------------------------------------------------------------------
    // mint — Tomb signature, returns bool, trustees-only
    // ---------------------------------------------------------------------

    function test_Mint_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        bond.mint(alice, 1 ether);
    }

    function test_Mint_OwnerCannotMint() public {
        vm.prank(owner);
        vm.expectRevert(Trustees.NotTrustees.selector);
        bond.mint(alice, 1 ether);
    }

    function test_Mint_ReturnsTrueOnPositiveAmount() public {
        vm.prank(trustees);
        bool ok = bond.mint(alice, 1 ether);
        assertTrue(ok);
        assertEq(bond.balanceOf(alice), 1 ether);
    }

    function test_Mint_ReturnsFalseOnZeroAmount() public {
        vm.prank(trustees);
        bool ok = bond.mint(alice, 0);
        assertFalse(ok);
        assertEq(bond.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------------
    // burn / burnFrom — public self-burn, trustees-only burnFrom
    // ---------------------------------------------------------------------

    function test_Burn_HolderCanBurnOwnBalance() public {
        vm.prank(trustees);
        bond.mint(alice, 5 ether);
        vm.prank(alice);
        bond.burn(2 ether);
        assertEq(bond.balanceOf(alice), 3 ether);
        assertEq(bond.totalSupply(), 3 ether);
    }

    function test_BurnFrom_OnlyTrustees() public {
        vm.prank(trustees);
        bond.mint(alice, 5 ether);
        vm.prank(alice);
        bond.approve(bob, 5 ether);

        // bob has allowance but is not trustees — must revert.
        vm.prank(bob);
        vm.expectRevert(Trustees.NotTrustees.selector);
        bond.burnFrom(alice, 1 ether);
    }

    function test_BurnFrom_TrusteesNeedsAllowance() public {
        vm.prank(trustees);
        bond.mint(alice, 5 ether);

        // No allowance — trustees cannot burnFrom.
        vm.prank(trustees);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, trustees, 0, 1 ether));
        bond.burnFrom(alice, 1 ether);

        // With allowance, trustees can burnFrom.
        vm.prank(alice);
        bond.approve(trustees, 1 ether);
        vm.prank(trustees);
        bond.burnFrom(alice, 1 ether);
        assertEq(bond.balanceOf(alice), 4 ether);
    }

    // ---------------------------------------------------------------------
    // Trustees rotation
    // ---------------------------------------------------------------------

    function test_TransferTrustees_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        bond.transferTrustees(alice);
    }

    function test_TransferTrustees_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(Trustees.ZeroTrusteesAddress.selector);
        bond.transferTrustees(address(0));
    }

    function test_TransferTrustees_RotatesAuthority() public {
        vm.prank(owner);
        bond.transferTrustees(alice);
        assertEq(bond.trustees(), alice);

        // Old trustees can no longer mint.
        vm.prank(trustees);
        vm.expectRevert(Trustees.NotTrustees.selector);
        bond.mint(bob, 1 ether);

        // New trustees can.
        vm.prank(alice);
        bond.mint(bob, 1 ether);
        assertEq(bond.balanceOf(bob), 1 ether);
    }

    // ---------------------------------------------------------------------
    // Ownership transfer
    // ---------------------------------------------------------------------

    function test_OwnershipTransfer_TwoStep() public {
        vm.prank(owner);
        bond.transferOwnership(alice);
        assertEq(bond.owner(), owner);
        assertEq(bond.pendingOwner(), alice);

        vm.prank(alice);
        bond.acceptOwnership();
        assertEq(bond.owner(), alice);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_Mint_IncreasesSupplyByExactly(
        uint96 amount
    ) public {
        vm.prank(trustees);
        bond.mint(alice, amount);
        assertEq(bond.totalSupply(), amount);
        assertEq(bond.balanceOf(alice), amount);
    }
}
