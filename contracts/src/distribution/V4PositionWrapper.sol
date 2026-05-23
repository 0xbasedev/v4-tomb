// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionInfo, PositionInfoLibrary} from "v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

/**
 * @title V4PositionWrapper
 * @notice Wraps a Uniswap V4 position NFT (from the V4 PositionManager) into a fungible
 *         ERC-20 receipt token. The ERC-20 amount equals the position's V4 liquidity at
 *         the moment of wrapping.
 *
 *         Bridges the gap between V4's ERC-721 LP positions and Tomb's MasterChef-style
 *         reward pools, which expect ERC-20 LP tokens. Sprint 16 of the Old Money build.
 *
 * @dev    Each wrapper instance is bound to ONE specific `(poolId, tickLower, tickUpper)`
 *         tuple. To support multiple LP "pairs" (e.g., MONEY/WETH full-range AND
 *         ESTATE/WETH full-range) deploy multiple wrappers.
 *
 *         End-user flow:
 *           1. Acquire MONEY + WETH and use the standard V4 PositionManager flow (via
 *              Uniswap UI or a router) to mint a position NFT at this wrapper's exact
 *              `(poolId, tickLower, tickUpper)`.
 *           2. `IERC721(positionManager).approve(wrapper, tokenId)` then
 *              `wrapper.wrap(tokenId)`. Wrapper pulls the NFT and mints ERC-20 equal to
 *              the position's V4 liquidity to the caller.
 *           3. Stake the ERC-20 in a reward pool (e.g., MainRewardPool, ShareRewardPool).
 *              The ERC-20 is freely transferable — staking moves it; the reward pool
 *              holds it until withdrawal.
 *           4. After withdrawing the ERC-20 from the reward pool, call
 *              `wrapper.unwrap(tokenId)` to redeem the original NFT. Only the address
 *              that originally wrapped a given tokenId may unwrap it.
 *
 *         Design point: the ERC-20 is fully transferable (so it's stakeable in any
 *         pool that takes ERC-20), but the right to redeem a *specific* NFT stays with
 *         the wrapper. This prevents Alice's freely-traded ERC-20 from being used by
 *         anyone to claim a particular NFT belonging to her. Concrete scenario this
 *         protects against:
 *
 *           - Alice wraps NFT-A (1000 liquidity) → has 1000 ERC-20
 *           - Bob wraps NFT-B (500 liquidity) → has 500 ERC-20
 *           - Without per-tokenId ownership tracking, anyone with 500 ERC-20 could
 *             unwrap Bob's NFT, leaving Bob with shares no NFT can satisfy.
 *           - With tracking, only Bob (the recorded `wrappedBy[NFT-B]`) can unwrap it.
 *
 *         Fees that accrue on the V4 position while it's wrapped stay on the NFT and
 *         remain claimable by the new owner after unwrap (via V4's PositionManager
 *         directly). The wrapper makes no claim on fees.
 *
 *         What this wrapper does NOT do:
 *           - Add/remove liquidity to/from positions on behalf of users. They must use
 *             the V4 PositionManager directly for that.
 *           - Tokenize fees separately from the NFT.
 *           - Combine multiple NFTs into a single fungible position (ALM behavior). For
 *             the Old Money v1 launch this simple NFT-wrap model is what we ship; a
 *             future ALM upgrade can layer on top.
 */
