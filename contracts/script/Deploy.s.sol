// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {PegToken} from "../src/tokens/PegToken.sol";
import {ShareToken, ShareTokenProfiles} from "../src/tokens/ShareToken.sol";
import {TrustNote} from "../src/tokens/TrustNote.sol";
import {Treasury} from "../src/core/Treasury.sol";
import {Boardroom} from "../src/core/Boardroom.sol";
import {Oracle} from "../src/oracle/Oracle.sol";
import {PegDefenseHook} from "../src/hooks/PegDefenseHook.sol";
import {NetworkConfig} from "./NetworkConfig.s.sol";
import {Create3Config} from "./Create3Config.s.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";

import {GenesisRewardPool} from "../src/distribution/GenesisRewardPool.sol";
import {MainRewardPool} from "../src/distribution/MainRewardPool.sol";
import {ShareRewardPool} from "../src/distribution/ShareRewardPool.sol";
import {V4PositionWrapper} from "../src/distribution/V4PositionWrapper.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MiniSwapRouter} from "../src/swap/MiniSwapRouter.sol";
import {Timelock} from "../src/governance/Timelock.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/**
 * @title Deploy
 * @notice One-shot Foundry deploy script for the inherited WETH-based protocol.
 *
 *         The script deploys the three reward pool contracts itself (GenesisRewardPool,
 *         MainRewardPool, ShareRewardPool) so the only remaining env-var addresses are
 *         the manifest infrastructure and human-controlled recipient/admin addresses.
 *
 *         See docs/DEPLOY.md for env-var setup and per-chain commands.
 */
