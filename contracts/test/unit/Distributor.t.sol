// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {Distributor} from "../../src/core/Distributor.sol";
import {IDistributor} from "../../src/interfaces/IDistributor.sol";

/// @notice Test-only IDistributor that records each call against it.
contract MockSubDistributor is IDistributor {
    uint256 public calls;
    bool public shouldRevert;

    function setShouldRevert(
        bool v
    ) external {
        shouldRevert = v;
    }

    function distribute() external {
        if (shouldRevert) revert("MockSubDistributor: revert");
        unchecked {
            ++calls;
        }
    }
}

contract DistributorTest is BaseTest {
    Distributor internal distributor;
    MockSubDistributor internal subA;
    MockSubDistributor internal subB;
    MockSubDistributor internal subC;

    function setUp() public override {
        super.setUp();
        subA = new MockSubDistributor();
        subB = new MockSubDistributor();
        subC = new MockSubDistributor();

        IDistributor[] memory list = new IDistributor[](3);
        list[0] = IDistributor(address(subA));
        list[1] = IDistributor(address(subB));
        list[2] = IDistributor(address(subC));
        distributor = new Distributor(list);
    }

    function test_Constructor_StoresList() public view {
        assertEq(address(distributor.distributors(0)), address(subA));
        assertEq(address(distributor.distributors(1)), address(subB));
        assertEq(address(distributor.distributors(2)), address(subC));
    }

    function test_Distribute_CallsEverySubInOrder() public {
        distributor.distribute();
        assertEq(subA.calls(), 1);
        assertEq(subB.calls(), 1);
        assertEq(subC.calls(), 1);
    }

    function test_Distribute_Permissionless() public {
        vm.prank(stranger);
        distributor.distribute();
        assertEq(subA.calls(), 1);
    }

    function test_Distribute_RevertsIfAnySubReverts() public {
        subB.setShouldRevert(true);
        vm.expectRevert(bytes("MockSubDistributor: revert"));
        distributor.distribute();
        // Atomic revert: all prior sub calls roll back too, so no observable effect.
        assertEq(subA.calls(), 0);
        assertEq(subB.calls(), 0);
        assertEq(subC.calls(), 0);
    }

    function test_Distribute_EmptyListIsNoop() public {
        IDistributor[] memory empty = new IDistributor[](0);
        Distributor d = new Distributor(empty);
        d.distribute(); // no revert, no observable effect
    }

    function test_Distribute_TwiceIncrementsEachSubTwice() public {
        distributor.distribute();
        distributor.distribute();
        assertEq(subA.calls(), 2);
        assertEq(subB.calls(), 2);
        assertEq(subC.calls(), 2);
    }
}
