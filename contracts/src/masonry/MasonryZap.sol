// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {SwapMath} from "v4-core/src/libraries/SwapMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BitMath} from "v4-core/src/libraries/BitMath.sol";
import {LiquidityMath} from "v4-core/src/libraries/LiquidityMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {IMasonryExactInputV4Router} from "./MasonryGenesisLPBurnFee.sol";

/// @notice The slice of a MasonryUsdcVault this zap drives. The vault's
/// deposit() is shares-denominated with per-token input caps and mints to an
/// arbitrary recipient — that recipient parameter is what makes a one-tx zap
/// possible at all. feeReserve0/1 and totalSupply() are the vault's public
/// fee-equalization state: a deposit of S shares pulls principal at the live
/// price PLUS ceil(feeReserve * S / supply) per token, so the equalization
/// top-up is derivable in advance instead of discovered by trial.
interface IMasonryZapVault {
    function poolKey() external view returns (PoolKey memory);
    function manager() external view returns (IPoolManager);
    function assetIsCurrency0() external view returns (bool);
    function tickLower() external view returns (int24);
    function tickUpper() external view returns (int24);
    function feeReserve0() external view returns (uint256);
    function feeReserve1() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function deposit(uint256 shares, uint256 maxAsset, uint256 maxUsdc, address recipient)
        external
        returns (uint256 assetIn, uint256 usdcIn);
}

/// @notice Genesis staking's zap-facing slice: the gated beneficiary entry
/// plus the position/accounting reads used to measure credited stake.
interface IMasonryZapGenesisStaking {
    function depositFor(uint256 pool, uint256 amount, address beneficiary) external;
    function positions(uint256 pool, address account) external view returns (uint256 shares, uint256, uint256);
    function standardAsset() external view returns (address);
    function lpAsset() external view returns (address);
    function lpFee() external view returns (address);
}

interface IMasonryZapBurnFee {
    function DEPOSIT_BURN_FEE_BPS() external view returns (uint256);
}

/// @notice The farm's zap-facing slice (ShareRewardPool).
interface IMasonryZapFarm {
    function depositFor(uint256 pid, uint256 amount, address beneficiary) external;
    function userInfo(uint256 pid, address account) external view returns (uint256 amount, uint256 rewardDebt);
    function poolInfo(uint256 pid) external view returns (address token, uint256, uint256, uint256, bool);
    function poolLength() external view returns (uint256);
}

/// @notice The Masonry (Boardroom)'s zap-facing slice.
interface IMasonryZapBoardroom {
    function stakeFor(address beneficiary, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function share() external view returns (address);
}

/**
 * @title MasonryZap
 * @notice One engine for every conversion the app offers, in the ZapBase
 *         pattern reshaped for this tree's Uniswap V4 hooked pools:
 *           - swap(): token→token conversion (the app's Swap),
 *           - LP zap-in: stable → LP created AND staked for the user,
 *           - zap-and-stake to Genesis (standard and LP pools), both farms
 *             and the Masonry (Boardroom),
 *         from any input the destination can price: the stable, or the
 *         destination's own stake asset (a direct stake, no conversion).
 *         Inputs are measured by balance delta (never trusted from the
 *         argument), limits bind at every step, and snapshot-delta refunds
 *         return anything not consumed — prior balances can never be
 *         spent and no residual ever strands here.
 *
 * @dev SOLVED SPLIT. The LP split is solved, not guessed: _simulateSwap
 *      replays the pool's own swap loop in view code (Pool.swap's tick
 *      walk over SwapMath.computeSwapStep, live slot0 fees), so a
 *      simulated swap is the swap, bit for bit, price impact and tick
 *      crossings included. _solveSwapAmount bisects the swap size against
 *      that simulation, valuing the leftover of whichever deposit leg
 *      would remain, using the vault's exact deposit pulls at the
 *      simulated post-swap price — principal from the range math PLUS the
 *      fee-equalization top-up derived from the vault's public reserves
 *      (grown by the position fees the deposit's own collection is about
 *      to harvest, read via fee-growth state). The executed swap passes
 *      the simulated output as its router minimum, so model drift reverts
 *      with the user whole instead of mis-filling; the deposit share
 *      count is then solved exactly against live post-swap state. If a
 *      swap would cross more initialized ticks than the simulation's step
 *      cap, execution degrades to the caller's own limits — never to an
 *      unverified formula.
 *
 *      STAKING. Every staking route ends STAKED for the beneficiary via
 *      the staking contracts' gated beneficiary entries (depositFor /
 *      stakeFor), which only this zap may call and which read every
 *      user-keyed check — pass tier, pool gates, reward checkpoints,
 *      epoch timers — from the beneficiary. Credited stake is measured by
 *      the staking contract's own accounting delta, Lodge-style, and the
 *      caller's minimum binds the credited amount.
 *
 *      SELL-SIDE INPUTS. Converting a pool asset INTO an LP position
 *      would require selling part of it through the fire-tax hook. That
 *      sell is not exactly solvable from outside the hook (the Square
 *      hook's after-sell routing performs further gas-dependent swaps
 *      and vault deposits), so asset input on LP routes reverts
 *      UnsupportedInput rather than guessing a split. Asset inputs that
 *      need no sell — the destination's own stake asset, and the Genesis
 *      standard / Masonry conversions where the asset IS the target —
 *      are fully supported. On the swap route, sells execute through the
 *      real pool (the hook takes whatever it takes) and the caller's
 *      minOut binds the measured receipt.
 *
 *      FEES (spec §15 house toll): one 0.5% route fee per call, taken
 *      once, in the input asset, on the amount actually received.
 *      EXCEPTION, carried from MasonryGenesisLPBurnFee's own rule ("a zap
 *      ending at Genesis must not separately charge the 0.5% route fee"):
 *      the Genesis LP route charges NO route fee, because staking those
 *      shares into Genesis pool 1 charges the 0.5% Genesis LP deposit
 *      burn fee. The Genesis STANDARD route does charge it: GenesisStaking
 *      credits pool 0 deposits gross (its fee call runs only for pool 1),
 *      so there is no second toll to double. The swap route charges it
 *      like every other conversion. Rate and recipient are admin config;
 *      the template speaks human units (routeFeePercent).
 *
 *      DEPLOY ORDER (constructor cross-checks enforce it): pools and
 *      vaults → farm pools added (pid 0 = Level vault, pid 1 = Square
 *      vault) → Genesis staking funded → this zap → setZapOperator(zap)
 *      called by each staking contract's admin.
 */
contract MasonryZap is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 public constant BPS = 10_000;
    /// @notice Safety bound on the admin-settable route fee (5%). This is a
    /// cap, not the rate — the rate itself is config, default 0.5%.
    uint256 public constant MAX_ROUTE_FEE_BPS = 500;
    /// @notice Reference liquidity for per-unit range amounts. Only ratios
    /// matter, never the absolute size.
    uint128 private constant REFERENCE_LIQUIDITY = 1e18;
    /// @notice Cap on simulated swap steps (initialized-tick crossings plus
    /// bitmap word hops). A swap needing more degrades to caller limits.
    uint256 private constant MAX_SWAP_STEPS = 64;
    /// @notice Bisection budget for the split solve.
    uint256 private constant SOLVE_ITERATIONS = 40;
    /// @notice Bisection budget for the exact deposit share solve. Pulls are
    /// monotone in shares, so this converges to the exact maximum.
    uint256 private constant SHARE_ITERATIONS = 64;

    enum Destination {
        GenesisLP,
        FarmLevel,
        FarmShare,
        Masonry,
        GenesisStandard,
        Swap
    }