contract Deploy is NetworkConfig, Create3Config {
    using PoolIdLibrary for PoolKey;

    struct Genesis {
        address airdropWallet;
        address communityFund;
        address devFund;
        uint256 vestingStart;
        uint256 epochStart;
        address timelockAdmin;
        uint256 timelockDelay;
    }

    Create3Plan private _plan;
    mapping(string role => address expected) private _expected;
    mapping(string role => uint256 nonce) private _nonces;

    PegToken public money;
    ShareToken public estate;
    TrustNote public trustnote;
    PegDefenseHook public hook;
    Oracle public oracle;
    Treasury public treasury;
    Boardroom public boardroom;
    GenesisRewardPool public genesisRewardPool;
    MainRewardPool public mainRewardPool;
    ShareRewardPool public shareRewardPool;
    V4PositionWrapper public lpWrapper;
    MiniSwapRouter public miniSwapRouter;
    Timelock public timelock;
    address public wethAddress;
    PoolKey public poolKey;

    function run() external {
        (string memory json, string memory path) = _network();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        Genesis memory g = _readGenesis();
        _preflight();
        _loadPlan(json, string.concat(path, ".create3"), deployer);

        console2.log("=== Legacy WETH protocol deploy ===");
        console2.log("chain id:", block.chainid);
        console2.log("deployer:", deployer);

        vm.startBroadcast(pk);

        wethAddress = _infrastructure("weth");
        console2.log("WETH:", wethAddress);
        _deployTokens(g);
        _deployHookAndInitPool(deployer);
        _deployOracle(g);
        _deployLpWrapper();
        _deployRewardPools(g);
        _deployCoreAndInit(g);
        miniSwapRouter = MiniSwapRouter(
            payable(_deploy(
                    "miniSwapRouter",
                    abi.encodePacked(type(MiniSwapRouter).creationCode, abi.encode(_infrastructure("poolManager")))
                ))
        );
        timelock = Timelock(
            payable(_deploy(
                    "timelock",
                    abi.encodePacked(type(Timelock).creationCode, abi.encode(g.timelockAdmin, g.timelockDelay))
                ))
        );

        // Genesis distributions go directly to the freshly deployed pool contracts.
        money.distributeReward(address(genesisRewardPool), address(mainRewardPool), g.airdropWallet);
        estate.distributeReward(address(shareRewardPool));

        // Register the LP wrapper as the stake token in the Main + Share reward pools.
        // Deployer is still the operator on these pools — handoff to a Timelock happens
        // via the governance ceremony. Sets a single 100-weight entry on each; future
        // ops can call .set() to add more LP types or adjust weights.
        mainRewardPool.add(100, IERC20(address(lpWrapper)), false, 0);
        shareRewardPool.add(100, IERC20(address(lpWrapper)), false, 0);

        // Wire Treasury into the hook so the Sprint 4b tax can route MONEY there above
        // the burn threshold. Hook trustees defaults to the deployer at construction; the
        // setter is invoked from that role. (autoCalculateTax stays false at deploy —
        // Trustees enables post-launch.)
        hook.setTreasury(address(treasury));

        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));

        vm.stopBroadcast();

        _postDeployChecks(g);
        _exportDeployment();
    }

    function _loadPlan(
        string memory json,
        string memory path,
        address deployer
    ) private {
        _plan = _readCreate3(json, path);
        if (_plan.deployer != deployer) revert InvalidCreate3Plan();
        _nonces["hook"] = vm.parseJsonUint(json, string.concat(path, ".hookNonce"));
        string[13] memory roles = [
            "money",
            "estate",
            "trustNote",
            "treasury",
            "boardroom",
            "oracle",
            "hook",
            "lpWrapper",
            "genesisRewardPool",
            "mainRewardPool",
            "shareRewardPool",
            "miniSwapRouter",
            "timelock"
        ];
        for (uint256 i; i < roles.length; ++i) {
            string memory role = roles[i];
            if (keccak256(bytes(role)) != keccak256("hook")) _nonces[role] = _addressNonce(json, path, role);
            address expected = vm.parseJsonAddress(json, string.concat(path, ".addresses.", role));
            address predicted = _create3Address(_plan, role, _nonces[role]);
            if (expected != predicted) revert UnexpectedCreate3Address(role, expected, predicted);
            if (expected.code.length != 0 || vm.getNonce(expected) != 0) revert Create3AddressOccupied(expected);
            _expected[role] = expected;
        }
        uint160 flags =
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        if (uint160(_expected["hook"]) & Hooks.ALL_HOOK_MASK != flags) revert InvalidCreate3Plan();
    }

    function _deploy(
        string memory role,
        bytes memory initcode
    ) private returns (address) {
        return _deployCreate3(_plan, role, _nonces[role], _expected[role], initcode);
    }

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    function _readGenesis() internal view returns (Genesis memory g) {
        g.airdropWallet = vm.envAddress("AIRDROP_WALLET");
        g.communityFund = vm.envAddress("COMMUNITY_FUND");
        g.devFund = vm.envAddress("DEV_FUND");
        g.vestingStart = vm.envUint("VESTING_START");
        g.epochStart = vm.envUint("EPOCH_START");
        g.timelockAdmin = vm.envAddress("TIMELOCK_ADMIN");
        g.timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(1 days));
        require(
            g.airdropWallet != address(0) && g.communityFund != address(0) && g.devFund != address(0),
            "Deploy: zero wallet"
        );
        require(g.timelockAdmin != address(0), "Deploy: zero admin");
        require(g.epochStart > block.timestamp && g.vestingStart > block.timestamp, "Deploy: start must be future");
        require(g.timelockDelay >= 1 days && g.timelockDelay <= 30 days, "Deploy: invalid timelock delay");
    }

    function _deployTokens(
        Genesis memory g
    ) internal {
        money = PegToken(_deploy("money", abi.encodePacked(type(PegToken).creationCode, abi.encode(_plan.deployer))));
        estate = ShareToken(
            _deploy(
                "estate",
                abi.encodePacked(
                    type(ShareToken).creationCode,
                    abi.encode(
                        ShareTokenProfiles.legacy(g.vestingStart, g.communityFund, g.devFund, _plan.deployer),
                        _plan.deployer
                    )
                )
            )
        );
        trustnote =
            TrustNote(_deploy("trustNote", abi.encodePacked(type(TrustNote).creationCode, abi.encode(_plan.deployer))));
        console2.log("$MONEY:    ", address(money));
        console2.log("$ESTATE:   ", address(estate));
        console2.log("$TRUSTNOTE:", address(trustnote));
    }

    function _deployHookAndInitPool(
        address deployer
    ) internal {
        IPoolManager pm = IPoolManager(_infrastructure("poolManager"));
        bytes memory creationCode =
            abi.encodePacked(type(PegDefenseHook).creationCode, abi.encode(pm, address(money), deployer));
        hook = PegDefenseHook(_deploy("hook", creationCode));
        console2.log("PegDefenseHook:", address(hook));

        (Currency c0, Currency c1) = address(money) < wethAddress
            ? (Currency.wrap(address(money)), Currency.wrap(wethAddress))
            : (Currency.wrap(wethAddress), Currency.wrap(address(money)));
        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        pm.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));
    }

    function _deployOracle(
        Genesis memory g
    ) internal {
        oracle = Oracle(
            _deploy(
                "oracle",
                abi.encodePacked(
                    type(Oracle).creationCode,
                    abi.encode(address(hook), address(money), wethAddress, 6 hours, g.epochStart, _plan.deployer)
                )
            )
        );
        console2.log("Oracle:", address(oracle));
    }

    /// @notice Deploy the three reward pools. Each constructor requires
    ///         block.timestamp < _poolStartTime, so:
    ///           - GenesisRewardPool opens at epochStart (24h window).
    ///           - MainRewardPool opens at epochStart + 1 day (genesis closes first).
    ///           - ShareRewardPool opens at epochStart + 1 day (concurrent with main).
    /// @notice Deploy the V4 position wrapper for the MONEY/WETH pool. Full-range LP
    ///         positions on this pool wrap into ERC-20 shares that can be staked in
    ///         MainRewardPool + ShareRewardPool.
    function _deployLpWrapper() internal {
        int24 tickLower = TickMath.minUsableTick(60);
        int24 tickUpper = TickMath.maxUsableTick(60);
        lpWrapper = V4PositionWrapper(
            _deploy(
                "lpWrapper",
                abi.encodePacked(
                    type(V4PositionWrapper).creationCode,
                    abi.encode(
                        _infrastructure("positionManager"),
                        poolKey,
                        tickLower,
                        tickUpper,
                        "Old Money MONEY-WETH LP",
                        "om-MWLP"
                    )
                )
            )
        );
        console2.log("V4PositionWrapper (MONEY/WETH full-range):", address(lpWrapper));
        console2.log("  tickLower:", int256(tickLower));
        console2.log("  tickUpper:", int256(tickUpper));
    }

    function _deployRewardPools(
        Genesis memory g
    ) internal {
        genesisRewardPool = GenesisRewardPool(
            _deploy(
                "genesisRewardPool",
                abi.encodePacked(
                    type(GenesisRewardPool).creationCode, abi.encode(address(money), g.epochStart, _plan.deployer)
                )
            )
        );
        mainRewardPool = MainRewardPool(
            _deploy(
                "mainRewardPool",
                abi.encodePacked(
                    type(MainRewardPool).creationCode, abi.encode(address(money), g.epochStart + 1 days, _plan.deployer)
                )
            )
        );
        shareRewardPool = ShareRewardPool(
            _deploy(
                "shareRewardPool",
                abi.encodePacked(
                    type(ShareRewardPool).creationCode,
                    abi.encode(address(estate), g.epochStart + 1 days, _plan.deployer)
                )
            )
        );
        console2.log("GenesisRewardPool:", address(genesisRewardPool));
        console2.log("MainRewardPool:   ", address(mainRewardPool));
        console2.log("ShareRewardPool:  ", address(shareRewardPool));
    }

    function _deployCoreAndInit(
        Genesis memory g
    ) internal {
        treasury =
            Treasury(_deploy("treasury", abi.encodePacked(type(Treasury).creationCode, abi.encode(_plan.deployer))));
        boardroom =
            Boardroom(_deploy("boardroom", abi.encodePacked(type(Boardroom).creationCode, abi.encode(_plan.deployer))));
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        // Pools + airdrop wallet are the addresses that hold un-emitted MONEY; they
        // must be excluded from `getMoneyCirculatingSupply` so the contraction-headroom
        // math doesn't count them as circulating.
        address[] memory excluded = new address[](3);
        excluded[0] = address(genesisRewardPool);
        excluded[1] = address(mainRewardPool);
        excluded[2] = g.airdropWallet;
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            g.epochStart,
            excluded
        );
        console2.log("Treasury: ", address(treasury));
        console2.log("Boardroom:", address(boardroom));
    }

    /// @notice Simulation output only. Publish after confirming broadcast receipts.
    function _exportDeployment() internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "money", address(money));
        vm.serializeAddress(key, "estate", address(estate));
        vm.serializeAddress(key, "trustNote", address(trustnote));
        vm.serializeAddress(key, "treasury", address(treasury));
        vm.serializeAddress(key, "boardroom", address(boardroom));
        vm.serializeAddress(key, "oracle", address(oracle));
        vm.serializeAddress(key, "hook", address(hook));
        vm.serializeAddress(key, "lpWrapper", address(lpWrapper));
        vm.serializeAddress(key, "genesisRewardPool", address(genesisRewardPool));
        vm.serializeAddress(key, "mainRewardPool", address(mainRewardPool));
        vm.serializeAddress(key, "shareRewardPool", address(shareRewardPool));
        vm.serializeAddress(key, "miniSwapRouter", address(miniSwapRouter));
        vm.serializeAddress(key, "timelock", address(timelock));
        vm.serializeAddress(key, "weth", wethAddress);
        vm.serializeAddress(key, "poolManager", _infrastructure("poolManager"));
        vm.serializeAddress(key, "positionManager", _infrastructure("positionManager"));
        vm.serializeAddress(key, "permit2", _infrastructure("permit2"));
        string memory json = vm.serializeAddress(key, "universalRouter", _infrastructure("universalRouter"));
        vm.createDir("./deployment-output", true);
        vm.writeJson(json, string.concat("./deployment-output/", vm.toString(block.chainid), ".json"));
    }

    function _postDeployChecks(
        Genesis memory g
    ) internal view {
        require(money.operator() == address(treasury), "Deploy: money operator");
        require(estate.operator() == address(treasury), "Deploy: estate operator");
        require(trustnote.operator() == address(treasury), "Deploy: trustnote operator");
        require(boardroom.operator() == address(treasury), "Deploy: boardroom operator");
        require(hook.bound(), "Deploy: hook not bound");
        require(treasury.isInitialized(), "Deploy: treasury not initialized");

        require(money.balanceOf(address(genesisRewardPool)) == 11_000 ether, "Deploy: genesis funding mismatch");
        require(money.balanceOf(address(mainRewardPool)) == 140_000 ether, "Deploy: main funding mismatch");
        // Airdrop wallet may already hold MONEY (e.g., the 1-unit constructor seed if the
        // wallet happens to equal the deployer in a dry-run). Assert at least the 9k landed.
        require(money.balanceOf(g.airdropWallet) >= 9000 ether, "Deploy: airdrop funding mismatch");
        require(estate.balanceOf(address(shareRewardPool)) == 59_500 ether, "Deploy: share funding mismatch");

        console2.log("\n=== POST-DEPLOY SANITY ===");
        console2.log("GenesisRewardPool MONEY:", money.balanceOf(address(genesisRewardPool)));
        console2.log("MainRewardPool MONEY:   ", money.balanceOf(address(mainRewardPool)));
        console2.log("airdropWallet MONEY:    ", money.balanceOf(g.airdropWallet));
        console2.log("ShareRewardPool ESTATE: ", estate.balanceOf(address(shareRewardPool)));
        console2.log("\nNext steps (post-deploy):");
        console2.log("  1. operator (deployer) calls genesisRewardPool.add(allocPoint, WETH, false, 0)");
        console2.log("     and/or .add(..., USDC, ...) to open the genesis pool for stakers.");
        console2.log("  2. Main + Share reward pools are already wired with V4PositionWrapper as the");
        console2.log("     LP stake token (100 weight each). LPs mint a full-range MONEY/WETH V4");
        console2.log("     position, wrap it, and stake the ERC-20 shares.");
        console2.log("  3. Seed initial V4 pool liquidity (manual step before genesis opens).");
        console2.log("  4. Rotate governance to the deployed Timelock using the governance scripts.");
    }
}
