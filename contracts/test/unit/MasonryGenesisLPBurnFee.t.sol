// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {
    MasonryGenesisLPBurnFee, IMasonryRedeemableLPVault, IMasonryBurnableLevel,
    IMasonryExactInputV4Router, IMasonryBuybackExecutionGuard
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";

contract MockMasonryLevel is ERC20Burnable {
    uint256 public totalBurned;
    constructor() ERC20("LEVEL", "LEVEL") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function burn(uint256 amount) public override {
        totalBurned += amount;
        super.burn(amount);
    }
}

contract MockMasonryUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockMasonryRedeemableVault is ERC20 {
    MockMasonryLevel public immutable level;
    MockMasonryUSDC public immutable usdc;
    bool public failRedemption;
    PoolKey private key;

    constructor(MockMasonryLevel level_, MockMasonryUSDC usdc_)
        ERC20("LEVEL/USDC LP Vault", "mlp")
    {
        level = level_;
        usdc = usdc_;
    }

    function setPoolKey(PoolKey memory key_) external { key = key_; }
    function poolKey() external view returns (PoolKey memory) { return key; }

    function mintShares(address to, uint256 shares) external { _mint(to, shares); }
    function setFailRedemption(bool fail) external { failRedemption = fail; }

    // Deterministic test-only vault: five LP shares (18 decimal) redeem
    // proportionally for two LEVEL plus three USDC. Not a real v4 vault.
    function redeem(uint256 shares, address to)
        external returns (uint256 levelReceived, uint256 usdcReceived)
    {
        require(!failRedemption, "mock: vault paused");
        _burn(msg.sender, shares);
        levelReceived = shares * 2 / 5;
        usdcReceived = shares * 3e6 / 5e18;
        IERC20(address(level)).transfer(to, levelReceived);
        IERC20(address(usdc)).transfer(to, usdcReceived);
    }
}

contract MockMasonryBurnGuard is IMasonryBuybackExecutionGuard {
    bool public safeToTrade = true;
    PoolId public officialPool;

    function setPoolKey(PoolKey memory key_) external { officialPool = PoolIdLibrary.toId(key_); }

    function setSafe(bool value) external { safeToTrade = value; }
    function minimumLevelOut(uint256 usdcAmount) external view returns (uint256) {
        require(safeToTrade, "mock: quote unsafe");
        return usdcAmount * 1e12 * 99 / 100;
    }
}

contract MockMasonryV4Router is IMasonryExactInputV4Router {
    MockMasonryLevel public immutable level;
    MockMasonryUSDC public immutable usdc;
    bool public failSwap;

    constructor(MockMasonryLevel level_, MockMasonryUSDC usdc_) {
        level = level_;
        usdc = usdc_;
    }

    function setFailSwap(bool value) external { failSwap = value; }

    function swapExactIn(
        PoolKey calldata,
        bool,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient
    ) external returns (uint256 amountOut) {
        require(!failSwap, "mock: unsafe v4 swap");
        usdc.transferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn * 1e12;
        require(amountOut >= amountOutMin, "mock: slippage");
        level.mint(recipient, amountOut);
    }
}

