// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NetworkConfig} from "../../script/NetworkConfig.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployMasonryComponent} from "../../script/DeployMasonryComponent.s.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";

contract ConfigHarness is NetworkConfig {
    uint256 public index;

    function selectIndex(
        uint256 value
    ) external {
        index = value;
    }

    function _networkIndex() internal view override returns (uint256) {
        return index;
    }

    function infrastructure(
        string memory key
    ) external view returns (address) {
        return _infrastructure(key);
    }

    function deployment(
        string memory key
    ) external view returns (address) {
        return _deployment(key);
    }

    function preflight() external view {
        _preflight();
    }
}

contract ConfigDeployHarness is Deploy {
    uint256 internal index;
    address internal manager;

    constructor(
        uint256 index_,
        address manager_
    ) {
        index = index_;
        manager = manager_;
    }

    function _networkIndex() internal view override returns (uint256) {
        return index;
    }

    function _createXCodeHash() internal pure override returns (bytes32) {
        return keccak256(type(ConfigTestFactory).runtimeCode);
    }

    function _infrastructure(
        string memory key
    ) internal view override returns (address) {
        if (keccak256(bytes(key)) == keccak256("poolManager")) return manager;
        return super._infrastructure(key);
    }
}

contract ConfigMasonryDeployHarness is DeployMasonryComponent {
    function _createXCodeHash() internal pure override returns (bytes32) {
        return keccak256(type(ConfigTestFactory).runtimeCode);
    }
}

/// @dev Minimal CREATE3 double. The bridge fork suite exercises the actual CreateX factory.
contract ConfigTestFactory {
    function computeCreate3Address(
        bytes32 salt
    ) public view returns (address) {
        address proxy = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", address(this), salt, keccak256(hex"67363d3d37363d34f03d5260086018f3"))
                    )
                )
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
    }

    function deployCreate3(
        bytes32 rawSalt,
        bytes calldata initCode
    ) external returns (address deployed) {
        require(address(bytes20(rawSalt)) == msg.sender && rawSalt[20] == 0, "invalid sender salt");
        bytes32 salt = keccak256(abi.encode(msg.sender, rawSalt));
        bytes memory proxyInit = hex"67363d3d37363d34f03d5260086018f3";
        address proxy;
        assembly ("memory-safe") {
            proxy := create2(0, add(proxyInit, 32), mload(proxyInit), salt)
        }
        require(proxy != address(0), "proxy deployment failed");
        (bool success,) = proxy.call(initCode);
        deployed = computeCreate3Address(salt);
        require(success && deployed.code.length != 0, "factory failed");
    }
}

