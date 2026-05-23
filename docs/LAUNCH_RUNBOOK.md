# Old Money — Launch Runbook

The runbook for taking a fresh `Deploy.s.sol` deployment from "contracts exist on chain" to "Trust is operational." Documents every post-deploy action required, when it must run, what role can run it, and the script that wraps it.

**Audience:** the operator (deployer EOA initially, Timelock post-Sprint-14).

**Current state at end of `Deploy.s.sol`:**
- All protocol contracts deployed and initialized.
- $MONEY: 11k to GenesisRewardPool, 140k to MainRewardPool, 9k to airdrop wallet (per `OldMoney.distributeReward` allocations).
- $ESTATE: 59.5k to ShareRewardPool. The 5.5k community-fund vesting + 5k dev-fund vesting begin at the `vestingStart` parameter (default `block.timestamp + 1 hour`).
- Treasury initialized; `bootstrapEpochs=28`, `daoFundSharedPercent=0`, `devFundSharedPercent=0`, no Boardroom seigniorage yet (epoch 0).
- PegDefenseHook bound to the MONEY-WETH V4 pool; `autoCalculateTax=false`, `treasury` slot points at the Treasury contract.
- Main + Share reward pools have V4PositionWrapper registered as PID 0 (weight 100).
- GenesisRewardPool has **no PIDs registered** — the pool is closed until the operator calls `add()`.
- All admin roles still on the deployer EOA. No Timelock rotation yet.

---

## 1 · Pre-Genesis (T-minus 1 hour before window opens)

### 1.1 Seed V4 liquidity

If `SeedLiquidity.s.sol` hasn't run yet (one-time per fresh pool):

```bash
export MONEY=<deployed-money-address>
export HOOK=<deployed-hook-address>
export MONEY_AMOUNT=100000000000000000   # 0.1 MONEY (wei)
export WETH_AMOUNT=100000000000000000    # 0.1 WETH (wei) — must equal MONEY_AMOUNT to land at peg
forge script script/SeedLiquidity.s.sol --rpc-url base_sepolia --broadcast --slow
```

The pool initialized at tick 0 (1 MONEY = 1 WETH). Equal amounts keep the seed at peg.

**Why now:** Without seed liquidity the first swap reverts, oracle never observes a price, and the Treasury can never tick past epoch 0.

### 1.2 Open the Genesis Pool

The operator (currently the deployer EOA) calls `genesisRewardPool.add(allocPoint, token, withUpdate, lastRewardTime)` for each accepted stake token. Run before `poolStartTime` (set in `Deploy.s.sol` to `epochStart`, default `block.timestamp + 1 hour`).

```bash
forge script script/OpenGenesis.s.sol --rpc-url base_sepolia --broadcast
```

Env vars consumed:

- `GENESIS_REWARD_POOL` — the deployed GenesisRewardPool address (from `frontend/src/lib/addresses.ts`)
- `GENESIS_STAKE_TOKENS` — comma-separated list of token addresses to accept (e.g. `"0x4200...0006"` for WETH; add USDC, USDT, etc.)
- `GENESIS_ALLOC_POINTS` — comma-separated per-token weights (e.g. `"100,50"` weights the first token 2× the second)

**Why now:** Until `add()` runs, the frontend's Genesis tab shows "No Stakes Registered" and users can't deposit anything. Need to be live before stakers arrive.

---

## 2 · Genesis Window (24 hours, epochs 0–4)

No operator actions required. Stakers deposit outside ERC-20s; rewards accrue. The frontend's `/vault` Genesis tab is fully functional.

Operational chores (do once at launch, then automate):

### 2.1 Keep the epoch advancing