    IMasonryExactInputV4Router public immutable router;
    IERC20 public immutable usdc;
    IMasonryZapVault public immutable levelVault;
    IMasonryZapVault public immutable squareVault;
    IMasonryZapGenesisStaking public immutable genesisStaking;
    IMasonryZapFarm public immutable farm;
    IMasonryZapBoardroom public immutable boardroom;
    IERC20 public immutable levelToken;
    IERC20 public immutable squareToken;
    /// @notice Genesis pool 0's stake asset, read from the staking
    /// contract (its constructor forbids the reward token there, so this
    /// is a deployment configuration — the stable in the tree's own
    /// Genesis fixture — never an assumption baked into this zap).
    IERC20 public immutable standardToken;
    /// @notice The vault whose pool prices the standard token (zero when
    /// the standard token IS the stable: no conversion exists or is needed).
    IMasonryZapVault public immutable standardVault;

    address public feeRecipient;
    uint256 public routeFeeBps;

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidFee();
    error Expired();
    error BelowMinShares(uint256 minShares, uint256 actualShares);
    error BelowMinOut(uint256 minOut, uint256 actualOut);
    error UnsupportedInput(address token);
    error UnsupportedOutput(address token);
    error DepositFailed();
    error PriorBalanceSpent();

    event ZapIn(
        address indexed user,
        address indexed inputToken,
        Destination indexed destination,
        uint256 amountIn,
        uint256 feePaid,
        uint256 output,
        uint256 usdcRefunded,
        uint256 assetRefunded
    );
    event RouteFeeUpdated(uint256 previousBps, uint256 newBps);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    constructor(
        address router_,
        address usdc_,
        address levelVault_,
        address squareVault_,
        address genesisStaking_,
        address farm_,
        address boardroom_,
        address feeRecipient_,
        uint256 routeFeeBps_,
        address owner_
    ) Ownable(owner_) {
        if (
            router_.code.length == 0 || usdc_.code.length == 0 || levelVault_.code.length == 0
                || squareVault_.code.length == 0 || genesisStaking_.code.length == 0 || farm_.code.length == 0
                || boardroom_.code.length == 0 || levelVault_ == squareVault_ || feeRecipient_ == address(0)
                || routeFeeBps_ > MAX_ROUTE_FEE_BPS
        ) revert InvalidConfiguration();
        // Both vaults must pair the configured stable against their asset.
        if (!_pairsUsdc(IMasonryZapVault(levelVault_), usdc_) || !_pairsUsdc(IMasonryZapVault(squareVault_), usdc_)) {
            revert InvalidConfiguration();
        }
        router = IMasonryExactInputV4Router(router_);
        usdc = IERC20(usdc_);
        levelVault = IMasonryZapVault(levelVault_);
        squareVault = IMasonryZapVault(squareVault_);
        genesisStaking = IMasonryZapGenesisStaking(genesisStaking_);
        farm = IMasonryZapFarm(farm_);
        boardroom = IMasonryZapBoardroom(boardroom_);
        levelToken = _assetOf(levelVault, levelVault.assetIsCurrency0());
        squareToken = _assetOf(squareVault, squareVault.assetIsCurrency0());

        // Cross-check the staking wiring (Zap.sol constructor pattern):
        // Genesis LP asset is the Level vault; farm pid 0 stakes the Level
        // vault, pid 1 the Square vault; the Boardroom stakes the Square
        // token; the Genesis standard asset is one this engine can price.
        if (genesisStaking.lpAsset() != levelVault_ || boardroom.share() != address(squareToken) || farm.poolLength() < 2) {
            revert InvalidConfiguration();
        }
        (address farmToken0,,,,) = farm.poolInfo(0);
        (address farmToken1,,,,) = farm.poolInfo(1);
        if (farmToken0 != levelVault_ || farmToken1 != squareVault_) revert InvalidConfiguration();
        address standard = genesisStaking.standardAsset();
        if (standard != usdc_ && standard != address(levelToken) && standard != address(squareToken)) {
            revert InvalidConfiguration();
        }
        standardToken = IERC20(standard);
        standardVault = standard == address(levelToken)
            ? levelVault
            : standard == address(squareToken) ? squareVault : IMasonryZapVault(address(0));
        feeRecipient = feeRecipient_;
        routeFeeBps = routeFeeBps_;
    }

    /* ------------------------------ admin ------------------------------ */

    function setRouteFeeBps(
        uint256 newBps
    ) external onlyOwner {
        if (newBps > MAX_ROUTE_FEE_BPS) revert InvalidFee();
        emit RouteFeeUpdated(routeFeeBps, newBps);
        routeFeeBps = newBps;
    }

