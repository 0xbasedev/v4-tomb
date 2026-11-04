// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {HookMiner} from "../utils/HookMiner.sol";

import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {Oracle} from "../../src/oracle/Oracle.sol";
import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {HistoricalAddresses as Addresses} from "../fixtures/HistoricalAddresses.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BaseForkHookTest
 * @notice Forks Base mainnet and validates the FULL real-hook deploy path:
 *           1. Mine a CREATE2 salt for PegDefenseHook with the right permission bits.
 *           2. CREATE2-deploy the hook against the real Base V4 PoolManager.
 *           3. Initialize a real MONEY/WETH V4 pool, which fires afterInitialize on
 *              the hook and binds it.
 *           4. Deploy our Oracle pointing to the hook as its IPriceSource.
 *           5. Deploy Treasury and Boardroom against the real Oracle (no MockOracle).
 *           6. Verify the wiring — Oracle reads from hook, Treasury reads from Oracle,
 *              one full no-op epoch ticks correctly.
 *
 *         What this test does NOT do (lives in the deploy script / Sprint 12+):
 *           - Add real liquidity to the pool (would need to source WETH on the fork).
 *           - Run real swaps to drive the hook's observation feed past tick 0.
 *           - Assert price-driven expansion (need real ticks > 0 to trigger expansion).
 *
 *         The test is gated by BASE_RPC_URL — skipped if unset.
 */
contract BaseForkHookTest is BaseTest {
    using PoolIdLibrary for PoolKey;

    PegToken internal money;
    ShareToken internal estate;
    TrustNote internal trustnote;
    Treasury internal treasury;
    Boardroom internal boardroom;
    Oracle internal oracle;
    PegDefenseHook internal hook;
    IPoolManager internal poolManager;
    PoolKey internal poolKey;

    address internal weth;
    address internal genesisPool = makeAddr("genesisPool");
    address internal mainPool = makeAddr("mainPool");
    address internal airdropWallet = makeAddr("airdropWallet");
    address internal farmingPool = makeAddr("farmingPool");
    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");

    uint256 internal startTime;
    bool internal forked;

    function setUp() public override {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(url);
        forked = true;

        super.setUp();

        startTime = block.timestamp + 1 hours;
        poolManager = IPoolManager(Addresses.poolManager());
        weth = Addresses.weth();

        // 1. Deploy tokens.
        money = new PegToken(address(this));
        estate = new ShareToken(startTime, communityFund, devFund, address(this));
        trustnote = new TrustNote(address(this));

        // 2. CREATE2-mine + deploy the PegDefenseHook at an address with the right
        //    permission bits (AFTER_INITIALIZE | BEFORE_SWAP).
        uint160 flags =
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        bytes memory hookCreationCode =
            abi.encodePacked(type(PegDefenseHook).creationCode, abi.encode(poolManager, address(money), address(this)));
        (address minedAddr, bytes32 hookSalt) = HookMiner.find(address(this), flags, hookCreationCode);

        PegDefenseHook deployedHook;
        bytes32 saltLocal = hookSalt;
        bytes memory codeLocal = hookCreationCode;
        assembly {
            deployedHook := create2(0, add(codeLocal, 0x20), mload(codeLocal), saltLocal)
        }
        require(address(deployedHook) == minedAddr, "BaseForkHook: hook addr mismatch");
        hook = deployedHook;

        // 3. Initialize the MONEY/WETH V4 pool with the hook attached. This fires
        //    afterInitialize on the hook.
        (Currency c0, Currency c1) = address(money) < weth
            ? (Currency.wrap(address(money)), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(address(money)));
        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolManager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));

        // 4. Deploy Oracle pointing at the hook as IPriceSource.
        oracle = new Oracle(IPriceSource(address(hook)), address(money), weth, 6 hours, startTime, address(this));

        // 5. Deploy Treasury + Boardroom, init, hand off operator.
        treasury = new Treasury(address(this));
        boardroom = new Boardroom(address(this));
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

        // Launch ceremony Boardroom seed (see docs/GAP_AUDIT.md gap #16):
        // The test contract (deployer) holds 1 ESTATE from ShareToken's constructor mint.
        // Stake a tiny amount in Boardroom so allocateSeigniorage doesn't revert with
        // CannotAllocateWhenTotalSupplyZero when the bootstrap branch fires.
        estate.approve(address(boardroom), 1);
        boardroom.stake(1);

        vm.warp(startTime + 1);
    }

    // ---------------------------------------------------------------------
    // Hook + pool wiring
    // ---------------------------------------------------------------------

    function test_HookAddressHasCorrectPermissionBits() public view {
        uint160 expected =
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        assertEq(
            uint160(address(hook)) & 0x3FFF,
            expected,
            "Hook address must encode AFTER_INIT|BEFORE_SWAP|BEFORE_SWAP_RETURNS_DELTA"
        );
    }

    function test_HookBoundToPoolAfterInitialize() public view {
        assertTrue(hook.bound(), "Hook should be bound after pool init");
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(poolKey.toId()), "Hook poolId should match");
        assertEq(hook.lastTick(), 0, "Initial tick should be 0 (parity)");
        // MONEY orientation: matches whether money sorts as currency0.
        assertEq(hook.moneyIsCurrency0(), address(money) < weth);
    }

    function test_OracleReadsFromHook() public view {
        assertEq(address(oracle.priceSource()), address(hook));
        // Right after init, no swaps have happened. Hook's cumulative is 0 at lastTs.
        (int56 cum, uint32 ts) = hook.getCurrentTickCumulative();
        assertEq(cum, 0);
        assertEq(ts, uint32(block.timestamp));
    }

    function test_OracleConsultReturnsZeroBeforeFirstUpdate() public view {
        // Tomb-faithful: consult returns 0 until update() runs at least once.
        assertEq(oracle.consult(address(money), 1e18), 0);
    }

    function test_OracleTwapReturnsParityAtTickZero() public {
        // twap recomputes from current cumulatives. At tick 0, parity.
        vm.warp(block.timestamp + 1 hours);
        uint256 quote = oracle.twap(address(money), 1e18);
        assertApproxEqAbs(quote, 1e18, 1, "twap at tick 0 should return 1:1");
    }

    function test_AllocateSeigniorageRunsAtParity() public {
        // Advance to next epoch and tick. With Oracle at parity, no expansion fires
        // (price <= ceiling). The check still increments epoch.
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();
        assertEq(treasury.epoch(), 1);
    }

    function test_FullStackInitializedAgainstRealHook() public view {
        assertEq(treasury.money(), address(money));
        assertEq(treasury.oracle(), address(oracle));
        assertEq(money.operator(), address(treasury));
        assertEq(estate.operator(), address(treasury));
        assertEq(trustnote.operator(), address(treasury));
        assertEq(boardroom.operator(), address(treasury));
        assertTrue(treasury.isInitialized());
    }
}
