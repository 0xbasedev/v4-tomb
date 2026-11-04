import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { AnySwap, type SwapPair } from "@/components/AnySwap";
import { FireTaxChart } from "@/components/FireTaxChart";
import { LiquidityPanel } from "@/components/LiquidityPanel";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { Segmented } from "@/components/docs/kit";
import { SimBadge } from "@/components/Status";
import { DRIVER_LABEL, recoveryFloorBps, sellTax, targetBps, type TaxedAsset } from "@/lib/fireTax";
import { useProtocol } from "@/lib/hooks";
import { FIRE, pct } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";

/** One-tap starting points — each is just a pair in the same card. */
const PRESETS: { title: string; detail: string; pair: SwapPair }[] = [
  { title: "Buy xTOMB", detail: "USDC → xTOMB · never taxed", pair: { input: "USDC", output: "xTOMB" } },
  { title: "Sell xTOMB", detail: "xTOMB → USDC · one Fire Tax", pair: { input: "xTOMB", output: "USDC" } },
  { title: "Exit LP to USDC", detail: "redeem, then sell the xTOMB half", pair: { input: "xTOMB-USDC", output: "USDC" } },
  { title: "Exit LP to xTOMB", detail: "redeem, then buy with the USDC half", pair: { input: "xTOMB-USDC", output: "xTOMB" } },
];

/**
 * Swap — the official pools (xTOMB/USDC and xSHARE/USDC through
 * MiniSwapRouter and their Fire Tax hooks) plus the two LP vaults. The Fire
 * Tax panel shows the one rate a sell would pay and why.
 */
