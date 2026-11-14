// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployMasonryComponent} from "../../script/DeployMasonryComponent.s.sol";
import {VerifyMasonryLaunch} from "../../script/VerifyMasonryLaunch.s.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {ConfigTestFactory} from "./NetworkConfig.t.sol";

/// Stand-in tax hook: same initializer-only, one-shot bind as MasonryTaxHook.
contract BindOnlyHook {
    address public immutable initializer;
    address public rangeManager;

    constructor(
        address initializer_
    ) {
        initializer = initializer_;
    }

    function bindRangeManager(
        address rm
    ) external {
        require(msg.sender == initializer && rangeManager == address(0) && rm.code.length != 0, "unauthorized");
        rangeManager = rm;
    }
}

contract DryRunDeploy is DeployMasonryComponent {
    function _createXCodeHash() internal pure override returns (bytes32) {
        return keccak256(type(ConfigTestFactory).runtimeCode);
    }
}

contract DryRunVerify is VerifyMasonryLaunch {
    function _createXCodeHash() internal pure override returns (bytes32) {
        return keccak256(type(ConfigTestFactory).runtimeCode);
    }

    function create3Address(
        bytes32 releaseId,
        address deployer,
        string memory role
    ) external pure returns (address) {
        return _create3Address(Create3Plan(CREATEX, deployer, releaseId), role, 0);
    }
}

/// Local dry run: CREATE3 launch of the range-manager role binds its hook in the same run,
/// and the verify gate requires code at every published address and every bind set.
contract MasonryLaunchDryRunTest is Test {
    address internal constant FACTORY = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    address internal constant HOOK = 0xA0000000000000000000000000000000000035C8;
    address internal constant SQUARE_HOOK = 0xb0000000000000000000000000000000000035c8;
    bytes32 internal constant RELEASE = bytes32(uint256(0x1234));
    string internal path = "./deployment-output/masonry-dryrun-test.json";
    address internal deployer;
    bytes internal initCode;
    DryRunVerify internal verify;

    function setUp() public {
        vm.chainId(4663);
        deployer = vm.addr(1);
        vm.deal(deployer, 10 ether);
        vm.etch(FACTORY, address(new ConfigTestFactory()).code);
        vm.etch(HOOK, address(new BindOnlyHook(deployer)).code);
        vm.etch(SQUARE_HOOK, address(new BindOnlyHook(deployer)).code);
        initCode = abi.encodePacked(type(MasonryGenesisSchedule).creationCode, abi.encode(0, deployer));
        verify = new DryRunVerify();
    }

    function _write(
        bool withSquare
    ) internal returns (address level, address square) {
        level = verify.create3Address(RELEASE, deployer, "masonryLevelRangeManager");
        square = verify.create3Address(RELEASE, deployer, "masonrySquareRangeManager");
        string memory h = vm.toString(keccak256(initCode));
        vm.createDir("./deployment-output", true);
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":4663,"factory":"',
                vm.toString(FACTORY),
                '","deployer":"',
                vm.toString(deployer),
                '","releaseId":"',
                vm.toString(RELEASE),
                '","addresses":{"masonryTaxHook":"',
                vm.toString(HOOK),
                '","masonryLevelRangeManager":"',
                vm.toString(level),
                '"',
                withSquare
                    ? string.concat(
                        ',"masonryShareTaxHook":"',
                        vm.toString(SQUARE_HOOK),
                        '","masonrySquareRangeManager":"',
                        vm.toString(square),
                        '"'
                    )
                    : "",
                '},"initCodeHashes":{"masonryLevelRangeManager":"',
                h,
                '","masonrySquareRangeManager":"',
                h,
                '"}}'
            )
        );
        vm.setEnv("MASONRY_CREATE3_CONFIG", path);
    }

    /// One test, sequential scenarios: forge runs tests in parallel and MASONRY_CREATE3_CONFIG is process-global.
    function testDryRunLaunchGate() public {
        uint256 snap = vm.snapshotState();
        // 1. wrong chain
        _write(false);
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(VerifyMasonryLaunch.WrongChain.selector, 4663, 8453));
        verify.run();
        vm.chainId(4663);
        // 2. published range manager has no code
        (address level,) = _write(true);
        vm.expectRevert(abi.encodeWithSelector(VerifyMasonryLaunch.NoCode.selector, "masonryLevelRangeManager", level));
        verify.run();
        // 3. code present but never bound
        _write(false);
        vm.etch(level, hex"00");
        vm.expectRevert(
            abi.encodeWithSelector(VerifyMasonryLaunch.Unbound.selector, "masonryTaxHook", address(0), level)
        );
        verify.run();
        vm.revertToState(snap);
        // 4. real launch run: CREATE3 deploy binds each hook in the same run, verify passes
        address square;
        (level, square) = _write(true);
        DryRunDeploy deploy = new DryRunDeploy();
        assertEq(deploy.run("masonryLevelRangeManager", initCode), level);
        assertEq(deploy.run("masonrySquareRangeManager", initCode), square);
        assertEq(BindOnlyHook(HOOK).rangeManager(), level);
        assertEq(BindOnlyHook(SQUARE_HOOK).rangeManager(), square);
        verify.run();
        vm.removeFile(path);
    }
}