    function setFeeRecipient(
        address newRecipient
    ) external onlyOwner {
        if (newRecipient == address(0)) revert InvalidConfiguration();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /* ------------------------------ generic entry ------------------------------ */

    /// @notice The generic zap: convert `inputToken` into the destination's
    /// staked position for the caller, in one transaction. Accepted inputs
    /// per destination — the stable, or the destination's own stake asset
    /// (Level vault shares for GenesisLP/FarmLevel, Square vault shares for
    /// FarmShare, the standard asset for GenesisStandard, the Square token
    /// for Masonry). minOutput floors the CREDITED stake (net of the
    /// Genesis pool-1 burn fee on the GenesisLP route).
    function zap(
        address inputToken,
        uint256 amountIn,
        Destination destination,
        uint256 minOutput,
        uint256 deadline
    ) external nonReentrant returns (uint256 output) {
        if (destination == Destination.GenesisStandard) {
            return _zapStandard(IERC20(inputToken), amountIn, minOutput, deadline);
        }
        if (destination == Destination.Masonry) {
            return _zapMasonry(IERC20(inputToken), amountIn, minOutput, deadline);
        }
        if (destination == Destination.Swap) revert InvalidConfiguration();
        // LP destinations.
        IMasonryZapVault vault = destination == Destination.FarmShare ? squareVault : levelVault;
        if (inputToken == address(vault)) {
            return _stakeDirect(IERC20(inputToken), amountIn, destination, minOutput, deadline);
        }
        if (inputToken != address(usdc)) revert UnsupportedInput(inputToken);
        return _zapLP(vault, destination, amountIn, minOutput, deadline);
    }

    /* ------------------------------ named routes ------------------------------ */

    /// @notice Zap into Genesis's LP pool: LP created and staked in pool 1
    /// for the caller. NO route fee (the pool-1 deposit burn fee applies
    /// instead — one toll per action). minShares floors the credited
    /// (net) stake.
    function zapToGenesisLP(
        uint256 amountIn,
        uint256 minShares,
        uint256 deadline
    ) external nonReentrant returns (uint256 credited) {
        return _zapLP(levelVault, Destination.GenesisLP, amountIn, minShares, deadline);
    }

    /// @notice Zap into the xTOMB LP farm: LP created and staked in farm
    /// pid 0 for the caller.
    function zapToFarmLevel(
        uint256 amountIn,
        uint256 minShares,
        uint256 deadline
    ) external nonReentrant returns (uint256 credited) {
        return _zapLP(levelVault, Destination.FarmLevel, amountIn, minShares, deadline);
    }

    /// @notice Zap into the xSHARE LP farm: LP created and staked in farm
    /// pid 1 for the caller.
    function zapToFarmShare(
        uint256 amountIn,
        uint256 minShares,
        uint256 deadline
    ) external nonReentrant returns (uint256 credited) {
        return _zapLP(squareVault, Destination.FarmShare, amountIn, minShares, deadline);
    }

    /// @notice Zap into the Masonry: the stable is converted to the share
    /// token and staked in the Boardroom for the caller.
    function zapToMasonry(
        uint256 amountIn,
        uint256 minStake,
        uint256 deadline
    ) external nonReentrant returns (uint256 credited) {
        return _zapMasonry(usdc, amountIn, minStake, deadline);
    }

    /// @notice Zap into Genesis's standard pool: staked in pool 0 for the
    /// caller. When the pool's configured standard asset is the stable
    /// this is a direct stake; when it is a pool asset, the stable is
    /// swapped to it at the simulated rate first. The route fee IS
    /// charged — pool 0 deposits are credited gross, so no second toll
    /// exists to double.
    function zapToGenesisStandard(
        uint256 amountIn,
        uint256 minStake,
        uint256 deadline
    ) external nonReentrant returns (uint256 credited) {
        return _zapStandard(usdc, amountIn, minStake, deadline);
    }

    /// @notice Asset-in form of the Genesis standard route: the pool's
    /// standard asset in, staked in pool 0 for the caller, route fee
    /// taken in that asset.
    function zapAssetToGenesisStandard(
        uint256 amountIn,
        uint256 minStake,
        uint256 deadline
    ) external nonReentrant returns (uint256 credited) {
        return _zapStandard(standardToken, amountIn, minStake, deadline);
    }

    /// @notice Token→token conversion — the app's Swap, as a first-class
    /// route of this engine (the frontend Swap page consumes this surface
    /// directly). Priceable pairs: either asset against the stable on its
    /// own hooked pool, and asset↔asset bridged through the stable in one
    /// transaction. Buys execute at the simulated rate (the quote binds
    /// the swap); sells execute through the real pool with minOut binding
    /// the measured receipt (the fire-tax hook's take is whatever it is).
    /// The route fee is charged in the input asset.
    function swap(
        address inputToken,
        uint256 amountIn,
        address outputToken,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        return _swap(IERC20(inputToken), amountIn, IERC20(outputToken), minOut, deadline);
    }

    /* ------------------------------ quoting ------------------------------ */

    /// @notice Solved quote for a stable-in zap: the fee that would be
    /// taken and the CREDITED stake the zap would land at the current
    /// pool state, computed with the same simulation and deposit math the
    /// real zap executes. (GenesisLP is quoted net of the pool-1 burn
    /// fee; Masonry and GenesisStandard quote the swapped asset amount,
    /// which stakes 1:1.)
    function previewZap(
        Destination destination,
        uint256 amountIn
    ) external view returns (uint256 fee, uint256 output) {
        if (destination == Destination.Swap) revert InvalidConfiguration();
        IMasonryZapVault vault = destination == Destination.FarmShare ? squareVault : levelVault;
        bool chargeFee = destination != Destination.GenesisLP;
        fee = chargeFee ? amountIn * routeFeeBps / BPS : 0;
        uint256 work = amountIn - fee;
        if (work == 0) return (fee, 0);

        if (destination == Destination.Masonry) {
            (uint256 expOut,, bool done) =
                _simulateSwap(squareVault.manager(), squareVault.poolKey(), !squareVault.assetIsCurrency0(), work);
            if (done) return (fee, expOut);
            return (fee, _spotAssetEstimate(squareVault, work));
        }
        if (destination == Destination.GenesisStandard) {
            if (address(standardVault) == address(0)) return (fee, work); // standard asset IS the stable
            (uint256 expOut,, bool done) =
                _simulateSwap(standardVault.manager(), standardVault.poolKey(), !standardVault.assetIsCurrency0(), work);
            if (done) return (fee, expOut);
            return (fee, _spotAssetEstimate(standardVault, work));
        }

        bool assetIs0 = vault.assetIsCurrency0();
        (uint256 swapAmt, uint256 expectedOut, uint160 sqrtAfter, bool complete) =
            _solveSwapAmount(vault, vault.poolKey(), assetIs0, work);
        uint256 gross;
        if (!complete) {
            gross = _spotPreviewShares(vault, assetIs0, work);
        } else {
            gross = _maxShares(vault, sqrtAfter, expectedOut, work - swapAmt);
        }
        if (destination == Destination.GenesisLP) {
            uint256 burnBps = IMasonryZapBurnFee(genesisStaking.lpFee()).DEPOSIT_BURN_FEE_BPS();
            gross -= gross * burnBps / BPS;
        }
        return (fee, gross);
    }

    /// @notice Quote for the asset-in Genesis standard route: fee and the
    /// stake credited for an asset input (no conversion; stakes 1:1).
    function previewZapAssetToGenesisStandard(
        uint256 amountIn
    ) external view returns (uint256 fee, uint256 credited) {
        fee = amountIn * routeFeeBps / BPS;
        return (fee, amountIn - fee);
    }

    /// @notice Quote for swap(): the fee and the expected output at the
    /// current pool state. Buy legs are exact (the same simulation the
    /// swap binds). Sell legs are quoted GROSS of the fire tax — the
    /// hook's rate is stateful, so a sell's net receipt is whatever the
    /// pool delivers, floored by the caller's minOut at execution.
    function previewSwap(
        address inputToken,
        uint256 amountIn,
        address outputToken
    ) external view returns (uint256 fee, uint256 expectedOut) {
        fee = amountIn * routeFeeBps / BPS;
        uint256 work = amountIn - fee;
        if (work == 0) return (fee, 0);
        (IMasonryZapVault leg1, IMasonryZapVault leg2) = _swapLegs(IERC20(inputToken), IERC20(outputToken));
        if (address(leg2) == address(0)) {
            (uint256 out,,) = _simulateSwap(leg1.manager(), leg1.poolKey(), _zeroForOne(leg1, IERC20(inputToken)), work);
            return (fee, out);
        }
        (uint256 mid,,) = _simulateSwap(leg1.manager(), leg1.poolKey(), _zeroForOne(leg1, IERC20(inputToken)), work);
        (uint256 out2,,) = _simulateSwap(leg2.manager(), leg2.poolKey(), _zeroForOne(leg2, usdc), mid);
        return (fee, out2);
    }

    /* ------------------------------ LP zap-in ------------------------------ */

    function _zapLP(
        IMasonryZapVault vault,
        Destination destination,
        uint256 amountIn,
        uint256 minShares,
        uint256 deadline
    ) private returns (uint256 credited) {
        if (amountIn == 0 || amountIn > uint256(type(uint128).max)) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        address user = msg.sender;
        bool assetIs0 = vault.assetIsCurrency0();
        IERC20 asset = _assetOf(vault, assetIs0);

        // Snapshot baselines before any funds move (ZapBase pattern).
        uint256 usdcBase = usdc.balanceOf(address(this));
        uint256 assetBase = asset.balanceOf(address(this));

        // Measure what actually arrived; never trust the argument.
        usdc.safeTransferFrom(user, address(this), amountIn);
        uint256 received = usdc.balanceOf(address(this)) - usdcBase;
        if (received == 0) revert InvalidAmount();

        // The one house toll, in the input asset, exactly once. The Genesis
        // LP route is exempt (see the contract notes).
        uint256 fee = destination != Destination.GenesisLP ? received * routeFeeBps / BPS : 0;
        if (fee != 0) usdc.safeTransfer(feeRecipient, fee);

        uint256 shares = _swapAndDeposit(vault, asset, assetIs0, received - fee);
        credited = _stakeLP(destination, shares, user);
        if (credited < minShares) revert BelowMinShares(minShares, credited);

        _settle(user, address(usdc), destination, amountIn, fee, credited, usdcBase, asset, assetBase);
    }

    /// @dev Solve the split, execute the swap at the simulated output as
    /// the router minimum, then deposit the exact maximum share count the
    /// live post-swap balances support, minted to this contract for the
    /// stake step.
    function _swapAndDeposit(
        IMasonryZapVault vault,
        IERC20 asset,
        bool assetIs0,
        uint256 work
    ) private returns (uint256 sharesOut) {
        IPoolManager manager = vault.manager();
        PoolKey memory key = vault.poolKey();
        (uint256 swapAmt, uint256 expectedOut,, bool complete) = _solveSwapAmount(vault, key, assetIs0, work);
        if (!complete) {
            // Degraded path: spot split, no simulated minimum — the caller's
            // minimum remains the binding protection.
            (uint160 sqrtPrice,,,) = manager.getSlot0(key.toId());
            swapAmt = _splitAmount(
                sqrtPrice,
                TickMath.getSqrtPriceAtTick(vault.tickLower()),
                TickMath.getSqrtPriceAtTick(vault.tickUpper()),
                assetIs0,
                work
            );
            expectedOut = 0;
        }
        if (swapAmt != 0) {
            // The router settles the exact pool delta from this contract, so
            // it is approved for the whole working balance rather than just
            // the swap amount — a hook-side delta can then never exceed the
            // approval mid-flight. The simulated output binds as the swap
            // minimum: any drift reverts with the user whole.
            usdc.forceApprove(address(router), usdc.balanceOf(address(this)));
            router.swapExactIn(key, !assetIs0, swapAmt, expectedOut, address(this));
            usdc.forceApprove(address(router), 0);
        }

        uint256 assetBal = asset.balanceOf(address(this));
        uint256 usdcBal = usdc.balanceOf(address(this));
        (uint160 sqrtNow,,,) = manager.getSlot0(key.toId());
        uint256 shares = _maxShares(vault, sqrtNow, assetBal, usdcBal);
        if (shares == 0) revert DepositFailed();

        asset.forceApprove(address(vault), assetBal);
        usdc.forceApprove(address(vault), usdcBal);
        sharesOut = _depositExact(vault, shares, assetBal, usdcBal, address(this));
        asset.forceApprove(address(vault), 0);
        usdc.forceApprove(address(vault), 0);
    }

    /// @dev Deposit the solved share count. The count is exact against live
    /// state, so the first attempt lands; the decrement steps below are a
    /// defensive fallback for state the model cannot see (e.g. fee growth
    /// between the read and the call inside the same transaction) and are
    /// never expected to run.
    function _depositExact(
        IMasonryZapVault vault,
        uint256 shares,
        uint256 assetBal,
        uint256 usdcBal,
        address recipient
    ) private returns (uint256) {
        try vault.deposit(shares, assetBal, usdcBal, recipient) returns (uint256, uint256) {
            return shares;
        } catch {}
        uint256[4] memory fallbacks =
            [shares * 9999 / BPS, shares * 999 / 1000, shares * 99 / 100, shares * 95 / 100];
        uint256 previous = shares;
        for (uint256 i = 0; i < fallbacks.length; i++) {
            uint256 attempt = fallbacks[i];
            if (attempt == 0 || attempt >= previous) continue;
            previous = attempt;
            try vault.deposit(attempt, assetBal, usdcBal, recipient) returns (uint256, uint256) {
                return attempt;
            } catch {}
        }
        revert DepositFailed();
    }

    /* ------------------------------ staking steps ------------------------------ */

    /// @dev Stake freshly minted vault shares into the route's staking
    /// destination for the user; returns the credited stake measured from
    /// the staking contract's own accounting.
    function _stakeLP(
        Destination destination,
        uint256 shares,
        address user
    ) private returns (uint256 credited) {
        if (destination == Destination.GenesisLP) {
            (uint256 beforeShares,,) = genesisStaking.positions(1, user);
            IERC20(address(levelVault)).forceApprove(address(genesisStaking), shares);
            genesisStaking.depositFor(1, shares, user);
            (uint256 afterShares,,) = genesisStaking.positions(1, user);
            return afterShares - beforeShares;
        }
        uint256 pid = destination == Destination.FarmShare ? 1 : 0;
        IMasonryZapVault vault = destination == Destination.FarmShare ? squareVault : levelVault;
        (uint256 beforeAmount,) = farm.userInfo(pid, user);
        IERC20(address(vault)).forceApprove(address(farm), shares);
        farm.depositFor(pid, shares, user);
        (uint256 afterAmount,) = farm.userInfo(pid, user);
        return afterAmount - beforeAmount;
    }

    /// @dev Stake the Genesis standard asset (pool 0) for the user.
    function _stakeGenesisStandard(
        uint256 amount,
        address user
    ) private returns (uint256 credited) {
        (uint256 beforeShares,,) = genesisStaking.positions(0, user);
        standardToken.forceApprove(address(genesisStaking), amount);
        genesisStaking.depositFor(0, amount, user);
        (uint256 afterShares,,) = genesisStaking.positions(0, user);
        return afterShares - beforeShares;
    }

    /// @dev Stake the share token in the Masonry (Boardroom) for the user.
    function _stakeMasonry(
        uint256 amount,
        address user
    ) private returns (uint256 credited) {
        uint256 beforeBalance = boardroom.balanceOf(user);
        squareToken.forceApprove(address(boardroom), amount);
        boardroom.stakeFor(user, amount);
        return boardroom.balanceOf(user) - beforeBalance;
    }

    /* ------------------------------ direct stake input ------------------------------ */

    /// @dev The input already IS the destination's stake asset: measure it,
    /// take the route fee in it, and stake the rest for the caller. No
    /// conversion, no sell — the purest zap-and-stake.
    function _stakeDirect(
        IERC20 input,
        uint256 amountIn,
        Destination destination,
        uint256 minOutput,
        uint256 deadline
    ) private returns (uint256 credited) {
        if (amountIn == 0 || amountIn > uint256(type(uint128).max)) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        address user = msg.sender;

        uint256 inputBase = input.balanceOf(address(this));
        input.safeTransferFrom(user, address(this), amountIn);
        uint256 received = input.balanceOf(address(this)) - inputBase;
        if (received == 0) revert InvalidAmount();

        uint256 fee = destination != Destination.GenesisLP ? received * routeFeeBps / BPS : 0;
        if (fee != 0) input.safeTransfer(feeRecipient, fee);
        uint256 work = received - fee;

        credited = _stakeLP(destination, work, user);
        if (credited < minOutput) revert BelowMinShares(minOutput, credited);

        _refundAbove(input, inputBase, user);
        emit ZapIn(user, address(input), destination, amountIn, fee, credited, 0, 0);
    }

    /* ------------------------------ Genesis standard zap ------------------------------ */

    function _zapStandard(
        IERC20 input,
        uint256 amountIn,
        uint256 minStake,
        uint256 deadline
    ) private returns (uint256 credited) {
        if (amountIn == 0 || amountIn > uint256(type(uint128).max)) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        address user = msg.sender;
        bool inputIsStandard = address(input) == address(standardToken);
        if (!inputIsStandard && address(input) != address(usdc)) revert UnsupportedInput(address(input));

        // Snapshot baselines for both legs before funds move.
        uint256 usdcBase = usdc.balanceOf(address(this));
        uint256 assetBase = standardToken.balanceOf(address(this));

        // Collect and measure the input BEFORE any payout (the reviewed
        // ZapBase flaw — paying out of prior balances — is not imported).
        input.safeTransferFrom(user, address(this), amountIn);
        uint256 received = input.balanceOf(address(this)) - (inputIsStandard ? assetBase : usdcBase);
        if (received == 0) revert InvalidAmount();

        // The route fee is charged on this route (pool 0 has no deposit
        // fee to double — see the contract notes).
        uint256 fee = received * routeFeeBps / BPS;
        if (fee != 0) input.safeTransfer(feeRecipient, fee);
        uint256 work = received - fee;

        // Direct stake when the input already is the standard asset (or
        // the stable IS the standard asset); otherwise convert first.
        uint256 staked = inputIsStandard ? work : _swapWorkToStandard(work, minStake, assetBase);
        credited = _stakeGenesisStandard(staked, user);
        if (credited < minStake) revert BelowMinOut(minStake, credited);

        _settle(user, address(input), Destination.GenesisStandard, amountIn, fee, credited, usdcBase, standardToken, assetBase);
    }

    /// @dev Swap the full stable work amount to the standard asset at the
    /// simulated rate. When the simulation completes, its output is both
    /// the quote checked against the caller's floor and the router
    /// minimum; when it cannot complete, the caller's floor alone binds
    /// the swap.
    function _swapWorkToStandard(
        uint256 work,
        uint256 minAssetOut,
        uint256 assetBase
    ) private returns (uint256 assetOut) {
        PoolKey memory key = standardVault.poolKey();
        bool assetIs0 = standardVault.assetIsCurrency0();
        (uint256 expectedOut,, bool complete) = _simulateSwap(standardVault.manager(), key, !assetIs0, work);
        uint256 swapMin = minAssetOut;
        if (complete) {
            if (expectedOut < minAssetOut) revert BelowMinOut(minAssetOut, expectedOut);
            swapMin = expectedOut; // solved quote binds the swap
        }
        usdc.forceApprove(address(router), usdc.balanceOf(address(this)));
        router.swapExactIn(key, !assetIs0, work, swapMin, address(this));
        usdc.forceApprove(address(router), 0);
        assetOut = standardToken.balanceOf(address(this)) - assetBase;
        if (assetOut < minAssetOut) revert BelowMinOut(minAssetOut, assetOut);
    }

    /* ------------------------------ Masonry zap ------------------------------ */

    function _zapMasonry(
        IERC20 input,
        uint256 amountIn,
        uint256 minStake,
        uint256 deadline
    ) private returns (uint256 credited) {
        if (amountIn == 0 || amountIn > uint256(type(uint128).max)) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        address user = msg.sender;
        bool inputIsAsset = address(input) == address(squareToken);
        if (!inputIsAsset && address(input) != address(usdc)) revert UnsupportedInput(address(input));

        uint256 usdcBase = usdc.balanceOf(address(this));
        uint256 assetBase = squareToken.balanceOf(address(this));

        input.safeTransferFrom(user, address(this), amountIn);
        uint256 received = input.balanceOf(address(this)) - (inputIsAsset ? assetBase : usdcBase);
        if (received == 0) revert InvalidAmount();

        uint256 fee = received * routeFeeBps / BPS;
        if (fee != 0) input.safeTransfer(feeRecipient, fee);
        uint256 work = received - fee;

        uint256 staked = inputIsAsset ? work : _swapWorkToSquare(work, minStake, assetBase);
        credited = _stakeMasonry(staked, user);
        if (credited < minStake) revert BelowMinOut(minStake, credited);

        _settle(user, address(input), Destination.Masonry, amountIn, fee, credited, usdcBase, squareToken, assetBase);
    }

    /// @dev Swap the full stable work amount to the share token on the
    /// Square pool at the simulated rate (same pattern as the Genesis
    /// standard route's asset leg).
    function _swapWorkToSquare(
        uint256 work,
        uint256 minAssetOut,
        uint256 assetBase
    ) private returns (uint256 assetOut) {
        PoolKey memory key = squareVault.poolKey();
        bool assetIs0 = squareVault.assetIsCurrency0();
        (uint256 expectedOut,, bool complete) = _simulateSwap(squareVault.manager(), key, !assetIs0, work);
        uint256 swapMin = minAssetOut;
        if (complete) {
            if (expectedOut < minAssetOut) revert BelowMinOut(minAssetOut, expectedOut);
            swapMin = expectedOut;
        }
        usdc.forceApprove(address(router), usdc.balanceOf(address(this)));
        router.swapExactIn(key, !assetIs0, work, swapMin, address(this));
        usdc.forceApprove(address(router), 0);
        assetOut = squareToken.balanceOf(address(this)) - assetBase;
        if (assetOut < minAssetOut) revert BelowMinOut(minAssetOut, assetOut);
    }

    /* ------------------------------ swap route ------------------------------ */

    function _swap(
        IERC20 input,
        uint256 amountIn,
        IERC20 output,
        uint256 minOut,
        uint256 deadline
    ) private returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > uint256(type(uint128).max)) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        if (address(input) == address(output)) revert InvalidConfiguration();
        address user = msg.sender;
        (IMasonryZapVault leg1, IMasonryZapVault leg2) = _swapLegs(input, output);

