// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MasonryRules} from "../masonry/MasonryRules.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {MasonryTaxHook} from "./MasonryTaxHook.sol";
import {MasonryLevelHook} from "./MasonryLevelHook.sol";
import {MasonryGenesisSchedule} from "../masonry/MasonryGenesisSchedule.sol";
import {MasonryCriticalDefense} from "../masonry/MasonryCriticalDefense.sol";
import {IMasonryPolSink} from "../masonry/IMasonryPolSink.sol";
import {IMasonryBurnableLevel} from "../masonry/MasonryGenesisLPBurnFee.sol";
import {MasonrySquareSwapLib} from "../masonry/MasonrySquareSwapLib.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";

/// @notice X Share sell tax: 3% while X Tomb is at or above peg, rising to 6% when X Tomb is
/// 10% under peg (fast up, 7-hour recovery down), and never below the Genesis Tax.
/// Tax collected while X Tomb is at or above peg is sold for the stablecoin and sent to the DAO
/// wallet. Tax collected while X Tomb is under peg buys X Tomb and burns it. Both happen through
/// separate permissionless calls (not inside the user swap), once at least $5 has built up.
contract MasonrySquareHook is MasonryTaxHook, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint16 public constant BOOTSTRAP_TAX_BPS = MasonryRules.GENESIS_TAX_BPS;
    uint256 private constant LEVEL_PEG = 1e18;
    /// @notice X Share tax collected under peg, waiting to buy and burn X Tomb.
    uint256 public pendingBuybackSquare;
    /// @notice Smallest batch a route will sell: $5 of the pool's stablecoin.
    uint256 public immutable minRouteQuote;

    struct RoutingConfig {
        PoolKey levelPool;
        address treasury;
        address polBinder;
        uint256 squareReferencePrice;
        uint128 maxSquarePerRoute;
        uint16 maxDeviationBps;
        MasonryCriticalDefense defense;
    }

    MasonryGenesisSchedule public immutable schedule;
    MasonryLevelHook public immutable levelHook;
    MasonryCriticalDefense public immutable defense;
    address public immutable treasury;
    uint256 public immutable squareReferencePrice;
    uint128 public immutable maxSquarePerRoute;
    uint16 public immutable maxDeviationBps;

    address public immutable polBinder;
    IMasonryPolSink public polVault;
    PoolKey private levelPool;
    /// @notice X Share tax collected at or above peg, waiting to be sold for the DAO wallet.
    uint256 public usdcReserveSquare;
    uint256 public deferredSquareClaims;
    uint256 public usdcRouted;
    uint256 public levelBurned;

    error UnsafeRoute();

    event SellTax(uint256 squareAmount, uint16 rateBps);
    event RouteSettled(bool indexed critical, uint256 squareIn, uint256 amountOut);

    constructor(
        IPoolManager manager,
        OracleConfig memory oracleConfig,
        address square,
        address usdc,
        uint24 lpFee,
        int24 spacing,
        RoutingConfig memory config
    ) MasonryTaxHook(manager, oracleConfig, square, usdc, lpFee, spacing) {
        MasonryLevelHook hook = MasonryLevelHook(address(config.levelPool.hooks));
        if (
            address(hook).code.length == 0 || hook.poolManager() != manager || hook.level() == square
                || PoolId.unwrap(config.levelPool.toId()) != PoolId.unwrap(hook.officialPool())
                || Currency.unwrap(hook.levelIsCurrency0() ? config.levelPool.currency1 : config.levelPool.currency0)
                    != usdc || config.treasury == address(0) || config.polBinder == address(0)
                || config.squareReferencePrice == 0 || config.squareReferencePrice > 1e36
                || config.maxSquarePerRoute == 0 || config.maxSquarePerRoute > uint256(uint128(type(int128).max))
                || config.maxDeviationBps == 0 || config.maxDeviationBps > 500
        ) revert InvalidConfiguration();
        polBinder = config.polBinder;
        levelPool = config.levelPool;
        levelHook = hook;
        schedule = hook.schedule();
        if (address(config.defense).code.length == 0 || address(config.defense.oracle()) != address(hook.oracle())) {
            revert InvalidConfiguration();
        }
        defense = config.defense;
        treasury = config.treasury;
        squareReferencePrice = config.squareReferencePrice;
        maxSquarePerRoute = config.maxSquarePerRoute;
        maxDeviationBps = config.maxDeviationBps;
        minRouteQuote = 5 * 10 ** IERC20Metadata(usdc).decimals();
    }

    function _sellTaxBps() internal view override returns (uint16) {
        return shareSellTaxBps();
    }

    /// @notice Current X Share sell tax. Follows the X Tomb peg: the curve's rate at the X Tomb
    /// TWAP, held up by X Tomb's 7-hour recovery floor and by the Genesis Tax. With no valid
    /// X Tomb TWAP the full 6% applies.
    function shareSellTaxBps() public view returns (uint16 rate) {
        uint16 base = MasonryRules.SHARE_BASE_SELL_TAX_BPS;
        uint256 twap = _levelTwap();
        if (twap == 0) return MAX_TAX_BPS;
        rate = MasonryRules.targetSellTaxBps(twap, LEVEL_PEG, base, MAX_TAX_BPS, MasonryRules.DEFAULT_FULL_TAX_DROP_BPS);
        uint16 raised = levelHook.raisedBps();
        uint16 recovery =
            MasonryRules.recoveryFloorBps(raised < base ? base : raised, base, levelHook.raisedAt(), block.timestamp);
        if (recovery > rate) rate = recovery;
        uint16 floor = _bootstrapFloor();
        if (floor > rate) rate = floor;
    }

    /// @dev The validated X Tomb TWAP, or 0 when there is none.
    function _levelTwap() private view returns (uint256) {
        try levelHook.peekValidatedTwap() returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }

    function bindPolVault(
        IMasonryPolSink vault
    ) external {
        if (
            msg.sender != polBinder || address(polVault) != address(0) || address(vault).code.length == 0
                || PoolId.unwrap(vault.poolKey().toId()) != PoolId.unwrap(officialPool)
                || vault.manager() != poolManager
        ) {
            revert InvalidConfiguration();
        }
        polVault = vault;
    }

    function _collectTax(
        uint256 amount,
        uint16 rate
    ) internal override {
        Currency square = Currency.wrap(asset);
        if (poolManager.getSyncedCurrency() == square) {
            // Mint v4 claims without changing the caller's ERC20 snapshot.
            // Claims are materialized before a later buy-and-burn.
            poolManager.mint(address(this), square.toId(), amount);
            deferredSquareClaims += amount;
        } else {
            poolManager.take(square, address(this), amount);
        }
        // Under peg the tax buys and burns X Tomb; otherwise it is sold for the DAO wallet.
        // The bucket is fixed at collection time and later price changes do not move it.
        if (_levelTwap() < LEVEL_PEG) pendingBuybackSquare += amount;
        else usdcReserveSquare += amount;
        emit SellTax(amount, rate);
    }

    /// @notice Permissionless X Share → stablecoin → X Tomb buy-and-burn of the under-peg tax.
    /// Not invoked from `afterSwap`, so it cannot sandwich or reenter the user's swap.
    /// Slippage is bounded by TWAP (`maxDeviationBps`) inside MasonrySquareSwapLib.swapGuarded.
    function buyAndBurn() external {
        poolManager.unlock(abi.encode(true));
    }

    /// @notice Permissionless X Share → stablecoin sale of the at-or-above-peg tax, paid to the DAO wallet.
    function sweepToDao() external {
        poolManager.unlock(abi.encode(false));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlySelf();
        _route(abi.decode(data, (bool)));
        return "";
    }

    function _route(
        bool burn
    ) private {
        if (deferredSquareClaims != 0) {
            uint256 materialize = deferredSquareClaims < maxSquarePerRoute ? deferredSquareClaims : maxSquarePerRoute;
            deferredSquareClaims -= materialize;
            Currency square = Currency.wrap(asset);
            poolManager.burn(address(this), square.toId(), materialize);
            poolManager.take(square, address(this), materialize);
        }
        uint256 available = burn ? pendingBuybackSquare : usdcReserveSquare;
        uint256 amount = available < maxSquarePerRoute ? available : maxSquarePerRoute;
        if (amount == 0) revert UnsafeRoute();
        if (burn) pendingBuybackSquare -= amount;
        else usdcReserveSquare -= amount;
        uint256 usdcAmount = MasonrySquareSwapLib.swapGuarded(
            poolManager, officialPoolKey(), oracle, assetIsCurrency0, amount, true, maxDeviationBps
        );
        // Wait until at least $5 has built up.
        if (usdcAmount < minRouteQuote) revert UnsafeRoute();
        _recordPool(true); // The PoolManager skips hooks for the hook's own X Share swap.
        uint256 received = usdcAmount;
        if (burn) {
            received = MasonrySquareSwapLib.swapGuarded(
                poolManager,
                levelPool,
                levelHook.oracle(),
                !levelHook.levelIsCurrency0(),
                usdcAmount,
                false,
                maxDeviationBps
            );
            IMasonryBurnableLevel(levelHook.level()).burn(received);
            levelBurned += received;
        } else {
            IERC20(quoteToken).safeTransfer(treasury, received);
            usdcRouted += received;
        }
        emit RouteSettled(burn, amount, received);
    }

    function _bootstrapFloor() internal view override returns (uint16) {
        return MasonryRules.genesisTaxFloorBps(schedule.active(), schedule.end(), block.timestamp);
    }

    function _referencePrice() internal view override returns (uint256) {
        return squareReferencePrice;
    }
}
