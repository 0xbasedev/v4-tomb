// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Masonry} from "../../src/core/Masonry.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BaseForkTest
 * @notice Forks Base mainnet at runtime and validates that the stack deploys
 *         cleanly against the live WETH token and Uniswap V4 PoolManager. The full V4
 *         hook integration (real pool initialization, swap-driven observation feed)
 *         lives in BaseForkHook.t.sol.
 *
 *         This test is gated on the BASE_RPC_URL env var; without it the whole contract
 *         is skipped so `forge test` in CI without that var stays green.
 */
contract BaseForkTest is BaseTest {
    /// @notice Canonical OP-stack predeploy WETH on Base mainnet (and Base Sepolia, OP, Unichain).
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    /// @notice Uniswap V4 PoolManager on Base mainnet.
    address internal constant V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    PegToken internal peg;
    ShareToken internal share;
    Treasury internal treasury;
    Masonry internal masonry;
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
        peg = new PegToken("Peg Token", "PEG");
        share = new ShareToken("Share Token", "SHARE", startTime, communityFund, devFund);
        vm.stopPrank();

        oracle = new MockOracle(1e18);

        vm.startPrank(owner);
        treasury = new Treasury();
        masonry = new Masonry();
        masonry.initialize(IERC20(address(peg)), IERC20(address(share)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = genesisPool;
        excluded[1] = mainPool;
        excluded[2] = airdropWallet;
        treasury.initialize(address(peg), address(share), address(oracle), address(masonry), startTime, excluded);

        peg.distributeReward(genesisPool, mainPool, airdropWallet);
        share.distributeReward(farmingPool);

        peg.transferTrustees(address(treasury));
        share.transferTrustees(address(treasury));
        masonry.setOperator(address(treasury));

        // Launch ceremony Masonry seed (see docs/GAP_AUDIT.md gap #16):
        // owner holds 1 SHARE from ShareToken's constructor mint. Stake a tiny
        // amount so allocateSeigniorage's bootstrap branch can credit Masonry
        // without reverting CannotAllocateWhenTotalSupplyZero.
        share.approve(address(masonry), 1);
        masonry.stake(1);

        vm.stopPrank();

        vm.warp(startTime + 1);
    }

    // ---------------------------------------------------------------------
    // Live Base state sanity checks
    // ---------------------------------------------------------------------

    function test_WethDeployedAndIsErc20() public view {
        assertGt(WETH.code.length, 0, "WETH should have code on Base");

        (bool ok, bytes memory data) = WETH.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok, "WETH.decimals() should succeed");
        uint8 decimals = abi.decode(data, (uint8));
        assertEq(decimals, 18, "WETH should have 18 decimals (matches our $PEG)");

        (bool ok2, bytes memory data2) = WETH.staticcall(abi.encodeWithSignature("symbol()"));
        assertTrue(ok2, "WETH.symbol() should succeed");
        string memory symbol = abi.decode(data2, (string));
        assertEq(symbol, "WETH", "WETH symbol should be WETH");
    }

    function test_V4PoolManagerDeployed() public view {
        assertGt(V4_POOL_MANAGER.code.length, 0, "V4 PoolManager should have code on Base");
    }

    // ---------------------------------------------------------------------
    // Full stack against the forked chain
    // ---------------------------------------------------------------------

    function test_FullStackInitializesAgainstFork() public view {
        // Treasury references all five protocol addresses post-init.
        assertEq(treasury.peg(), address(peg));
        assertEq(treasury.share(), address(share));
        assertEq(treasury.oracle(), address(oracle));
        assertEq(treasury.masonry(), address(masonry));

        // Operator handoff complete on every protocol contract.
        assertEq(peg.operator(), address(treasury));
        assertEq(share.operator(), address(treasury));
        assertEq(masonry.operator(), address(treasury));

        // Genesis distributions landed.
        assertEq(peg.balanceOf(genesisPool), 11_000 ether);
        assertEq(peg.balanceOf(mainPool), 140_000 ether);
        assertEq(peg.balanceOf(airdropWallet), 9000 ether);
        assertEq(share.balanceOf(farmingPool), 59_500 ether);
    }

    function test_EpochCycleRunsAgainstFork() public {
        // Seed circulation: alice + bob get OLDM from the peg farm.
        vm.startPrank(mainPool);
        peg.transfer(alice, 10_000 ether);
        peg.transfer(bob, 10_000 ether);
        vm.stopPrank();

        // Seed SHARE from farming pool to alice.
        vm.prank(farmingPool);
        share.transfer(alice, 1000 ether);

        // Alice stakes.
        vm.prank(alice);
        share.approve(address(masonry), 1000 ether);
        vm.roll(block.number + 1);
        vm.prank(alice);
        masonry.stake(1000 ether);

        // Drive the oracle and allocate one expansion epoch.
        oracle.setPrice(1.05e18);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();
        assertEq(treasury.epoch(), 1);

        // Alice accrued reward.
        assertGt(masonry.earned(alice), 0);
    }

    function test_TreasuryHoldsNothingAcrossExpansionAndContraction() public {
        vm.startPrank(mainPool);
        peg.transfer(alice, 5000 ether);
        vm.stopPrank();
        vm.prank(farmingPool);
        share.transfer(alice, 1000 ether);
        vm.prank(alice);
        share.approve(address(masonry), 1000 ether);
        vm.roll(block.number + 1);
        vm.prank(alice);
        masonry.stake(1000 ether);

        // Expansion, contraction, then expansion again: no debt to repay in between.
        uint256[4] memory prices = [uint256(1.05e18), 0.9e18, 1.15e18, 1.15e18];
        for (uint256 i = 0; i < prices.length; ++i) {
            oracle.setPrice(prices[i]);
            uint256 supplyBefore = peg.totalSupply();
            vm.warp(treasury.nextEpochPoint() + 1);
            vm.roll(block.number + 1);
            treasury.allocateSeigniorage();
            if (prices[i] <= treasury.pegPriceCeiling()) {
                assertEq(peg.totalSupply(), supplyBefore, "nothing minted at or below the ceiling");
            } else {
                assertGt(peg.totalSupply(), supplyBefore, "expansion mints straight away");
            }
            assertEq(peg.balanceOf(address(treasury)), 0, "the Treasury never holds a balance");
        }
    }
}
