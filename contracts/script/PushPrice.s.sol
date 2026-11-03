// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

/**
 * @title PushPrice
 * @notice One-shot V4 swap on MONEY/WETH pool, bypassing UniversalRouter.
 *         Deploys a fresh PoolSwapTest helper, approves it for the input
 *         token, swaps. Use for testnet experiments — to push price below peg
 *         (activates bond acquire) or above premium (activates bond redeem).
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY — signer; must hold input token + ETH for gas.
 *           MONEY address is resolved from the selected manifest deployment.
 *           HOOK address is resolved from the selected manifest deployment.
 *           AMOUNT_IN            — wei of input (e.g. 50000000000000000 = 0.05).
 *           DIRECTION            — "sell-money" or "buy-money".
 *
 *         Example:
 *           export MONEY=0xb650... HOOK=0x8FF8...
 *           export AMOUNT_IN=50000000000000000 DIRECTION=sell-money
 *           forge script script/PushPrice.s.sol --rpc-url "$RPC_URL" --broadcast --slow
 */
contract PushPrice is NetworkConfig {
    struct Inputs {
        uint256 pk;
        address signer;
        address money;
        address hook;
        uint256 amountIn;
        bool sellMoney;
    }

    function run() external {
        _network();
        Inputs memory i = _readInputs();
        PoolKey memory poolKey = _buildPoolKey(i);
        bool zeroForOne = _computeDirection(i);
        address tokenIn = i.sellMoney ? i.money : _infrastructure("weth");

        _logHeader(i, zeroForOne, tokenIn);
        _doSwap(i, poolKey, zeroForOne, tokenIn);
        _logFooter();
    }

    function _readInputs() internal view returns (Inputs memory i) {
        i.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        i.signer = vm.addr(i.pk);
        i.money = _deployment("money");
        i.hook = _deployment("hook");
        i.amountIn = vm.envUint("AMOUNT_IN");

        string memory direction = vm.envString("DIRECTION");
        i.sellMoney = keccak256(bytes(direction)) == keccak256(bytes("sell-money"));
        if (!i.sellMoney && keccak256(bytes(direction)) != keccak256(bytes("buy-money"))) {
            revert("DIRECTION must be 'sell-money' or 'buy-money'");
        }
    }

    function _buildPoolKey(
        Inputs memory i
    ) internal view returns (PoolKey memory) {
        address weth = _infrastructure("weth");
        (Currency c0, Currency c1) = i.money < weth
            ? (Currency.wrap(i.money), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(i.money));
        return PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(i.hook)
        });
    }

    function _computeDirection(
        Inputs memory i
    ) internal view returns (bool zeroForOne) {
        // WETH sorts as currency0 (0x4200... < 0xb650...). Selling MONEY
        // (currency1 -> currency0) means zeroForOne = false. Buying MONEY = true.
        bool wethIsToken0 = _infrastructure("weth") < i.money;
        return wethIsToken0 ? !i.sellMoney : i.sellMoney;
    }

    function _doSwap(
        Inputs memory i,
        PoolKey memory poolKey,
        bool zeroForOne,
        address tokenIn
    ) internal {
        vm.startBroadcast(i.pk);

        PoolSwapTest swapTest = new PoolSwapTest(IPoolManager(_infrastructure("poolManager")));
        console2.log("PoolSwapTest:     ", address(swapTest));

        IERC20(tokenIn).approve(address(swapTest), i.amountIn);

        uint160 sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne, amountSpecified: -int256(i.amountIn), sqrtPriceLimitX96: sqrtPriceLimitX96
        });
        PoolSwapTest.TestSettings memory settings =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

        swapTest.swap(poolKey, params, settings, bytes(""));

        vm.stopBroadcast();
    }

    function _logHeader(
        Inputs memory i,
        bool zeroForOne,
        address tokenIn
    ) internal pure {
        console2.log("=== PushPrice ===");
        console2.log("signer:        ", i.signer);
        console2.log("tokenIn:       ", tokenIn);
        console2.log("amountIn wei:  ", i.amountIn);
        console2.log("zeroForOne:    ", zeroForOne);
    }

    function _logFooter() internal pure {
        console2.log("\nSwap complete.");
        console2.log("Next: Manual Tick (or cast send oracle.update) to refresh TWAP,");
        console2.log("then /notes Acquire panel activates when oracle reports sub-peg.");
    }
}
