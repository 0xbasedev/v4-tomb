// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MasonryGenesisSchedule} from "../masonry/MasonryGenesisSchedule.sol";
import {IMasonryBurnableLevel} from "../masonry/MasonryGenesisLPBurnFee.sol";
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

    function _bootstrapFloor() internal view override returns (uint16) {
        return schedule.active() ? GENESIS_MIN_TAX_BPS : 0;
    }

    function _referencePrice() internal pure override returns (uint256) {
        return 1e18;
    }
}
