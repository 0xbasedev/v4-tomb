import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Countdown } from "@/components/Countdown";
import { FarmPoolCard } from "@/components/FarmPoolCard";
import { LiquidityWorkshop } from "@/components/LiquidityWorkshop";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatTile } from "@/components/StatTile";
import { NotDeployed, RuleBadge } from "@/components/Status";
import { Segmented } from "@/components/docs/kit";
import { formatDate, toNumber } from "@/lib/format";
import { useProtocol, type FarmPool } from "@/lib/hooks";
import { useReveal } from "@/lib/motion/useReveal";
import { EMISSIONS, NAMES } from "@/lib/protocol";
import type { PoolId } from "@/lib/swap/poolKey";

type FarmTab = "peg" | "share";
const POOL_OF: Record<FarmPool["role"], PoolId | null> = { pegLp: "peg", shareLp: "share", pairLp: "pair", other: null };

/**
 * Farm — PegFarm (pays the peg token) and ShareFarm (pays the share token).
 *
 * Both take wrapped full-range Uniswap V4 positions, so the page has two halves:
 * the pools you stake in, and the workshop that turns two tokens into the
 * wrapper token those pools accept.
 */
export function Farm() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const [params, setParams] = useSearchParams();
  const tab: FarmTab = params.get("farm") === "share" ? "share" : "peg";
  const farm = tab === "peg" ? p.farms.pegFarm : p.farms.shareFarm;
  const meta = tab === "peg" ? EMISSIONS.pegFarm : EMISSIONS.shareFarm;
  const reward = tab === "peg" ? NAMES.peg : NAMES.share;
  const [workshop, setWorkshop] = useState<PoolId>("peg");
  const [focusKey, setFocusKey] = useState(0);
  useReveal(root, [p.deployed, tab, farm.pools.length]);

  function needLp(pool: FarmPool) {
    const id = POOL_OF[pool.role];
    if (!id) return;
    setWorkshop(id);
    setFocusKey((k) => k + 1);
    document.getElementById("workshop")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Farm"
        token="xSHARE"
        title={
          <>
            Stake liquidity, earn <span className="spectre-text">{NAMES.share}</span>
          </>
        }
        lede={`Provide full-range liquidity, wrap the position into a token, and stake it. The PegFarm pays ${NAMES.peg} for nine days; the ShareFarm pays ${NAMES.share} for 370.`}
        aside={
          <div className="panel panel-raised p-5">
            <div className="label mb-3">Three steps</div>
            <ol className="space-y-2.5 text-[13.5px] text-bone-dim">
              {["Mint a full-range position from two tokens", "Wrap it — you get wrapper shares", "Deposit the shares in a pool below"].map((s, i) => (
                <li key={s} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-[10px] font-semibold text-white">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          </div>
        }
      />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-10 md:px-8">
        {!p.deployed && <NotDeployed what="Farming" />}

        <div data-reveal className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            options={[
              { id: "peg", label: `PegFarm · earns ${NAMES.peg}` },
              { id: "share", label: `ShareFarm · earns ${NAMES.share}` },
            ]}
            value={tab}
            onChange={(t) => setParams(t === "peg" ? {} : { farm: t }, { replace: true })}
          />
          <span className={`chip ${farm.phase === "live" ? "chip-ok" : farm.phase === "upcoming" ? "chip-iris" : ""}`}>
            {farm.phase === "unknown" ? "Not deployed" : farm.phase === "upcoming" ? "Opens soon" : farm.phase === "live" ? "Live" : "Ended"}
          </span>
        </div>

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Programme">
          <StatTile label="Total rewards" numeric={toNumber(farm.totalRewards) ?? meta.total} format={(n) => n.toLocaleString()} unit={reward} hint={farm.totalRewards === null ? "Contract constant" : "TOTAL_REWARDS"} tone={tab === "peg" ? "iris" : "spectre"} />
          <StatTile label="Schedule" value={tab === "peg" ? "9 days" : "370 days"} hint={tab === "peg" ? EMISSIONS.pegFarm.phases : EMISSIONS.shareFarm.split} />
          <StatTile label="Opens" value={farm.start ? formatDate(farm.start) : "—"} hint="poolStartTime" />
          <StatTile
            label="Ends"
            value={farm.end ? formatDate(farm.end) : "—"}
            hint={farm.phase === "live" ? <>In <Countdown to={farm.end} done="moments" className="text-bone-dim" /></> : "When emissions stop"}
          />
        </section>

        <section>
          <SectionTitle kicker="Pools" title={tab === "peg" ? "PegFarm" : "ShareFarm"} />
          {farm.pools.length > 0 ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {farm.pools.map((pool) => (
                <FarmPoolCard key={`${tab}-${pool.pid}`} farm={farm} pool={pool} onNeedLp={needLp} />
              ))}
            </div>
          ) : (
            <div data-reveal className="rounded-2xl border border-dashed border-white/12 bg-black/20 p-6 text-[14px] leading-relaxed text-bone-dim">
              {p.deployed
                ? farm.loaded
                  ? "No pools are registered in this farm yet."
                  : "Reading the pools…"
                : tab === "peg"
                  ? `By design this farm has one pool: the wrapped ${NAMES.peg} liquidity position. It appears here once the protocol is deployed.`
                  : `By design this farm has two pools: wrapped ${NAMES.peg} liquidity (30% of emissions) and wrapped ${NAMES.share} liquidity (70%). They appear here once the protocol is deployed.`}
            </div>
          )}
        </section>

        <section>
          <SectionTitle
            kicker="Workshop"
            title="Make the token the pools accept"
            right={
              p.deployed ? (
                <Segmented
                  options={[
                    { id: "peg", label: `${NAMES.peg} LP` },
                    { id: "share", label: `${NAMES.share} LP` },
                    { id: "pair", label: `${NAMES.peg}/${NAMES.share} LP` },
                  ]}
                  value={workshop}
                  onChange={setWorkshop}
                />
              ) : undefined
            }
          />
          {p.deployed ? (
            <LiquidityWorkshop pool={workshop} focusKey={focusKey} />
          ) : (
            <div data-reveal className="grid grid-cols-1 gap-4 md:grid-cols-4">
              {[
                ["1 · Mint", "Supply two tokens at the pool's current ratio. You receive a Uniswap V4 position NFT covering the full range."],
                ["2 · Wrap", "Hand the NFT to its wrapper and receive ERC-20 shares, one per unit of liquidity. Only you can unwrap it."],
                ["3 · Stake", "Deposit the shares in a farm pool — or, for the peg/share pair, in xROOM."],
                ["Undo", "Withdraw, unwrap with the same token ID, then remove the liquidity to get both tokens back."],
              ].map(([k, v]) => (
                <div key={k} className="panel p-5">
                  <div className="label mb-2">{k}</div>
                  <p className="text-[13.5px] leading-relaxed text-bone-dim">{v}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionTitle kicker="Rules" title="Good to know before you provide liquidity" right={<RuleBadge />} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              ["Full range only", "Wrappers accept one exact range: the whole curve at tick spacing 60. There is nothing to rebalance and nothing to go out of range."],
              ["No lockup here", "Farm deposits can be withdrawn at any time, with rewards. Only xROOM has lockups."],
              ["Price risk is real", `Liquidity holds both tokens. If ${NAMES.peg} or ${NAMES.share} falls against the paired asset, so does the position — rewards do not remove that risk.`],
            ].map(([k, v]) => (
              <div key={k} data-reveal className="panel p-5">
                <div className="label mb-2">{k}</div>
                <p className="text-[13.5px] leading-relaxed text-bone-dim">{v}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[13px] text-ash">
            Holding the {NAMES.peg}/{NAMES.share} wrapper?{" "}
            <Link to="/masonry" className="text-iris-hot underline-offset-4 hover:underline">
              Stake it in {NAMES.room} for expansion →
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
