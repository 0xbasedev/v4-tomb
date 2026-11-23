// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Minimal interface to standard Uniswap V2-compatible pairs.
/// @dev Checks source pool identity and uses native UQ112x112 cumulative TWAP.
interface IV2TwapPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

interface IUsdReference {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Permissionless V2 time-weighted price oracle, with quote/USD reference and liquidity checks.
/// @dev No owner price setting, no spot fallback, no guaranteed protection against a manipulated pool.
///      Only use on canonical pre-seeded deep pairs. Peer-review oracle and quote feed per deployment.
contract LiteV2TwapOracle {
    uint256 private constant Q112 = 2 ** 112;
    uint256 private constant BPS = 10_000;

    IV2TwapPair public immutable pair;
    address public immutable peg;
    address public immutable quote;
    IUsdReference public immutable quoteUsdFeed;
    bool public immutable pegIsToken0;
    uint8 public immutable quoteDecimals;
    uint8 public immutable feedDecimals;
    uint64 public immutable windowSeconds;
    uint64 public immutable maxObservationAge;
    uint64 public immutable maxFeedAge;
    uint16 public immutable maxSpotDeviationBps;
    uint16 public immutable minPriceMoveBps;
    uint112 public immutable minPegReserve;
    uint112 public immutable minQuoteReserve;

    uint256 public previousCumulative;
    uint64 public previousTimestamp;
    uint112 public previousPegReserve;
    uint112 public previousQuoteReserve;

    uint256 public lastQuoteTwapE18;
    uint64 public lastTwapAt;
    uint64 public lastPriceMoveAt;

    error BadConfig();
    error InsufficientLiquidity();
    error NotWarmed();
    error InvalidPrice();
    error FeedUnavailable();

    event Observation(uint256 quotePriceE18, uint256 updatedAt, uint256 pegReserve, uint256 quoteReserve);

    constructor(
        address pair_,
        address peg_,
        address quote_,
        address usdFeed_,
        uint8 quoteDecimals_,
        uint112 minPegReserve_,
        uint112 minQuoteReserve_,
        uint64 windowSeconds_,
        uint64 maxObservationAge_,
        uint64 maxFeedAge_,
        uint16 maxSpotDeviationBps_,
        uint16 minPriceMoveBps_
    ) {
        if (pair_ == address(0) || peg_ == address(0) || quote_ == address(0) ||
            usdFeed_ == address(0) || pair_.code.length == 0 || usdFeed_.code.length == 0 ||
            quoteDecimals_ > 18 || minPegReserve_ == 0 || minQuoteReserve_ == 0 ||
            windowSeconds_ < 30 minutes || maxObservationAge_ > 1 hours ||
            maxObservationAge_ == 0 || maxFeedAge_ == 0 || maxFeedAge_ > 1 hours ||
            maxSpotDeviationBps_ == 0 || maxSpotDeviationBps_ > 500 ||
            minPriceMoveBps_ == 0 || minPriceMoveBps_ > 200
        ) revert BadConfig();
        IV2TwapPair p = IV2TwapPair(pair_);
        address a = p.token0();
        address b = p.token1();
        if (!((a == peg_ && b == quote_) || (b == peg_ && a == quote_))) revert BadConfig();
        uint8 fd = IUsdReference(usdFeed_).decimals();
        if (fd > 18) revert BadConfig();
        pair = p;
        peg = peg_;
        quote = quote_;
        quoteUsdFeed = IUsdReference(usdFeed_);
        pegIsToken0 = a == peg_;
        quoteDecimals = quoteDecimals_;
        feedDecimals = fd;
        minPegReserve = minPegReserve_;
        minQuoteReserve = minQuoteReserve_;
        windowSeconds = windowSeconds_;
        maxObservationAge = maxObservationAge_;
        maxFeedAge = maxFeedAge_;
        maxSpotDeviationBps = maxSpotDeviationBps_;
        minPriceMoveBps = minPriceMoveBps_;
    }

    function _state() internal view returns (uint256 cumulative, uint112 pegReserve, uint112 quoteReserve) {
        (uint112 r0, uint112 r1, uint32 reserveTimestamp) = pair.getReserves();
        pegReserve = pegIsToken0 ? r0 : r1;
        quoteReserve = pegIsToken0 ? r1 : r0;
        if (pegReserve < minPegReserve || quoteReserve < minQuoteReserve) revert InsufficientLiquidity();
        cumulative = pegIsToken0 ? pair.price0CumulativeLast() : pair.price1CumulativeLast();
        uint32 elapsed;
        unchecked {
            elapsed = uint32(block.timestamp) - reserveTimestamp;
            cumulative += (uint256(quoteReserve) * Q112 / pegReserve) * elapsed;
        }
    }

    function _scaleQ112(uint256 raw) internal view returns (uint256) {
        // Solidity checked multiplication deliberately rejects extreme/malformed pool ratios.
        return raw * 10 ** (36 - quoteDecimals) / Q112;
    }

    function _spot(uint112 pegReserve, uint112 quoteReserve) internal view returns (uint256) {
        return uint256(quoteReserve) * 10 ** (36 - quoteDecimals) / pegReserve;
    }

    /// @notice First call anchors an observation. Second call after the window can validate TWAP.
    /// @dev Requires actual reserve-ratio movement during the window; never revalidates idle pools.
    ///      Reserve movements may come from sync/liquidity changes, not necessarily a swap.
    function poke() external returns (uint256 quoteTwapE18) {
        (uint256 cumulative, uint112 pr, uint112 qr) = _state();
        uint64 nowTs = uint64(block.timestamp);
        if (previousTimestamp == 0) {
            previousTimestamp = nowTs;
            previousCumulative = cumulative;
            previousPegReserve = pr;
            previousQuoteReserve = qr;
            return 0;
        }
        uint256 elapsed = block.timestamp - previousTimestamp;
        if (elapsed < windowSeconds) revert NotWarmed();
        // Reject windows longer than 2x requested; a missed keeper interval must rewarm.
        if (elapsed > 2 * uint256(windowSeconds)) {
            _reset(cumulative, pr, qr, nowTs);
            return 0;
        }

        uint256 diff;
        unchecked { diff = cumulative - previousCumulative; } // V2 cumulative wraps mod 2^256.
        quoteTwapE18 = _scaleQ112(diff / elapsed);
        uint256 spotE18 = _spot(pr, qr);
        if (quoteTwapE18 == 0 || spotE18 == 0) revert InvalidPrice();
        uint256 deviation = spotE18 > quoteTwapE18
            ? (spotE18 - quoteTwapE18) * BPS / quoteTwapE18
            : (quoteTwapE18 - spotE18) * BPS / quoteTwapE18;

        uint256 oldSpot = _spot(previousPegReserve, previousQuoteReserve);
        uint256 movement = spotE18 > oldSpot
            ? (spotE18 - oldSpot) * BPS / oldSpot
            : (oldSpot - spotE18) * BPS / oldSpot;
        _reset(cumulative, pr, qr, nowTs);
        if (deviation > maxSpotDeviationBps || movement < minPriceMoveBps) {
            // Invalidate the old observation too: stale or inactive pool cannot authorize minting.
            lastQuoteTwapE18 = 0;
            lastTwapAt = 0;
            return 0;
        }

        lastPriceMoveAt = nowTs;
        lastQuoteTwapE18 = quoteTwapE18;
        lastTwapAt = nowTs;
        emit Observation(quoteTwapE18, nowTs, pr, qr);
    }

    function _reset(uint256 cum, uint112 pr, uint112 qr, uint64 ts) internal {
        previousTimestamp = ts;
        previousCumulative = cum;
        previousPegReserve = pr;
        previousQuoteReserve = qr;
    }

    /// @notice USD price of 1e18 peg units, normalized to 18 decimals.
    /// @dev The price feed MUST be independently verified to reference the quote in real USD.
    function latestPrice() external view returns (uint256 priceE18, uint256 updatedAt) {
        updatedAt = lastTwapAt;
        if (updatedAt == 0 || block.timestamp < updatedAt ||
            block.timestamp - updatedAt > maxObservationAge || lastQuoteTwapE18 == 0
        ) revert InvalidPrice();
        (uint80 roundId, int256 answer,, uint256 feedAt, uint80 answeredInRound) =
            quoteUsdFeed.latestRoundData();
        if (answer <= 0 || roundId == 0 || answeredInRound < roundId || feedAt == 0 ||
            feedAt > block.timestamp || block.timestamp - feedAt > maxFeedAge) revert FeedUnavailable();
        priceE18 = lastQuoteTwapE18 * uint256(answer) / (10 ** feedDecimals);
        if (priceE18 == 0) revert InvalidPrice();
    }
}
