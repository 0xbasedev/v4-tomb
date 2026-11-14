// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MasonryGenesisSchedule} from "../masonry/MasonryGenesisSchedule.sol";
import {IMasonryBurnableLevel} from "../masonry/MasonryGenesisLPBurnFee.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {MasonryLevelPrice} from "../masonry/MasonryLevelPrice.sol";
import {MasonryRules} from "../masonry/MasonryRules.sol";
import {MasonryTaxHook} from "./MasonryTaxHook.sol";

/// @notice LEVEL sells burn their single tax debit during the Genesis window.
contract MasonryLevelHook is MasonryTaxHook {
    using SafeERC20 for IERC20;

    uint16 public constant GENESIS_MIN_TAX_BPS = 300;
    MasonryGenesisSchedule public immutable schedule;
    address public immutable taxRecipient;
    uint256 public genesisLevelBurned;

    event SellTax(uint256 levelAmount, uint16 rateBps, bool burned);

    constructor(
        IPoolManager manager,
        MasonryGenesisSchedule schedule_,
        OracleConfig memory oracleConfig,
        address level_,
        address usdc,
        address recipient,
        uint24 lpFee,
        int24 tickSpacing
    ) MasonryTaxHook(manager, oracleConfig, level_, usdc, lpFee, tickSpacing) {
        if (address(schedule_).code.length == 0 || recipient == address(0)) revert InvalidConfiguration();
        schedule = schedule_;
        taxRecipient = recipient;
    }

    function level() external view returns (address) {
        return asset;
    }

    function levelIsCurrency0() external view returns (bool) {
        return assetIsCurrency0;
    }

    function _collectTax(
        uint256 amount,
        uint16 rate
    ) internal override {
        poolManager.take(Currency.wrap(asset), address(this), amount);
        bool genesis = schedule.active();
        if (genesis) {
            IMasonryBurnableLevel(asset).burn(amount);
            genesisLevelBurned += amount;
        } else {
            IERC20(asset).safeTransfer(taxRecipient, amount);
        }
        emit SellTax(amount, rate, genesis);
    }

    /// @dev Fire Tax on an X Tomb sell: the higher of the TWAP rate, the projected
    /// post-sale rate, the 7-hour recovery floor and the Genesis minimum.
    function _fireTaxQuote(
        PoolKey calldata key,
        SwapParams calldata params
    ) internal override returns (uint256 fee, uint16 rate) {
        uint16 bootstrapFloor = _bootstrapFloor();
        bool exactInput = params.amountSpecified < 0;
        uint16 recovery = MasonryRules.recoveryFloorBps(raisedBps, BASE_TAX, raisedAt, block.timestamp);
        uint256 twap = _validatedTwap();
        if (twap == 0) revert InvalidOraclePrice();
        uint16 ordinaryFloor = MasonryRules.effectiveSellTaxBps(_target(twap), recovery, BASE_TAX);
        uint16 minimum = ordinaryFloor < bootstrapFloor ? bootstrapFloor : ordinaryFloor;

        // The largest possible net asset input gives a conservative post-sale price.
        // Any higher tax can only reduce the executed net input and price impact.
        SwapParams memory preview = params;
        if (exactInput) {
            uint256 gross = uint256(-params.amountSpecified);
            preview.amountSpecified += int256(FullMath.mulDiv(gross, minimum, BPS));
        }
        (uint256 input, uint160 sqrtPrice) = _project(key, preview);
        uint16 target = MasonryRules.effectiveSellTaxBps(
            _target(twap), _target(MasonryLevelPrice.fromSqrtPrice(sqrtPrice, assetIsCurrency0)), BASE_TAX
        );
        if (target > raisedBps || (block.timestamp - raisedAt >= MasonryRules.FIRE_TAX_RECOVERY && target > BASE_TAX)) {
            raisedBps = target;
            raisedAt = block.timestamp;
        }
        rate = target > minimum ? target : minimum;

        // Exact-output specifies USDC, so gross up the simulated net asset input
        // to make the rate a share of the total asset paid.
        uint256 taxBase = exactInput ? uint256(-params.amountSpecified) : input;
        fee = _taxAmount(taxBase, rate, bootstrapFloor, exactInput);
    }

    function _taxAmount(
        uint256 taxBase,
        uint16 rate,
        uint16 bootstrapFloor,
        bool exactInput
    ) private pure returns (uint256 fee) {
        fee = FullMath.mulDiv(taxBase, rate, exactInput ? BPS : BPS - rate);
        if (bootstrapFloor != 0) {
            uint256 floor = FullMath.mulDivRoundingUp(taxBase, bootstrapFloor, exactInput ? BPS : BPS - bootstrapFloor);
            uint256 ceiling = FullMath.mulDiv(taxBase, MAX_TAX_BPS, exactInput ? BPS : BPS - MAX_TAX_BPS);
            if (floor > ceiling) revert UnrepresentableTax();
            if (fee < floor) fee = floor;
        }
    }

    function _bootstrapFloor() internal view override returns (uint16) {
        return schedule.active() ? GENESIS_MIN_TAX_BPS : 0;
    }

    function _referencePrice() internal pure override returns (uint256) {
        return 1e18;
    }
}
