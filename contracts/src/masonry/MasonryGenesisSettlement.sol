// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MasonryLevelHook} from "../hooks/MasonryLevelHook.sol";
import {MiniSwapRouter} from "../swap/MiniSwapRouter.sol";
import {MasonryGenesisStaking, IMasonryGenesisSettlement} from "./MasonryGenesisStaking.sol";
import {MasonryLevelUsdcVault} from "./MasonryLevelUsdcVault.sol";
import {MasonryBuybackGuard} from "./MasonryBuybackGuard.sol";

/// @notice Separates immediate Genesis rewards from non-revocable vested tranches.
contract MasonryGenesisSettlement is ReentrancyGuard, IMasonryGenesisSettlement {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 private constant BPS = 10_000;
    uint256 public constant WALLET_FEE_BPS = 200;
    uint256 public constant AUTOMATION_FEE_BPS = 200;
    uint256 public constant MAX_REFUND_BPS = 300;
    uint8 public constant INSTALLMENTS = 16;
    uint256 public constant RELEASE_INTERVAL = 6 hours;

    struct Tranche {
        uint256 amount;
        uint64 nextRelease;
        uint8 releasedInstallments;
    }

    address public immutable binder;
    MasonryGenesisStaking public staking;
    MasonryLevelUsdcVault public immutable vault;
    MasonryBuybackGuard public immutable guard;
    MiniSwapRouter public immutable router;
    IERC20 public immutable level;
    IERC20 public immutable usdc;
    address public immutable treasury;
    uint256 public immutable genesisEnd;
    uint256 public totalEscrowed;
    mapping(address => Tranche[]) public tranches;

    error InvalidConfiguration();
    error Unauthorized();
    error InvalidPlan();
    error InvalidSettlement();
    error VestingLocked();

    event Escrowed(address indexed beneficiary, uint256 indexed tranche, uint256 levelAmount);
    event Released(address indexed beneficiary, uint256 indexed tranche, uint256 levelAmount);
    event Paid(address indexed beneficiary, uint256 amount, uint256 fee);
    event Compounded(address indexed beneficiary, uint256 grossShares, uint256 automationFee);

    constructor(
        MasonryLevelUsdcVault vault_,
        MasonryBuybackGuard guard_,
        MiniSwapRouter router_,
        address treasury_,
        address binder_
    ) {
        PoolKey memory key = vault_.poolKey();
        MasonryLevelHook hook = MasonryLevelHook(address(key.hooks));
        if (
            treasury_ == address(0) || binder_ == address(0)
                || PoolId.unwrap(guard_.officialPool()) != PoolId.unwrap(key.toId())
                || router_.poolManager() != vault_.manager()
        ) revert InvalidConfiguration();
        vault = vault_;
        guard = guard_;
        router = router_;
        level = IERC20(hook.level());
        usdc = IERC20(Currency.unwrap(vault_.levelIsCurrency0() ? key.currency1 : key.currency0));
        genesisEnd = hook.schedule().end();
        treasury = treasury_;
        binder = binder_;
    }

    function bind(
        MasonryGenesisStaking staking_
    ) external {
        if (msg.sender != binder || address(staking) != address(0)) revert Unauthorized();
        MasonryLevelHook hook = MasonryLevelHook(address(vault.poolKey().hooks));
        if (
            address(staking_.settlement()) != address(this) || address(staking_.lpAsset()) != address(vault)
                || staking_.level() != level || staking_.schedule() != hook.schedule()
                || staking_.pass().treasury() != treasury
        ) revert InvalidConfiguration();
        staking = staking_;
    }

    function settle(
        address beneficiary,
        uint256 reward,
        bool compound,
        bool automated,
        CompoundPlan calldata plan
    ) external nonReentrant {
        if (msg.sender != address(staking)) revert Unauthorized();
        uint256 liquid = reward / 2;
        uint256 vested = reward - liquid;
        if (level.balanceOf(address(this)) < totalEscrowed + reward) revert InvalidSettlement();
        totalEscrowed += vested;
        uint256 index = tranches[beneficiary].length;
        tranches[beneficiary].push(Tranche(vested, uint64(genesisEnd + RELEASE_INTERVAL), 0));
        emit Escrowed(beneficiary, index, vested);

        if (compound) {
            uint256 performanceFee = automated ? Math.mulDiv(liquid, AUTOMATION_FEE_BPS, BPS) : 0;
            if (performanceFee != 0) level.safeTransfer(treasury, performanceFee);
            _compound(beneficiary, liquid - performanceFee, plan);
            emit Compounded(beneficiary, plan.grossShares, performanceFee);
        } else {
            _payWallet(beneficiary, liquid);
        }
    }

    function release(
        uint256 index
    ) external nonReentrant returns (uint256 amount) {
        Tranche storage tranche = tranches[msg.sender][index];
        uint8 released = tranche.releasedInstallments;
        if (released == INSTALLMENTS || block.timestamp < tranche.nextRelease) revert VestingLocked();
        amount = Math.mulDiv(tranche.amount, released + 1, INSTALLMENTS)
            - Math.mulDiv(tranche.amount, released, INSTALLMENTS);
        tranche.releasedInstallments = released + 1;
        tranche.nextRelease = uint64(block.timestamp + RELEASE_INTERVAL);
        totalEscrowed -= amount;
        _payWallet(msg.sender, amount);
        emit Released(msg.sender, index, amount);
    }

    function trancheCount(
        address beneficiary
    ) external view returns (uint256) {
        return tranches[beneficiary].length;
    }

    function _compound(
        address beneficiary,
        uint256 budget,
        CompoundPlan calldata plan
    ) private {
        if (plan.grossShares == 0 || plan.levelToSell > budget || budget == 0) revert InvalidPlan();
        // An out-of-range LEVEL-only position may need no swap, but still
        // requires a healthy oracle for keeper-triggerable compounding.
        if (plan.levelToSell == 0) guard.validatedSpot();
        uint256 usdcReceived = plan.levelToSell == 0 ? 0 : _sellLevel(plan.levelToSell);
        uint256 levelAvailable = budget - plan.levelToSell;
        level.forceApprove(address(vault), levelAvailable);
        usdc.forceApprove(address(vault), usdcReceived);
        (uint256 levelUsed, uint256 usdcUsed) =
            vault.deposit(plan.grossShares, levelAvailable, usdcReceived, address(staking));
        level.forceApprove(address(vault), 0);
        usdc.forceApprove(address(vault), 0);

        uint256 levelRefund = levelAvailable - levelUsed;
        uint256 usdcRefund = usdcReceived - usdcUsed;
        if (
            levelRefund > Math.mulDiv(budget, MAX_REFUND_BPS, BPS) + 1
                || usdcRefund > Math.mulDiv(usdcReceived, MAX_REFUND_BPS, BPS) + 1
        ) revert InvalidPlan();
        _payWallet(beneficiary, levelRefund);
        if (usdcRefund != 0) usdc.safeTransfer(beneficiary, usdcRefund);
    }

    function _sellLevel(
        uint256 amount
    ) private returns (uint256 received) {
        uint256 minimum = guard.minimumAssetSaleOut(amount);
        uint256 levelBefore = level.balanceOf(address(this));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        level.forceApprove(address(router), amount);
        received = router.swapExactIn(vault.poolKey(), vault.levelIsCurrency0(), amount, minimum, address(this));
        level.forceApprove(address(router), 0);
        if (
            levelBefore - level.balanceOf(address(this)) != amount
                || usdc.balanceOf(address(this)) - usdcBefore != received
        ) {
            revert InvalidSettlement();
        }
    }

    function _payWallet(
        address beneficiary,
        uint256 amount
    ) private {
        uint256 fee = Math.mulDiv(amount, WALLET_FEE_BPS, BPS);
        if (fee != 0) level.safeTransfer(treasury, fee);
        if (amount != 0) level.safeTransfer(beneficiary, amount - fee);
        emit Paid(beneficiary, amount, fee);
    }
}
