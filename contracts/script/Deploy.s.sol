// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {PegToken} from "../src/tokens/PegToken.sol";
import {ShareToken} from "../src/tokens/ShareToken.sol";
import {BondToken} from "../src/tokens/BondToken.sol";
import {Treasury} from "../src/core/Treasury.sol";
import {Masonry} from "../src/core/Masonry.sol";
import {Oracle} from "../src/oracle/Oracle.sol";
import {PegDefenseHook, PegDefenseHookPermissions} from "../src/hooks/PegDefenseHook.sol";
import {ShareBuybackHook, ShareBuybackHookPermissions, IFireTaxSource} from "../src/hooks/ShareBuybackHook.sol";
import {LpOnlyHook, LpOnlyHookPermissions} from "../src/hooks/LpOnlyHook.sol";
import {NetworkConfig} from "./NetworkConfig.s.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";

import {GenesisRewardPool} from "../src/distribution/GenesisRewardPool.sol";
import {PegFarm} from "../src/distribution/PegFarm.sol";
import {ShareFarm} from "../src/distribution/ShareFarm.sol";
import {V4PositionWrapper} from "../src/distribution/V4PositionWrapper.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MiniSwapRouter} from "../src/swap/MiniSwapRouter.sol";
import {Timelock} from "../src/governance/Timelock.sol";

import {HookMiner} from "../test/utils/HookMiner.sol";

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
 * @notice One-shot Foundry deploy script for the protocol.
 *
 *         The script deploys the three reward pool contracts itself (GenesisRewardPool,
 *         PegFarm, ShareFarm) so the only remaining env-var addresses are
 *         the manifest infrastructure and human-controlled recipient/admin addresses.
 *
 *         See docs/DEPLOY.md for env-var setup and per-chain commands.
 */