contract MasonryGenesisLPBurnFeeTest is Test {
    MockMasonryLevel internal level;
    MockMasonryUSDC internal usdc;
    MockMasonryRedeemableVault internal vault;
    MockMasonryBurnGuard internal guard;
    MockMasonryV4Router internal router;
    MasonryGenesisLPBurnFee internal collector;

    uint256 internal constant GROSS = 1000e18;
    uint256 internal constant FEE = 5e18;

    function setUp() public {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        vault = new MockMasonryRedeemableVault(level, usdc);
        guard = new MockMasonryBurnGuard();
        router = new MockMasonryV4Router(level, usdc);

        address c0 = address(level) < address(usdc) ? address(level) : address(usdc);
        address c1 = address(level) < address(usdc) ? address(usdc) : address(level);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });

        vault.setPoolKey(key);
        guard.setPoolKey(key);
        collector = new MasonryGenesisLPBurnFee(
            IMasonryRedeemableLPVault(address(vault)),
            IMasonryBurnableLevel(address(level)),
            IERC20(address(usdc)),
            IMasonryExactInputV4Router(address(router)),
            IMasonryBuybackExecutionGuard(address(guard)),
            key,
            address(this),
            100e18,
            100e6
        );

        vault.mintShares(address(this), 10_000e18);
        vault.approve(address(collector), type(uint256).max);
        level.mint(address(vault), 10_000e18);
        usdc.mint(address(vault), 10_000e6);
    }

    function test_FullFeeBurnsInDepositorsTransaction() public {
        uint256 fee = collector.collectAndProcess(GROSS);
        assertEq(fee, FEE);
        assertEq(collector.totalFeeSharesCollected(), FEE);
        assertEq(collector.pendingFeeShares(), 0);
        assertEq(collector.pendingBurnUSDC(), 0);
        assertEq(collector.totalLevelBurnedFromLPFees(), 5e18);
        assertEq(level.totalBurned(), 5e18);
        assertEq(usdc.balanceOf(address(router)), 3e6);
        assertEq(vault.balanceOf(address(this)), 10_000e18 - FEE);
    }

    function test_BuybackFailurePreservesUSDCAndDoesNotBlockDeposit() public {
        router.setFailSwap(true);
        uint256 fee = collector.collectAndProcess(GROSS);
        assertEq(fee, FEE);
        assertEq(level.totalBurned(), 2e18);
        assertEq(collector.pendingBurnUSDC(), 3e6);
        assertEq(usdc.balanceOf(address(collector)), 3e6);

        router.setFailSwap(false);
        collector.collectAndProcess(GROSS);
        // The second fee creates 3 USDC more, then clears the full backlog.
        assertEq(level.totalBurned(), 10e18);
        assertEq(collector.pendingBurnUSDC(), 0);
    }

    function test_UnsafeGuardDefersConversionWithoutBlockingDeposit() public {
        guard.setSafe(false);
        collector.collectAndProcess(GROSS);
        assertEq(level.totalBurned(), 2e18);
        assertEq(collector.pendingBurnUSDC(), 3e6);
        guard.setSafe(true);
        collector.collectAndProcess(GROSS);
        assertEq(level.totalBurned(), 10e18);
    }

    function test_RedemptionFailurePreservesSharesForNextGenesisAction() public {
        vault.setFailRedemption(true);
        collector.collectAndProcess(GROSS);
        assertEq(collector.pendingFeeShares(), FEE);
        assertEq(collector.totalLevelBurnedFromLPFees(), 0);
        assertEq(vault.balanceOf(address(collector)), FEE);

        vault.setFailRedemption(false);
        collector.collectAndProcess(GROSS);
        assertEq(collector.pendingFeeShares(), 0);
        assertEq(level.totalBurned(), 10e18);
    }

    function test_BoundedUSDCConversionCarriesRemainingBalanceForward() public {
        collector.setExecutionLimits(100e18, 1e6);
        collector.collectAndProcess(GROSS);
        assertEq(level.totalBurned(), 3e18);
        assertEq(collector.pendingBurnUSDC(), 2e6);
        collector.collectAndProcess(GROSS);
        assertEq(level.totalBurned(), 6e18);
        assertEq(collector.pendingBurnUSDC(), 4e6);
    }

    function test_NoFeeOnZeroRoundedShares() public {
        uint256 fee = collector.collectAndProcess(1);
        assertEq(fee, 0);
        assertEq(collector.totalFeeSharesCollected(), 0);
    }

    function test_UnauthorizedCallerCannotBookOrProcessFeeShares() public {
        vm.expectRevert(MasonryGenesisLPBurnFee.UnauthorizedGenesis.selector);
        vm.prank(address(0xBEEF));
        collector.collectAndProcess(GROSS);

        vm.expectRevert(MasonryGenesisLPBurnFee.OnlySelf.selector);
        collector.redeemPendingShares();

        vm.expectRevert(MasonryGenesisLPBurnFee.OnlySelf.selector);
        collector.buyAndBurnPendingUSDC();
    }

    function test_OwnerCannotSetZeroExecutionLimits() public {
        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        collector.setExecutionLimits(0, 1e6);
    }

    function testFuzz_FeeNeverExceedsFiftyBasisPoints(uint128 gross) public pure {
        uint256 fee = uint256(gross) * 50 / 10_000;
        assertLe(fee, uint256(gross));
        assertLe(fee * 10_000, uint256(gross) * 50);
    }
}
