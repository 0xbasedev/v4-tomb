import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { EmissionsTimeline, HarvestSplitter, TierMatrix } from "@/components/docs/GenesisVisuals";
import { DocSection } from "@/components/docs/kit";
import { FireTaxExplorer, Glossary, RiskMeters } from "@/components/docs/MiscVisuals";
import { PathStepper } from "@/components/docs/PathStepper";
import { PegMachine } from "@/components/docs/PegMachine";
import { TokenFlows } from "@/components/docs/TokenFlows";
import { EpochWheel, RoutingSplit } from "@/components/docs/TreasuryVisuals";
import { CompoundCurve, RoutePlayer } from "@/components/docs/ZapVisuals";
import { PageHeader } from "@/components/PageHeader";
import { PendingPanel } from "@/components/Status";
import { BRIDGE } from "@/lib/create3";
import { GENESIS_DAYS, LP_DAY } from "@/lib/genesis";
import { DEFENSE, EPOCH_SECONDS, EXPANSION, FARM_POLICY, FIRE, GENESIS_POLICY, PASSES, SQUARE_ROUTING, SQUARE_SUPPLY, pct } from "@/lib/launch";
import { PEG, pegPair } from "@/lib/peg";
import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Docs — the field guide, as something you can play with. Every section is a
 * short column of facts next to an interactive, animated visual. Every number
 * is read from config/masonry-launch.template.json through lib/launch, so the
 * docs can't drift from the contracts' launch configuration. Anything without
 * a contract binding is labelled pending or planned.
 */

const TOC: { id: string; label: string }[] = [
  { id: "summary", label: "In sixty seconds" },
  { id: "tokens", label: "The three tokens" },
  { id: "begin", label: "How to begin" },
  { id: "genesis", label: "Genesis and the passes" },
  { id: "tax", label: "Swap and the Fire Tax" },
  { id: "loop", label: "Claim and compound" },
  { id: "cycle", label: "Epochs, expansion, defense" },
  { id: "masonry", label: "Masonry and Farm" },
  { id: "bonds", label: "Bonds" },
  { id: "bridge", label: "Bridge" },
  { id: "risks", label: "Risks" },
  { id: "glossary", label: "Glossary" },
];
const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const num = (id: string) => NUMERALS[TOC.findIndex((t) => t.id === id)] ?? "·";

const H = (s: number) => `${s / 3600}h`;
const USD = (n: number) => `$${n.toFixed(2)}`;

