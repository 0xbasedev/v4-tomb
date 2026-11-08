// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {MasonryLaunchParams} from "./MasonryLaunchConfig.sol";
import {MasonryFarm} from "../src/masonry/MasonryFarm.sol";
import {MasonryPooledRangeVault} from "../src/masonry/MasonryPooledRangeVault.sol";
import {MasonryShareWethZapper, IShareWethAmm, IZapTwap} from "../src/masonry/MasonryShareWethZapper.sol";
import {MasonryRangeManager, IMasonryRangeTwap} from "../src/masonry/MasonryRangeManager.sol";
import {IMasonryFireTax} from "../src/masonry/IMasonryFireTax.sol";

/// @notice Builds reviewed initcode for the liquidity-layer roles. Every policy value comes from
/// MasonryLaunchParams (config/masonry-launch*.json); every address from the CREATE3 plan.
library MasonryLaunchInitCode {
    struct Addrs {
        IPoolManager poolManager;
        address share;
        address weth;
        address shareWethLp;
        address chamber; // Masonry
        address farm; // planned
        address zapper; // planned
        address admin;
        address shareWethAmm;
        address shareWethTwap;
        address levelTwap;
        address squareTwap;
        address levelHook;
        address squareHook;
    }

    function farm(MasonryLaunchParams memory p, Addrs memory a, uint256 startTime, uint256 budget)
        internal pure returns (bytes memory)
    {
        return bytes.concat(
            type(MasonryFarm).creationCode,
            abi.encode(
                IERC20(a.share), startTime, p.farmEmissionDays * 1 days, budget, a.admin, IERC20(a.shareWethLp),
                p.farmShareWethLpAllocPoints,
                MasonryFarm.Policy({
                    claimToWallet: p.farmClaimToWallet,
                    withdrawCooldown: p.farmWithdrawCooldownSeconds,
                    daoWallet: p.daoWallet,
                    masonry: a.chamber,
                    zapper: a.zapper,
                    fireTax: IMasonryFireTax(a.levelHook)
                })
            )
        );
    }

    function zapper(MasonryLaunchParams memory p, Addrs memory a) internal pure returns (bytes memory) {
        return bytes.concat(
            type(MasonryShareWethZapper).creationCode,
            abi.encode(
                IERC20(a.share), IERC20(a.weth), a.farm, p.daoWallet, IShareWethAmm(a.shareWethAmm),
                IZapTwap(a.shareWethTwap), uint16(p.rangeSquareMaxTwapDeviationBps)
            )
        );
    }

    function pooledVault(MasonryLaunchParams memory p, Addrs memory a, PoolKey memory levelKey, uint160 sqrtPeg)
        internal pure returns (bytes memory)
    {
        return bytes.concat(
            type(MasonryPooledRangeVault).creationCode,
            abi.encode(
                a.poolManager, levelKey,
                p.rangeLevelPegAnchor ? MasonryPooledRangeVault.Strategy.PegAnchor : MasonryPooledRangeVault.Strategy.FixedPeg, uint16(p.rangeLevelHalfWidthBps),
                sqrtPeg, p.farmWithdrawCooldownSeconds, a.admin, p.daoWallet, IMasonryFireTax(a.levelHook),
                MasonryPooledRangeVault.RangeGuards(
                    uint16(p.rangeLevelRecenterBps), p.rangeLevelCooldownSeconds, uint16(p.rangeLevelMaxTwapDeviationBps)
                )
            )
        );
    }

    function levelRangeManager(MasonryLaunchParams memory p, Addrs memory a, PoolKey memory key, bool level0, uint160 sqrtPeg, uint128 minLiq)
        internal pure returns (bytes memory)
    {
        MasonryRangeManager.RangeConfig memory c = MasonryRangeManager.RangeConfig({
            halfWidthBps: uint16(p.rangeLevelHalfWidthBps),
            recenterBps: uint16(p.rangeLevelRecenterBps),
            cooldown: p.rangeLevelCooldownSeconds,
            maxTwapDeviationBps: uint16(p.rangeLevelMaxTwapDeviationBps),
            minPoolLiquidity: minLiq,
            lowerHalfWidthBps: uint16(p.rangeLevelLowerHalfWidthBps),
            upperHalfWidthBps: uint16(p.rangeLevelUpperHalfWidthBps),
            sqrtPeg: sqrtPeg,
            pegAnchor: p.rangeLevelPegAnchor
        });
        return bytes.concat(
            type(MasonryRangeManager).creationCode,
            abi.encode(a.poolManager, key, IMasonryRangeTwap(a.levelTwap), a.levelHook, level0, c)
        );
    }

    function squareRangeManager(MasonryLaunchParams memory p, Addrs memory a, PoolKey memory key, bool square0, uint128 minLiq)
        internal pure returns (bytes memory)
    {
        MasonryRangeManager.RangeConfig memory c = MasonryRangeManager.RangeConfig({
            halfWidthBps: uint16(p.rangeSquareHalfWidthBps),
            recenterBps: uint16(p.rangeSquareRecenterBps),
            cooldown: p.rangeSquareCooldownSeconds,
            maxTwapDeviationBps: uint16(p.rangeSquareMaxTwapDeviationBps),
            minPoolLiquidity: minLiq,
            lowerHalfWidthBps: 0,
            upperHalfWidthBps: 0,
            sqrtPeg: 0,
            pegAnchor: false
        });
        return bytes.concat(
            type(MasonryRangeManager).creationCode,
            abi.encode(a.poolManager, key, IMasonryRangeTwap(a.squareTwap), a.squareHook, square0, c)
        );
    }
}