Anyone can call `treasury.allocateSeigniorage()` post-`nextEpochPoint`. The call internally invokes `oracle.update()` (wrapped in try/catch so a pre-epoch oracle revert doesn't block) so the TWAP refreshes inside the same transaction. The keeper just needs to call allocateSeigniorage on every 6h boundary.

**Option A — GitHub Actions (recommended for testnet, simple for mainnet)**

The repo ships `.github/workflows/keeper.yml` which runs `script/KeeperTick.s.sol` every 30 minutes on a cron. To enable:

1. Generate a fresh wallet for the keeper. ETH-for-gas only — NO admin roles. The keeper wallet must be disjoint from the deployer / multisig.
2. Fund it (a few finney is enough for months of operation on Base).
3. In repo Settings → Secrets and variables → Actions:
   - Secret: `KEEPER_PRIVATE_KEY` (no 0x prefix? actually with 0x — check forge syntax)
   - Secret: `BASE_SEPOLIA_RPC_URL` (e.g. Alchemy or QuickNode endpoint)
   - Secret: `BASE_RPC_URL` (for mainnet; can be skipped pre-launch)
   - Variable: `TREASURY_BASE_SEPOLIA` (the deployed Treasury address from `frontend/src/lib/addresses.ts`)
   - Variable: `TREASURY_BASE` (for mainnet; can be set later)
4. The workflow will fire `*/30 * * * *`. Manual run via Actions tab → keeper → Run workflow.

GitHub Actions cron drifts up to ~15 min during heavy scheduling windows. With a 6h epoch and a 30-min cadence, you get ~12 attempts per epoch — more than enough.

**Option B — local cron / Defender / Gelato**

Any setup that runs `script/KeeperTick.s.sol` every 30 minutes against the right RPC works. The script is a clean no-op when there's nothing to do.

```bash
# Manual one-off call
export KEEPER_PRIVATE_KEY=0x...
export TREASURY=0x928B72a3E734d6D07606d9655c55289D3a224c20
forge script script/KeeperTick.s.sol --rpc-url base_sepolia --broadcast --slow
```

**Why this matters:** Without the keeper, `allocateSeigniorage` never fires; the Treasury's epoch counter stalls at whatever value it had when the keeper was last on. No seigniorage flows, the Boardroom never pays out, bonds can't redeem during expansion. The keeper is the heartbeat of the protocol.

---

## 3 · Main + Share Pools Open (T+24h, end of Genesis)

No operator actions required. `poolStartTime` is set in `Deploy.s.sol` to the same `epochStart` the Treasury uses — Main + Share emit from second 1, but they don't pay anything out until users wrap their V4 LP positions and stake the wrapper shares (T+24h is when users start doing that en masse, after pulling capital out of Genesis).

### 3.1 (User-facing) The wrap flow

1. User mints a MONEY-WETH V4 position via PositionManager (full range, tick spacing 60).
2. User calls `V4PositionWrapper.wrap(tokenId)` — wrapper takes the NFT, mints ERC-20 shares.
3. User stakes shares in `MainRewardPool.deposit(0, amount)` or `ShareRewardPool.deposit(0, amount)`.

The frontend's `/vault` Main + Share tabs show this flow. The wrap UI itself isn't shipped yet — Sprint C polish item.

---

## 4 · Post-Bootstrap (after epoch 28, ~T+7 days)

Bootstrap guarantees 4.5% supply expansion to Boardroom regardless of price. After epoch 28 the Treasury switches to oracle-driven expansion/contraction. This is the moment to enable the rest of the monetization rails.

### 4.1 Enable hook tax (optional, recommended)

```bash
cast send <hook> 'setAutoCalculateTax(bool)' true --rpc-url base_sepolia --private-key $OPERATOR_PRIVATE_KEY
```

**Effect:** PegDefenseHook starts taking the schedule's tax on every MONEY sell. Below `burnThreshold` (1.10 ETH), the tax is burned. At or above, it routes to `hook.treasury()` — which by default is the Treasury contract.

**Why this lever exists:** Tomb-faithful peg defense. The first 28 epochs run without the tax so the protocol stabilizes; turning it on early can spook stakers.

### 4.2 Set fund cuts (optional, controversial)

```bash
forge script script/PostBootstrap.s.sol --rpc-url base_sepolia --broadcast
```

Env vars:

- `DAO_FUND_PERCENT` — basis points of expansion seigniorage to daoFund (0–3000 = 0–30%). 0 disables.
- `DEV_FUND_PERCENT` — basis points to devFund (0–1000 = 0–10%). 0 disables.

The default at deploy is 0/0 — the team takes nothing from seigniorage. Setting these to nonzero is **visible team monetization**; document it publicly before flipping.

### 4.3 Redirect above-threshold tax (optional, aggressive)

By default, when price > 1.10 ETH the hook's tax routes to the Treasury (where it sits in the seigniorage reserve, used for bond redemption). To redirect it to a team wallet instead:

```bash
cast send <hook> 'setTreasury(address)' $TEAM_WALLET --rpc-url base_sepolia --private-key $OPERATOR_PRIVATE_KEY
```

**Caveat:** This is the most aggressive monetization knob. Tomb did this with `taxCollectorAddress`. The optics are unambiguous — users will read it as team rent extraction. Strongly consider leaving the default (Treasury) unless you've broadcast the change publicly first.

---

## 5 · Governance Rotation (pre-mainnet only)

Before mainnet, rotate every admin-bearing contract from the deployer EOA to the Timelock. Two-phase, with the `TIMELOCK_DELAY` (default 24h) between queue and execute.

**What rotates:**

| Target | Mechanism | Reversible? |
|---|---|---|
| `$MONEY` / `$ESTATE` / `$TRUSTNOTE` / `PegDefenseHook` ownership | Ownable2Step (transferOwnership + acceptOwnership) | Two-step; queue can be cancelled |
| `PegDefenseHook` trustees | one-step `transferTrustees` | One-way once queue executes |
| Treasury operator + Genesis/Main/Share reward pool operators | one-step `setOperator` | One-way |
| Boardroom operator | **stays as Treasury** (intentional — protocol-internal) | — |
| V4PositionWrapper | no admin role (intentional) | — |

The `/admin` Rotation Status panel reads on-chain state and surfaces which phase you're in, plus the exact env-var-prefilled command to run.

### 5.1 Queue

Required env vars (all live in `frontend/src/lib/addresses.ts` for the active chain):

```bash
cd contracts
set -a && source .env && set +a

# Base Sepolia values (mirror frontend/src/lib/addresses.ts)
export TIMELOCK=0x216452DeD9bB3eDc618A40E6BCf84c33167F03d1
export MONEY=0xb650e095c528fAc0f7DBC57121c60176323d8177
export ESTATE=0xaA5f51352c6D6fD4367dc00C0DA86f54E4f824BD
export TRUSTNOTE=0x4B5DD3A4b6Ba475eecC8307bb9d2932c71D14588
export HOOK=0x8FF87C2B51eE70cA39B3ECD72B60db13ad86D088
export TREASURY=0x928B72a3E734d6D07606d9655c55289D3a224c20
export GENESIS_REWARD_POOL=0xBf511845D6252E622734681f2713131EF39a6487
export MAIN_REWARD_POOL=0x3190962F3f0F50f3D486B3fa81D61088a06FAb2D
export SHARE_REWARD_POOL=0x5193Ce115BA7df3d25c7f5dA4c29DA2CD7c890bC

forge script script/RotateGovernanceQueue.s.sol \
  --rpc-url base_sepolia --broadcast --slow
```

**What it does:**
1. `transferOwnership(Timelock)` on MONEY/ESTATE/TRUSTNOTE/HOOK (Ownable2Step → sets pendingOwner)
2. `transferTrustees(Timelock)` on HOOK (one-step)
3. `setOperator(Timelock)` on Treasury + Genesis/Main/Share pools (one-step)
4. `queueTransaction(acceptOwnership)` on Timelock for MONEY/ESTATE/TRUSTNOTE/HOOK

13 broadcasts total. **The script logs the ETA** — save it for Execute. If you didn't override, it's `(queue_block.timestamp + Timelock.delay() + 60)`.

After this script: deployer has lost Treasury/Hook/reward-pool admin power. Token ownership is suspended (pendingOwner set, owner still deployer). The 24h clock starts.

### 5.2 Wait `TIMELOCK_DELAY` seconds (default 86,400 = 24h)

The `/admin` Rotation Status panel will show "Phase · Awaiting Execute" during this window. The Treasury continues operating (keeper still ticks epochs; users still stake/withdraw/swap) — only the admin surface is paused.

### 5.3 Execute

```bash
cd contracts
set -a && source .env && set +a

export TIMELOCK=0x216452DeD9bB3eDc618A40E6BCf84c33167F03d1
export MONEY=0xb650e095c528fAc0f7DBC57121c60176323d8177
export ESTATE=0xaA5f51352c6D6fD4367dc00C0DA86f54E4f824BD
export TRUSTNOTE=0x4B5DD3A4b6Ba475eecC8307bb9d2932c71D14588
export HOOK=0x8FF87C2B51eE70cA39B3ECD72B60db13ad86D088
export ETA=<unix-timestamp-from-queue-log>

forge script script/RotateGovernanceExecute.s.sol \
  --rpc-url base_sepolia --broadcast --slow
```

**What it does:** 4 `executeTransaction(acceptOwnership)` calls — one per token + hook. The Timelock pulls the queued txs and runs them against each target, finalizing the Ownable2Step transfer.

After this script: Timelock owns MONEY/ESTATE/TRUSTNOTE/HOOK + is the operator/trustees of every privileged surface. The deployer EOA is no longer privileged. Every admin action now goes through the Timelock's queue/execute pattern (24h delay between proposing and acting).

### 5.4 Verifying

The `/admin` Rotation Status panel should show "Phase · Complete" — every row in its state table reads the Timelock address with an emerald check.

Sanity check via cast:

```bash
cast call --rpc-url base_sepolia $TREASURY 'operator()(address)'   # expect Timelock
cast call --rpc-url base_sepolia $MONEY 'owner()(address)'         # expect Timelock
cast call --rpc-url base_sepolia $HOOK 'trustees()(address)'       # expect Timelock
```

### 5.5 If something goes wrong

- **Forgot ETA before 24h elapsed** — recover from the queue script's transaction logs on BaseScan (`QueueTransaction` event includes the eta).
- **Past the grace window (eta + 14 days)** — the queued txs are stale. You'd need to queue them again, which requires the Timelock admin (deployer at this point still, since acceptOwnership hasn't executed). Re-run RotateGovernanceQueue with `ETA=<new-time>`.
- **Wrong address in a queue tx** — `cancelTransaction` on the Timelock as deployer/admin before the eta elapses. Re-queue with the correct values.

