#!/usr/bin/env python3
"""Monte Carlo sweep for Masonry protocol-owned v4 range settings.

Faithfully mirrors:
  - MasonryRangeLib.bandTicks / needsRecenter / deviationBps (tick spacing 60)
  - Uniswap v3/v4 concentrated-liquidity amounts and constant-product impact
  - Official pool fee 0.30% (3000), inventory swap limited to maxTwapDeviation
  - MAX_INVENTORY_LOSS_BPS = 100, cooldown, same-block/TWAP guards
  - Fire Tax curve: 3% at/above peg, 12% at 10% below peg (linear in between)

Range-manager rebalance swaps are Fire-Tax-exempt when the hook's
`rangeManager` is bound (MasonryTaxHook.beforeSwap returns a zero delta if
sender == rangeManager). The sim always applies the pool LP fee and also
records the hypothetical Fire Tax that would hit an *unbound* manager that
sells xTOMB while recentering.

X Tomb strategies compared:
  follow      — current design: symmetric band around spot
  fixed       — never moves; band stays centered on $1
  peg_anchor  — follows spot down (and up), but the band always covers the
                path back to $1 (upper >= peg when below, lower <= peg when above)

Primary X Tomb metrics: recovery-path depth back to $1 during/after depegs,
and ending inventory after fees, IL, rebalance swap cost (and hypothetical
Fire Tax). X Share is tuned separately on a high-vol follow strategy.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

BPS = 10_000
FEE = 0.003
SPACING = 60
TICK_BASE = 1.0001
LN_TICK = math.log(TICK_BASE)
MAX_LOSS = 0.01
PEG = 1.0
DT_SECONDS = 3600
DAYS = 60
STEPS = DAYS * 24
START_VALUE = 100_000.0  # USDG
EXT_FRACTION = 0.30  # residual full-range liquidity vs protocol TVL
DAILY_TURN_TOMB = 0.35
DAILY_TURN_SHARE = 0.25
TYPICAL_SELL = 2_000.0  # USDG notional
RECOVERY_BAND = 0.01  # "near peg" window for snapshot metrics


def price_to_tick(price: float) -> float:
    return math.log(max(price, 1e-12)) / LN_TICK


def tick_to_price(tick: float) -> float:
    return math.exp(tick * LN_TICK)


def align(tick: int, spacing: int, round_up: bool) -> int:
    compressed = tick // spacing
    if tick < 0 and tick % spacing != 0:
        compressed -= 1
    if round_up and compressed * spacing < tick:
        compressed += 1
    return compressed * spacing


def band_ticks(price: float, down_bps: int, up_bps: int) -> tuple[int, int]:
    lower_p = price * (1.0 - down_bps / BPS)
    upper_p = price * (1.0 + up_bps / BPS)
    lower_p = max(lower_p, 1e-8)
    upper_p = max(upper_p, lower_p * 1.0002)
    lower = align(int(math.floor(price_to_tick(lower_p))), SPACING, False)
    upper = align(int(math.ceil(price_to_tick(upper_p))), SPACING, True)
    if lower >= upper:
        mid = align(int(math.floor(price_to_tick(price))), SPACING, False)
        lower, upper = mid - SPACING, mid + SPACING
    return lower, upper


def peg_anchor_ticks(price: float, down_bps: int, up_bps: int) -> tuple[int, int]:
    """Follow spot, but always span the recovery/depeg path through $1."""
    lower_p = min(price, PEG) * (1.0 - down_bps / BPS)
    upper_p = max(price, PEG) * (1.0 + up_bps / BPS)
    lower_p = max(lower_p, 1e-8)
    upper_p = max(upper_p, lower_p * 1.0002)
    lower = align(int(math.floor(price_to_tick(lower_p))), SPACING, False)
    upper = align(int(math.ceil(price_to_tick(upper_p))), SPACING, True)
    if lower >= upper:
        mid = align(int(math.floor(price_to_tick(price))), SPACING, False)
        lower, upper = mid - SPACING, mid + SPACING
    return lower, upper


def needs_recenter(tick: int, lower: int, upper: int, half_width: int, recenter: int) -> bool:
    if lower >= upper:
        return True
    if tick <= lower or tick >= upper:
        return True
    mid = (lower + upper) // 2
    half = (upper - lower) // 2
    inner = int(half * recenter / max(half_width, 1))
    if inner == 0:
        inner = 1
    dist = tick - mid if tick > mid else mid - tick
    return dist >= inner


def fire_tax_bps(price: float) -> int:
    if price >= PEG:
        return 300
    drop = (PEG - price) * BPS
    extra = min(900.0, 900.0 * drop / 1000.0)
    return int(round(300 + extra))


def amounts_for_L(L: float, sqrt_p: float, sqrt_a: float, sqrt_b: float) -> tuple[float, float]:
    if L <= 0:
        return 0.0, 0.0
    if sqrt_p <= sqrt_a:
        return L * (1.0 / sqrt_a - 1.0 / sqrt_b), 0.0
    if sqrt_p >= sqrt_b:
        return 0.0, L * (sqrt_b - sqrt_a)
    return L * (1.0 / sqrt_p - 1.0 / sqrt_b), L * (sqrt_p - sqrt_a)


def L_for_amounts(amt0: float, amt1: float, sqrt_p: float, sqrt_a: float, sqrt_b: float) -> float:
    if sqrt_b <= sqrt_a:
        return 0.0
    if sqrt_p <= sqrt_a:
        return amt0 / (1.0 / sqrt_a - 1.0 / sqrt_b) if amt0 > 0 else 0.0
    if sqrt_p >= sqrt_b:
        return amt1 / (sqrt_b - sqrt_a) if amt1 > 0 else 0.0
    l0 = amt0 / (1.0 / sqrt_p - 1.0 / sqrt_b) if amt0 > 0 else 0.0
    l1 = amt1 / (sqrt_p - sqrt_a) if amt1 > 0 else 0.0
    return min(l0, l1) if (l0 > 0 and l1 > 0) else max(l0, l1)


def fr_reserves(L: float, price: float) -> tuple[float, float]:
    sqrt_p = math.sqrt(price)
    return (L / sqrt_p, L * sqrt_p) if L > 0 else (0.0, 0.0)


def swap_cp(amt_in: float, zero_for_one: bool, price: float, L: float, fee: float, max_dev: float):
    """Swap against constant-product virtual reserves of liquidity L. Returns out, new_price, filled_in."""
    if amt_in <= 0 or L <= 0:
        return 0.0, price, 0.0
    x, y = fr_reserves(L, price)
    limit = price * ((1.0 - max_dev) ** 2 if zero_for_one else (1.0 + max_dev) ** 2)
    # Use linear price limits in price space (max_dev is a price deviation, matching sqrtPriceLimit).
    limit = price * (1.0 - max_dev) if zero_for_one else price * (1.0 + max_dev)
    taxed = amt_in * (1.0 - fee)
    if zero_for_one:
        new_x = x + taxed
        new_p = (L / new_x) ** 2
        if new_p < limit:
            new_p = limit
            new_x = L / math.sqrt(new_p)
            taxed = max(new_x - x, 0.0)
            amt_in = taxed / (1.0 - fee) if fee < 1 else amt_in
        out = y - L * math.sqrt(new_p)
        return max(out, 0.0), new_p, amt_in
    new_y = y + taxed
    new_p = (new_y / L) ** 2
    if new_p > limit:
        new_p = limit
        new_y = L * math.sqrt(new_p)
        taxed = max(new_y - y, 0.0)
        amt_in = taxed / (1.0 - fee) if fee < 1 else amt_in
    out = x - L / math.sqrt(new_p)
    return max(out, 0.0), new_p, amt_in


def active_L(pos_L: float, price: float, lower: int, upper: int, ext_L: float) -> float:
    tick = price_to_tick(price)
    in_range = lower < tick < upper
    return (pos_L if in_range else 0.0) + ext_L


def slippage_sell_asset(size_quote: float, price: float, pos_L: float, lower: int, upper: int, ext_L: float) -> float:
    """Price impact of selling `size_quote` worth of asset. 1.0 = 100% impact/fail."""
    if size_quote <= 0 or price <= 0:
        return 0.0
    L = active_L(pos_L, price, lower, upper, ext_L)
    if L <= 0:
        return 1.0
    amt0 = size_quote / price
    out, new_p, _ = swap_cp(amt0, True, price, L, FEE, 0.99)
    if out <= 0:
        return 1.0
    exec_p = out / amt0
    return max(0.0, 1.0 - exec_p / price)


def recovery_metrics(price: float, pos_L: float, lower: int, upper: int) -> tuple[float, float]:
    """USDG-marked xTOMB in [spot, $1] ∩ range, and the fraction of that path covered.

    A gap below a fixed $1 band (price << lower) does not count as path depth, and a
    follow-band that no longer reaches $1 has coverage 0 near peg.
    """
    if price >= PEG - 1e-12:
        return 0.0, 1.0
    lower_p = tick_to_price(lower)
    upper_p = tick_to_price(upper)
    inter_lo = max(price, lower_p)
    inter_hi = min(PEG, upper_p)
    path_len = PEG - price
    if inter_hi <= inter_lo or path_len <= 0:
        return 0.0, 0.0
    coverage = (inter_hi - inter_lo) / path_len
    depth = 0.0
    if pos_L > 0:
        depth = pos_L * (1.0 / math.sqrt(inter_lo) - 1.0 / math.sqrt(inter_hi)) * price
    return depth, coverage


def quote_below(price: float, pos_L: float, lower: int, floor_price: float) -> float:
    """USDG between floor_price and spot — sell-side peg support."""
    if pos_L <= 0:
        return 0.0
    sqrt_p = math.sqrt(price)
    sqrt_a = math.sqrt(tick_to_price(lower))
    sqrt_floor = math.sqrt(max(floor_price, 1e-8))
    bottom = max(sqrt_a, sqrt_floor)
    if sqrt_p <= bottom:
        return 0.0
    return pos_L * (sqrt_p - bottom)


def value_of(amt0: float, amt1: float, price: float) -> float:
    return amt0 * price + amt1


# --- price paths -------------------------------------------------------------

def _ou_step(p: float, rng: np.random.Generator, kappa: float, sigma: float, dt: float) -> float:
    return p + kappa * (PEG - p) * dt + sigma * math.sqrt(dt) * float(rng.normal())


def tomb_path(kind: str, seed: int) -> np.ndarray:
    rng = np.random.default_rng(10_000 + seed * 17 + sum(ord(c) for c in kind) * 13 % 997)
    dt = DT_SECONDS / (365.25 * 24 * 3600)
    p = PEG
    out = np.empty(STEPS + 1)
    out[0] = p
    sigma = {"calm": 0.15, "depeg10": 0.25, "depeg30": 0.30, "pump20": 0.22,
             "fire_cascade": 0.28, "manipulate": 0.20, "sustained_sell": 0.24,
             "sharp_recover": 0.28, "deposit_redeem": 0.18, "redeem_depeg": 0.30}.get(kind, 0.22)
    kappa = {"calm": 80.0, "fire_cascade": 18.0, "sustained_sell": 12.0,
             "deposit_redeem": 70.0, "sharp_recover": 40.0}.get(kind, 45.0)
    for i in range(1, STEPS + 1):
        k = 110.0 if kind == "sharp_recover" and i > 10 * 24 else kappa
        p = max(_ou_step(p, rng, k, sigma, dt), 0.05)
        if kind == "depeg10" and i in (8 * 24, 22 * 24, 40 * 24):
            p *= 0.90
        elif kind in ("depeg30", "redeem_depeg") and i in (12 * 24, 36 * 24):
            p *= 0.70
        elif kind == "pump20" and i in (10 * 24, 28 * 24, 48 * 24):
            p *= 1.20
        elif kind == "fire_cascade" and 6 * 24 <= i <= 18 * 24:
            p *= 0.997
        elif kind == "sustained_sell" and 4 * 24 <= i <= 30 * 24:
            p *= 0.9982
        elif kind == "sharp_recover" and i == 10 * 24:
            p *= 0.72
        elif kind == "manipulate" and i % (7 * 24) in (20, 21):
            p *= 1.08 if i % (7 * 24) == 20 else (1 / 1.08)
        p = min(max(p, 0.05), 3.0)
        out[i] = p
    return out


def share_path(kind: str, seed: int) -> np.ndarray:
    rng = np.random.default_rng(20_000 + seed * 31 + sum(ord(c) for c in kind) * 17 % 991)
    dt = DT_SECONDS / (365.25 * 24 * 3600)
    p = PEG
    out = np.empty(STEPS + 1)
    out[0] = p
    vol = {"chop": 0.80, "highvol": 1.10, "bull": 0.90, "crash": 1.40, "manipulate": 1.00}.get(kind, 1.0)
    mu = {"bull": 0.80, "crash": -0.15, "chop": 0.0}.get(kind, 0.10)
    for i in range(1, STEPS + 1):
        z = float(rng.normal())
        p *= math.exp((mu - 0.5 * vol * vol) * dt + vol * math.sqrt(dt) * z)
        if kind == "crash" and i == 14 * 24:
            p *= 0.45
        elif kind == "manipulate" and i % (5 * 24) in (10, 11):
            p *= 1.10 if i % (5 * 24) == 10 else (1 / 1.10)
        p = min(max(p, 0.02), 50.0)
        out[i] = p
    return out


def volume_for_step(kind: str, token: str, price: float, prev: float, start_tvl: float) -> tuple[float, float]:
    """Return (buy_quote, sell_quote) notionals hitting the pool this hour."""
    daily = DAILY_TURN_TOMB if token == "tomb" else DAILY_TURN_SHARE
    base = daily * start_tvl / 24.0
    ret = abs(price / prev - 1.0) if prev > 0 else 0.0
    base *= 1.0 + 8.0 * ret
    if token == "tomb" and price < PEG:
        base *= 1.0 + 3.0 * (PEG - price)
    # Bias: down moves are sells of the asset, up moves are buys.
    if price < prev:
        sell_share = 0.62
    elif price > prev:
        sell_share = 0.38
    else:
        sell_share = 0.50
    if token == "tomb" and kind in ("fire_cascade", "sustained_sell") and price < 0.97:
        sell_share = 0.75
    sell = base * sell_share
    buy = base * (1.0 - sell_share)
    return buy, sell


# --- simulation --------------------------------------------------------------

def compute_band(strategy: str, price: float, down: int, up: int) -> tuple[int, int]:
    if strategy == "fixed":
        return band_ticks(PEG, down, up)
    if strategy == "peg_anchor":
        return peg_anchor_ticks(price, down, up)
    return band_ticks(price, down, up)


def try_rebalance(state: dict, price: float, twap: float, cfg: dict, now: int) -> None:
    strategy = cfg["strategy"]
    if strategy == "fixed":
        return
    down, up = cfg["down"], cfg["up"]
    half = max(down, up)
    recenter = cfg["recenter"]
    tick = int(round(price_to_tick(price)))
    if not needs_recenter(tick, state["lower"], state["upper"], half, recenter):
        # peg_anchor may still want to stretch the far edge toward peg
        if strategy != "peg_anchor":
            return
        target = compute_band(strategy, price, down, up)
        if target == (state["lower"], state["upper"]):
            return
        # Only stretch if spot moved by the recenter threshold from last center.
        if abs(price / state["center"] - 1.0) * BPS < recenter:
            return
    else:
        target = compute_band(strategy, price, down, up)

    if now < state["last_ts"] + cfg["cooldown"]:
        state["cooldown_blocks"] += 1
        return
    if twap <= 0 or abs(price / twap - 1.0) * BPS > cfg["twap_dev"]:
        state["twap_blocks"] += 1
        return

    # Pull principal (+ uncollected fees already paid into amounts via fee accrual).
    sqrt_p = math.sqrt(price)
    sqrt_a = math.sqrt(tick_to_price(state["lower"]))
    sqrt_b = math.sqrt(tick_to_price(state["upper"]))
    a0, a1 = amounts_for_L(state["L"], sqrt_p, sqrt_a, sqrt_b)
    a0 += state["idle0"]
    a1 += state["idle1"]
    before = value_of(a0, a1, price)
    state["L"] = 0.0

    # Target band and inventory swap against residual (external) liquidity only,
    # matching "remove position then swap" in MasonryRangeManager.
    t_lo, t_hi = target
    ts_a = math.sqrt(tick_to_price(t_lo))
    ts_b = math.sqrt(tick_to_price(t_hi))
    l0 = a0 / (1.0 / sqrt_p - 1.0 / ts_b) if sqrt_p < ts_b else 0.0
    l1 = a1 / (sqrt_p - ts_a) if sqrt_p > ts_a else 0.0
    swap0 = swap1 = 0.0
    ext_L = state["ext_L"]
    max_dev = cfg["twap_dev"] / BPS
    if l0 > l1 and l1 > 0:
        used0 = (1.0 / sqrt_p - 1.0 / ts_b) * l1
        excess0 = a0 - used0
        if excess0 > 1e-9:
            out, _, filled = swap_cp(excess0, True, price, ext_L, FEE, max_dev)
            swap0 = -filled
            swap1 = out
            a0 -= filled
            a1 += out
            # Hypothetical Fire Tax if this sell of xTOMB were not exempt.
            tax = filled * fire_tax_bps(price) / BPS
            state["hyp_tax"] += tax * price
            state["hyp_tax_asset"] += tax
            state["rebal_sell_asset"] += filled
    elif l1 > l0 and l0 > 0:
        used1 = (sqrt_p - ts_a) * l0
        excess1 = a1 - used1
        if excess1 > 1e-9:
            out, _, filled = swap_cp(excess1, False, price, ext_L, FEE, max_dev)
            swap1 = -filled
            swap0 = out
            a1 -= filled
            a0 += out
            state["rebal_buy_asset"] += out

    after_swap = value_of(a0, a1, price)
    loss = (before - after_swap) / before if before > 0 else 0.0
    if loss > MAX_LOSS:
        # Revert: put the old position back (nudge catch). Use pre-swap amounts.
        a0 -= swap0 if swap0 > 0 else 0.0
        # Simpler: we already mutated; treat as failed by restoring from before via skipping
        # because we zeroed L and mixed tokens. Record fail and redeploy into OLD band
        # without counting a successful recenter — matches a full tx revert (state unchanged).
        state["loss_blocks"] += 1
        # Cannot cheaply restore; approximate revert by rejecting the swap mutation:
        # We saved `before` composition in a0/a1 before swap only if we keep copies.
        return  # BUG: state is mutated. Fix below in caller by copying first.

    state["rebal_cost"] += max(before - after_swap, 0.0)
    new_L = L_for_amounts(a0, a1, sqrt_p, ts_a, ts_b)
    used0, used1 = amounts_for_L(new_L, sqrt_p, ts_a, ts_b)
    state["L"] = new_L
    state["idle0"] = max(a0 - used0, 0.0)
    state["idle1"] = max(a1 - used1, 0.0)
    state["lower"], state["upper"] = t_lo, t_hi
    state["center"] = price
    state["last_ts"] = now
    state["rebalances"] += 1
    if swap0 != 0.0 or swap1 != 0.0:
        state["swap_legs"] += 1


def _snapshot_amounts(state: dict, price: float) -> tuple[float, float]:
    sqrt_p = math.sqrt(price)
    sqrt_a = math.sqrt(tick_to_price(state["lower"]))
    sqrt_b = math.sqrt(tick_to_price(state["upper"]))
    a0, a1 = amounts_for_L(state["L"], sqrt_p, sqrt_a, sqrt_b)
    return a0 + state["idle0"], a1 + state["idle1"]


USER_DEPOSIT = 50_000.0
USER_BAND_BPS = 1500


def _user_deposit(user: dict, value: float, price: float) -> None:
    if value <= 0 or price <= 0:
        return
    sqrt_p = math.sqrt(price)
    sqrt_a = math.sqrt(tick_to_price(user["lower"]))
    sqrt_b = math.sqrt(tick_to_price(user["upper"]))
    amt0, amt1 = (value / 2.0) / price, value / 2.0
    user["L"] += L_for_amounts(amt0, amt1, sqrt_p, sqrt_a, sqrt_b)
    user["deposited"] += value


def _user_redeem(user: dict, frac: float, price: float, state: dict) -> None:
    if user["L"] <= 0 or frac <= 0:
        return
    take = user["L"] * min(frac, 1.0)
    sqrt_p = math.sqrt(price)
    sqrt_a = math.sqrt(tick_to_price(user["lower"]))
    sqrt_b = math.sqrt(tick_to_price(user["upper"]))
    a0, a1 = amounts_for_L(take, sqrt_p, sqrt_a, sqrt_b)
    user["L"] -= take
    tax = a0 * fire_tax_bps(price) / BPS
    sell = max(a0 - tax, 0.0)
    tick = price_to_tick(price)
    user_in = user["L"] if user["lower"] < tick < user["upper"] else 0.0
    L_act = active_L(state["L"], price, state["lower"], state["upper"], state["ext_L"] + user_in)
    out, _, _ = swap_cp(sell, True, price, max(L_act, 1e-12), FEE, 0.99)
    user["redeemed"] += a1 + out



def run_path(prices: np.ndarray, cfg: dict, token: str, kind: str) -> dict:
    down, up = cfg["down"], cfg["up"]
    strategy = cfg["strategy"]
    p0 = float(prices[0])
    lower, upper = compute_band(strategy, p0, down, up)
    # Seed 50/50 value into the opening band (fixed uses peg-centered band at p0~1).
    half = START_VALUE / 2.0
    amt0, amt1 = half / p0, half
    sqrt_p = math.sqrt(p0)
    sqrt_a = math.sqrt(tick_to_price(lower))
    sqrt_b = math.sqrt(tick_to_price(upper))
    L = L_for_amounts(amt0, amt1, sqrt_p, sqrt_a, sqrt_b)
    used0, used1 = amounts_for_L(L, sqrt_p, sqrt_a, sqrt_b)
    ext_L = math.sqrt((EXT_FRACTION * START_VALUE / p0) * (EXT_FRACTION * START_VALUE))
    state = {
        "L": L, "idle0": amt0 - used0, "idle1": amt1 - used1,
        "lower": lower, "upper": upper, "center": p0, "last_ts": -10**9,
        "ext_L": ext_L, "rebalances": 0, "rebal_cost": 0.0, "fees": 0.0,
        "hyp_tax": 0.0, "hyp_tax_asset": 0.0, "rebal_sell_asset": 0.0,
        "rebal_buy_asset": 0.0, "swap_legs": 0,
        "cooldown_blocks": 0, "twap_blocks": 0, "loss_blocks": 0,
        "in_range_steps": 0, "steps": 0,
        "slip_sum": 0.0, "slip_n": 0, "peg_slip_sum": 0.0, "peg_slip_n": 0,
        "recov_depth_sum": 0.0, "recov_depth_n": 0, "recov_cov_sum": 0.0,
        "recov_cov_n": 0, "support_sum": 0.0, "support_n": 0,
        "fail_reverts": 0, "below_peg": 0, "usdg_depeg_sum": 0.0, "usdg_depeg_n": 0,
    }

    # Use copies inside try_rebalance to honor revert semantics.
    twap = p0
    start0, start1 = amt0, amt1
    hodl0, hodl1 = amt0, amt1
    user = {
        "lower": 0, "upper": 0, "L": 0.0, "deposited": 0.0, "redeemed": 0.0,
        "depeg_redeemed": False,
    }
    if token == "tomb":
        user["lower"], user["upper"] = band_ticks(PEG, USER_BAND_BPS, USER_BAND_BPS)
        _user_deposit(user, USER_DEPOSIT, p0)

    for i in range(1, len(prices)):
        prev = float(prices[i - 1])
        price = float(prices[i])
        now = i * DT_SECONDS
        if token == "tomb" and price < PEG:
            support = quote_below(price, state["L"], state["lower"], price * 0.5)
            tick_now = price_to_tick(price)
            if user["L"] and user["lower"] < tick_now < user["upper"]:
                support += quote_below(price, user["L"], user["lower"], price * 0.5)
            price = price + (PEG - price) * 0.012 * min(support / (0.25 * START_VALUE), 1.5)
        twap = 0.75 * twap + 0.25 * price  # ~few-hour EWMA
        buy_q, sell_q = volume_for_step(kind, token, price, prev, START_VALUE)

        # Fire Tax reduces the xTOMB sell that actually hits the pool.
        if token == "tomb" and sell_q > 0:
            tax_rate = fire_tax_bps(price) / BPS
            sell_q = sell_q * (1.0 - tax_rate)

        tick = price_to_tick(price)
        in_range = state["lower"] < tick < state["upper"]
        state["steps"] += 1
        if in_range:
            state["in_range_steps"] += 1
        if token == "tomb" and price < PEG:
            state["below_peg"] += 1
            state["usdg_depeg_sum"] += _snapshot_amounts(state, price)[1]
            state["usdg_depeg_n"] += 1

        user_in = 0.0
        if token == "tomb" and user["L"] and user["lower"] < tick < user["upper"]:
            user_in = user["L"]
        L_act = active_L(state["L"], price, state["lower"], state["upper"], state["ext_L"] + user_in)
        # Fees: protocol share of 30bp on volume that trades while we are in range.
        vol = buy_q + sell_q
        if in_range and L_act > 0:
            share = state["L"] / L_act
            fee_quote = vol * FEE * share
            state["fees"] += fee_quote
            # Accrue fees into idle quote (approximate: fees paid in both tokens; mark in quote).
            state["idle1"] += fee_quote

        # Slippage / depth snapshots
        slip = slippage_sell_asset(TYPICAL_SELL, price, state["L"], state["lower"], state["upper"], state["ext_L"])
        state["slip_sum"] += slip
        state["slip_n"] += 1
        if token == "tomb" and abs(price - PEG) <= 0.02:
            state["peg_slip_sum"] += slip
            state["peg_slip_n"] += 1
            state["support_sum"] += quote_below(price, state["L"], state["lower"], price * 0.99)
            state["support_n"] += 1
        if token == "tomb" and price < PEG - 0.005:
            d, cov = recovery_metrics(price, state["L"], state["lower"], state["upper"])
            state["recov_depth_sum"] += d
            state["recov_depth_n"] += 1
            state["recov_cov_sum"] += cov
            state["recov_cov_n"] += 1

        if token == "tomb":
            if kind == "deposit_redeem" and i == 7 * 24:
                _user_deposit(user, 25_000.0, price)
            if kind == "deposit_redeem" and i in (21 * 24, 40 * 24):
                _user_redeem(user, 0.40, price, state)
            if (
                kind in ("redeem_depeg", "depeg30", "depeg10", "sharp_recover", "sustained_sell")
                and price < 0.88
                and not user["depeg_redeemed"]
            ):
                _user_redeem(user, 0.50, price, state)
                user["depeg_redeemed"] = True

        # Attempt recenter after flow (hook nudge).
        saved = (state["L"], state["idle0"], state["idle1"], state["lower"], state["upper"],
                 state["center"], state["last_ts"], state["rebal_cost"], state["hyp_tax"],
                 state["hyp_tax_asset"], state["rebal_sell_asset"], state["rebal_buy_asset"],
                 state["swap_legs"], state["rebalances"])
        try_rebalance(state, price, twap, cfg, now)
        # Detect broken revert path: if loss_blocks increased, restore.
        # try_rebalance increments loss_blocks then currently returns after mutation.
        # We fix revert by checking last successful flag via comparing rebalances vs saved.

    # Fix: re-run rebalance properly with snapshot restore. The loop already called
    # try_rebalance which may have a revert bug. Patch try_rebalance usage:
    # (see corrected function — we restore if rebalances didn't increment but tokens changed)

    end_p = float(prices[-1])
    e0, e1 = _snapshot_amounts(state, end_p)
    end_val = value_of(e0, e1, end_p)
    hodl_val = value_of(hodl0, hodl1, end_p)
    if token == "tomb" and user["L"] > 0:
        _user_redeem(user, 1.0, end_p, state)
    user_redeem_value = (user["redeemed"] / user["deposited"]) if user["deposited"] else None
    usdg_reserves = e1
    if state["usdg_depeg_n"]:
        usdg_reserves = 0.5 * e1 + 0.5 * (state["usdg_depeg_sum"] / state["usdg_depeg_n"])
    return {
        "end_value": end_val,
        "end_amt0": e0,
        "end_amt1": e1,
        "time_below_peg": state["below_peg"] / max(state["steps"], 1),
        "usdg_reserves": usdg_reserves,
        "user_redeem_value": user_redeem_value,
        "net_pnl": (end_val - START_VALUE) / START_VALUE,
        "vs_hodl": end_val / hodl_val - 1.0 if hodl_val > 0 else 0.0,
        "fees": state["fees"],
        "rebalances": state["rebalances"],
        "rebal_cost": state["rebal_cost"],
        "hyp_tax": state["hyp_tax"],
        "hyp_tax_pct": state["hyp_tax"] / START_VALUE,
        "rebal_sell_asset": state["rebal_sell_asset"],
        "time_in_range": state["in_range_steps"] / max(state["steps"], 1),
        "avg_slip": state["slip_sum"] / max(state["slip_n"], 1),
        "peg_slip": state["peg_slip_sum"] / max(state["peg_slip_n"], 1) if state["peg_slip_n"] else None,
        "recovery_depth": state["recov_depth_sum"] / max(state["recov_depth_n"], 1) if state["recov_depth_n"] else 0.0,
        "recovery_coverage": state["recov_cov_sum"] / max(state["recov_cov_n"], 1) if state.get("recov_cov_n") else 0.0,
        "support_1pct": state["support_sum"] / max(state["support_n"], 1) if state["support_n"] else 0.0,
        "twap_blocks": state["twap_blocks"],
        "cooldown_blocks": state["cooldown_blocks"],
        "loss_blocks": state["loss_blocks"],
        "kind": kind,
    }


# Correct revert semantics: rewrite try_rebalance to snapshot internally.
def try_rebalance(state: dict, price: float, twap: float, cfg: dict, now: int) -> None:
    strategy = cfg["strategy"]
    if strategy == "fixed":
        return
    down, up = cfg["down"], cfg["up"]
    half = max(down, up)
    recenter = cfg["recenter"]
    tick = int(round(price_to_tick(price)))
    must = needs_recenter(tick, state["lower"], state["upper"], half, recenter)
    if not must:
        if strategy != "peg_anchor":
            return
        target = compute_band(strategy, price, down, up)
        if target == (state["lower"], state["upper"]):
            return
        if abs(price / state["center"] - 1.0) * BPS < recenter:
            return
    else:
        target = compute_band(strategy, price, down, up)

    if now < state["last_ts"] + cfg["cooldown"]:
        state["cooldown_blocks"] += 1
        return
    if twap <= 0 or abs(price / twap - 1.0) * BPS > cfg["twap_dev"]:
        state["twap_blocks"] += 1
        return

    snap = {k: state[k] for k in ("L", "idle0", "idle1", "lower", "upper", "center", "last_ts")}
    sqrt_p = math.sqrt(price)
    sqrt_a = math.sqrt(tick_to_price(state["lower"]))
    sqrt_b = math.sqrt(tick_to_price(state["upper"]))
    a0, a1 = amounts_for_L(state["L"], sqrt_p, sqrt_a, sqrt_b)
    a0 += state["idle0"]
    a1 += state["idle1"]
    before = value_of(a0, a1, price)

    t_lo, t_hi = target
    ts_a = math.sqrt(tick_to_price(t_lo))
    ts_b = math.sqrt(tick_to_price(t_hi))
    l0 = a0 / max(1.0 / sqrt_p - 1.0 / ts_b, 1e-18) if sqrt_p < ts_b else 0.0
    l1 = a1 / max(sqrt_p - ts_a, 1e-18) if sqrt_p > ts_a else 0.0

    hyp_tax_add = 0.0
    hyp_tax_asset = 0.0
    sell_add = 0.0
    buy_add = 0.0
    ext_L = state["ext_L"]
    max_dev = cfg["twap_dev"] / BPS
    did_swap = False
    if l0 > l1 and l1 > 0:
        used0 = (1.0 / sqrt_p - 1.0 / ts_b) * l1
        excess0 = a0 - used0
        if excess0 > 1e-9:
            out, _, filled = swap_cp(excess0, True, price, ext_L, FEE, max_dev)
            a0 -= filled
            a1 += out
            hyp_tax_asset = filled * fire_tax_bps(price) / BPS
            hyp_tax_add = hyp_tax_asset * price
            sell_add = filled
            did_swap = filled > 0
    elif l1 > l0 and l0 > 0:
        used1 = (sqrt_p - ts_a) * l0
        excess1 = a1 - used1
        if excess1 > 1e-9:
            out, _, filled = swap_cp(excess1, False, price, ext_L, FEE, max_dev)
            a1 -= filled
            a0 += out
            buy_add = out
            did_swap = filled > 0

    after_swap = value_of(a0, a1, price)
    if before > 0 and (before - after_swap) / before > MAX_LOSS:
        state["loss_blocks"] += 1
        return  # snap already holds old state; we didn't write it back yet

    new_L = L_for_amounts(a0, a1, sqrt_p, ts_a, ts_b)
    used0, used1 = amounts_for_L(new_L, sqrt_p, ts_a, ts_b)
    state["L"] = new_L
    state["idle0"] = max(a0 - used0, 0.0)
    state["idle1"] = max(a1 - used1, 0.0)
    state["lower"], state["upper"] = t_lo, t_hi
    state["center"] = price
    state["last_ts"] = now
    state["rebalances"] += 1
    state["rebal_cost"] += max(before - after_swap, 0.0)
    state["hyp_tax"] += hyp_tax_add
    state["hyp_tax_asset"] += hyp_tax_asset
    state["rebal_sell_asset"] += sell_add
    state["rebal_buy_asset"] += buy_add
    if did_swap:
        state["swap_legs"] += 1
    _ = snap  # unused except documenting revert-by-not-writing


def summarize(rows: list[dict]) -> dict:
    def arr(key):
        return np.array([r[key] for r in rows if r.get(key) is not None], dtype=float)

    def stats(key):
        a = arr(key)
        if a.size == 0:
            return {"mean": None, "median": None, "p10": None}
        return {
            "mean": float(a.mean()),
            "median": float(np.median(a)),
            "p10": float(np.percentile(a, 10)),
        }

    out = {k: stats(k) for k in (
        "net_pnl", "vs_hodl", "fees", "rebalances", "rebal_cost", "hyp_tax",
        "hyp_tax_pct", "time_in_range", "avg_slip", "peg_slip", "recovery_depth",
        "recovery_coverage", "support_1pct", "end_value", "time_below_peg",
        "usdg_reserves", "user_redeem_value",
    )}
    out["n"] = len(rows)
    return out


def score_tomb(s: dict) -> float:
    """Higher is better. Emphasize recovery depth and ending inventory, not just TIR."""
    end = s["end_value"]["median"] or 0.0
    recov = s["recovery_depth"]["median"] or 0.0
    recov_p10 = s["recovery_depth"]["p10"] or 0.0
    cov = s.get("recovery_coverage", {}).get("median") or 0.0
    pnl = s["vs_hodl"]["median"] or 0.0
    pnl_p10 = s["vs_hodl"]["p10"] or 0.0
    peg_slip = s["peg_slip"]["median"] if s["peg_slip"]["median"] is not None else s["avg_slip"]["median"] or 0.0
    tbp = (s.get("time_below_peg") or {}).get("median") or 0.0
    usdg = (s.get("usdg_reserves") or {}).get("median") or 0.0
    uredeem = (s.get("user_redeem_value") or {}).get("median") or 0.0
    return (
        0.25 * ((end - START_VALUE) / START_VALUE)
        + 0.10 * pnl + 0.08 * pnl_p10
        + 0.14 * (recov / START_VALUE) + 0.06 * (recov_p10 / START_VALUE)
        + 0.12 * cov
        + 0.10 * (usdg / START_VALUE)
        + 0.12 * uredeem
        - 0.08 * tbp
        - 0.12 * (peg_slip or 0.0)
    )


def score_share(s: dict) -> float:
    pnl = s["vs_hodl"]["median"] or 0.0
    pnl_p10 = s["vs_hodl"]["p10"] or 0.0
    tir = s["time_in_range"]["median"] or 0.0
    slip = s["avg_slip"]["median"] or 0.0
    return 0.30 * pnl + 0.40 * pnl_p10 + 0.20 * tir - 0.15 * slip - 0.05 * ((s["rebal_cost"]["median"] or 0) / START_VALUE)


TOMB_KINDS = [
    "calm", "depeg10", "depeg30", "pump20", "fire_cascade", "manipulate",
    "sustained_sell", "sharp_recover", "deposit_redeem", "redeem_depeg",
]
SHARE_KINDS = ["chop", "highvol", "bull", "crash", "manipulate"]


def grid_tomb_phase1():
    widths = [500, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000]
    rec_fracs = [0.50, 0.67, 0.80]
    cooldowns = [1800]
    twaps = [300]
    strategies = ["follow", "fixed", "peg_anchor"]
    cfgs = []
    for strat in strategies:
        for w in widths:
            fracs = [1.0] if strat == "fixed" else rec_fracs
            cds = [86400] if strat == "fixed" else cooldowns
            for rf in fracs:
                rec = max(100, min(int(w * rf), w - 1))
                for cd in cds:
                    for td in twaps:
                        cfgs.append({
                            "strategy": strat, "down": w, "up": w, "half": w,
                            "recenter": rec, "cooldown": cd, "twap_dev": td,
                            "label": f"{strat}/w{w}/r{rec}/cd{cd}/td{td}",
                        })
    return cfgs


def grid_share_phase1():
    widths = [800, 1200, 1500, 2000, 2500, 3000, 4000, 5000]
    rec_fracs = [0.50, 0.67, 0.80]
    cfgs = []
    for w in widths:
        for rf in rec_fracs:
            rec = max(100, min(int(w * rf), w - 1))
            for cd in (1800, 3600):
                for td in (300, 500):
                    cfgs.append({
                        "strategy": "follow", "down": w, "up": w, "half": w,
                        "recenter": rec, "cooldown": cd, "twap_dev": td,
                        "label": f"follow/w{w}/r{rec}/cd{cd}/td{td}",
                    })
    return cfgs


def refine_tomb(best_follow_w: int):
    """Local refine + cooldown/twap around the winning follow width; keep strategy comparison."""
    widths = sorted(set([best_follow_w - 300, best_follow_w, best_follow_w + 300, 1500, 2000]))
    widths = [w for w in widths if 400 <= w <= 5000]
    cfgs = []
    for strat in ("follow", "peg_anchor"):
        for w in widths:
            for rf in (0.55, 0.67, 0.75):
                rec = max(100, min(int(w * rf), w - 1))
                for cd in (900, 1800, 3600, 14400):
                    for td in (200, 300, 500):
                        cfgs.append({
                            "strategy": strat, "down": w, "up": w, "half": w,
                            "recenter": rec, "cooldown": cd, "twap_dev": td,
                            "label": f"{strat}/w{w}/r{rec}/cd{cd}/td{td}",
                        })
    # Asymmetric follow: wider below for peg support
    for down, up in ((2000, 1200), (1800, 1000), (2500, 1500), (2000, 1500)):
        rec = min(down, up) * 2 // 3
        cfgs.append({
            "strategy": "follow", "down": down, "up": up, "half": max(down, up),
            "recenter": rec, "cooldown": 1800, "twap_dev": 300,
            "label": f"follow/d{down}/u{up}/r{rec}/cd1800/td300",
        })
        cfgs.append({
            "strategy": "peg_anchor", "down": down, "up": up, "half": max(down, up),
            "recenter": rec, "cooldown": 1800, "twap_dev": 300,
            "label": f"peg_anchor/d{down}/u{up}/r{rec}/cd1800/td300",
        })
    return cfgs


def refine_share(best_w: int):
    widths = sorted(set([best_w - 500, best_w, best_w + 500, 2500, 3000]))
    widths = [w for w in widths if 500 <= w <= 5000]
    cfgs = []
    for w in widths:
        for rf in (0.55, 0.67, 0.80):
            rec = max(100, min(int(w * rf), w - 1))
            for cd in (900, 1800, 3600, 14400):
                for td in (200, 300, 500):
                    cfgs.append({
                        "strategy": "follow", "down": w, "up": w, "half": w,
                        "recenter": rec, "cooldown": cd, "twap_dev": td,
                        "label": f"follow/w{w}/r{rec}/cd{cd}/td{td}",
                    })
    return cfgs


def run_sweep(token: str, cfgs: list[dict], seeds: int) -> list[dict]:
    kinds = TOMB_KINDS if token == "tomb" else SHARE_KINDS
    path_fn = tomb_path if token == "tomb" else share_path
    cache = {(kind, s): path_fn(kind, s) for kind in kinds for s in range(seeds)}
    results = []
    t0 = time.time()
    for i, cfg in enumerate(cfgs):
        rows = []
        for kind in kinds:
            for s in range(seeds):
                rows.append(run_path(cache[(kind, s)], cfg, token, kind))
        summary = summarize(rows)
        summary["cfg"] = cfg
        summary["token"] = token
        summary["score"] = score_tomb(summary) if token == "tomb" else score_share(summary)
        results.append(summary)
        if (i + 1) % 10 == 0 or i + 1 == len(cfgs):
            print(f"  {token} {i+1}/{len(cfgs)} elapsed {time.time()-t0:.1f}s", flush=True)
    results.sort(key=lambda r: r["score"], reverse=True)
    return results


def width_curve(token: str, companion: dict, seeds: int) -> list[dict]:
    widths = [300, 500, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000]
    cfgs = []
    for w in widths:
        rec = max(100, min(int(w * companion["recenter"] / max(companion["half"], 1)), w - 1))
        if rec >= w:
            rec = w - 1
        cfgs.append({
            "strategy": companion.get("strategy", "follow"),
            "down": w, "up": w, "half": w, "recenter": rec,
            "cooldown": companion["cooldown"], "twap_dev": companion["twap_dev"],
            "label": f"width-{w}",
        })
    return run_sweep(token, cfgs, seeds)


def pick_best(results, strategy=None):
    for r in results:
        if strategy is None or r["cfg"]["strategy"] == strategy:
            return r
    return results[0]


def dump_brief(r: dict) -> dict:
    c = r["cfg"]
    return {
        "label": c["label"],
        "strategy": c["strategy"],
        "down": c["down"],
        "up": c["up"],
        "recenter": c["recenter"],
        "cooldown": c["cooldown"],
        "twap_dev": c["twap_dev"],
        "score": r["score"],
        "end_value": r["end_value"],
        "vs_hodl": r["vs_hodl"],
        "net_pnl": r["net_pnl"],
        "fees": r["fees"],
        "rebalances": r["rebalances"],
        "rebal_cost": r["rebal_cost"],
        "hyp_tax": r["hyp_tax"],
        "hyp_tax_pct": r["hyp_tax_pct"],
        "time_in_range": r["time_in_range"],
        "avg_slip": r["avg_slip"],
        "peg_slip": r["peg_slip"],
        "recovery_depth": r["recovery_depth"],
        "recovery_coverage": r.get("recovery_coverage"),
        "support_1pct": r["support_1pct"],
        "time_below_peg": r.get("time_below_peg"),
        "usdg_reserves": r.get("usdg_reserves"),
        "user_redeem_value": r.get("user_redeem_value"),
        "n": r["n"],
    }


def make_chart(tomb_curve, share_curve, out_png: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def xs_ys(curve):
        xs = [r["cfg"]["half"] / 100.0 for r in sorted(curve, key=lambda r: r["cfg"]["half"])]
        ys = [100.0 * (r["vs_hodl"]["median"] or 0.0) for r in sorted(curve, key=lambda r: r["cfg"]["half"])]
        return xs, ys

    fig, axes = plt.subplots(1, 2, figsize=(10.5, 4.2), sharey=False)
    for ax, curve, title in (
        (axes[0], tomb_curve, "xTOMB / USDG"),
        (axes[1], share_curve, "xSHARE / USDG"),
    ):
        xs, ys = xs_ys(curve)
        ax.plot(xs, ys, marker="o", color="#6ee7b7", linewidth=2)
        ax.axhline(0, color="#444", linewidth=0.8)
        ax.set_title(title)
        ax.set_xlabel("Half-width (%)")
        ax.set_ylabel("Median net PnL vs HODL (%)")
        ax.grid(True, alpha=0.25)
    fig.suptitle("Range width vs net PnL (60-day Monte Carlo, companion knobs held at the chosen optimum)")
    fig.tight_layout()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=140)
    plt.close(fig)


def self_check() -> None:
    lo, hi = band_ticks(1.0, 1500, 1500)
    width = hi - lo
    assert 2000 < width < 4000, width
    assert not needs_recenter(0, -1500, 1500, 1500, 1000)
    assert needs_recenter(1100, -1500, 1500, 1500, 1000)
    assert fire_tax_bps(1.0) == 300
    assert fire_tax_bps(0.90) == 1200
    plo, phi = peg_anchor_ticks(0.85, 1500, 1500)
    assert tick_to_price(phi) >= 1.0 * 0.99
    print("self-check ok", {"band": (lo, hi), "peg_anchor_at_0.85": (plo, phi, tick_to_price(phi))})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="docs/sim")
    ap.add_argument("--seeds", type=int, default=8)
    ap.add_argument("--refine-seeds", type=int, default=12)
    ap.add_argument("--curve-seeds", type=int, default=10)
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    if args.quick:
        args.seeds = 3
        args.refine_seeds = 4
        args.curve_seeds = 3
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    self_check()

    print("phase 1 tomb", flush=True)
    tomb1 = run_sweep("tomb", grid_tomb_phase1(), args.seeds)
    best_follow = pick_best(tomb1, "follow")
    print("phase 1 share", flush=True)
    share1 = run_sweep("share", grid_share_phase1(), args.seeds)
    best_share_p1 = pick_best(share1)

    print("phase 2 tomb refine", flush=True)
    tomb2 = run_sweep("tomb", refine_tomb(best_follow["cfg"]["half"]), args.refine_seeds)
    print("phase 2 share refine", flush=True)
    share2 = run_sweep("share", refine_share(best_share_p1["cfg"]["half"]), args.refine_seeds)

    tomb_all = tomb1 + tomb2
    share_all = share1 + share2
    tomb_all.sort(key=lambda r: r["score"], reverse=True)
    share_all.sort(key=lambda r: r["score"], reverse=True)

    chosen_tomb_follow = pick_best(tomb_all, "follow")
    chosen_tomb_fixed = pick_best(tomb_all, "fixed")
    chosen_tomb_anchor = pick_best(tomb_all, "peg_anchor")
    chosen_share = pick_best(share_all)

    # Width curves at each token's chosen follow companion knobs
    print("width curves", flush=True)
    tomb_curve = width_curve("tomb", chosen_tomb_follow["cfg"], args.curve_seeds)
    share_curve = width_curve("share", chosen_share["cfg"], args.curve_seeds)
    shots = Path("/workspace/v4-assess/shots")
    png = shots / "range-pnl-vs-width.png"
    make_chart(tomb_curve, share_curve, png)

    payload = {
        "meta": {
            "days": DAYS, "step_seconds": DT_SECONDS, "start_value": START_VALUE,
            "seeds_phase1": args.seeds, "seeds_refine": args.refine_seeds,
            "fee": FEE, "ext_fraction": EXT_FRACTION,
            "fire_tax_note": (
                "Rebalance swaps that sell xTOMB are Fire-Tax-exempt when "
                "MasonryTaxHook.rangeManager is bound (sender == rangeManager). "
                "hyp_tax is the hypothetical USDG-marked tax if that bind were missing."
            ),
        },
        "tomb": {
            "best_follow": dump_brief(chosen_tomb_follow),
            "best_fixed": dump_brief(chosen_tomb_fixed),
            "best_peg_anchor": dump_brief(chosen_tomb_anchor),
            "top10": [dump_brief(r) for r in tomb_all[:10]],
            "width_curve": [dump_brief(r) for r in sorted(tomb_curve, key=lambda r: r["cfg"]["half"])],
        },
        "share": {
            "best": dump_brief(chosen_share),
            "top10": [dump_brief(r) for r in share_all[:10]],
            "width_curve": [dump_brief(r) for r in sorted(share_curve, key=lambda r: r["cfg"]["half"])],
        },
        "chart": str(png),
    }
    out_json = outdir / "range_sweep_results.json"
    out_json.write_text(json.dumps(payload, indent=2))
    print("wrote", out_json)
    print("chart", png)
    print("BEST TOMB FOLLOW", json.dumps(payload["tomb"]["best_follow"], indent=2))
    print("BEST TOMB FIXED", json.dumps(payload["tomb"]["best_fixed"], indent=2))
    print("BEST TOMB PEG_ANCHOR", json.dumps(payload["tomb"]["best_peg_anchor"], indent=2))
    print("BEST SHARE", json.dumps(payload["share"]["best"], indent=2))


if __name__ == "__main__":
    main()
