// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {
    MasonryGenesisLPBurnFee,
    IMasonryRedeemableLPVault,
    IMasonryBurnableLevel,
    IMasonryExactInputV4Router,
    IMasonryBuybackExecutionGuard
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";

contract MockMasonryLevel is ERC20Burnable {
    uint256 public totalBurned;
    constructor() ERC20("LEVEL", "LEVEL") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    function burn(
        uint256 amount
    ) public override {
        totalBurned += amount;
        super.burn(amount);
    }
}

contract MockMasonryUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockMasonryRedeemableVault is ERC20 {
    MockMasonryLevel public immutable level;
    MockMasonryUSDC public immutable usdc;
    bool public failRedemption;
    PoolKey private key;

    constructor(
        MockMasonryLevel level_,
        MockMasonryUSDC usdc_
    ) ERC20("LEVEL/USDC LP Vault", "mlp") {
        level = level_;
        usdc = usdc_;
    }

    function setPoolKey(
        PoolKey memory key_
    ) external {
        key = key_;
    }

    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    function mintShares(
        address to,
        uint256 shares
    ) external {
        _mint(to, shares);
    }

    function setFailRedemption(
        bool fail
    ) external {
        failRedemption = fail;
    }

    // Deterministic test-only vault: five LP shares (18 decimal) redeem
    // proportionally for two LEVEL plus three USDC. Not a real v4 vault.
    function redeem(
        uint256 shares,
        address to
    ) external returns (uint256 levelReceived, uint256 usdcReceived) {
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

    function setPoolKey(
        PoolKey memory key_
    ) external {
        officialPool = PoolIdLibrary.toId(key_);
    }

    function setSafe(
        bool value
    ) external {
        safeToTrade = value;
    }

    function minimumLevelOut(
        uint256 usdcAmount
    ) external view returns (uint256) {
        require(safeToTrade, "mock: quote unsafe");
        return usdcAmount * 1e12 * 99 / 100;
    }
}

contract MockMasonryV4Router is IMasonryExactInputV4Router {
    MockMasonryLevel public immutable level;
    MockMasonryUSDC public immutable usdc;
    bool public failSwap;

    constructor(
        MockMasonryLevel level_,
        MockMasonryUSDC usdc_
    ) {
        level = level_;
        usdc = usdc_;
    }

    function setFailSwap(
        bool value
    ) external {
        failSwap = value;
    }

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

/// @dev Skims 1% on every transfer, so the collector receives less than it asked for.
contract MockSkimmingVault is MockMasonryRedeemableVault {
    constructor(
        MockMasonryLevel level_,
        MockMasonryUSDC usdc_
    ) MockMasonryRedeemableVault(level_, usdc_) {}

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 skim = value / 100;
            super._update(from, address(0xdead), skim);
            value -= skim;
        }
        super._update(from, to, value);
    }
}

