// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {V4PositionWrapper} from "../../src/distribution/V4PositionWrapper.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionInfo, PositionInfoLibrary} from "v4-periphery/src/libraries/PositionInfoLibrary.sol";

/// @notice Minimal ERC721 that also implements the V4-PositionManager view surface
///         (getPoolAndPositionInfo, getPositionLiquidity). Used to simulate position
///         NFTs without standing up a real V4 PoolManager + PositionManager.
contract MockV4PositionManager is ERC721 {
    struct PositionStorage {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    uint256 private _nextId = 1;
    mapping(uint256 tokenId => PositionStorage) private _positions;

    constructor() ERC721("Mock V4 Position", "MVP") {}

    /// @notice Test-only mint. Creates a new position NFT with the given metadata.
    function mintPosition(
        address to,
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external returns (uint256 tokenId) {
        tokenId = _nextId++;
        _positions[tokenId] =
            PositionStorage({key: key, tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity});
        _mint(to, tokenId);
    }

    /// @notice V4-PositionManager surface used by V4PositionWrapper.
    function getPoolAndPositionInfo(
        uint256 tokenId
    ) external view returns (PoolKey memory, PositionInfo) {
        PositionStorage memory p = _positions[tokenId];
        PositionInfo info = PositionInfoLibrary.initialize(p.key, p.tickLower, p.tickUpper);
        return (p.key, info);
    }

    function getPositionLiquidity(
        uint256 tokenId
    ) external view returns (uint128) {
        return _positions[tokenId].liquidity;
    }
}

contract V4PositionWrapperTest is BaseTest {
    V4PositionWrapper internal wrapper;
    MockV4PositionManager internal positionManager;

    PoolKey internal expectedPoolKey;
    PoolKey internal otherPoolKey;
    int24 internal constant TICK_LOWER = -6000;
    int24 internal constant TICK_UPPER = 6000;

    address internal aliceTokenOwner = makeAddr("aliceTokenOwner");
    address internal bobTokenOwner = makeAddr("bobTokenOwner");
    address internal charlieRecipient = makeAddr("charlieRecipient");

    function setUp() public override {
        super.setUp();

        positionManager = new MockV4PositionManager();

        // Build the canonical (expected) pool key for our wrapper.
        // Use synthetic addresses; the actual MONEY/WETH pair doesn't matter for mock tests.
        address tokenA = makeAddr("MONEY");
        address tokenB = makeAddr("WETH");
        (Currency c0, Currency c1) = tokenA < tokenB
            ? (Currency.wrap(tokenA), Currency.wrap(tokenB))
            : (Currency.wrap(tokenB), Currency.wrap(tokenA));
        expectedPoolKey = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(address(0))
        });

        // A different pool that should be rejected by the wrapper.
        address otherA = makeAddr("OTHER_A");
        address otherB = makeAddr("OTHER_B");
        (Currency oc0, Currency oc1) = otherA < otherB
            ? (Currency.wrap(otherA), Currency.wrap(otherB))
            : (Currency.wrap(otherB), Currency.wrap(otherA));
        otherPoolKey = PoolKey({currency0: oc0, currency1: oc1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))});

        wrapper = new V4PositionWrapper(
            IPositionManager(address(positionManager)),
            expectedPoolKey,
            TICK_LOWER,
            TICK_UPPER,
            "Old Money MONEY/WETH LP",
            "om-MWLP"
        );
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function test_Constructor_StoresBindings() public view {
        assertEq(address(wrapper.positionManager()), address(positionManager));
        assertEq(wrapper.tickLower(), TICK_LOWER);
        assertEq(wrapper.tickUpper(), TICK_UPPER);
        // Pool id derived from expectedPoolKey
        assertEq(wrapper.name(), "Old Money MONEY/WETH LP");
        assertEq(wrapper.symbol(), "om-MWLP");
    }

    // ---------------------------------------------------------------------
    // wrap — happy path
    // ---------------------------------------------------------------------

    function test_Wrap_MintsSharesAndPullsNft() public {
        uint128 liquidity = 1000 ether;
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liquidity);

        vm.prank(aliceTokenOwner);
        uint128 returnedLiq = wrapper.wrap(tokenId);

        assertEq(returnedLiq, liquidity, "returns wrapped liquidity");
        assertEq(wrapper.balanceOf(aliceTokenOwner), uint256(liquidity), "alice gets ERC-20 = liquidity");
        assertEq(wrapper.wrappedBy(tokenId), aliceTokenOwner, "wrappedBy records alice");
        assertEq(wrapper.wrappedLiquidity(tokenId), liquidity, "wrappedLiquidity recorded");
        assertEq(positionManager.ownerOf(tokenId), address(wrapper), "NFT now held by wrapper");
    }

    // ---------------------------------------------------------------------
    // wrap — validation
    // ---------------------------------------------------------------------

    function test_Wrap_RejectsWrongPool() public {
        // Mint a position in a different pool.
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, otherPoolKey, TICK_LOWER, TICK_UPPER, 1000 ether);
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.WrongPool.selector);
        wrapper.wrap(tokenId);
    }

    function test_Wrap_RejectsWrongTickLower() public {
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER + 60, TICK_UPPER, 1000 ether);
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.WrongTickRange.selector);
        wrapper.wrap(tokenId);
    }

    function test_Wrap_RejectsWrongTickUpper() public {
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER - 60, 1000 ether);
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.WrongTickRange.selector);
        wrapper.wrap(tokenId);
    }

    function test_Wrap_RejectsZeroLiquidity() public {
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, 0);
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.ZeroLiquidityPosition.selector);
        wrapper.wrap(tokenId);
    }

    function test_Wrap_RequiresApproval() public {
        // Mint the NFT but don't approve the wrapper.
        uint256 tokenId =
            positionManager.mintPosition(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, 1000 ether);
        vm.prank(aliceTokenOwner);
        vm.expectRevert(); // ERC721's own permission revert
        wrapper.wrap(tokenId);
    }

    // ---------------------------------------------------------------------
    // unwrap — happy path + permission
    // ---------------------------------------------------------------------

    function test_Unwrap_BurnsSharesAndReturnsNft() public {
        uint128 liquidity = 1000 ether;
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liquidity);

        vm.prank(aliceTokenOwner);
        wrapper.wrap(tokenId);

        vm.prank(aliceTokenOwner);
        wrapper.unwrap(tokenId);

        assertEq(wrapper.balanceOf(aliceTokenOwner), 0, "alice burned all shares");
        assertEq(positionManager.ownerOf(tokenId), aliceTokenOwner, "alice gets NFT back");
        assertEq(wrapper.wrappedBy(tokenId), address(0), "wrappedBy cleared");
        assertEq(wrapper.wrappedLiquidity(tokenId), 0, "wrappedLiquidity cleared");
    }

    function test_Unwrap_RequiresOriginalWrapper() public {
        uint128 liquidity = 1000 ether;
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liquidity);

        vm.prank(aliceTokenOwner);
        wrapper.wrap(tokenId);

        // Alice transfers her ERC-20 to charlie. Charlie now has enough shares to "afford"
        // the unwrap (1000), but he's NOT the original wrapper. Unwrap MUST revert.
        vm.prank(aliceTokenOwner);
        wrapper.transfer(charlieRecipient, uint256(liquidity));
        assertEq(wrapper.balanceOf(charlieRecipient), uint256(liquidity));

        vm.prank(charlieRecipient);
        vm.expectRevert(V4PositionWrapper.NotOriginalWrapper.selector);
        wrapper.unwrap(tokenId);
    }

    function test_Unwrap_RejectsNonWrapped() public {
        // tokenId that was never wrapped
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.NotOriginalWrapper.selector);
        wrapper.unwrap(999);
    }

    function test_Unwrap_RejectsTwice() public {
        uint128 liquidity = 1000 ether;
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liquidity);

        vm.prank(aliceTokenOwner);
        wrapper.wrap(tokenId);

        vm.prank(aliceTokenOwner);
        wrapper.unwrap(tokenId);

        // Second unwrap: alice is no longer wrappedBy, so reverts.
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.NotOriginalWrapper.selector);
        wrapper.unwrap(tokenId);
    }

    function test_Unwrap_RevertsIfSharesAlreadySpent() public {
        // Alice wraps, then transfers ALL her shares away. She is still wrappedBy[tokenId]
        // but has no shares to burn — ERC20 burn reverts.
        uint128 liquidity = 1000 ether;
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liquidity);

        vm.prank(aliceTokenOwner);
        wrapper.wrap(tokenId);

        vm.prank(aliceTokenOwner);
        wrapper.transfer(charlieRecipient, uint256(liquidity));

        vm.prank(aliceTokenOwner);
        vm.expectRevert(); // ERC20InsufficientBalance from OZ ERC20
        wrapper.unwrap(tokenId);
    }

    // ---------------------------------------------------------------------
    // ERC-20 surface
    // ---------------------------------------------------------------------

    function test_Erc20_IsTransferable() public {
        uint128 liquidity = 100 ether;
        uint256 tokenId = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liquidity);

        vm.prank(aliceTokenOwner);
        wrapper.wrap(tokenId);

        vm.prank(aliceTokenOwner);
        wrapper.transfer(bobTokenOwner, 30 ether);

        assertEq(wrapper.balanceOf(aliceTokenOwner), 70 ether);
        assertEq(wrapper.balanceOf(bobTokenOwner), 30 ether);
    }

    // ---------------------------------------------------------------------
    // Multi-wrap scenarios
    // ---------------------------------------------------------------------

    function test_MultipleWrappers_OnlyOwnerCanUnwrapEachToken() public {
        // Alice wraps NFT-A (1000 liquidity)
        uint128 liqA = 1000 ether;
        uint256 tokenIdA = _mintAndApproveTo(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liqA);
        vm.prank(aliceTokenOwner);
        wrapper.wrap(tokenIdA);

        // Bob wraps NFT-B (500 liquidity)
        uint128 liqB = 500 ether;
        uint256 tokenIdB = _mintAndApproveTo(bobTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, liqB);
        vm.prank(bobTokenOwner);
        wrapper.wrap(tokenIdB);

        // Total supply = 1500
        assertEq(wrapper.totalSupply(), uint256(liqA) + uint256(liqB));

        // Alice tries to unwrap Bob's NFT — should revert.
        vm.prank(aliceTokenOwner);
        vm.expectRevert(V4PositionWrapper.NotOriginalWrapper.selector);
        wrapper.unwrap(tokenIdB);

        // Bob tries to unwrap Alice's NFT — should revert.
        vm.prank(bobTokenOwner);
        vm.expectRevert(V4PositionWrapper.NotOriginalWrapper.selector);
        wrapper.unwrap(tokenIdA);

        // Each can unwrap their own.
        vm.prank(aliceTokenOwner);
        wrapper.unwrap(tokenIdA);
        vm.prank(bobTokenOwner);
        wrapper.unwrap(tokenIdB);

        assertEq(positionManager.ownerOf(tokenIdA), aliceTokenOwner);
        assertEq(positionManager.ownerOf(tokenIdB), bobTokenOwner);
    }

    // ---------------------------------------------------------------------
    // onERC721Received — must reject safe transfers
    // ---------------------------------------------------------------------

    function test_OnERC721Received_RejectsDirectSafeTransfer() public {
        // Mint NFT to alice but DON'T approve. Try to safeTransferFrom into the wrapper
        // directly — the wrapper's onERC721Received returns 0, which causes the safe
        // transfer to revert. This ensures NFTs can only enter via wrap().
        uint256 tokenId =
            positionManager.mintPosition(aliceTokenOwner, expectedPoolKey, TICK_LOWER, TICK_UPPER, 1000 ether);

        vm.prank(aliceTokenOwner);
        vm.expectRevert(); // OZ ERC721's InvalidReceiver error
        positionManager.safeTransferFrom(aliceTokenOwner, address(wrapper), tokenId);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _mintAndApproveTo(
        address recipient,
        PoolKey memory key,
        int24 _tickLower,
        int24 _tickUpper,
        uint128 liquidity
    ) internal returns (uint256 tokenId) {
        tokenId = positionManager.mintPosition(recipient, key, _tickLower, _tickUpper, liquidity);
        vm.prank(recipient);
        positionManager.approve(address(wrapper), tokenId);
    }
}
