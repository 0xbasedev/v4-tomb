// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {BondToken} from "../../src/tokens/BondToken.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Masonry} from "../../src/core/Masonry.sol";
import {Timelock} from "../../src/governance/Timelock.sol";
import {GenesisRewardPool} from "../../src/distribution/GenesisRewardPool.sol";
import {PegFarm} from "../../src/distribution/PegFarm.sol";
import {ShareFarm} from "../../src/distribution/ShareFarm.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {MockOracle} from "../utils/MockOracle.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

/**
 * @title GovernanceRotationTest
 * @notice Verifies the full Sprint 14 ceremony — deploy a Timelock and rotate every
 *         admin-bearing role from the deployer EOA to the Timelock.
 *
 *         Final ownership state after rotation (and what stays put):
 *
 *           Ownable2Step (rotated to Timelock via two-step):
 *             - PegToken.owner = Timelock
 *             - ShareToken.owner   = Timelock
 *             - BondToken.owner = Timelock
 *             - PegDefenseHook.owner = Timelock  (not exercised here — needs V4 setUp)
 *
 *           Single-step operator (rotated to Timelock directly):
 *             - Treasury.operator       = Timelock
 *             - GenesisRewardPool.operator = Timelock
 *             - PegFarm.operator    = Timelock
 *             - ShareFarm.operator   = Timelock
 *
 *           Unchanged (protocol-internal — rotating breaks the seigniorage flow):
 *             - Masonry.operator   = Treasury   (Treasury calls allocateSeigniorage)
 *             - PegToken.trustees    = Treasury   (Treasury mints/burns)
 *             - ShareToken.trustees      = Treasury
 *             - BondToken.trustees   = Treasury
 *             - V4PositionWrapper    = no admin   (wrap/unwrap are permissionless)
 *
 *         The ceremony has three on-chain stages:
 *           1. Deploy Timelock(admin=deployer, delay=24h)
 *           2. Deployer calls:
 *                - transferOwnership(timelock) on every Ownable2Step contract
 *                  (sets pendingOwner; Timelock must accept)
 *                - setOperator(timelock) on every operator-bearing contract
 *                - timelock.queueTransaction(target=ownable, sig="acceptOwnership()", eta)
 *                  for each Ownable2Step contract
 *           3. After eta: deployer executes each queued acceptOwnership tx via Timelock.
 *
 *         For mainnet the delay is the wait between stages 2 and 3 (real time).
 *         This test simulates the wait via `vm.warp`.
 */
