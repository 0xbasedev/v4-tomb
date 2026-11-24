import { useRef } from "react";
import { Link } from "react-router-dom";

import { ChainPicker } from "@/components/ChainPicker";
import { ConnectButton } from "@/components/ConnectButton";
import { Countdown } from "@/components/Countdown";
import { Ambient, Footer } from "@/components/Layout";
import { NextMove } from "@/components/NextMove";
import { PegGauge } from "@/components/PegGauge";
import { NetworkNote } from "@/components/Status";
import { TaxLadder } from "@/components/TaxLadder";
import { TokenIcon, type TokenSymbol } from "@/components/TokenIcon";
import { Wordmark } from "@/components/brand/Sigil";
import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { HeatSync } from "@/components/fx/HeatSync";
import { toNumber } from "@/lib/format";
import { useProtocol } from "@/lib/hooks";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useMagnetic } from "@/lib/motion/useMagnetic";
import { LOCKUP, NAMES } from "@/lib/protocol";

/**
 * Landing — the pitch, with the live protocol beside it.
 *
 *   1. Hero: "xTOMB" rises letter by letter; the PegGauge sits beside it so the
 *      first thing you see is real state — or an honest "not deployed".
 *   2. Live strip: TWAP · next epoch · sell tax · burned by the tax.
 *   3. Three names: what each is for and the one action it wants from you.
 *   4. The sell tax, drawn.
 *   5. Two states: above the ceiling vs at or below it.
 *   6. Right now: the NextMove card for the live state.
 */

