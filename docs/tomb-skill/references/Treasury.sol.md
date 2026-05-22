# Treasury.sol — Full Annotated Source

Solidity 0.6.12. Deployed at `0xF50c6dAAAEC271B56FCddFBC38F0b56cA45E6f0d` on Fantom Opera.

## Imports & Interfaces

```solidity
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./lib/Babylonian.sol";       // sqrt
import "./owner/Operator.sol";       // two-role ownership (owner + operator)
import "./utils/ContractGuard.sol";  // onlyOneBlock modifier
import "./interfaces/IBasisAsset.sol"; // mint/burnFrom interface
import "./interfaces/IOracle.sol";     // consult/twap/update
import "./interfaces/IMasonry.sol";    // allocateSeigniorage/setOperator/setLockUp
```

`IBondTreasury` interface (inline):
```solidity
interface IBondTreasury {
    function totalVested() external view returns (uint256);
}
```

## ContractGuard

`onlyOneBlock` modifier: ensures a function can only be called once per block. Prevents same-block re-entrancy patterns.

## Epoch System

```
PERIOD = 6 hours

nextEpochPoint() = startTime + (epoch * PERIOD)
```

The `checkEpoch` modifier:
1. Requires `now >= nextEpochPoint()`
2. Increments `epoch`
3. Resets `epochSupplyContractionLeft`:
   - If TOMB > ceiling: set to 0 (no bond buying when above peg)
   - Else: set to `circulatingSupply * maxSupplyContractionPercent / 10000`

## Core Functions

### initialize()

Sets all addresses and default parameters. Can only be called once (`notInitialized` modifier).
Key defaults set here:
- `tombPriceOne = 1e18`
- `tombPriceCeiling = 1.01e18`
- `supplyTiers` and `maxExpansionTiers` arrays (9 tiers each)
- `bootstrapEpochs = 12`, `bootstrapSupplyExpansionPercent = 500` (5%)
- `maxSupplyContractionPercent = 300` (3%)
- `maxDebtRatioPercent = 3500` (35%)
- `seigniorageExpansionFloorPercent = 3500` (35%)
- `bondDepletionFloorPercent = 10000` (100%)
- `premiumThreshold = 110`, `premiumPercent = 7000`
- `seigniorageSaved` = current TOMB balance of treasury

### allocateSeigniorage() — Full Logic

```
modifiers: onlyOneBlock, checkCondition, checkEpoch, checkOperator
```

```
1. _updateTombPrice()  // calls oracle.update()
2. previousEpochTombPrice = getTombPrice()
3. tombSupply = getTombCirculatingSupply() - seigniorageSaved
4. _sendToBondTreasury(tombSupply * bondSupplyExpansionPercent / 10000)

5. if (epoch < bootstrapEpochs):
     _sendToMasonry(tombSupply * bootstrapSupplyExpansionPercent / 10000)
   else:
     if (previousEpochTombPrice > tombPriceCeiling):
       bondSupply = IERC20(tbond).totalSupply()
       _percentage = previousEpochTombPrice - tombPriceOne
       _mse = _calculateMaxSupplyExpansionPercent(tombSupply) * 1e14
       _percentage = min(_percentage, _mse)
       
       if (seigniorageSaved >= bondSupply * bondDepletionFloorPercent / 10000):
         // DEBT-FREE: full expansion to masonry
         _savedForMasonry = tombSupply * _percentage / 1e18
         _savedForBond = 0
       else:
         // DEBT PHASE: split
         _seigniorage = tombSupply * _percentage / 1e18
         _savedForMasonry = _seigniorage * seigniorageExpansionFloorPercent / 10000  // 35%
         _savedForBond = _seigniorage - _savedForMasonry                              // 65%
         if (mintingFactorForPayingDebt > 0):
           _savedForBond = _savedForBond * mintingFactorForPayingDebt / 10000
       
       if (_savedForMasonry > 0): _sendToMasonry(_savedForMasonry)
       if (_savedForBond > 0):
         seigniorageSaved += _savedForBond
         IBasisAsset(tomb).mint(address(this), _savedForBond)
         emit TreasuryFunded(now, _savedForBond)
```

### _sendToMasonry(amount)

