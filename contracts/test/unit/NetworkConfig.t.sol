// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Test} from "forge-std/Test.sol";
import {NetworkConfig} from "../../script/NetworkConfig.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
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

    function _infrastructure(
        string memory key
    ) internal view override returns (address) {
        if (keccak256(bytes(key)) == keccak256("poolManager")) return manager;
        return super._infrastructure(key);
    }
}

/// @dev Test factory implementing the salt || initCode interface required by Deploy.
contract ConfigTestFactory {
    fallback() external {
        bytes memory initCode = msg.data[32:];
        bytes32 salt = bytes32(msg.data[:32]);
        address created;
        assembly {
            created := create2(0, add(initCode, 32), mload(initCode), salt)
        }
        require(created != address(0), "factory failed");
    }
}

contract NetworkConfigTest is Test {
    ConfigHarness internal config;
    address internal constant WETH = address(0x1111);
    address internal constant MANAGER = address(0x1112);
    address internal constant POSITIONS = address(0x1113);
    address internal constant PERMIT = address(0x1114);
    address internal constant FACTORY = address(0x1116);

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

    function _deployAndAssert() internal {
        // Real V4 pool initialization and hook binding; peripheral views are mocked.
        address realManager = address(new PoolManager(address(this)));
        vm.mockCall(POSITIONS, abi.encodeWithSignature("poolManager()"), abi.encode(realManager));
        vm.etch(FACTORY, address(new ConfigTestFactory()).code);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "1");
        vm.setEnv("AIRDROP_WALLET", vm.toString(address(0xBEEF)));
        vm.setEnv("COMMUNITY_FUND", vm.toString(address(0xCAFE)));
        vm.setEnv("DEV_FUND", vm.toString(address(0xF00D)));
        vm.setEnv("TIMELOCK_ADMIN", vm.toString(address(0xABCD)));
        vm.setEnv("DAO_WALLET", vm.toString(address(0xDA0)));
        vm.setEnv("PEG_NAME", "xTOMB");
        vm.setEnv("PEG_SYMBOL", "xTOMB");
        vm.setEnv("SHARE_NAME", "xSHARE");
        vm.setEnv("SHARE_SYMBOL", "xSHARE");
        vm.deal(vm.addr(1), 100 ether);
        Deploy deploy = new ConfigDeployHarness(block.chainid == 777 ? 0 : 1, realManager);
        deploy.run();
        assertTrue(deploy.hook().bound());
        assertEq(deploy.hook().trustees(), vm.addr(1));
        assertEq(uint160(address(deploy.hook())) & 0x3FFF, 0x10CC);
        assertTrue(deploy.shareBuybackHook().bound());
        assertEq(uint160(address(deploy.shareBuybackHook())) & 0x3FFF, 0x10CC);
        assertEq(deploy.shareBuybackHook().trustees(), vm.addr(1));
        assertEq(deploy.shareBuybackHook().share(), address(deploy.share()));
        assertEq(deploy.shareBuybackHook().peg(), address(deploy.peg()));
        assertEq(deploy.shareBuybackHook().quote(), WETH);
        assertEq(address(deploy.shareBuybackHook().fireTax()), address(deploy.hook()));
        assertFalse(deploy.shareBuybackHook().taxEnabled(), "collection starts disabled");
        assertTrue(deploy.pairLpHook().bound(), "PEG/SHARE pool initialised");
        assertEq(uint160(address(deploy.pairLpHook())) & 0x3FFF, 0x2080);
        assertEq(deploy.pairLpHook().initializer(), vm.addr(1));
        assertTrue(address(deploy.pairLpWrapper()) != address(deploy.lpWrapper()));

        // Token names come from the environment; the contracts hardcode none.
        assertEq(deploy.peg().symbol(), "xTOMB");
        assertEq(deploy.share().name(), "xSHARE");

        // Sell tax goes to the DAO wallet, never to the Treasury contract.
        assertEq(deploy.hook().feeRecipient(), address(0xDA0));

        // The Masonry stakes the untradeable peg/share LP.
        assertEq(address(deploy.masonry().share()), address(deploy.pairLpWrapper()));

        // Share-token farm emissions: 30% to the peg LP, 70% to the share LP.
        (IERC20 farmToken0, uint256 alloc0,,,) = deploy.shareFarm().poolInfo(0);
        (IERC20 farmToken1, uint256 alloc1,,,) = deploy.shareFarm().poolInfo(1);
        assertEq(address(farmToken0), address(deploy.lpWrapper()));
        assertEq(address(farmToken1), address(deploy.shareLpWrapper()));
        assertEq(alloc0, 30);
        assertEq(alloc1, 70);
        assertEq(deploy.shareFarm().totalAllocPoint(), 100);

        // Genesis runs first; the Treasury's epoch 0 and the farms open when it ends.
        uint256 genesisStart = deploy.genesisRewardPool().poolStartTime();
        assertEq(deploy.treasury().startTime(), genesisStart + 1 days, "epoch 0 follows genesis");
        assertEq(deploy.pegFarm().poolStartTime(), deploy.treasury().startTime());
        assertEq(deploy.shareFarm().poolStartTime(), deploy.treasury().startTime());

        // The airdrop allocation is not excluded from circulating supply.
        assertEq(deploy.treasury().excludedFromTotalSupply(0), address(deploy.genesisRewardPool()));
        assertEq(deploy.treasury().excludedFromTotalSupply(1), address(deploy.pegFarm()));
        Treasury deployedTreasury = deploy.treasury();
        vm.expectRevert();
        deployedTreasury.excludedFromTotalSupply(2);
        assertEq(deploy.peg().operator(), address(deploy.treasury()));
        assertEq(deploy.peg().balanceOf(address(deploy.genesisRewardPool())), 11_000 ether);
        assertEq(deploy.share().balanceOf(address(deploy.shareFarm())), 59_500 ether);
        assertEq(deploy.timelock().admin(), address(0xABCD));
        assertEq(address(deploy.miniSwapRouter().poolManager()), realManager);
        string memory file = string.concat("./deployment-output/", vm.toString(block.chainid), ".json");
        string memory output = vm.readFile(file);
        assertEq(vm.parseJsonUint(output, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(output, ".hook"), address(deploy.hook()));
        assertEq(vm.parseJsonAddress(output, ".shareBuybackHook"), address(deploy.shareBuybackHook()));
        assertEq(vm.parseJsonAddress(output, ".pairLpHook"), address(deploy.pairLpHook()));
        assertEq(vm.parseJsonAddress(output, ".pairLpWrapper"), address(deploy.pairLpWrapper()));
        assertEq(vm.parseJsonAddress(output, ".shareLpWrapper"), address(deploy.shareLpWrapper()));
        vm.removeFile(file);
    }
}
