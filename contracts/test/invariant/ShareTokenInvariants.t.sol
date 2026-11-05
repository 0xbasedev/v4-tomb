// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {ShareToken, ShareTokenProfiles} from "../../src/tokens/ShareToken.sol";

/**
 * @title ShareTokenHandler
 * @notice Fuzz-target wrapper for ESTATE. The handler holds the trustees role so it can
 *         call `distributeReward`. It also drives time forward (via vm.warp) so the
 *         claimRewards vesting math is exercised across the full 365-day schedule.
 */
contract ShareTokenHandler is Test {
    ShareToken public estate;

    address public farmingPool;
    address public communityFund;
    address public devFund;
    address[] public actors;

    uint256 public ghost_warpedTo;
    bool public ghost_distributed;

    constructor(
        ShareToken _estate,
        address _farmingPool,
        address _communityFund,
        address _devFund
    ) {
        estate = _estate;
        farmingPool = _farmingPool;
        communityFund = _communityFund;
        devFund = _devFund;
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        ghost_warpedTo = block.timestamp;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /// @notice One-shot distribute. After the first call further calls revert; handler swallows
    ///         the revert by short-circuiting on the ghost flag.
    function distribute() external {
        if (ghost_distributed) return;
        estate.distributeReward(farmingPool);
        ghost_distributed = true;
    }

    /// @notice Advance time so vesting accrual progresses. Capped at end of vesting + 30d so
    ///         we stay within sane bounds.
    function warp(
        uint32 secondsForward
    ) external {
        uint256 maxTs = estate.endTime() + 30 days;
        uint256 next = block.timestamp + (uint256(secondsForward) % 1 days);
        if (next > maxTs) next = maxTs;
        vm.warp(next);
        ghost_warpedTo = next;
    }

    /// @notice Anyone can poke claimRewards — it mints any due vesting to the community / dev
    ///         fund addresses.
    function claimRewards() external {
        estate.claimRewards();
    }

    function transfer(
        uint256 fromSeed,
        uint256 toSeed,
        uint256 amount
    ) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = estate.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);
        vm.prank(from);
        estate.transfer(to, amount);
    }

    function burn(
        uint256 actorSeed,
        uint256 amount
    ) external {
        address from = actors[actorSeed % actors.length];
        uint256 balance = estate.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);
        vm.prank(from);
        estate.burn(amount);
    }

    /// @notice Seed actors with ESTATE from the farming pool so transfer/burn actions have
    ///         something to work with. The fuzzer calls this whenever it wants to top up.
    function seedFromFarmingPool(
        uint256 actorSeed,
        uint256 amount
    ) external {
        if (!ghost_distributed) return;
        address to = actors[actorSeed % actors.length];
        uint256 balance = estate.balanceOf(farmingPool);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);
        vm.prank(farmingPool);
        estate.transfer(to, amount);
    }
}

/**
 * @title ShareTokenInvariants
 * @notice Properties that must hold across all interactions with $ESTATE.
 */
contract ShareTokenInvariants is StdInvariant, Test {
    ShareToken public estate;
    ShareTokenHandler public handler;

    address public farmingPool;
    address public communityFund;
    address public devFund;

    uint256 public startTime;

    function setUp() public {
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;

        farmingPool = makeAddr("farmingPool");
        communityFund = makeAddr("communityFund");
        devFund = makeAddr("devFund");

        estate =
            new ShareToken(ShareTokenProfiles.legacy(startTime, communityFund, devFund, address(this)), address(this));
        handler = new ShareTokenHandler(estate, farmingPool, communityFund, devFund);

        // Hand trustees to the handler so it can call distributeReward.
        estate.transferTrustees(address(handler));

        targetContract(address(handler));
    }

    /// @notice The hard cap. Constructor mints 1 ether to deployer; everything else is
    ///         capped at the sum of the three Tomb-faithful allocations (70k ETH total).
    ///         Vesting drips never push past this.
    function invariant_TotalSupplyNeverExceedsCapPlusDeployMint() public view {
        uint256 totalAlloc = estate.FARMING_POOL_REWARD_ALLOCATION() + estate.COMMUNITY_FUND_POOL_ALLOCATION()
            + estate.DEV_FUND_POOL_ALLOCATION();
        assertLe(estate.totalSupply(), 1 ether + totalAlloc);
    }

    /// @notice The community fund vesting never mints more than its full allocation. Even
    ///         if claimRewards is called repeatedly with extreme time warps, the cap holds.
    function invariant_CommunityFundNeverOverPaid() public view {
        assertLe(estate.balanceOf(communityFund), estate.COMMUNITY_FUND_POOL_ALLOCATION());
    }

    /// @notice Same for dev fund.
    function invariant_DevFundNeverOverPaid() public view {
        assertLe(estate.balanceOf(devFund), estate.DEV_FUND_POOL_ALLOCATION());
    }

    /// @notice Pre-distribution: farming pool has nothing. Post-distribution: it has at
    ///         most FARMING_POOL_REWARD_ALLOCATION (handler reseeds out to actors, never in).
    function invariant_FarmingPoolNeverOverAllocated() public view {
        assertLe(estate.balanceOf(farmingPool), estate.FARMING_POOL_REWARD_ALLOCATION());
    }

    /// @notice Sum of every tracked address's balance equals totalSupply.
    function invariant_SumOfBalancesEqualsTotalSupply() public view {
        uint256 sum = estate.balanceOf(address(this)); // deployer holds 1 ether
        sum += estate.balanceOf(farmingPool);
        sum += estate.balanceOf(communityFund);
        sum += estate.balanceOf(devFund);
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += estate.balanceOf(handler.actors(i));
        }
        assertEq(sum, estate.totalSupply());
    }
}
