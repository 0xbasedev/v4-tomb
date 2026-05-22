# Masonry.sol — Full Annotated Source

Solidity 0.6.12. Deployed at `0x8764DE60236C5843D9faEB1B638fbCE962773B67` on Fantom Opera.

## ShareWrapper Base Contract

```solidity
contract ShareWrapper {
    IERC20 public share;               // TSHARE token
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    function stake(uint256 amount) public virtual {
        _totalSupply += amount;
        _balances[msg.sender] += amount;
        share.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) public virtual {
        require(_balances[msg.sender] >= amount, "withdraw request greater than staked");
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;
        share.safeTransfer(msg.sender, amount);
    }
}
```

## Key Data Structures

### Masonseat (per-user state)
```solidity
struct Masonseat {
    uint256 lastSnapshotIndex;  // index into history[] at last interaction
    uint256 rewardEarned;       // accumulated unclaimed TOMB
    uint256 epochTimerStart;    // treasury.epoch() value at last interaction
}
```

### MasonrySnapshot (per-epoch state)
```solidity
struct MasonrySnapshot {
    uint256 time;            // block.number
    uint256 rewardReceived;  // TOMB amount sent by Treasury this snapshot
    uint256 rewardPerShare;  // cumulative rewardPerShare (accrual-style)
}
```

`history[]` is an array of snapshots. New snapshots are appended by `allocateSeigniorage()`.

## Lockup Configuration

```
withdrawLockupEpochs = 6   // must wait 6 epochs after last interaction to withdraw TSHARE
rewardLockupEpochs   = 3   // must wait 3 epochs after last interaction to claim TOMB
```

Both are settable by operator (Treasury) via `setLockUp()`. Any interaction resets `epochTimerStart` to `treasury.epoch()`.

## Core Functions

### stake(uint256 amount)

```
modifier: onlyOneBlock, notInitialized(mason), updateReward(msg.sender)
```

1. `updateReward` modifier:
   - Computes rewards earned since `lastSnapshotIndex`
   - Adds to `rewardEarned`
   - Updates `lastSnapshotIndex` to latest snapshot
2. Calls `ShareWrapper.stake(amount)` (transfers TSHARE in)
3. `masons[msg.sender].epochTimerStart = treasury.epoch()` — **resets BOTH lockups**
4. Emits `Staked(msg.sender, amount)`

### withdraw(uint256 amount)

```
modifier: onlyOneBlock, masonExists, updateReward(msg.sender)
```

1. `require(masons[msg.sender].epochTimerStart + withdrawLockupEpochs <= treasury.epoch())`
2. `claimReward()` — claims pending rewards if reward lockup has passed
3. Calls `ShareWrapper.withdraw(amount)` (transfers TSHARE out)
4. Emits `Withdrawn(msg.sender, amount)`

### claimReward()

```
modifier: updateReward(msg.sender)
```

1. `require(masons[msg.sender].epochTimerStart + rewardLockupEpochs <= treasury.epoch())`
2. `reward = masons[msg.sender].rewardEarned`
3. If reward > 0:
   - `masons[msg.sender].rewardEarned = 0`
   - `IERC20(tomb).safeTransfer(msg.sender, reward)`
4. `masons[msg.sender].epochTimerStart = treasury.epoch()` — **resets BOTH lockups**
5. Emits `RewardPaid(msg.sender, reward)`

### exit()

Convenience: calls `withdraw(balanceOf(msg.sender))` then `claimReward()`.

### allocateSeigniorage(uint256 amount) — called by Treasury

```
modifier: onlyOneBlock, onlyOperator
```

1. `require(totalSupply() > 0)` — no-op if nobody staked
2. `rewardPerShare = amount * 1e18 / totalSupply()`
3. Appends new `MasonrySnapshot { time: block.number, rewardReceived: amount, rewardPerShare: latestSnapshotRewardPerShare + rewardPerShare }`
4. `IERC20(tomb).safeTransferFrom(msg.sender, address(this), amount)`
5. Emits `RewardAdded(msg.sender, amount)`

Note: Treasury must `safeApprove(masonry, amount)` before calling this.

## Reward Calculation (updateReward modifier)

```solidity
modifier updateReward(address mason) {
    if (mason != address(0)) {
        Masonseat memory seat = masons[mason];
        seat.rewardEarned = earned(mason);
        seat.lastSnapshotIndex = latestSnapshotIndex();
        masons[mason] = seat;
    }
    _;
}

function earned(address mason) public view returns (uint256) {
    uint256 latestRPS = getLatestSnapshot().rewardPerShare;
    uint256 storedRPS = getLastSnapshotOf(mason).rewardPerShare;
    return balanceOf(mason)
        .mul(latestRPS.sub(storedRPS))
        .div(1e18)
        .add(masons[mason].rewardEarned);
}
```

The snapshot system is cumulative: each snapshot's `rewardPerShare` is the running total. To get earnings since last interaction, compute `latestRPS - storedRPS`. This is the classic "reward debt" pattern.

## View Functions

- `latestSnapshotIndex()`: `history.length - 1`
- `getLatestSnapshot()`: latest MasonrySnapshot
- `getLastSnapshotIndexOf(mason)`: mason's stored snapshot index
- `getLastSnapshotOf(mason)`: snapshot at mason's stored index
- `canWithdraw(mason)`: `epochTimerStart + withdrawLockupEpochs <= treasury.epoch()`
- `canClaimReward(mason)`: `epochTimerStart + rewardLockupEpochs <= treasury.epoch()`
- `epoch()`: delegated to `treasury.epoch()`
- `nextEpochPoint()`: delegated to `treasury.nextEpochPoint()`
- `getTombPrice()`: delegated to `treasury.getTombPrice()`

## Initialization

```solidity
function initialize(IERC20 _tomb, IERC20 _share, ITreasury _treasury) public notInitialized {
    tomb = _tomb;
    share = _share;
    treasury = _treasury;
    MasonrySnapshot memory genesisSnapshot = MasonrySnapshot({
        time: block.number,
        rewardReceived: 0,
        rewardPerShare: 0
    });
    history.push(genesisSnapshot);
    withdrawLockupEpochs = 6;
    rewardLockupEpochs = 3;
    initialized = true;
    operator = msg.sender;
}
```

## Important Nuances

1. **Reward snapshots are cumulative**: `rewardPerShare` in each snapshot is a running sum, not per-epoch delta. This means you must subtract the user's stored `rewardPerShare` from the latest to get what they earned.

2. **allocateSeigniorage fails silently if totalSupply == 0**: It reverts with `"Masonry: Cannot allocate when totalSupply is 0"`. Treasury calls this inside `_sendToMasonry()` so if nobody is staked, that TOMB is never minted.

3. **epochTimerStart is NOT the epoch when you staked, it's the epoch of your last interaction**. Even claiming rewards resets the withdraw lockup.

4. **The Masonry holds actual TOMB received from Treasury** (via `safeTransferFrom` in `allocateSeigniorage`). It does not mint TOMB itself — Treasury mints and approves, then Masonry pulls.
