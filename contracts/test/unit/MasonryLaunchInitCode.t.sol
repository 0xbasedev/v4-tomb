// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MasonryLaunchConfig, MasonryLaunchParams} from "../../script/MasonryLaunchConfig.sol";
import {MasonryLaunchInitCode} from "../../script/MasonryLaunchInitCode.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";
import {MockFireTax} from "../utils/MockFireTax.sol";

contract T is ERC20 {
    constructor() ERC20("t", "t") {}
}

/// Launch-step initcode carries daoWallet, withdraw fee, cooldowns and claimToWallet from launch config.
contract MasonryLaunchInitCodeTest is Test {
    function testFarmInitCodeCarriesLaunchConfig() public {
        MasonryLaunchParams memory p = MasonryLaunchConfig.load(vm);
        MasonryLaunchInitCode.Addrs memory a;
        a.share = address(new T());
        a.shareWethLp = address(new T());
        a.chamber = address(0xC4);
        a.zapper = address(0x2A);
        a.admin = address(this);
        a.levelHook = address(new MockFireTax());
        bytes memory code = MasonryLaunchInitCode.farm(p, a, block.timestamp + 1 days, 1e18);
        address f;
        assembly { f := create(0, add(code, 0x20), mload(code)) }
        require(f != address(0), "farm create failed");
        MasonryFarm farm = MasonryFarm(f);
        assertEq(farm.daoWallet(), p.daoWallet);
        assertEq(address(farm.fireTax()), a.levelHook);
        assertEq(farm.withdrawFeeBps(), 300);
        assertEq(farm.withdrawCooldown(), p.farmWithdrawCooldownSeconds);
        assertEq(farm.claimToWallet(), p.farmClaimToWallet);
        assertEq(farm.zapper(), a.zapper);
        assertEq(farm.masonry(), a.chamber);
    }
}