contract Deploy is NetworkConfig {
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

    PegToken public peg;
    ShareToken public share;
    BondToken public bond;
    PegDefenseHook public hook;
    ShareBuybackHook public shareBuybackHook;
    Oracle public oracle;
    Treasury public treasury;
    Masonry public masonry;
    GenesisRewardPool public genesisRewardPool;
    PegFarm public pegFarm;
    ShareFarm public shareFarm;
    V4PositionWrapper public lpWrapper;
    LpOnlyHook public pairLpHook;
    V4PositionWrapper public pairLpWrapper;
    MiniSwapRouter public miniSwapRouter;
    Timelock public timelock;
    address public wethAddress;
    PoolKey public poolKey;
    PoolKey public sharePoolKey;
    PoolKey public pairPoolKey;

    /// @notice Static LP fee of the SHARE/WETH pool, in V4 pips (0.30%).
    uint24 public constant SHARE_POOL_FEE = 3000;

    function run() external {
        _network();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        Genesis memory g = _readGenesis();
        _preflight();

        console2.log("=== Protocol deploy ===");
        console2.log("chain id:", block.chainid);
        console2.log("deployer:", deployer);

        vm.startBroadcast(pk);

        wethAddress = _infrastructure("weth");
        console2.log("WETH:", wethAddress);
        _deployTokens(g);
        _deployHookAndInitPool(deployer);
        _deployShareBuybackHookAndInitPool(deployer);
        _deployOracle(g);
        _deployLpWrapper();
        _deployPairLpPool(deployer);
        _deployRewardPools(g);
        _deployCoreAndInit(g);
        miniSwapRouter = new MiniSwapRouter(IPoolManager(_infrastructure("poolManager")));
        timelock = new Timelock(g.timelockAdmin, g.timelockDelay);

        // Genesis distributions go directly to the freshly deployed pool contracts.
        peg.distributeReward(address(genesisRewardPool), address(pegFarm), g.airdropWallet);
        share.distributeReward(address(shareFarm));

        // Register the LP wrapper as the stake token in the Main + Share reward pools.
        // Deployer is still the operator on these pools — handoff to a Timelock happens
        // via the governance ceremony. Sets a single 100-weight entry on each; future
        // ops can call .set() to add more LP types or adjust weights.
        pegFarm.add(100, IERC20(address(lpWrapper)), false, 0);
        shareFarm.add(100, IERC20(address(lpWrapper)), false, 0);

        // Wire Treasury into the hook so the Sprint 4b tax can route PEG there above
        // the burn threshold. Hook trustees defaults to the deployer at construction; the
        // setter is invoked from that role. (autoCalculateTax stays false at deploy —
        // Trustees enables post-launch.)
        hook.setTreasury(address(treasury));
        // Assess the sell tax against the epoch TWAP rather than the pool's spot price.
        hook.setTaxOracle(address(oracle));

        peg.transferTrustees(address(treasury));
        share.transferTrustees(address(treasury));
        bond.transferTrustees(address(treasury));
        masonry.setOperator(address(treasury));

        vm.stopBroadcast();

        _postDeployChecks(g);
        _exportDeployment();
    }

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    function _readGenesis() internal view returns (Genesis memory g) {
        g.airdropWallet = vm.envAddress("AIRDROP_WALLET");
        g.communityFund = vm.envAddress("COMMUNITY_FUND");
        g.devFund = vm.envAddress("DEV_FUND");
        g.vestingStart = vm.envOr("VESTING_START", block.timestamp + 1 hours);
        g.epochStart = vm.envOr("EPOCH_START", g.vestingStart);
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
        peg = new PegToken();
        share = new ShareToken(g.vestingStart, g.communityFund, g.devFund);
        bond = new BondToken();
        console2.log("$PEG:    ", address(peg));
        console2.log("$SHARE:   ", address(share));
        console2.log("$BOND:", address(bond));
    }

    function _deployHookAndInitPool(
        address deployer
    ) internal {
        IPoolManager pm = IPoolManager(_infrastructure("poolManager"));
        bytes memory creationCode =
            abi.encodePacked(type(PegDefenseHook).creationCode, abi.encode(pm, address(peg), deployer));
        uint160 flags = PegDefenseHookPermissions.FLAGS;
        (address mined, bytes32 salt) = HookMiner.find(_infrastructure("create2Deployer"), flags, creationCode);

        // Call the selected factory directly so Foundry's default CREATE2 address
        // cannot disagree with the address used for mining hook permission bits.
        (bool success,) = _infrastructure("create2Deployer").call(abi.encodePacked(salt, creationCode));
        require(success && mined.code.length > 0, "Deploy: hook deployment failed");
        hook = PegDefenseHook(mined);
        console2.log("PegDefenseHook:", address(hook));

        (Currency c0, Currency c1) = address(peg) < wethAddress
            ? (Currency.wrap(address(peg)), Currency.wrap(wethAddress))
            : (Currency.wrap(wethAddress), Currency.wrap(address(peg)));
        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        pm.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));
    }

    /// @notice Deploy the ShareBuybackHook and initialise the SHARE/WETH pool it taxes.
    ///         SHARE sells pay the Fire Tax in WETH; the hook converts that WETH to PEG
    ///         in the PEG/WETH pool above and burns it. Collection starts disabled.
    ///
    ///         `SHARE_POOL_INITIAL_TICK` sets the opening price (WETH per SHARE, in ticks,
    ///         before currency ordering). It defaults to parity; an empty pool's price is
    ///         whatever the first liquidity provider makes it, so this is only a starting
    ///         point.
    function _deployShareBuybackHookAndInitPool(
        address deployer
    ) internal {
        IPoolManager pm = IPoolManager(_infrastructure("poolManager"));
        bytes memory creationCode = abi.encodePacked(
            type(ShareBuybackHook).creationCode,
            abi.encode(
                pm,
                address(share),
                address(peg),
                poolKey,
                IFireTaxSource(address(hook)),
                IPriceSource(address(hook)),
                deployer
            )
        );
        (address mined, bytes32 salt) =
            HookMiner.find(_infrastructure("create2Deployer"), ShareBuybackHookPermissions.FLAGS, creationCode);
        (bool success,) = _infrastructure("create2Deployer").call(abi.encodePacked(salt, creationCode));
        require(success && mined.code.length > 0, "Deploy: share hook deployment failed");
        shareBuybackHook = ShareBuybackHook(mined);
        console2.log("ShareBuybackHook:", address(shareBuybackHook));

        bool shareIsCurrency0 = address(share) < wethAddress;
        (Currency c0, Currency c1) = shareIsCurrency0
            ? (Currency.wrap(address(share)), Currency.wrap(wethAddress))
            : (Currency.wrap(wethAddress), Currency.wrap(address(share)));
        sharePoolKey = PoolKey({
            currency0: c0, currency1: c1, fee: SHARE_POOL_FEE, tickSpacing: 60, hooks: IHooks(address(shareBuybackHook))
        });

        int256 priceTick = vm.envOr("SHARE_POOL_INITIAL_TICK", int256(0));
        require(priceTick > -887_000 && priceTick < 887_000, "Deploy: share pool tick out of range");
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 poolTick = shareIsCurrency0 ? int24(priceTick) : -int24(priceTick);
        pm.initialize(sharePoolKey, TickMath.getSqrtPriceAtTick(poolTick));
    }

    function _deployOracle(
        Genesis memory g
    ) internal {
        oracle = new Oracle(IPriceSource(address(hook)), address(peg), wethAddress, 6 hours, g.epochStart);
        console2.log("Oracle:", address(oracle));
    }

    /// @notice Deploy the three reward pools. Each constructor requires
    ///         block.timestamp < _poolStartTime, so:
    ///           - GenesisRewardPool opens at epochStart (24h window).
    ///           - PegFarm opens at epochStart + 1 day (genesis closes first).
    ///           - ShareFarm opens at epochStart + 1 day (concurrent with main).
    /// @notice Deploy the V4 position wrapper for the PEG/WETH pool. Full-range LP
    ///         positions on this pool wrap into ERC-20 shares that can be staked in
    ///         PegFarm + ShareFarm.
    function _deployLpWrapper() internal {
        int24 tickLower = TickMath.minUsableTick(60);
        int24 tickUpper = TickMath.maxUsableTick(60);
        lpWrapper = new V4PositionWrapper(
            IPositionManager(_infrastructure("positionManager")),
            poolKey,
            tickLower,
            tickUpper,
            "LEVEL-WETH LP",
            "LEVEL-WETH-LP"
        );
        console2.log("V4PositionWrapper (PEG/WETH full-range):", address(lpWrapper));
        console2.log("  tickLower:", int256(tickLower));
        console2.log("  tickUpper:", int256(tickUpper));
    }

    /// @notice Deploy the untradeable PEG/SHARE pool and the wrapper that turns its
    ///         full-range position into a stakeable ERC-20. The LpOnlyHook rejects every
    ///         swap, so the pool is a staking position and never a route between the two
    ///         tokens around the sell tax.
    ///
    ///         With no trading the opening ratio is permanent. `PAIR_POOL_INITIAL_TICK`
    ///         sets it as PEG per SHARE in ticks and defaults to 0 (one for one). Only
    ///         the deployer can initialise the pool. The wrapper is NOT registered with any
    ///         reward pool here: emissions weights are an operator decision.
    function _deployPairLpPool(
        address deployer
    ) internal {
        IPoolManager pm = IPoolManager(_infrastructure("poolManager"));
        bytes memory creationCode =
            abi.encodePacked(type(LpOnlyHook).creationCode, abi.encode(pm, address(peg), address(share), deployer));
        (address mined, bytes32 salt) =
            HookMiner.find(_infrastructure("create2Deployer"), LpOnlyHookPermissions.FLAGS, creationCode);
        (bool success,) = _infrastructure("create2Deployer").call(abi.encodePacked(salt, creationCode));
        require(success && mined.code.length > 0, "Deploy: pair LP hook deployment failed");
        pairLpHook = LpOnlyHook(mined);
        console2.log("LpOnlyHook (PEG/SHARE):", address(pairLpHook));

        bool shareIsCurrency0 = address(share) < address(peg);
        (Currency c0, Currency c1) = shareIsCurrency0
            ? (Currency.wrap(address(share)), Currency.wrap(address(peg)))
            : (Currency.wrap(address(peg)), Currency.wrap(address(share)));
        pairPoolKey =
            PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(address(pairLpHook))});

        int256 ratioTick = vm.envOr("PAIR_POOL_INITIAL_TICK", int256(0));
        require(ratioTick > -887_000 && ratioTick < 887_000, "Deploy: pair pool tick out of range");
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 poolTick = shareIsCurrency0 ? int24(ratioTick) : -int24(ratioTick);
        pm.initialize(pairPoolKey, TickMath.getSqrtPriceAtTick(poolTick));

        pairLpWrapper = new V4PositionWrapper(
            IPositionManager(_infrastructure("positionManager")),
            pairPoolKey,
            TickMath.minUsableTick(60),
            TickMath.maxUsableTick(60),
            "LEVEL-SQUARE LP",
            "LEVEL-SQUARE-LP"
        );
        console2.log("V4PositionWrapper (PEG/SHARE full-range):", address(pairLpWrapper));
    }

    function _deployRewardPools(
        Genesis memory g
    ) internal {
        genesisRewardPool = new GenesisRewardPool(address(peg), g.epochStart);
        pegFarm = new PegFarm(address(peg), g.epochStart + 1 days);
        shareFarm = new ShareFarm(address(share), g.epochStart + 1 days);
        console2.log("GenesisRewardPool:", address(genesisRewardPool));
        console2.log("PegFarm:   ", address(pegFarm));
        console2.log("ShareFarm:  ", address(shareFarm));
    }

    function _deployCoreAndInit(
        Genesis memory g
    ) internal {
        treasury = new Treasury();
        masonry = new Masonry();
        masonry.initialize(IERC20(address(peg)), IERC20(address(share)), ITreasury(address(treasury)));

        // Pools + airdrop wallet are the addresses that hold un-emitted PEG; they
        // must be excluded from `getPegCirculatingSupply` so the contraction-headroom
        // math doesn't count them as circulating.
        address[] memory excluded = new address[](3);
        excluded[0] = address(genesisRewardPool);
        excluded[1] = address(pegFarm);
        excluded[2] = g.airdropWallet;
        treasury.initialize(
            address(peg), address(bond), address(share), address(oracle), address(masonry), g.epochStart, excluded
        );
        console2.log("Treasury: ", address(treasury));
        console2.log("Masonry:", address(masonry));
    }

    /// @notice Simulation output only. Publish after confirming broadcast receipts.
    function _exportDeployment() internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "peg", address(peg));
        vm.serializeAddress(key, "share", address(share));
        vm.serializeAddress(key, "bond", address(bond));
        vm.serializeAddress(key, "treasury", address(treasury));
        vm.serializeAddress(key, "masonry", address(masonry));
        vm.serializeAddress(key, "oracle", address(oracle));
        vm.serializeAddress(key, "hook", address(hook));
        vm.serializeAddress(key, "shareBuybackHook", address(shareBuybackHook));
        vm.serializeAddress(key, "lpWrapper", address(lpWrapper));
        vm.serializeAddress(key, "pairLpHook", address(pairLpHook));
        vm.serializeAddress(key, "pairLpWrapper", address(pairLpWrapper));
        vm.serializeAddress(key, "genesisRewardPool", address(genesisRewardPool));
        vm.serializeAddress(key, "pegFarm", address(pegFarm));
        vm.serializeAddress(key, "shareFarm", address(shareFarm));
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
        require(peg.operator() == address(treasury), "Deploy: peg operator");
        require(share.operator() == address(treasury), "Deploy: share operator");
        require(bond.operator() == address(treasury), "Deploy: bond operator");
        require(masonry.operator() == address(treasury), "Deploy: masonry operator");
        require(hook.bound(), "Deploy: hook not bound");
        require(shareBuybackHook.bound(), "Deploy: share hook not bound");
        require(
            shareBuybackHook.share() == address(share) && shareBuybackHook.peg() == address(peg)
                && shareBuybackHook.quote() == wethAddress,
            "Deploy: share hook tokens"
        );
        require(address(shareBuybackHook.fireTax()) == address(hook), "Deploy: share hook rate source");
        require(!shareBuybackHook.taxEnabled(), "Deploy: share tax must start disabled");
        require(pairLpHook.bound(), "Deploy: pair LP pool not initialised");
        require(pairLpHook.tokenA() == address(peg) && pairLpHook.tokenB() == address(share), "Deploy: pair LP tokens");
        require(treasury.isInitialized(), "Deploy: treasury not initialized");

        require(peg.balanceOf(address(genesisRewardPool)) == 11_000 ether, "Deploy: genesis funding mismatch");
        require(peg.balanceOf(address(pegFarm)) == 140_000 ether, "Deploy: main funding mismatch");
        // Airdrop wallet may already hold PEG (e.g., the 1-unit constructor seed if the
        // wallet happens to equal the deployer in a dry-run). Assert at least the 9k landed.
        require(peg.balanceOf(g.airdropWallet) >= 9000 ether, "Deploy: airdrop funding mismatch");
        require(share.balanceOf(address(shareFarm)) == 59_500 ether, "Deploy: share funding mismatch");

        console2.log("\n=== POST-DEPLOY SANITY ===");
        console2.log("GenesisRewardPool PEG:", peg.balanceOf(address(genesisRewardPool)));
        console2.log("PegFarm PEG:   ", peg.balanceOf(address(pegFarm)));
        console2.log("airdropWallet PEG:    ", peg.balanceOf(g.airdropWallet));
        console2.log("ShareFarm SHARE: ", share.balanceOf(address(shareFarm)));
        console2.log("\nNext steps (post-deploy):");
        console2.log("  1. operator (deployer) calls genesisRewardPool.add(allocPoint, WETH, false, 0)");
        console2.log("     and/or .add(..., USDC, ...) to open the genesis pool for stakers.");
        console2.log("  2. Main + Share reward pools are already wired with V4PositionWrapper as the");
        console2.log("     LP stake token (100 weight each). LPs mint a full-range PEG/WETH V4");
        console2.log("     position, wrap it, and stake the ERC-20 shares.");
        console2.log("  3. Seed initial V4 pool liquidity (manual step before genesis opens).");
        console2.log("  4. Rotate governance to the deployed Timelock using the governance scripts.");
    }
}
