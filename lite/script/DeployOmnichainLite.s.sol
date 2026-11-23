// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {XLiteToken, XTombLiteMasonry, ILiteERC20} from "../src/XTombLite.sol";
import {LiteV2TwapOracle} from "../src/LiteV2TwapOracle.sol";
import {LiteChainlinkUsdSource} from "../src/LiteChainlinkUsdSource.sol";
import {LiteSellTaxController} from "../src/LiteSellTaxController.sol";
import {LiteLiquidityAdapter} from "../src/LiteLiquidityAdapter.sol";
import {LiteLpFarm} from "../src/LiteLpFarm.sol";
import {LiteLinearVesting} from "../src/LiteLinearVesting.sol";

interface VmOmni {
    function envAddress(string calldata key) external returns (address);
    function envUint(string calldata key) external returns (uint256);
    function startBroadcast(address sender) external;
    function stopBroadcast() external;
}
interface IV2FactoryOmni {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}
interface IV2RouterOmni {
    function factory() external view returns (address);
}

/// @notice Config-driven, chain-agnostic testnet deployment of xTomb Lite production-oriented components.
/// @dev NO automatic mainnet launch. An approved 333,333-share allocation is a prerequisite.
///      The script deploys infrastructure but NEVER opens trading or seeds public liquidity.
contract DeployOmnichainLite {
    VmOmni private constant vm = VmOmni(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SHARE_CAP = 333333 ether;
    uint256 private constant BPS = 10000;

    struct Config {
        address deployer;
        address treasury;
        address arbitrage;
        address team;
        address developer;
        address saleEscrow;
        address factory;
        address router;
        address stable;
        address quoteUsdFeed;
        address nativeUsdFeed;
        uint256 genesisStart;
        uint256 farmStart;
        uint256 initialPegSupply;
        uint256 farmPegAllocation;
        uint256 farmShareAllocation;
        uint256 saleAllocation;
        uint256 deployerAllocation;
        uint256[4] upfront;
        uint256[4] vested;
    }

    event OmnichainLiteDeployed(
        uint256 indexed chainId,
        address peg, address share, address masonry,
        address pegStablePool, address shareStablePool, address masonryPool,
        address validatedTwap, address pegFarm, address shareFarm
    );
    event TaxComponents(address pegTax, address shareTax, address pegLiquidityAdapter, address shareLiquidityAdapter);
    event VestingComponents(address team, address developer, address treasury, address arbitrage);

    error ConfigRejected();

    function _read() internal returns (Config memory c) {
        c.deployer = vm.envAddress("DEPLOYER_ADDRESS");
        c.treasury = vm.envAddress("TREASURY_ADDRESS");
        c.arbitrage = vm.envAddress("ARBITRAGE_ADDRESS");
        c.team = vm.envAddress("TEAM_ADDRESS");
        c.developer = vm.envAddress("DEVELOPER_ADDRESS");
        c.saleEscrow = vm.envAddress("SALE_ESCROW_ADDRESS");
        c.factory = vm.envAddress("V2_FACTORY");
        c.router = vm.envAddress("V2_ROUTER");
        c.stable = vm.envAddress("USD_STABLE");
        c.quoteUsdFeed = vm.envAddress("STABLE_USD_FEED");
        c.nativeUsdFeed = vm.envAddress("NATIVE_USD_FEED"); // zero disables native epoch fees.
        c.genesisStart = vm.envUint("GENESIS_START");
        c.farmStart = vm.envUint("FARMS_START");
        c.initialPegSupply = vm.envUint("APPROVED_LEVEL_LAUNCH_WEI");
        c.farmPegAllocation = vm.envUint("SHARE_FARM_LEVEL_LP");
        c.farmShareAllocation = vm.envUint("SHARE_FARM_SHARE_LP");
        c.saleAllocation = vm.envUint("SHARE_SALE_ESCROW");
        c.deployerAllocation = vm.envUint("SHARE_DEPLOYER");
        c.upfront[0] = vm.envUint("SHARE_TEAM_UPFRONT");
        c.upfront[1] = vm.envUint("SHARE_DEV_UPFRONT");
        c.upfront[2] = vm.envUint("SHARE_TREASURY_UPFRONT");
        c.upfront[3] = vm.envUint("SHARE_ARBITRAGE_UPFRONT");
        c.vested[0] = vm.envUint("SHARE_TEAM_VESTED");
        c.vested[1] = vm.envUint("SHARE_DEV_VESTED");
        c.vested[2] = vm.envUint("SHARE_TREASURY_VESTED");
        c.vested[3] = vm.envUint("SHARE_ARBITRAGE_VESTED");

        if (block.chainid != vm.envUint("EXPECTED_CHAIN_ID") ||
            vm.envUint("TESTNET_DEPLOYMENT_APPROVED") != 1 ||
            vm.envUint("ALLOCATION_PLAN_APPROVED") != 1 ||
            vm.envUint("LEVEL_LAUNCH_SUPPLY_APPROVED") != 1 ||
            c.deployer == address(0) || c.treasury == address(0) ||
            c.arbitrage == address(0) || c.team == address(0) ||
            c.developer == address(0) || c.saleEscrow == address(0) ||
            c.factory.code.length == 0 || c.router.code.length == 0 ||
            c.stable.code.length == 0 || c.quoteUsdFeed.code.length == 0 ||
            (c.nativeUsdFeed != address(0) && c.nativeUsdFeed.code.length == 0) ||
            c.genesisStart <= block.timestamp + 2 hours ||
            c.farmStart < c.genesisStart + 7 days ||
            c.initialPegSupply == 0 ||
            IV2RouterOmni(c.router).factory() != c.factory
        ) revert ConfigRejected();

        uint256 sum = c.farmPegAllocation + c.farmShareAllocation +
            c.saleAllocation + c.deployerAllocation;
        for (uint256 i; i < 4; ++i) sum += c.upfront[i] + c.vested[i];
        if (sum != 333333) revert ConfigRejected();
        // This script uses whole xSHARE counts; all values scale by 1e18 at mint.
        if (c.farmPegAllocation == 0 || c.farmShareAllocation == 0) revert ConfigRejected();
    }

    function _ensurePair(address factory, address a, address b) internal returns (address p) {
        IV2FactoryOmni f = IV2FactoryOmni(factory);
        p = f.getPair(a, b);
        if (p == address(0)) p = f.createPair(a, b);
        if (p.code.length == 0) revert ConfigRejected();
    }

    function run() external {
        Config memory c = _read();
        vm.startBroadcast(c.deployer);

        XLiteToken peg = new XLiteToken("xTOMB", "xTOMB", 18, type(uint256).max, c.deployer);
        XLiteToken share = new XLiteToken("xSHARE", "xSHARE", 18, SHARE_CAP, c.deployer);
        peg.mint(c.deployer, c.initialPegSupply);
        share.mint(c.deployer, SHARE_CAP);

        address ps = _ensurePair(c.factory, address(peg), c.stable);
        address ss = _ensurePair(c.factory, address(share), c.stable);
        address xp = _ensurePair(c.factory, address(peg), address(share));

        uint8 quoteDecimals = ILiteERC20(c.stable).decimals();
        // A USD quote reference must be fresh and plausibly near $1 at deployment.
        LiteChainlinkUsdSource stableUsd = new LiteChainlinkUsdSource(c.quoteUsdFeed, 30 minutes);
        (uint256 stablePrice,) = stableUsd.latestPrice();
        if (stablePrice < 0.95e18 || stablePrice > 1.05e18) revert ConfigRejected();
        address nativeSource;
        if (c.nativeUsdFeed != address(0)) {
            nativeSource = address(new LiteChainlinkUsdSource(c.nativeUsdFeed, 30 minutes));
        }

        LiteV2TwapOracle twap = new LiteV2TwapOracle(
            ps, address(peg), c.stable, c.quoteUsdFeed, quoteDecimals,
            uint112(vm.envUint("MIN_PEG_RESERVE_WEI")),
            uint112(vm.envUint("MIN_STABLE_RESERVE_UNITS")),
            30 minutes, 30 minutes, 30 minutes, 500, 10
        );

        LiteLiquidityAdapter pegAdd = new LiteLiquidityAdapter(address(peg), c.stable, ps, c.router, c.factory);
        LiteLiquidityAdapter shareAdd = new LiteLiquidityAdapter(address(share), c.stable, ss, c.router, c.factory);
        LiteLiquidityAdapter masonryAdd = new LiteLiquidityAdapter(address(peg), address(share), xp, c.router, c.factory);
        if (address(masonryAdd) == address(0)) revert ConfigRejected();

        LiteSellTaxController pegTax = new LiteSellTaxController(
            address(peg), ps, address(twap), 1e18,
            100, 1200, 1500, 0, 0, quoteDecimals, uint16(vm.envUint("V2_SWAP_FEE_BPS")), true
        );
        LiteSellTaxController shareTax = new LiteSellTaxController(
            address(share), ss, address(twap), 1e18,
            100, 1200, 1500, 600, uint64(c.genesisStart + 7 days),
            quoteDecimals, uint16(vm.envUint("V2_SWAP_FEE_BPS")), false
        );
        peg.configureTax(ps, address(pegTax), c.treasury, address(pegAdd));
        share.configureTax(ss, address(shareTax), c.treasury, address(shareAdd));

        XTombLiteMasonry masonry = new XTombLiteMasonry(
            block.chainid, address(peg), address(share), xp, c.stable,
            address(twap), address(stableUsd), nativeSource,
            c.treasury, c.arbitrage, c.deployer, c.genesisStart
        );
        peg.finalizeMinter(address(masonry));
        // xSHARE is fully minted and has no ongoing emissions mint authority.
        share.finalizeMinter(address(1));

        LiteLpFarm farmPeg = new LiteLpFarm(ps, address(share), address(twap),
            c.deployer, c.treasury, c.farmStart, 300);
        LiteLpFarm farmShare = new LiteLpFarm(ss, address(share), address(twap),
            c.deployer, c.treasury, c.farmStart, 300);

        address[4] memory beneficiaries = [c.team, c.developer, c.treasury, c.arbitrage];
        address[4] memory vestingContracts;
        for (uint256 i; i < 4; ++i) {
            uint256 up = c.upfront[i] * 1 ether;
            uint256 vested = c.vested[i] * 1 ether;
            if (up + vested == 0) continue;
            LiteLinearVesting vesting = new LiteLinearVesting(
                address(share), beneficiaries[i], c.deployer, uint64(c.genesisStart), 180 days
            );
            share.approve(address(vesting), up + vested);
            vesting.fund(up, vested);
            vestingContracts[i] = address(vesting);
        }

        share.approve(address(farmPeg), c.farmPegAllocation * 1 ether);
        farmPeg.activate(c.farmPegAllocation * 1 ether);
        share.approve(address(farmShare), c.farmShareAllocation * 1 ether);
        farmShare.activate(c.farmShareAllocation * 1 ether);
        if (c.saleAllocation != 0) share.transfer(c.saleEscrow, c.saleAllocation * 1 ether);
        // Remaining allocation stays with the deployer, ONLY as explicitly approved in the plan.
        if (share.balanceOf(c.deployer) != c.deployerAllocation * 1 ether) revert ConfigRejected();
        vm.stopBroadcast();

        emit OmnichainLiteDeployed(block.chainid, address(peg), address(share),
            address(masonry), ps, ss, xp, address(twap), address(farmPeg), address(farmShare));
        emit TaxComponents(address(pegTax), address(shareTax), address(pegAdd), address(shareAdd));
        emit VestingComponents(
            vestingContracts[0], vestingContracts[1], vestingContracts[2], vestingContracts[3]
        );
    }
}
