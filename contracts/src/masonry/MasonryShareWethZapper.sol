// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MasonryRangeLib} from "./MasonryRangeLib.sol";

interface IShareWethAmm {
    function spotPrice() external view returns (uint256);
    function swapShareForWeth(
        uint256 shareIn,
        uint256 minWethOut
    ) external returns (uint256 wethOut);
    function addLiquidity(
        uint256 shareIn,
        uint256 wethIn,
        uint256 minLp
    ) external returns (uint256 lpOut, uint256 shareUsed, uint256 wethUsed);
    function lpToken() external view returns (address);
}

interface IZapTwap {
    function latestValidatedTwap() external view returns (uint256 price, uint256 observedAt, bool valid);
}

/// @notice Turns pending farm X Share into X Share/WETH LP and returns it to the farm
/// to stake in Masonry. Leftover X Share goes back to the farm (never the user
/// wallet). Leftover WETH is sent to the DAO wallet.
///
/// Fire Tax: this zap swaps on the X Share/WETH Masonry-LP pool, not the official
/// hooked X Share/USDG pool, so it does not pay Fire Tax.
contract MasonryShareWethZapper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable share;
    IERC20 public immutable weth;
    address public farm;
    address public immutable daoWallet;
    IShareWethAmm public immutable amm;
    IZapTwap public immutable twapOracle;
    uint16 public immutable maxTwapDeviationBps;

    error ZeroAddress();
    error Unauthorized();
    error InvalidAmount();
    error UnsafeZap();
    error SlippageExceeded();

    constructor(
        IERC20 share_,
        IERC20 weth_,
        address farm_,
        address daoWallet_,
        IShareWethAmm amm_,
        IZapTwap twapOracle_,
        uint16 maxTwapDeviationBps_
    ) {
        if (
            address(share_) == address(0) || address(weth_) == address(0) || daoWallet_ == address(0)
                || address(amm_) == address(0) || address(twapOracle_) == address(0)
        ) revert ZeroAddress();
        if (maxTwapDeviationBps_ == 0 || maxTwapDeviationBps_ > 1000) revert UnsafeZap();
        share = share_;
        weth = weth_;
        farm = farm_;
        daoWallet = daoWallet_;
        amm = amm_;
        twapOracle = twapOracle_;
        maxTwapDeviationBps = maxTwapDeviationBps_;
    }

    /// @dev Launch passes the planned CREATE3 farm address to the constructor; this late bind
    ///      is DAO-wallet-only so a stranger can't claim the zapper first.
    function bindFarm(
        address farm_
    ) external {
        if (msg.sender != daoWallet || farm != address(0) || farm_ == address(0)) revert Unauthorized();
        farm = farm_;
    }

    function lpToken() external view returns (address) {
        return amm.lpToken();
    }

    function zap(
        address,
        uint256 shareAmount,
        uint256 minWethOut,
        uint256 minLpOut
    ) external nonReentrant returns (uint256 lpOut, uint256 shareDust, uint256 wethDust) {
        if (msg.sender != farm) revert Unauthorized();
        if (shareAmount < 2) revert InvalidAmount();
        _guardTwap();
        uint256 toSell = shareAmount / 2;
        uint256 toKeep = shareAmount - toSell;
        share.forceApprove(address(amm), toSell);
        uint256 wethOut = amm.swapShareForWeth(toSell, minWethOut);
        if (wethOut < minWethOut) revert SlippageExceeded();
        share.forceApprove(address(amm), toKeep);
        weth.forceApprove(address(amm), wethOut);
        uint256 shareUsed;
        uint256 wethUsed;
        (lpOut, shareUsed, wethUsed) = amm.addLiquidity(toKeep, wethOut, minLpOut);
        if (lpOut < minLpOut) revert SlippageExceeded();
        shareDust = toKeep - shareUsed;
        wethDust = wethOut - wethUsed;
        IERC20(amm.lpToken()).safeTransfer(farm, lpOut);
        if (shareDust != 0) share.safeTransfer(farm, shareDust);
        if (wethDust != 0) weth.safeTransfer(daoWallet, wethDust);
    }

    function _guardTwap() private view {
        (uint256 twap,, bool valid) = twapOracle.latestValidatedTwap();
        if (!valid || twap == 0) revert UnsafeZap();
        uint256 spot = amm.spotPrice();
        if (MasonryRangeLib.deviationBps(spot, twap) > maxTwapDeviationBps) revert UnsafeZap();
    }
}
