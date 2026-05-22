// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {OldMoney} from "../../src/tokens/OldMoney.sol";

/**
 * @title OldMoneyHandler
 * @notice Fuzz-target wrapper around OldMoney. The invariant runner calls these external
 *         functions with random arguments; we bound the arguments to valid ranges (correct
 *         actor, balance-bounded amount, etc.) so the handler doesn't waste runs on
 *         obviously-invalid calls.
 *
 *         The handler holds the trustees role on OldMoney so its `mint` action succeeds.
 *         Burn / transfer actions vm.prank an actor so msg.sender inside the token
 *         contract is that actor.
 */
contract OldMoneyHandler is Test {
    OldMoney public oldm;

    address[] public actors;

    // Ghost variables — the handler's view of what the supply *should* be.
    uint256 public ghost_minted;
    uint256 public ghost_burned;

    constructor(
        OldMoney _oldm
    ) {
        oldm = _oldm;
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function mint(
        uint256 actorSeed,
        uint96 amount
    ) external {
        address to = actors[actorSeed % actors.length];
        oldm.mint(to, amount);
        ghost_minted += amount;
    }

    function burn(
        uint256 actorSeed,
        uint256 amount
    ) external {
        address from = actors[actorSeed % actors.length];
        uint256 balance = oldm.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);
        vm.prank(from);
        oldm.burn(amount);
        ghost_burned += amount;
    }

    function transfer(
        uint256 fromSeed,
        uint256 toSeed,
        uint256 amount
    ) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = oldm.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);
        vm.prank(from);
        oldm.transfer(to, amount);
    }
}

/**
 * @title OldMoneyInvariants
 * @notice Properties that must hold across any sequence of mints, burns, and transfers on
 *         the $OLDM token. The constructor mints 1 ether to the deployer (this test
 *         contract), then we hand off trustees to the handler so it can mint freely.
 */
contract OldMoneyInvariants is StdInvariant, Test {
    OldMoney public oldm;
    OldMoneyHandler public handler;

    function setUp() public {
        oldm = new OldMoney();
        handler = new OldMoneyHandler(oldm);
        oldm.transferTrustees(address(handler));

        targetContract(address(handler));
    }

    /// @notice The fundamental supply invariant. The test contract holds 1 ether from
    ///         construction; everything else is tracked by the handler's ghost counters.
    function invariant_TotalSupplyMatchesMintedMinusBurned() public view {
        // Test contract is the deployer → holds the 1 ether construction mint.
        // No actor or handler ever burns that 1 ether (handler only burns from its
        // three actor addresses), so it sits constant in totalSupply.
        uint256 expected = oldm.balanceOf(address(this)) + handler.ghost_minted() - handler.ghost_burned();
        assertEq(oldm.totalSupply(), expected);
    }

    /// @notice No individual balance can exceed the total supply.
    function invariant_NoBalanceExceedsTotalSupply() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            assertLe(oldm.balanceOf(handler.actors(i)), oldm.totalSupply());
        }
    }

    /// @notice The sum of tracked balances (deployer + actors) equals totalSupply.
    ///         Stronger than the "no balance exceeds" invariant.
    function invariant_SumOfBalancesEqualsTotalSupply() public view {
        uint256 sum = oldm.balanceOf(address(this));
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += oldm.balanceOf(handler.actors(i));
        }
        assertEq(sum, oldm.totalSupply());
    }
}
