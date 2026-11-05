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
import {MasonryTaxHook} from "../hooks/MasonryTaxHook.sol";
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
        MasonryTaxHook hook = MasonryTaxHook(address(pool.hooks));
        if (
            address(hook).code.length == 0 || PoolId.unwrap(pool.toId()) != PoolId.unwrap(hook.officialPool())
                || spotBps == 0 || impactBps == 0 || lossBps == 0 || spotBps > MAX_TOLERANCE_BPS
                || impactBps > MAX_TOLERANCE_BPS || lossBps > MAX_TOLERANCE_BPS
        ) revert InvalidConfiguration();
        key = pool;
        manager = hook.poolManager();
        oracle = hook.oracle();
        officialPool = pool.toId();
        levelIsCurrency0 = hook.assetIsCurrency0();
        minLiquidity = oracle.minLiquidity();
        maxSpotDeviationBps = spotBps;
        maxPriceImpactBps = impactBps;
        maxExecutionLossBps = lossBps;
    }

    function minimumLevelOut(
        uint256 usdcAmount
    ) external returns (uint256) {
        return _minimumOut(usdcAmount, false);
    }

    /// @notice Quote a sale through the ordinary tax path. Includes up to
    /// the immutable Fire Tax ceiling in the allowed execution-cost budget.
    function minimumAssetSaleOut(
        uint256 amount
    ) external returns (uint256) {
        return _minimumOut(amount, true);
    }

    function _minimumOut(
        uint256 amount,
        bool sell
    ) private returns (uint256) {
        if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert PreviewFailed();
        (uint256 spot, uint256 twap) = validatedSpot();

        (uint256 output, uint160 sqrtAfter, uint128 liquidityAfter) = _preview(amount, sell);
        if (liquidityAfter < minLiquidity) revert InsufficientLiquidity();
        uint256 priceAfter = MasonryLevelPrice.fromSqrtPrice(sqrtAfter, levelIsCurrency0);
        uint256 impact = priceAfter > spot ? priceAfter - spot : spot - priceAfter;
        if (impact > FullMath.mulDiv(spot, maxPriceImpactBps, BPS)) revert UnsafePrice();

        uint256 expected = sell ? FullMath.mulDiv(amount, twap, 1e30) : FullMath.mulDiv(amount, 1e30, twap);
        if (sell) expected = FullMath.mulDiv(expected, BPS - MasonryTaxHook(address(key.hooks)).MAX_TAX_BPS(), BPS);
        uint256 minimum = FullMath.mulDivRoundingUp(expected, BPS - maxExecutionLossBps, BPS);
        if (output < minimum) revert UnsafePrice();
        return output;
    }

    function validatedSpot() public view returns (uint256 spot, uint256 twap) {
        twap = oracle.validatedPrice(officialPool);
        (uint160 sqrtBefore,,,) = manager.getSlot0(officialPool);
        spot = MasonryLevelPrice.fromSqrtPrice(sqrtBefore, levelIsCurrency0);
        uint256 deviation = spot > twap ? spot - twap : twap - spot;
        if (deviation > FullMath.mulDiv(twap, maxSpotDeviationBps, BPS)) revert UnsafePrice();
        if (manager.getLiquidity(officialPool) < minLiquidity) revert InsufficientLiquidity();
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        (uint256 amount, bool sell) = abi.decode(data, (uint256, bool));
        bool zeroForOne = sell == levelIsCurrency0;
        BalanceDelta delta = manager.swap(
            key,
            SwapParams(
                zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (paid != -int256(amount) || received <= 0) revert PreviewFailed();
        (uint160 sqrtPrice,,,) = manager.getSlot0(officialPool);
        revert Preview(uint256(uint128(received)), sqrtPrice, manager.getLiquidity(officialPool));
    }

    function _preview(
        uint256 amount,
        bool sell
    ) private returns (uint256 levelOut, uint160 sqrtPrice, uint128 liquidity) {
        try manager.unlock{gas: PREVIEW_GAS}(abi.encode(amount, sell)) returns (bytes memory) {
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
