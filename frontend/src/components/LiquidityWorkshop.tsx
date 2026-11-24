import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";

import { AmountField, parseAmount } from "@/components/AmountField";
import { Reason } from "@/components/Status";
import { TokenIcon, type TokenSymbol } from "@/components/TokenIcon";
import { formatToken } from "@/lib/format";
import { useActions, useProtocol, useV4Position } from "@/lib/hooks";
import { getAmountsForLiquidity, getLiquidityForAmounts } from "@/lib/swap/liquidityMath";
import type { PoolId } from "@/lib/swap/poolKey";
import { getSqrtPriceAtTick, maxUsableTick, minUsableTick } from "@/lib/swap/tickMath";

const HUGE = 2n ** 127n - 1n;

interface Side {
  address: Address;
  symbol: string;
  decimals: number;
  balance: bigint | null;
  icon: TokenSymbol;
}

/**
 * Turns two tokens into a stakeable wrapper token, and back.
 *
 *   Make   1. mint a full-range Uniswap V4 position (an NFT)
 *          2. wrap the NFT → wrapper shares (an ERC-20), 1 share per unit of liquidity
 *   Unmake 3. unwrap (burn the shares, get the NFT back — only the address that wrapped it can)
 *          4. remove the liquidity (burn the NFT, get both tokens back)
 *
 * Wrappers accept only the full range at tick spacing 60, so there is no range
 * to choose and nothing to go out of range.
 */
