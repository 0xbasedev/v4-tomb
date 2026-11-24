import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/PageHeader";
import { RuleBadge } from "@/components/Status";
import { TaxLadder } from "@/components/TaxLadder";
import { DocSection, Slider, Stage } from "@/components/docs/kit";
import { formatBps } from "@/lib/format";
import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";
import { useReveal } from "@/lib/motion/useReveal";
import { CEILING, EMISSIONS, LOCKUP, NAMES, scheduleBps } from "@/lib/protocol";

/**
 * Docs — how this system works, written from the contracts in this repository
 * (contracts/src). Every number is a constant or constructor default in those
 * contracts; where governance can change one, the text says so.
 */

const TOC = [
  { id: "summary", label: "In one minute" },
  { id: "names", label: "Three names" },
  { id: "treasury", label: "Treasury" },
  { id: "tax", label: "Sell tax" },
  { id: "share-tax", label: `${NAMES.share} tax` },
  { id: "pools", label: "Pools & wrappers" },
  { id: "genesis", label: "Genesis" },
  { id: "farms", label: "Farms" },
  { id: "room", label: NAMES.room },
  { id: "swap", label: "Swapping" },
  { id: "governance", label: "Governance" },
  { id: "risks", label: "Risks" },
  { id: "glossary", label: "Glossary" },
] as const;
const num = (id: string) => String(TOC.findIndex((t) => t.id === id) + 1).padStart(2, "0");

/** Treasury._expansionCapFor: the cap (bps of supply) by circulating supply. */
const CAPS: [number, number][] = [
  [0, 450],
  [500_000, 400],
  [1_000_000, 350],
  [1_500_000, 300],
  [2_000_000, 250],
  [5_000_000, 200],
  [10_000_000, 150],
  [20_000_000, 125],
  [50_000_000, 100],
];
const capFor = (supply: number) => CAPS.reduce((cap, [from, bps]) => (supply >= from ? bps : cap), CAPS[0][1]);

const GLOSSARY: { term: string; body: string }[] = [
  { term: "TWAP", body: `Time-weighted average price of ${NAMES.peg} in the paired asset, taken from the peg pool. The Treasury and the sell tax read the TWAP, never the spot price, so one trade cannot move them.` },
  { term: "Epoch", body: "Six hours. Once per epoch the Treasury checks the TWAP and either mints or does nothing." },
  { term: "Ceiling", body: `${CEILING.toFixed(2)}. The Treasury mints only when the TWAP is strictly above it.` },
  { term: "Expansion", body: `Newly minted ${NAMES.peg}, sent to ${NAMES.room} stakers after the fund cuts.` },
  { term: "Sell tax", body: `The share of a ${NAMES.peg} sell kept by the peg pool's hook: 12%, 6% or 3% by TWAP.` },
  { term: "Ratchet", body: "The rule that the tax rate rises at once but falls only after the lower rate has stood for 7 hours." },
  { term: "Hook", body: "A Uniswap V4 contract that runs on every swap of its pool. Each of the three pools has one." },
  { term: "Wrapper", body: "An ERC-20 that holds full-range position NFTs of one pool and issues one share per unit of liquidity." },
  { term: "Full range", body: "A position covering every price. Wrappers accept only this, at tick spacing 60." },
  { term: "Paired asset", body: `The token ${NAMES.peg} and ${NAMES.share} each trade against. It is set at deployment; the app reads its symbol from chain.` },
  { term: "Timelock", body: "A contract that delays governance actions by at least 24 hours so they can be seen before they execute." },
  { term: "Permissionless call", body: "A function anyone may call. Here they only move tax to the burn or the fee recipient, or advance the tax ratchet." },
];

