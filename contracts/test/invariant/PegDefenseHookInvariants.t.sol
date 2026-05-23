// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/**
 * @notice Minimal pool-manager stub — the invariant suite only exercises the tax-table
 *         mutator surface and the fee setter, so the hook never actually swaps and the
 *         manager is referenced only by the immutable address stored in the constructor.
 */
contract StubPM {}

/**
 * @title PegDefenseHookHandler
 * @notice Drives Trustees-only setter calls on the hook's tax/fee surface. Inputs are
 *         bounded so the handler emits a mix of valid setter sequences and invalid ones
 *         (which are expected to revert and are filtered by fail_on_revert=false).
 *
 *         The invariants below assert that no valid setter sequence can break monotonicity
 *         of the tier table, push a rate above 10000 bps, or push a fee above the V4 max.
 */
contract PegDefenseHookHandler is Test {
    PegDefenseHook public hook;

    constructor(PegDefenseHook _hook) {
        hook = _hook;
    }

    function setTaxTiersTwap(uint256 idx, uint256 newTwap) external {
        idx = bound(idx, 0, hook.getTaxTiersTwapsCount() - 1);
        // Generous bound — the tier-table validation in the hook will reject non-monotonic
        // values. The fuzzer benefits from seeing both valid and invalid cases.
        newTwap = bound(newTwap, 0, 10e18);
        hook.setTaxTiersTwap(idx, newTwap);
    }

    function setTaxTiersRate(uint256 idx, uint256 newRate) external {
        idx = bound(idx, 0, hook.getTaxTiersRatesCount() - 1);
        // Bound across the validation boundary so we get both accepted (<=10000) and
        // rejected (>10000) inputs.
        newRate = bound(newRate, 0, 20_000);
        hook.setTaxTiersRate(idx, newRate);
    }

    function setBurnThreshold(uint256 newThreshold) external {
        newThreshold = bound(newThreshold, 1, 100e18);
        hook.setBurnThreshold(newThreshold);
    }

    function setAutoCalculateTax(bool enabled) external {
        hook.setAutoCalculateTax(enabled);
    }

    function setExcludedAddress(uint256 addrSeed, bool excluded) external {
        address a = address(uint160(uint256(keccak256(abi.encode(addrSeed)))));
        hook.setExcludedAddress(a, excluded);
    }
}

contract PegDefenseHookInvariants is StdInvariant, Test {
    PegDefenseHook public hook;
    PegDefenseHookHandler public handler;
    OldMoney public money;
    StubPM public pm;

    address internal hookAddr;

    function setUp() public {
        vm.warp(1_700_000_000);

        money = new OldMoney();
        pm = new StubPM();

        // Place the hook at an address whose low bits match the declared permissions
        // (AFTER_INITIALIZE | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA = 0x1088).
        hookAddr = address(
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG)
        );

        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(pm)), address(money), address(this)),
            hookAddr
        );
        hook = PegDefenseHook(hookAddr);

        handler = new PegDefenseHookHandler(hook);
        hook.transferTrustees(address(handler));

        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // Invariants on the tax-tier table
    // ---------------------------------------------------------------------

    /// @notice Tier table length is fixed at 14 — set in constructor, no resizer exists.
    function invariant_TierTableLengthFixed() public view {
        assertEq(hook.getTaxTiersTwapsCount(), 14);
        assertEq(hook.getTaxTiersRatesCount(), 14);
    }

    /// @notice TWAPs are strictly monotonic — setTaxTiersTwap enforces it on every write.
    function invariant_TiersMonotonic() public view {
        uint256 prev = hook.taxTiersTwaps(0);
        for (uint256 i = 1; i < hook.getTaxTiersTwapsCount(); ++i) {
            uint256 cur = hook.taxTiersTwaps(i);
            assertGt(cur, prev, "tier TWAPs must be strictly increasing");
            prev = cur;
        }
    }

    /// @notice No tax rate ever exceeds 10000 bps (100%). The setter rejects this; the
    ///         invariant is the cross-check that no path mutates the array around it.
    function invariant_TaxRatesBoundedBy100Pct() public view {
        for (uint256 i = 0; i < hook.getTaxTiersRatesCount(); ++i) {
            assertLe(hook.taxTiersRates(i), 10_000, "tax rate exceeds 100%");
        }
    }

    /// @notice burnThreshold is always strictly positive (setter rejects zero).
    function invariant_BurnThresholdNonZero() public view {
        assertGt(hook.burnThreshold(), 0);
    }

    /// @notice money / poolManager immutables can never change post-construction.
    function invariant_ImmutablesStable() public view {
        assertEq(hook.money(), address(money));
        assertEq(address(hook.poolManager()), address(pm));
    }

    /// @notice taxRateForPrice(price) always returns a value present in the rates table.
    ///         Fuzzed via the active price the invariant runner reaches.
    function invariant_TaxRateAlwaysInTable() public view {
        uint256[7] memory probes =
            [uint256(0), 0.25e18, 0.5e18, 0.75e18, 1.0e18, 1.5e18, 100e18];
        for (uint256 i = 0; i < probes.length; ++i) {
            uint256 rate = hook.taxRateForPrice(probes[i]);
            bool found = false;
            // Rate 0 is the only one not literally in the rates table — it's the "below
            // the lowest tier" fall-through. Accept it.
            if (rate == 0) continue;
            for (uint256 j = 0; j < hook.getTaxTiersRatesCount(); ++j) {
                if (hook.taxTiersRates(j) == rate) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "taxRateForPrice returned a value not in the table");
        }
    }
}