const fmt4 = (n: number) => n.toFixed(4);
const fmt0 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${+n.toFixed(2)}%`;

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const launch = useRef<HTMLAnchorElement>(null);
  useMagnetic(launch, 0.25);

  const p = useProtocol();
  const { market } = p;
  const genesisOpen = p.farms.genesis.phase === "live" || p.farms.genesis.phase === "upcoming";

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const tl = gsap.timeline({ defaults: { ease: EASE.rise } });
      tl.from(".hero-letter", { yPercent: 110, rotate: 6, duration: 1.1, stagger: 0.06, ease: "expo.out" })
        .from(".hero-fade", { autoAlpha: 0, y: 16, duration: 0.8, stagger: 0.08 }, "-=0.7")
        .from(".hero-gauge", { autoAlpha: 0, scale: 0.94, duration: 1.1, ease: EASE.settle }, "-=0.9");

      gsap.utils.toArray<HTMLElement>(".scroll-in").forEach((el) => {
        gsap.from(el, { autoAlpha: 0, y: 40, duration: 0.9, scrollTrigger: { trigger: el, start: "top 88%" } });
      });

      // Token cards: subtle 3D tilt toward the pointer.
      gsap.utils.toArray<HTMLElement>(".tilt").forEach((card) => {
        const rx = gsap.quickTo(card, "rotationX", { duration: 0.6, ease: "power3.out" });
        const ry = gsap.quickTo(card, "rotationY", { duration: 0.6, ease: "power3.out" });
        card.addEventListener("pointermove", (e) => {
          const r = card.getBoundingClientRect();
          ry(((e.clientX - r.left) / r.width - 0.5) * 8);
          rx(-((e.clientY - r.top) / r.height - 0.5) * 8);
        });
        card.addEventListener("pointerleave", () => {
          rx(0);
          ry(0);
        });
      });
    },
    { scope: root },
  );

  const cards: { sym: string; icon: TokenSymbol; tone: string; ring: string; role: string; body: string; want: string; to: string }[] = [
    {
      sym: NAMES.peg,
      icon: "xTOMB",
      tone: "iris-text",
      ring: "hover:border-iris/50",
      role: "The peg",
      body: `Targets 1 unit of the paired asset. Buys are never taxed. Sells pay 12% while the TWAP is under 1.12, 6% from 1.12 and 3% from 1.20 — and the screen shows the exact amount before you sign.`,
      want: "See the sell tax now",
      to: "/swap",
    },
    {
      sym: NAMES.share,
      icon: "xSHARE",
      tone: "spectre-text",
      ring: "hover:border-spectre/50",
      role: "The share",
      body: `Earned by farming wrapped liquidity. When its tax switch is on, selling it pays the same rate out of your proceeds; that tax is later swapped into ${NAMES.peg} and burned.`,
      want: "Farm it with liquidity",
      to: "/farm",
    },
    {
      sym: NAMES.room,
      icon: "xROOM",
      tone: "amethyst-text",
      ring: "hover:border-amethyst/50",
      role: "The staking room",
      body: `Stake the ${NAMES.peg}/${NAMES.share} liquidity token and receive newly minted ${NAMES.peg} every epoch the TWAP is above 1.01. Withdrawals unlock after ${LOCKUP.withdrawEpochs} epochs, rewards after ${LOCKUP.rewardEpochs}.`,
      want: "Stake for expansion",
      to: "/masonry",
    },
  ];

  return (
    <div ref={root} className="relative min-h-screen overflow-x-hidden">
      <Ambient />
      <HeatSync />

      <nav className="relative z-40 mx-auto flex min-h-20 w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 md:px-8" aria-label="Site">
        <Wordmark />
        <div className="ml-auto flex items-center justify-end gap-2 md:gap-3">
          <Link to="/docs" className="btn btn-ghost hidden h-10 sm:inline-flex">
            Docs
          </Link>
          <ChainPicker />
          <ConnectButton compact />
        </div>
      </nav>
      <NetworkNote />

      {/* ===== Hero ===== */}
      <section className="relative z-10 mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-12 px-4 pb-16 pt-8 md:px-8 lg:grid-cols-[1.15fr_1fr] lg:pb-24 lg:pt-14">
        <div>
          <div className="hero-fade mb-6 flex flex-wrap items-center gap-2">
            {p.deployed ? (
              <span className="chip chip-ok">Live · {p.net.network.name}</span>
            ) : (
              <span className="chip chip-warn">Not deployed on this network</span>
            )}
            <span className="chip chip-iris">Uniswap V4 hooks</span>
            <span className="chip">6-hour epochs</span>
          </div>
          <h1 className="whitespace-nowrap font-display text-hero font-bold text-bone" aria-label="xTOMB">
            {"xTOMB".split("").map((ch, i) => (
              <span key={i} className="inline-block overflow-hidden pb-[0.06em] align-bottom">
                <span className={`hero-letter inline-block ${i === 0 ? "iris-text" : ""}`}>{ch}</span>
              </span>
            ))}
          </h1>
          <p className="hero-fade mt-6 max-w-xl text-[18px] leading-relaxed text-bone-dim md:text-[20px]">
            A pegged token that <span className="text-iris-hot">mints only when it trades above its ceiling</span> and taxes sells, never buys. Farm{" "}
            <span className="text-spectre">{NAMES.share}</span> with liquidity, then stake in <span className="text-amethyst">{NAMES.room}</span> to receive each expansion.
          </p>
          <div className="hero-fade mt-9 flex flex-wrap items-center gap-3">
            <Link ref={launch} to={genesisOpen ? "/genesis" : "/dashboard"} className="btn btn-primary h-14 px-8 text-[15px]">
              {genesisOpen ? "Enter Genesis" : "Open the app"} <span aria-hidden>→</span>
            </Link>
            <a href="#states" className="btn btn-ghost h-14 px-6">
              How the peg holds
            </a>
          </div>
        </div>

        <div className="hero-gauge panel panel-raised p-6 md:p-8">
          <PegGauge price={market.twap} phase={market.phase} unit={p.deployed ? p.symbols.quote : undefined} idleLabel={p.deployed ? "No reading yet" : "Not deployed"} />
          <div className="mt-2 grid grid-cols-3 gap-3 border-t border-white/5 pt-5 text-center">
            <div>
              <div className="label mb-1">Target</div>
              <div className="num text-bone">1.00</div>
            </div>
            <div>
              <div className="label mb-1">Mints above</div>
              <div className="num text-bone">{market.ceiling.toFixed(2)}</div>
            </div>
            <div>
              <div className="label mb-1">Tax eases at</div>
              <div className="num text-bone">1.12</div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Live strip ===== */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-4 md:px-8" aria-label="Live readings">
        <div className="scroll-in grid grid-cols-2 overflow-hidden rounded-shard border border-white/[0.07] bg-basalt/70 backdrop-blur md:grid-cols-4">
          {[
            { label: `${NAMES.peg} TWAP`, node: <AnimatedNumber value={market.twap} format={fmt4} />, unit: "per paired asset" },
            { label: "Next epoch", node: <Countdown to={p.epoch.nextAt} done="due" />, unit: "6h epochs" },
            { label: `${NAMES.peg} sell tax`, node: <AnimatedNumber value={p.tax.rateBps !== null ? p.tax.rateBps / 100 : null} format={fmtPct} />, unit: "buys: 0%" },
            { label: "Burned by the tax", node: <AnimatedNumber value={toNumber(p.tax.totals.burned)} format={fmt0} />, unit: NAMES.peg },
          ].map((s, i) => (
            <div key={s.label} className={`p-5 md:p-6 ${i % 2 === 1 ? "border-l border-white/[0.06]" : ""} ${i >= 2 ? "border-t border-white/[0.06] md:border-t-0" : ""} ${i === 2 ? "md:border-l" : ""}`}>
              <div className="label mb-2">{s.label}</div>
              <div className="flex flex-wrap items-baseline gap-2 font-display text-2xl font-semibold tracking-[-0.03em] text-bone md:text-3xl">
                {s.node}
                <span className="font-mono text-[11px] font-normal tracking-wider text-ash">{s.unit}</span>
              </div>
            </div>
          ))}
        </div>
        {!p.deployed && <p className="mt-3 font-mono text-[11px] text-ash">Dashes are honest: nothing is deployed on {p.net.network.name}, so there are no readings to show.</p>}
      </section>

      {/* ===== Three names ===== */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-4 py-24 md:px-8 md:py-32">
        <div className="scroll-in mb-12 max-w-2xl">
          <div className="label mb-3">Three names, three jobs</div>
          <h2 className="text-section text-bone">Each one wants something different from you.</h2>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3" style={{ perspective: 1200 }}>
          {cards.map((t) => (
            <Link key={t.sym} to={t.to} className={`tilt scroll-in panel group flex flex-col gap-5 p-7 transition-colors [transform-style:preserve-3d] ${t.ring}`}>
              <div className="flex items-center justify-between">
                <TokenIcon symbol={t.icon} size={44} />
                <span className="label">{t.role}</span>
              </div>
              <h3 className={`font-display text-4xl font-bold tracking-[-0.04em] ${t.tone}`}>{t.sym}</h3>
              <p className="flex-1 text-[15px] leading-relaxed text-bone-dim">{t.body}</p>
              <span className="flex items-center justify-between border-t border-white/5 pt-4 text-[14px] font-semibold text-bone">
                {t.want}
                <span className="transition-transform group-hover:translate-x-1">→</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* ===== The sell tax ===== */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-4 pb-24 md:px-8 md:pb-32">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
          <div className="scroll-in max-w-xl">
            <div className="label mb-3">The sell tax</div>
            <h2 className="text-section text-bone">Selling costs most when the peg is weakest.</h2>
            <p className="mt-5 text-[16px] leading-relaxed text-bone-dim">
              The peg pool's hook reads the TWAP and takes a share of every {NAMES.peg} sell. It rises the moment the TWAP drops a tier and falls only after seven hours of recovery, so nobody can dip it for one block. The cap is 12%. Buying is always free of it.
            </p>
            <Link to="/swap" className="btn btn-spectre mt-7">
              Check what a sell costs →
            </Link>
          </div>
          <div className="scroll-in panel p-5 md:p-6">
            <TaxLadder price={p.tax.price} rateBps={p.tax.rateBps} enabled={p.tax.enabled} />
          </div>
        </div>
      </section>

      {/* ===== Two states ===== */}
      <section id="states" className="relative z-10 mx-auto w-full max-w-7xl px-4 pb-24 md:px-8 md:pb-32">
        <div className="scroll-in mb-12 max-w-2xl">
          <div className="label mb-3">How the peg holds</div>
          <h2 className="text-section text-bone">Two states. The Treasury does one thing in each.</h2>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <State
            tone="violet"
            title="Above the ceiling"
            range="TWAP > 1.01"
            does={[
              `Each 6-hour epoch the Treasury mints new ${NAMES.peg} — more the further above 1.00, up to a cap that shrinks as supply grows`,
              `The mint goes to ${NAMES.room} stakers, after the fund cuts shown on the dashboard`,
              `New supply pushes the price back toward 1.00`,
            ]}
            you={`Be staked in ${NAMES.room} before the epoch turns. Deposits are untaxed.`}
            cta={{ to: "/masonry", label: `Stake in ${NAMES.room}` }}
          />
          <State
            tone="blue"
            title="At or below the ceiling"
            range="TWAP ≤ 1.01"
            does={[
              `The Treasury mints nothing. It holds no reserve and has nothing else to do`,
              `The 12% sell tax stays on, which makes leaving expensive and buying comparatively cheap`,
              `When its switch is on, ${NAMES.share} sells pay the same rate; that tax buys ${NAMES.peg} and burns it`,
            ]}
            you={`Do not sell into a 12% tax. Farms keep paying ${NAMES.share} regardless.`}
            cta={{ to: "/farm", label: `Farm ${NAMES.share}` }}
          />
        </div>
      </section>

      {/* ===== Right now ===== */}
      <section className="relative z-10 mx-auto w-full max-w-3xl px-4 pb-24 md:px-8">
        <div className="scroll-in">
          <NextMove />
        </div>
      </section>

      <Footer />
    </div>
  );
}

function State({ tone, title, range, does, you, cta }: { tone: "violet" | "blue"; title: string; range: string; does: string[]; you: string; cta: { to: string; label: string } }) {
  const accent = tone === "violet" ? "from-violet/25" : "from-blue/20";
  const dot = tone === "violet" ? "bg-iris" : "bg-spectre";
  const btn = tone === "violet" ? "btn-primary" : "btn-spectre";
  return (
    <div className="scroll-in panel relative overflow-hidden p-7 md:p-8">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${accent} to-transparent opacity-50`} />
      <div className="relative">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-2xl font-bold tracking-[-0.03em] text-bone md:text-3xl">{title}</h3>
          <span className="num text-[12px] text-bone-dim">{range}</span>
        </div>
        <div className="label mb-3">The protocol</div>
        <ul className="mb-7 space-y-3">
          {does.map((d) => (
            <li key={d} className="flex gap-3 text-[15px] text-bone-dim">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              {d}
            </li>
          ))}
        </ul>
        <div className="label mb-2">You</div>
        <p className="mb-6 text-[16px] font-medium text-bone">{you}</p>
        <Link to={cta.to} className={`btn ${btn}`}>
          {cta.label} →
        </Link>
      </div>
    </div>
  );
}