---

## 6 · Quick-Reference Schedule

| When | Action | Script | Reversible? |
|---|---|---|---|
| T-1h | Seed V4 liquidity | `SeedLiquidity.s.sol` | No (locks LP into pool) |
| T-1h | Open Genesis pool | `OpenGenesis.s.sol` | No effect once stakers arrive |
| T+0 → ∞ | Keeper: `oracle.update` + `allocateSeigniorage` every 6h | Cron / Defender | n/a |
| T+24h | Main + Share start paying (auto) | — | — |
| T+7d (epoch 28) | Enable hook tax | `cast send hook 'setAutoCalculateTax(bool)' true` | Yes — operator can flip back |
| T+7d (epoch 28) | Set fund cuts | `PostBootstrap.s.sol` | Yes — operator can re-call setExtraFunds |
| T+7d (epoch 28) | Redirect tax destination | `cast send hook 'setTreasury(address)' …` | Yes — operator can flip back |
| Pre-mainnet | Rotate governance to Timelock | `RotateGovernance{Queue,Execute}.s.sol` | One-way (deployer loses admin) |

## 7 · Things that DO NOT need an operator

These are self-service or permissionless:

- $MONEY / $ESTATE / $TRUSTNOTE token transfers — anyone with a balance
- Boardroom stake / withdraw / claimReward — anyone with $ESTATE
- Reward pool deposit / withdraw / emergencyWithdraw — anyone with the stake token
- Treasury buyBonds / redeemBonds — anyone with $MONEY (below peg) or $TRUSTNOTE (above ceiling)
- V4 swap on MONEY-WETH — anyone (hook handles tax automatically once enabled)
- LP wrap / unwrap via V4PositionWrapper — anyone with a MONEY-WETH V4 NFT
- Oracle update + Treasury allocateSeigniorage — anyone post-epoch (Trustees pre-epoch only)
- ESTATE vesting claim — anyone calls `Estate.claimRewards(target)` for community/dev fund (the target is fixed by the contract, not chosen by caller)

