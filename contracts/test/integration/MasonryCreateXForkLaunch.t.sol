// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {DeployMasonryComponent} from "../../script/DeployMasonryComponent.s.sol";
import {VerifyMasonryLaunch} from "../../script/VerifyMasonryLaunch.s.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {BindOnlyHook} from "../unit/MasonryLaunchDryRun.t.sol";

contract RealVerify is VerifyMasonryLaunch {
    function predict(bytes32 releaseId, address deployer, string memory role) external pure returns (address) {
        return _create3Address(Create3Plan(CREATEX, deployer, releaseId), role, 0);
    }
}

/// Local fork of Robinhood 4663 (read-only RPC, nothing broadcast). Uses the chain's real CreateX
/// runtime (code hash pinned in Create3Config), the unmodified launch + verify scripts.
contract MasonryCreateXForkLaunchTest is Test {
    address internal constant HOOK = 0xA0000000000000000000000000000000000035C8;
    address internal constant SQUARE_HOOK = 0xb0000000000000000000000000000000000035c8;
    bytes32 internal constant RELEASE = bytes32(uint256(0xC0FFEE));

    function test_RealCreateXRangeManagerLaunchOnFork() public {
        try vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com") {} catch { vm.skip(true); return; }
        address deployer = vm.addr(7);
        vm.deal(deployer, 1 ether);
        vm.etch(HOOK, address(new BindOnlyHook(deployer)).code);
        vm.etch(SQUARE_HOOK, address(new BindOnlyHook(deployer)).code);
        RealVerify verify = new RealVerify();
        bytes memory initCode = abi.encodePacked(type(MasonryGenesisSchedule).creationCode, abi.encode(0, deployer));
        address level = verify.predict(RELEASE, deployer, "masonryLevelRangeManager");
        address square = verify.predict(RELEASE, deployer, "masonrySquareRangeManager");
        string memory path = "./deployment-output/masonry-createx-fork.json";
        string memory h = vm.toString(keccak256(initCode));
        vm.writeFile(path, string.concat(
            '{"chainId":4663,"factory":"0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed","deployer":"', vm.toString(deployer),
            '","releaseId":"', vm.toString(RELEASE), '","addresses":{"masonryTaxHook":"', vm.toString(HOOK),
            '","masonryLevelRangeManager":"', vm.toString(level), '","masonryShareTaxHook":"', vm.toString(SQUARE_HOOK),
            '","masonrySquareRangeManager":"', vm.toString(square), '"},"initCodeHashes":{"masonryLevelRangeManager":"', h,
            '","masonrySquareRangeManager":"', h, '"}}'
        ));
        vm.setEnv("MASONRY_CREATE3_CONFIG", path);
        DeployMasonryComponent deploy = new DeployMasonryComponent();
        address dl = deploy.run("masonryLevelRangeManager", initCode);
        address ds = deploy.run("masonrySquareRangeManager", initCode);
        console2.log("level  predicted", level, "deployed", dl);
        console2.log("square predicted", square, "deployed", ds);
        assertEq(dl, level);
        assertEq(ds, square);
        verify.run();
        vm.removeFile(path);
    }
}