contract V4PositionWrapper is ERC20 {
    using PositionInfoLibrary for PositionInfo;
    using PoolIdLibrary for PoolKey;

    /// @notice The V4 PositionManager this wrapper accepts NFTs from.
    IPositionManager public immutable positionManager;

    /// @notice The pool id this wrapper accepts positions from. Set at deploy.
    PoolId public immutable poolId;

    /// @notice The exact tickLower the position must have to be wrappable.
    int24 public immutable tickLower;

    /// @notice The exact tickUpper the position must have to be wrappable.
    int24 public immutable tickUpper;

    /// @notice Address that originally wrapped each tokenId. Only this address may
    ///         unwrap. Cleared on unwrap.
    mapping(uint256 tokenId => address) public wrappedBy;

    /// @notice V4 liquidity recorded at the moment each tokenId was wrapped. Equals the
    ///         ERC-20 burn amount required to unwrap that specific tokenId.
    mapping(uint256 tokenId => uint128) public wrappedLiquidity;

    event Wrapped(uint256 indexed tokenId, address indexed wrapper, uint128 liquidity);
    event Unwrapped(uint256 indexed tokenId, address indexed unwrapper, uint128 liquidity);

    error WrongPool();
    error WrongTickRange();
    error NotOriginalWrapper();
    error NotWrapped();
    error ZeroLiquidityPosition();

    constructor(
        IPositionManager _positionManager,
        PoolKey memory _poolKey,
        int24 _tickLower,
        int24 _tickUpper,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        positionManager = _positionManager;
        poolId = _poolKey.toId();
        tickLower = _tickLower;
        tickUpper = _tickUpper;
    }

    /// @notice Wrap a V4 position NFT into ERC-20 shares.
    /// @dev Caller must have called `IERC721(positionManager).approve(this, tokenId)` first.
    /// @param tokenId The V4 PositionManager NFT to wrap.
    /// @return liquidity The position's V4 liquidity, equal to the ERC-20 shares minted.
    function wrap(
        uint256 tokenId
    ) external returns (uint128 liquidity) {
        // 1. Read position info BEFORE transfer.
        (PoolKey memory key, PositionInfo info) = positionManager.getPoolAndPositionInfo(tokenId);

        // 2. Validate pool match.
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert WrongPool();

        // 3. Validate exact tick range match.
        if (info.tickLower() != tickLower) revert WrongTickRange();
        if (info.tickUpper() != tickUpper) revert WrongTickRange();

        // 4. Read liquidity. Reject zero-liquidity positions (would mint 0 shares and
        //    permanently lock an empty NFT — useless and confusing).
        liquidity = positionManager.getPositionLiquidity(tokenId);
        if (liquidity == 0) revert ZeroLiquidityPosition();

        // 5. Effects before interactions: record ownership before the external NFT pull.
        wrappedBy[tokenId] = msg.sender;
        wrappedLiquidity[tokenId] = liquidity;

        // 6. Pull NFT via plain transferFrom (not safeTransferFrom — onERC721Received
        //    isn't called, which is what we want: arrival is gated through this method
        //    only). Cast PositionManager to IERC721 since the standard interface lives
        //    on the ERC721 surface.
        IERC721(address(positionManager)).transferFrom(msg.sender, address(this), tokenId);

        // 7. Mint shares equal to liquidity.
        _mint(msg.sender, uint256(liquidity));

        emit Wrapped(tokenId, msg.sender, liquidity);
    }

    /// @notice Burn ERC-20 shares and reclaim a specific position NFT. Only callable by
    ///         the original wrapper of that tokenId.
    /// @dev Caller must hold at least `wrappedLiquidity[tokenId]` ERC-20 shares (they
    ///      are burned here).
    /// @param tokenId The wrapped NFT to redeem.
    /// @return liquidity The liquidity of the redeemed position (same as ERC-20 burned).
    function unwrap(
        uint256 tokenId
    ) external returns (uint128 liquidity) {
        if (wrappedBy[tokenId] != msg.sender) revert NotOriginalWrapper();

        liquidity = wrappedLiquidity[tokenId];
        if (liquidity == 0) revert NotWrapped();

        // 1. Burn shares (reverts on insufficient balance via ERC20).
        _burn(msg.sender, uint256(liquidity));

        // 2. Clear records BEFORE the external NFT transfer (CEI).
        delete wrappedBy[tokenId];
        delete wrappedLiquidity[tokenId];

        // 3. Return NFT.
        IERC721(address(positionManager)).transferFrom(address(this), msg.sender, tokenId);

        emit Unwrapped(tokenId, msg.sender, liquidity);
    }

    /// @notice Reject all external safe-transfers into this contract. NFTs must arrive
    ///         via `wrap()` so we record the original wrapper.
    /// @dev Returning a non-selector value causes safeTransferFrom to revert.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0;
    }
}
