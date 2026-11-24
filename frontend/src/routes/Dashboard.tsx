import { useRef } from "react";
import { Link } from "react-router-dom";

import { Countdown } from "@/components/Countdown";
import { NextMove } from "@/components/NextMove";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PegGauge } from "@/components/PegGauge";
import { StatTile } from "@/components/StatTile";
import { NotDeployed, RuleBadge } from "@/components/Status";
import { TaxLadder } from "@/components/TaxLadder";
import { TokenIcon, type TokenSymbol } from "@/components/TokenIcon";
import { formatBps, formatDate, formatToken, toNumber } from "@/lib/format";
import { useProtocol } from "@/lib/hooks";
import { useReveal } from "@/lib/motion/useReveal";
import { EMISSIONS, NAMES, PHASE_META } from "@/lib/protocol";
import type { PoolId } from "@/lib/swap/poolKey";

const f4 = (n: number) => n.toFixed(4);
const f0 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * Dashboard — the protocol's state, read straight from the contracts.
 *
 *   Treasury          TWAP, ceiling, epoch clock, the next expansion and its cuts
 *   PegDefenseHook    live sell tax, ratchet, deferred tax, lifetime totals
 *   ShareBuybackHook  pending buyback and lifetime totals
 *   PoolManager       price and liquidity of the three pools
 *
 * It writes nothing.
 */
