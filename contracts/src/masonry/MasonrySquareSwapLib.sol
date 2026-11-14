// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {MasonryLevelOracle} from "./MasonryLevelOracle.sol";
import {MasonryLevelPrice} from "./MasonryLevelPrice.sol";

/// @notice External swap helpers for MasonrySquareHook so the hook stays under EIP-170.
library MasonrySquareSwapLib {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant BPS = 10_000;

    error UnsafeRoute();

    function swapGuarded(
        IPoolManager manager,
        PoolKey memory key,
        MasonryLevelOracle feed,
        bool zeroForOne,
        uint256 amount,
        bool sell,
        uint16 maxDeviationBps
    ) external returns (uint256 output) {
        PoolId id = key.toId();
        (uint256 twap, uint256 spot, bool token0) =
            _preflight(manager, feed, id, zeroForOne, amount, sell, maxDeviationBps);
        output = _swap(manager, key, id, feed, zeroForOne, amount);
        checkDeviation(price(manager, id, token0), spot, maxDeviationBps);
        _assertFill(amount, sell, twap, maxDeviationBps, output);
        _settle(manager, key, zeroForOne, amount, output);
    }

    function _preflight(
        IPoolManager manager,
        MasonryLevelOracle feed,
        PoolId id,
        bool zeroForOne,
        uint256 amount,
        bool sell,
        uint16 maxDeviationBps
    ) private view returns (uint256 twap, uint256 spot, bool token0) {
        if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert UnsafeRoute();
        twap = feed.validatedPrice(id);
        token0 = sell == zeroForOne;
        spot = price(manager, id, token0);
        checkDeviation(spot, twap, maxDeviationBps);
        if (manager.getLiquidity(id) < feed.minLiquidity()) revert UnsafeRoute();
    }

    function _swap(
        IPoolManager manager,
        PoolKey memory key,
        PoolId id,
        MasonryLevelOracle feed,
        bool zeroForOne,
        uint256 amount
    ) private returns (uint256 output) {
        BalanceDelta delta = manager.swap(
            key,
            SwapParams(
                zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (paid != -int256(amount) || received <= 0 || manager.getLiquidity(id) < feed.minLiquidity()) {
            revert UnsafeRoute();
        }
        output = uint256(uint128(received));
    }

    function _assertFill(
        uint256 amount,
        bool sell,
        uint256 twap,
        uint16 maxDeviationBps,
        uint256 output
    ) private pure {
        uint256 expected = sell ? FullMath.mulDiv(amount, twap, 1e30) : FullMath.mulDiv(amount, 1e30, twap);
        if (output < FullMath.mulDivRoundingUp(expected, BPS - maxDeviationBps, BPS)) revert UnsafeRoute();
    }

    function _settle(
        IPoolManager manager,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amount,
        uint256 output
    ) private {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency out = zeroForOne ? key.currency1 : key.currency0;
        manager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransfer(address(manager), amount);
        if (manager.settle() != amount) revert UnsafeRoute();
        manager.take(out, address(this), output);
    }

    function price(
        IPoolManager manager,
        PoolId pool,
        bool token0
    ) public view returns (uint256) {
        (uint160 sqrtPrice,,,) = manager.getSlot0(pool);
        return MasonryLevelPrice.fromSqrtPrice(sqrtPrice, token0);
    }

    function checkDeviation(
        uint256 price_,
        uint256 referencePrice,
        uint16 maxDeviationBps
    ) public pure {
        uint256 deviation = price_ > referencePrice ? price_ - referencePrice : referencePrice - price_;
        if (deviation > FullMath.mulDiv(referencePrice, maxDeviationBps, BPS)) revert UnsafeRoute();
    }
}
