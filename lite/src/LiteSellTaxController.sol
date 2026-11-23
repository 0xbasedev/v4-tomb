// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

interface ILitePrice {
    function latestPrice() external view returns (uint256 priceE18, uint256 observedAt);
}

interface ILitePoolReserves {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

/// @notice Sell-only tax policy; authorized token calls quoteAndRecord on transfers into a canonical pool.
/// @dev Works with a V2 token transfer, whereas v4 chains should use separate v4 hook adapters.
///      Can reject unrecognized pools at the token level only if the token itself integrates enforcement.
///      Exempting arbitrary routers would bypass taxation; only a separately controlled LP adapter may be exempt.
contract LiteSellTaxController {
    uint16 public constant HARD_CAP_BPS = 1200;
    uint256 public constant RECOVERY_SECONDS = 7 hours;
    uint256 public constant STALE_GRACE = 1 hours;
    uint256 private constant BPS = 10000;

    address public immutable token;
    address public immutable canonicalPair;
    ILitePrice public immutable pegOracle;
    uint256 public immutable referenceUsdE18;
    uint16 public immutable baselineBps;
    uint16 public immutable maximumBps;
    uint16 public immutable fullTaxDropBps;
    uint16 public immutable launchFloorBps;
    uint64 public immutable launchFloorEndsAt;
    uint8 public immutable quoteDecimals;
    uint16 public immutable swapFeeBps;
    bool public immutable previewPoolImpact;

    uint16 public elevatedBps;
    uint64 public elevatedAt;
    uint16 public lastTrustedBps;
    uint64 public lastTrustedAt;

    error Unauthorized();
    error InvalidConfig();

    event SaleTaxQuoted(uint256 gross, uint16 rateBps, bool oracleFresh);

    constructor(
        address token_, address pair_, address oracle_, uint256 referenceUsdE18_,
        uint16 baselineBps_, uint16 maxBps_, uint16 fullTaxDropBps_,
        uint16 launchFloorBps_, uint64 launchFloorEndsAt_,
        uint8 quoteDecimals_, uint16 swapFeeBps_, bool previewPoolImpact_
    ) {
        if (token_ == address(0) || pair_ == address(0) || oracle_ == address(0) ||
            oracle_.code.length == 0 || pair_.code.length == 0 ||
            referenceUsdE18_ == 0 || baselineBps_ > maxBps_ ||
            maxBps_ > HARD_CAP_BPS || maxBps_ == 0 ||
            fullTaxDropBps_ == 0 || fullTaxDropBps_ > 10000 ||
            launchFloorBps_ > HARD_CAP_BPS || quoteDecimals_ > 18 ||
            swapFeeBps_ > 1000) revert InvalidConfig();
        if (ILitePoolReserves(pair_).token0() != token_ &&
            ILitePoolReserves(pair_).token1() != token_) revert InvalidConfig();
        token = token_;
        canonicalPair = pair_;
        pegOracle = ILitePrice(oracle_);
        referenceUsdE18 = referenceUsdE18_;
        baselineBps = baselineBps_;
        maximumBps = maxBps_;
        fullTaxDropBps = fullTaxDropBps_;
        launchFloorBps = launchFloorBps_;
        launchFloorEndsAt = launchFloorEndsAt_;
        quoteDecimals = quoteDecimals_;
        swapFeeBps = swapFeeBps_;
        previewPoolImpact = previewPoolImpact_;
        lastTrustedBps = maxBps_; // conservative until a valid oracle observation.
    }

    function _target(uint256 price) internal view returns (uint16) {
        if (price >= referenceUsdE18) return baselineBps;
        uint256 bottom = referenceUsdE18 * (BPS - fullTaxDropBps) / BPS;
        if (price <= bottom) return maximumBps;
        uint256 span = referenceUsdE18 - bottom;
        uint256 progress = (referenceUsdE18 - price) * BPS / span;
        uint256 nonlinear = progress * progress / BPS;
        return baselineBps + uint16(uint256(maximumBps - baselineBps) * nonlinear / BPS);
    }

    function _floor() internal view returns (uint16) {
        if (elevatedAt == 0 || elevatedBps <= baselineBps) return baselineBps;
        uint256 elapsed = block.timestamp - elevatedAt;
        if (elapsed >= RECOVERY_SECONDS) return baselineBps;
        return baselineBps +
            uint16(uint256(elevatedBps - baselineBps) * (RECOVERY_SECONDS - elapsed) / RECOVERY_SECONDS);
    }

    /// @notice Conservative constant-product projection of a V2 sell against canonical pool reserves.
    /// @dev Only valid for V2-style pools using the configured swap fee; explicit max deviation from
    ///      oracle is enforced by the oracle. Does not model exotic tokens or dynamic swap fees.
    function _projectedRate(uint256 gross, uint256 observedUsdPrice) internal view returns (uint16) {
        if (!previewPoolImpact || gross == 0) return baselineBps;
        ILitePoolReserves p = ILitePoolReserves(canonicalPair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool token0 = p.token0() == token;
        uint256 rPeg = token0 ? r0 : r1;
        uint256 rQuote = token0 ? r1 : r0;
        if (rPeg == 0 || rQuote == 0) return maximumBps;
        // Clamp in pathological or overflow-prone states rather than accidentally under-tax.
        if (gross > rPeg || gross > type(uint256).max / BPS) return maximumBps;
        uint256 feeIn = gross * (BPS - swapFeeBps);
        uint256 denominator = rPeg * BPS + feeIn;
        uint256 out = feeIn * rQuote / denominator;
        if (out >= rQuote) return maximumBps;
        uint256 spot = rQuote * 10 ** (36 - quoteDecimals) / rPeg;
        uint256 postSpot = (rQuote - out) * 10 ** (36 - quoteDecimals) / (rPeg + gross);
        if (spot == 0) return maximumBps;
        // Relative post-trade impact applied to the USD TWAP. Conservative when spot near TWAP.
        uint256 projectedUsd = observedUsdPrice * postSpot / spot;
        return _target(projectedUsd);
    }

    /// @notice Only the token itself may consume a quote and update recovery state.
    function quoteAndRecord(uint256 gross) external returns (uint16 bps) {
        if (msg.sender != token) revert Unauthorized();
        bool fresh;
        uint256 price;
        try pegOracle.latestPrice() returns (uint256 p, uint256 at) {
            if (p != 0 && at != 0 && at <= block.timestamp && block.timestamp - at <= 30 minutes) {
                price = p;
                fresh = true;
            }
        } catch {}

        uint16 floorBps = _floor();
        if (fresh) {
            uint16 twapRate = _target(price);
            uint16 projectedRate = _projectedRate(gross, price);
            bps = twapRate > projectedRate ? twapRate : projectedRate;
            if (bps < floorBps) bps = floorBps;
            if (bps > floorBps) {
                elevatedBps = bps;
                elevatedAt = uint64(block.timestamp);
            }
            lastTrustedBps = bps;
            lastTrustedAt = uint64(block.timestamp);
        } else if (lastTrustedAt != 0 && block.timestamp - lastTrustedAt <= STALE_GRACE) {
            bps = lastTrustedBps > floorBps ? lastTrustedBps : floorBps;
        } else {
            bps = maximumBps; // Fail conservative on missing or long-stale oracle.
        }

        if (block.timestamp < launchFloorEndsAt && bps < launchFloorBps) bps = launchFloorBps;
        if (bps > HARD_CAP_BPS) revert InvalidConfig();
        emit SaleTaxQuoted(gross, bps, fresh);
    }
}
