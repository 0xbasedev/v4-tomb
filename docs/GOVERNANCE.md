# Governance

How Old Money's admin roles are organized and how the deployer EOA hands them off to a Timelock after launch.

## The role hierarchy

The protocol has two kinds of admin role:

**Ownable2Step `owner`** — rotates the `trustees` role and (post-rotation) can be transferred via two-step `transferOwnership` + `acceptOwnership`. Held by:
- `OldMoney` (the $MONEY token)
- `Estate` (the $ESTATE token)
- `TrustNote` (the $TRUSTNOTE bond)
- `PegDefenseHook`

**Single-step `operator`** — has direct mutate-the-config rights; rotation via `setOperator(newOperator)` from the current operator (irreversible from the prior holder). Held by:
- `Treasury` — main protocol parameters
- `Boardroom` — calls `allocateSeigniorage` from Treasury (operator stays as `Treasury` forever)
- `GenesisRewardPool`, `MainRewardPool`, `ShareRewardPool` — manages pool entries
- `Timelock` — has its own `admin` field (same model)

The intentional split: `owner` controls who can mutate config (slow-moving, queueable); `operator`/`trustees` are the active mutators (fast-moving, but bounded by who `owner` allows).

## State immediately after `Deploy.s.sol`

| Contract | owner | trustees / operator |
|---|---|---|
| `OldMoney` | deployer EOA | `Treasury` |
| `Estate` | deployer EOA | `Treasury` |
| `TrustNote` | deployer EOA | `Treasury` |
| `PegDefenseHook` | deployer EOA | deployer EOA |
| `Treasury` | n/a | deployer EOA (operator) |
| `Boardroom` | n/a | `Treasury` (operator) |
| `Oracle` | n/a | n/a (no admin) |
| `GenesisRewardPool` | n/a | deployer EOA (operator) |
| `MainRewardPool` | n/a | deployer EOA (operator) |
| `ShareRewardPool` | n/a | deployer EOA (operator) |
| `V4PositionWrapper` | n/a | n/a (no admin) |

The deployer holds significant power at this point. Sprint 14 closes that.

## The ceremony

Three on-chain stages, one off-chain wait between stages 2 and 3.

### Stage 1 — Deploy the Timelock

```bash
TIMELOCK_ADMIN=<your_eoa_or_multisig> \
TIMELOCK_DELAY=86400 \
DEPLOYER_PRIVATE_KEY=<deployer_pk> \
forge script script/DeployTimelock.s.sol --rpc-url base --broadcast --verify
```

`TIMELOCK_DELAY` is in seconds. Bounded to `[1 days, 30 days]` by the Timelock contract. For mainnet pick at least 24h (86400) so the community has time to react. For testnet you can also pick 24h — anything shorter is rejected.

`TIMELOCK_ADMIN` is the address that will queue + execute Timelock transactions. Start with the deployer EOA; rotate it to a multisig later via `setPendingAdmin` (which itself must go through the queue/execute cycle).

Output: a deployed `Timelock` address. Save it for the next stage.

### Stage 2 — Transfer ownership + queue acceptance

```bash
TIMELOCK=<addr_from_stage_1> \
MONEY=<addr> ESTATE=<addr> TRUSTNOTE=<addr> HOOK=<addr> \
TREASURY=<addr> GENESIS_REWARD_POOL=<addr> MAIN_REWARD_POOL=<addr> SHARE_REWARD_POOL=<addr> \
DEPLOYER_PRIVATE_KEY=<deployer_pk> \
forge script script/RotateGovernanceQueue.s.sol --rpc-url base --broadcast
```

The script does, in one transaction sequence:

