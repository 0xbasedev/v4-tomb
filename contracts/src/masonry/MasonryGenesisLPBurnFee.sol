// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @notice Interface for a genuinely fungible v4 LP vault: shares must be
/// redeemable pro-rata by ANY holder, not only the original NFT depositor.
/// @dev The legacy V4PositionWrapper in this repo does NOT implement this.
interface IMasonryRedeemableLPVault is IERC20 {
    function poolKey() external view returns (PoolKey memory);

    function redeem(uint256 shares, address recipient)
        external
        returns (uint256 levelReceived, uint256 usdcReceived);
}

interface IMasonryBurnableLevel is IERC20 {
    function burn(uint256 amount) external;
}

interface IMasonryExactInputV4Router {
    function swapExactIn(
        PoolKey calldata poolKey,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient
    ) external returns (uint256 amountOut);
}

/// @notice The guard MUST verify a fresh validated oracle, conservative
/// expected output, projected impact, pool liquidity and slippage; returning
/// a positive min output is the explicit authorization for this buyback.
/// Implementations MUST NOT rely only on the current manipulable spot tick.
interface IMasonryBuybackExecutionGuard {
    function officialPool() external view returns (PoolId);

    function minimumLevelOut(uint256 usdcAmount) external returns (uint256);
}

/// @notice Genesis LEVEL/USDC LP deposit/auto-compound fee: collect exactly
/// 50 bps of shares, redeem to LEVEL + USDC, burn LEVEL immediately, and
/// opportunistically buy LEVEL with USDC in the SAME user transaction.
///
/// No standalone processFees function exists: deferred shares and USDC are
/// only retried by a successful authorized Genesis collection call.
/// Failed optional redemption or buyback cannot revert a valid deposit.
///
/// IMPORTANT: This is a modular integration component. Production deployment
/// requires a redeemable v4 LP vault, an audited buyback quote/impact guard,
/// and a Genesis pool that credits net (gross - fee) shares only.
contract MasonryGenesisLPBurnFee is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant DEPOSIT_BURN_FEE_BPS = 50;
    uint256 public constant BPS = 10_000;

    IMasonryRedeemableLPVault public immutable lpVault;
    IMasonryBurnableLevel public immutable level;
    IERC20 public immutable usdc;
    IMasonryExactInputV4Router public immutable router;
    IMasonryBuybackExecutionGuard public immutable guard;

    PoolKey internal buybackPoolKey;
    bool public immutable usdcIsCurrency0;

    address public genesis;
    uint256 public maxFeeSharesPerCall;
    uint256 public maxUsdcPerCall;

    // Only fees collected by the authorized Genesis pool enter these totals.
    // Unsolicited token transfers cannot be recategorized as protocol revenue.
    uint256 public pendingFeeShares;
    uint256 public pendingBurnUSDC;
    uint256 public totalFeeSharesCollected;
    uint256 public totalLevelBurnedFromLPFees;

    error UnauthorizedGenesis();
    error OnlySelf();
    error InvalidConfiguration();
    error InvalidPool();
    error InvalidFeeReceipt();
    error UnexpectedRedemption();
    error UnexpectedBuyback();
    error InvalidMinimumOutput();

    event GenesisUpdated(address indexed previousGenesis, address indexed newGenesis);
    event ExecutionLimitsUpdated(uint256 maxFeeSharesPerCall, uint256 maxUsdcPerCall);
    event FeeSharesCollected(uint256 grossShares, uint256 feeShares);
    event FeeSharesRedeemed(uint256 feeShares, uint256 levelOut, uint256 usdcOut);
    event FeeLevelBurned(uint256 levelAmount, uint256 cumulativeLevelBurned);
    event BuybackDeferred(bytes32 indexed errorHash);
    event RedemptionDeferred(bytes32 indexed errorHash);

    modifier onlyGenesis() {
        if (msg.sender != genesis) revert UnauthorizedGenesis();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    constructor(
        IMasonryRedeemableLPVault lpVault_,
        IMasonryBurnableLevel level_,
        IERC20 usdc_,
        IMasonryExactInputV4Router router_,
        IMasonryBuybackExecutionGuard guard_,
        PoolKey memory buybackPoolKey_,
        address genesis_,
        uint256 maxFeeSharesPerCall_,
        uint256 maxUsdcPerCall_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(lpVault_).code.length == 0 || address(level_).code.length == 0
                || address(usdc_).code.length == 0 || address(router_).code.length == 0
                || address(guard_).code.length == 0 || genesis_ == address(0)
                || maxFeeSharesPerCall_ == 0 || maxUsdcPerCall_ == 0
        ) revert InvalidConfiguration();

        address c0 = Currency.unwrap(buybackPoolKey_.currency0);
        address c1 = Currency.unwrap(buybackPoolKey_.currency1);
        if (
            !(c0 == address(usdc_) && c1 == address(level_))
                && !(c0 == address(level_) && c1 == address(usdc_))
        ) revert InvalidPool();
        if (c0 >= c1) revert InvalidPool();

        PoolId pool = buybackPoolKey_.toId();
        if (PoolId.unwrap(lpVault_.poolKey().toId()) != PoolId.unwrap(pool)
            || PoolId.unwrap(guard_.officialPool()) != PoolId.unwrap(pool)) revert InvalidPool();

        lpVault = lpVault_;
        level = level_;
        usdc = usdc_;
        router = router_;
        guard = guard_;
        buybackPoolKey = buybackPoolKey_;
        usdcIsCurrency0 = c0 == address(usdc_);
        genesis = genesis_;
        maxFeeSharesPerCall = maxFeeSharesPerCall_;
        maxUsdcPerCall = maxUsdcPerCall_;
    }

    function poolKey() external view returns (PoolKey memory) {
        return buybackPoolKey;
    }

    /// @notice Immediate owner-controlled integration changes. Never authorizes
    /// withdrawals from the burn reserve and never pauses public v4 swaps.
    function setGenesis(address newGenesis) external onlyOwner {
        if (newGenesis == address(0) || newGenesis.code.length == 0) revert InvalidConfiguration();
        emit GenesisUpdated(genesis, newGenesis);
        genesis = newGenesis;
    }

    function setExecutionLimits(uint256 feeShareLimit, uint256 usdcLimit) external onlyOwner {
        if (feeShareLimit == 0 || usdcLimit == 0) revert InvalidConfiguration();
        maxFeeSharesPerCall = feeShareLimit;
        maxUsdcPerCall = usdcLimit;
        emit ExecutionLimitsUpdated(feeShareLimit, usdcLimit);
    }

    /// @notice Called by the Genesis LP staking pool AFTER it receives the gross
    /// shares and BEFORE it credits net shares to a depositor/auto-compounder.
    /// Genesis MUST approve this module to transfer the fee from its balance.
    /// A zap ending at Genesis must not separately charge the 0.5% route fee.
    function collectAndProcess(uint256 grossShares)
        external
        onlyGenesis
        nonReentrant
        returns (uint256 feeShares)
    {
        if (grossShares == 0) revert InvalidConfiguration();
        feeShares = grossShares * DEPOSIT_BURN_FEE_BPS / BPS;
        if (feeShares > 0) {
            uint256 beforeBalance = lpVault.balanceOf(address(this));
            IERC20(address(lpVault)).safeTransferFrom(msg.sender, address(this), feeShares);
            if (lpVault.balanceOf(address(this)) - beforeBalance != feeShares) revert InvalidFeeReceipt();
            pendingFeeShares += feeShares;
            totalFeeSharesCollected += feeShares;
        }
        emit FeeSharesCollected(grossShares, feeShares);

        // Each try/catch is a separate revert boundary. A failed USDC buyback
        // leaves already-burned LEVEL burned and USDC still earmarked for burn.
        if (pendingFeeShares > 0) {
            try this.redeemPendingShares() {} catch (bytes memory reason) {
                emit RedemptionDeferred(keccak256(reason));
            }
        }
        if (pendingBurnUSDC > 0) {
            try this.buyAndBurnPendingUSDC() {} catch (bytes memory reason) {
                emit BuybackDeferred(keccak256(reason));
            }
        }
    }

    /// @dev Only reachable through collectAndProcess()'s self-call.
    function redeemPendingShares() external onlySelf {
        uint256 shares = pendingFeeShares;
        if (shares > maxFeeSharesPerCall) shares = maxFeeSharesPerCall;
        if (shares == 0) return;

        uint256 beforeLevel = level.balanceOf(address(this));
        uint256 beforeUsdc = usdc.balanceOf(address(this));
        (uint256 returnedLevel, uint256 returnedUsdc) = lpVault.redeem(shares, address(this));
        uint256 receivedLevel = level.balanceOf(address(this)) - beforeLevel;
        uint256 receivedUsdc = usdc.balanceOf(address(this)) - beforeUsdc;
        if (returnedLevel != receivedLevel || returnedUsdc != receivedUsdc) revert UnexpectedRedemption();

        pendingFeeShares -= shares;
        pendingBurnUSDC += receivedUsdc;
        emit FeeSharesRedeemed(shares, receivedLevel, receivedUsdc);

        if (receivedLevel > 0) {
            totalLevelBurnedFromLPFees += receivedLevel;
            level.burn(receivedLevel);
            emit FeeLevelBurned(receivedLevel, totalLevelBurnedFromLPFees);
        }
    }

    /// @dev Guard-supplied positive minOut must be backed by fresh TWAP,
    /// executable impact checks and a bounded slippage policy. Actual swap
    /// settlement uses the existing official Uniswap v4 exact-input router.
    function buyAndBurnPendingUSDC() external onlySelf {
        uint256 amountIn = pendingBurnUSDC;
        if (amountIn > maxUsdcPerCall) amountIn = maxUsdcPerCall;
        if (amountIn == 0) return;

        uint256 minLevel = guard.minimumLevelOut(amountIn);
        if (minLevel == 0) revert InvalidMinimumOutput();

        uint256 beforeLevel = level.balanceOf(address(this));
        uint256 beforeUsdc = usdc.balanceOf(address(this));
        usdc.forceApprove(address(router), amountIn);
        uint256 returned = router.swapExactIn(
            buybackPoolKey, usdcIsCurrency0, amountIn, minLevel, address(this)
        );
        usdc.forceApprove(address(router), 0);

        uint256 received = level.balanceOf(address(this)) - beforeLevel;
        if (
            received != returned || received < minLevel
                || beforeUsdc - usdc.balanceOf(address(this)) != amountIn
        ) revert UnexpectedBuyback();

        pendingBurnUSDC -= amountIn;
        totalLevelBurnedFromLPFees += received;
        level.burn(received);
        emit FeeLevelBurned(received, totalLevelBurnedFromLPFees);
    }
}