```
1. IBasisAsset(tomb).mint(address(this), amount)
2. if daoFundSharedPercent > 0:
     daoAmount = amount * daoFundSharedPercent / 10000
     IERC20(tomb).transfer(daoFund, daoAmount)
3. if devFundSharedPercent > 0:
     devAmount = amount * devFundSharedPercent / 10000
     IERC20(tomb).transfer(devFund, devAmount)
4. remainder = amount - daoAmount - devAmount
5. IERC20(tomb).safeApprove(masonry, remainder)
6. IMasonry(masonry).allocateSeigniorage(remainder)
```

### _sendToBondTreasury(amount)

Handles POL bond treasury:
```
treasuryBalance = IERC20(tomb).balanceOf(bondTreasury)
treasuryVested = IBondTreasury(bondTreasury).totalVested()
if (treasuryVested >= treasuryBalance): return  // already fully vested, skip
unspent = treasuryBalance - treasuryVested
if (amount > unspent):
  IBasisAsset(tomb).mint(bondTreasury, amount - unspent)
// never transfers from this contract; only mints directly to bondTreasury
```

### buyBonds() — Full Logic

```
modifiers: onlyOneBlock, checkCondition, checkOperator
```

```
tombPrice = getTombPrice()
require tombPrice == targetPrice            // slippage check
require tombPrice < tombPriceOne           // below peg
require _tombAmount <= epochSupplyContractionLeft

_rate = getBondDiscountRate()
  → if discountPercent == 0: rate = tombPriceOne (1:1)
  → else: rate = 1 + (1e18/tombPrice - 1) * discountPercent/10000
  → capped at maxDiscountRate

_bondAmount = _tombAmount * _rate / 1e18

newBondSupply = tbond.totalSupply() + _bondAmount
require newBondSupply <= getTombCirculatingSupply() * maxDebtRatioPercent / 10000

IBasisAsset(tomb).burnFrom(msg.sender, _tombAmount)
IBasisAsset(tbond).mint(msg.sender, _bondAmount)
epochSupplyContractionLeft -= _tombAmount
_updateTombPrice()
```

### redeemBonds() — Full Logic

```
modifiers: onlyOneBlock, checkCondition, checkOperator
```

```
tombPrice = getTombPrice()
require tombPrice == targetPrice
require tombPrice > tombPriceCeiling        // above peg

_rate = getBondPremiumRate()
  → if tombPrice < premiumThreshold (1.10): rate = tombPriceOne (1:1)
  → else: rate = 1 + (tombPrice - 1) * premiumPercent/10000
  → capped at maxPremiumRate

_tombAmount = _bondAmount * _rate / 1e18
require IERC20(tomb).balanceOf(address(this)) >= _tombAmount

seigniorageSaved -= min(seigniorageSaved, _tombAmount)
IBasisAsset(tbond).burnFrom(msg.sender, _bondAmount)
IERC20(tomb).safeTransfer(msg.sender, _tombAmount)
_updateTombPrice()
```

## View Functions

- `getTombCirculatingSupply()`: `totalSupply - sum(balance[excludedAddr])`
- `getBurnableTombLeft()`: how much more TOMB can be burned this epoch for bonds
- `getRedeemableBonds()`: how many bonds can be redeemed right now given treasury balance
- `getBondDiscountRate()`: current rate for bond purchase
- `getBondPremiumRate()`: current rate for bond redemption
- `getReserve()`: alias for `seigniorageSaved`
- `nextEpochPoint()`: timestamp of next epoch start

## Governance Admin Functions (onlyOperator)

- `setOperator`, `setMasonry`, `setBondTreasury`, `setTombOracle`
- `setTombPriceCeiling` (range: [1.0, 1.2])
- `setBootstrap` (up to 120 epochs bootstrap, 1–10% rate)
- `setExtraFunds` (DAO/dev fund addresses and shares, DAO ≤ 30%, dev ≤ 10%)
- `setMaxDiscountRate`, `setMaxPremiumRate`, `setDiscountPercent`, `setPremiumPercent`
- `setMintingFactorForPayingDebt` (range: [100%, 200%])
- `masonrySetOperator`, `masonrySetLockUp`, `masonryAllocateSeigniorage`
- `governanceRecoverUnsupported` (cannot drain TOMB, TBOND, TSHARE)