const TERMS: { term: string; body: string; tag: string }[] = [
  { term: "Epoch", tag: "treasury", body: `A ${H(EPOCH_SECONDS)} checkpoint. Each one is judged on its own fresh TWAP; a missed or stale epoch is never made up later.` },
  { term: "TWAP", tag: "treasury", body: `Time-weighted average price from the official ${pegPair("xTOMB")} pool's oracle. It needs active liquidity and a recent real swap to be valid.` },
  { term: "Expansion (planned)", tag: "treasury", body: `When a fresh TWAP is strictly above ${USD(EXPANSION.gate)}, an epoch may mint up to ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB. The mint isn't bound in the contracts yet. There is no bootstrap.` },
  { term: "Critical Defense", tag: "treasury", body: `Entered at or below ${USD(DEFENSE.enterAt)}. New xSHARE sell tax buys and burns xTOMB until ${DEFENSE.recoveryEpochs} checkpoints close above ${USD(DEFENSE.exitAbove)}.` },
  { term: "Fire Tax", tag: "swap", body: `The hooks' sell tax: the highest of the TWAP rate, the projected post-sale rate, the recovery floor and the Genesis floor. Baseline ${pct(FIRE.baselineBps)}, hard cap ${pct(FIRE.capBps)}. Buys and wallet transfers pay 0%.` },
  { term: "Recovery floor", tag: "swap", body: `After the tax rises, it can't fall straight back: the floor decays linearly to baseline over ${H(FIRE.recoverySeconds)}.` },
  { term: "Genesis floor", tag: "swap", body: `During Genesis, sells pay at least ${pct(FIRE.genesisFloorBps.xTOMB)} (xTOMB) or ${pct(FIRE.genesisFloorBps.xSHARE)} (xSHARE). The whole xTOMB sell tax burns during Genesis.` },
  { term: "Sell leg", tag: "swap", body: `The part of a route that sells xTOMB or xSHARE for ${PEG.symbol}. Only that leg pays the Fire Tax — removing liquidity to ${PEG.symbol} taxes the sold half, not the whole position.` },
  { term: "Pool fee", tag: "swap", body: "The Uniswap v4 LP fee on each leg. It's shown separately from the Fire Tax." },
  { term: "Genesis pass", tag: "genesis", body: `Soulbound, one per wallet, paid in ${PEG.symbol}: Genesis ${PASSES.genesis.priceUsdc}, Pro ${PASSES.pro.priceUsdc}, Ultra ${PASSES.ultra.priceUsdc}. Same reward weighting for all. No deposit fees; upgrades cost the price difference.` },
  { term: "Standard pool", tag: "genesis", body: `Genesis pool 0. It takes every emission on Day 1 and 25% from Day ${LP_DAY}. Ultra can stake in it up to 24h before Genesis starts.` },
  { term: "LP pool", tag: "genesis", body: `Genesis pool 1 — ${pegPair("xTOMB")} vault shares. Opens on Day ${LP_DAY} with 75% of emissions.` },
  { term: "Liquid / vested", tag: "genesis", body: `Every reward splits ${pct(GENESIS_POLICY.liquidShare * 10_000)} liquid, the rest vested. This is separate from the 75/25 pool split.` },
  { term: "Installment", tag: "genesis", body: `Vested rewards release in ${GENESIS_POLICY.installments} claim-gated installments. The first opens ${H(GENESIS_POLICY.installmentSeconds)} after Genesis ends; each next one ${H(GENESIS_POLICY.installmentSeconds)} after you claim the last.` },
  { term: "Wallet fee", tag: "genesis", body: `${pct(GENESIS_POLICY.walletFeeBps)} of liquid claims, releases and refunds, to Treasury. A claim of 400 pays 196 to the wallet, 4 to Treasury and vests 200.` },
  { term: "LP burn fee", tag: "genesis", body: `${pct(GENESIS_POLICY.lpBurnFeeBps)} of the LP shares a compound creates, burned.` },
  { term: "Keeper", tag: "automation", body: `An executor a Pro or Ultra holder opts into. It compounds for you, no more often than every ${H(GENESIS_POLICY.compoundCooldownSeconds)}, for ${pct(GENESIS_POLICY.automationFeeBps)} of the liquid half per run.` },
  { term: "Compound cooldown", tag: "automation", body: `${H(GENESIS_POLICY.compoundCooldownSeconds)}, shared by claims and compounds, by hand or by keeper. Withdrawals are never locked.` },
  { term: "xSHARE routing", tag: "treasury", body: `Normal mode: ${pct(SQUARE_ROUTING.polBps)} of collected xSHARE tax to protocol LP, ${pct(SQUARE_ROUTING.usdcReserveBps)} to the ${PEG.symbol} reserve, ${pct(SQUARE_ROUTING.squareReserveBps)} to the xSHARE reserve.` },
  { term: "Hook", tag: "swap", body: "A Uniswap v4 contract that runs on every swap of its pool. The xTOMB and xSHARE hooks observe price, charge the Fire Tax and reject sells without a valid TWAP." },
  { term: "CREATE3 release plan", tag: "app", body: "CreateX predicts every project address from the deployment signer, a release ID and each role — the same on every chain with the canonical factory. Hooks are mined for their Uniswap v4 permission bits. Predictions aren't deployments." },
  { term: "Home chain", tag: "bridge", body: "Where original xSHARE lives and the bridge escrows it. Chosen in the Wizard; every route runs home ↔ satellite." },
  { term: "Bridged xSHARE", tag: "bridge", body: "The 18-decimal token on the four non-home networks. Same symbol as xSHARE, its own address; minted and burned only by the bridge." },
  { term: "Hyperlane", tag: "bridge", body: "The messaging layer the bridge uses: a Mailbox per chain, an ISM that verifies messages, and relayers that deliver them. Fees are quoted in the source chain's native currency." },
  { term: "Preview", tag: "app", body: "Until a verified deployment exists, the app runs on simulated data. Every action is simulated and no wallet request is ever sent." },
];

