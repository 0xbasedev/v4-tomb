// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {MasonryLevelPrice} from "./MasonryLevelPrice.sol";
import {IMasonryValidatedLevelTwap} from "./MasonryCriticalDefense.sol";

/// @notice Time-weighted official-pool price from hook-authenticated state changes.
/// A thin interval anywhere in the measured window invalidates the result.
contract MasonryLevelOracle is IMasonryValidatedLevelTwap {
    uint256 public constant WINDOW = 30 minutes;
    uint256 public constant MAX_LOOKBACK = 1 hours;
    uint256 public constant MAX_SWAP_AGE = 30 minutes;
    uint256 private constant BUCKET = 5 minutes;
    uint8 private constant HISTORY = 16;

    struct Observation {
        uint64 timestamp;
        int64 tickSeconds;
        uint64 thinSeconds;
    }

    address public immutable hook;
    PoolId public immutable officialPool;
    bool public immutable levelIsCurrency0;
    uint128 public immutable minLiquidity;

    Observation private last;
    Observation[HISTORY] private history;
    uint8 private cursor;
    uint8 private count;
    int24 private lastTick;
    uint128 private lastLiquidity;
    uint64 public lastPriceChange;

    error OnlyHook();
    error InvalidLiquidity();
    error InvalidPrice();

    constructor(
        PoolId pool,
        bool level0,
        uint128 minLiquidity_,
        address hook_
    ) {
        if (minLiquidity_ == 0) revert InvalidLiquidity();
        if (hook_ == address(0)) revert OnlyHook();
        hook = hook_;
        officialPool = pool;
        levelIsCurrency0 = level0;
        minLiquidity = minLiquidity_;
    }

    function record(
        int24 tick,
        uint128 liquidity,
        bool priceChanged
    ) external {
        if (msg.sender != hook) revert OnlyHook();
        Observation memory current = _advance();
        if (count == 0 || current.timestamp / BUCKET != history[cursor].timestamp / BUCKET) {
            if (count != 0) cursor = (cursor + 1) % HISTORY;
            history[cursor] = current;
            if (count < HISTORY) ++count;
        } else if (lastLiquidity < minLiquidity && liquidity >= minLiquidity) {
            // Retain the start of the new continuous healthy interval, even
            // when liquidity was removed and restored in the same bucket.
            history[cursor] = current;
        }
        last = current;
        lastTick = tick;
        lastLiquidity = liquidity;
        if (priceChanged && liquidity >= minLiquidity) lastPriceChange = current.timestamp;
    }

    function validatedPrice(
        PoolId pool
    ) external view returns (uint256 price) {
        if (PoolId.unwrap(pool) != PoolId.unwrap(officialPool)) revert InvalidPrice();
        bool valid;
        (price,, valid) = latestValidatedTwap();
        if (!valid) revert InvalidPrice();
    }

    function latestValidatedTwap() public view returns (uint256 price, uint256 observedAt, bool valid) {
        return _twap(WINDOW);
    }

    /// @notice The same validated TWAP over a caller-chosen window: the
    /// identical observation history, freshness gate and thin-interval
    /// invalidation, with `window` substituted for the fixed WINDOW. A
    /// window the recorded history cannot cover (or one longer than
    /// MAX_LOOKBACK) reads invalid — consumers fail closed on it.
    function latestValidatedTwap(
        uint256 window
    ) public view returns (uint256 price, uint256 observedAt, bool valid) {
        return _twap(window);
    }

    function _twap(
        uint256 window
    ) private view returns (uint256 price, uint256 observedAt, bool valid) {
        observedAt = lastPriceChange;
        if (
            observedAt == 0 || block.timestamp - observedAt > MAX_SWAP_AGE || lastLiquidity < minLiquidity
                || block.timestamp < window
        ) return (0, observedAt, false);

        Observation memory current = _advance();
        for (uint256 i; i < count; ++i) {
            Observation memory past = history[(uint256(cursor) + HISTORY - i) % HISTORY];
            uint256 elapsed = current.timestamp - past.timestamp;
            if (elapsed < window) continue;
            if (elapsed > MAX_LOOKBACK || current.thinSeconds != past.thinSeconds) break;

            int256 tickSeconds = int256(current.tickSeconds) - past.tickSeconds;
            int256 meanTick = tickSeconds / int256(elapsed);
            if (tickSeconds < 0 && tickSeconds % int256(elapsed) != 0) --meanTick;
            price = MasonryLevelPrice.fromSqrtPrice(TickMath.getSqrtPriceAtTick(int24(meanTick)), levelIsCurrency0);
            return (price, observedAt, price != 0);
        }
    }

    function _advance() private view returns (Observation memory current) {
        current = last;
        uint64 timestamp = uint64(block.timestamp);
        if (count != 0) {
            uint64 elapsed = timestamp - current.timestamp;
            current.tickSeconds += int64(int256(lastTick) * int256(uint256(elapsed)));
            if (lastLiquidity < minLiquidity) current.thinSeconds += elapsed;
        }
        current.timestamp = timestamp;
    }
}