export function Swap() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const [params, setParams] = useSearchParams();
  const [pair, setPair] = useState<SwapPair>({ input: "USDC", output: "xTOMB" });
  const [asset, setAsset] = useState<TaxedAsset>("xTOMB");
  const mode = params.get("mode") === "liquidity" ? "liquidity" : "swap";
  useReveal(root);

  const ratio = asset === "xTOMB" ? p.market.twap : p.market.twap !== null ? (p.prices.xSHARE ?? 0) / (p.hooks.xSHARE.reference ?? 1) : null;
  const quote = p.taxFor(asset, 1_000);

  return (
    <div ref={root}>
      <PageHeader
        eyebrow={p.sim ? "Swap · simulated" : "Swap"}
        title="Official pools only"
        lede="xTOMB/USDC and xSHARE/USDC on Uniswap v4. Buys and wallet transfers pay no Fire Tax; every sell pays one rate, shown before you sign, with pool fees itemized separately."
      />
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-4 pb-12 md:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Segmented
            options={[
              { id: "swap", label: "Swap" },
              { id: "liquidity", label: "Add / remove liquidity" },
            ]}
            value={mode}
            onChange={(m) => setParams(m === "liquidity" ? { mode: "liquidity" } : {}, { replace: true })}
          />
          {mode === "swap" ? <AnySwap pair={pair} onPair={setPair} onLiquidity={() => setParams({ mode: "liquidity" }, { replace: true })} /> : <LiquidityPanel />}
          {mode === "swap" && (
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((x) => (
                <button key={x.title} type="button" onClick={() => setPair(x.pair)} className="rounded-xl border border-white/[0.07] bg-black/20 p-3 text-left transition-colors hover:border-white/20">
                  <div className="text-[13px] font-semibold text-bone">{x.title}</div>
                  <div className="text-[11.5px] text-ash">{x.detail}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <section data-reveal className="panel p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="label">Fire Tax now</span>
                {p.sim && <SimBadge />}
              </div>
              <Segmented options={[{ id: "xTOMB", label: "xTOMB" }, { id: "xSHARE", label: "xSHARE" }]} value={asset} onChange={setAsset} />
            </div>
            <FireTaxChart asset={asset} ratio={p.market.fresh ? ratio : null} quote={quote} genesisActive={!!p.clock?.active} simulated={p.sim} />
          </section>
          <TaxExplorer />
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl px-4 pb-12 md:px-8">
        <SectionTitle kicker="Rules" title="How one sell tax is chosen" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {[
            ["TWAP target", `${pct(FIRE.baselineBps)} at or above the reference, rising to ${pct(FIRE.capBps)} at ${FIRE.fullTaxAt.toFixed(2)} of it.`],
            ["Projected price", "The hook previews your sale in the real pool and applies the target at the post-sale price."],
            ["Recovery floor", `After a higher rate is observed, the floor decays back to ${pct(FIRE.baselineBps)} over ${FIRE.recoverySeconds / 3600} hours.`],
            ["Genesis floor", `${pct(FIRE.genesisFloorBps.xTOMB)} on xTOMB (burned in full) and ${pct(FIRE.genesisFloorBps.xSHARE)} on xSHARE for the seven days.`],
          ].map(([k, v]) => (
            <div key={k} data-reveal className="panel p-4">
              <div className="label mb-1">{k}</div>
              <p className="text-[12.5px] leading-relaxed text-bone-dim">{v}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-ash">The highest of the four applies, capped at {pct(FIRE.capBps)}. If the oracle has no valid TWAP the hook rejects the sell; buys still go through.</p>
      </div>
    </div>
  );
}

/** What-if: set the inputs and read the one rate the hook would choose. */
function TaxExplorer() {
  const [asset, setAsset] = useState<TaxedAsset>("xTOMB");
  const [direction, setDirection] = useState<"sell" | "buy">("sell");
  const [genesis, setGenesis] = useState(true);
  const [twap, setTwap] = useState("1.0000");
  const [projected, setProjected] = useState("1.0000");
  const [recovery, setRecovery] = useState("1");
  const rec = parseFloat(recovery);
  const invalid = !(rec >= 1 && rec <= FIRE.capBps / 100) || !(parseFloat(twap) > 0) || !(parseFloat(projected) > 0);
  const q = sellTax({ asset, twap: parseFloat(twap), projected: parseFloat(projected), raisedBps: Math.round(rec * 100), raisedAt: 0, now: 0, genesisActive: genesis });
  const rate = direction === "buy" ? 0 : invalid ? null : q.rateBps;
  return (
    <section data-reveal className="panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="label">Fire Tax explorer</span>
        <span className="font-mono text-[10.5px] text-ash">what-if · not a quote</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1">
          <span className="text-ash">Asset</span>
          <select aria-label="Asset" value={asset} onChange={(e) => setAsset(e.target.value as TaxedAsset)} className="well px-2 py-1.5 text-bone">
            <option value="xTOMB">xTOMB</option>
            <option value="xSHARE">xSHARE</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ash">Direction</span>
          <select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value as "sell" | "buy")} className="well px-2 py-1.5 text-bone">
            <option value="sell">Sell</option>
            <option value="buy">Buy</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ash">TWAP / reference</span>
          <input aria-label="TWAP / reference" value={twap} onChange={(e) => setTwap(e.target.value)} inputMode="decimal" className="well px-2 py-1.5 font-mono text-bone" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ash">Projected price / reference</span>
          <input aria-label="Projected price / reference" value={projected} onChange={(e) => setProjected(e.target.value)} inputMode="decimal" className="well px-2 py-1.5 font-mono text-bone" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ash">Recovery floor (%)</span>
          <input aria-label="Recovery floor (%)" value={recovery} onChange={(e) => setRecovery(e.target.value)} inputMode="decimal" className="well px-2 py-1.5 font-mono text-bone" />
        </label>
        <label className="flex items-center gap-2 self-end pb-1.5">
          <input type="checkbox" aria-label="During Genesis" checked={genesis} onChange={(e) => setGenesis(e.target.checked)} />
          <span className="text-bone-dim">During Genesis</span>
        </label>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3 border-t border-white/5 pt-3">
        <div>
          <div className="label mb-1">Estimated Fire Tax</div>
          <div aria-label="Estimated Fire Tax" className="num text-3xl text-bone">
            {rate === null ? "—" : pct(rate)}
          </div>
        </div>
        <div className="text-right text-[11.5px] text-ash">
          {direction === "buy"
            ? "Buys are never taxed."
            : invalid
              ? `Recovery floor must be 1–${FIRE.capBps / 100}%.`
              : `${DRIVER_LABEL[q.driver!]} · TWAP ${pct(targetBps(parseFloat(twap)))}, projected ${pct(targetBps(parseFloat(projected)))}, recovery ${pct(recoveryFloorBps(Math.round(rec * 100), 0, 0))}`}
        </div>
      </div>
    </section>
  );
}
