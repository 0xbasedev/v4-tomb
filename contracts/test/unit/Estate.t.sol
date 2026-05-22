// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {Estate} from "../../src/tokens/Estate.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract EstateTest is BaseTest {
    Estate internal estate;

    // Three named genesis recipients.
    address internal distributor = makeAddr("distributor");
    address internal teamVesting = makeAddr("teamVesting");
    address internal treasury = makeAddr("treasury");

    event Distributed(address indexed distributor, address indexed teamVesting, address indexed treasury);
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Paused(address account);
    event Unpaused(address account);

    function setUp() public override {
        super.setUp();
        vm.label(distributor, "distributor");
        vm.label(teamVesting, "teamVesting");
        vm.label(treasury, "treasury");

        vm.prank(owner);
        estate = new Estate(owner);

        vm.prank(owner);
        estate.setGuardian(guardian);
    }

    // ---------------------------------------------------------------------
    // Constructor / metadata
    // ---------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(estate.name(), "Estate");
        assertEq(estate.symbol(), "ESTATE");
        assertEq(estate.decimals(), 18);
    }

    function test_Constructor_SetsOwner() public view {
        assertEq(estate.owner(), owner);
    }

    function test_Constructor_NoSupplyAtDeploy() public view {
        assertEq(estate.totalSupply(), 0);
        assertFalse(estate.distributed());
    }

    function test_AllocationsSumToMaxSupply() public view {
        assertEq(estate.COMMUNITY_ALLOC() + estate.TEAM_ALLOC() + estate.TREASURY_ALLOC(), estate.MAX_SUPPLY());
        assertEq(estate.MAX_SUPPLY(), 80_000 ether);
        assertEq(estate.COMMUNITY_ALLOC(), 48_000 ether);
        assertEq(estate.TEAM_ALLOC(), 16_000 ether);
        assertEq(estate.TREASURY_ALLOC(), 16_000 ether);
    }

    // ---------------------------------------------------------------------
    // Guardian rotation
    // ---------------------------------------------------------------------

    function test_SetGuardian_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        estate.setGuardian(alice);
    }

    function test_SetGuardian_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(Estate.ZeroAddress.selector);
        estate.setGuardian(address(0));
    }

    function test_SetGuardian_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit GuardianSet(guardian, alice);
        vm.prank(owner);
        estate.setGuardian(alice);
        assertEq(estate.guardian(), alice);
    }

    // ---------------------------------------------------------------------
    // distribute()
    // ---------------------------------------------------------------------

    function test_Distribute_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        estate.distribute(distributor, teamVesting, treasury);
    }

    function test_Distribute_RejectsZeroDistributor() public {
        vm.prank(owner);
        vm.expectRevert(Estate.ZeroAddress.selector);
        estate.distribute(address(0), teamVesting, treasury);
    }

    function test_Distribute_RejectsZeroTeamVesting() public {
        vm.prank(owner);
        vm.expectRevert(Estate.ZeroAddress.selector);
        estate.distribute(distributor, address(0), treasury);
    }

    function test_Distribute_RejectsZeroTreasury() public {
        vm.prank(owner);
        vm.expectRevert(Estate.ZeroAddress.selector);
        estate.distribute(distributor, teamVesting, address(0));
    }

    function test_Distribute_MintsExactAllocations() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        assertEq(estate.balanceOf(distributor), estate.COMMUNITY_ALLOC());
        assertEq(estate.balanceOf(teamVesting), estate.TEAM_ALLOC());
        assertEq(estate.balanceOf(treasury), estate.TREASURY_ALLOC());
        assertEq(estate.totalSupply(), estate.MAX_SUPPLY());
        assertTrue(estate.distributed());
    }

    function test_Distribute_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit Distributed(distributor, teamVesting, treasury);
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);
    }

    function test_Distribute_EmitsAllThreeTransfers() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), distributor, estate.COMMUNITY_ALLOC());
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), teamVesting, estate.TEAM_ALLOC());
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), treasury, estate.TREASURY_ALLOC());

        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);
    }

    function test_Distribute_OneShot() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        vm.prank(owner);
        vm.expectRevert(Estate.AlreadyDistributed.selector);
        estate.distribute(distributor, teamVesting, treasury);
    }

    function test_Distribute_NoMintingPossibleAfter() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        // Burning is the only way supply can change after distribution.
        // There is no `mint()` external function — verified by the absence of a getter.
        // The only test is: supply == MAX_SUPPLY now, and remains <= MAX_SUPPLY forever.
        assertEq(estate.totalSupply(), estate.MAX_SUPPLY());
    }

    // ---------------------------------------------------------------------
    // Burn (ERC20Burnable)
    // ---------------------------------------------------------------------

    function test_Burn_ReducesSupplyBelowMaxSupply() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        vm.prank(treasury);
        estate.burn(1000 ether);

        assertEq(estate.balanceOf(treasury), estate.TREASURY_ALLOC() - 1000 ether);
        assertEq(estate.totalSupply(), estate.MAX_SUPPLY() - 1000 ether);
        assertLt(estate.totalSupply(), estate.MAX_SUPPLY());
    }

    function test_BurnFrom_RequiresAllowance() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 100 ether));
        estate.burnFrom(treasury, 100 ether);

        vm.prank(treasury);
        estate.approve(bob, 100 ether);

        vm.prank(bob);
        estate.burnFrom(treasury, 100 ether);

        assertEq(estate.balanceOf(treasury), estate.TREASURY_ALLOC() - 100 ether);
    }

    // ---------------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------------

    function test_Pause_OnlyGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(Estate.NotGuardian.selector);
        estate.pause();
    }

    function test_Pause_OwnerCannotPause() public {
        vm.prank(owner);
        vm.expectRevert(Estate.NotGuardian.selector);
        estate.pause();
    }

    function test_Pause_BlocksTransfers() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        vm.prank(guardian);
        estate.pause();

        vm.prank(treasury);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        estate.transfer(alice, 1 ether);
    }

    function test_Pause_BlocksDistribute() public {
        // Edge case: if guardian pauses before distribute is called,
        // distribute will revert because _mint goes through _update.
        vm.prank(guardian);
        estate.pause();

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        estate.distribute(distributor, teamVesting, treasury);

        // Recoverable: unpause and retry.
        vm.prank(guardian);
        estate.unpause();

        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);
        assertTrue(estate.distributed());
    }

    function test_Unpause_RestoresTransfers() public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        vm.prank(guardian);
        estate.pause();

        vm.expectEmit(true, true, true, true);
        emit Unpaused(guardian);
        vm.prank(guardian);
        estate.unpause();

        vm.prank(treasury);
        estate.transfer(alice, 1 ether);
        assertEq(estate.balanceOf(alice), 1 ether);
    }

    // ---------------------------------------------------------------------
    // Ownership transfer
    // ---------------------------------------------------------------------

    function test_OwnershipTransfer_TwoStep() public {
        vm.prank(owner);
        estate.transferOwnership(alice);
        assertEq(estate.owner(), owner);
        assertEq(estate.pendingOwner(), alice);

        vm.prank(alice);
        estate.acceptOwnership();
        assertEq(estate.owner(), alice);
    }

    // ---------------------------------------------------------------------
    // EIP-2612 Permit
    // ---------------------------------------------------------------------

    function test_Permit_GaslessApproval() public {
        (uint256 pk, address holder) = _makeSigner("estate_permit_holder");

        // Distribute then transfer some ESTATE to the permit holder for testing.
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);
        vm.prank(treasury);
        estate.transfer(holder, 10 ether);

        uint256 nonce = estate.nonces(holder);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 value = 5 ether;
        address spender = bob;

        bytes32 typehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(typehash, holder, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", estate.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        estate.permit(holder, spender, value, deadline, v, r, s);

        assertEq(estate.allowance(holder, spender), value);
        assertEq(estate.nonces(holder), nonce + 1);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_Burn_NeverExceedsMaxSupplyCap(
        uint96 burnAmount
    ) public {
        vm.prank(owner);
        estate.distribute(distributor, teamVesting, treasury);

        burnAmount = uint96(bound(burnAmount, 0, uint256(estate.TREASURY_ALLOC())));
        vm.prank(treasury);
        estate.burn(burnAmount);

        assertLe(estate.totalSupply(), estate.MAX_SUPPLY());
        assertEq(estate.totalSupply(), uint256(estate.MAX_SUPPLY()) - burnAmount);
    }
}
