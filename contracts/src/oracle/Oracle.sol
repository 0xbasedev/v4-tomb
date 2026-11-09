// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {Epoch} from "../libs/Epoch.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";

/**
 * @title Oracle
 * @notice Fixed-window TWAP oracle. Tomb-Finance analog: Oracle.sol.
 * @dev    Same period-windowed semantics and same (`update` / `consult` / `twap`) interface as
 *         Tomb. The only deviation from Tomb's V2-cumulative-price design is internal: this
 *         oracle reads tick cumulatives from an IPriceSource (the PegDefenseHook on the V4
 *         MONEY/WETH pool, once that lands in Sprint 4) rather than from a V2 pair's
 *         `price0CumulativeLast`. The math is equivalent — V3/V4's tick cumulative replaces
 *         V2's price cumulative — and the resulting TWAP is mathematically the same once
 *         tick is converted to price.
 *
 *         Returns 0 from `consult` until the first successful `update()` — matches Tomb's
 *         "this will always return 0 before update has been called successfully for the
 *         first time" behavior.
 *
 *         Returns 0 from `twap` for an unrecognized token — matches Tomb's silent else-fall-
 *         through. `consult` reverts on unrecognized token — matches Tomb's explicit require.
 */
contract Oracle is IOracle, Epoch {
    /// @notice The price source providing tick cumulatives. Immutable post-deploy.
    IPriceSource public immutable priceSource;

    /// @notice The two tokens of the pool the oracle tracks, sorted (token0 < token1).
    address public immutable token0;
    address public immutable token1;

    /// @notice Tick cumulative captured at the last snapshot.
    int56 public tickCumulativeLast;

    /// @notice Timestamp captured at the last snapshot.
    uint32 public blockTimestampLast;

    /// @notice Period-averaged tick from the most recent completed window. Zero before first update.
    int24 public averageTick;

    /// @notice True once `update()` has run at least once with `timeElapsed > 0`.
    bool public initialized;

    event Updated(int56 tickCumulative, uint32 blockTimestamp, int24 averageTick);

    error InvalidToken();
    error IdenticalTokens();
    error AmountOverflow();

    constructor(
        IPriceSource _priceSource,
        address _tokenA,
        address _tokenB,
        uint256 _period,
        uint256 _startTime,
        address initialTrustees
    ) Epoch(_period, _startTime, 0, initialTrustees) {
        if (_tokenA == _tokenB) revert IdenticalTokens();
        priceSource = _priceSource;
        (token0, token1) = _tokenA < _tokenB ? (_tokenA, _tokenB) : (_tokenB, _tokenA);

        (int56 cum, uint32 ts) = _priceSource.getCurrentTickCumulative();
        tickCumulativeLast = cum;
        blockTimestampLast = ts;
    }

    /// @inheritdoc IOracle
    function update() external checkEpoch {
        (int56 currentCumulative, uint32 currentTimestamp) = priceSource.getCurrentTickCumulative();
        uint32 timeElapsed = currentTimestamp - blockTimestampLast;
        if (timeElapsed == 0) return;

        int56 tickDelta = currentCumulative - tickCumulativeLast;
        averageTick = int24(tickDelta / int56(uint56(timeElapsed)));

        tickCumulativeLast = currentCumulative;
        blockTimestampLast = currentTimestamp;
        initialized = true;

        emit Updated(currentCumulative, currentTimestamp, averageTick);
    }

    /// @inheritdoc IOracle
    function consult(
        address _token,
        uint256 _amountIn
    ) external view returns (uint144 amountOut) {
        if (!initialized) return 0;
        return _tickToAmount(_token, _amountIn, averageTick);
    }

    /// @inheritdoc IOracle
    function isFresh(
        uint256 maxAge
    ) external view returns (bool) {
        if (!initialized || maxAge == 0) return false;
        uint256 last = uint256(blockTimestampLast);
        if (block.timestamp < last) return false;
        return block.timestamp - last <= maxAge;
    }

    /// @inheritdoc IOracle
    function twap(
        address _token,
        uint256 _amountIn
    ) external view returns (uint144 amountOut) {
        if (_token != token0 && _token != token1) return 0; // Tomb-style silent miss
        (int56 currentCumulative, uint32 currentTimestamp) = priceSource.getCurrentTickCumulative();
        uint32 timeElapsed = currentTimestamp - blockTimestampLast;

        if (timeElapsed == 0) {
            if (!initialized) return 0;
            return _tickToAmount(_token, _amountIn, averageTick);
        }

        int56 tickDelta = currentCumulative - tickCumulativeLast;
        int24 currentTwap = int24(tickDelta / int56(uint56(timeElapsed)));
        return _tickToAmount(_token, _amountIn, currentTwap);
    }

    /// @dev Convert (tick, token, amountIn) → amountOut quote. Reverts on unknown token.
    ///      Math: V4's TickMath.getSqrtPriceAtTick gives sqrt(token1/token0) * 2^96. Two
    ///      sequential mulDivs avoid a 512-bit-product overflow that a single sqrtP^2 step
    ///      would risk for high-tick magnitudes.
    function _tickToAmount(
        address _token,
        uint256 _amountIn,
        int24 _tick
    ) internal view returns (uint144) {
        if (_token != token0 && _token != token1) revert InvalidToken();
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(_tick);
        uint256 out;
        if (_token == token0) {
            // amountOut = amountIn * sqrtP^2 / 2^192, evaluated as two mulDiv steps.
            out = FullMath.mulDiv(_amountIn, sqrtPriceX96, 1 << 96);
            out = FullMath.mulDiv(out, sqrtPriceX96, 1 << 96);
        } else {
            // token1: amountOut = amountIn * 2^192 / sqrtP^2
            out = FullMath.mulDiv(_amountIn, 1 << 96, sqrtPriceX96);
            out = FullMath.mulDiv(out, 1 << 96, sqrtPriceX96);
        }
        if (out > type(uint144).max) revert AmountOverflow();
        return uint144(out);
    }
}
