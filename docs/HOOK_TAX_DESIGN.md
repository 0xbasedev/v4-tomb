# Sprint 4b — PegDefenseHook tax routing design

> **Revised.** The sections below are the original Sprint 4b design and are kept for history.
> Where they disagree with [Revision 2](#revision-2--exact-output-tax-post-swap-observation-deferred-collection)
> [Revision 3](#revision-3--three-tier-curve-keyed-to-the-twap) or
> [Revision 4](#revision-4--fire-tax-ratchet-hard-cap-deferred-tax-accounting) at the end of
> this document, the revisions are what the contract does. In particular the 14-tier Tomb table
> below is no longer the default.

Design doc for restoring Tomb's burn-during-deep-contraction lever as a `beforeSwapReturnDelta` extension to `PegDefenseHook`. **Read this and sign off before any code lands in `src/`.**

## Purpose

Tomb's `Bomb.sol` taxed `transferFrom` of BOMB with a price-tier-dependent rate (1%–20%). When `currentBombPrice < burnThreshold (1.10e18)` — which is most of the time — the tax was **burned**; otherwise it went to a `taxCollectorAddress`. This is the load-bearing deflationary lever during contraction: every sale removes a chunk of supply from circulation, making the peg defense self-reinforcing on every transaction.

Our current `PegDefenseHook` (Sprint 4) doesn't burn or route any value. It only raises the LP fee during deep-contraction, which deters selling but produces zero supply contraction. Per `docs/TOMB_AUDIT.md` BUG #3 / Gap #3, that's the biggest Tomb-fidelity gap we haven't closed.

This sprint adds the tax slice **on top of** the existing dynamic LP fee. The two mechanisms coexist:

- **Dynamic LP fee** (existing) — higher cost = lower MONEY sell pressure; revenue flows to LPs.
- **Tax slice on sells** (new) — takes a percentage of swap input as MONEY → burns (or routes to Treasury) → permanent supply reduction.

## How Tomb's tax worked, exactly

From `Bomb.sol::transferFrom` (the primary source):

```solidity
if (autoCalculateTax) {
    uint256 currentBombPrice = _getBombPrice();
    currentTaxRate = _updateTaxRate(currentBombPrice);  // tier lookup
    if (currentBombPrice < burnThreshold) {              // 1.10e18 default
        burnTax = true;
    }
}

if (currentTaxRate > 0 && !excludedAddresses[sender]) {
    uint256 taxAmount = amount * taxRate / 10000;
    if (burnTax) {
        super.burnFrom(sender, taxAmount);              // BURN
    } else {
        _transfer(sender, taxCollectorAddress, taxAmount);  // collect
    }
    _transfer(sender, recipient, amount - taxAmount);
}
```

Tax tier table (14 tiers):

| Price range × 1e18 | Tax rate (bps) |
|---|---|
| 0 → 0.50 | 2000 (20%) |
| 0.50 → 0.60 | 1900 (19%) |
| 0.60 → 0.70 | 1800 (18%) |
| 0.70 → 0.80 | 1700 (17%) |
| 0.80 → 0.90 | 1600 (16%) |
| 0.90 → 0.95 | 1500 (15%) |
| 0.95 → 1.00 | 1500 (15%) |
| 1.00 → 1.05 | 1500 (15%) |
| 1.05 → 1.10 | 1500 (15%) |
| 1.10 → 1.20 | 1400 (14%) |
| 1.20 → 1.30 | 900 (9%) |
| 1.30 → 1.40 | 400 (4%) |
| 1.40 → 1.50 | 200 (2%) |
| 1.50+ | 100 (1%) |

`burnThreshold = 1.10e18` → at any price below 1.10× peg (which is most of the time), the tax MONEY is burned. Above 1.10× peg (rare), it goes to a tax-collector wallet.

## Scope changes for the V4 hook port

| Aspect | Tomb | Our hook (this sprint) |
|---|---|---|
| Trigger | Any `transferFrom` of BOMB | Only swaps through the V4 MONEY/WETH pool |
| Direction | Symmetric (both directions) | **Sells only** — MONEY → WETH swaps. Buys (WETH → MONEY) untaxed; taxing buys discourages MONEY acquisition which contradicts contraction goals |
| Burn vs route | Burned if price < 1.10; else to collector | Same threshold. Burn below 1.10; route to Treasury above 1.10 (Treasury can use it for bond redemption — replaces Tomb's separate collector wallet) |
| Tax tier table | 14 tiers (Tomb's exact table) | **14 tiers, same exact values.** Matches Tomb 1:1. |
| Excluded addresses | `mapping(address => bool) excludedAddresses` | Same — Trustees-settable. Set to `true` for protocol contracts (Treasury, PoolManager, wrappers) so they can move MONEY without being taxed |
| Active toggle | `autoCalculateTax` (off by default) | Same. Trustees flip on after launch |

**Justification for sells-only:** Tomb's symmetric tax was a side effect of intercepting `transferFrom`; on every operation including buys via a DEX, BOMB was being moved out of the LP, which triggered the tax. The economic intent was always sell-side. Our V4 swap context makes the direction explicit and lets us tax the intended side cleanly. **This is a narrowing of scope vs Tomb but matches Tomb's economic intent.**

## V4 mechanism: BeforeSwapDelta

V4's `beforeSwap` returns `(selector, BeforeSwapDelta, fee)`. The `BeforeSwapDelta` is a packed `int256`:

- **Upper 128 bits** = `deltaSpecified` (signed) — adjustment to the specified token's delta
- **Lower 128 bits** = `deltaUnspecified` (signed) — adjustment to the unspecified token's delta

For a sell with exact-input MONEY:
- `params.zeroForOne = moneyIsCurrency0` (MONEY → WETH)
- `params.amountSpecified < 0` (negative for exact-input per V4 convention)
- The **specified** token is MONEY (the one user is paying)
- Returning `deltaSpecified = +taxAmount` (positive int128) tells V4 the hook is owed `taxAmount` of MONEY from the swap
- V4 reduces the amount sent to the LPs by `taxAmount` and credits the hook with `taxAmount` MONEY

After `beforeSwap` returns, the hook calls `poolManager.take(moneyCurrency, address(this), taxAmount)` to pull the MONEY into the hook's balance. Then either:
- `money.burn(taxAmount)` if `price < burnThreshold` → MONEY supply decreases
- `money.transfer(treasury, taxAmount)` if `price >= burnThreshold` → Treasury accumulates reserves

For exact-output swaps (`amountSpecified > 0`): the specified token is the OUTPUT (WETH in a sell). The tax must come from the input side (MONEY), which is the unspecified token. This is messier — covered in "edge cases" below.

## Permission bits change

Current hook deployed address has low-14-bit pattern `0x1080` (`AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG`).

After adding `BEFORE_SWAP_RETURNS_DELTA_FLAG` (`1 << 3 = 0x8`):

```
AFTER_INITIALIZE_FLAG       = 0x1000
BEFORE_SWAP_FLAG            = 0x0080
BEFORE_SWAP_RETURNS_DELTA   = 0x0008
                              ------
                              0x1088
```

**New address pattern: low 14 bits = `0x1088`.** Hook MUST be redeployed at a freshly-mined CREATE2 salt that produces this pattern.

This means:
1. Existing Sepolia hook address (already obsolete from peg migration) gets replaced
2. `Deploy.s.sol` CREATE2 mining now mines for the new pattern automatically (it uses `Hooks.AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG` — we add `BEFORE_SWAP_RETURNS_DELTA_FLAG` to that)
3. Tests that hardcode the pattern (`BaseForkHook.t.sol::test_HookAddressHasCorrectPermissionBits`) must update from `0x1080` → `0x1088`

## Tax tier lookup

Match Tomb exactly:

```solidity
uint256[14] public taxTiersTwaps = [
    0,
    0.50e18, 0.60e18, 0.70e18, 0.80e18, 0.90e18,
    0.95e18, 1.00e18, 1.05e18, 1.10e18, 1.20e18,
    1.30e18, 1.40e18, 1.50e18
];

uint256[14] public taxTiersRates = [
    2000, 1900, 1800, 1700, 1600,
    1500, 1500, 1500, 1500, 1400,
    900, 400, 200, 100
];
```

Lookup walks tiers high → low; first one we exceed sets the rate. Same algorithm Tomb used in `_updateTaxRate`.

`burnThreshold = 1.10e18` — Trustees-settable. Below this threshold, tax is burned. At or above, routed to Treasury.

## Algorithm — `beforeSwap` extension

Pseudocode:

```
1. Run existing observation accumulation and dynamic-fee lookup (no change)

2. If autoCalculateTax == false → return (selector, ZERO_DELTA, fee | OVERRIDE_FEE_FLAG)
   (preserves current Sprint-4 behavior when tax is disabled)

3. If swap is a BUY (WETH → MONEY direction):
   → return (selector, ZERO_DELTA, fee | OVERRIDE_FEE_FLAG)
   (no tax on buys)

4. If sender is in `excludedAddresses`:
   → return (selector, ZERO_DELTA, fee | OVERRIDE_FEE_FLAG)

5. Compute current MONEY price in WETH from tick:
   - sqrtPriceX96 = TickMath.getSqrtPriceAtTick(currentTick)
   - price = (sqrtPriceX96^2 / 2^192) * 1e18  (or via FullMath for precision)

6. Look up taxRate from tier table based on price

7. If taxRate == 0:
   → return (selector, ZERO_DELTA, fee | OVERRIDE_FEE_FLAG)

8. Compute taxAmount = abs(amountSpecified) * taxRate / 10000

9. Build BeforeSwapDelta:
   - For exact-input sell: deltaSpecified = +int128(taxAmount), deltaUnspecified = 0
   - For exact-output sell: deltaUnspecified = +int128(taxAmount), deltaSpecified = 0
     (tax comes from input side which is unspecified for exact-output)

10. After PoolManager processes the delta, call:
    poolManager.take(moneyCurrency, address(this), taxAmount)

11. Conditional dispatch:
    if (price < burnThreshold):
        money.burn(taxAmount)
        emit TaxBurned(taxAmount, price)
    else:
        money.safeTransfer(treasury, taxAmount)
        emit TaxRouted(treasury, taxAmount, price)

12. Return (selector, beforeSwapDelta, fee | OVERRIDE_FEE_FLAG)
```

Note step 10: `poolManager.take` requires the unlock context, which `beforeSwap` is inside. So this call is valid.

## Edge cases

1. **Hook doesn't hold MONEY** — solved by `take` from PoolManager into hook's balance. After take, hook can burn or transfer.

2. **Treasury address not set yet** — `treasury` is Trustees-settable on the hook. If unset (zero address) AND price >= burnThreshold, tax falls through to burn anyway (safe default). Document as such.

3. **Exact-output swaps** — when `amountSpecified > 0` (exact output), the specified token is what's received, the unspecified is what's paid. For a sell (MONEY → WETH, exact-output WETH), the unspecified is MONEY. To take MONEY tax, set `deltaUnspecified > 0`. The downside: we don't know the exact MONEY amount until after the swap clears. Approach: estimate from the pool's current tick + WETH amount, take the estimated tax, then if the actual sale's MONEY input differs slightly, accept the rounding (sub-cent). Document the precision limitation.

4. **Concurrent excluded-address management** — the trustees list controls which addresses bypass tax. Required to be set for: Treasury, PoolManager, all reward pools, the hook itself, any V4 LP wrappers we deploy. Without proper exclusion, the protocol's own seigniorage flow gets taxed (bad — seigniorage going TO Boardroom would be partially burned).

5. **Tax during expansion is also possible** — above peg, the table still returns 1-9% tax for sells. This is correct: even when above peg, sells still cause a small amount of supply contraction. Tomb did this; we match.

6. **What if `take` fails?** — Defensive: if `take` reverts, the entire swap reverts (V4 unwinds the unlock callback). User sees a clean revert with no funds lost.

7. **`autoCalculateTax = false` initial state** — At deploy, tax is OFF. Trustees flip it on after launch when the protocol is stable. This matches Tomb's behavior (constructor sets `autoCalculateTax` to false implicitly; operator enables later via `enableAutoCalculateTax()`).

## New trustees-settable parameters

| Variable | Default | Purpose |
|---|---|---|
| `autoCalculateTax` | `false` | Master switch — flip true after launch |
| `taxTiersTwaps[14]` | Tomb's exact tiers | Price thresholds (1e18-scaled) |
| `taxTiersRates[14]` | Tomb's exact rates | Tax basis points per tier |
| `burnThreshold` | `1.10e18` | Below = burn; above = route to Treasury |
| `treasury` | unset (Trustees sets post-deploy) | Tax recipient when burnTax=false |
| `excludedAddresses` | empty | Tax-exempt senders |

Plus single-setter functions (matching Tomb's `setTaxTiersTwap`, `setTaxTiersRate`, `setBurnThreshold`, `setTaxCollectorAddress`, `setExcludedAddress`).

## Tests required (production quality bar)

Unit tests (mock PoolManager):

- [ ] `autoCalculateTax = false` → no tax delta returned, behavior matches Sprint 4
- [ ] Tax tier lookup correctness — for each of 14 tiers, verify rate returned matches table
- [ ] Buy direction (WETH → MONEY): no tax delta returned regardless of `autoCalculateTax`
- [ ] Sell direction (MONEY → WETH) with `autoCalculateTax = true`: deltaSpecified > 0 returned
- [ ] Excluded sender: no tax even on sell
- [ ] `burnThreshold` boundary: at price = 1.10e18 exactly, route to Treasury; at 1.099e18, burn
- [ ] Setter functions are Trustees-only
- [ ] `taxTiersTwaps` and `taxTiersRates` arrays must remain monotonic when updated (catch operator footguns)
- [ ] `MAX_LP_FEE` bound on rates still applies — reject rates > 100%
- [ ] Treasury address can be unset at deploy; setter rotates it

Fork tests (real V4):

- [ ] Real sell swap through real PoolManager: tax MONEY actually gets taken to the hook's balance
- [ ] Burn path: `money.totalSupply()` decreases by exactly `taxAmount`
- [ ] Route path: `money.balanceOf(treasury)` increases by exactly `taxAmount`
- [ ] Exact-input + exact-output both work
- [ ] Buy swap through real PoolManager: hook balance unchanged

Invariant test (handler-style):

- [ ] **Tax conservation**: for every swap, either (sender's MONEY balance decreased by amount+tax AND tax was burned/routed) OR (sender's MONEY balance decreased by amount AND tax was 0)
- [ ] **No MONEY leak**: after N random swaps, `money.totalSupply() + money.balanceOf(treasury) + sum(money.balanceOf(every staker))` accounts for all MONEY in the system
- [ ] **Burn-vs-route monotonicity**: as price moves from below to above burnThreshold, tax routing switches from burn to Treasury at exactly the threshold

Slither:
- [ ] No new HIGH/MEDIUM findings
- [ ] Reentrancy clean — `take` is the only external call during beforeSwap; happens inside the V4 unlock context which is already reentrancy-guarded by PoolManager
- [ ] Burn before transfer (CEI applies even here)

## Migration impact

- **Hook address changes** — new CREATE2 mining target `0x1088`. Sepolia redeploy needed (already obsolete from peg migration, so no extra cost).
- **`Deploy.s.sol`** — update `flags` constant from `AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG` to `AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG | BEFORE_SWAP_RETURNS_DELTA_FLAG`.
- **`Deploy.s.sol`** — pass `address(treasury)` into hook setter post-init so tax-routing has a destination.
- **`BaseForkHook.t.sol::test_HookAddressHasCorrectPermissionBits`** — update expected pattern.
- **Existing 23 PegDefenseHook unit tests** — most should still pass (no breaking changes when `autoCalculateTax = false`, which is the default).
- **GAP_AUDIT.md, TOMB_AUDIT.md** — mark gap #3 as implemented.

## Estimated work — ✅ ALL TURNS COMPLETE

| Turn | Work | Commit |
|---|---|---|
| 1 | Design doc + sign-off | `8befc42` |
| 2 | Hook contract extension + Deploy.s.sol + permission-bit update | `72a1c3d` |
| 3 | Mock-based unit tests — 28 tests covering defaults, tier table, lookup boundaries, setters, early returns, take+burn/route | `a296c11` |
| 4 | Fork integration tests — 5 tests against real Base V4 PoolManager (burn path, route path, buy direction, excluded sender, tax-off) | `f2ed8dd` |
| 5 | Fuzz tests for tax conservation + doc closure | (this commit) |
| 6 (pending) | Slither pass — needs Slither installed locally (not in this environment); see commit `9f95adc` for last clean Slither result | — |

Final stats: PegDefenseHook test count 23 → **55** unit tests + **5** fork tests + **4** fuzz tests. Full suite 255 → **292 tests** passing in ~4.6s.

## What I need from you

Three decisions:

1. **Tax tier table — exact Tomb match (14 tiers, 2000→100 bps)?** Or simpler 4-tier table aligned with our existing fee tiers? Recommended: exact Tomb match.
2. **Sells-only tax (recommended)** or **symmetric (Tomb-faithful but discourages buying during contraction)**?
3. **Default initial state of `autoCalculateTax`**: `false` (operator enables post-launch) or `true` (live at deploy)? Recommended: `false`, matches Tomb.

If you sign off on the three recommendations above, I'll start contract implementation in the next turn.

---

## Revision 2 — exact-output tax, post-swap observation, deferred collection

Three defects in the Sprint 4b hook were reproduced against a real v4-core `PoolManager`
(`contracts/test/integration/PegDefenseHookAdversarial.t.sol`) and fixed in place.

### 1. Exact-output sells were taxed on the WETH figure

`taxAmount = abs(amountSpecified) * rate` was used for both swap modes. On an exact-output
sell `amountSpecified` is the WETH the seller wants out, so the MONEY tax was computed from a
WETH number. MONEY and WETH share 18 decimals, so the error scales with the depeg instead of
being off by orders of magnitude — which makes it worse exactly when the tax matters:
at 0.55 WETH per MONEY the 19% tier collected an effective **9.2%**.

The MONEY a pool needs for an exact-output swap is only known after the swap runs, so that
leg moved to `afterSwap`:

| Mode | MONEY is | Assessed in | Formula | Effective rate on gross MONEY paid |
|---|---|---|---|---|
| exact-input | specified | `beforeSwap` (specified delta) | `tax = G × r` | `r` |
| exact-output | unspecified | `afterSwap` (unspecified delta) | `tax = N × r / (1 − r)`, rounded up | `r` |

`G` is the seller's gross input, `N` the MONEY the pool took. Both modes now cost the same
for the same trade. The tier is always chosen from the **pre-swap** price. The rate is capped at 12% (Revision 4), so the gross-up is always well defined.

The tax stays MONEY-denominated in both modes because the burn is the point. Collecting
WETH in `afterSwap` for every sell would be simpler but would turn a supply-contraction
lever into a revenue line.

### 2. The oracle was one swap stale, and could be parked at any tick for free

`beforeSwap` stored the pre-swap tick as `lastTick` and nothing recorded where the swap
ended. Idle time after a swap was therefore integrated at the price *before* that swap.
Worse, a same-block buy-then-sell left `lastTick` at the intra-block peak while the pool
returned to its starting price, so six idle hours of TWAP read a price that never rested —
at the cost of two swap fees. That feeds `Treasury.allocateSeigniorage` directly.

`afterSwap` now writes the post-swap tick. Combined with `beforeSwap` folding
`lastTick × elapsed`, the accumulator integrates the tick the pool actually rested at, and
only the final tick of a block carries into the next interval (the same guarantee as a
Uniswap v3 observation). Moving the TWAP now requires holding the price across blocks,
exposed to arbitrage.

### 3. Taxed sells reverted when the PoolManager held too little MONEY

Hook callbacks run before the router settles the swapper's input, so `poolManager.take`
is paid out of MONEY the manager already holds. When price sits above a concentrated
liquidity range the pool is ~100% WETH, the `take` reverts, and the sells that would
arbitrage price back toward peg are blocked.

`_collectTax` now checks the manager's MONEY balance. If it cannot cover the tax, the hook
takes ERC-6909 claims instead (no token transfer) and records the amount in
`pendingTaxBurn` / `pendingTaxRoute`; the burn-vs-route decision is fixed at the swap's
price. `settleDeferredTax()` is permissionless and redeems the claims once reserves allow.
In the common case nothing changes: the tax is still burned or routed atomically.
Deferred burn tax is not reflected in `totalSupply` until it is settled; the keeper does
that (see Revision 4).

### Permission bits

`afterSwap` and `afterSwapReturnDelta` are new, so the address pattern changes
**`0x1088` → `0x10CC`** and the hook must be redeployed at a freshly mined salt. There is
no compatibility path: `config/schema.mjs` rejects any hook whose address is not `0x10CC`. A pool is
bound to its hook address forever, so this means a new pool: existing liquidity has to
migrate. `PegDefenseHookPermissions.FLAGS` is now the single definition that the deploy
script, tests and `config/schema.mjs` agree on.

### What the hook does not enforce

These are deliberate limits of taxing at the pool rather than at the token. Each is pinned
by a `test_KnownLimit_*` test so a future change cannot alter it silently.

- **Other pools are untaxed.** MONEY is an unrestricted ERC-20; anyone can open a hookless
  V4 pool (or a V2/V3 pool) and sell there tax-free. Closing that requires transfer-gating
  the token, which breaks wallets, lending markets, bridges and aggregators. The defence is
  economic: LP rewards (`V4PositionWrapper` checks the `PoolId`) and the oracle only
  recognise the official pool, so shadow pools get no emissions and cannot move the TWAP.
- **`excludedAddresses` exempts routers, not users.** V4 passes the hook the address that
  called `PoolManager.swap`. Excluding a router exempts everyone who trades through it.
  Treasury, Boardroom and the reward pools never call `swap`, so they never need excluding
  (the edge-case list above is wrong on this point). Leave the mapping empty unless a
  single-purpose protocol contract swaps for itself.
- **LP positions are resting asks, not sells.** Single-sided MONEY liquidity above the
  current price converts to WETH only when a buyer trades through it. Adding and removing
  it extracts no WETH, so no liquidity hooks are needed.
- **One rate per trade.** The tier is fixed before the swap and applied to the whole
  amount (see Revision 3 for which price it is read from).

### ESTATE (the share token)

ESTATE has no sell tax, and none is planned. Tomb's TSHARE was untaxed too. The MONEY tax
exists to burn supply while below peg; ESTATE has no peg, so a tax on it would only be a
fee on entering and leaving the Boardroom. If protocol revenue from ESTATE trading is ever
wanted, the clean form is a flat LP-fee split on an ESTATE pool, not this hook's tier table.

---

## Revision 3 — three-tier curve keyed to the TWAP

The Tomb 14-tier table is replaced by a curve that eases as the peg strengthens:

| TWAP (WETH per MONEY) | Sell tax | Destination |
|---|---|---|
| below 1.12 | 12% | burned below 1.10, Treasury from 1.10 |
| 1.12 up to 1.20 | 6% | Treasury |
| 1.20 and above | 3% | Treasury |

`taxTiersTwaps = [0, 1.12e18, 1.2e18]`, `taxTiersRates = [1200, 600, 300]`. Both remain
Trustees-settable per tier, within the 12% cap; the table length is fixed at three.
Thresholds are WETH per MONEY, which equals multiples of peg while the peg is 1:1.

### Which price

The tier and the burn threshold are read from `taxOracle.consult(money, 1e18)` — the
Oracle's **last completed epoch TWAP** — not from the pool's spot price. `Deploy.s.sol`
wires the protocol Oracle in with `setTaxOracle`.

With a curve that gets cheaper as price rises, a spot-keyed tax invites the obvious trade:
buy to push spot above 1.20, then sell at 3% in the same transaction. Keying to the epoch
TWAP removes that; `test_TaxTier_CannotBeBoughtDownWithinTheSellTransaction` pins it.

Consequences worth knowing:

- The schedule's target changes at most once per epoch (6 hours), when `Oracle.update()`
  runs. A sharp move reaches the tax at the next epoch, not immediately.
- Until the Oracle completes its first epoch it reports zero, and the hook falls back to the
  pre-swap spot price. The same fallback applies if the oracle is unset or reverts, so a
  broken oracle can neither block sells nor switch the tax off. Enable `autoCalculateTax`
  only after the first `Oracle.update()` if the spot fallback is not acceptable at launch.
- `currentTaxPrice()` and `currentTaxRate()` expose what a sell would be charged right now.
  The frontend reads these instead of re-deriving a tier from spot.

---

## Revision 4 — Fire Tax ratchet, hard cap, deferred-tax accounting

### 12% is a hard ceiling

`MAX_TAX_BPS = 1200` is a constant. `setTaxTiersRate` rejects anything above it, the
ratchet clamps to it, and `taxRate` is stored as the rate actually charged. There is no
owner path to a higher tax. (The previous bound was 100%.)

### Increases are immediate, decreases take seven hours

The tier table is now a **target**. The rate charged, `taxRate`, follows it through a
ratchet (`_nextTaxState`):

- **Target at or above the rate in force:** charged on the very next swap. Any pending
  decrease is cancelled.
- **Target below the rate in force:** a recovery window opens. The rate falls only once a
  lower target has stood for `TAX_RECOVERY_PERIOD` (7 hours), and it falls to the *highest*
  target seen during that window. A still-lower target then needs a window of its own, so
  12% → 3% takes at least fourteen hours unless 3% was the target from the start.

`taxRate` starts at 12%, so a new deployment charges the maximum until a lower rate has
been earned.

Targets are sampled when the hook runs: on every swap while the tax is enabled, and on the
permissionless `pokeTaxRate()`. A window therefore opens at the first *observation* of a
lower target. The keeper pokes so that this does not wait for a trade. The ratchet can only
err toward the higher rate.

Views: `currentTaxRate()` (what a sell pays now, including any step the next sync would
apply), `targetTaxRate()`, `pendingTaxDecrease()`.

### Deferred tax accounting

Three lifetime counters make the relationship checkable on-chain and in tests:

```
totalTaxAssessed == totalTaxBurned + totalTaxRouted + pendingTaxBurn + pendingTaxRoute
PoolManager ERC-6909 MONEY claims held by the hook == pendingTaxBurn + pendingTaxRoute
PoolManager MONEY balance                          >= pendingTaxBurn + pendingTaxRoute
supply burned by the hook == totalTaxBurned;  Treasury receipts == totalTaxRouted
```

`testFuzz_TaxAccounting_ConservedAcrossAnySequence` asserts all of it after every step of
random sell / buy / settle / time-skip sequences against thin liquidity, in both token
orderings.

One consequence worth stating: a deferral only lasts until the swap that caused it has
settled. The seller's own input is what backs the claim, so the claim is redeemable in full
as soon as that transaction ends, even if buyers then take every MONEY the pool holds.
`settleDeferredTax()` still settles partially and never reverts for lack of reserves, as a
defence, but no reachable sequence was found that leaves a claim unbacked.

### Keeper

`KeeperTick.s.sol` now does three things per pass, each a clean no-op when idle:

1. advance the epoch when due;
2. `pokeTaxRate()` when a sync would raise the rate, open a window, or complete one;
3. `settleDeferredTax()` when tax is deferred and reserves allow.

Outstanding deferred tax after a pass is printed as a GitHub Actions `::warning::`. If the
hook's claims ever fall short of what is owed, the script reverts and the scheduled run goes
red.

---

## Revision 5 — share-token sell tax: SHARE → QUOTE → PEG → burn

`contracts/src/hooks/ShareBuybackHook.sol` implements the share-token policy as a second
hook, on the SHARE/QUOTE pool. In the approved design that is SQUARE/USDC with LEVEL as the
peg token; in this repository's own tokens it would be ESTATE/WETH with MONEY. The hook
takes all three as constructor addresses and has no dependency on Treasury, Boardroom or
the Oracle.

| Step | What happens | Why it cannot be abused or get stuck |
|---|---|---|
| Collect | A SHARE sell pays the Fire Tax out of its QUOTE proceeds | Rate comes from the peg hook's ratchet and is clamped again here to 12%. No exemption list. |
| Hold | Tax is taken as ERC-6909 QUOTE claims and counted in `pendingQuote` | No token transfer and no swap inside the user's trade, so a buyback that cannot run cannot fail a sell |
| Convert and burn | Permissionless `executeBuyback()` swaps pending QUOTE for PEG and burns all of it | The only path value can leave by. No Treasury, POL or reserve share, no sweep, no configurable recipient |

**100% to the burn.** There is no split and no mode switch: the buyback does not depend on
any "critical defense" state.

**One Fire Tax.** The hook calls `pokeTaxRate()` on the peg hook, so SHARE and PEG sells pay
the same rate under the same immediate-up, seven-hours-down ratchet. If that call fails the
hook charges the 12% ceiling, so a broken dependency neither blocks the sell nor waives the
tax.

**Buyback price guard.** A permissionless market buy invites a sandwich. The buyback
carries a price limit of `maxPremiumTicks` (default 100, about 1%) above a TWAP of the peg
pool measured over at least `twapWindow` (default 30 minutes). Spot already above the limit:
nothing is bought and the tax stays pending. Limit reached part-way: the rest stays pending.
The TWAP comes from the hook's own checkpoints of the peg pool's tick accumulator, not from
the protocol Oracle, so the tax system stays separate from the peg token's mint gating.
Trustees can tune the two guard parameters inside fixed bounds (10 minutes to 6 hours; 0 to
500 ticks) and can switch collection on or off. That is the entire admin surface.

**Accounting**, asserted after every step of random sequences in all four token-ordering
combinations (`testFuzz_ShareTaxAccounting_ConservedAcrossAnySequence`):

```
totalQuoteAssessed == totalQuoteConverted + pendingQuote
hook's ERC-6909 QUOTE claims == pendingQuote
PoolManager QUOTE balance    >= pendingQuote
hook holds no SHARE, QUOTE or PEG;  every PEG bought has left the supply
```

The suite was mutation-checked: removing the burn, the pending decrement, the price guard,
the 12% clamp, or the exact-output tax each makes it fail.

**Tax arithmetic.** Both swap modes charge rate `r` on gross QUOTE proceeds. Exact-input:
`tax = out × r` in `afterSwap`. Exact-output: the pool is asked for `W + tax` in
`beforeSwap` with `tax = W × r / (1 − r)`, so the seller still receives exactly `W`.

**Deployment.** `Deploy.s.sol` mines and deploys the hook at a `0x10CC` address, wired to
ESTATE (share), MONEY (peg), WETH (quote, taken from the MONEY/WETH pool key) and the
PegDefenseHook (rate and price source), then initialises the ESTATE/WETH pool at a 0.30%
static fee. `SHARE_POOL_INITIAL_TICK` sets the opening price and defaults to parity.
Collection starts disabled; `PostBootstrap.s.sol` enables it together with the MONEY tax.
The address is exported as `shareBuybackHook`, which the manifest now requires and
validates. The governance rotation scripts hand its ownership and trustees to the Timelock
alongside the peg hook, and the keeper runs its buyback every pass.

Known limits: both pools must share the same QUOTE asset; an exact-output sell that stops
at the caller's price limit is still taxed on the amount requested; and no script seeds
ESTATE/WETH liquidity yet (`SeedLiquidity.s.sol` covers MONEY/WETH only), so the pool is
empty after deploy.

### Still outside this repository

- **LEVEL / SQUARE and Masonry.** The tokens themselves are not here. `ShareBuybackHook`
  and `PegDefenseHook` are tested with this repository's MONEY and a plain ERC-20 standing
  in for the share token; the eventual LEVEL / SQUARE contracts need their own validation
  against both hooks, in particular that `LEVEL.burn(uint256)` is callable by the hooks and
  that neither token charges a transfer tax of its own (which would double-tax).
- **LEVEL's fresh-TWAP mint gate** is a separate system and is not touched by either hook.
- **Non-18-decimal paired assets** for the Fire Tax price thresholds.