## 8 · Things to monitor

- `treasury.epoch()` — should advance every 6h. If stalled, the keeper isn't running `allocateSeigniorage()`.
- `oracle.initialized()` — should flip to `true` after the first `oracle.update()` that observes time elapsed. If still `false` after 12h, the keeper isn't running.
- `treasury.getMoneyPrice()` — once initialized, returns the 1e18-scaled TWAP. Sanity-check against the spot price.
- Hook tax events: `TaxBurned(amount, price)` and `TaxRouted(treasury, amount, price)` — only fire when `autoCalculateTax=true`.
- `treasury.seigniorageSaved()` — accumulates during expansion (less daoFund + devFund shares). Depleted on `redeemBonds`.
- `treasury.getBondsOutstanding()` (via `TRUSTNOTE.totalSupply()` ÷ `MONEY.totalSupply()` for debt ratio) — never exceeds `maxDebtRatioPercent` (3500 = 35%).

## 9 · Known launch hazards

- **`getMoneyPrice()` reverts before first `oracle.update()` with time elapsed.** The Treasury's `allocateSeigniorage()` will revert with a string error from that surface. Mitigation: ensure oracle.update() runs at least once before the keeper hits allocateSeigniorage.
- **Genesis pool stake tokens must be added before `poolStartTime`.** The rewards-per-second emission ticks from `poolStartTime` regardless; if no PIDs are registered, the emission is lost to early epochs.
- **The `targetPrice` slippage check in `buyBonds`/`redeemBonds` is strict.** Frontend reads price at click time, but if oracle.update() runs in the same block as the bond call, the price changes and the call reverts with `PriceMoved`. Mitigation (T10): widen frontend slippage tolerance.
- **`autoCalculateTax=true` requires the hook to have been funded with the `treasury` slot set.** Default at deploy is the Treasury contract, so this is fine; only an issue if you manually called `hook.setTreasury(address(0))` for some reason.
- **Bootstrap supply expansion is unconditional.** Even if MONEY trades below peg in epochs 1–28, the protocol still mints 4.5% to Boardroom. This is Tomb-faithful behavior — it incentivizes early staking. Don't be surprised if the price chart looks weird during this window.

---

## 10 · Documents to keep current alongside this one

- `docs/DEPLOYED.md` — addresses by chain after each deploy
- `docs/GAP_AUDIT.md` — known gaps vs. Tomb (now closed but referenced)
- `docs/TOMB_AUDIT.md` — bug-by-bug audit of Tomb-faithfulness
- `frontend/src/lib/addresses.ts` — frontend-facing address map (must match docs/DEPLOYED.md)
