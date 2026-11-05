import { useRef } from "react";
import { Link } from "react-router-dom";

import { ConnectButton } from "@/components/ConnectButton";
import { Wordmark } from "@/components/brand/Sigil";
import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { HeatSync } from "@/components/fx/HeatSync";
import { Ambient, Footer } from "@/components/Layout";
import { NextMove } from "@/components/NextMove";
import { PegGauge } from "@/components/PegGauge";
import { PreviewDock } from "@/components/PreviewDock";
import { TokenIcon } from "@/components/TokenIcon";
import { NetworkNote, SimBadge } from "@/components/Status";
import { useProtocol } from "@/lib/hooks";
import { DEFENSE, EPOCH_SECONDS, EXPANSION, FIRE, SQUARE_SUPPLY, pct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useMagnetic } from "@/lib/motion/useMagnetic";
import { GenesisStrip } from "@/components/GenesisStrip";

/**
 * Landing — the pitch, with the live protocol on the right.
 *
 *   1. Hero: "xTOMB" rises out of the obsidian letter by letter; the live
 *      PegGauge sits beside it so the first thing you see is real state.
 *   2. Live strip: TWAP · next checkpoint · Fire Tax now · Genesis burn.
 *   3. Three tokens: what each is for, and the one action it wants from you.
 *   4. Two regimes: above peg vs below peg — what the protocol does and what
 *      you should do. This is the whole mechanism in one comparison.
 *   5. Right now: the NextMove card for the live phase.
 */

