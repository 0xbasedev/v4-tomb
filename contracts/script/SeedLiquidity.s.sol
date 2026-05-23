// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Addresses} from "../src/libs/Addresses.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

/**
 * @title SeedLiquidity
 * @notice Mints the initial full-range V4 LP position in the MONEY/WETH pool. Closes gap
 *         #2 in `docs/GAP_AUDIT.md` — without seed liquidity the first swap (and the
 *         genesis-pool stakers cashing out into MONEY-WETH) would fail with no depth.
 *
 *         Mechanically: pulls `MONEY_AMOUNT` + `WETH_AMOUNT` from the operator's wallet,
 *         approves Permit2 + Permit2-to-PositionManager, then calls
 *         `positionManager.modifyLiquidities(MINT_POSITION + SETTLE_PAIR)` at the
 *         **wrapper's exact tick range** (full range, `minUsableTick(60)` to
 *         `maxUsableTick(60)`). The resulting position NFT lands in the operator's
 *         wallet — they can later wrap it via `V4PositionWrapper.wrap(tokenId)` and stake
 *         the shares in `MainRewardPool` to start earning, OR lock it (transfer to a
 *         zero/burn address) to make the liquidity protocol-owned forever.
 *
 *         Where the assets come from (per `docs/tomb-skill/references/HOW_IT_WORKED.md`):
 *           - **MONEY**: from the 9,000-MONEY airdrop wallet allocation. The operator
 *             transfers however much they want to seed into the operator wallet first.
 *           - **WETH**: from team funds. Deposit ETH to the OP-stack predeploy at
 *             `0x4200000000000000000000000000000000000006` to mint WETH 1:1.
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY — operator signing the tx. Holds MONEY + WETH.
 *           MONEY                — the deployed $MONEY address (see docs/DEPLOYED.md).
 *           HOOK                 — the deployed PegDefenseHook address.
 *           MONEY_AMOUNT         — wei of MONEY to deposit (e.g., 3000 ether).
 *           WETH_AMOUNT          — wei of WETH to deposit (e.g., 1 ether).
 */
contract SeedLiquidity is Script {
    using StateLibrary for IPoolManager;

    struct Inputs {
        address operator;
        address money;
        address weth;
        address hook;
        uint256 moneyAmount;
        uint256 wethAmount;
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Inputs memory i = Inputs({
            operator: vm.addr(pk),
            money: vm.envAddress("MONEY"),
            weth: Addresses.weth(),
            hook: vm.envAddress("HOOK"),
            moneyAmount: vm.envUint("MONEY_AMOUNT"),
            wethAmount: vm.envUint("WETH_AMOUNT")
        });

        PoolKey memory poolKey = _buildPoolKey(i);
        uint128 liquidity = _computeLiquidity(poolKey, i);

        _logHeader(i, liquidity);

        vm.startBroadcast(pk);
        _approvePermit2(i);
        uint256 tokenId = _mintPosition(poolKey, liquidity, i);
        vm.stopBroadcast();

        console2.log("\nseed position minted, tokenId:", tokenId);
        console2.log("\nNext steps (operator decisions):");
        console2.log("  - Verify NFT in operator's wallet via PositionManager.ownerOf");
        console2.log("  - To lock liquidity forever: transfer NFT to a burn address");
        console2.log("  - To earn Main/Share pool rewards: V4PositionWrapper.wrap(tokenId)");
    }

    // ------------------------------------------------------------------
    // Helpers (each function in its own stack frame to dodge stack-too-deep)
    // ------------------------------------------------------------------

    function _buildPoolKey(
        Inputs memory i
    ) internal pure returns (PoolKey memory) {
        (Currency c0, Currency c1) = i.money < i.weth
            ? (Currency.wrap(i.money), Currency.wrap(i.weth))
            : (Currency.wrap(i.weth), Currency.wrap(i.money));
        return PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(i.hook)
        });
    }

    function _computeLiquidity(
        PoolKey memory poolKey,
        Inputs memory i
    ) internal view returns (uint128 liquidity) {
        IPoolManager pm = IPoolManager(Addresses.poolManager());
        (uint160 sqrtPriceX96,,,) = pm.getSlot0(poolKey.toId());
        require(sqrtPriceX96 != 0, "SeedLiquidity: pool not initialized");

        (uint256 amount0Max, uint256 amount1Max) =
            i.money < i.weth ? (i.moneyAmount, i.wethAmount) : (i.wethAmount, i.moneyAmount);

        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(60)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(60)),
            amount0Max,
            amount1Max
        );
        require(liquidity > 0, "SeedLiquidity: insufficient liquidity");
    }

    function _approvePermit2(
        Inputs memory i
    ) internal {
        IAllowanceTransfer permit2 = IAllowanceTransfer(Addresses.permit2());
        IPositionManager positionManager = IPositionManager(Addresses.positionManager());

        IERC20(i.money).approve(address(permit2), type(uint256).max);
        IERC20(i.weth).approve(address(permit2), type(uint256).max);
        permit2.approve(i.money, address(positionManager), type(uint160).max, type(uint48).max);
        permit2.approve(i.weth, address(positionManager), type(uint160).max, type(uint48).max);
    }

    function _mintPosition(
        PoolKey memory poolKey,
        uint128 liquidity,
        Inputs memory i
    ) internal returns (uint256 tokenId) {
        IPositionManager positionManager = IPositionManager(Addresses.positionManager());
        tokenId = positionManager.nextTokenId();

        (uint256 amount0Max, uint256 amount1Max) =
            i.money < i.weth ? (i.moneyAmount, i.wethAmount) : (i.wethAmount, i.moneyAmount);

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            poolKey,
            TickMath.minUsableTick(60),
            TickMath.maxUsableTick(60),
            uint256(liquidity),
            uint128(amount0Max),
            uint128(amount1Max),
            i.operator,
            bytes("")
        );
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);

        // Deadline buffer must cover the gap between forge script simulation and broadcast.
        // 1 hour is conservative; mainnet would tighten this.
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1 hours);
    }

    function _logHeader(
        Inputs memory i,
        uint128 liquidity
    ) internal pure {
        console2.log("=== SeedLiquidity ===");
        console2.log("operator: ", i.operator);
        console2.log("money:    ", i.money);
        console2.log("weth:     ", i.weth);
        console2.log("hook:     ", i.hook);
        console2.log("MONEY in: ", i.moneyAmount);
        console2.log("WETH in:  ", i.wethAmount);
        console2.log("liquidity:", uint256(liquidity));
    }
}
