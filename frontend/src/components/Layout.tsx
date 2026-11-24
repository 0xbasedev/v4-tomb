import { useEffect, useRef, type CSSProperties } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { ChainPicker } from "@/components/ChainPicker";
import { ConnectButton } from "@/components/ConnectButton";
import { NetworkNote } from "@/components/Status";
import { Wordmark } from "@/components/brand/Sigil";
import { GlowField } from "@/components/fx/GlowField";
import { HeatSync } from "@/components/fx/HeatSync";
import { formatBps } from "@/lib/format";
import { useProtocol } from "@/lib/hooks";
import { gsap, prefersReducedMotion } from "@/lib/motion";
import { NAMES } from "@/lib/protocol";
import { useNextMove } from "@/lib/useNextMove";

/** Primary nav: the five places a user acts. xROOM is the Masonry's on-screen name. */
export const NAV_ITEMS: { label: string; to: string; glyph: string; accent: string }[] = [
  { label: "Dashboard", to: "/dashboard", glyph: "◎", accent: "165 180 252" },
  { label: "Genesis", to: "/genesis", glyph: "▲", accent: "196 181 253" },
  { label: "Farm", to: "/farm", glyph: "◈", accent: "147 197 253" },
  { label: NAMES.room, to: "/masonry", glyph: "◆", accent: "180 140 255" },
  { label: "Swap", to: "/swap", glyph: "⇅", accent: "96 165 250" },
];

export function Layout() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[90] focus:rounded-lg focus:bg-basalt-2 focus:px-3 focus:py-2 focus:text-bone">
        Skip to content
      </a>
      <Ambient />
      <HeatSync />
      <RouteSweep />
      <TopNav />
      <NetworkNote />
      <main id="main" tabIndex={-1} className="relative z-10 flex-1 outline-none">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

export function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <div className="bg-heat absolute inset-0 transition-[background] duration-1000" />
      <GlowField className="absolute inset-0" />
    </div>
  );
}

function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-void/90 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-3 py-2.5 sm:px-6 md:px-8">
        <Link to="/" aria-label="xTOMB home" className="shrink-0">
          <Wordmark />
        </Link>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-2.5">
          <div className="order-last flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[11.5px] sm:order-none">
            <Link to="/docs" className="px-1.5 text-ash transition-colors hover:text-bone">
              Docs
            </Link>
            <span className="text-ash-dim">·</span>
            <Link to="/admin" className="px-1.5 text-ash transition-colors hover:text-bone">
              Status
            </Link>
          </div>
          <Ticker />
          <ChainPicker />
          <ConnectButton compact />
        </div>
      </div>
      <PrimaryNav />
    </header>
  );
}

/** Live header readout. With no deployment every figure is a dash — never a sample. */
export function Ticker() {
  const p = useProtocol();
  const item = (name: string, value: string, dot: string) => (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-ash">{name}</span>
      <span className="text-bone">{value}</span>
    </span>
  );
  return (
    <Link
      to="/dashboard"
      data-testid="ticker"
      className="hidden h-9 shrink-0 items-center gap-3 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.02] px-3 font-mono text-[12px] transition-colors hover:border-white/15 lg:flex"
      title={p.deployed ? "xTOMB TWAP · xSHARE spot · sell tax · epoch" : "Not deployed on this network — no live readings"}
    >
      {item(NAMES.peg, p.market.twap !== null ? p.market.twap.toFixed(4) : "—", p.market.twap !== null ? "bg-iris" : "bg-ash-dim")}
      <span className="text-ash-dim">|</span>
      {item(NAMES.share, p.market.shareSpot !== null ? p.market.shareSpot.toPrecision(4) : "—", p.market.shareSpot !== null ? "bg-spectre" : "bg-ash-dim")}
      <span className="text-ash-dim">|</span>
      {item("Sell tax", p.tax.enabled === false ? "off" : formatBps(p.tax.rateBps), p.tax.rateBps !== null ? "bg-amethyst" : "bg-ash-dim")}
      <span className="text-ash-dim">|</span>
      <span className="text-ash">
        Epoch <span className="text-bone">{p.epoch.current ?? "—"}</span>
      </span>
    </Link>
  );
}

function PrimaryNav() {
  const recommended = useNextMove().primary.to.split(/[?#]/)[0];
  return (
    <nav className="border-t border-white/[0.07] bg-black/20 py-1" aria-label="Primary">
      <div className="mx-auto grid max-w-2xl grid-cols-5 gap-1 px-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={{ "--nav-accent": item.accent } as CSSProperties}
            className="primary-nav-item relative flex h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-medium transition-colors"
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-current" />}
                <span aria-hidden="true" className="text-[17px] leading-none">
                  {item.glyph}
                </span>
                <span className="truncate">{item.label}</span>
                {recommended === item.to && !isActive && (
                  <span title="Suggested next" className="absolute right-2 top-2 h-1.5 w-1.5 animate-breathe rounded-full bg-current sm:right-[24%]" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/** A thin gradient bar sweeps across the top on every route change. */
function RouteSweep() {
  const location = useLocation();
  const bar = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    if (first.current) {
      first.current = false;
      return;
    }
    if (!bar.current || prefersReducedMotion()) return;
    gsap.fromTo(
      bar.current,
      { scaleX: 0, autoAlpha: 1, transformOrigin: "left" },
      { scaleX: 1, duration: 0.6, ease: "power2.inOut", onComplete: () => void gsap.to(bar.current, { autoAlpha: 0, duration: 0.3 }) },
    );
  }, [location.pathname]);

  return (
    <div
      ref={bar}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[70] h-[2px] w-full bg-brand opacity-0 shadow-[0_0_12px_rgb(var(--indigo-rgb)/0.8)]"
    />
  );
}

export function Footer() {
  return (
    <footer className="relative z-10 mt-16 border-t border-white/[0.05] pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex items-center gap-4">
          <Wordmark />
          <span className="font-mono text-[11px] tracking-[0.14em] text-ash">
            {NAMES.peg} · {NAMES.share} · {NAMES.room}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-ash">
          <Link to="/docs" className="rounded-full border border-white/[0.08] px-3 py-1.5 text-[12px] hover:border-iris/40 hover:text-iris-hot">
            Docs
          </Link>
          <Link to="/docs#risks" className="rounded-full border border-white/[0.08] px-3 py-1.5 text-[12px] hover:border-iris/40 hover:text-iris-hot">
            Risks
          </Link>
        </div>
      </div>
    </footer>
  );
}