1. `transferOwnership(timelock)` on **OldMoney, Estate, TrustNote, PegDefenseHook** (Ownable2Step → sets `pendingOwner = timelock`, NOT yet final).
2. `transferTrustees(timelock)` on `PegDefenseHook` (one-step — irreversible from deployer's side after this).
3. `setOperator(timelock)` on `Treasury`, `GenesisRewardPool`, `MainRewardPool`, `ShareRewardPool` (one-step — irreversible).
4. `timelock.queueTransaction(target, 0, "acceptOwnership()", "", eta)` four times — once per Ownable2Step contract. `eta` defaults to `now + timelock.delay() + 60 seconds`. The script logs the exact `eta` value for use in stage 3.

After this script completes:
- The deployer EOA has lost `operator` on Treasury + reward pools.
- The deployer EOA has lost `trustees` on the hook (Timelock now controls tax tiers).
- The tokens + hook have `pendingOwner = timelock` but ownership has NOT fully transferred yet.
- Four `acceptOwnership()` transactions sit queued in the Timelock.

### (Off-chain) Wait the delay

Real wall-clock time. For mainnet at 24h delay, this is one day. Operations team should:
- Verify the queue addresses on BaseScan
- Confirm no surprise transactions are queued
- Wait for `eta` (logged by stage 2)

### Stage 3 — Execute the queued transfers

```bash
TIMELOCK=<same> MONEY=<same> ESTATE=<same> TRUSTNOTE=<same> HOOK=<same> \
ETA=<value_from_stage_2_log> \
DEPLOYER_PRIVATE_KEY=<deployer_pk> \
forge script script/RotateGovernanceExecute.s.sol --rpc-url base --broadcast
```

Reverts if `block.timestamp < eta` (too early) or `block.timestamp > eta + 14 days` (past grace period). Otherwise: executes all four `acceptOwnership()` calls via Timelock. After this, the Timelock is the formal owner of every Ownable2Step contract.

## Final state after the ceremony

| Contract | owner / trustees / operator |
|---|---|
| `OldMoney` | owner = **Timelock**; trustees = Treasury |
| `Estate` | owner = **Timelock**; trustees = Treasury |
| `TrustNote` | owner = **Timelock**; trustees = Treasury |
| `PegDefenseHook` | owner = **Timelock**; trustees = **Timelock** |
| `Treasury` | operator = **Timelock** |
| `Boardroom` | operator = Treasury (unchanged — protocol-internal) |
| `GenesisRewardPool` | operator = **Timelock** |
| `MainRewardPool` | operator = **Timelock** |
| `ShareRewardPool` | operator = **Timelock** |
| `Oracle` | no admin (unchanged) |
| `V4PositionWrapper` | no admin (unchanged) |
| `Timelock` | admin = whatever you set in stage 1 |

What changed: the deployer EOA can no longer mutate any protocol parameter. Every config change now requires queueing in the Timelock + waiting the delay + executing.

What stayed: Treasury still operates Boardroom (it has to — `allocateSeigniorage` is called by Treasury). Treasury is still trustees on all tokens (it has to — Treasury mints/burns during expansion/contraction).

## What the Timelock can do

After the ceremony, the Timelock's `admin` is the only address that can mutate protocol parameters. Examples:

**Change the dynamic fee tiers on the hook:**
```
target = HOOK
signature = "setFees(uint24,uint24,uint24,uint24)"
data = abi.encode(500, 2000, 8000, 25_000)
```

**Tune the tax tier table:**
```
target = HOOK
signature = "setTaxTiersRate(uint256,uint256)"
data = abi.encode(7, 1200)  // tier 7 (at peg) -> 12%
```

**Rotate Treasury's operator (e.g., to a future v2 controller):**
```
target = TREASURY
signature = "setOperator(address)"
data = abi.encode(newOperator)
```

**Rotate the Timelock's own admin (queue, then accept by new admin):**
```
target = TIMELOCK
signature = "setPendingAdmin(address)"
data = abi.encode(newMultisig)
// later: newMultisig calls timelock.acceptAdmin() — no delay on the accept step
```

The Timelock's `setDelay` is itself queueable — an admin who wants to shorten the delay must wait the current delay before doing so. Commitment device.

## Invariants this design preserves

1. **Treasury is the sole minter of MONEY / TRUSTNOTE / ESTATE** — Treasury holds `trustees` on all three. Even the Timelock can't directly mint; it would have to first call `transferTrustees(newMinter)` (queued) → then the new minter could mint. That's still a one-day delay before any unscheduled mint can happen.
2. **Boardroom can't be bypassed** — Boardroom's operator stays as Treasury forever. Routing `allocateSeigniorage` through the Timelock would require queueing each epoch, which is impractical.
3. **The wrapper is permissionless** — V4PositionWrapper has no admin to rotate; users always control their own NFTs / shares.

## Rollback

If something is wrong during stage 2/3:

- Between stages 2 and 3: the Timelock admin can call `cancelTransaction` to cancel any queued tx before `eta`. But you've still lost `trustees` on the hook and `operator` on Treasury + reward pools — those rotations are one-step and the deployer can't reverse them.
- After stage 3: ownership has fully transferred. Recovery requires the Timelock admin to queue a `transferOwnership(newRecipient)` call on each affected contract, wait the delay, and execute.

In short: stage 2 is a serious commitment. Don't run it without verifying every input address against `docs/DEPLOYED.md`.
