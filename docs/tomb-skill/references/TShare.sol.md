# TShare.sol — Annotated Source

Deployed at `0x4cdF39285D7Ca8eB3f090fDA0C069ba5F4145B37` on Fantom Opera.

## Supply Constants

```solidity
uint256 public constant FARMING_POOL_REWARD_ALLOCATION = 59500 ether;  // to TShareRewardPool
uint256 public constant COMMUNITY_FUND_POOL_ALLOCATION = 5500 ether;   // vested to community
uint256 public constant DEV_FUND_POOL_ALLOCATION       = 5000 ether;   // vested to dev
// Total max: 70,000 TSHARE
```

## Vesting

- `VESTING_DURATION = 365 days`
- Both community and dev fund amounts vest linearly from `startTime` to `endTime = startTime + 365 days`
- Rates computed at deployment:
  - `communityFundRewardRate = COMMUNITY_FUND_POOL_ALLOCATION / VESTING_DURATION`
  - `devFundRewardRate = DEV_FUND_POOL_ALLOCATION / VESTING_DURATION`
- `claimRewards()` function: transfers accrued TSHARE to fund addresses based on elapsed time since last claim

## Distribution in constructor

```solidity
constructor(uint256 _startTime, address _communityFund, address _devFund) {
    _mint(msg.sender, 1 ether);  // initial mint for genesis pools/liquidity
    startTime = _startTime;
    endTime = startTime + VESTING_DURATION;
    
    communityFundRewardRate = COMMUNITY_FUND_POOL_ALLOCATION / VESTING_DURATION;
    devFundRewardRate = DEV_FUND_POOL_ALLOCATION / VESTING_DURATION;
    
    communityFund = _communityFund;
    devFund = _devFund;
}
```

The farming pool allocation (59,500 TSHARE) is minted to the TShareRewardPool address during deployment. The vested allocations accrue over time.

## Key Functions

- `mint(address recipient, uint256 amount)` — onlyOperator. Used by TShareRewardPool to distribute farming rewards.
- `burn(uint256 amount)` — public. Users can burn TSHARE.
- `burnFrom(address account, uint256 amount)` — public. Burns with allowance.
- `claimRewards()` — permissionless. Computes time-weighted accrual for both community and dev funds since last claim and mints to them.

## Notes

- TSHARE is **not** minted by Treasury. Treasury is not the operator of TSHARE.
- The TShareRewardPool is the operator and uses `mint()` to pay out TSHARE rewards to LP stakers.
- Hard supply cap is enforced implicitly through the allocation model (pool + vesting = 70,000 total).
