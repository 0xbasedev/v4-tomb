import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatUnits } from "viem";

import { AmountField, parseAmount } from "@/components/AmountField";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { SlippageChips } from "@/components/SlippageChips";
import { NotDeployed, Reason, RuleBadge } from "@/components/Status";
import { SwapFlowArt } from "@/components/SwapFlowArt";
import { TaxLadder } from "@/components/TaxLadder";
import { TokenIcon } from "@/components/TokenIcon";
import { Segmented } from "@/components/docs/kit";
import { HoldButton } from "@/components/fx/HoldButton";
import { formatBps, formatDate, formatToken } from "@/lib/format";
import { useActions, useProtocol } from "@/lib/hooks";
import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";
import { useReveal } from "@/lib/motion/useReveal";
import { NAMES, TAX } from "@/lib/protocol";
import { SHARE_POOL_FEE, estimateExactIn } from "@/lib/swap/poolKey";

type Market = "peg" | "share";

/**
 * Swap — exact-input swaps through MiniSwapRouter (always with a deadline).
 *
 *   xTOMB  / paired asset   PegDefenseHook: a sell pays the tax out of the xTOMB you send
 *   xSHARE / paired asset   ShareBuybackHook: a sell pays the same rate out of what you receive
 *
 * Buying is the plain path: gradient button, one tap. Selling into a tax is the
 * expensive path: the exact loss is spelled out above the button, and at the
 * 12% cap the button must be held, so nobody signs it by reflex.
 */