contract MasonryGenesisLPBurnFeeTest is Test {
    MockMasonryLevel internal level;
    MockMasonryUSDC internal usdc;
    MockMasonryRedeemableVault internal vault;
    MasonryGenesisLPBurnFee internal collector;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant STRANGER = address(0xBEEF);

    uint256 internal constant GROSS = 1000e18;
    uint256 internal constant FEE = 5e18;
    uint256 internal constant SUPPLY = 10_000e18;

    event GenesisUpdated(address indexed previousGenesis, address indexed newGenesis);
    event FeeSharesCollected(uint256 grossShares, uint256 feeShares);
    event FeeSharesSentToTreasury(uint256 feeShares, uint256 cumulativeSent);

    function setUp() public {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        vault = new MockMasonryRedeemableVault(level, usdc);
        collector = _deploy(vault, TREASURY, address(this), address(this));

        vault.mintShares(address(this), SUPPLY);
        vault.approve(address(collector), type(uint256).max);
        // Back the shares so any accidental redemption would be observable.
        level.mint(address(vault), 10_000e18);
        usdc.mint(address(vault), 10_000e6);
    }

    function _deploy(
        MockMasonryRedeemableVault vault_,
        address treasury_,
        address genesis_,
        address owner_
    ) internal returns (MasonryGenesisLPBurnFee) {
        return new MasonryGenesisLPBurnFee(
            IMasonryRedeemableLPVault(address(vault_)),
            IMasonryBurnableLevel(address(level)),
            IERC20(address(usdc)),
            treasury_,
            genesis_,
            owner_
        );
    }

    // ---- fee flow -------------------------------------------------------

    function test_FeeSharesGoStraightToTreasuryAsPOL() public {
        vm.expectEmit(address(collector));
        emit FeeSharesSentToTreasury(FEE, FEE);
        vm.expectEmit(address(collector));
        emit FeeSharesCollected(GROSS, FEE);

        uint256 fee = collector.collectAndProcess(GROSS);

        assertEq(fee, FEE);
        assertEq(vault.balanceOf(TREASURY), FEE);
        assertEq(vault.balanceOf(address(collector)), 0);
        assertEq(vault.balanceOf(address(this)), SUPPLY - FEE);
        assertEq(collector.totalFeeSharesCollected(), FEE);
        assertEq(collector.totalSharesSentToTreasury(), FEE);
    }

    function test_NothingIsRedeemedOrBurned() public {
        uint256 vaultLevel = level.balanceOf(address(vault));
        uint256 vaultUsdc = usdc.balanceOf(address(vault));

        collector.collectAndProcess(GROSS);

        // The LP position stays whole: no share burn, no underlying leaves the vault.
        assertEq(vault.totalSupply(), SUPPLY);
        assertEq(level.totalBurned(), 0);
        assertEq(level.balanceOf(address(vault)), vaultLevel);
        assertEq(usdc.balanceOf(address(vault)), vaultUsdc);
        assertEq(level.balanceOf(address(collector)), 0);
        assertEq(usdc.balanceOf(address(collector)), 0);
    }

    function test_RepeatedCollectionsAccumulate() public {
        collector.collectAndProcess(GROSS);
        collector.collectAndProcess(GROSS * 2);

        assertEq(vault.balanceOf(TREASURY), FEE * 3);
        assertEq(collector.totalFeeSharesCollected(), FEE * 3);
        assertEq(collector.totalSharesSentToTreasury(), FEE * 3);
        assertEq(vault.balanceOf(address(collector)), 0);
    }

    function test_NoFeeOnZeroRoundedShares() public {
        vm.expectEmit(address(collector));
        emit FeeSharesCollected(199, 0);
        uint256 fee = collector.collectAndProcess(199);

        assertEq(fee, 0);
        assertEq(collector.totalFeeSharesCollected(), 0);
        assertEq(vault.balanceOf(TREASURY), 0);
    }

    function test_SmallestChargeableDepositPaysOneWei() public {
        assertEq(collector.collectAndProcess(200), 1);
        assertEq(vault.balanceOf(TREASURY), 1);
    }

    function test_ZeroGrossSharesReverts() public {
        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        collector.collectAndProcess(0);
    }

    function test_UnsolicitedSharesAreNeverForwardedOrCounted() public {
        vault.mintShares(address(collector), 77e18);

        collector.collectAndProcess(GROSS);

        assertEq(vault.balanceOf(TREASURY), FEE);
        assertEq(vault.balanceOf(address(collector)), 77e18);
        assertEq(collector.totalFeeSharesCollected(), FEE);
    }

    function test_ShortFeeReceiptRevertsTheDeposit() public {
        MockSkimmingVault skimming = new MockSkimmingVault(level, usdc);
        MasonryGenesisLPBurnFee c = _deploy(skimming, TREASURY, address(this), address(this));
        skimming.mintShares(address(this), SUPPLY);
        skimming.approve(address(c), type(uint256).max);

        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidFeeReceipt.selector);
        c.collectAndProcess(GROSS);
    }

    function test_MissingAllowanceRevertsTheDeposit() public {
        vault.approve(address(collector), 0);
        vm.expectRevert();
        collector.collectAndProcess(GROSS);
    }

    // ---- access control -------------------------------------------------

    function test_OnlyGenesisCanCollect() public {
        vm.expectRevert(MasonryGenesisLPBurnFee.UnauthorizedGenesis.selector);
        vm.prank(STRANGER);
        collector.collectAndProcess(GROSS);
    }

    function test_OwnerRepointsGenesis() public {
        vm.expectEmit(address(collector));
        emit GenesisUpdated(address(this), address(vault));
        collector.setGenesis(address(vault));

        assertEq(collector.genesis(), address(vault));
        vm.expectRevert(MasonryGenesisLPBurnFee.UnauthorizedGenesis.selector);
        collector.collectAndProcess(GROSS);
    }

    function test_OnlyOwnerCanRepointGenesis() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        vm.prank(STRANGER);
        collector.setGenesis(address(vault));
    }

    function test_GenesisMustBeADeployedContract() public {
        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        collector.setGenesis(address(0));
        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        collector.setGenesis(STRANGER);
    }

    function test_TreasuryIsFixedAtDeployment() public view {
        assertEq(collector.treasury(), TREASURY);
        assertEq(address(collector.lpVault()), address(vault));
        assertEq(address(collector.level()), address(level));
        assertEq(address(collector.usdc()), address(usdc));
        assertEq(collector.DEPOSIT_BURN_FEE_BPS(), 50);
    }

    // ---- constructor ----------------------------------------------------

    function test_ConstructorRejectsBadConfiguration() public {
        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        _deploy(vault, address(0), address(this), address(this));

        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        _deploy(vault, TREASURY, address(0), address(this));

        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidConfiguration.selector);
        _deploy(MockMasonryRedeemableVault(STRANGER), TREASURY, address(this), address(this));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        _deploy(vault, TREASURY, address(this), address(0));
    }

    // ---- fuzz -----------------------------------------------------------

    function testFuzz_ExactlyFiftyBpsReachesTreasury(
        uint256 gross
    ) public {
        gross = bound(gross, 1, SUPPLY);
        uint256 expected = gross * 50 / 10_000;

        uint256 fee = collector.collectAndProcess(gross);

        assertEq(fee, expected);
        assertEq(vault.balanceOf(TREASURY), expected);
        assertEq(vault.balanceOf(address(collector)), 0);
        assertEq(vault.balanceOf(address(this)), SUPPLY - expected);
        assertLe(fee * 10_000, gross * 50);
    }
}
