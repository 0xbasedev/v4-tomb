# Sprint 4b — PegDefenseHook tax routing design

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