export function Swap() {
  const root = useRef<HTMLDivElement>(null);
  const flip = useRef<HTMLButtonElement>(null);
  const p = useProtocol();
  const act = useActions();
  const [market, setMarket] = useState<Market>("peg");
  const [selling, setSelling] = useState(false);
  const [raw, setRaw] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  useReveal(root, [p.deployed]);

  const d = p.net.deployment;
  const state = p.pools[market];
  const base = market === "peg" ? { symbol: p.symbols.peg, icon: "xTOMB" as const, address: d?.peg, balance: p.balances.peg, decimals: 18 } : { symbol: p.symbols.share, icon: "xSHARE" as const, address: d?.share, balance: p.balances.share, decimals: 18 };
  const quote = { symbol: p.symbols.quote, icon: "QUOTE" as const, address: d?.weth, balance: p.balances.quote, decimals: p.quoteDecimals };
  const tokenIn = selling ? base : quote;
  const tokenOut = selling ? quote : base;

  const amountIn = parseAmount(raw, tokenIn.decimals);
  const initialised = !!state && state.sqrtPriceX96 > 0n && state.liquidity > 0n;
  const zeroForOne = !!state && !!tokenIn.address && state.key.currency0.toLowerCase() === tokenIn.address.toLowerCase();
  const feePips = market === "peg" ? p.tax.poolFeePips : SHARE_POOL_FEE;

  // The rate both hooks charge. The share hook reads it from the peg hook and caps it at 12%.
  const switchOn = market === "peg" ? p.tax.enabled : p.buyback.enabled;
  const rateBps = p.tax.rateBps === null ? null : Math.min(p.tax.rateBps, TAX.maxBps);
  const taxed = selling && switchOn !== false;
  const effectiveBps = taxed ? (rateBps ?? TAX.maxBps) : 0;

  // xTOMB sell: tax comes off the input, exactly. xSHARE sell: tax comes off the output.
  let taxAmount: bigint | null = null;
  let out: bigint | null = null;
  if (amountIn !== null && initialised) {
    if (market === "peg") {
      taxAmount = taxed ? (amountIn * BigInt(effectiveBps)) / 10_000n : 0n;
      out = estimateExactIn(state!, zeroForOne, amountIn - taxAmount, feePips);
    } else {
      const gross = estimateExactIn(state!, zeroForOne, amountIn, feePips);
      taxAmount = taxed ? (gross * BigInt(effectiveBps)) / 10_000n : 0n;
      out = gross - taxAmount;
    }
  }
  const minOut = out !== null ? (out * BigInt(10_000 - slippageBps)) / 10_000n : null;
  const taxSymbol = market === "peg" ? base.symbol : quote.symbol;
  const taxDecimals = market === "peg" ? 18 : quote.decimals;
  const atCap = taxed && effectiveBps >= TAX.maxBps;
  const cheaper = taxed && p.tax.pendingDecrease && p.tax.pendingDecrease.toBps < effectiveBps ? p.tax.pendingDecrease : null;

  const reason =
    act.blocked ??
    (!state || state.sqrtPriceX96 === 0n
      ? "This pool has not been initialised yet."
      : state.liquidity === 0n
        ? "This pool has no liquidity yet."
        : taxed && rateBps === null
          ? "Reading the current tax rate…"
          : amountIn === null
            ? "Enter an amount."
            : tokenIn.balance !== null && amountIn > tokenIn.balance
              ? `You only hold ${formatToken(tokenIn.balance, tokenIn.decimals)} ${tokenIn.symbol}.`
              : out === null || out === 0n
                ? "This amount is too small to return anything."
                : null);

  async function submit() {
    if (reason || amountIn === null || minOut === null || !state || !tokenIn.address) return;
    const okay = await act.swap({ key: state.key, zeroForOne, tokenIn: tokenIn.address, amountIn, minOut });
    if (okay) setRaw("");
  }

  function turn() {
    setSelling((s) => !s);
    setRaw("");
    if (flip.current && !prefersReducedMotion()) gsap.fromTo(flip.current, { rotate: 0 }, { rotate: 180, duration: 0.45, ease: EASE.snap });
  }

  const price = amountIn && out ? Number(formatUnits(out, tokenOut.decimals)) / Number(formatUnits(amountIn, tokenIn.decimals)) : null;

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Swap"
        title="Swap"
        lede={`Trade ${NAMES.peg} and ${NAMES.share} against the paired asset. Buys are never taxed. Before you sell, this page shows the exact amount the tax takes.`}
        aside={<SwapFlowArt />}
      />

      <div className="mx-auto mb-5 w-full max-w-7xl px-4 md:px-8">
        {!p.deployed && (
          <div className="mb-6">
            <NotDeployed what="Swapping" />
          </div>
        )}
        <div data-reveal>
          <Segmented
            options={[
              { id: "peg", label: `${NAMES.peg} market` },
              { id: "share", label: `${NAMES.share} market` },
            ]}
            value={market}
            onChange={(v) => {
              setMarket(v);
              setRaw("");
            }}
          />
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-4 pb-12 md:px-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
        {/* ---- Ticket ---- */}
        <section data-reveal className="panel panel-raised p-5 md:p-6" aria-label="Swap ticket">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold tracking-[-0.02em] text-bone">
              {selling ? "Sell" : "Buy"} {base.symbol}
            </h2>
            <span className={`chip ${selling ? (taxed ? "chip-bad" : "") : "chip-ok"}`} data-testid="swap-tax-chip">
              {selling ? (taxed ? `Sell tax ${formatBps(effectiveBps)}` : "Sell tax off") : "No tax on buys"}
            </span>
          </div>

          <AmountField label="You pay" value={raw} onChange={setRaw} symbol={tokenIn.symbol} icon={<TokenIcon symbol={tokenIn.icon} size={20} />} decimals={tokenIn.decimals} balance={p.account ? tokenIn.balance : undefined} disabled={act.busy || !p.deployed} />

          <div className="my-3 flex justify-center">
            <button ref={flip} type="button" onClick={turn} aria-label={selling ? `Switch to buying ${base.symbol}` : `Switch to selling ${base.symbol}`} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-basalt-3 text-bone-dim transition-colors hover:border-iris/50 hover:text-bone">
              ⇅
            </button>
          </div>

          <AmountField label="You receive (estimate)" value={out !== null ? formatToken(out, tokenOut.decimals, 6) : ""} onChange={() => {}} symbol={tokenOut.symbol} icon={<TokenIcon symbol={tokenOut.icon} size={20} />} decimals={tokenOut.decimals} balance={p.account ? tokenOut.balance : undefined} readOnly disabled={!p.deployed} />

          {/* ---- The cost of selling, before the button ---- */}
          {taxed && (
            <div role="alert" data-testid="tax-warning" className={`mt-5 rounded-2xl border p-4 ${atCap ? "border-bad/45 bg-bad/[0.07]" : "border-warn/35 bg-warn/[0.05]"}`}>
              <div className="flex items-start gap-3">
                <span aria-hidden className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] ${atCap ? "border-bad/60 text-bad" : "border-warn/60 text-warn"}`}>
                  !
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-bone">
                    {taxAmount !== null ? (
                      <>
                        This sale loses{" "}
                        <span className={`num ${atCap ? "text-bad" : "text-warn"}`}>
                          {market === "share" && "≈ "}
                          {formatToken(taxAmount, taxDecimals, 6)} {taxSymbol}
                        </span>{" "}
                        to the {formatBps(effectiveBps)} sell tax.
                      </>
                    ) : (
                      <>Selling {base.symbol} pays a {formatBps(effectiveBps)} tax right now.</>
                    )}
                  </p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-bone-dim">
                    {market === "peg"
                      ? `It is taken from the ${base.symbol} you send, before the swap, and is burned or sent to the fee recipient. You do not get it back.`
                      : `It is taken from the ${quote.symbol} you would receive and later used to buy and burn ${NAMES.peg}. You do not get it back.`}
                    {atCap && " This is the maximum rate."}
                  </p>
                  {cheaper && (
                    <p className="mt-2 text-[12.5px] font-medium text-ok">
                      Waiting helps: the rate is due to fall to {formatBps(cheaper.toBps)} from {formatDate(cheaper.readyAt)}
                      {taxAmount !== null && market === "peg" ? `, saving you ${formatToken((amountIn! * BigInt(effectiveBps - cheaper.toBps)) / 10_000n, 18, 6)} ${base.symbol}` : ""}.
                    </p>
                  )}
                  {!cheaper && atCap && (
                    <p className="mt-2 text-[12.5px] text-bone-dim">
                      It eases to 6% only after the TWAP holds at 1.12 or above for 7 hours. <button type="button" onClick={turn} className="font-semibold text-iris-hot underline underline-offset-4">Buy instead — untaxed</button>
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          <dl className="mt-5 space-y-2 border-t border-white/[0.06] pt-4 font-mono text-[12.5px]">
            <Line k="Rate" v={price !== null ? `1 ${tokenIn.symbol} ≈ ${price.toPrecision(6)} ${tokenOut.symbol}` : "—"} />
            <Line k="LP fee" v={p.deployed ? `${feePips / 10_000}%${market === "peg" ? " (set by the hook)" : ""}` : "—"} />
            <Line k="Sell tax" v={!selling ? "0% — buys are untaxed" : taxed ? `${formatBps(effectiveBps)}${taxAmount !== null ? ` · ${formatToken(taxAmount, taxDecimals, 6)} ${taxSymbol}` : ""}` : "off"} tone={taxed ? (atCap ? "text-bad" : "text-warn") : "text-ok"} />
            <Line k="Minimum received" v={minOut !== null ? `${formatToken(minOut, tokenOut.decimals, 6)} ${tokenOut.symbol}` : "—"} strong />
            <Line k="Deadline" v="10 minutes" />
          </dl>

          <div className="mt-4">
            <div className="label mb-2">Slippage tolerance</div>
            <SlippageChips valueBps={slippageBps} onChange={setSlippageBps} />
          </div>

          <div className="mt-5">
            {atCap ? (
              <HoldButton onConfirm={submit} disabled={!!reason || act.busy} hold={1.5}>
                Sell anyway{taxAmount !== null ? ` — lose ${formatToken(taxAmount, taxDecimals, 4)} ${taxSymbol} to tax` : ""}
              </HoldButton>
            ) : (
              <button type="button" onClick={submit} disabled={!!reason || act.busy} className={`btn w-full ${selling ? (taxed ? "btn-danger" : "") : "btn-primary"}`}>
                {act.busy ? "Working…" : selling ? `Sell ${base.symbol}` : `Buy ${base.symbol}`}
              </button>
            )}
            {reason ? <Reason>{reason}</Reason> : <Reason>The output is an estimate from the pool's current price. The transaction reverts if you would receive less than the minimum, or if it is not mined within 10 minutes.</Reason>}
          </div>
        </section>

        {/* ---- Context ---- */}
        <div className="space-y-5">
          <section data-reveal className="panel p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="label">Sell tax by TWAP</span>
              <RuleBadge />
            </div>
            <TaxLadder price={p.tax.price} rateBps={p.tax.rateBps} enabled={p.tax.enabled} />
          </section>
          <section data-reveal className="panel p-5">
            <div className="label mb-3">This market</div>
            <dl className="space-y-2 font-mono text-[12.5px]">
              <Line k="Pool" v={`${base.symbol} / ${quote.symbol}`} />
              <Line k="State" v={!state ? "—" : state.sqrtPriceX96 === 0n ? "not initialised" : "initialised"} />
              <Line k="In-range liquidity" v={state ? formatToken(state.liquidity) : "—"} />
              <Line k={market === "peg" ? "Sell tax switch" : "Buyback tax switch"} v={switchOn === null ? "—" : switchOn ? "on" : "off"} />
              {market === "peg" && <Line k="TWAP · spot" v={`${p.market.twap?.toFixed(4) ?? "—"} · ${p.market.spot?.toFixed(4) ?? "—"}`} />}
            </dl>
            <p className="mt-3 text-[12.5px] leading-relaxed text-ash">
              {NAMES.peg} and {NAMES.share} cannot be swapped for each other: their shared pool is liquidity only. <Link to="/masonry" className="text-iris-hot underline-offset-4 hover:underline">It is what {NAMES.room} stakes</Link>.
            </p>
          </section>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 pb-12 md:px-8">
        <SectionTitle kicker="Rules" title="What selling costs, and why" right={<RuleBadge />} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {[
            ["Three tiers", "12% while the TWAP is under 1.12, 6% from 1.12, 3% from 1.20. Never more than 12%."],
            ["Up fast, down slow", "The rate rises the moment the TWAP drops a tier. It falls only after the lower rate has stood for 7 hours."],
            ["Buys are free of it", "Only sells are taxed. The LP fee applies both ways and goes to liquidity providers."],
            [`${NAMES.share} follows`, `When its switch is on, ${NAMES.share} sells pay the same rate from the proceeds, which then buy ${NAMES.peg} and burn it.`],
          ].map(([k, v]) => (
            <div key={k} data-reveal className="panel p-4">
              <div className="label mb-1">{k}</div>
              <p className="text-[12.5px] leading-relaxed text-bone-dim">{v}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Line({ k, v, tone = "text-bone-dim", strong }: { k: string; v: string; tone?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ash">{k}</dt>
      <dd className={`min-w-0 break-words text-right ${strong ? "text-bone" : tone}`}>{v}</dd>
    </div>
  );
}
