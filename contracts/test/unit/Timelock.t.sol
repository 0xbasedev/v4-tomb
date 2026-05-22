// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {Timelock} from "../../src/governance/Timelock.sol";

/// @notice A simple counter for testing executeTransaction call-through.
contract CounterTarget {
    uint256 public counter;
    address public lastCaller;
    uint256 public lastValueReceived;

    function bump(
        uint256 delta
    ) external payable returns (uint256) {
        counter += delta;
        lastCaller = msg.sender;
        lastValueReceived = msg.value;
        return counter;
    }
}

contract TimelockTest is BaseTest {
    Timelock internal timelock;
    CounterTarget internal target;

    uint256 internal constant DELAY = 2 days;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        vm.prank(owner);
        timelock = new Timelock(owner, DELAY);
        target = new CounterTarget();
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function test_Constructor_StoresAdminAndDelay() public view {
        assertEq(timelock.admin(), owner);
        assertEq(timelock.delay(), DELAY);
        assertEq(timelock.pendingAdmin(), address(0));
    }

    function test_Constructor_RejectsDelayBelowMinimum() public {
        vm.expectRevert(Timelock.DelayBelowMinimum.selector);
        new Timelock(owner, 23 hours);
    }

    function test_Constructor_RejectsDelayAboveMaximum() public {
        vm.expectRevert(Timelock.DelayAboveMaximum.selector);
        new Timelock(owner, 31 days);
    }

    function test_Constructor_AcceptsBoundaries() public {
        Timelock t1 = new Timelock(owner, 1 days);
        assertEq(t1.delay(), 1 days);
        Timelock t2 = new Timelock(owner, 30 days);
        assertEq(t2.delay(), 30 days);
    }

    function test_Constants() public view {
        assertEq(timelock.MINIMUM_DELAY(), 1 days);
        assertEq(timelock.MAXIMUM_DELAY(), 30 days);
        assertEq(timelock.GRACE_PERIOD(), 14 days);
    }

    // ---------------------------------------------------------------------
    // queueTransaction
    // ---------------------------------------------------------------------

    function test_QueueTransaction_OnlyAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(Timelock.NotAdmin.selector);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), block.timestamp + DELAY);
    }

    function test_QueueTransaction_RejectsEtaTooSoon() public {
        vm.prank(owner);
        vm.expectRevert(Timelock.EtaTooSoon.selector);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), block.timestamp + DELAY - 1);
    }

    function test_QueueTransaction_MarksQueued() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        bytes32 txHash = timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);

        bytes32 expectedHash = keccak256(abi.encode(address(target), uint256(0), "bump(uint256)", abi.encode(1), eta));
        assertEq(txHash, expectedHash);
        assertTrue(timelock.queuedTransactions(txHash));
    }

    // ---------------------------------------------------------------------
    // cancelTransaction
    // ---------------------------------------------------------------------

    function test_CancelTransaction_OnlyAdmin() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);

        vm.prank(stranger);
        vm.expectRevert(Timelock.NotAdmin.selector);
        timelock.cancelTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
    }

    function test_CancelTransaction_UnsetsQueueFlag() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        bytes32 txHash = timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
        assertTrue(timelock.queuedTransactions(txHash));

        vm.prank(owner);
        timelock.cancelTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
        assertFalse(timelock.queuedTransactions(txHash));
    }

    // ---------------------------------------------------------------------
    // executeTransaction
    // ---------------------------------------------------------------------

    function test_ExecuteTransaction_OnlyAdmin() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
        vm.warp(eta);

        vm.prank(stranger);
        vm.expectRevert(Timelock.NotAdmin.selector);
        timelock.executeTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
    }

    function test_ExecuteTransaction_RejectsUnqueued() public {
        uint256 eta = block.timestamp + DELAY;
        vm.warp(eta);
        vm.prank(owner);
        vm.expectRevert(Timelock.TransactionNotQueued.selector);
        timelock.executeTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
    }

    function test_ExecuteTransaction_RejectsBeforeEta() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);

        // Don't warp — still pre-eta.
        vm.prank(owner);
        vm.expectRevert(Timelock.TransactionNotMature.selector);
        timelock.executeTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
    }

    function test_ExecuteTransaction_RejectsAfterGracePeriod() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);

        vm.warp(eta + timelock.GRACE_PERIOD() + 1);
        vm.prank(owner);
        vm.expectRevert(Timelock.TransactionStale.selector);
        timelock.executeTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
    }

    function test_ExecuteTransaction_HappyPath_ChangesTargetState() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(7), eta);

        vm.warp(eta);
        vm.prank(owner);
        timelock.executeTransaction(address(target), 0, "bump(uint256)", abi.encode(7), eta);

        assertEq(target.counter(), 7);
        assertEq(target.lastCaller(), address(timelock));
    }

    function test_ExecuteTransaction_ForwardsValue() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 1 ether, "bump(uint256)", abi.encode(3), eta);

        vm.warp(eta);
        vm.deal(owner, 5 ether);
        vm.prank(owner);
        timelock.executeTransaction{value: 1 ether}(address(target), 1 ether, "bump(uint256)", abi.encode(3), eta);

        assertEq(target.lastValueReceived(), 1 ether);
        assertEq(address(target).balance, 1 ether);
    }

    function test_ExecuteTransaction_UnsetsQueueFlagAfterExecution() public {
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        bytes32 txHash = timelock.queueTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);

        vm.warp(eta);
        vm.prank(owner);
        timelock.executeTransaction(address(target), 0, "bump(uint256)", abi.encode(1), eta);
        assertFalse(timelock.queuedTransactions(txHash));
    }

    function test_ExecuteTransaction_PropagatesTargetRevert() public {
        // Queue a call that targets a method that doesn't exist on the counter —
        // call returns success=true with empty returndata BUT target has no fallback,
        // which on plain `call` returns success=true... so let's instead make it target
        // a contract that reverts. Reuse CounterTarget but use a non-existent selector.
        uint256 eta = block.timestamp + DELAY;
        vm.prank(owner);
        timelock.queueTransaction(address(target), 0, "doesNotExist(uint256)", abi.encode(1), eta);

        vm.warp(eta);
        vm.prank(owner);
        // The target has no matching function — call succeeds with empty data on
        // contracts without a fallback only if there's no payable mismatch. Our target
        // has no fallback, so the EVM returns success=false on missing function call.
        vm.expectRevert(Timelock.TransactionFailed.selector);
        timelock.executeTransaction(address(target), 0, "doesNotExist(uint256)", abi.encode(1), eta);
    }

    // ---------------------------------------------------------------------
    // setDelay — must come from the Timelock itself
    // ---------------------------------------------------------------------

    function test_SetDelay_RejectsExternalCall() public {
        vm.prank(owner);
        vm.expectRevert(Timelock.CallMustComeFromTimelock.selector);
        timelock.setDelay(5 days);
    }

    function test_SetDelay_ViaQueueThenExecute() public {
        uint256 eta = block.timestamp + DELAY;
        bytes memory data = abi.encode(uint256(5 days));

        vm.prank(owner);
        timelock.queueTransaction(address(timelock), 0, "setDelay(uint256)", data, eta);

        vm.warp(eta);
        vm.prank(owner);
        timelock.executeTransaction(address(timelock), 0, "setDelay(uint256)", data, eta);

        assertEq(timelock.delay(), 5 days);
    }

    function test_SetDelay_SelfCallStillEnforcesBounds() public {
        uint256 eta = block.timestamp + DELAY;
        // Try to set below minimum via the queue/execute cycle.
        vm.prank(owner);
        timelock.queueTransaction(address(timelock), 0, "setDelay(uint256)", abi.encode(uint256(23 hours)), eta);

        vm.warp(eta);
        vm.prank(owner);
        vm.expectRevert(Timelock.TransactionFailed.selector); // bubbled-up DelayBelowMinimum
        timelock.executeTransaction(address(timelock), 0, "setDelay(uint256)", abi.encode(uint256(23 hours)), eta);
    }

    // ---------------------------------------------------------------------
    // setPendingAdmin / acceptAdmin
    // ---------------------------------------------------------------------

    function test_SetPendingAdmin_RejectsExternalCall() public {
        vm.prank(owner);
        vm.expectRevert(Timelock.CallMustComeFromTimelock.selector);
        timelock.setPendingAdmin(alice);
    }

    function test_AcceptAdmin_OnlyPendingAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(Timelock.NotPendingAdmin.selector);
        timelock.acceptAdmin();
    }

    function test_FullAdminRotation() public {
        // Queue setPendingAdmin(alice) via the Timelock's own queue/execute path.
        uint256 eta = block.timestamp + DELAY;
        bytes memory data = abi.encode(alice);
        vm.prank(owner);
        timelock.queueTransaction(address(timelock), 0, "setPendingAdmin(address)", data, eta);

        vm.warp(eta);
        vm.prank(owner);
        timelock.executeTransaction(address(timelock), 0, "setPendingAdmin(address)", data, eta);
        assertEq(timelock.pendingAdmin(), alice);

        // Alice accepts directly (no delay on the accept step — Tomb-faithful).
        vm.prank(alice);
        timelock.acceptAdmin();
        assertEq(timelock.admin(), alice);
        assertEq(timelock.pendingAdmin(), address(0));
    }

    // ---------------------------------------------------------------------
    // receive() payable
    // ---------------------------------------------------------------------

    function test_Receive_AcceptsEth() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        (bool ok,) = address(timelock).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(address(timelock).balance, 3 ether);
    }
}