export function Dashboard() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  useReveal(root, [p.deployed]);
  const { market, tax, buyback } = p;
  const meta = PHASE_META[market.phase];
  const exp = market.nextExpansion;
  const cut = (market.daoCutBps ?? 0) + (market.devCutBps ?? 0);
  const toRoom = exp !== null ? exp - (exp * BigInt(cut)) / 10_000n : null;

  const pools: { id: PoolId; name: string; icon: TokenSymbol; note: string }[] = [
    { id: "peg", name: `${p.symbols.peg} / ${p.symbols.quote}`, icon: "PEG-LP", note: "Tradeable · dynamic LP fee · sell tax on the peg token" },
    { id: "share", name: `${p.symbols.share} / ${p.symbols.quote}`, icon: "SHARE-LP", note: "Tradeable · 0.30% LP fee · sell tax buys and burns the peg token" },
    { id: "pair", name: `${p.symbols.peg} / ${p.symbols.share}`, icon: "PAIR-LP", note: "Liquidity only · every swap reverts · the xROOM stake" },
  ];

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Dashboard"
        token="xTOMB"
        title={
          <>
            The state of <span className="iris-text">{NAMES.peg}</span>
          </>
        }
        lede={p.deployed ? meta.detail : "Every figure on this page is read from the contracts. Nothing is deployed on this network, so the figures are blank and the rules are shown instead."}
        aside={
          <div className="panel panel-raised p-5">
            <PegGauge price={market.twap} phase={market.phase} unit={p.deployed ? p.symbols.quote : undefined} idleLabel={p.deployed ? "No reading yet" : "Not deployed"} />
          </div>
        }
      />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-10 md:px-8">
        {!p.deployed && <NotDeployed what="Live protocol state" />}

        <section aria-label="Key readings" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="TWAP · last epoch" numeric={market.twap} format={f4} unit={p.deployed ? p.symbols.quote : undefined} hint={market.liveTwap !== null ? `If updated now: ${market.liveTwap.toFixed(4)}` : "Treasury.getPegPrice"} tone="iris" />
          <StatTile
            label="Epoch"
            value={p.epoch.current !== null ? String(p.epoch.current) : "—"}
            hint={
              <>
                Next in <Countdown to={p.epoch.nextAt} done="due now" className="text-bone-dim" />
              </>
            }
          />
          <StatTile
            label={`${NAMES.peg} sell tax`}
            value={tax.enabled === false ? "Off" : formatBps(tax.rateBps)}
            hint={tax.enabled === false ? "The tax switch is off" : tax.pendingDecrease ? `Falls to ${formatBps(tax.pendingDecrease.toBps)} · ${formatDate(tax.pendingDecrease.readyAt)}` : "Buys are never taxed"}
            tone={tax.rateBps !== null && tax.rateBps >= 1200 && tax.enabled !== false ? "bad" : "spectre"}
          />
          <StatTile
            label="Next expansion"
            numeric={toNumber(exp)}
            format={f0}
            unit={NAMES.peg}
            hint={exp === null ? "Minted only above the 1.01 ceiling" : exp === 0n ? "Zero: TWAP is at or below the ceiling" : `${formatToken(toRoom)} to xROOM after ${formatBps(cut)} fund cuts`}
            tone={exp !== null && exp > 0n ? "ok" : "default"}
          />
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
          <NextMove />
          <div data-reveal className="panel p-5 md:p-6">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="label">Sell tax schedule</span>
              <RuleBadge />
            </div>
            <TaxLadder price={tax.price} rateBps={tax.rateBps} enabled={tax.enabled} />
          </div>
        </section>

        <section>
          <SectionTitle kicker="Supply" title="What exists" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label={`${NAMES.peg} supply`} numeric={toNumber(p.supplies.peg)} format={f0} hint={`Circulating: ${formatToken(market.circulating)}`} />
            <StatTile label={`${NAMES.share} supply`} numeric={toNumber(p.supplies.share)} format={f0} hint="Emitted by the ShareFarm and two vesting funds" />
            <StatTile label={`Staked in ${NAMES.room}`} numeric={toNumber(p.masonry.totalStaked)} format={f0} unit={p.deployed ? p.masonry.stakeSymbol : undefined} hint="Receives every expansion" tone="amethyst" />
            <StatTile label="Fund cuts" value={market.daoCutBps !== null ? `${formatBps(market.daoCutBps)} + ${formatBps(market.devCutBps)}` : "—"} hint="DAO fund + dev fund share of each expansion" />
          </div>
        </section>

        <section>
          <SectionTitle kicker="Where the tax goes" title="Burned, routed and waiting" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div data-reveal className="panel p-5">
              <div className="mb-4 flex items-center gap-2">
                <TokenIcon symbol="xTOMB" size={22} />
                <span className="label">{NAMES.peg} sell tax · PegDefenseHook</span>
              </div>
              <dl className="grid grid-cols-3 gap-3 text-[13px]">
                <Cell k="Assessed" v={formatToken(tax.totals.assessed)} />
                <Cell k="Burned" v={formatToken(tax.totals.burned)} tone="text-iris-hot" />
                <Cell k="To fee recipient" v={formatToken(tax.totals.routed)} />
                <Cell k="Waiting to burn" v={formatToken(tax.pendingBurn)} />
                <Cell k="Waiting to route" v={formatToken(tax.pendingRoute)} />
                <Cell k="Burn threshold" v={tax.burnThreshold !== null ? tax.burnThreshold.toFixed(2) : "—"} />
              </dl>
              <p className="mt-4 text-[12.5px] leading-relaxed text-ash">Tax is burned while the TWAP is under the burn threshold and sent to the fee recipient above it. Amounts wait as pool claims until anyone settles them.</p>
            </div>
            <div data-reveal className="panel p-5">
              <div className="mb-4 flex items-center gap-2">
                <TokenIcon symbol="xSHARE" size={22} />
                <span className="label">{NAMES.share} sell tax · ShareBuybackHook</span>
                {buyback.enabled === false && <span className="chip h-6 px-2 text-[10px]">Switch off</span>}
              </div>
              <dl className="grid grid-cols-3 gap-3 text-[13px]">
                <Cell k="Assessed" v={formatToken(buyback.totals.assessed, p.quoteDecimals)} />
                <Cell k="Converted" v={formatToken(buyback.totals.converted, p.quoteDecimals)} />
                <Cell k={`${NAMES.peg} burned`} v={formatToken(buyback.totals.pegBurned)} tone="text-iris-hot" />
                <Cell k="Waiting" v={formatToken(buyback.pendingQuote, p.quoteDecimals)} />
                <Cell k="Convertible from" v={buyback.readyAt ? formatDate(buyback.readyAt) : "—"} />
              </dl>
              <p className="mt-4 text-[12.5px] leading-relaxed text-ash">
                Collected in the paired asset, then swapped into {NAMES.peg} and burned by a permissionless call. <Link to="/admin" className="text-iris-hot underline-offset-4 hover:underline">Run the upkeep calls</Link>.
              </p>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle kicker="Pools" title="Three pools on Uniswap V4" />
          <div data-reveal className="panel overflow-x-auto p-0">
            <table className="crypt-table w-full min-w-[560px] text-[13px]">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>State</th>
                  <th className="!text-right">Tick</th>
                  <th className="!text-right">In-range liquidity</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((row) => {
                  const s = p.pools[row.id];
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <TokenIcon symbol={row.icon} size={24} />
                          <div>
                            <div className="font-semibold text-bone">{row.name}</div>
                            <div className="text-[11.5px] text-ash">{row.note}</div>
                          </div>
                        </div>
                      </td>
                      <td>{!s ? <span className="text-ash">—</span> : s.sqrtPriceX96 === 0n ? <span className="chip chip-warn">Not initialised</span> : <span className="chip chip-ok">Initialised</span>}</td>
                      <td className="num text-right text-bone-dim">{s && s.sqrtPriceX96 > 0n ? s.tick : "—"}</td>
                      <td className="num text-right text-bone-dim">{s ? formatToken(s.liquidity) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionTitle kicker="Emissions" title="Three programmes, fixed in the contracts" right={<RuleBadge />} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { name: "Genesis", to: "/genesis", total: EMISSIONS.genesis.total, sym: NAMES.peg, span: "24 hours, before epoch 0", farm: p.farms.genesis },
              { name: "PegFarm", to: "/farm", total: EMISSIONS.pegFarm.total, sym: NAMES.peg, span: EMISSIONS.pegFarm.phases, farm: p.farms.pegFarm },
              { name: "ShareFarm", to: "/farm?farm=share", total: EMISSIONS.shareFarm.total, sym: NAMES.share, span: `370 days · ${EMISSIONS.shareFarm.split}`, farm: p.farms.shareFarm },
            ].map((e) => (
              <Link key={e.name} to={e.to} data-reveal className="panel panel-hover block p-5">
                <div className="mb-3 flex items-center justify-between">
                  <span className="label">{e.name}</span>
                  <span className={`chip ${e.farm.phase === "live" ? "chip-ok" : e.farm.phase === "upcoming" ? "chip-iris" : ""}`}>{e.farm.phase === "unknown" ? "Not deployed" : e.farm.phase}</span>
                </div>
                <div className="font-display text-2xl font-semibold tracking-[-0.03em] text-bone">
                  {e.total.toLocaleString()} <span className="font-mono text-xs font-medium text-ash">{e.sym}</span>
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ash">{e.span}</p>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Cell({ k, v, tone = "text-bone" }: { k: string; v: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="label mb-1 !tracking-[0.1em]">{k}</dt>
      <dd className={`num truncate ${tone}`}>{v}</dd>
    </div>
  );
}