export function Docs() {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(TOC[0].id);
  const pill = useRef<HTMLSpanElement>(null);
  useReveal(root);

  // Scroll-spy: the section crossing the middle of the viewport is "here".
  useEffect(() => {
    const els = TOC.map((t) => document.getElementById(t.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: "-45% 0px -50% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // The active marker glides between TOC items.
  useEffect(() => {
    const target = document.querySelector<HTMLElement>(`[data-toc="${active}"]`);
    if (!pill.current || !target) return;
    const y = target.offsetTop;
    if (prefersReducedMotion()) gsap.set(pill.current, { y, height: target.offsetHeight });
    else gsap.to(pill.current, { y, height: target.offsetHeight, duration: 0.45, ease: EASE.settle });
    document.querySelector(`[data-toc-m="${active}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Field guide · interactive"
        title="How xTomb works"
        lede="Every section has something to drag, tap or play. The numbers come from the same config the app runs on."
      />

      {/* Mobile contents: a sticky chip rail. */}
      <div className="sticky top-16 z-30 -mt-4 mb-4 border-y border-white/5 bg-void/85 backdrop-blur lg:hidden">
        <div className="flex gap-1.5 overflow-x-auto px-4 py-2 [scrollbar-width:none]">
          {TOC.map((t) => (
            <button
              key={t.id}
              type="button"
              data-toc-m={t.id}
              onClick={() => go(t.id)}
              className={`shrink-0 rounded-full border px-3 py-1 font-mono text-[11px] ${active === t.id ? "border-ember/60 bg-ember/10 text-ember-hot" : "border-white/[0.07] text-ash"}`}
            >
              {num(t.id)} · {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-8 px-4 md:px-8 lg:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav className="sticky top-24" aria-label="Contents">
            <div className="label mb-3">Contents</div>
            <div className="relative">
              <span ref={pill} className="absolute left-0 top-0 w-full rounded-lg border-l-2 border-ember bg-ember/[0.07]" style={{ height: 32 }} />
              {TOC.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-toc={t.id}
                  onClick={() => go(t.id)}
                  className={`relative block w-full rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors ${active === t.id ? "text-bone" : "text-ash hover:text-bone-dim"}`}
                >
                  <span className="mr-2 font-mono text-[10px] text-ember/80">{num(t.id)}</span>
                  {t.label}
                </button>
              ))}
            </div>
          </nav>
        </aside>

        <div className="min-w-0 space-y-6 pb-10">
          <DocSection
            id="summary"
            numeral={num("summary")}
            title="In sixty seconds"
            lede={`xTOMB is pegged to $1 ${PEG.symbol}. Each rule switches on at a different price, and all of them read the same validated TWAP.`}
            facts={[
              `At every price: sells pay the Fire Tax, at least ${pct(FIRE.baselineBps)} and at most ${pct(FIRE.capBps)}. Buys and transfers pay 0%.`,
              `At or below ${USD(DEFENSE.enterAt)}: Critical Defense. New xSHARE tax buys and burns xTOMB.`,
              `Above ${USD(EXPANSION.gate)} on a fresh TWAP: an epoch may mint up to ${pct(EXPANSION.maxPerEpochBps)} (planned).`,
              "No valid TWAP: sells are rejected and nothing expands.",
            ]}
          >
            <PegMachine />
          </DocSection>

          <DocSection
            id="tokens"
            numeral={num("tokens")}
            title="The three tokens"
            lede={`A $1 stable, a capped share that trades against ${PEG.symbol}, and X Bond (MasonryBond, not launched).`}
            facts={[
              `xTOMB — the $1 stable. Official pair: ${pegPair("xTOMB")}.`,
              `xSHARE — capped at ${SQUARE_SUPPLY.cap.toLocaleString("en-US")}. Official pair: ${pegPair("xSHARE")}.`,
              "xBOND — MasonryBond: buy below peg (burn xTOMB), redeem above peg. Not launched.",
            ]}
          >
            <TokenFlows />
          </DocSection>

          <DocSection
            id="begin"
            numeral={num("begin")}
            title="How to begin"
            lede="Four ways in. Only Genesis is bound to contracts today; the others say what's missing."
            facts={["Founders enter Genesis with a soulbound pass.", "Farmers earn xSHARE on LP via MasonryFarm (X Share/WETH LP is the first pool).", "Members stake X Share/WETH LP in MasonryChamber to receive expansion.", "Bondholders use MasonryBond once a verified address is published."]}
          >
            <PathStepper />
          </DocSection>

          <DocSection
            id="genesis"
            numeral={num("genesis")}
            title="Genesis and the passes"
            lede={`${GENESIS_DAYS} days, two pools. Day 1 the standard pool takes every emission; from Day ${LP_DAY} the ${pegPair("xTOMB")} LP pool takes 75%.`}
            facts={[
              `Each reward: ${pct(GENESIS_POLICY.liquidShare * 10_000)} liquid, the rest vested — separate from the 75/25 pool split.`,
              `Vested: ${GENESIS_POLICY.installments} claim-gated ${H(GENESIS_POLICY.installmentSeconds)} installments after Genesis ends.`,
              `${pct(GENESIS_POLICY.walletFeeBps)} wallet fee on liquid claims. 400 → 196 wallet, 4 Treasury, 200 vested.`,
              `Passes: ${PASSES.genesis.priceUsdc} / ${PASSES.pro.priceUsdc} / ${PASSES.ultra.priceUsdc} ${PEG.symbol}, soulbound. Same reward weighting.`,
              "Pro and Ultra can opt into keeper compounding. Ultra can stake the standard pool 24h early.",
            ]}
            wide
          >
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <EmissionsTimeline />
              <HarvestSplitter />
            </div>
            <div className="mt-4">
              <TierMatrix />
            </div>
          </DocSection>

          <DocSection
            id="tax"
            numeral={num("tax")}
            title="Swap and the Fire Tax"
            lede="One sell tax per swap: the highest of the TWAP rate, the projected post-sale rate, the recovery floor and the Genesis floor."
            facts={[
              `Baseline ${pct(FIRE.baselineBps)}; rises as price falls; ${pct(FIRE.capBps)} at or below ${Math.round(FIRE.fullTaxAt * 100)}% of the reference.`,
              `Genesis floors: ${pct(FIRE.genesisFloorBps.xTOMB)} xTOMB, ${pct(FIRE.genesisFloorBps.xSHARE)} xSHARE. The full xTOMB sell tax burns during Genesis.`,
              `After a rise the floor decays to baseline over ${H(FIRE.recoverySeconds)}.`,
              "Routes tax only their sell leg; pool fees are listed separately. Unsupported routes say so.",
            ]}
            wide
          >
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <FireTaxExplorer />
              <RoutePlayer />
            </div>
          </DocSection>

          <DocSection
            id="loop"
            numeral={num("loop")}
            title="Claim and compound"
            lede={`Claims and compounds share one ${H(GENESIS_POLICY.compoundCooldownSeconds)} cooldown. A compound sells part of the liquid half for ${PEG.symbol}, adds ${pegPair("xTOMB")} liquidity and stakes it.`}
            facts={[
              "The compound's sell leg can pay the Fire Tax.",
              `${pct(GENESIS_POLICY.lpBurnFeeBps)} of the new LP shares burn.`,
              `Keeper runs (Pro/Ultra, opt-in) add a ${pct(GENESIS_POLICY.automationFeeBps)} automation fee.`,
              "Withdrawals are never locked.",
            ]}
          >
            <CompoundCurve />
          </DocSection>

          <DocSection
            id="cycle"
            numeral={num("cycle")}
            title="Epochs, expansion, defense"
            lede={`Every ${H(EPOCH_SECONDS)} is a checkpoint judged on its own fresh, validated TWAP. There's no bootstrap: no epoch mints unconditionally.`}
            facts={[
              `Expansion (planned): fresh TWAP strictly above ${USD(EXPANSION.gate)}, at most ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB.`,
              `Critical Defense: at or below ${USD(DEFENSE.enterAt)}; exits after ${DEFENSE.recoveryEpochs} checkpoints above ${USD(DEFENSE.exitAbove)}.`,
              `Oracle readings older than ${DEFENSE.oracleMaxAgeSeconds / 60} minutes don't count for defense checkpoints.`,
              "Normal xSHARE routing and Critical Defense routing are separate — see the toggle.",
            ]}
            wide
          >
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <EpochWheel />
              <RoutingSplit />
            </div>
          </DocSection>

          <DocSection
            id="masonry"
            numeral={num("masonry")}
            title="Masonry and Farm"
            lede="Both screens exist; neither has a bound contract in the merge branch. Their actions stay disabled and say why."
            facts={[
              `Farm: xSHARE emissions over ${FARM_POLICY.emissionDays} days, ${H(FARM_POLICY.compoundCooldownSeconds)} compound limit (configured).`,
              `Masonry: stake ${pegPair("xSHARE")} LP for a share of expansion (planned).`,
              "Locks, fees and automation for both are pending.",
            ]}
          >
            <div className="space-y-3">
              <PendingPanel title="Farm">
                Configured for {SQUARE_SUPPLY.farming.toLocaleString("en-US")} xSHARE over {FARM_POLICY.emissionDays} days. No production Farm contract or ABI is in the handoff, so deposits, claims and
                compounds are disabled. <Link to="/farm" className="text-ember-hot underline-offset-2 hover:underline">Open the Farm →</Link>
              </PendingPanel>
              <PendingPanel title="Masonry">
                MasonryTreasury mints expansion to MasonryChamber (X Share/WETH LP stakers) when a fresh TWAP is strictly above $1.01. Contracts exist; no verified launch address is bound yet.{" "}
                <Link to="/masonry" className="text-ember-hot underline-offset-2 hover:underline">Open the Masonry →</Link>
              </PendingPanel>
            </div>
          </DocSection>

          <DocSection
            id="bonds"
            numeral={num("bonds")}
            title="Bonds"
            lede="MasonryBond buys below peg by burning xTOMB and redeems above peg 1:1. Issuance stays disabled until a verified address is published; discount and debt caps are placeholders."
            facts={["Once live, the page will show the contract's quote, your eligibility, remaining issuance and reserve availability.", "Every blocked action will say why."]}
          >
            <PendingPanel title="xBOND" badge="planned">
              Nothing here sends a transaction. <Link to="/bonds" className="text-ember-hot underline-offset-2 hover:underline">Open Bonds →</Link>
            </PendingPanel>
          </DocSection>

          <DocSection
            id="bridge"
            numeral={num("bridge")}
            title="Bridge"
            lede={`xSHARE moves over Hyperlane between the home chain and ${BRIDGE.networks.map((n) => n.name).join(", ")}. Original xSHARE stays home; the others receive Bridged xSHARE.`}
            facts={[
              "Satellite → satellite is two transfers through the home chain.",
              "xSHARE only — Genesis passes are soulbound and stay put.",
              "Every route is disabled until a verified deployment passes a production canary. Sonic also needs a verified validator and relayer.",
              "Addresses are predicted with CreateX CREATE3 from the deployment signer and release ID.",
            ]}
          >
            <PendingPanel title="xSHARE bridge" badge="planned">
              Five networks, all disabled in the manifest. The Bridge page shows the routes, the send checks and predicted addresses from your release plan.{" "}
              <Link to="/bridge" className="text-ember-hot underline-offset-2 hover:underline">Open Bridge →</Link>
            </PendingPanel>
          </DocSection>

          <DocSection
            id="risks"
            numeral={num("risks")}
            title="Risks"
            lede="Algorithmic stables are speculative. The peg holds while the incentives outweigh people's willingness to exit. Tap a risk for what's done about it."
            wide
          >
            <RiskMeters />
          </DocSection>

          <DocSection id="glossary" numeral={num("glossary")} title="Glossary" lede="Search it, or filter by area." wide>
            <Glossary terms={TERMS} />
          </DocSection>

          <div data-reveal className="panel panel-raised p-6 md:p-8">
            <div className="label mb-2">Ready</div>
            <h2 className="mb-3 font-display text-2xl font-semibold text-bone">Pick a path</h2>
            <p className="mb-6 text-[15px] text-bone-dim">The dashboard tells you which one the current phase favours.</p>
            <div className="flex flex-wrap gap-3">
              <Link to="/dashboard" className="btn btn-primary">
                Dashboard →
              </Link>
              <Link to="/genesis" className="btn">
                Genesis
              </Link>
              <Link to="/masonry" className="btn">
                Masonry
              </Link>
              <Link to="/bridge" className="btn">
                Bridge
              </Link>
              <Link to="/swap" className="btn">
                Swap
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