contract GovernanceRotationTest is BaseTest {
    // ----- protocol contracts (set up like EpochCycle/BaseFork tests) -----
    PegToken internal peg;
    ShareToken internal share;
    BondToken internal bond;
    Treasury internal treasury;
    Masonry internal masonry;
    GenesisRewardPool internal genesisRewardPool;
    PegFarm internal pegFarm;
    ShareFarm internal shareFarm;
    MockOracle internal oracle;
    Timelock internal timelock;

    address internal genesisPoolEoa = makeAddr("genesisPoolEoa");
    address internal mainPoolEoa = makeAddr("mainPoolEoa");
    address internal airdropWallet = makeAddr("airdropWallet");
    address internal farmingPool = makeAddr("farmingPool");
    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");

    uint256 internal startTime;
    uint256 internal constant TIMELOCK_DELAY = 1 days;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;

        // Deploy tokens (owner deploys → owner is Ownable2Step.owner).
        vm.startPrank(owner);
        peg = new PegToken();
        share = new ShareToken(startTime, communityFund, devFund);
        bond = new BondToken();
        oracle = new MockOracle(1e18);

        // Deploy reward pools (deployer = owner = operator of each).
        genesisRewardPool = new GenesisRewardPool(address(peg), startTime);
        pegFarm = new PegFarm(address(peg), startTime + 1 days);
        shareFarm = new ShareFarm(address(share), startTime + 1 days);

        // Deploy Treasury + Masonry and wire.
        treasury = new Treasury();
        masonry = new Masonry();
        masonry.initialize(IERC20(address(peg)), IERC20(address(share)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = address(genesisRewardPool);
        excluded[1] = address(pegFarm);
        excluded[2] = airdropWallet;
        treasury.initialize(
            address(peg), address(bond), address(share), address(oracle), address(masonry), startTime, excluded
        );

        peg.distributeReward(address(genesisRewardPool), address(pegFarm), airdropWallet);
        share.distributeReward(address(shareFarm));

        // Hand off trustees on tokens and operator on masonry to Treasury.
        peg.transferTrustees(address(treasury));
        share.transferTrustees(address(treasury));
        bond.transferTrustees(address(treasury));
        masonry.setOperator(address(treasury));

        // Deploy Timelock with admin = owner (the deployer EOA).
        timelock = new Timelock(owner, TIMELOCK_DELAY);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Pre-ceremony sanity
    // ---------------------------------------------------------------------

    function test_PreCeremony_AdminStateMatchesExpected() public view {
        // Ownable2Step contracts: owner = the deployer (owner addr).
        assertEq(peg.owner(), owner, "peg owner == deployer");
        assertEq(share.owner(), owner, "share owner == deployer");
        assertEq(bond.owner(), owner, "bond owner == deployer");

        // Trustees: Treasury (set in setUp).
        assertEq(peg.trustees(), address(treasury), "peg trustees == treasury");
        assertEq(share.trustees(), address(treasury), "share trustees == treasury");
        assertEq(bond.trustees(), address(treasury), "bond trustees == treasury");

        // Treasury + reward pools: operator = deployer.
        assertEq(treasury.operator(), owner, "treasury operator == deployer");
        assertEq(genesisRewardPool.operator(), owner, "genesis operator == deployer");
        assertEq(pegFarm.operator(), owner, "main operator == deployer");
        assertEq(shareFarm.operator(), owner, "share operator == deployer");

        // Masonry: operator = Treasury (stays).
        assertEq(masonry.operator(), address(treasury), "masonry operator == treasury");

        // Timelock: admin = deployer, delay = 24h.
        assertEq(timelock.admin(), owner, "timelock admin == deployer");
        assertEq(timelock.delay(), TIMELOCK_DELAY, "timelock delay == 24h");
    }

    // ---------------------------------------------------------------------
    // Stage 2: transfer + queue
    // ---------------------------------------------------------------------

    function test_FullCeremony_RotatesEveryAdminToTimelock() public {
        uint256 eta = block.timestamp + TIMELOCK_DELAY + 1;

        // Stage 2a: Ownable2Step transferOwnership (sets pendingOwner = timelock).
        vm.startPrank(owner);
        peg.transferOwnership(address(timelock));
        share.transferOwnership(address(timelock));
        bond.transferOwnership(address(timelock));

        // Stage 2b: single-step operator rotation.
        treasury.setOperator(address(timelock));
        genesisRewardPool.setOperator(address(timelock));
        pegFarm.setOperator(address(timelock));
        shareFarm.setOperator(address(timelock));

        // Stage 2c: queue acceptOwnership for each Ownable2Step contract via Timelock.
        timelock.queueTransaction(address(peg), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(share), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(bond), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();

        // Mid-ceremony state: pendingOwner == timelock on tokens; operator already rotated.
        assertEq(peg.pendingOwner(), address(timelock), "peg pendingOwner == timelock");
        assertEq(share.pendingOwner(), address(timelock), "share pendingOwner == timelock");
        assertEq(bond.pendingOwner(), address(timelock), "bond pendingOwner == timelock");
        assertEq(treasury.operator(), address(timelock), "treasury operator == timelock");
        assertEq(genesisRewardPool.operator(), address(timelock), "genesis operator == timelock");
        assertEq(pegFarm.operator(), address(timelock), "main operator == timelock");
        assertEq(shareFarm.operator(), address(timelock), "share operator == timelock");

        // Cannot execute before eta.
        vm.expectRevert(Timelock.TransactionNotMature.selector);
        vm.prank(owner);
        timelock.executeTransaction(address(peg), 0, "acceptOwnership()", bytes(""), eta);

        // Stage 3: wait the delay then execute.
        vm.warp(eta + 1);

        vm.startPrank(owner);
        timelock.executeTransaction(address(peg), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(share), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(bond), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();

        // Final state: every Ownable2Step contract has Timelock as owner.
        assertEq(peg.owner(), address(timelock), "peg owner == timelock");
        assertEq(share.owner(), address(timelock), "share owner == timelock");
        assertEq(bond.owner(), address(timelock), "bond owner == timelock");

        // Trustees on tokens still Treasury (unchanged).
        assertEq(peg.trustees(), address(treasury), "peg trustees still treasury");
        assertEq(share.trustees(), address(treasury), "share trustees still treasury");
        assertEq(bond.trustees(), address(treasury), "bond trustees still treasury");

        // Masonry unchanged.
        assertEq(masonry.operator(), address(treasury), "masonry operator still treasury");

        // pendingOwner cleared after acceptOwnership.
        assertEq(peg.pendingOwner(), address(0), "peg pendingOwner cleared");
    }

    // ---------------------------------------------------------------------
    // After ceremony: Timelock can mutate via queue/execute
    // ---------------------------------------------------------------------

    function test_PostCeremony_TimelockCanRotateTrustees() public {
        // Do the full rotation first.
        _doFullRotation();

        // After rotation, Timelock is owner of peg. Timelock can call
        // peg.transferTrustees(newTrustees) via queue+execute.
        address newTrustees = makeAddr("newTrustees");
        uint256 eta = block.timestamp + TIMELOCK_DELAY + 1;

        bytes memory data = abi.encode(newTrustees);
        vm.prank(owner);
        timelock.queueTransaction(address(peg), 0, "transferTrustees(address)", data, eta);

        vm.warp(eta + 1);
        vm.prank(owner);
        timelock.executeTransaction(address(peg), 0, "transferTrustees(address)", data, eta);

        assertEq(peg.trustees(), newTrustees, "trustees rotated via Timelock");
    }

    function test_PostCeremony_TimelockCanRotateTreasuryOperator() public {
        _doFullRotation();

        address newOperator = makeAddr("newOperator");
        uint256 eta = block.timestamp + TIMELOCK_DELAY + 1;

        bytes memory data = abi.encode(newOperator);
        vm.prank(owner);
        timelock.queueTransaction(address(treasury), 0, "setOperator(address)", data, eta);

        vm.warp(eta + 1);
        vm.prank(owner);
        timelock.executeTransaction(address(treasury), 0, "setOperator(address)", data, eta);

        assertEq(treasury.operator(), newOperator, "treasury operator rotated via Timelock");
    }

    function test_PostCeremony_FormerDeployerCannotMutate() public {
        _doFullRotation();

        // Former deployer (owner var) can no longer call treasury.setOperator —
        // it's no longer the operator.
        vm.prank(owner);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setOperator(makeAddr("attempt"));

        // Former deployer can no longer transferOwnership on tokens — it's no longer
        // the owner. OZ's Ownable reverts with OwnableUnauthorizedAccount.
        vm.prank(owner);
        vm.expectRevert();
        peg.transferOwnership(makeAddr("attempt"));
    }

    // ---------------------------------------------------------------------
    // Reward pools: Timelock can add LP entries via queue/execute
    // ---------------------------------------------------------------------

    function test_PostCeremony_TimelockCanAddRewardPoolEntries() public {
        _doFullRotation();

        // Some stake token to register in the genesis pool.
        IERC20 stakeToken = IERC20(address(share));

        bytes memory data = abi.encode(uint256(100), stakeToken, false, uint256(0));
        uint256 eta = block.timestamp + TIMELOCK_DELAY + 1;

        vm.prank(owner);
        timelock.queueTransaction(address(genesisRewardPool), 0, "add(uint256,address,bool,uint256)", data, eta);

        vm.warp(eta + 1);
        vm.prank(owner);
        timelock.executeTransaction(address(genesisRewardPool), 0, "add(uint256,address,bool,uint256)", data, eta);

        // Pool entry registered with 100 allocPoint.
        (IERC20 token, uint256 allocPoint,,,) = genesisRewardPool.poolInfo(0);
        assertEq(address(token), address(stakeToken));
        assertEq(allocPoint, 100);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _doFullRotation() internal {
        uint256 eta = block.timestamp + TIMELOCK_DELAY + 1;

        vm.startPrank(owner);
        peg.transferOwnership(address(timelock));
        share.transferOwnership(address(timelock));
        bond.transferOwnership(address(timelock));
        treasury.setOperator(address(timelock));
        genesisRewardPool.setOperator(address(timelock));
        pegFarm.setOperator(address(timelock));
        shareFarm.setOperator(address(timelock));
        timelock.queueTransaction(address(peg), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(share), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(bond), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();

        vm.warp(eta + 1);
        vm.startPrank(owner);
        timelock.executeTransaction(address(peg), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(share), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(bond), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();
    }
}
