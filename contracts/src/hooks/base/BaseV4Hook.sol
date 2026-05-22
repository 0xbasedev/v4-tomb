// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

/**
 * @title BaseV4Hook
 * @notice Minimal abstract V4 hook base. v4-periphery used to ship a `BaseHook` utility but
 *         the installed version no longer does, so we maintain a lean local equivalent.
 *
 * @dev    Responsibilities:
 *           - Hold a single `poolManager` immutable.
 *           - Provide `onlyPoolManager` for restricting V4 callbacks.
 *           - Provide default-reverting stubs for every hook in IHooks; concrete subclasses
 *             override only the ones they declare in `getHookPermissions()`.
 *           - Validate at construction that the deployed address has the correct hook
 *             permission bits. (Address must be mined via CREATE2 in production; tests use
 *             `vm.etch` to place the contract at an address with the right low-bit pattern.)
 *
 *         Hooks the V4 PoolManager will never call against a contract that doesn't declare
 *         them in its address bits, so the default-revert stubs are belt-and-suspenders.
 */
abstract contract BaseV4Hook is IHooks {
    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error HookNotImplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager _poolManager
    ) {
        poolManager = _poolManager;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @notice Subclasses declare which hook callbacks they implement. Must match the
    ///         permission bits encoded in the contract's deployed address.
    function getHookPermissions() public pure virtual returns (Hooks.Permissions memory);

    // ------------------------------------------------------------------
    // Default-revert stubs. Subclasses override only the ones they need.
    // ------------------------------------------------------------------

    function beforeInitialize(
        address,
        PoolKey calldata,
        uint160
    ) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(
        address,
        PoolKey calldata,
        uint160,
        int24
    ) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata
    ) external virtual returns (bytes4, BeforeSwapDelta, uint24) {
        revert HookNotImplemented();
    }

    function afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, int128) {
        revert HookNotImplemented();
    }

    function beforeDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }
}
