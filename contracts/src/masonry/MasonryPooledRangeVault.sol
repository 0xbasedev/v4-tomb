// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {MasonryRangeLib} from "./MasonryRangeLib.sol";

/// @notice Local prototype: users share one concentrated v4 band and can redeem.
/// @dev Not wired into launch. Compares Follow, FixedPeg and PegAnchor inventories.
contract MasonryPooledRangeVault is ERC20, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    enum Strategy {
        Follow,
        FixedPeg,
        PegAnchor
    }

    enum Op {
        Deposit,
        Redeem,
        Rebalance
    }

    uint256 public constant DEAD_SHARES = 1_000;
    address public constant DEAD = address(0xdead);

    IPoolManager public immutable manager;
    PoolId public immutable poolId;
    Strategy public immutable strategy;
    uint16 public immutable halfWidthBps;
    uint160 public immutable sqrtPeg;
    uint256 public immutable redeemCooldown;
    uint16 public immutable recenterBps;
    uint256 public immutable rangeCooldown;
    uint16 public immutable maxTwapDeviationBps;

    struct RangeGuards {
        uint16 recenterBps;
        uint256 cooldown;
        uint16 maxTwapDeviationBps;
    }
    address public immutable owner;
    address public immutable daoWallet;
    uint16 public constant MAX_WITHDRAW_FEE_BPS = 1_000;
    uint16 public withdrawFeeBps;

    PoolKey private key;
    int24 public tickLower;
    int24 public tickUpper;
    uint128 public liquidity;
    bool public seeded;

    error NotPoolManager();
    error ZeroShares();
    error NoLiquidity();
    error FirstDepositTooSmall();
    error RedeemPending();
    error RedeemNotPending();
    error RedeemCooldownActive();
    error ReceiptNotTransferable();
    error Unauthorized();
    error FeeCapExceeded();

    struct RedeemRequest {
        uint256 shares;
        uint256 availableAt;
        uint256 receiptId;
    }

    mapping(address => RedeemRequest) public redeemRequests;
    mapping(address => uint256) public lastCompoundAt;
    mapping(uint256 => address) public receiptOwner;
    uint256 private _nextReceiptId = 1;

    event Deposited(address indexed user, uint256 shares, uint256 amount0, uint256 amount1);
    event RedeemRequested(address indexed user, uint256 shares, uint256 availableAt, uint256 receiptId);
    event RedeemCompleted(address indexed user, uint256 shares, uint256 amount0, uint256 amount1, uint256 receiptId);
    event RedeemCancelled(address indexed user, uint256 shares, uint256 receiptId);
    event Compounded(address indexed user, uint256 unlockedShares);
    event WithdrawFeePaid(address indexed user, uint256 fee0, uint256 fee1, address indexed daoWallet);
    event WithdrawFeeUpdated(uint16 bps);
    event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity);

    constructor(
        IPoolManager manager_,
        PoolKey memory pool,
        Strategy strategy_,
        uint16 halfWidthBps_,
        uint160 sqrtPeg_,
        uint256 redeemCooldown_,
        address owner_,
        address daoWallet_,
        uint16 withdrawFeeBps_,
        RangeGuards memory guards
    ) ERC20("Masonry Pooled Range Prototype", "mPRANGE") {
        // Range guards come from launch config (policy.liquidityVault*), not literals.
        MasonryRangeLib.validate(halfWidthBps_, guards.recenterBps, guards.cooldown, guards.maxTwapDeviationBps);
        recenterBps = guards.recenterBps;
        rangeCooldown = guards.cooldown;
        maxTwapDeviationBps = guards.maxTwapDeviationBps;
        if (address(manager_) == address(0) || sqrtPeg_ == 0 || owner_ == address(0) || daoWallet_ == address(0)) {
            revert MasonryRangeLib.InvalidRangeConfig();
        }
        if (redeemCooldown_ < 60 || redeemCooldown_ > 1 days) revert MasonryRangeLib.InvalidRangeConfig();
        if (withdrawFeeBps_ > MAX_WITHDRAW_FEE_BPS) revert FeeCapExceeded();
        manager = manager_;
        key = pool;
        poolId = pool.toId();
        strategy = strategy_;
        halfWidthBps = halfWidthBps_;
        sqrtPeg = sqrtPeg_;
        redeemCooldown = redeemCooldown_;
        owner = owner_;
        daoWallet = daoWallet_;
        withdrawFeeBps = withdrawFeeBps_;
    }

    function setWithdrawFeeBps(uint16 bps) external {
        if (msg.sender != owner) revert Unauthorized();
        if (bps > MAX_WITHDRAW_FEE_BPS) revert FeeCapExceeded();
        withdrawFeeBps = bps;
        emit WithdrawFeeUpdated(bps);
    }

    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    function previewBand() public view returns (int24 lower, int24 upper) {
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        return _band(sqrtPrice);
    }

    function inventory() public view returns (uint256 amount0, uint256 amount1) {
        amount0 = IERC20(Currency.unwrap(key.currency0)).balanceOf(address(this));
        amount1 = IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this));
        if (liquidity == 0) return (amount0, amount1);
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtPrice <= sa) {
            amount0 += SqrtPriceMath.getAmount0Delta(sa, sb, liquidity, false);
        } else if (sqrtPrice >= sb) {
            amount1 += SqrtPriceMath.getAmount1Delta(sa, sb, liquidity, false);
        } else {
            amount0 += SqrtPriceMath.getAmount0Delta(sqrtPrice, sb, liquidity, false);
            amount1 += SqrtPriceMath.getAmount1Delta(sa, sqrtPrice, liquidity, false);
        }
    }

    function deposit(uint256 max0, uint256 max1) external nonReentrant returns (uint256 shares) {
        if (max0 == 0 && max1 == 0) revert ZeroShares();
        uint256 supply = totalSupply();
        (uint256 before0, uint256 before1) = inventory();
        (uint160 sqrtBefore,,,) = manager.getSlot0(poolId);
        uint256 beforeValue = MasonryRangeLib.valueInCurrency1(before0, before1, sqrtBefore);
        _pull(max0, max1);
        _run(Op.Deposit);
        (uint256 after0, uint256 after1) = inventory();
        uint256 afterValue = MasonryRangeLib.valueInCurrency1(after0, after1, sqrtBefore);
        uint256 added = afterValue > beforeValue ? afterValue - beforeValue : 0;
        if (added == 0) revert ZeroShares();
        if (supply == 0 || beforeValue == 0) {
            if (added <= DEAD_SHARES) revert FirstDepositTooSmall();
            _mint(DEAD, DEAD_SHARES);
            shares = added - DEAD_SHARES;
        } else {
            shares = added * supply / beforeValue;
        }
        if (shares == 0) revert ZeroShares();
        _mint(msg.sender, shares);
        uint256 used0 = before0 > after0 ? 0 : after0 - before0;
        uint256 used1 = before1 > after1 ? 0 : after1 - before1;
        emit Deposited(msg.sender, shares, used0, used1);
    }

    function requestRedeem(uint256 shares) external nonReentrant returns (uint256 receiptId) {
        if (shares == 0 || shares > balanceOf(msg.sender)) revert ZeroShares();
        if (redeemRequests[msg.sender].shares != 0) revert RedeemPending();
        _transfer(msg.sender, address(this), shares);
        receiptId = ++_nextReceiptId;
        uint256 availableAt = block.timestamp + redeemCooldown;
        redeemRequests[msg.sender] = RedeemRequest(shares, availableAt, receiptId);
        receiptOwner[receiptId] = msg.sender;
        emit RedeemRequested(msg.sender, shares, availableAt, receiptId);
    }

    function completeRedeem() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        RedeemRequest memory req = redeemRequests[msg.sender];
        if (req.shares == 0) revert RedeemNotPending();
        if (block.timestamp < req.availableAt) revert RedeemCooldownActive();
        delete redeemRequests[msg.sender];
        delete receiptOwner[req.receiptId];
        uint256 supplyBefore = totalSupply();
        IERC20 token0 = IERC20(Currency.unwrap(key.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(key.currency1));
        uint256 idle0 = token0.balanceOf(address(this));
        uint256 idle1 = token1.balanceOf(address(this));
        _burn(address(this), req.shares);
        _redeemShares = req.shares;
        _redeemSupply = supplyBefore;
        _run(Op.Redeem);
        _redeemShares = 0;
        _redeemSupply = 0;
        uint256 withdrawn0 = token0.balanceOf(address(this)) - idle0;
        uint256 withdrawn1 = token1.balanceOf(address(this)) - idle1;
        amount0 = withdrawn0 + idle0 * req.shares / supplyBefore;
        amount1 = withdrawn1 + idle1 * req.shares / supplyBefore;
        uint256 fee0 = amount0 * uint256(withdrawFeeBps) / 10_000;
        uint256 fee1 = amount1 * uint256(withdrawFeeBps) / 10_000;
        amount0 -= fee0;
        amount1 -= fee1;
        if (fee0 != 0) token0.safeTransfer(daoWallet, fee0);
        if (fee1 != 0) token1.safeTransfer(daoWallet, fee1);
        if (fee0 != 0 || fee1 != 0) emit WithdrawFeePaid(msg.sender, fee0, fee1, daoWallet);
        if (amount0 != 0) token0.safeTransfer(msg.sender, amount0);
        if (amount1 != 0) token1.safeTransfer(msg.sender, amount1);
        emit RedeemCompleted(msg.sender, req.shares, amount0, amount1, req.receiptId);
    }

    function cancelRedeem() external nonReentrant {
        _unlockPending(msg.sender);
    }

    /// @notice Cancels a pending withdrawal and deploys idle fees back into the band.
    function compound() external nonReentrant {
        uint256 unlocked;
        if (redeemRequests[msg.sender].shares != 0) {
            unlocked = redeemRequests[msg.sender].shares;
            _unlockPending(msg.sender);
        }
        if (seeded) _run(Op.Deposit);
        lastCompoundAt[msg.sender] = block.timestamp;
        emit Compounded(msg.sender, unlocked);
    }

    function transferRedeemReceipt(address, uint256) external pure {
        revert ReceiptNotTransferable();
    }

    function cooldownRemaining(address user) external view returns (uint256) {
        RedeemRequest memory req = redeemRequests[user];
        if (req.shares == 0 || block.timestamp >= req.availableAt) return 0;
        return req.availableAt - block.timestamp;
    }

    function _unlockPending(address user) private {
        RedeemRequest memory req = redeemRequests[user];
        if (req.shares == 0) revert RedeemNotPending();
        delete redeemRequests[user];
        delete receiptOwner[req.receiptId];
        _transfer(address(this), user, req.shares);
        emit RedeemCancelled(user, req.shares, req.receiptId);
    }

    function rebalance() external nonReentrant {
        if (strategy == Strategy.FixedPeg && seeded) return;
        _run(Op.Rebalance);
        emit Rebalanced(tickLower, tickUpper, liquidity);
    }

    uint256 private _redeemShares;
    uint256 private _redeemSupply;

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        _execute(abi.decode(data, (Op)));
        return "";
    }

    function _run(Op op) private {
        if (manager.isUnlocked()) _execute(op);
        else manager.unlock(abi.encode(op));
    }

    function _execute(Op op) private {
        if (op == Op.Rebalance) {
            _removeAll();
            _setBand();
            _addFromBalance();
            return;
        }
        if (op == Op.Redeem) {
            if (liquidity != 0 && _redeemSupply != 0) {
                uint256 take = uint256(liquidity) * _redeemShares / _redeemSupply;
                if (take != 0) _removeLiquidity(uint128(take));
            }
            return;
        }
        if (!seeded) _setBand();
        _addFromBalance();
    }

    function _band(uint160 sqrtPrice) private view returns (int24 lower, int24 upper) {
        if (strategy == Strategy.FixedPeg) {
            return MasonryRangeLib.fixedPegTicks(sqrtPeg, halfWidthBps, key.tickSpacing);
        }
        if (strategy == Strategy.PegAnchor) {
            return MasonryRangeLib.pegAnchorTicks(sqrtPrice, sqrtPeg, halfWidthBps, halfWidthBps, key.tickSpacing);
        }
        return MasonryRangeLib.bandTicks(sqrtPrice, halfWidthBps, key.tickSpacing);
    }

    function _setBand() private {
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        (tickLower, tickUpper) = _band(sqrtPrice);
        seeded = true;
    }

    function _removeAll() private {
        if (liquidity != 0) _removeLiquidity(liquidity);
    }

    function _removeLiquidity(uint128 liq) private {
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(tickLower, tickUpper, -int256(uint256(liq)), bytes32(0)), ""
        );
        liquidity -= liq;
        _takePositive(key.currency0, delta.amount0());
        _takePositive(key.currency1, delta.amount1());
    }

    function _addFromBalance() private {
        IERC20 token0 = IERC20(Currency.unwrap(key.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(key.currency1));
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        if (bal0 == 0 && bal1 == 0) return;
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint128 add = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), bal0, bal1
        );
        if (add == 0) return;
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(add)), bytes32(0)), ""
        );
        _settleNegative(key.currency0, delta.amount0());
        _settleNegative(key.currency1, delta.amount1());
        liquidity += add;
    }

    function _takePositive(Currency currency, int128 amount) private {
        if (amount > 0) manager.take(currency, address(this), uint256(uint128(amount)));
    }

    function _settleNegative(Currency currency, int128 amount) private {
        if (amount > 0) {
            manager.take(currency, address(this), uint256(uint128(amount)));
            return;
        }
        if (amount == 0) return;
        uint256 paid = uint256(uint128(-amount));
        manager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(manager), paid);
        manager.settle();
    }

    function _pull(uint256 amount0, uint256 amount1) private {
        if (amount0 != 0) IERC20(Currency.unwrap(key.currency0)).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) IERC20(Currency.unwrap(key.currency1)).safeTransferFrom(msg.sender, address(this), amount1);
    }
}