export function Docs() {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>(TOC[0].id);
  const pill = useRef<HTMLSpanElement>(null);
  const [twap, setTwap] = useState(1.05);
  const [supply, setSupply] = useState(300_000);
  useReveal(root);

  // Scroll-spy: the section crossing the middle of the viewport is "here".
  useEffect(() => {
    const els = TOC.map((t) => document.getElementById(t.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)), { rootMargin: "-45% 0px -50% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // The active marker glides between contents items.
  useEffect(() => {
    const target = document.querySelector<HTMLElement>(`[data-toc="${active}"]`);
    if (!pill.current || !target) return;
    const y = target.offsetTop;
    if (prefersReducedMotion()) gsap.set(pill.current, { y, height: target.offsetHeight });
    else gsap.to(pill.current, { y, height: target.offsetHeight, duration: 0.45, ease: EASE.settle });
  }, [active]);

  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });

  const expanding = twap > CEILING;
  const capBps = capFor(supply);
  const pctOfSupply = expanding ? Math.min(twap - 1, capBps / 10_000) : 0;
  const minted = supply * pctOfSupply;

  return (
    <div ref={root}>
      <PageHeader eyebrow="Docs" title={`How ${NAMES.peg} works`} lede="Written from the contracts in this repository. Two sections have a slider — move it and watch what the protocol would do." aside={<div className="flex justify-end"><RuleBadge /></div>} />

      {/* Mobile contents: a sticky chip rail. */}
      <div className="sticky top-[104px] z-30 -mt-4 mb-4 border-y border-white/5 bg-void/85 backdrop-blur lg:hidden">
        <div className="flex gap-1.5 overflow-x-auto px-4 py-2 [scrollbar-width:none]">
          {TOC.map((t) => (
            <button key={t.id} type="button" onClick={() => go(t.id)} className={`shrink-0 rounded-full border px-3 py-1 font-mono text-[11px] ${active === t.id ? "border-iris/60 bg-iris/10 text-iris-hot" : "border-white/[0.07] text-ash"}`}>
              {num(t.id)} · {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-8 px-4 md:px-8 lg:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav className="sticky top-36" aria-label="Contents">
            <div className="label mb-3">Contents</div>
            <div className="relative">
              <span ref={pill} aria-hidden className="absolute left-0 top-0 w-0.5 rounded-full bg-brand" style={{ height: 28 }} />
              <ul>
                {TOC.map((t) => (
                  <li key={t.id}>
                    <button type="button" data-toc={t.id} onClick={() => go(t.id)} aria-current={active === t.id ? "true" : undefined} className={`flex w-full items-baseline gap-2.5 py-1.5 pl-4 text-left text-[13px] transition-colors ${active === t.id ? "text-bone" : "text-ash hover:text-bone-dim"}`}>
                      <span className="font-mono text-[10px] text-ash-dim">{num(t.id)}</span>
                      {t.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </aside>

        <div className="min-w-0 space-y-6 pb-10">
          <DocSection
            id="summary"
            numeral={num("summary")}
            title="In one minute"
            lede={`${NAMES.peg} is a token that aims to trade at 1 unit of its paired asset. It has two levers and nothing else.`}
            facts={[
              <><b className="text-bone">Mint above the ceiling.</b> When the 6-hour TWAP is above {CEILING.toFixed(2)}, the Treasury mints new {NAMES.peg} and gives it to {NAMES.room} stakers. More supply pulls the price down.</>,
              <><b className="text-bone">Tax the exits.</b> Every {NAMES.peg} sell pays 12% while the TWAP is under 1.12, then 6%, then 3% from 1.20. Buys pay nothing.</>,
              <><b className="text-bone">Nothing else.</b> The Treasury holds no reserve and no balance. Below the ceiling it simply does not mint.</>,
            ]}
          >
            <Stage caption="The whole loop. Farms pay out on a fixed schedule; the Treasury pays only when the price earns it.">
              <ol className="grid gap-2 text-[13.5px] text-bone-dim sm:grid-cols-2">
                {[
                  ["Provide liquidity", "Mint a full-range position and wrap it."],
                  [`Farm ${NAMES.share}`, "Stake the wrapper in the farms."],
                  [`Stake in ${NAMES.room}`, `Wrap ${NAMES.peg}/${NAMES.share} liquidity and stake it.`],
                  ["Receive expansion", `New ${NAMES.peg} each epoch above ${CEILING.toFixed(2)}.`],
                ].map(([k, v], i) => (
                  <li key={k} className="flex gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-[11px] font-semibold text-white">{i + 1}</span>
                    <span>
                      <span className="block font-semibold text-bone">{k}</span>
                      {v}
                    </span>
                  </li>
                ))}
              </ol>
            </Stage>
          </DocSection>

          <DocSection
            id="names"
            numeral={num("names")}
            title="Three names"
            lede="Two tokens and one place to stake. The on-chain symbols are set at deployment; the app reads them from the contracts and falls back to these names."
            wide
            facts={[
              <><b className="text-iris-hot">{NAMES.peg}</b> — the pegged token (PegToken). Minted by the Treasury during expansion and by the three emission programmes; burned by the sell tax.</>,
              <><b className="text-spectre">{NAMES.share}</b> — the share token (ShareToken). 59,500 are emitted by the ShareFarm over 370 days; a community fund (5,500) and a dev fund (5,000) vest over 365 days.</>,
              <><b className="text-amethyst">{NAMES.room}</b> — the Masonry. Not a token: a staking contract that receives every expansion.</>,
            ]}
          >
            <span />
          </DocSection>

          <DocSection
            id="treasury"
            numeral={num("treasury")}
            title="The Treasury: emissions only"
            lede={`Every 6 hours anyone can turn the epoch. The Treasury reads the TWAP and makes one decision.`}
            facts={[
              <>TWAP above {CEILING.toFixed(2)}: mint <code>supply × (TWAP − 1)</code>, limited by a cap that starts at 4.5% of circulating supply and steps down to 1% as supply grows.</>,
              <>The mint goes to {NAMES.room}, minus the DAO-fund and dev-fund cuts governance has set (shown live on the dashboard).</>,
              <>TWAP at or below {CEILING.toFixed(2)}: nothing happens. There is no debt, no reserve and no other mechanism to wait for.</>,
              <>If nobody is staked in {NAMES.room}, the mint is skipped rather than sent nowhere.</>,
            ]}
          >
            <Stage caption="Drag the TWAP and the supply. This is Treasury.getExpansionAmount, before fund cuts.">
              <div className="space-y-4">
                <Slider id="doc-twap" label="TWAP" value={twap} min={0.9} max={1.3} step={0.005} onChange={setTwap} display={twap.toFixed(3)} />
                <Slider id="doc-supply" label={`Circulating ${NAMES.peg}`} value={supply} min={50_000} max={6_000_000} step={50_000} onChange={setSupply} display={supply.toLocaleString()} accent="rgb(var(--blue-rgb))" />
                <div className="grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-4 text-center">
                  <div>
                    <div className="label mb-1">This epoch</div>
                    <div className={`font-display text-[15px] font-semibold ${expanding ? "text-ok" : "text-bone-dim"}`}>{expanding ? "Mints" : "Nothing"}</div>
                  </div>
                  <div>
                    <div className="label mb-1">Of supply</div>
                    <div className="num text-bone">{(pctOfSupply * 100).toFixed(2)}%</div>
                    <div className="font-mono text-[10px] text-ash">cap {formatBps(capBps)}</div>
                  </div>
                  <div>
                    <div className="label mb-1">Minted</div>
                    <div className="num text-bone">{Math.round(minted).toLocaleString()}</div>
                  </div>
                </div>
              </div>
            </Stage>
          </DocSection>

          <DocSection
            id="tax"
            numeral={num("tax")}
            title={`The ${NAMES.peg} sell tax`}
            lede="The peg pool's hook (PegDefenseHook) takes a share of every sell before the swap happens. It never touches buys."
            facts={[
              <>12% while the TWAP is under 1.12 · 6% from 1.12 · 3% from 1.20. The hard cap is 12%.</>,
              <><b className="text-bone">Up at once, down after 7 hours.</b> A higher rate applies immediately. A lower one applies only after it has stood for a full 7-hour window.</>,
              <>The tax is <b className="text-bone">burned</b> while the TWAP is under 1.10 and sent to the fee recipient above it.</>,
              <>When the pool cannot pay the tax out on the spot, it is parked and settled later by a permissionless call. Either way the seller has already paid it.</>,
              <>A master switch (autoCalculateTax) turns the tax on. It is off at deployment and switched on by governance; the app shows its state.</>,
            ]}
          >
            <Stage caption={`At a TWAP of ${twap.toFixed(3)} the schedule points at ${formatBps(scheduleBps(twap))}. Selling 1,000 ${NAMES.peg} would lose ${(1000 * scheduleBps(twap)) / 10_000} to the tax.`}>
              <Slider id="doc-twap-tax" label="TWAP" value={twap} min={0.95} max={1.3} step={0.005} onChange={setTwap} display={twap.toFixed(3)} />
              <div className="mt-4">
                <TaxLadder price={twap} rateBps={scheduleBps(twap)} enabled />
              </div>
            </Stage>
          </DocSection>

          <DocSection
            id="share-tax"
            numeral={num("share-tax")}
            title={`The ${NAMES.share} sell tax and buyback`}
            lede={`${NAMES.share} trades in its own pool with its own hook (ShareBuybackHook). It borrows the rate above and turns it into ${NAMES.peg} burns.`}
            wide
            facts={[
              <>When its switch is on, a {NAMES.share} sell pays the current rate (never more than 12%) out of the paired asset the seller receives.</>,
              <>The hook holds that tax, then <code>executeBuyback()</code> — callable by anyone — swaps it into {NAMES.peg} in the peg pool and burns all of it.</>,
              <>The buyback will not chase the price: it waits for a TWAP window (30 minutes by default) and stops when the peg pool's spot is too far above it.</>,
              <>The pool's own LP fee is 0.30%.</>,
            ]}
          >
            <span />
          </DocSection>

          <DocSection
            id="pools"
            numeral={num("pools")}
            title="Three pools and their wrappers"
            lede="All liquidity lives in Uniswap V4. Each pool has a hook, and each has a wrapper that turns a full-range position into a token you can stake."
            wide
          >
            <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
              <table className="crypt-table w-full min-w-[620px] text-[13px]">
                <thead>
                  <tr>
                    <th>Pool</th>
                    <th>Hook</th>
                    <th>Trading</th>
                    <th>Its wrapper is staked in</th>
                  </tr>
                </thead>
                <tbody className="text-bone-dim">
                  <tr>
                    <td className="font-semibold text-bone">{NAMES.peg} / paired asset</td>
                    <td>PegDefenseHook</td>
                    <td>Open · LP fee set per swap by the hook (0.10% – 3%) · sell tax</td>
                    <td>PegFarm, ShareFarm pool 0</td>
                  </tr>
                  <tr>
                    <td className="font-semibold text-bone">{NAMES.share} / paired asset</td>
                    <td>ShareBuybackHook</td>
                    <td>Open · 0.30% LP fee · sell tax funds the buyback</td>
                    <td>ShareFarm pool 1</td>
                  </tr>
                  <tr>
                    <td className="font-semibold text-bone">{NAMES.peg} / {NAMES.share}</td>
                    <td>LpOnlyHook</td>
                    <td>Closed · every swap reverts · liquidity only</td>
                    <td>{NAMES.room}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul className="mt-4 grid gap-2 text-[13.5px] leading-relaxed text-bone-dim sm:grid-cols-2">
              <li>A wrapper (V4PositionWrapper) accepts only positions of its own pool, at the full range, and mints one share per unit of liquidity.</li>
              <li>Only the address that wrapped a position can unwrap it, by returning the same number of shares and naming the token ID.</li>
              <li>Because the {NAMES.peg}/{NAMES.share} pool cannot be traded, it can never be a route around the sell tax, and its ratio never moves.</li>
              <li>Adding or removing liquidity is not a sale, so it is not taxed.</li>
            </ul>
          </DocSection>

          <DocSection
            id="genesis"
            numeral={num("genesis")}
            title="Genesis"
            lede={`One 24-hour window before the first epoch (GenesisRewardPool). It distributes ${EMISSIONS.genesis.total.toLocaleString()} ${NAMES.peg}.`}
            wide
            facts={[
              <>Deposit a token the pool lists and earn {NAMES.peg} per second, in proportion to your share of that pool.</>,
              <>The listed tokens and their weights are set by the operator before the window opens. The app reads them from the contract.</>,
              <>No lockup and no deposit fee: withdraw the same token whenever you like.</>,
            ]}
          >
            <Link to="/genesis" className="btn btn-ghost">
              Open Genesis →
            </Link>
          </DocSection>

          <DocSection
            id="farms"
            numeral={num("farms")}
            title="Farms"
            lede="Two reward pools that take wrapper tokens. Both pay per second and neither locks deposits."
            wide
            facts={[
              <><b className="text-bone">PegFarm</b> — {EMISSIONS.pegFarm.total.toLocaleString()} {NAMES.peg} over 9 days: {EMISSIONS.pegFarm.phases}. One pool: the wrapped {NAMES.peg} liquidity position.</>,
              <><b className="text-bone">ShareFarm</b> — {EMISSIONS.shareFarm.total.toLocaleString()} {NAMES.share} over 370 days. Pool 0, wrapped {NAMES.peg} liquidity, gets 30%; pool 1, wrapped {NAMES.share} liquidity, gets 70%.</>,
              <>Claiming is a zero-amount deposit; withdrawing pays out what you earned. Emergency withdraw returns the stake and forfeits the earnings.</>,
            ]}
          >
            <Link to="/farm" className="btn btn-ghost">
              Open the farm →
            </Link>
          </DocSection>

          <DocSection
            id="room"
            numeral={num("room")}
            title={`${NAMES.room}`}
            lede={`The Masonry. By default it stakes the wrapper of the ${NAMES.peg}/${NAMES.share} position — not ${NAMES.share} itself — and pays out ${NAMES.peg} whenever the Treasury expands.`}
            facts={[
              <>Each expansion is split across stakers by their share of the stake at that moment.</>,
              <><b className="text-bone">Rewards unlock after {LOCKUP.rewardEpochs} epochs</b> (18 hours); <b className="text-bone">the stake after {LOCKUP.withdrawEpochs}</b> (36 hours).</>,
              <>Both clocks restart on every stake, and on every claim or withdrawal that pays a reward. The app warns before you restart them.</>,
              <>Staking is a deposit, not a trade: no sell tax and no fee.</>,
            ]}
          >
            <Stage caption="Epochs since your last stake or claim. Each bar is six hours.">
              <div className="flex gap-1.5">
                {Array.from({ length: 8 }, (_, i) => {
                  const rewards = i >= LOCKUP.rewardEpochs;
                  const stake = i >= LOCKUP.withdrawEpochs;
                  return (
                    <div key={i} className="flex-1 text-center">
                      <div className={`h-12 rounded-lg border ${stake ? "border-ok/40 bg-ok/15" : rewards ? "border-spectre/40 bg-spectre/15" : "border-white/10 bg-white/[0.03]"}`} />
                      <div className="mt-1.5 font-mono text-[10px] text-ash">{i}</div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-ash">
                <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-white/20" />locked</span>
                <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-spectre" />rewards claimable</span>
                <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-ok" />stake withdrawable</span>
              </div>
            </Stage>
          </DocSection>

          <DocSection
            id="swap"
            numeral={num("swap")}
            title="Swapping"
            lede="The app trades through MiniSwapRouter: one exact-input call with a minimum output and a deadline."
            wide
            facts={[
              <>You approve the router for the exact amount, then swap. No unlimited approvals.</>,
              <>The transaction reverts if you would receive less than the minimum shown, or if it is mined after its 10-minute deadline.</>,
              <>Before a sell, the ticket shows the tax as an amount, not just a rate. At the 12% cap the sell button must be held.</>,
              <>{NAMES.peg} and {NAMES.share} cannot be swapped for each other directly.</>,
            ]}
          >
            <Link to="/swap" className="btn btn-ghost">
              Open swap →
            </Link>
          </DocSection>

          <DocSection
            id="governance"
            numeral={num("governance")}
            title="Governance and upkeep"
            lede="Privileged roles are meant to sit behind a Timelock. The status page shows who holds each one right now."
            wide
            facts={[
              <>The Timelock delays every action by at least 24 hours (and at most 30 days), with a 14-day window to execute.</>,
              <>Governance can change the ceiling, the expansion caps, the fund cuts, the tax tiers (never above 12%), the fee recipient, the two tax switches and the farm pool weights.</>,
              <>Three calls are open to anyone: <code>pokeTaxRate</code> advances the tax ratchet, <code>settleDeferredTax</code> burns or routes parked tax, and <code>executeBuyback</code> converts {NAMES.share} tax into burned {NAMES.peg}.</>,
            ]}
          >
            <Link to="/admin" className="btn btn-ghost">
              Open status →
            </Link>
          </DocSection>

          <DocSection
            id="risks"
            numeral={num("risks")}
            title="Risks"
            lede="Read these before you put anything in. None of them is hypothetical."
            wide
            facts={[
              <><b className="text-bone">The peg can break.</b> Nothing redeems {NAMES.peg} for the paired asset. Below the ceiling the only support is the sell tax and buyers' own demand.</>,
              <><b className="text-bone">Liquidity carries price risk.</b> A full-range position holds both tokens; if one falls, the position falls with it, and rewards may not cover that.</>,
              <><b className="text-bone">Lockups are real.</b> A stake in {NAMES.room} cannot be withdrawn for {LOCKUP.withdrawEpochs} epochs, and claiming restarts the wait.</>,
              <><b className="text-bone">Selling is expensive.</b> Up to 12% of a sale is taken. Plan exits around the rate, not after it.</>,
              <><b className="text-bone">Governance can change parameters.</b> Check who holds the roles and what is queued in the Timelock.</>,
              <><b className="text-bone">Smart-contract risk.</b> Hooks, wrappers and the router are code. Verify addresses against the published deployment, and never act on figures from an interface that is not reading it.</>,
            ]}
          >
            <span />
          </DocSection>

          <section id="glossary" data-reveal className="panel scroll-mt-24 p-5 md:p-7">
            <div className="mb-2 flex items-center gap-3">
              <span className="font-mono text-[11px] tracking-[0.2em] text-iris">{num("glossary")}</span>
              <span className="h-px flex-1 bg-gradient-to-r from-iris/40 to-transparent" />
            </div>
            <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-bone md:text-[28px]">Glossary</h2>
            <dl className="mt-5 grid gap-x-8 gap-y-4 md:grid-cols-2">
              {GLOSSARY.map((g) => (
                <div key={g.term}>
                  <dt className="text-[14px] font-semibold text-bone">{g.term}</dt>
                  <dd className="mt-1 text-[13.5px] leading-relaxed text-bone-dim">{g.body}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
