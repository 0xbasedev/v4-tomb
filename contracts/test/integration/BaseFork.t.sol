// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Estate} from "../../src/tokens/Estate.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BaseForkTest
 * @notice Forks Base mainnet at runtime and validates that the Old Money stack deploys
 *         cleanly against the live cbETH token and Uniswap V4 PoolManager. The full V4
 *         hook integration (real pool initialization, swap-driven observation feed)
 *         requires liquidity setup + swap routing and lives in Sprint 12.
 *
 *         This test is gated on the BASE_RPC_URL env var; without it the whole contract
 *         is skipped so `forge test` in CI without that var stays green.
 */
contract BaseForkTest is BaseTest {
    /// @notice Coinbase Wrapped Staked ETH on Base mainnet.
    address internal constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;

    /// @notice Uniswap V4 PoolManager on Base mainnet.
    address internal constant V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    OldMoney internal money;
    Estate internal estate;
    TrustNote internal trustnote;
    Treasury internal treasury;
    Boardroom internal boardroom;
    MockOracle internal oracle;

    address internal genesisPool = makeAddr("genesisPool");
    address internal mainPool = makeAddr("mainPool");
    address internal airdropWallet = makeAddr("airdropWallet");
    address internal farmingPool = makeAddr("farmingPool");
    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");

    uint256 internal startTime;
    bool internal forked;

    function setUp() public override {
        // Gracefully skip if BASE_RPC_URL isn't configured. Avoids CI breakage.
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(url);
        forked = true;

        super.setUp();

        startTime = block.timestamp + 1 hours;

        // Standard deploy sequence — same dance as EpochCycle.t.sol setUp.
        vm.startPrank(owner);
        money = new OldMoney();
        estate = new Estate(startTime, communityFund, devFund);
        trustnote = new TrustNote();
        vm.stopPrank();

        oracle = new MockOracle(1e18);

        vm.startPrank(owner);
        treasury = new Treasury();
        boardroom = new Boardroom();
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = genesisPool;
        excluded[1] = mainPool;
        excluded[2] = airdropWallet;
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            startTime,
            excluded
        );

        money.distributeReward(genesisPool, mainPool, airdropWallet);
        estate.distributeReward(farmingPool);

        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));
        vm.stopPrank();

        vm.warp(startTime + 1);
    }

    // ---------------------------------------------------------------------
    // Live Base state sanity checks
    // ---------------------------------------------------------------------

    function test_CbethDeployedAndIsErc20() public view {
        assertGt(CBETH.code.length, 0, "cbETH should have code on Base");

        // Standard ERC20 interface — decimals(), name(), symbol() are optional but
        // present on cbETH per Coinbase's docs.
        (bool ok, bytes memory data) = CBETH.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok, "cbETH.decimals() should succeed");
        uint8 decimals = abi.decode(data, (uint8));
        assertEq(decimals, 18, "cbETH should have 18 decimals (matches our $MONEY)");

        (bool ok2, bytes memory data2) = CBETH.staticcall(abi.encodeWithSignature("symbol()"));
        assertTrue(ok2, "cbETH.symbol() should succeed");
        string memory symbol = abi.decode(data2, (string));
        assertEq(symbol, "cbETH", "cbETH symbol should be cbETH");
    }

    function test_V4PoolManagerDeployed() public view {
        assertGt(V4_POOL_MANAGER.code.length, 0, "V4 PoolManager should have code on Base");
    }

    // ---------------------------------------------------------------------
    // Full stack against the forked chain
    // ---------------------------------------------------------------------

    function test_FullStackInitializesAgainstFork() public view {
        // Treasury references all five protocol addresses post-init.
        assertEq(treasury.money(), address(money));
        assertEq(treasury.trustnote(), address(trustnote));
        assertEq(treasury.estate(), address(estate));
        assertEq(treasury.oracle(), address(oracle));
        assertEq(treasury.boardroom(), address(boardroom));

        // Operator handoff complete on every protocol contract.
        assertEq(money.operator(), address(treasury));
        assertEq(estate.operator(), address(treasury));
        assertEq(trustnote.operator(), address(treasury));
        assertEq(boardroom.operator(), address(treasury));

        // Genesis distributions landed.
        assertEq(money.balanceOf(genesisPool), 11_000 ether);
        assertEq(money.balanceOf(mainPool), 140_000 ether);
        assertEq(money.balanceOf(airdropWallet), 9000 ether);
        assertEq(estate.balanceOf(farmingPool), 59_500 ether);
    }

    function test_EpochCycleRunsAgainstFork() public {
        // Seed circulation: alice + bob get OLDM from the main reward pool.
        vm.startPrank(mainPool);
        money.transfer(alice, 10_000 ether);
        money.transfer(bob, 10_000 ether);
        vm.stopPrank();

        // Seed ESTATE from farming pool to alice.
        vm.prank(farmingPool);
        estate.transfer(alice, 1000 ether);

        // Alice stakes.
        vm.prank(alice);
        estate.approve(address(boardroom), 1000 ether);
        vm.roll(block.number + 1);
        vm.prank(alice);
        boardroom.stake(1000 ether);

        // Drive the oracle and allocate one expansion epoch.
        oracle.setPrice(1.05e18);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();
        assertEq(treasury.epoch(), 1);

        // Alice accrued reward.
        assertGt(boardroom.earned(alice), 0);
    }

    function test_TreasuryHoldsMoneyAfterContractionRecovery() public {
        // Quick contraction → recovery to make sure the bond reserve path works on fork.
        vm.startPrank(mainPool);
        money.transfer(alice, 5000 ether);
        vm.stopPrank();
        vm.prank(farmingPool);
        estate.transfer(alice, 1000 ether);
        vm.prank(alice);
        estate.approve(address(boardroom), 1000 ether);
        vm.roll(block.number + 1);
        vm.prank(alice);
        boardroom.stake(1000 ether);

        // Expansion (need a tick at all).
        oracle.setPrice(1.05e18);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();

        // Contraction tick.
        oracle.setPrice(0.9e18);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();

        // Alice buys some bonds.
        vm.prank(alice);
        money.approve(address(treasury), 100 ether);
        uint256 contractionPrice = treasury.getMoneyPrice();
        vm.roll(block.number + 1);
        vm.prank(alice);
        treasury.buyBonds(100 ether, contractionPrice);
        assertEq(trustnote.balanceOf(alice), 100 ether);

        // Three recovery expansions at 1.15 to build reserves.
        oracle.setPrice(1.15e18);
        for (uint256 i = 0; i < 3; ++i) {
            vm.warp(treasury.nextEpochPoint() + 1);
            vm.roll(block.number + 1);
            treasury.allocateSeigniorage();
        }

        // Treasury now holds MONEY for bond redemption.
        assertGt(money.balanceOf(address(treasury)), 0);
    }
}
