import { useMemo, useRef, useState, type ReactNode } from "react";

import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { HoldButton } from "@/components/fx/HoldButton";
import { Modal, Row } from "@/components/Modal";
import { SlippageChips } from "@/components/SlippageChips";
import { Reason, SimBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { DRIVER_LABEL, taxDestination } from "@/lib/fireTax";
import { useActions, useProtocol, useSwapSimulation } from "@/lib/hooks";
import { pct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";
import { useMagnetic } from "@/lib/motion/useMagnetic";
import { usd } from "@/lib/peg";
import { planRoute, quoteRoute, type Leg } from "@/lib/routes";
import { SWAP_TOKENS, TOKENS, shortLabel, type TokenId } from "@/lib/tokens";
import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * Swap card — official pools only (xTOMB/USDC, xSHARE/USDC) plus the two LP
 * vaults. The route is shown leg by leg; the Fire Tax is computed from the
 * actual sell leg (an LP exit to USDC sells the xTOMB half), pool fees are
 * itemized separately, and routes the contracts can't do say so.
 *
 * Friction follows cost: a route that pays real tax names it in the button;
 * above ~8% of value it's press-and-hold. Buys and LP exits into the asset
 * never pay the Fire Tax, and the card offers that path when it exists.
 */

export type SwapPair = { input: TokenId; output: TokenId };

const fmtAmt = (n: number | null | undefined, max = 6) => {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : max;
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
};

export function AnySwap({ pair, onPair, onLiquidity }: { pair: SwapPair; onPair: (p: SwapPair) => void; onLiquidity: () => void }) {
  const { input, output } = pair;
  const p = useProtocol();
  const actions = useActions();
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [settings, setSettings] = useState(false);
  const [picking, setPicking] = useState<"in" | "out" | null>(null);
  const flipRef = useRef<HTMLButtonElement>(null);
  const routeRef = useRef<HTMLOListElement>(null);
  const cta = useRef<HTMLButtonElement>(null);
  useMagnetic(cta, 0.14);

  const amt = parseFloat(amount) || 0;
  const plan = useMemo(() => planRoute(input, output, p.lpAssetShare), [input, output, p.lpAssetShare]);
  const quote = plan.ok ? quoteRoute(plan, input, output, amt, { prices: p.prices, poolFeeBps: p.poolFeeBps, taxFor: p.taxFor }) : null;
  // Before an amount is typed the tax rate still comes from the route.
  const preQuote = plan.ok && !quote ? quoteRoute(plan, input, output, 1, { prices: p.prices, poolFeeBps: p.poolFeeBps, taxFor: p.taxFor }) : null;
  const shown = quote ?? preQuote;
  const sellLeg = shown?.legs.find((l) => l.kind === "sell") ?? null;
  const taxShare = shown?.taxShareOfValue ?? 0;
  const heavy = taxShare >= 0.08;
  const notable = taxShare >= 0.03;
  const bal = p.balances[input];
  const over = bal !== null && bal !== undefined && amt > bal;
  const blocked = shown?.blocked ?? null;
  const single = plan.ok && plan.legs.length === 1 && plan.legs[0].kind !== "redeem" ? plan.legs[0] : null;
  // Live: the contract's own output for single-leg swaps, simulated once the router allowance covers it.
  const sim = useSwapSimulation(single ? single.asset : null, single?.kind === "sell" ? "sell" : "buy", single ? amt : 0);

  function choose(side: "in" | "out", id: TokenId) {
    if (side === "in") onPair(id === output ? { input: id, output: input } : { input: id, output });
    else onPair(id === input ? { input: output, output: id } : { input, output: id });
  }
  function flip() {
    if (flipRef.current && !prefersReducedMotion())
      gsap.fromTo(flipRef.current, { rotate: 0 }, { rotate: 180, duration: 0.45, ease: EASE.snap, onComplete: () => void gsap.set(flipRef.current, { rotate: 0 }) });
    onPair({ input: output, output: input });
    setAmount("");
  }
  function animateRoute() {
    if (!routeRef.current || prefersReducedMotion()) return;
    gsap.fromTo(routeRef.current.children, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.35, stagger: 0.05, ease: EASE.rise });
  }

  function submit() {
    if (!plan.ok || !quote || over || blocked) return;
    const done = () => setAmount("");
    const sold = sellLeg?.tax?.rateBps ? { asset: sellLeg.asset, valueUsd: sellLeg.valueUsd, rateBps: sellLeg.tax.rateBps } : undefined;
    if (p.sim) return actions.simulateRoute(`${shortLabel(input)} → ${shortLabel(output)}`, input, output, amt, quote.amountOut ?? 0, sold, done);
    // Live: single-leg swaps go out with the simulated minimum; multi-leg routes are sent leg by leg from the route list.
    if (single && sim.out !== null) {
      const min = (sim.out * BigInt(10_000 - slippageBps)) / 10_000n;
      return actions.swapLeg(single.asset, single.kind === "sell" ? "sell" : "buy", amt, min, done);
    }
  }

  const mode = plan.ok ? plan.mode : null;
  const modeLabel = mode === "remove" ? "Remove liquidity" : mode === "two-hop" ? "Two swaps" : mode === "swap" ? "Swap" : "Unavailable";
  const liveNeedsSim = !p.sim && single !== null && amt > 0 && sim.out === null;
  const multiLive = !p.sim && plan.ok && plan.legs.length > 1;
  const disabledReason = !plan.ok
    ? plan.reason
    : blocked
      ? blocked
      : !p.account
        ? "Connect a wallet."
        : !p.sim && !p.net.canTransact
          ? (p.net.reason ?? "Transactions are unavailable.")
          : multiLive
            ? "Live routes run one leg per transaction: redeem in Liquidity first, then swap what you received."
            : liveNeedsSim
              ? sim.needsApproval
                ? "Approve the router first; the minimum received comes from simulating the swap."
                : (sim.error ?? "Simulating the swap…")
              : null;

  return (
    <div data-reveal className="panel panel-raised w-full p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="font-display text-[15px] font-semibold text-bone">Swap</span>
          <span className={`chip h-6 whitespace-nowrap ${plan.ok ? (mode === "remove" ? "chip-spectre" : "") : "chip-warn"}`}>{modeLabel}</span>
          {p.sim && <SimBadge />}
        </div>
        <button
          type="button"
          onClick={() => setSettings((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] text-ash transition-colors hover:bg-white/5 hover:text-bone-dim"
          aria-expanded={settings}
        >
          Slippage <span className={slippageBps > 500 ? "text-warn" : "text-bone-dim"}>{(slippageBps / 100).toFixed(1)}%</span> ⚙
        </button>
      </div>
      {settings && (
        <div className="mb-3 rounded-xl border border-white/[0.06] bg-black/25 p-3">
          <SlippageChips valueBps={slippageBps} onChange={setSlippageBps} />
        </div>
      )}

      <Side label="You pay" token={input} other={output} side="in" onPick={(id) => (choose("in", id), animateRoute())} onOpen={() => setPicking("in")}
        right={
          <button type="button" onClick={() => bal && setAmount(String(bal))} className="font-mono text-[11px] text-ash transition-colors hover:text-ember-hot">
            Bal <span className="text-bone-dim">{fmtAmt(bal)}</span> · <span className="text-ember">MAX</span>
          </button>
        }
        usdLine={<div className="font-mono text-[11px] text-ash">≈ {usd(quote?.valueInUsd)}</div>}
      >
        <input
          id="swap-amount"
          type="text"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(maskDecimalInput(e.target.value))}
          aria-label={`Amount of ${TOKENS[input].symbol} to pay`}
          className="num min-w-0 flex-1 bg-transparent text-[32px] leading-none text-bone outline-none"
        />
      </Side>

      <div className="relative z-10 -my-3 flex justify-center">
        <button ref={flipRef} type="button" onClick={flip} aria-label="Reverse direction" className="flex h-10 w-10 items-center justify-center rounded-xl border-4 border-basalt-2 bg-basalt-3 text-bone-dim transition-colors hover:text-ember-hot">
          ↓
        </button>
      </div>

      <Side label="You receive" token={output} other={input} side="out" onPick={(id) => (choose("out", id), animateRoute())} onOpen={() => setPicking("out")} dim
        right={<span className="font-mono text-[11px] text-ash">after pool fees + Fire Tax</span>}
        usdLine={<div className="font-mono text-[11px] text-ash">≈ {usd(quote?.valueOutUsd)}</div>}
      >
        <AnimatedNumber
          value={quote?.amountOut ?? (amt > 0 ? null : 0)}
          format={(n) => (n === 0 ? "0" : fmtAmt(n))}
          duration={0.5}
          className={`num min-w-0 flex-1 truncate text-[32px] leading-none ${quote?.amountOut ? "text-bone" : "text-ash-dim"}`}
        />
      </Side>

      {!plan.ok && (
        <div className="mt-3 rounded-xl border border-warn/30 bg-warn/[0.05] p-3 text-[12.5px] text-bone-dim" role="note">
          <span className="font-semibold text-warn">Route unavailable. </span>
          {plan.reason}
          {plan.suggest === "liquidity" && (
            <button type="button" onClick={onLiquidity} className="ml-1 font-semibold text-spectre hover:underline">
              Open Add liquidity →
            </button>
          )}
        </div>
      )}

      {plan.ok && (
        <div className="mt-4 px-1">
          <div className="label mb-2">
            Route · {plan.txCount} transaction{plan.txCount > 1 ? "s" : ""}
          </div>
          <ol ref={routeRef} className="flex flex-wrap items-center gap-1.5">
            {plan.legs.map((s, i) => (
              <RouteChip key={`${s.label}-${i}`} leg={s} last={i === plan.legs.length - 1} rate={shown?.legs[i]?.tax?.rateBps ?? null} />
            ))}
          </ol>
        </div>
      )}

      {plan.ok && (
        <dl className="mt-4 space-y-2 px-1 text-[13px]">
          {shown?.legs
            .filter((l) => l.kind !== "redeem")
            .map((l, i) => (
              <Row key={`fee-${i}`} k={`Pool fee · ${l.pool}`} v={quote ? `−${usd(l.poolFeeUsd)}` : "—"} sub={`${pct(l.poolFeeBps)}${p.sim ? " · sample fee" : " · pool key"}`} />
            ))}
          <Row
            k="Fire Tax"
            v={
              sellLeg?.tax?.rateBps === null && sellLeg
                ? "sell rejected"
                : !sellLeg
                  ? "0%"
                  : quote
                    ? `−${usd(quote.fireTaxUsd)}`
                    : pct(sellLeg.tax!.rateBps! * sellLeg.valueShare)
            }
            sub={
              !sellLeg
                ? "no sell leg · buys pay none"
                : sellLeg.tax?.rateBps === null
                  ? "no valid TWAP"
                  : `${pct(sellLeg.tax!.rateBps!)} on the ${sellLeg.asset} sold${sellLeg.valueShare < 1 ? ` (${Math.round(sellLeg.valueShare * 100)}% of value)` : ""} · ${DRIVER_LABEL[sellLeg.tax!.driver!]}`
            }
            tone={!sellLeg ? "text-ok" : heavy ? "text-bad" : notable ? "text-warn" : "text-bone-dim"}
          />
          {sellLeg && sellLeg.tax?.rateBps !== null && (
            <Row k="Tax goes to" v={taxDestination(sellLeg.asset, !!p.clock?.active, p.market.defense.active)} />
          )}
          {quote?.amountOut != null && (
            <div className="border-t border-white/5 pt-2">
              <Row
                k={single && !p.sim ? `Minimum (${(slippageBps / 100).toFixed(1)}%) · from simulation` : `Minimum (${(slippageBps / 100).toFixed(1)}% slippage)${p.sim ? " · simulated" : " · estimate"}`}
                v={
                  single && !p.sim
                    ? sim.out !== null
                      ? `${fmtAmt(Number(sim.out) / 10 ** TOKENS[output].decimals * (1 - slippageBps / 10_000))} ${shortLabel(output)}`
                      : "after simulation"
                    : `${fmtAmt(quote.amountOut * (1 - slippageBps / 10_000))} ${shortLabel(output)}`
                }
                strong
              />
            </div>
          )}
        </dl>
      )}

      {/* The cheaper path, when this route pays real tax. */}
      {plan.ok && sellLeg && (sellLeg.tax?.rateBps ?? 0) > 100 && (
        <div className="mt-4">
          {mode === "remove" ? (
            <button type="button" onClick={() => onPair({ input, output: sellLeg.asset })} className="group flex w-full items-center gap-3 rounded-xl border border-ember/30 bg-ember/[0.06] p-3 text-left hover:border-ember/60">
              <TokenIcon symbol={sellLeg.asset} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-bone">Take it as {sellLeg.asset} instead</span>
                <span className="block text-[12px] text-bone-dim">The USDC half buys {sellLeg.asset} — buys are never taxed, so nothing is sold.</span>
              </span>
              <span className="font-mono text-[12px] text-ember-hot">Switch →</span>
            </button>
          ) : (
            <p className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-[12px] text-bone-dim">
              The recovery floor decays to the baseline over seven hours after a higher rate — a sell later can cost less.
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        {!plan.ok ? (
          <button type="button" disabled className="btn btn-primary h-14 w-full">
            Route unavailable
          </button>
        ) : heavy && amt > 0 && !over && !disabledReason ? (
          <HoldButton onConfirm={submit} tone="bad" hold={1.6} disabled={actions.busy}>
            {mode === "remove" ? "Remove anyway" : "Sell anyway"} · −{usd(quote?.fireTaxUsd)} tax
          </HoldButton>
        ) : (
          <button
            ref={cta}
            type="button"
            onClick={submit}
            disabled={!(amt > 0) || over || !!disabledReason || actions.busy}
            className={`btn h-14 w-full text-[15px] ${notable ? "btn-ghost border-warn/40 text-warn" : "btn-primary"}`}
          >
            {!(amt > 0) ? "Enter an amount" : over ? `Not enough ${shortLabel(input)}` : blocked ? "Sell rejected" : notable ? `${modeLabel} · −${usd(quote?.fireTaxUsd)} tax` : p.sim ? `${modeLabel} (simulated)` : modeLabel}
          </button>
        )}
        {disabledReason && amt > 0 && <Reason tone={blocked ? "warn" : "ash"}>{disabledReason}</Reason>}
      </div>

      {picking && <TokenPicker side={picking} current={picking === "in" ? input : output} other={picking === "in" ? output : input} onPick={(id) => choose(picking, id)} onClose={() => setPicking(null)} />}
    </div>
  );
}

function Side({
  label,
  token,
  other,
  side,
  onPick,
  onOpen,
  right,
  usdLine,
  dim,
  children,
}: {
  label: string;
  token: TokenId;
  other: TokenId;
  side: "in" | "out";
  onPick: (id: TokenId) => void;
  onOpen: () => void;
  right: ReactNode;
  usdLine: ReactNode;
  dim?: boolean;
  children: ReactNode;
}) {
  const p = useProtocol();
  return (
    <div className={`rounded-2xl p-4 ${dim ? "bg-black/20" : "bg-black/35"}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="label">{label}</span>
        {right}
      </div>
      <div className="flex items-center gap-3">
        {children}
        <button
          type="button"
          onClick={onOpen}
          className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1.5 pl-1.5 pr-3 font-mono text-sm text-bone transition-colors hover:border-white/25"
          aria-label={`Choose the token you ${side === "in" ? "pay with" : "receive"}`}
        >
          <TokenIcon symbol={token} size={24} />
          {shortLabel(token)}
          {TOKENS[token].pair && <span className="rounded bg-ember/15 px-1 text-[9px] text-ember-hot">LP</span>}
          <span className="text-ash">▾</span>
        </button>
      </div>
      <div className="mt-1">{usdLine}</div>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {SWAP_TOKENS.map((id) => {
          const active = id === token;
          const plan = side === "in" ? planRoute(id, other, p.lpAssetShare) : planRoute(other, id, p.lpAssetShare);
          const ok = plan.ok || id === other;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              title={ok ? TOKENS[id].name : (plan as { reason: string }).reason}
              className={`flex min-w-0 items-center justify-center gap-1 rounded-lg border px-1 py-1.5 font-mono text-[10px] transition-colors sm:gap-1.5 sm:px-1.5 sm:text-[10.5px] ${
                active ? "border-ember/60 bg-ember/[0.10] text-bone" : ok ? "border-white/[0.07] bg-black/20 text-bone-dim hover:border-white/20 hover:text-bone" : "border-white/[0.04] bg-black/10 text-ash-dim opacity-60"
              }`}
            >
              <TokenIcon symbol={id} size={14} />
              {TOKENS[id].pair ? (
                <>
                  <span className="truncate sm:hidden">{TOKENS[id].pair![0]} LP</span>
                  <span className="hidden truncate sm:inline">{shortLabel(id)}</span>
                  <span className="hidden shrink-0 rounded bg-ember/15 px-1 text-[8.5px] leading-[14px] text-ember-hot sm:inline">LP</span>
                </>
              ) : (
                <span className="truncate">{shortLabel(id)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TokenPicker({ side, current, other, onPick, onClose }: { side: "in" | "out"; current: TokenId; other: TokenId; onPick: (id: TokenId) => void; onClose: () => void }) {
  const p = useProtocol();
  const groups: { name: string; ids: TokenId[] }[] = [
    { name: "Protocol", ids: ["xTOMB", "xSHARE"] },
    { name: "Official LP (vault shares)", ids: ["xTOMB-USDC", "xSHARE-USDC"] },
    { name: "Quote", ids: ["USDC", "ETH"] },
  ];
  return (
    <Modal kicker={side === "in" ? "You pay" : "You receive"} title="Choose a token" onClose={onClose} width={440}>
      {(close) => (
        <div className="space-y-4">
          {p.sim && <SimBadge label="Balances simulated" />}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ash-dim">{g.name}</div>
              <div className="space-y-1">
                {g.ids.map((id) => {
                  const plan = side === "in" ? planRoute(id, other, p.lpAssetShare) : planRoute(other, id, p.lpAssetShare);
                  const ok = plan.ok || id === other;
                  const b = p.balances[id];
                  const price = p.prices[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        onPick(id);
                        close();
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        id === current ? "border-ember/50 bg-ember/[0.07]" : ok ? "border-white/[0.06] bg-black/20 hover:border-white/15" : "border-white/[0.04] opacity-60"
                      }`}
                    >
                      <TokenIcon symbol={id} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-semibold text-bone">{TOKENS[id].symbol}</span>
                        <span className="block truncate text-[11px] text-ash">{ok ? TOKENS[id].name : (plan as { reason: string }).reason}</span>
                      </span>
                      <span className="text-right">
                        <span className="num block text-[13px] text-bone">{fmtAmt(b)}</span>
                        <span className="num block text-[11px] text-ash">{b && price ? usd(b * price, 0) : ""}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function RouteChip({ leg, last, rate }: { leg: Leg; last: boolean; rate: number | null }) {
  const tone = leg.kind === "sell" ? "border-bad/40 text-bad" : leg.kind === "redeem" ? "border-spectre/40 text-spectre" : "border-ok/30 text-ok";
  return (
    <li className="flex items-center gap-1.5">
      <span className={`rounded-lg border bg-black/25 px-2 py-1 font-mono text-[11px] ${tone}`}>
        {leg.label}
        {leg.kind === "sell" && rate !== null && <span className="opacity-80"> · {pct(rate)} tax</span>}
        {leg.kind === "buy" && <span className="opacity-80"> · 0% tax</span>}
      </span>
      {!last && <span className="text-ash-dim">→</span>}
    </li>
  );
}
