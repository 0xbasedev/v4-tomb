// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {XLiteToken, XTombLiteMasonry} from "../src/XTombLite.sol";
import {LiteManualTestOracle} from "../src/LiteManualTestOracle.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function warp(uint256 newTimestamp) external;
    function prank(address caller) external;
}

contract XTombLiteTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    address internal constant TREASURY = address(0x1111);
    address internal constant ARBITRAGE = address(0x2222);
    XLiteToken internal peg;
    XLiteToken internal lpMock;
    XLiteToken internal usd;
    LiteManualTestOracle internal oracle;
    XTombLiteMasonry internal masonry;
    uint256 internal epochStart;

    function setUp() public {
        vm.chainId(668801);
        peg = new XLiteToken("xTOMB Test", "xTOMB", 18, type(uint256).max, address(this));
        lpMock = new XLiteToken("LP Test", "LP", 18, type(uint256).max, address(this));
        usd = new XLiteToken("Fake USD", "mUSD", 6, 1e18, address(this));
        peg.mint(TREASURY, 1000e18);
        lpMock.mint(ALICE, 100e18);
        usd.mint(ALICE, 1000e6);
        oracle = new LiteManualTestOracle(address(this));
        epochStart = block.timestamp + 1;
        masonry = new XTombLiteMasonry(
            address(peg), address(lpMock), address(usd), address(oracle),
            address(0), TREASURY, ARBITRAGE, address(this), epochStart, 25e6
        );
        peg.finalizeMinter(address(masonry));
        vm.prank(ALICE);
        lpMock.approve(address(masonry), type(uint256).max);
        vm.prank(ALICE);
        usd.approve(address(masonry), type(uint256).max);
        vm.prank(ALICE);
        masonry.deposit(100e18);
    }

    function _dueAt(uint256 price) internal {
        vm.warp(epochStart + 6 hours + 1);
        oracle.setTestPrice(price);
    }

    function testRejectsAtOrBelowPegWithoutChargingFee() public {
        _dueAt(1.01e18);
        vm.prank(ALICE);
        (bool ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochUsdc, ()));
        require(!ok, "minted at peg");
        require(peg.totalSupply() == 1000e18, "supply changed");
        require(usd.balanceOf(TREASURY) == 0, "charged rejected epoch");
        oracle.setTestPrice(1e18);
        vm.prank(ALICE);
        (ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochUsdc, ()));
        require(!ok, "minted under peg");
    }

    function testAdvanceMaxTwoPercentThenNoCatchUp() public {
        _dueAt(1.02e18);
        vm.prank(ALICE);
        masonry.advanceEpochUsdc();
        require(peg.totalSupply() == 1020e18, "not 2 percent");
        require(usd.balanceOf(TREASURY) == 25e6, "missing test epoch fee");
        require(masonry.nextEpochAt() == block.timestamp + 6 hours, "incorrect next epoch");

        vm.prank(ALICE);
        (bool ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochUsdc, ()));
        require(!ok, "caught up");
        vm.prank(ALICE);
        masonry.claim();
        require(peg.balanceOf(ALICE) == 20e18, "LP rewards not claimed");
    }

    function testInstantExitForfeitsHalfLpAndAllRewards() public {
        _dueAt(1.02e18);
        vm.prank(ALICE);
        masonry.advanceEpochUsdc();
        vm.prank(ALICE);
        masonry.exitNow(0, 100e18);
        require(lpMock.balanceOf(ALICE) == 50e18, "user share");
        require(lpMock.balanceOf(TREASURY) == 50e18, "treasury share");
        require(peg.balanceOf(ARBITRAGE) == 20e18, "reward forfeiture");
        require(masonry.totalStaked() == 0, "stake remains");
    }

    function testShareCapAndMinterHandoff() public {
        vm.prank(ALICE);
        (bool ok,) = address(peg).call(abi.encodeCall(peg.mint, (ALICE, 1)));
        require(!ok, "unapproved mint");
        XLiteToken share = new XLiteToken("xSHARE Test", "xSHARE", 18, 333333e18, address(this));
        share.mint(ALICE, 333333e18);
        (ok,) = address(share).call(abi.encodeCall(share.mint, (ALICE, 1)));
        require(!ok, "share cap bypass");
    }

    function testManualOracleStalenessFailsClosed() public {
        _dueAt(1.02e18);
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(ALICE);
        (bool ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochUsdc, ()));
        require(!ok, "stale oracle minted");
    }
}
