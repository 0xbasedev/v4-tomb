// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MasonryLevelHook} from "../hooks/MasonryLevelHook.sol";
import {MasonryLevelOracle} from "./MasonryLevelOracle.sol";
import {MasonryLevelPrice} from "./MasonryLevelPrice.sol";
import {IMasonryBuybackExecutionGuard} from "./MasonryGenesisLPBurnFee.sol";

/// @notice Previews an exact-input USDC buyback in the official PoolManager.
/// Preview state is reverted. The collector enforces the resulting minimum and
/// full USDC spend against real token balances during the subsequent execution.
contract MasonryBuybackGuard is IMasonryBuybackExecutionGuard, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 private constant BPS = 10_000;
    uint16 public constant MAX_TOLERANCE_BPS = 500;
    uint256 public constant PREVIEW_GAS = 750_000;

    IPoolManager public immutable manager;
    MasonryLevelOracle public immutable oracle;
    PoolId public immutable officialPool;
    bool public immutable levelIsCurrency0;
    uint128 public immutable minLiquidity;
    uint16 public immutable maxSpotDeviationBps;
    uint16 public immutable maxPriceImpactBps;
    uint16 public immutable maxExecutionLossBps;
    PoolKey private key;

    error InvalidConfiguration();
    error UnsafePrice();
    error InsufficientLiquidity();
    error PreviewFailed();
    error NotPoolManager();
    error Preview(uint256 levelOut, uint160 sqrtPrice, uint128 liquidity);

    constructor(
        PoolKey memory pool,
        uint16 spotBps,
        uint16 impactBps,
        uint16 lossBps
    ) {
        MasonryLevelHook hook = MasonryLevelHook(address(pool.hooks));
        if (
            address(hook).code.length == 0 || PoolId.unwrap(pool.toId()) != PoolId.unwrap(hook.officialPool())
                || spotBps == 0 || impactBps == 0 || lossBps == 0 || spotBps > MAX_TOLERANCE_BPS
                || impactBps > MAX_TOLERANCE_BPS || lossBps > MAX_TOLERANCE_BPS
        ) revert InvalidConfiguration();
        key = pool;
        manager = hook.poolManager();
        oracle = hook.oracle();
        officialPool = pool.toId();
        levelIsCurrency0 = hook.levelIsCurrency0();
        minLiquidity = oracle.minLiquidity();
        maxSpotDeviationBps = spotBps;
        maxPriceImpactBps = impactBps;
        maxExecutionLossBps = lossBps;
    }

    function minimumLevelOut(
        uint256 usdcAmount
    ) external returns (uint256) {
        if (usdcAmount == 0 || usdcAmount > uint256(uint128(type(int128).max))) revert PreviewFailed();
        uint256 twap = oracle.validatedPrice(officialPool);
        (uint160 sqrtBefore,,,) = manager.getSlot0(officialPool);
        uint256 spot = MasonryLevelPrice.fromSqrtPrice(sqrtBefore, levelIsCurrency0);
        uint256 deviation = spot > twap ? spot - twap : twap - spot;
        if (deviation > FullMath.mulDiv(twap, maxSpotDeviationBps, BPS)) revert UnsafePrice();
        if (manager.getLiquidity(officialPool) < minLiquidity) revert InsufficientLiquidity();

        (uint256 levelOut, uint160 sqrtAfter, uint128 liquidityAfter) = _preview(usdcAmount);
        if (liquidityAfter < minLiquidity) revert InsufficientLiquidity();
        uint256 priceAfter = MasonryLevelPrice.fromSqrtPrice(sqrtAfter, levelIsCurrency0);
        if (priceAfter > spot + FullMath.mulDiv(spot, maxPriceImpactBps, BPS)) revert UnsafePrice();

        uint256 expected = FullMath.mulDiv(usdcAmount, 1e30, twap);
        uint256 minFromTwap = FullMath.mulDivRoundingUp(expected, BPS - maxExecutionLossBps, BPS);
        if (levelOut < minFromTwap) revert UnsafePrice();
        return levelOut;
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        uint256 usdcAmount = abi.decode(data, (uint256));
        bool zeroForOne = !levelIsCurrency0;
        BalanceDelta delta = manager.swap(
            key,
            SwapParams(
                zeroForOne, -int256(usdcAmount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (paid != -int256(usdcAmount) || received <= 0) revert PreviewFailed();
        (uint160 sqrtPrice,,,) = manager.getSlot0(officialPool);
        revert Preview(uint256(uint128(received)), sqrtPrice, manager.getLiquidity(officialPool));
    }

    function _preview(
        uint256 usdcAmount
    ) private returns (uint256 levelOut, uint160 sqrtPrice, uint128 liquidity) {
        try manager.unlock{gas: PREVIEW_GAS}(abi.encode(usdcAmount)) returns (bytes memory) {
            revert PreviewFailed();
        } catch (bytes memory result) {
            if (result.length != 100 || bytes4(result) != Preview.selector) revert PreviewFailed();
            assembly ("memory-safe") {
                levelOut := mload(add(result, 36))
                sqrtPrice := mload(add(result, 68))
                liquidity := mload(add(result, 100))
            }
        }
    }
}
