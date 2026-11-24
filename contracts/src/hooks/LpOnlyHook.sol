// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {BaseV4Hook} from "./base/BaseV4Hook.sol";

/// @notice The low-14-bit address pattern LpOnlyHook must be deployed at.
library LpOnlyHookPermissions {
    uint160 internal constant FLAGS = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
}

/**
 * @title LpOnlyHook
 * @notice Makes a V4 pool untradeable. Liquidity can be added and removed; every swap
 *         reverts. Used for the peg/share pool whose LP position is a staking token: it
 *         gives stakers a position to hold without opening a route that swaps one protocol
 *         token for the other around the sell tax.
 *
 *         Because nothing can trade, the pool's price never moves from the price it was
 *         initialised at. Liquidity providers deposit the two tokens at that fixed ratio
 *         and withdraw exactly what they deposited: no fees, no impermanent loss.
 *
 * @dev    The opening price is therefore permanent, so only `initializer` may create the
 *         pool, and only one pool can ever use this hook. After that the hook has no
 *         owner, no settings and no way to re-enable swaps.
 *
 *         Hook permissions — low-14-bit pattern = 0x2080:
 *           BEFORE_INITIALIZE = 0x2000
 *           BEFORE_SWAP       = 0x0080
 */
contract LpOnlyHook is BaseV4Hook {
    using PoolIdLibrary for PoolKey;

    /// @notice The permission bits this hook's deployed address must carry.
    uint160 public constant PERMISSION_FLAGS = LpOnlyHookPermissions.FLAGS;

    /// @notice The two tokens the pool must pair, in either order.
    address public immutable tokenA;
    address public immutable tokenB;

    /// @notice The only address allowed to initialise the pool (and so fix its ratio).
    address public immutable initializer;

    /// @notice The single pool bound to this hook. Zero until initialised.
    PoolId public poolId;
    bool public bound;

    event Bound(PoolId indexed poolId, uint160 sqrtPriceX96);

    error SwapsDisabled();
    error NotInitializer();
    error AlreadyBound();
    error WrongPoolTokens();
    error IdenticalTokens();
    error ZeroAddress();

    constructor(
        IPoolManager _poolManager,
        address _tokenA,
        address _tokenB,
        address _initializer
    ) BaseV4Hook(_poolManager) {
        if (_tokenA == address(0) || _tokenB == address(0) || _initializer == address(0)) revert ZeroAddress();
        if (_tokenA == _tokenB) revert IdenticalTokens();
        tokenA = _tokenA;
        tokenB = _tokenB;
        initializer = _initializer;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true, // gate who fixes the ratio, and which pool
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true, // reject every swap
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96
    ) external override onlyPoolManager returns (bytes4) {
        if (sender != initializer) revert NotInitializer();
        if (bound) revert AlreadyBound();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (!((c0 == tokenA && c1 == tokenB) || (c0 == tokenB && c1 == tokenA))) revert WrongPoolTokens();

        poolId = key.toId();
        bound = true;
        emit Bound(poolId, sqrtPriceX96);
        return IHooks.beforeInitialize.selector;
    }

    /// @dev Unconditional. There is no state, role or parameter that lets a swap through.
    function beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        revert SwapsDisabled();
    }
}
