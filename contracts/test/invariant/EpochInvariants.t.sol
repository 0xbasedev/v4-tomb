// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {Epoch} from "../../src/libs/Epoch.sol";

/**
 * @title EpochHarness
 * @notice Concrete child of the abstract Epoch base. Exposes a `tick()` gated by checkEpoch
 *         so the invariant handler can drive epoch advancement.
 */
contract EpochHarness is Epoch {
    constructor(uint256 period_, uint256 startTime_) Epoch(period_, startTime_, 0) {}

    /// @notice Trustees-pre-epoch + permissionless-post-epoch — same modifier semantics as
    ///         every real Epoch consumer (Treasury, Oracle).
    function tick() external checkEpoch {}
}

/**
 * @title EpochHandler
 * @notice Drives time forward + calls tick(). Ghost-tracks tick() calls so the invariant
 *         can compare counter movement against externally-observed time progression.
 */
contract EpochHandler is Test {
    EpochHarness public harness;
    uint256 public ghost_tickCalls;
    uint256 public ghost_lastEpochSeen;

    constructor(EpochHarness _harness) {
        harness = _harness;
        ghost_lastEpochSeen = _harness.getCurrentEpoch();
    }

    /// @notice Advance block time by a fuzzer-chosen delta (bounded 1s..2 days), then attempt
    ///         a tick. Some ticks will be pre-epoch (trustees-only) and succeed silently;
    ///         others will be post-epoch and advance the counter by 1+.
    function advanceAndTick(uint256 deltaSec) external {
        deltaSec = bound(deltaSec, 1, 2 days);
        vm.warp(block.timestamp + deltaSec);

        // This contract is trustees (set in setUp via transferTrustees), so the pre-epoch
        // path succeeds; the post-epoch path also succeeds and advances the counter.
        harness.tick();
        ghost_tickCalls++;
        ghost_lastEpochSeen = harness.getCurrentEpoch();
    }

    /// @notice Re-set the period within the allowed range to test that the new period
    ///         is honored on the next nextEpochPoint() calculation.
    function setPeriod(uint256 newPeriod) external {
        newPeriod = bound(newPeriod, 1 hours, 48 hours);
        harness.setPeriod(newPeriod);
    }
}

/**
 * @title EpochInvariants
 * @notice Properties that must hold over any sequence of time advances + ticks.
 */
contract EpochInvariants is StdInvariant, Test {
    EpochHarness public harness;
    EpochHandler public handler;

    uint256 internal startTime;

    function setUp() public {
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        harness = new EpochHarness(6 hours, startTime);

        handler = new EpochHandler(harness);
        // Hand off trustees so the handler can call the checkEpoch-gated tick() and
        // setPeriod() (which is onlyTrustees).
        harness.transferTrustees(address(handler));

        targetContract(address(handler));
    }

    /// @notice Period stays within Tomb's [1 hour, 48 hours] bounds. setPeriod reverts
    ///         outside this range, so any successful setter sequence keeps it in band.
    function invariant_PeriodWithinBounds() public view {
        uint256 p = harness.getPeriod();
        assertGe(p, 1 hours);
        assertLe(p, 48 hours);
    }

    /// @notice nextEpochPoint() == lastEpochTime + period at all times. This is the core
    ///         relation the checkEpoch modifier relies on.
    function invariant_NextEpochPointFormula() public view {
        assertEq(harness.nextEpochPoint(), harness.getLastEpochTime() + harness.getPeriod());
    }

    /// @notice The internal epoch counter is monotonic — never decreases. Captured against
    ///         the handler's ghost of the last counter value it saw post-tick.
    function invariant_EpochMonotonic() public view {
        assertGe(harness.getCurrentEpoch(), handler.ghost_lastEpochSeen());
    }

    /// @notice The start time is immutable post-construction (no setter exists; this catches
    ///         a future refactor that accidentally introduces one).
    function invariant_StartTimeImmutable() public view {
        assertEq(harness.getStartTime(), startTime);
    }
}