contract NetworkConfigTest is Test {
    ConfigHarness internal config;
    address internal constant WETH = address(0x1111);
    address internal constant MANAGER = address(0x1112);
    address internal constant POSITIONS = address(0x1113);
    address internal constant PERMIT = address(0x1114);
    address internal constant FACTORY = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

    function setUp() public {
        vm.setEnv("PROTOCOL_CONFIG", "./test/fixtures/networks.json");
        vm.chainId(777);
        vm.warp(1_700_000_000);
        config = new ConfigHarness();
        for (uint160 i = 0x1111; i <= 0x1116; ++i) {
            vm.etch(address(i), hex"00");
        }
        vm.mockCall(WETH, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.mockCall(POSITIONS, abi.encodeWithSignature("poolManager()"), abi.encode(MANAGER));
        vm.mockCall(POSITIONS, abi.encodeWithSignature("permit2()"), abi.encode(PERMIT));
    }

    function test_ArbitraryConfiguredChain() public view {
        assertEq(config.infrastructure("weth"), WETH);
        assertEq(config.deployment("treasury"), MANAGER);
        config.preflight();
    }

    function test_RejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(NetworkConfig.WrongChain.selector, 777, 1));
        config.preflight();
    }

    function test_SelectsSecondChain() public {
        config.selectIndex(1);
        vm.chainId(888);
        config.preflight();
    }

    function test_RejectsMissingDependencyCode() public {
        vm.etch(MANAGER, hex"");
        vm.expectRevert(abi.encodeWithSelector(NetworkConfig.InvalidInfrastructure.selector, "poolManager", MANAGER));
        config.preflight();
    }

    function test_RejectsNon18DecimalPeg() public {
        vm.mockCall(WETH, abi.encodeWithSignature("decimals()"), abi.encode(uint8(6)));
        vm.expectRevert(abi.encodeWithSelector(NetworkConfig.InvalidPegDecimals.selector, 6));
        config.preflight();
    }

    function test_RejectsWrongPoolManagerBinding() public {
        vm.mockCall(POSITIONS, abi.encodeWithSignature("poolManager()"), abi.encode(address(99)));
        vm.expectRevert(NetworkConfig.IncompatiblePositionManager.selector);
        config.preflight();
    }

    function test_RejectsWrongPermitBinding() public {
        vm.mockCall(POSITIONS, abi.encodeWithSignature("permit2()"), abi.encode(address(99)));
        vm.expectRevert(NetworkConfig.IncompatiblePositionManager.selector);
        config.preflight();
    }

    function test_RejectsDeploymentWithoutCode() public {
        vm.etch(MANAGER, hex"");
        vm.expectRevert("Config: invalid deployment address");
        config.deployment("treasury");
    }

    function test_FullDeployOnArbitraryChain() public {
        _deployAndAssert();
    }

    function test_FullDeployOnSecondArbitraryChain() public {
        vm.chainId(888);
        _deployAndAssert();
    }

    function test_DeployMasonryComponentWithCustomAddress() public {
        vm.etch(FACTORY, address(new ConfigTestFactory()).code);
        vm.deal(vm.addr(1), 100 ether);
        bytes memory initCode = abi.encodePacked(type(MasonryGenesisSchedule).creationCode, abi.encode(0, vm.addr(1)));
        address expected = 0xC1e16e56c5f5075D3b0E35508f518CBFec035683;
        string memory path = "./deployment-output/masonry-vanity-test.json";
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":777,"factory":"',
                vm.toString(FACTORY),
                '","deployer":"',
                vm.toString(vm.addr(1)),
                '","releaseId":"0x9999999999999999999999999999999999999999999999999999999999999999"',
                ',"addressNonces":{"masonryGenesisSchedule":399},"addresses":{"masonryGenesisSchedule":"',
                vm.toString(expected),
                '"},"initCodeHashes":{"masonryGenesisSchedule":"',
                vm.toString(keccak256(initCode)),
                '"}}'
            )
        );
        vm.setEnv("MASONRY_CREATE3_CONFIG", path);
        ConfigMasonryDeployHarness deploy = new ConfigMasonryDeployHarness();
        assertEq(deploy.run("masonryGenesisSchedule", initCode), expected);
        assertEq(MasonryGenesisSchedule(expected).scheduler(), vm.addr(1));
        vm.removeFile(path);
    }

    function _deployAndAssert() internal {
        // Real V4 pool initialization and hook binding; peripheral views are mocked.
        address realManager = address(new PoolManager(address(this)));
        vm.mockCall(POSITIONS, abi.encodeWithSignature("poolManager()"), abi.encode(realManager));
        vm.etch(FACTORY, address(new ConfigTestFactory()).code);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "1");
        vm.setEnv("VESTING_START", vm.toString(block.timestamp + 1 hours));
        vm.setEnv("EPOCH_START", vm.toString(block.timestamp + 1 hours));
        vm.setEnv("AIRDROP_WALLET", vm.toString(address(0xBEEF)));
        vm.setEnv("COMMUNITY_FUND", vm.toString(address(0xCAFE)));
        vm.setEnv("DEV_FUND", vm.toString(address(0xF00D)));
        vm.setEnv("TIMELOCK_ADMIN", vm.toString(address(0xABCD)));
        vm.deal(vm.addr(1), 100 ether);
        Deploy deploy = new ConfigDeployHarness(block.chainid == 777 ? 0 : 1, realManager);
        deploy.run();
        assertTrue(deploy.hook().bound());
        assertEq(deploy.hook().trustees(), vm.addr(1));
        assertEq(uint160(address(deploy.hook())) & 0x3FFF, 0x1088);
        assertEq(deploy.money().operator(), address(deploy.treasury()));
        assertEq(deploy.money().owner(), vm.addr(1));
        assertEq(deploy.estate().owner(), vm.addr(1));
        assertEq(deploy.oracle().owner(), vm.addr(1));
        assertEq(deploy.genesisRewardPool().operator(), vm.addr(1));
        assertEq(deploy.money().balanceOf(address(deploy.genesisRewardPool())), 11_000 ether);
        assertEq(deploy.estate().balanceOf(address(deploy.shareRewardPool())), 59_500 ether);
        assertEq(deploy.timelock().admin(), address(0xABCD));
        assertEq(address(deploy.miniSwapRouter().poolManager()), realManager);
        string memory file = string.concat("./deployment-output/", vm.toString(block.chainid), ".json");
        string memory output = vm.readFile(file);
        assertEq(vm.parseJsonUint(output, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(output, ".hook"), address(deploy.hook()));
        if (block.chainid == 888) {
            assertEq(address(deploy.money()), 0xa4a44dD904abd86FD03B5398859CFCA0Ef68056d);
        }
        vm.removeFile(file);
    }
}
