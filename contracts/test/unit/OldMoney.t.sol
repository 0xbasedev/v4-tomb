// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract OldMoneyTest is BaseTest {
    OldMoney internal oldm;

    event TrusteesSet(address indexed previousTrustees, address indexed newTrustees);
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
    event Coined(address indexed to, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Paused(address account);
    event Unpaused(address account);

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        oldm = new OldMoney(owner);

        vm.startPrank(owner);
        oldm.setTrustees(trustees);
        oldm.setGuardian(guardian);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Constructor / metadata
    // ---------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(oldm.name(), "Old Money");
        assertEq(oldm.symbol(), "OLDM");
        assertEq(oldm.decimals(), 18);
    }

    function test_Constructor_SetsOwner() public view {
        assertEq(oldm.owner(), owner);
    }

    function test_Constructor_NoSupplyMintedAtDeploy() public {
        vm.prank(owner);
        OldMoney fresh = new OldMoney(owner);
        assertEq(fresh.totalSupply(), 0);
    }

    // ---------------------------------------------------------------------
    // Trustees rotation
    // ---------------------------------------------------------------------

    function test_SetTrustees_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oldm.setTrustees(alice);
    }

    function test_SetTrustees_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(OldMoney.ZeroAddress.selector);
        oldm.setTrustees(address(0));
    }

    function test_SetTrustees_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit TrusteesSet(trustees, alice);
        vm.prank(owner);
        oldm.setTrustees(alice);
        assertEq(oldm.trustees(), alice);
    }

    // ---------------------------------------------------------------------
    // Guardian rotation
    // ---------------------------------------------------------------------

    function test_SetGuardian_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oldm.setGuardian(alice);
    }

    function test_SetGuardian_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(OldMoney.ZeroAddress.selector);
        oldm.setGuardian(address(0));
    }

    function test_SetGuardian_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit GuardianSet(guardian, alice);
        vm.prank(owner);
        oldm.setGuardian(alice);
        assertEq(oldm.guardian(), alice);
    }

    // ---------------------------------------------------------------------
    // Mint authority
    // ---------------------------------------------------------------------

    function test_Mint_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(OldMoney.NotTrustees.selector);
        oldm.mint(alice, 1 ether);
    }

    function test_Mint_OwnerCannotMint() public {
        vm.prank(owner);
        vm.expectRevert(OldMoney.NotTrustees.selector);
        oldm.mint(alice, 1 ether);
    }

    function test_Mint_EmitsCoinedAndTransfer() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 1 ether);
        vm.expectEmit(true, true, true, true);
        emit Coined(alice, 1 ether);

        vm.prank(trustees);
        oldm.mint(alice, 1 ether);

        assertEq(oldm.balanceOf(alice), 1 ether);
        assertEq(oldm.totalSupply(), 1 ether);
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(guardian);
        oldm.pause();

        vm.prank(trustees);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oldm.mint(alice, 1 ether);
    }

    // ---------------------------------------------------------------------
    // Burn (ERC20Burnable)
    // ---------------------------------------------------------------------

    function test_Burn_HolderCanBurnOwnBalance() public {
        vm.prank(trustees);
        oldm.mint(alice, 5 ether);

        vm.prank(alice);
        oldm.burn(2 ether);

        assertEq(oldm.balanceOf(alice), 3 ether);
        assertEq(oldm.totalSupply(), 3 ether);
    }

    function test_BurnFrom_RequiresAllowance() public {
        vm.prank(trustees);
        oldm.mint(alice, 5 ether);

        // bob has no allowance — must revert
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 2 ether));
        oldm.burnFrom(alice, 2 ether);

        // grant allowance, then burn succeeds
        vm.prank(alice);
        oldm.approve(bob, 2 ether);

        vm.prank(bob);
        oldm.burnFrom(alice, 2 ether);

        assertEq(oldm.balanceOf(alice), 3 ether);
        assertEq(oldm.allowance(alice, bob), 0);
    }

    function test_Burn_RevertsWhenPaused() public {
        vm.prank(trustees);
        oldm.mint(alice, 5 ether);

        vm.prank(guardian);
        oldm.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oldm.burn(1 ether);
    }

    // ---------------------------------------------------------------------
    // Pause control
    // ---------------------------------------------------------------------

    function test_Pause_OnlyGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(OldMoney.NotGuardian.selector);
        oldm.pause();
    }

    function test_Pause_OwnerCannotPause() public {
        vm.prank(owner);
        vm.expectRevert(OldMoney.NotGuardian.selector);
        oldm.pause();
    }

    function test_Pause_BlocksTransfers() public {
        vm.prank(trustees);
        oldm.mint(alice, 5 ether);

        vm.prank(guardian);
        oldm.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oldm.transfer(bob, 1 ether);
    }

    function test_Pause_EmitsPaused() public {
        vm.expectEmit(true, true, true, true);
        emit Paused(guardian);
        vm.prank(guardian);
        oldm.pause();
        assertTrue(oldm.paused());
    }

    function test_Unpause_RestoresTransfers() public {
        vm.prank(trustees);
        oldm.mint(alice, 5 ether);

        vm.prank(guardian);
        oldm.pause();

        vm.expectEmit(true, true, true, true);
        emit Unpaused(guardian);
        vm.prank(guardian);
        oldm.unpause();

        vm.prank(alice);
        oldm.transfer(bob, 1 ether);
        assertEq(oldm.balanceOf(bob), 1 ether);
    }

    // ---------------------------------------------------------------------
    // Ownership transfer (Ownable2Step)
    // ---------------------------------------------------------------------

    function test_OwnershipTransfer_TwoStep() public {
        vm.prank(owner);
        oldm.transferOwnership(alice);

        // owner has not changed yet — pending acceptance
        assertEq(oldm.owner(), owner);
        assertEq(oldm.pendingOwner(), alice);

        vm.prank(alice);
        oldm.acceptOwnership();
        assertEq(oldm.owner(), alice);
        assertEq(oldm.pendingOwner(), address(0));
    }

    function test_OwnershipTransfer_NonPendingCannotAccept() public {
        vm.prank(owner);
        oldm.transferOwnership(alice);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        oldm.acceptOwnership();
    }

    // ---------------------------------------------------------------------
    // EIP-2612 Permit
    // ---------------------------------------------------------------------

    function test_Permit_GaslessApproval() public {
        (uint256 pk, address holder) = _makeSigner("permit_holder");

        vm.prank(trustees);
        oldm.mint(holder, 10 ether);

        uint256 nonce = oldm.nonces(holder);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 value = 5 ether;
        address spender = bob;

        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, holder, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", oldm.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        oldm.permit(holder, spender, value, deadline, v, r, s);

        assertEq(oldm.allowance(holder, spender), value);
        assertEq(oldm.nonces(holder), nonce + 1);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_Mint_IncreasesSupplyByExactly(
        uint96 amount
    ) public {
        vm.prank(trustees);
        oldm.mint(alice, amount);
        assertEq(oldm.totalSupply(), amount);
        assertEq(oldm.balanceOf(alice), amount);
    }

    function testFuzz_Burn_DecreasesSupplyByExactly(
        uint96 mintAmount,
        uint96 burnAmount
    ) public {
        vm.assume(burnAmount <= mintAmount);
        vm.prank(trustees);
        oldm.mint(alice, mintAmount);

        vm.prank(alice);
        oldm.burn(burnAmount);

        assertEq(oldm.totalSupply(), uint256(mintAmount) - uint256(burnAmount));
        assertEq(oldm.balanceOf(alice), uint256(mintAmount) - uint256(burnAmount));
    }
}
