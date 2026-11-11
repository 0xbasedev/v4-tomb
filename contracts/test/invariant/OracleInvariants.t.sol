// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {Oracle} from "../../src/oracle/Oracle.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

/**
 * @title MockPriceSource
 * @notice Poke-able IPriceSource. The handler advances the tick cumulative each turn so the
 *         oracle has something fresh to consume on `update()`.
 */
contract MockPriceSource is IPriceSource {
    int56 public cumulative;
    uint32 public ts;

    function set(
        int56 _c,
        uint32 _ts
    ) external {
        cumulative = _c;
        ts = _ts;
    }

    function getCurrentTickCumulative() external view returns (int56, uint32) {
        return (cumulative, ts);
    }
}

contract OracleHandler is Test {
    Oracle public oracle;
    MockPriceSource public source;

    /// @notice Highest blockTimestampLast the handler has observed post-update. Used to assert
    ///         monotonicity from the invariant.
    uint32 public ghost_maxBlockTs;
    /// @notice Captures whether a successful (timeElapsed > 0) update has ever been done.
    bool public ghost_everUpdated;

    constructor(
        Oracle _oracle,
        MockPriceSource _source
    ) {
        oracle = _oracle;
        source = _source;
    }

    /// @notice Push the mock source forward, then call update. The fuzzer chooses tick
    ///         delta (bounded) and time delta (bounded).
    function advanceAndUpdate(
        int56 tickDelta,
        uint32 timeDelta
    ) external {
        // Bound tick delta to a sane range — ticks are bounded by TickMath.MIN/MAX but
        // the per-update delta in real swaps would be much smaller.
        if (tickDelta > int56(1_000_000)) tickDelta = int56(1_000_000);
        if (tickDelta < int56(-1_000_000)) tickDelta = int56(-1_000_000);
        // Bound time delta to 1..1 day so we don't blow past uint32 limits.
        timeDelta = uint32(bound(uint256(timeDelta), 1, 1 days));

        int56 newCumulative = source.cumulative() + tickDelta;
        uint32 newTs = source.ts() + timeDelta;
        source.set(newCumulative, newTs);

        // Advance block time so checkEpoch in update() doesn't gate us off forever.
        vm.warp(block.timestamp + timeDelta);

        // Trustees-pre-epoch + permissionless-post-epoch.
        oracle.update();

        uint32 reportedTs = oracle.blockTimestampLast();
        if (reportedTs > ghost_maxBlockTs) {
            ghost_maxBlockTs = reportedTs;
            ghost_everUpdated = true;
        }
    }
}

contract OracleInvariants is StdInvariant, Test {
    Oracle public oracle;
    MockPriceSource public source;
    OracleHandler public handler;

    address constant TOKEN_A = address(0x1111);
    address constant TOKEN_B = address(0x2222);

    function setUp() public {
        vm.warp(1_700_000_000);
        source = new MockPriceSource();
        source.set(int56(0), uint32(block.timestamp));

        oracle = new Oracle(source, TOKEN_A, TOKEN_B, 6 hours, block.timestamp + 1 hours, address(this));

        handler = new OracleHandler(oracle, source);
        oracle.transferTrustees(address(handler));

        targetContract(address(handler));
    }

    /// @notice blockTimestampLast never moves backward across update() calls. This is the
    ///         core monotonicity guarantee that makes the TWAP math sound.
    function invariant_BlockTimestampMonotonic() public view {
        assertGe(oracle.blockTimestampLast(), handler.ghost_maxBlockTs());
    }

    /// @notice Token ordering invariant: token0 < token1 always (set in constructor; no
    ///         setter exists to change them — catches an accidental future setter).
    function invariant_TokensSorted() public view {
        assertLt(uint160(oracle.token0()), uint160(oracle.token1()));
    }

    /// @notice consult() for an unrecognized token must always revert with InvalidToken.
    ///         This is the safety net against silently quoting against the wrong asset.
    function invariant_ConsultRevertsOnUnknown() public {
        // Only meaningful once oracle is initialized — else consult returns 0 silently
        // by design ("returns 0 before first update" is part of the Tomb interface).
        if (!oracle.initialized()) return;
        try oracle.consult(address(0xDEAD), 1e18) {
            assertTrue(false, "consult should have reverted on unknown token");
        } catch {
            // expected
        }
    }

    /// @notice twap() returns 0 silently for an unknown token, matching Tomb's behavior.
    function invariant_TwapSilentOnUnknown() public view {
        uint144 q = oracle.twap(address(0xDEAD), 1e18);
        assertEq(uint256(q), 0);
    }

    /// @notice Once initialized, the oracle stays initialized. There's no resetter.
    function invariant_InitializedSticky() public view {
        if (handler.ghost_everUpdated()) {
            assertTrue(oracle.initialized());
        }
    }
}