export function LiquidityWorkshop({ pool, focusKey }: { pool: PoolId; focusKey?: number }) {
  const p = useProtocol();
  const act = useActions();
  const d = p.net.deployment;
  const state = p.pools[pool];
  const [tab, setTab] = useState<"make" | "unmake">("make");
  const [driver, setDriver] = useState<0 | 1>(0);
  const [raw, setRaw] = useState("");
  const [tokenId, setTokenId] = useState("");

  useEffect(() => {
    setRaw("");
  }, [pool]);
  useEffect(() => {
    if (focusKey) setTab("make");
  }, [focusKey]);

  const wrapper = d ? (pool === "peg" ? d.lpWrapper : pool === "share" ? d.shareLpWrapper : d.pairLpWrapper) : null;
  const wrapperBalance = pool === "peg" ? p.balances.pegLp : pool === "share" ? p.balances.shareLp : p.balances.pairLp;
  const wrapperIcon: TokenSymbol = pool === "peg" ? "PEG-LP" : pool === "share" ? "SHARE-LP" : "PAIR-LP";

  // Token metadata for currency0 / currency1 of this pool.
  const sides = useMemo<[Side, Side] | null>(() => {
    if (!d || !state) return null;
    const meta = (a: Address): Side =>
      a.toLowerCase() === d.peg.toLowerCase()
        ? { address: a, symbol: p.symbols.peg, decimals: 18, balance: p.balances.peg, icon: "xTOMB" }
        : a.toLowerCase() === d.share.toLowerCase()
          ? { address: a, symbol: p.symbols.share, decimals: 18, balance: p.balances.share, icon: "xSHARE" }
          : { address: a, symbol: p.symbols.quote, decimals: p.quoteDecimals, balance: p.balances.quote, icon: "QUOTE" };
    return [meta(state.key.currency0), meta(state.key.currency1)];
  }, [d, state, p.symbols.peg, p.symbols.share, p.symbols.quote, p.quoteDecimals, p.balances.peg, p.balances.share, p.balances.quote]);

  const initialised = !!state && state.sqrtPriceX96 > 0n;
  const lower = state ? getSqrtPriceAtTick(minUsableTick(state.key.tickSpacing)) : 0n;
  const upper = state ? getSqrtPriceAtTick(maxUsableTick(state.key.tickSpacing)) : 0n;

  // The typed side fixes the liquidity; the other side follows from the pool's current price.
  const plan = useMemo(() => {
    if (!sides || !state || !initialised) return null;
    const typed = parseAmount(raw, sides[driver].decimals);
    if (typed === null) return null;
    const liquidity = getLiquidityForAmounts(state.sqrtPriceX96, lower, upper, driver === 0 ? typed : HUGE, driver === 0 ? HUGE : typed);
    if (liquidity === 0n) return null;
    const { amount0, amount1 } = getAmountsForLiquidity(state.sqrtPriceX96, lower, upper, liquidity);
    return { liquidity, amount0, amount1 };
  }, [sides, state, initialised, raw, driver, lower, upper]);

  const show = (i: 0 | 1) => {
    if (!sides) return "";
    if (i === driver) return raw;
    if (!plan) return "";
    return formatUnits(i === 0 ? plan.amount0 : plan.amount1, sides[i].decimals);
  };
  const short = (i: 0 | 1) => !!plan && !!sides && sides[i].balance !== null && (i === 0 ? plan.amount0 : plan.amount1) > sides[i].balance!;

  const mintReason =
    act.blocked ??
    (!initialised
      ? "This pool has not been initialised yet."
      : !plan
        ? "Enter an amount for either token."
        : short(0)
          ? `Not enough ${sides![0].symbol}: this needs ${formatToken(plan.amount0, sides![0].decimals)}.`
          : short(1)
            ? `Not enough ${sides![1].symbol}: this needs ${formatToken(plan.amount1, sides![1].decimals)}.`
            : null);

  // 1% headroom on the pull caps: the position manager takes at most this, usually less.
  const cap = (n: bigint) => n + n / 100n + 1n;
  async function mint() {
    if (!plan || !state || mintReason) return;
    const res = await act.mintPosition({ key: state.key, liquidity: plan.liquidity, amount0Max: cap(plan.amount0), amount1Max: cap(plan.amount1) });
    if (res.ok) {
      setRaw("");
      if (res.tokenId !== null) setTokenId(res.tokenId.toString());
    }
  }

  const pos = useV4Position(d, wrapper, tokenId, p.account);
  const wrapReason =
    act.blocked ??
    (pos.tokenId === null
      ? "Enter the position's token ID. Minting above fills it in for you."
      : pos.loading
        ? "Checking the position…"
        : !pos.exists
          ? "No position with this ID exists."
          : pos.isWrapped
            ? pos.isWrapper
              ? "You already wrapped this position. The shares are in your wallet or staked."
              : "This position is already wrapped by another address."
            : !pos.isOwner
              ? "This position belongs to another address."
              : pos.liquidity === 0n
                ? "This position holds no liquidity, so it cannot be wrapped."
                : null);

  const unwrapReason =
    act.blocked ??
    (pos.tokenId === null
      ? "Enter the token ID of the position you wrapped."
      : pos.loading
        ? "Checking the position…"
        : !pos.isWrapped
          ? pos.isOwner
            ? "This position is not wrapped — it is already in your wallet. Go to step 4."
            : "This wrapper does not hold that position."
          : !pos.isWrapper
            ? "Only the address that wrapped a position can unwrap it."
            : (wrapperBalance ?? 0n) < pos.wrappedLiquidity
              ? `Unwrapping burns ${formatToken(pos.wrappedLiquidity)} shares and your wallet holds ${formatToken(wrapperBalance)}. Withdraw them from the farm or xROOM first.`
              : null);

  const burnAmounts = state && pos.liquidity > 0n && initialised ? getAmountsForLiquidity(state.sqrtPriceX96, lower, upper, pos.liquidity) : null;
  const removeReason =
    act.blocked ??
    (pos.tokenId === null
      ? "Enter the position's token ID."
      : pos.loading
        ? "Checking the position…"
        : pos.isWrapped
          ? "Still wrapped. Unwrap it first (step 3)."
          : !pos.isOwner
            ? "This position is not in your wallet."
            : !burnAmounts
              ? "This position holds no liquidity."
              : null);

  const floor = (n: bigint) => n - n / 100n;

  if (!d) return null;
  const pairLabel = sides ? `${sides[0].symbol} / ${sides[1].symbol}` : "—";

  return (
    <section data-reveal className="panel panel-raised p-5 md:p-6" aria-label="Liquidity workshop" id="workshop">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TokenIcon symbol={wrapperIcon} size={32} />
          <div>
            <div className="label mb-1">Liquidity workshop · full range</div>
            <h3 className="font-display text-lg font-semibold tracking-[-0.02em] text-bone">{pairLabel}</h3>
          </div>
        </div>
        <div className="inline-flex gap-1 rounded-xl border border-white/[0.07] bg-black/30 p-1" role="tablist" aria-label="Direction">
          {([["make", "Make & wrap"], ["unmake", "Unwrap & remove"]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)} className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${tab === id ? "bg-iris/15 text-iris-hot" : "text-ash hover:bg-white/5 hover:text-bone"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {pool === "pair" && (
        <p className="mb-5 rounded-xl border border-spectre/25 bg-spectre/[0.05] p-3 text-[13px] leading-relaxed text-bone-dim">
          This pool is <span className="font-semibold text-bone">liquidity only</span>: its hook rejects every swap, so the ratio you add at never moves and no fees accrue. Adding and removing liquidity here is not a trade and pays no sell tax.
        </p>
      )}

      {tab === "make" ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <StepHead n={1} title="Mint a full-range position" />
            {sides && (
              <div className="space-y-3">
                {([0, 1] as const).map((i) => (
                  <AmountField
                    key={i}
                    label={sides[i].symbol}
                    value={show(i)}
                    onChange={(v) => {
                      setDriver(i);
                      setRaw(v);
                    }}
                    symbol={sides[i].symbol}
                    icon={<TokenIcon symbol={sides[i].icon} size={20} />}
                    decimals={sides[i].decimals}
                    balance={p.account ? sides[i].balance : undefined}
                    disabled={act.busy || !initialised}
                  />
                ))}
              </div>
            )}
            <button type="button" onClick={mint} disabled={!!mintReason || act.busy} className="btn btn-primary mt-4 w-full">
              {act.busy ? "Working…" : "Mint position"}
            </button>
            {mintReason ? (
              <Reason>{mintReason}</Reason>
            ) : (
              <Reason>Up to four approvals the first time (each for the exact amount, expiring in 30 minutes), then the mint. At most 1% more than shown is pulled; any excess stays in your wallet.</Reason>
            )}
          </div>
          <div>
            <StepHead n={2} title="Wrap it into stakeable shares" />
            <TokenIdField value={tokenId} onChange={setTokenId} disabled={act.busy} />
            {pos.exists && !pos.isWrapped && pos.isOwner && (
              <p className="mt-2 font-mono text-[12px] text-bone-dim">
                Liquidity {formatToken(pos.liquidity)} → you receive {formatToken(pos.liquidity)} shares
              </p>
            )}
            <button type="button" onClick={() => pos.tokenId !== null && wrapper && act.wrapPosition(wrapper, pos.tokenId)} disabled={!!wrapReason || act.busy} className="btn btn-primary mt-4 w-full">
              Wrap position
            </button>
            {wrapReason ? <Reason>{wrapReason}</Reason> : <Reason>The wrapper holds the NFT and mints you shares. Remember the token ID: only you can unwrap it, and you need it to do so.</Reason>}
            <p className="mt-4 border-t border-white/[0.06] pt-3 font-mono text-[12px] text-ash">
              Shares in your wallet: <span className="text-bone-dim">{formatToken(wrapperBalance)}</span> — stake them in the pool above.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <StepHead n={3} title="Unwrap the position" />
            <TokenIdField value={tokenId} onChange={setTokenId} disabled={act.busy} />
            <button type="button" onClick={() => pos.tokenId !== null && wrapper && act.unwrapPosition(wrapper, pos.tokenId)} disabled={!!unwrapReason || act.busy} className="btn mt-4 w-full">
              Unwrap
            </button>
            {unwrapReason ? <Reason>{unwrapReason}</Reason> : <Reason>Burns {formatToken(pos.wrappedLiquidity)} shares and returns the NFT to your wallet.</Reason>}
          </div>
          <div>
            <StepHead n={4} title="Remove the liquidity" />
            {burnAmounts && sides && !pos.isWrapped && pos.isOwner ? (
              <dl className="space-y-1.5 rounded-xl border border-white/[0.06] bg-black/30 p-3 font-mono text-[12.5px]">
                {([0, 1] as const).map((i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <dt className="text-ash">≈ {sides[i].symbol}</dt>
                    <dd className="text-bone">{formatToken(i === 0 ? burnAmounts.amount0 : burnAmounts.amount1, sides[i].decimals)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="rounded-xl border border-white/[0.06] bg-black/30 p-3 text-[12.5px] text-ash">The amounts you get back appear here once the position is unwrapped and in your wallet.</p>
            )}
            <button
              type="button"
              onClick={() => pos.tokenId !== null && state && burnAmounts && act.burnPosition({ key: state.key, tokenId: pos.tokenId, amount0Min: floor(burnAmounts.amount0), amount1Min: floor(burnAmounts.amount1) })}
              disabled={!!removeReason || act.busy}
              className="btn mt-4 w-full"
            >
              Remove liquidity
            </button>
            {removeReason ? <Reason>{removeReason}</Reason> : <Reason>Burns the NFT and returns both tokens. The transaction reverts if you would receive more than 1% less than shown.</Reason>}
          </div>
        </div>
      )}
    </section>
  );
}

function StepHead({ n, title }: { n: number; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand font-mono text-[11px] font-semibold text-white">{n}</span>
      <h4 className="text-[14px] font-semibold text-bone">{title}</h4>
    </div>
  );
}

function TokenIdField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">Position token ID</span>
      <span className="well px-4 py-3">
        <input
          type="text"
          inputMode="numeric"
          placeholder="e.g. 1234"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
          className="num w-full text-[18px] text-bone"
        />
        <span className="font-mono text-[12px] text-ash">NFT</span>
      </span>
    </label>
  );
}
