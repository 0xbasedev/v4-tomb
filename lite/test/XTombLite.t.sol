// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {XLiteToken, XTombLiteMasonry} from "../src/XTombLite.sol";
import {LiteV2TwapOracle} from "../src/LiteV2TwapOracle.sol";
import {LiteChainlinkUsdSource} from "../src/LiteChainlinkUsdSource.sol";
import {LiteSellTaxController} from "../src/LiteSellTaxController.sol";
import {LiteLpFarm} from "../src/LiteLpFarm.sol";
import {LiteLinearVesting} from "../src/LiteLinearVesting.sol";

interface VmOmniTest {
    function chainId(uint256 chain) external;
    function warp(uint256 when) external;
    function prank(address sender) external;
}

contract MockStable {
    string public constant name = "Test USD";
    string public constant symbol = "mUSD";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; totalSupply += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount && balanceOf[from] >= amount);
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
        return true;
    }
}

contract MockFeed {
    uint8 public constant decimals = 8;
    int256 public answer = 1e8;
    uint256 public updatedAt;
    constructor() { updatedAt = block.timestamp; }
    function set(int256 p) external { answer = p; updatedAt = block.timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockPrice {
    uint256 public price;
    uint256 public timestamp;
    function set(uint256 p) external { price = p; timestamp = block.timestamp; }
    function latestPrice() external view returns (uint256, uint256) {
        return (price, timestamp);
    }
}

/// @dev A mock LP ERC-20 that also simulates standard V2 reserve+cumulative interfaces.
contract MockPair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    uint32 private reservesAt;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address a, address b) {
        token0 = a; token1 = b;
        reservesAt = uint32(block.timestamp);
    }

    function setReserves(uint112 r0_, uint112 r1_) external {
        uint32 elapsed;
        unchecked { elapsed = uint32(block.timestamp) - reservesAt; }
        if (r0 != 0 && r1 != 0 && elapsed > 0) {
            price0CumulativeLast += (uint256(r1) * 2 ** 112 / r0) * elapsed;
            price1CumulativeLast += (uint256(r0) * 2 ** 112 / r1) * elapsed;
        }
        r0 = r0_; r1 = r1_; reservesAt = uint32(block.timestamp);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, reservesAt);
    }
    function mintLp(address to, uint256 amount) external {
        balanceOf[to] += amount; totalSupply += amount;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount && balanceOf[from] >= amount);
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
        return true;
    }
}
contract MockAdapter {}

