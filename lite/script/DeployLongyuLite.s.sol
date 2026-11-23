// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {XLiteToken, XTombLiteMasonry} from "../src/XTombLite.sol";
import {LiteManualTestOracle} from "../src/LiteManualTestOracle.sol";

interface VmLite {
    function envAddress(string calldata key) external returns (address);
    function envUint(string calldata key) external returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

interface ILiteV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

/// @notice Testnet smoke deployment only. NOT a production DeFi launch.
/// @dev Run with forge script ... --rpc-url LONGYU_TESTNET_RPC --account <funded keystore> --broadcast.
///      No keys stored in source and no mainnet broadcast allowed.
contract DeployXTombLiteLongyu {
    VmLite internal constant vm = VmLite(address(uint160(uint256(keccak256("hevm cheat code")))));

    event LiteDeployment(
        address xtomb, address xshare, address mockUsd,
        address lpPair, address manualOracle, address masonry
    );

    function run() external {
        require(block.chainid == 668801, "LONGYU TESTNET ONLY");
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address arbitrage = vm.envAddress("ARBITRAGE_ADDRESS");
        address factory = vm.envAddress("LONGYU_V2_FACTORY");
        uint256 genesisStart = vm.envUint("GENESIS_START");
        uint256 initialPeg = vm.envUint("TEST_XTOMB_SEED_WEI");
        uint256 initialShare = vm.envUint("TEST_XSHARE_SEED_WEI");
        uint256 testUsdSeed = vm.envUint("TEST_USD_SEED_UNITS");
        require(
            deployer != address(0) && treasury != address(0) && arbitrage != address(0)
            && factory.code.length != 0 && genesisStart > block.timestamp
            && initialPeg > 0 && initialShare <= 333333e18 && testUsdSeed >= 25e6,
            "bad pilot settings"
        );

        vm.startBroadcast();
        XLiteToken peg = new XLiteToken("xTOMB Testnet", "xTOMB", 18, type(uint256).max, deployer);
        XLiteToken share = new XLiteToken("xSHARE Testnet", "xSHARE", 18, 333333e18, deployer);
        XLiteToken usd = new XLiteToken("MockUSD TEST ONLY", "mUSD", 6, 1e18, deployer);
        peg.mint(deployer, initialPeg);
        if (initialShare > 0) share.mint(deployer, initialShare);
        usd.mint(deployer, testUsdSeed);

        ILiteV2Factory dex = ILiteV2Factory(factory);
        address lp = dex.getPair(address(peg), address(share));
        if (lp == address(0)) lp = dex.createPair(address(peg), address(share));
        require(lp.code.length != 0, "no pair code");

        // The manual oracle starts at ZERO. Epoch advancement fails closed until test price set.
        LiteManualTestOracle oracle = new LiteManualTestOracle(deployer);
        XTombLiteMasonry masonry = new XTombLiteMasonry(
            address(peg), lp, address(usd), address(oracle), address(0),
            treasury, arbitrage, deployer, genesisStart, 25e6
        );
        // One-way mint authorization: AFTER this call, only Masonry can create xTOMB.
        peg.finalizeMinter(address(masonry));
        vm.stopBroadcast();
        emit LiteDeployment(address(peg), address(share), address(usd), lp, address(oracle), address(masonry));
    }
}