        // Snapshot baselines for every priceable token.
        Baselines memory base = _snapshotAll();

        input.safeTransferFrom(user, address(this), amountIn);
        uint256 received = input.balanceOf(address(this)) - _baselineOf(input, base);
        if (received == 0) revert InvalidAmount();

        // The route fee, in the input asset, exactly once.
        uint256 fee = received * routeFeeBps / BPS;
        if (fee != 0) input.safeTransfer(feeRecipient, fee);
        uint256 work = received - fee;

        if (address(leg2) == address(0)) {
            amountOut = _executeLeg(leg1, input, work, minOut, true);
        } else {
            // Bridge through the stable. Leg 1 is a sell: its receipt is
            // measured, not bound (the hook's take is stateful); leg 2 is
            // a buy at the simulated rate and carries the caller's floor.
            uint256 mid = _executeLeg(leg1, input, work, 0, false);
            amountOut = _executeLeg(leg2, usdc, mid, minOut, true);
        }

        if (output.balanceOf(address(this)) - _baselineOf(output, base) != amountOut) revert DepositFailed();
        output.safeTransfer(user, amountOut);

        _settle(user, address(input), Destination.Swap, amountIn, fee, amountOut, base.usdc, levelToken, base.level);
        _refundAbove(squareToken, base.square, user);
    }

    /// @dev Execute one swap leg through the router, returning the
    /// measured output. Buy legs (stable in) bind the simulated output as
    /// the router minimum; sell legs bind the given minimum (the final
    /// leg carries the caller's floor; a bridge's first leg is measured
    /// only, with the floor enforced on the second leg).
    function _executeLeg(
        IMasonryZapVault vault,
        IERC20 input,
        uint256 amount,
        uint256 minOutLeg,
        bool isFinal
    ) private returns (uint256 out) {
        PoolKey memory key = vault.poolKey();
        bool zeroForOne = _zeroForOne(vault, input);
        uint256 min = minOutLeg;
        if (address(input) == address(usdc)) {
            (uint256 expected,, bool complete) = _simulateSwap(vault.manager(), key, zeroForOne, amount);
            if (complete) {
                if (isFinal && expected < minOutLeg) revert BelowMinOut(minOutLeg, expected);
                min = expected; // solved quote binds the swap
            }
        }
        input.forceApprove(address(router), input.balanceOf(address(this)));
        out = router.swapExactIn(key, zeroForOne, amount, min, address(this));
        input.forceApprove(address(router), 0);
        if (isFinal && out < minOutLeg) revert BelowMinOut(minOutLeg, out);
    }

    /// @dev Resolve the pool(s) a conversion walks: a single vault for
    /// pairs involving the stable, or both vaults (bridged through the
    /// stable) for asset↔asset. Reverts for unpriceable tokens.
    function _swapLegs(
        IERC20 input,
        IERC20 output
    ) private view returns (IMasonryZapVault leg1, IMasonryZapVault leg2) {
        bool inUsdc = address(input) == address(usdc);
        bool outUsdc = address(output) == address(usdc);
        bool inLevel = address(input) == address(levelToken);
        bool outLevel = address(output) == address(levelToken);
        bool inSquare = address(input) == address(squareToken);
        bool outSquare = address(output) == address(squareToken);
        if (!(inUsdc || inLevel || inSquare)) revert UnsupportedInput(address(input));
        if (!(outUsdc || outLevel || outSquare)) revert UnsupportedOutput(address(output));
        if (inUsdc || outUsdc) {
            return ((inLevel || outLevel) ? levelVault : squareVault, IMasonryZapVault(address(0)));
        }
        // Asset↔asset: sell the input asset's pool leg, buy on the other's.
        leg1 = inLevel ? levelVault : squareVault;
        leg2 = outLevel ? levelVault : squareVault;
    }

    /// @dev Swap direction for a leg: true when the input is currency0.
    function _zeroForOne(
        IMasonryZapVault vault,
        IERC20 input
    ) private view returns (bool) {
        return Currency.unwrap(vault.poolKey().currency0) == address(input);
    }

    struct Baselines {
        uint256 usdc;
        uint256 level;
        uint256 square;
    }

    function _snapshotAll() private view returns (Baselines memory base) {
        base.usdc = usdc.balanceOf(address(this));
        base.level = levelToken.balanceOf(address(this));
        base.square = squareToken.balanceOf(address(this));
    }

    function _baselineOf(
        IERC20 token,
        Baselines memory base
    ) private view returns (uint256) {
        if (address(token) == address(usdc)) return base.usdc;
        if (address(token) == address(levelToken)) return base.level;
        return base.square;
    }

    /* ------------------------------ settle / refunds ------------------------------ */

    /// @dev Snapshot-delta refunds for the stable and one asset, then emit.
    function _settle(
        address user,
        address inputToken,
        Destination destination,
        uint256 amountIn,
        uint256 fee,
        uint256 output,
        uint256 usdcBase,
        IERC20 asset,
        uint256 assetBase
    ) private {
        uint256 usdcRefunded = _refundAbove(usdc, usdcBase, user);
        uint256 assetRefunded = _refundAbove(asset, assetBase, user);
        emit ZapIn(user, inputToken, destination, amountIn, fee, output, usdcRefunded, assetRefunded);
    }

    /// @dev Return any balance above the pre-call baseline to the caller.
    /// A balance BELOW baseline means prior funds were touched — revert
    /// (ZapBase's protected-balance rule). In practice baselines are zero:
    /// this contract holds nothing between calls.
    function _refundAbove(
        IERC20 token,
        uint256 baseline,
        address user
    ) private returns (uint256 refunded) {
        uint256 balance = token.balanceOf(address(this));
        if (balance < baseline) revert PriorBalanceSpent();
        refunded = balance - baseline;
        if (refunded != 0) token.safeTransfer(user, refunded);
    }

    /* ------------------------------ the split solve ------------------------------ */

    struct SolveState {
        uint256 lo;
        uint256 hi;
        uint256 bestAmt;
        uint256 bestOut;
        uint160 bestSqrt;
        uint256 bestCost;
        bool complete;
        bool done;
    }

    /// @dev Bisect the swap size against the exact swap simulation. The
    /// objective values the post-deposit leftover of the excess leg (in the
    /// stable, at the simulated post-swap price); the root is where neither
    /// leg is left over. Returns the best swap size seen, its simulated
    /// output and post-swap price, and whether the simulation completed.
    function _solveSwapAmount(
        IMasonryZapVault vault,
        PoolKey memory key,
        bool assetIs0,
        uint256 work
    ) private view returns (uint256 bestAmt, uint256 bestOut, uint160 bestSqrt, bool complete) {
        SolveState memory s;
        s.hi = work;
        s.bestCost = type(uint256).max;
        s.complete = true;

        for (uint256 i = 0; i < SOLVE_ITERATIONS && !s.done; i++) {
            uint256 x = i == 0 ? _spotSplit(vault, key, assetIs0, work) : (s.lo + s.hi) / 2;
            if (x < s.lo || x > s.hi) x = (s.lo + s.hi) / 2;
            _solveProbe(vault, key, assetIs0, work, x, s);
        }
        bestAmt = s.bestAmt;
        bestOut = s.bestOut;
        bestSqrt = s.bestSqrt;
        complete = s.complete;
        if (bestSqrt == 0 && complete) {
            // Only reachable when work == 0.
            (, bestSqrt,) = _simulateSwap(vault.manager(), key, !assetIs0, 0);
        }
    }

    /// @dev One bisection probe: simulate the swap at `x`, value the
    /// resulting deposit imbalance, and narrow the bracket toward the
    /// leg that is in excess.
    function _solveProbe(
        IMasonryZapVault vault,
        PoolKey memory key,
        bool assetIs0,
        uint256 work,
        uint256 x,
        SolveState memory s
    ) private view {
        (uint256 out, uint160 sqrtAfter, bool ok) = _simulateSwap(vault.manager(), key, !assetIs0, x);
        if (!ok) {
            s.complete = false;
            s.done = true;
            return;
        }
        (uint256 cost, bool assetExcess) = _imbalance(vault, sqrtAfter, assetIs0, out, work - x);
        if (cost < s.bestCost) {
            s.bestCost = cost;
            s.bestAmt = x;
            s.bestOut = out;
            s.bestSqrt = sqrtAfter;
        }
        if (cost == 0) {
            s.done = true;
            return;
        }
        if (assetExcess) {
            if (x <= s.lo) {
                s.done = true;
                return;
            }
            s.hi = x;
        } else {
            if (x >= s.hi) {
                s.done = true;
                return;
            }
            s.lo = x;
        }
        if (s.hi - s.lo <= 1) s.done = true;
    }

    /// @dev Value (in the stable) of what a maximal deposit at the given
    /// post-swap price would leave behind, and which leg is in excess.
    function _imbalance(
        IMasonryZapVault vault,
        uint160 sqrtPrice,
        bool assetIs0,
        uint256 assetBal,
        uint256 usdcBal
    ) private view returns (uint256 leftoverValue, bool assetExcess) {
        uint256 shares = _approxShares(vault, sqrtPrice, assetIs0, assetBal, usdcBal, true);
        (uint256 assetPull, uint256 usdcPull) = _depositPulls(vault, sqrtPrice, assetIs0, shares);
        if (assetPull > assetBal) {
            // The usdc-first estimate overshot the asset leg; re-derive the
            // share count from the asset leg instead.
            shares = _approxShares(vault, sqrtPrice, assetIs0, assetBal, usdcBal, false);
            (assetPull, usdcPull) = _depositPulls(vault, sqrtPrice, assetIs0, shares);
        }
        uint256 leftoverAsset = assetBal > assetPull ? assetBal - assetPull : 0;
        uint256 leftoverUsdc = usdcBal > usdcPull ? usdcBal - usdcPull : 0;
        uint256 assetValue = leftoverAsset == 0
            ? 0
            : FullMath.mulDiv(leftoverAsset, _priceX18(sqrtPrice, assetIs0), 1e18);
        leftoverValue = leftoverUsdc + assetValue;
        assetExcess = leftoverAsset != 0 && (leftoverUsdc == 0 || assetValue >= leftoverUsdc);
    }

    /// @dev Near-exact share count from a per-unit pull division, adjusted
    /// by exact pull checks. Used for objective steering only; the executed
    /// deposit uses _maxShares.
    function _approxShares(
        IMasonryZapVault vault,
        uint160 sqrtPrice,
        bool assetIs0,
        uint256 assetBal,
        uint256 usdcBal,
        bool fromUsdcLeg
    ) private view returns (uint256 shares) {
        uint256 perRef = _legPull(vault, sqrtPrice, assetIs0, REFERENCE_LIQUIDITY, fromUsdcLeg);
        if (perRef == 0) return 0;
        uint256 bal = fromUsdcLeg ? usdcBal : assetBal;
        shares = FullMath.mulDiv(bal, REFERENCE_LIQUIDITY, perRef);
        uint256 cap = uint256(uint128(type(int128).max));
        if (shares > cap) shares = cap;
        // Adjust to the exact boundary for the steering leg (pulls are
        // linear in shares up to per-token rounding, so this is a few steps).
        for (uint256 i = 0; i < 16; i++) {
            uint256 pull = _legPull(vault, sqrtPrice, assetIs0, shares, fromUsdcLeg);
            if (pull > bal) {
                if (shares == 0) break;
                uint256 excess = (pull - bal) * REFERENCE_LIQUIDITY / perRef + 1;
                shares -= excess < shares ? excess : shares;
                continue;
            }
            if (_legPull(vault, sqrtPrice, assetIs0, shares + 1, fromUsdcLeg) > bal || shares >= cap) break;
            uint256 step = (bal - pull) * REFERENCE_LIQUIDITY / perRef;
            shares += step == 0 ? 1 : step;
            if (shares > cap) shares = cap;
        }
    }

    /// @dev One leg of a deposit pull (the stable leg or the asset leg).
    function _legPull(
        IMasonryZapVault vault,
        uint160 sqrtPrice,
        bool assetIs0,
        uint256 shares,
        bool usdcLeg
    ) private view returns (uint256) {
        (uint256 assetPull, uint256 usdcPull) = _depositPulls(vault, sqrtPrice, assetIs0, shares);
        return usdcLeg ? usdcPull : assetPull;
    }

    /// @dev The exact maximum shares whose deposit pulls fit both balances
    /// at the given price. Pulls are monotone non-decreasing in shares, so
    /// bisection lands on the exact boundary.
    function _maxShares(
        IMasonryZapVault vault,
        uint160 sqrtPrice,
        uint256 assetBal,
        uint256 usdcBal
    ) private view returns (uint256) {
        bool assetIs0 = vault.assetIsCurrency0();
        uint256 hi = _quoteSharesAt(vault, sqrtPrice, assetBal, usdcBal);
        uint256 cap = uint256(uint128(type(int128).max));
        if (hi > cap) hi = cap;
        uint256 lo = 0;
        for (uint256 i = 0; i < SHARE_ITERATIONS && lo < hi; i++) {
            uint256 mid = lo + (hi - lo + 1) / 2;
            (uint256 assetPull, uint256 usdcPull) = _depositPulls(vault, sqrtPrice, assetIs0, mid);
            if (assetPull <= assetBal && usdcPull <= usdcBal) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// @dev What a deposit of `shares` will pull from the payer at the
    /// given price: principal for the vault's range PLUS the fee
    /// equalization the vault charges on top — ceil(reserve * shares /
    /// supply) per token, with reserves as they will stand when the
    /// deposit's own fee collection has run (stored reserves plus the
    /// position fees already accrued against the vault's position).
    function _depositPulls(
        IMasonryZapVault vault,
        uint160 sqrtPrice,
        bool assetIs0,
        uint256 shares
    ) private view returns (uint256 assetPull, uint256 usdcPull) {
        (uint256 amount0, uint256 amount1) = _amountsForLiquidity(
            sqrtPrice,
            TickMath.getSqrtPriceAtTick(vault.tickLower()),
            TickMath.getSqrtPriceAtTick(vault.tickUpper()),
            uint128(shares)
        );
        uint256 supply = vault.totalSupply();
        if (supply != 0 && shares != 0) {
            (uint256 reserve0, uint256 reserve1) = _reservesAfterCollect(vault);
            amount0 += FullMath.mulDivRoundingUp(reserve0, shares, supply);
            amount1 += FullMath.mulDivRoundingUp(reserve1, shares, supply);
        }
        (assetPull, usdcPull) = assetIs0 ? (amount0, amount1) : (amount1, amount0);
    }

    /// @dev The vault's fee reserves as the deposit will find them: stored
    /// reserves plus fees accrued on the vault's own pool position since
    /// its last collection, computed from the same fee-growth state the
    /// vault's _collectFees reads.
    function _reservesAfterCollect(
        IMasonryZapVault vault
    ) private view returns (uint256 reserve0, uint256 reserve1) {
        reserve0 = vault.feeReserve0();
        reserve1 = vault.feeReserve1();
        IPoolManager manager = vault.manager();
        PoolId id = vault.poolKey().toId();
        (uint128 positionLiquidity, uint256 last0, uint256 last1) = manager.getPositionInfo(
            id, address(vault), vault.tickLower(), vault.tickUpper(), bytes32(0)
        );
        if (positionLiquidity == 0) return (reserve0, reserve1);
        (uint256 inside0, uint256 inside1) =
            manager.getFeeGrowthInside(id, vault.tickLower(), vault.tickUpper());
        if (inside0 > last0) {
            reserve0 += FullMath.mulDiv(inside0 - last0, positionLiquidity, uint256(1) << 128);
        }
        if (inside1 > last1) {
            reserve1 += FullMath.mulDiv(inside1 - last1, positionLiquidity, uint256(1) << 128);
        }
    }

    /* ------------------------------ swap simulation ------------------------------ */

    struct SimState {
        uint160 sqrtPrice;
        int24 tick;
        uint128 liquidity;
        uint256 remaining;
        uint256 amountOut;
    }

    /// @dev Replay Pool.swap's exact-input loop against live pool state.
    /// Mirrors the pool's own step math (SwapMath.computeSwapStep), fee
    /// combination (protocol + LP via ProtocolFeeLibrary, read from slot0
    /// so dynamic fees are honored), tick walking (tick bitmap) and
    /// liquidity transitions (tick liquidityNet). The hooked pools' tax
    /// fires only on asset sells; for buy legs (what the zap-in routes
    /// execute) the simulation is the swap bit for bit. Sell legs are
    /// simulated gross of the fire tax and used only for quoting.
    /// Returns the output, the post-swap price, and whether the walk
    /// finished inside the step cap.
    function _simulateSwap(
        IPoolManager manager,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn
    ) private view returns (uint256 amountOut, uint160 sqrtPriceAfter, bool complete) {
        PoolId id = key.toId();
        SimState memory s;
        (s.sqrtPrice, s.tick,,) = manager.getSlot0(id);
        s.liquidity = manager.getLiquidity(id);
        sqrtPriceAfter = s.sqrtPrice;
        if (amountIn == 0) return (0, sqrtPriceAfter, true);
        if (amountIn > uint256(uint128(type(int128).max))) return (0, sqrtPriceAfter, false);
        uint24 swapFee = _swapFee(manager, id, zeroForOne);
        s.remaining = amountIn;

        for (uint256 step = 0; step < MAX_SWAP_STEPS; step++) {
            if (s.remaining == 0) break;
            _simStep(manager, id, key.tickSpacing, zeroForOne, swapFee, s);
        }
        return (s.amountOut, s.sqrtPrice, s.remaining == 0);
    }

    /// @dev The combined swap fee Pool.swap would charge: LP fee from
    /// slot0 (dynamic-fee aware) combined with the direction's protocol
    /// fee exactly as ProtocolFeeLibrary prescribes.
    function _swapFee(
        IPoolManager manager,
        PoolId id,
        bool zeroForOne
    ) private view returns (uint24) {
        (,, uint24 protocolFeePacked, uint24 lpFee) = manager.getSlot0(id);
        uint16 protocolFee = zeroForOne
            ? ProtocolFeeLibrary.getZeroForOneFee(protocolFeePacked)
            : ProtocolFeeLibrary.getOneForZeroFee(protocolFeePacked);
        return protocolFee == 0 ? lpFee : ProtocolFeeLibrary.calculateSwapFee(protocolFee, lpFee);
    }

    /// @dev One Pool.swap loop iteration against the simulation state:
    /// walk to the next initialized tick, run the pool's own step math,
    /// cross the tick (applying its liquidityNet) when it is reached.
    function _simStep(
        IPoolManager manager,
        PoolId id,
        int24 tickSpacing,
        bool zeroForOne,
        uint24 swapFee,
        SimState memory s
    ) private view {
        (int24 tickNext, bool initialized) = _nextInitializedTick(manager, id, s.tick, tickSpacing, zeroForOne);
        if (tickNext <= TickMath.MIN_TICK) tickNext = TickMath.MIN_TICK;
        if (tickNext >= TickMath.MAX_TICK) tickNext = TickMath.MAX_TICK;
        uint160 sqrtTarget = TickMath.getSqrtPriceAtTick(tickNext);
        (uint160 sqrtNext, uint256 stepIn, uint256 stepOut, uint256 stepFee) =
            SwapMath.computeSwapStep(s.sqrtPrice, sqrtTarget, s.liquidity, -int256(s.remaining), swapFee);
        s.remaining -= stepIn + stepFee;
        s.amountOut += stepOut;
        if (sqrtNext == sqrtTarget) {
            if (initialized) _crossTick(manager, id, tickNext, zeroForOne, s);
            s.tick = zeroForOne ? tickNext - 1 : tickNext;
        } else {
            s.tick = TickMath.getTickAtSqrtPrice(sqrtNext);
        }
        s.sqrtPrice = sqrtNext;
    }

    /// @dev Apply an initialized tick's liquidityNet to the walk, with
    /// Pool.swap's sign convention for the swap direction.
    function _crossTick(
        IPoolManager manager,
        PoolId id,
        int24 tickNext,
        bool zeroForOne,
        SimState memory s
    ) private view {
        (, int128 liquidityNet) = manager.getTickLiquidity(id, tickNext);
        if (zeroForOne) liquidityNet = -liquidityNet;
        s.liquidity = LiquidityMath.addDelta(s.liquidity, liquidityNet);
    }

    /// @dev TickBitmap.nextInitializedTickWithinOneWord re-implemented over
    /// StateLibrary word reads (the library function operates on the
    /// PoolManager's storage mapping; the semantics are copied exactly).
    function _nextInitializedTick(
        IPoolManager manager,
        PoolId id,
        int24 tick,
        int24 tickSpacing,
        bool lte
    ) private view returns (int24 next, bool initialized) {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) compressed--;
        if (lte) {
            (int16 wordPos, uint8 bitPos) = _tickPosition(compressed);
            uint256 mask = type(uint256).max >> (uint256(type(uint8).max) - bitPos);
            uint256 masked = manager.getTickBitmap(id, wordPos) & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * tickSpacing
                : (compressed - int24(uint24(bitPos))) * tickSpacing;
        } else {
            compressed++;
            (int16 wordPos, uint8 bitPos) = _tickPosition(compressed);
            uint256 mask = ~((uint256(1) << bitPos) - 1);
            uint256 masked = manager.getTickBitmap(id, wordPos) & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * tickSpacing
                : (compressed + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
        }
    }

    /// @dev TickBitmap.position: word and bit of a compressed tick.
    function _tickPosition(
        int24 compressed
    ) private pure returns (int16 wordPos, uint8 bitPos) {
        wordPos = int16(compressed >> 8);
        bitPos = uint8(uint256(int256(compressed) & 0xff));
    }

    /* ------------------------------ spot helpers ------------------------------ */
    /* Used by the degraded path and spot quotes only. The solved path    */
    /* above is what executes whenever the simulation completes.          */

    function _spotSplit(
        IMasonryZapVault vault,
        PoolKey memory key,
        bool assetIs0,
        uint256 work
    ) private view returns (uint256) {
        (uint160 sqrtPrice,,,) = vault.manager().getSlot0(key.toId());
        return _splitAmount(
            sqrtPrice,
            TickMath.getSqrtPriceAtTick(vault.tickLower()),
            TickMath.getSqrtPriceAtTick(vault.tickUpper()),
            assetIs0,
            work
        );
    }

    /// @dev How much of `work` to swap into the asset so the post-swap
    /// balances match the ratio the vault's range consumes AT SPOT (no
    /// price impact). Degraded-path and quote use only.
    function _splitAmount(
        uint160 sqrtPrice,
        uint160 sqrtLower,
        uint160 sqrtUpper,
        bool assetIs0,
        uint256 work
    ) private pure returns (uint256 swapAmt) {
        (uint256 amt0, uint256 amt1) = _amountsForLiquidity(sqrtPrice, sqrtLower, sqrtUpper, REFERENCE_LIQUIDITY);
        (uint256 assetPerL, uint256 usdcPerL) = assetIs0 ? (amt0, amt1) : (amt1, amt0);
        if (assetPerL == 0) return 0; // range sits entirely on the stable side
        if (usdcPerL == 0) return work; // range sits entirely on the asset side
        uint256 assetValue = FullMath.mulDiv(assetPerL, _priceX18(sqrtPrice, assetIs0), 1e18);
        return FullMath.mulDiv(work, assetValue, assetValue + usdcPerL);
    }

    /// @dev Degraded LP quote: the v1 spot split estimate, used only when
    /// the exact simulation cannot complete.
    function _spotPreviewShares(
        IMasonryZapVault vault,
        bool assetIs0,
        uint256 work
    ) private view returns (uint256) {
        PoolKey memory key = vault.poolKey();
        (uint160 sqrtPrice,,,) = vault.manager().getSlot0(key.toId());
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(vault.tickLower());
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(vault.tickUpper());
        uint256 spotSwap = _splitAmount(sqrtPrice, sqrtLower, sqrtUpper, assetIs0, work);
        uint256 assetEst = spotSwap == 0 ? 0 : FullMath.mulDiv(spotSwap, 1e18, _priceX18(sqrtPrice, assetIs0));
        (uint256 amt0, uint256 amt1) = assetIs0 ? (assetEst, work - spotSwap) : (work - spotSwap, assetEst);
        return LiquidityAmounts.getLiquidityForAmounts(sqrtPrice, sqrtLower, sqrtUpper, amt0, amt1);
    }

    /// @dev Spot estimate of a full stable→asset swap (no impact), used
    /// only when the exact simulation cannot complete.
    function _spotAssetEstimate(
        IMasonryZapVault vault,
        uint256 work
    ) private view returns (uint256) {
        PoolKey memory key = vault.poolKey();
        (uint160 sqrtPrice,,,) = vault.manager().getSlot0(key.toId());
        return FullMath.mulDiv(work, 1e18, _priceX18(sqrtPrice, vault.assetIsCurrency0()));
    }

    /// @dev Principal-quote share count for the given balances at the
    /// given price — the bisection bound for _maxShares.
    function _quoteSharesAt(
        IMasonryZapVault vault,
        uint160 sqrtPrice,
        uint256 assetBal,
        uint256 usdcBal
    ) private view returns (uint256) {
        (uint256 amt0, uint256 amt1) = vault.assetIsCurrency0() ? (assetBal, usdcBal) : (usdcBal, assetBal);
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice,
            TickMath.getSqrtPriceAtTick(vault.tickLower()),
            TickMath.getSqrtPriceAtTick(vault.tickUpper()),
            amt0,
            amt1
        );
    }

    /// @dev Principal amounts a range position of `liquidity` consumes at
    /// the given price — the same SqrtPriceMath deltas (rounding up, as
    /// deposits settle) the vault itself incurs in its deposit.
    function _amountsForLiquidity(
        uint160 sqrtPrice,
        uint160 sqrtLower,
        uint160 sqrtUpper,
        uint128 liquidity
    ) private pure returns (uint256 amount0, uint256 amount1) {
        uint160 start0 = sqrtPrice > sqrtLower ? sqrtPrice : sqrtLower;
        uint160 end1 = sqrtPrice < sqrtUpper ? sqrtPrice : sqrtUpper;
        amount0 = start0 < sqrtUpper ? SqrtPriceMath.getAmount0Delta(start0, sqrtUpper, liquidity, true) : 0;
        amount1 = end1 > sqrtLower ? SqrtPriceMath.getAmount1Delta(sqrtLower, end1, liquidity, true) : 0;
    }

    /// @dev Spot price of the asset in the stable, raw units, scaled by 1e18.
    function _priceX18(
        uint160 sqrtPrice,
        bool assetIs0
    ) private pure returns (uint256) {
        uint256 sp = uint256(sqrtPrice);
        if (assetIs0) {
            // price = (sqrtPrice / 2^96)^2, currency1 per currency0
            uint256 priceX96 = FullMath.mulDiv(sp, sp, uint256(1) << 96);
            return FullMath.mulDiv(priceX96, 1e18, uint256(1) << 96);
        }
        // price = 2^192 / sqrtPrice^2, currency0 per currency1
        uint256 invSqrtX96 = FullMath.mulDiv(uint256(1) << 96, uint256(1) << 96, sp);
        uint256 invPriceX96 = FullMath.mulDiv(invSqrtX96, invSqrtX96, uint256(1) << 96);
        return FullMath.mulDiv(invPriceX96, 1e18, uint256(1) << 96);
    }

    function _assetOf(
        IMasonryZapVault vault,
        bool assetIs0
    ) private view returns (IERC20) {
        PoolKey memory key = vault.poolKey();
        return IERC20(Currency.unwrap(assetIs0 ? key.currency0 : key.currency1));
    }

    function _pairsUsdc(
        IMasonryZapVault vault,
        address usdc_
    ) private view returns (bool) {
        PoolKey memory key = vault.poolKey();
        return Currency.unwrap(key.currency0) == usdc_ || Currency.unwrap(key.currency1) == usdc_;
    }
}