contract XTombLiteTest {
    VmOmniTest private constant vm = VmOmniTest(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant TREASURY = address(0x1111);
    address private constant ARBITRAGE = address(0x2222);

    XLiteToken private peg;
    XLiteToken private share;
    MockStable private stable;
    MockPair private lp;
    MockPair private pegStable;
    MockFeed private feed;
    MockPrice private pegPrice;
    LiteChainlinkUsdSource private stablePrice;
    XTombLiteMasonry private masonry;
    uint256 private genesis;

    function setUp() public {
        // Deliberately not LONGYU: same bytecode must work on any configured EVM chain.
        vm.chainId(775533);
        vm.warp(1_000_000);
        peg = new XLiteToken("xTOMB", "xTOMB", 18, type(uint256).max, address(this));
        share = new XLiteToken("xSHARE", "xSHARE", 18, 333333e18, address(this));
        stable = new MockStable();
        lp = new MockPair(address(peg), address(share));
        pegStable = new MockPair(address(peg), address(stable));
        pegStable.setReserves(1000e18, 1000e6);
        feed = new MockFeed();
        pegPrice = new MockPrice();
        stablePrice = new LiteChainlinkUsdSource(address(feed), 30 minutes);
        peg.mint(TREASURY, 1000e18);
        stable.mint(ALICE, 1000e6);
        lp.mintLp(ALICE, 100e18);
        genesis = block.timestamp + 1;
        masonry = new XTombLiteMasonry(
            block.chainid, address(peg), address(share), address(lp), address(stable),
            address(pegPrice), address(stablePrice), address(0),
            TREASURY, ARBITRAGE, address(this), genesis
        );
        peg.finalizeMinter(address(masonry));
        vm.prank(ALICE);
        lp.approve(address(masonry), type(uint256).max);
        vm.prank(ALICE);
        stable.approve(address(masonry), type(uint256).max);
        vm.prank(ALICE);
        masonry.deposit(100e18);
    }

    function _eligible(uint256 price) internal {
        vm.warp(genesis + 6 hours + 1);
        feed.set(1e8);
        pegPrice.set(price);
    }

    function testNoMintAtOrBelowPegAndNoFeeCharged() public {
        _eligible(1.01e18);
        vm.prank(ALICE);
        (bool ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochStable, ()));
        require(!ok, "minted at ceiling");
        require(peg.totalSupply() == 1000e18, "supply changed");
        require(stable.balanceOf(TREASURY) == 0, "fee charged");
        pegPrice.set(0.99e18);
        vm.prank(ALICE);
        (ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochStable, ()));
        require(!ok, "minted below peg");
    }

    function testPermissionlessEpochDynamicFeeNoCatchupAndClaim() public {
        _eligible(1.02e18);
        vm.prank(ALICE);
        masonry.advanceEpochStable();
        require(peg.totalSupply() == 1020e18, "not 2 percent");
        require(stable.balanceOf(TREASURY) == 25e6, "wrong fee");
        require(masonry.nextEpochAt() == block.timestamp + 6 hours, "no catchup broken");
        vm.prank(ALICE);
        (bool ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochStable, ()));
        require(!ok, "duplicate epoch");
        vm.prank(ALICE);
        masonry.claim();
        require(peg.balanceOf(ALICE) == 20e18, "LP reward not distributed");
    }

    function testDepeggedStableRequiresMoreThan25Tokens() public {
        _eligible(1.02e18);
        feed.set(9e7); // 1 mUSD = $0.90, requires 27.777778 mUSD
        vm.prank(ALICE);
        masonry.advanceEpochStable();
        require(stable.balanceOf(TREASURY) == 27_777_778, "fee was not $25");
    }

    function testExitNowForfeitsHalfLpAndAllPendingPegRewards() public {
        _eligible(1.02e18);
        vm.prank(ALICE);
        masonry.advanceEpochStable();
        vm.prank(ALICE);
        masonry.exitNow(0, 100e18);
        require(lp.balanceOf(ALICE) == 50e18, "user LP");
        require(lp.balanceOf(TREASURY) == 50e18, "treasury LP");
        require(peg.balanceOf(ARBITRAGE) == 20e18, "forfeited reward");
        require(masonry.totalStaked() == 0, "stake remains");
    }

    function testInactivePegOracleFailsClosed() public {
        _eligible(1.02e18);
        vm.warp(block.timestamp + 31 minutes);
        feed.set(1e8);
        vm.prank(ALICE);
        (bool ok,) = address(masonry).call(abi.encodeCall(masonry.advanceEpochStable, ()));
        require(!ok, "stale price minted");
    }

    function testMismatchedConfiguredChainRejected() public {
        try new XTombLiteMasonry(
            block.chainid + 1, address(peg), address(share), address(lp), address(stable),
            address(pegPrice), address(stablePrice), address(0),
            TREASURY, ARBITRAGE, address(this), genesis
        ) returns (XTombLiteMasonry) {
            revert("wrong chain accepted");
        } catch {}
    }

    function testTaxCapAndSevenHourRecoveryConfig() public {
        // Independent token allows configuring the immutable tax policy before mint authority handoff.
        XLiteToken taxablePeg = new XLiteToken("Tax Peg", "pTOMB", 18, type(uint256).max, address(this));
        MockPair taxablePair = new MockPair(address(taxablePeg), address(stable));
        taxablePair.setReserves(1000e18, 1000e6);
        taxablePeg.mint(TREASURY, 1000e18);
        LiteSellTaxController tax = new LiteSellTaxController(
            address(taxablePeg), address(taxablePair), address(pegPrice),
            1e18, 100, 1200, 1500, 0, 0, 6, 30, true
        );
        taxablePeg.configureTax(address(taxablePair), address(tax), TREASURY, address(new MockAdapter()));
        pegPrice.set(0.85e18);
        vm.prank(TREASURY);
        taxablePeg.transfer(address(taxablePair), 100e18);
        require(taxablePeg.balanceOf(address(taxablePair)) == 88e18, "max tax breached");
        require(taxablePeg.balanceOf(TREASURY) == 912e18, "tax bucket incorrect");
    }

    function testRealV2TWAPAndStaleReference() public {
        LiteV2TwapOracle oracle = new LiteV2TwapOracle(
            address(pegStable), address(peg), address(stable), address(feed),
            6, 100e18, 100e6, 30 minutes, 30 minutes, 30 minutes, 500, 10
        );
        uint256 anchor = block.timestamp;
        oracle.poke(); // Anchor.
        vm.warp(anchor + 15 minutes);
        pegStable.setReserves(1000e18, 1040e6);
        vm.warp(anchor + 30 minutes);
        feed.set(1e8);
        oracle.poke();
        (uint256 price,) = oracle.latestPrice();
        require(price > 1.01e18 && price < 1.04e18, "TWAP normalization failed");
        vm.warp(block.timestamp + 31 minutes);
        (bool ok,) = address(oracle).staticcall(abi.encodeCall(oracle.latestPrice, ()));
        require(!ok, "stale TWAP passed");
    }

    function testPrefunded365DayFarmsAndFailOpenWithdrawal() public {
        LiteLpFarm farm = new LiteLpFarm(
            address(lp), address(share), address(pegPrice),
            address(this), TREASURY, block.timestamp + 1, 300
        );
        share.mint(address(this), 1000e18);
        share.approve(address(farm), 1000e18);
        farm.activate(1000e18);
        vm.warp(block.timestamp + 2);
        // The initial 100 LP were deposited into Masonry by setUp; mint distinct LP for this farm.
        lp.mintLp(ALICE, 100e18);
        vm.prank(ALICE);
        lp.approve(address(farm), type(uint256).max);
        vm.prank(ALICE);
        farm.stake(100e18);
        vm.warp(block.timestamp + 30 days);
        require(farm.pending(ALICE) > 0, "farm did not accrue");
        // Stale oracle: never block withdrawal and never levy an unverified withdrawal fee.
        vm.prank(ALICE);
        farm.withdraw(100e18);
        require(lp.balanceOf(ALICE) == 100e18, "withdraw fail-open");
    }

    function testIrrevocable180DayVesting() public {
        LiteLinearVesting vest = new LiteLinearVesting(
            address(share), ALICE, address(this), uint64(block.timestamp + 1), 180 days
        );
        share.mint(address(this), 110e18);
        share.approve(address(vest), 110e18);
        vest.fund(10e18, 100e18);
        require(share.balanceOf(ALICE) == 10e18, "upfront not paid");
        vm.warp(block.timestamp + 1 + 90 days);
        vest.release();
        require(share.balanceOf(ALICE) == 60e18, "linear midpoint incorrect");
        vm.warp(block.timestamp + 90 days);
        vest.release();
        require(share.balanceOf(ALICE) == 110e18, "vested principal lost");
    }

    function testImmutableShareCapAndNoUnauthorizedMinter() public {
        share.mint(ALICE, 333333e18);
        (bool ok,) = address(share).call(abi.encodeCall(share.mint, (ALICE, 1)));
        require(!ok, "share cap bypass");
        vm.prank(ALICE);
        (ok,) = address(peg).call(abi.encodeCall(peg.mint, (ALICE, 1)));
        require(!ok, "unauthorized peg mint");
    }
}
