// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/**
 * @title MiniSwapRouter
 * @notice A purpose-built V4 swap router for Old Money. Exposes a single
 *         exact-input swap entry, plain ERC-20 approve flow (no Permit2),
 *         and the canonical V4 unlock+callback pattern wrapped behind a
 *         simple external API.
 *
 *         Why not the Uniswap UniversalRouter? UR's V4 encoding has shifted
 *         across versions (notably the `minHopPriceX36` field was added to
 *         `ExactInputSingleParams`), making frontend encoding fragile across
 *         deploys. By owning this surface we control the calldata shape and
 *         keep the audit boundary tight.
 *
 *         Caller flow:
 *           1. user.approve(thisRouter, amountIn)                    — standard ERC-20
 *           2. router.swapExactIn(poolKey, zeroForOne, amountIn, ...)
 *           3. (internal) router.unlockCallback runs the swap, settles input
 *              from `payer` to PoolManager, takes output to `recipient`
 *
 *         Hook compatibility: the underlying `poolManager.swap` invokes
 *         `hooks.beforeSwap` / `afterSwap` exactly as it would for any other
 *         swap path. PegDefenseHook's tax mechanic fires identically.
 *
 *         Slippage: enforced via `amountOutMin` checked against the actual
 *         take amount before the take call. Reverts cleanly with
 *         `TooLittleReceived(min, actual)` so the frontend can decode the
 *         revert reason rather than landing in 'exceeds max gas'.
 */
contract MiniSwapRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error ZeroAmount();
    error TooLittleReceived(uint256 amountOutMin, uint256 actualOut);
    error InvalidDelta();

    /// @notice Internal payload passed through unlock -> callback.
    struct SwapData {
        address payer;
        address recipient;
        PoolKey poolKey;
        bool zeroForOne;
        uint256 amountIn;
        uint256 amountOutMin;
    }

    constructor(
        IPoolManager _poolManager
    ) {
        poolManager = _poolManager;
    }

    /**
     * @notice Swap an exact amount of input token for at least `amountOutMin` of output.
     * @param  poolKey      Pool to swap on. currency0 < currency1 per V4 convention.
     * @param  zeroForOne   True to swap currency0 -> currency1; false otherwise.
     * @param  amountIn     Exact amount of input the caller will spend (wei).
     * @param  amountOutMin Minimum output the caller will accept (slippage gate).
     * @param  recipient    Address that receives the output token.
     * @return amountOut    Actual amount of output token delivered to `recipient`.
     *
     * @dev Caller MUST have approved this router for at least `amountIn` of the input
     *      token before calling. Single-tx swap; no Permit2.
     */
    function swapExactIn(
        PoolKey calldata poolKey,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient
    ) external returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        bytes memory result = poolManager.unlock(
            abi.encode(
                SwapData({
                    payer: msg.sender,
                    recipient: recipient,
                    poolKey: poolKey,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    amountOutMin: amountOutMin
                })
            )
        );
        amountOut = abi.decode(result, (uint256));
    }

    /**
     * @notice V4 unlock callback. Only the PoolManager may invoke. Inside, we run
     *         the actual swap, settle input from `payer`, take output to `recipient`.
     */
    function unlockCallback(
        bytes calldata rawData
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapData memory s = abi.decode(rawData, (SwapData));

        // Run the swap. Exact-input is amountSpecified < 0 in V4 convention.
        // Use a wide-open price limit so the swap can move the tick freely;
        // slippage is enforced post-hoc by the amountOutMin check.
        BalanceDelta delta = poolManager.swap(
            s.poolKey,
            SwapParams({
                zeroForOne: s.zeroForOne,
                amountSpecified: -int256(s.amountIn),
                sqrtPriceLimitX96: s.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );

        // Resolve the deltas. For exact-input, the input side is negative
        // (we owe), output side is positive (we receive). Account for the hook
        // potentially slicing extra off the input side (PegDefenseHook tax) —
        // the resulting deltas already reflect that, so we settle/take the
        // exact figures the PoolManager returns.
        Currency currencyIn = s.zeroForOne ? s.poolKey.currency0 : s.poolKey.currency1;
        Currency currencyOut = s.zeroForOne ? s.poolKey.currency1 : s.poolKey.currency0;
        int128 deltaIn = s.zeroForOne ? delta.amount0() : delta.amount1();
        int128 deltaOut = s.zeroForOne ? delta.amount1() : delta.amount0();
        if (deltaIn >= 0 || deltaOut <= 0) revert InvalidDelta();

        uint256 amountOwed = uint256(uint128(-deltaIn));
        uint256 amountReceived = uint256(uint128(deltaOut));
        if (amountReceived < s.amountOutMin) {
            revert TooLittleReceived(s.amountOutMin, amountReceived);
        }

        // Settle the input side: pull from payer, sync, transfer to PoolManager.
        // V4's settle pattern: sync() snapshots the manager's pre-transfer balance,
        // we transfer, then settle() credits the delta-difference against the
        // open deficit. (Mirror of v4-core/src/test/PoolTestBase.sol pattern.)
        // s.payer is the original swapExactIn caller, paying their own funds via
        // their own pre-set allowance. unlockCallback is gated to PoolManager-only.
        // Canonical V4 router pattern, same as UniversalRouter / PoolSwapTest.
        poolManager.sync(currencyIn);
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(Currency.unwrap(currencyIn)).safeTransferFrom(s.payer, address(poolManager), amountOwed);
        // settle() returns the amount paid (informational); the load-bearing
        // effect is clearing the open negative delta, which always fires.
        // slither-disable-next-line unused-return
        poolManager.settle();

        // Take the output side to the recipient.
        poolManager.take(currencyOut, s.recipient, amountReceived);

        return abi.encode(amountReceived);
    }
}