const fmt0 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmt4 = (n: number) => n.toFixed(4);
const fmtPct = (n: number) => `${+n.toFixed(2)}%`;

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const launch = useRef<HTMLAnchorElement>(null);
  useMagnetic(launch, 0.25);

  const p = useProtocol();
  const market = p.market;
  const secondsUntilNextEpoch = EPOCH_SECONDS - (p.now % EPOCH_SECONDS);
  const genesisLive = p.clock?.phase === "day1" || p.clock?.phase === "lp" || p.clock?.phase === "pre";
  const tax = p.taxFor("xTOMB", 1_000).rateBps;

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const tl = gsap.timeline({ defaults: { ease: EASE.rise } });
      tl.from(".hero-letter", { yPercent: 110, rotate: 6, duration: 1.1, stagger: 0.06, ease: "expo.out" })
        .from(".hero-fade", { autoAlpha: 0, y: 16, duration: 0.8, stagger: 0.08 }, "-=0.7")
        .from(".hero-gauge", { autoAlpha: 0, scale: 0.94, duration: 1.1, ease: EASE.settle }, "-=0.9");

      gsap.utils.toArray<HTMLElement>(".scroll-in").forEach((el) => {
        gsap.from(el, {
          autoAlpha: 0,
          y: 40,
          duration: 0.9,
          scrollTrigger: { trigger: el, start: "top 85%" },
        });
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

  const h = Math.floor(secondsUntilNextEpoch / 3600);
  const m = Math.floor((secondsUntilNextEpoch % 3600) / 60);

  return (
    <div ref={root} className="relative min-h-screen overflow-x-hidden">
      <Ambient />
      <HeatSync />

      {/* ===== Nav ===== */}
      <nav className="relative z-20 mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-4 md:px-8">
        <Wordmark />
        <div className="flex items-center gap-2 md:gap-3">
          <Link to="/docs" className="hidden px-3 text-[14px] text-ash transition-colors hover:text-bone sm:block">
            Docs
          </Link>
          <Link to="/dashboard" className="btn btn-ghost hidden h-10 sm:inline-flex">
            Open app
          </Link>
          <ConnectButton compact />
        </div>
      </nav>
      <NetworkNote />

      {/* ===== Hero ===== */}
      <section className="relative z-10 mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-12 px-4 pb-16 pt-8 md:px-8 lg:grid-cols-[1.15fr_1fr] lg:pb-24 lg:pt-14">
        <div>
          <div className="hero-fade mb-6 flex flex-wrap items-center gap-2">
            <span className="chip chip-ember">$1 USDC peg</span>
            <span className="chip">Uniswap v4</span>
            <span className="chip">xTOMB/USDC · xSHARE/USDC</span>
          </div>
          <h1 className="whitespace-nowrap text-hero font-display font-bold text-bone" aria-label="xTOMB">
            {"xTOMB".split("").map((ch, i) => (
              <span key={i} className="inline-block overflow-hidden pb-[0.06em] align-bottom">
                <span className={`hero-letter inline-block ${i === 0 ? "ember-text" : ""}`}>{ch}</span>
              </span>
            ))}
          </h1>
          <p className="hero-fade mt-6 max-w-xl text-[18px] leading-relaxed text-bone-dim md:text-[20px]">
            xTOMB targets $1 in USDC. Every official sell pays one <span className="text-ember-hot">Fire Tax</span> — 1% at peg,
            up to 12% under pressure — and xSHARE's sell tax funds <span className="text-spectre">protocol liquidity</span> or, in
            Critical Defense, <span className="text-bad">buys and burns xTOMB</span>. Genesis opens the first path in.
          </p>
          <div className="hero-fade mt-9 flex flex-wrap items-center gap-3">
            <Link ref={launch} to={genesisLive ? "/genesis" : "/dashboard"} className="btn btn-primary h-14 px-8 text-[15px]">
              {genesisLive ? "Enter Genesis" : "Launch app"} <span aria-hidden>→</span>
            </Link>
            <a href="#regimes" className="btn btn-ghost h-14 px-6">
              How the peg holds
            </a>
          </div>
        </div>

        <div className="hero-gauge panel panel-raised p-6 md:p-8">
          {p.sim && (
            <div className="mb-2 flex justify-end">
              <SimBadge />
            </div>
          )}
          <PegGauge price={market.twap ?? 0} phase={market.phase} simulated={p.sim} idleLabel="No valid TWAP" />
          <div className="mt-2 grid grid-cols-3 gap-3 border-t border-white/5 pt-5 text-center">
            <div>
              <div className="label mb-1">Target</div>
              <div className="num text-bone">$1.00</div>
            </div>
            <div>
              <div className="label mb-1">Expansion gate</div>
              <div className="num text-bone">&gt;${EXPANSION.gate.toFixed(2)}</div>
            </div>
            <div>
              <div className="label mb-1">Defense</div>
              <div className="num text-bone">≤${DEFENSE.enterAt.toFixed(2)}</div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Genesis (while it runs) ===== */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-4 pb-5 md:px-8">
        <GenesisStrip />
      </section>

      {/* ===== Live strip ===== */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-4 md:px-8">
        <div className="scroll-in grid grid-cols-2 overflow-hidden rounded-shard border border-white/[0.07] bg-basalt/70 backdrop-blur md:grid-cols-4">
          {[
            { label: p.sim ? "xTOMB TWAP · sim" : "xTOMB TWAP", node: <AnimatedNumber value={market.twap} format={fmt4} />, unit: "USD" },
            { label: "Next checkpoint", node: <span className="num">{h}h {String(m).padStart(2, "0")}m</span>, unit: "6h epochs" },
            { label: p.sim ? "xTOMB sell tax · sim" : "xTOMB sell tax", node: <AnimatedNumber value={tax !== null ? tax / 100 : null} format={fmtPct} />, unit: "one rate" },
            { label: p.sim ? "Burned in Genesis · sim" : "Burned in Genesis", node: <AnimatedNumber value={p.hooks.xTOMB.genesisBurned} format={fmt0} />, unit: "xTOMB" },
          ].map((s, i) => (
            <div key={s.label} className={`p-5 md:p-6 ${i % 2 === 1 ? "border-l border-white/[0.06]" : ""} ${i >= 2 ? "border-t border-white/[0.06] md:border-t-0" : ""} ${i === 2 ? "md:border-l" : ""}`}>
              <div className="label mb-2">{s.label}</div>
              <div className="flex items-baseline gap-2 font-display text-2xl font-semibold tracking-[-0.03em] text-bone md:text-3xl">
                {s.node}
                <span className="font-mono text-[11px] font-normal tracking-wider text-ash">{s.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Three tokens ===== */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-4 py-24 md:px-8 md:py-32">
        <div className="scroll-in mb-12 max-w-2xl">
          <div className="label mb-3">Three tokens, three jobs</div>
          <h2 className="text-section text-bone">Each one wants something different from you.</h2>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3" style={{ perspective: 1200 }}>
          {[
            {
              sym: "xTOMB",
              tone: "ember-text",
              ring: "hover:border-ember/40",
              role: "The peg",
              body: `Targets $1 in USDC on the official xTOMB/USDC pool. Sells pay one Fire Tax (${pct(FIRE.baselineBps)}–${pct(FIRE.capBps)}); during Genesis the whole tax is burned. Buys and transfers are never taxed.`,
              want: "Swap or add liquidity",
              to: "/swap",
            },
            {
              sym: "xSHARE",
              tone: "spectre-text",
              ring: "hover:border-spectre/40",
              role: "The claim",
              body: `Capped at ${SQUARE_SUPPLY.cap.toLocaleString()} (configured). Its sell tax normally funds 12% protocol LP, 20% USDC reserve and 68% xSHARE reserve; in Critical Defense 100% buys and burns xTOMB.`,
              want: "See the routing",
              to: "/dashboard",
            },
            {
              sym: "xBOND",
              tone: "amethyst-text",
              ring: "hover:border-amethyst/40",
              role: "The defense",
              body: "A planned bond office. Issuance and redemption stay disabled until a verified bond contract exposes both actions — no rates or returns are promised here.",
              want: "Preview the bond office",
              to: "/bonds",
            },
          ].map((t) => (
            <Link
              key={t.sym}
              to={t.to}
              className={`tilt scroll-in panel group flex flex-col gap-5 p-7 transition-colors [transform-style:preserve-3d] ${t.ring}`}
            >
              <div className="flex items-center justify-between">
                <TokenIcon symbol={t.sym} size={44} />
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

      {/* ===== Two regimes ===== */}
      <section id="regimes" className="relative z-10 mx-auto w-full max-w-7xl px-4 pb-24 md:px-8 md:pb-32">
        <div className="scroll-in mb-12 max-w-2xl">
          <div className="label mb-3">How the peg holds</div>
          <h2 className="text-section text-bone">Two regimes. The protocol pays you to be on the right side of each.</h2>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Regime
            tone="ember"
            title="Above the gate"
            range={`fresh TWAP > $${EXPANSION.gate.toFixed(2)}`}
            does={[
              `Planned: an eligible six-hour epoch can mint up to ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB`,
              "Only a fresh validated TWAP counts — never spot, never catch-up",
              `Sells pay the ${pct(FIRE.baselineBps)} baseline unless a recovery floor is still decaying`,
            ]}
            you="Provide official liquidity. Treasury mint wiring is still open, so expansion is shown as planned."
            cta={{ to: "/swap?mode=liquidity", label: "Add liquidity" }}
          />
          <Regime
            tone="amethyst"
            title="Below peg"
            range="TWAP < $1.00"
            does={[
              `The Fire Tax target rises toward ${pct(FIRE.capBps)} at $${FIRE.fullTaxAt.toFixed(2)} and decays back over seven hours`,
              `At a fresh TWAP ≤ $${DEFENSE.enterAt.toFixed(2)}, Critical Defense sends 100% of new xSHARE tax to xTOMB buy-and-burn`,
              `Defense ends only after ${DEFENSE.recoveryEpochs} consecutive checkpoints above $${DEFENSE.exitAbove.toFixed(2)}`,
            ]}
            you="Don't sell into a high tax. The interface shows the one rate before you sign."
            cta={{ to: "/swap", label: "Check the Fire Tax" }}
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
      <PreviewDock />
    </div>
  );
}

function Regime({
  tone,
  title,
  range,
  does,
  you,
  cta,
}: {
  tone: "ember" | "amethyst";
  title: string;
  range: string;
  does: string[];
  you: string;
  cta: { to: string; label: string };
}) {
  const accent = tone === "ember" ? "from-ember/20" : "from-amethyst/20";
  const dot = tone === "ember" ? "bg-ember" : "bg-amethyst";
  const btn = tone === "ember" ? "btn-primary" : "btn-amethyst";
  return (
    <div className="scroll-in panel relative overflow-hidden p-7 md:p-8">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${accent} to-transparent opacity-50`} />
      <div className="relative">
        <div className="mb-6 flex items-center justify-between">
          <h3 className="font-display text-3xl font-bold tracking-[-0.03em] text-bone">{title}</h3>
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
