// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken, ShareTokenProfiles} from "../../src/tokens/ShareToken.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {Timelock} from "../../src/governance/Timelock.sol";
import {GenesisRewardPool} from "../../src/distribution/GenesisRewardPool.sol";
import {MainRewardPool} from "../../src/distribution/MainRewardPool.sol";
import {ShareRewardPool} from "../../src/distribution/ShareRewardPool.sol";
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
 *             - TrustNote.owner = Timelock
 *             - PegDefenseHook.owner = Timelock  (not exercised here — needs V4 setUp)
 *
 *           Single-step operator (rotated to Timelock directly):
 *             - Treasury.operator       = Timelock
 *             - GenesisRewardPool.operator = Timelock
 *             - MainRewardPool.operator    = Timelock
 *             - ShareRewardPool.operator   = Timelock
 *
 *           Unchanged (protocol-internal — rotating breaks the seigniorage flow):
 *             - Boardroom.operator   = Treasury   (Treasury calls allocateSeigniorage)
 *             - PegToken.trustees    = Treasury   (Treasury mints/burns)
 *             - ShareToken.trustees      = Treasury
 *             - TrustNote.trustees   = Treasury
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
    PegToken internal money;
    ShareToken internal estate;
    TrustNote internal trustnote;
    Treasury internal treasury;
    Boardroom internal boardroom;
    GenesisRewardPool internal genesisRewardPool;
    MainRewardPool internal mainRewardPool;
    ShareRewardPool internal shareRewardPool;
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
        money = new PegToken(owner);
        estate = new ShareToken(ShareTokenProfiles.legacy(startTime, communityFund, devFund, owner), owner);
        trustnote = new TrustNote(owner);
        oracle = new MockOracle(1e18);

        // Deploy reward pools (deployer = owner = operator of each).
        genesisRewardPool = new GenesisRewardPool(address(money), startTime, owner);
        mainRewardPool = new MainRewardPool(address(money), startTime + 1 days, owner);
        shareRewardPool = new ShareRewardPool(address(estate), startTime + 1 days, owner);

        // Deploy Treasury + Boardroom and wire.
        treasury = new Treasury(owner);
        boardroom = new Boardroom(owner);
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = address(genesisRewardPool);
        excluded[1] = address(mainRewardPool);
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

        money.distributeReward(address(genesisRewardPool), address(mainRewardPool), airdropWallet);
        estate.distributeReward(address(shareRewardPool));

        // Hand off trustees on tokens and operator on boardroom to Treasury.
        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));

        // Deploy Timelock with admin = owner (the deployer EOA).
        timelock = new Timelock(owner, TIMELOCK_DELAY);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Pre-ceremony sanity
    // ---------------------------------------------------------------------

    function test_PreCeremony_AdminStateMatchesExpected() public view {
        // Ownable2Step contracts: owner = the deployer (owner addr).
        assertEq(money.owner(), owner, "money owner == deployer");
        assertEq(estate.owner(), owner, "estate owner == deployer");
        assertEq(trustnote.owner(), owner, "trustnote owner == deployer");

        // Trustees: Treasury (set in setUp).
        assertEq(money.trustees(), address(treasury), "money trustees == treasury");
        assertEq(estate.trustees(), address(treasury), "estate trustees == treasury");
        assertEq(trustnote.trustees(), address(treasury), "trustnote trustees == treasury");

        // Treasury + reward pools: operator = deployer.
        assertEq(treasury.operator(), owner, "treasury operator == deployer");
        assertEq(genesisRewardPool.operator(), owner, "genesis operator == deployer");
        assertEq(mainRewardPool.operator(), owner, "main operator == deployer");
        assertEq(shareRewardPool.operator(), owner, "share operator == deployer");

        // Boardroom: operator = Treasury (stays).
        assertEq(boardroom.operator(), address(treasury), "boardroom operator == treasury");

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
        money.transferOwnership(address(timelock));
        estate.transferOwnership(address(timelock));
        trustnote.transferOwnership(address(timelock));

        // Stage 2b: single-step operator rotation.
        treasury.setOperator(address(timelock));
        genesisRewardPool.setOperator(address(timelock));
        mainRewardPool.setOperator(address(timelock));
        shareRewardPool.setOperator(address(timelock));

        // Stage 2c: queue acceptOwnership for each Ownable2Step contract via Timelock.
        timelock.queueTransaction(address(money), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(estate), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(trustnote), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();

        // Mid-ceremony state: pendingOwner == timelock on tokens; operator already rotated.
        assertEq(money.pendingOwner(), address(timelock), "money pendingOwner == timelock");
        assertEq(estate.pendingOwner(), address(timelock), "estate pendingOwner == timelock");
        assertEq(trustnote.pendingOwner(), address(timelock), "trustnote pendingOwner == timelock");
        assertEq(treasury.operator(), address(timelock), "treasury operator == timelock");
        assertEq(genesisRewardPool.operator(), address(timelock), "genesis operator == timelock");
        assertEq(mainRewardPool.operator(), address(timelock), "main operator == timelock");
        assertEq(shareRewardPool.operator(), address(timelock), "share operator == timelock");

        // Cannot execute before eta.
        vm.expectRevert(Timelock.TransactionNotMature.selector);
        vm.prank(owner);
        timelock.executeTransaction(address(money), 0, "acceptOwnership()", bytes(""), eta);

        // Stage 3: wait the delay then execute.
        vm.warp(eta + 1);

        vm.startPrank(owner);
        timelock.executeTransaction(address(money), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(estate), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(trustnote), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();

        // Final state: every Ownable2Step contract has Timelock as owner.
        assertEq(money.owner(), address(timelock), "money owner == timelock");
        assertEq(estate.owner(), address(timelock), "estate owner == timelock");
        assertEq(trustnote.owner(), address(timelock), "trustnote owner == timelock");

        // Trustees on tokens still Treasury (unchanged).
        assertEq(money.trustees(), address(treasury), "money trustees still treasury");
        assertEq(estate.trustees(), address(treasury), "estate trustees still treasury");
        assertEq(trustnote.trustees(), address(treasury), "trustnote trustees still treasury");

        // Boardroom unchanged.
        assertEq(boardroom.operator(), address(treasury), "boardroom operator still treasury");

        // pendingOwner cleared after acceptOwnership.
        assertEq(money.pendingOwner(), address(0), "money pendingOwner cleared");
    }

    // ---------------------------------------------------------------------
    // After ceremony: Timelock can mutate via queue/execute
    // ---------------------------------------------------------------------

    function test_PostCeremony_TimelockCanRotateTrustees() public {
        // Do the full rotation first.
        _doFullRotation();

        // After rotation, Timelock is owner of money. Timelock can call
        // money.transferTrustees(newTrustees) via queue+execute.
        address newTrustees = makeAddr("newTrustees");
        uint256 eta = block.timestamp + TIMELOCK_DELAY + 1;

        bytes memory data = abi.encode(newTrustees);
        vm.prank(owner);
        timelock.queueTransaction(address(money), 0, "transferTrustees(address)", data, eta);

        vm.warp(eta + 1);
        vm.prank(owner);
        timelock.executeTransaction(address(money), 0, "transferTrustees(address)", data, eta);

        assertEq(money.trustees(), newTrustees, "trustees rotated via Timelock");
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
        money.transferOwnership(makeAddr("attempt"));
    }

    // ---------------------------------------------------------------------
    // Reward pools: Timelock can add LP entries via queue/execute
    // ---------------------------------------------------------------------

    function test_PostCeremony_TimelockCanAddRewardPoolEntries() public {
        _doFullRotation();

        // Some stake token to register in the genesis pool.
        IERC20 stakeToken = IERC20(address(estate));

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
        money.transferOwnership(address(timelock));
        estate.transferOwnership(address(timelock));
        trustnote.transferOwnership(address(timelock));
        treasury.setOperator(address(timelock));
        genesisRewardPool.setOperator(address(timelock));
        mainRewardPool.setOperator(address(timelock));
        shareRewardPool.setOperator(address(timelock));
        timelock.queueTransaction(address(money), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(estate), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(trustnote), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();

        vm.warp(eta + 1);
        vm.startPrank(owner);
        timelock.executeTransaction(address(money), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(estate), 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(address(trustnote), 0, "acceptOwnership()", bytes(""), eta);
        vm.stopPrank();
    }
}
