import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { ConnectButton } from "@/components/ConnectButton";
import { Wordmark } from "@/components/brand/Sigil";
import { EmberField } from "@/components/fx/EmberField";
import { HeatSync } from "@/components/fx/HeatSync";
import { PreviewDock } from "@/components/PreviewDock";
import { NetworkNote } from "@/components/Status";
import { useIsAdmin, useProtocol } from "@/lib/hooks";
import { EPOCH_SECONDS } from "@/lib/launch";
import { PHASE_META } from "@/lib/market";
import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";
import { usePlan } from "@/lib/plan";

/**
 * Layout — shared chrome for every route.
 *
 *   - Ambient: heat glow + EmberField behind everything, synced to the TWAP.
 *   - Desktop nav: glass bar, sliding active indicator, live price ticker.
 *     The nav item the current phase recommends wears an ember pip — the
 *     whole app points toward the right move, not just the dashboard.
 *   - Mobile: compact top bar + thumb-reach bottom tab bar.
 *   - Route change: ember progress sweep + scroll reset.
 */

/** Primary nav. The Genesis slot reads "Farm" once Genesis has ended. */
export function useNavItems(): { label: string; to: string; glyph: string }[] {
  const { clock } = useProtocol();
  const ended = clock?.phase === "ended";
  return [
    { label: "Dashboard", to: "/dashboard", glyph: "◎" },
    { label: ended ? "Farm" : "Genesis", to: ended ? "/farm" : "/genesis", glyph: "▲" },
    { label: "Masonry", to: "/masonry", glyph: "◆" },
    { label: "Swap", to: "/swap", glyph: "⇅" },
    { label: "Bonds", to: "/bonds", glyph: "⬡" },
    { label: "Bridge", to: "/bridge", glyph: "⟁" },
  ];
}

export function Layout() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <Ambient />
      <HeatSync />
      <RouteSweep />
      <TopNav />
      <NetworkNote />
      <main id="main" tabIndex={-1} className="relative z-10 flex-1 outline-none">
        <Outlet />
      </main>
      <Footer />
      <MobileTabBar />
      <PreviewDock />
    </div>
  );
}

export function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <div className="bg-heat absolute inset-0 transition-[background] duration-1000" />
      <EmberField className="absolute inset-0" />
    </div>
  );
}

function useRecommendedPath() {
  return usePlan().primary.to.split(/[?#]/)[0];
}

function TopNav() {
  const admin = useIsAdmin();
  const recommended = useRecommendedPath();
  const navItems = useNavItems();
  const location = useLocation();
  const linksRef = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const wrap = linksRef.current;
    const ind = indicator.current;
    if (!wrap || !ind) return;
    const active = wrap.querySelector<HTMLAnchorElement>("a[aria-current='page']");
    if (!active) {
      gsap.to(ind, { autoAlpha: 0, duration: 0.2 });
      return;
    }
    const props = { x: active.offsetLeft, width: active.offsetWidth, autoAlpha: 1 };
    if (prefersReducedMotion() || gsap.getProperty(ind, "opacity") === 0) gsap.set(ind, props);
    else gsap.to(ind, { ...props, duration: 0.55, ease: EASE.snap });
  }, [location.pathname, navItems[1].label]);

  return (
    <nav className="sticky top-0 z-40 border-b border-white/[0.06] bg-void/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 md:px-8">
        <Link to="/" aria-label="xTomb home" className="shrink-0">
          <Wordmark />
        </Link>

        <div ref={linksRef} className="relative hidden items-center gap-1 xl:flex">
          <span
            ref={indicator}
            aria-hidden
            className="absolute left-0 top-1/2 h-9 -translate-y-1/2 rounded-xl border border-white/10 bg-white/[0.06] opacity-0"
          />
          {[...navItems, { label: "Docs", to: "/docs", glyph: "" }].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `relative z-10 flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[14px] font-medium transition-colors 2xl:px-3.5 ${
                  isActive ? "text-bone" : "text-ash hover:text-bone-dim"
                }`
              }
            >
              {item.label}
              {recommended === item.to && (
                <span className="relative flex h-1.5 w-1.5" title="Recommended right now">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember" />
                </span>
              )}
            </NavLink>
          ))}
          {admin.isAdmin &&
            [
              ["/admin", "Admin"],
              ["/wizard", "Wizard"],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `relative z-10 ml-1 shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider ${to === "/wizard" ? "hidden 2xl:block" : ""} ${
                    isActive ? "border-ember/60 text-ember-hot" : "border-white/10 text-ash hover:text-bone-dim"
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
        </div>

        <div className="flex shrink-0 items-center gap-2 md:gap-3">
          <PriceTicker />
          <ConnectButton compact />
        </div>
      </div>
    </nav>
  );
}

function PriceTicker() {
  const p = useProtocol();
  const m = p.market;
  const known = m.twap !== null;
  const meta = PHASE_META[m.phase];
  const left = EPOCH_SECONDS - (p.now % EPOCH_SECONDS);
  const h = Math.floor(left / 3600);
  const mm = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
  return (
    <Link
      to="/dashboard"
      className="hidden h-9 shrink-0 items-center gap-3 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.02] px-3 font-mono text-[12px] transition-colors hover:border-white/15 sm:flex"
      title={`${meta.label} · next six-hour checkpoint in ${h}h ${mm}m`}
    >
      {p.sim && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn">Sim</span>}
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${m.phase === "defense" ? "bg-bad" : m.phase === "stale" ? "bg-warn" : known ? "bg-ember" : "bg-ash-dim"}`} />
        <span className="text-ash">xTOMB</span>
        <span className="text-bone">{known ? `$${m.twap!.toFixed(4)}` : "no TWAP"}</span>
      </span>
      <span className="hidden text-ash-dim md:inline xl:hidden 2xl:inline">|</span>
      <span className="hidden text-ash md:inline xl:hidden 2xl:inline">
        epoch <span className="text-bone-dim">{h}h{mm}</span>
      </span>
    </Link>
  );
}

function MobileTabBar() {
  const recommended = useRecommendedPath();
  const all = useNavItems();
  const admin = useIsAdmin();
  const location = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [location.pathname]);
  // Thumb bar: the four most-used screens; the rest live under "More".
  const navItems = [all[0], all[1], all[3], all[5]];
  const extra = [all[2], all[4], { label: "Docs", to: "/docs", glyph: "§" }, ...(admin.isAdmin ? [{ label: "Admin", to: "/admin", glyph: "⚙" }, { label: "Wizard", to: "/wizard", glyph: "✦" }] : [])];
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-white/[0.07] bg-void/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl xl:hidden"
      aria-label="Primary"
    >
      {more && (
        <div className="absolute inset-x-3 bottom-[calc(100%+8px)] grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-basalt-2/95 p-3 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)]">
          {extra.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `flex h-14 flex-col items-center justify-center gap-1 rounded-xl border text-[12px] ${isActive ? "border-ember/50 text-bone" : "border-white/[0.06] text-ash"}`}
            >
              <span className="text-[16px] leading-none">{item.glyph}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
      <div className="mx-auto grid max-w-md grid-cols-5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                isActive ? "text-bone" : "text-ash"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-ember" />}
                <span className={`text-[17px] leading-none ${isActive ? "text-ember" : ""}`}>{item.glyph}</span>
                {item.label}
                {recommended === item.to && !isActive && (
                  <span className="absolute right-[26%] top-3 h-1.5 w-1.5 animate-breathe rounded-full bg-ember" />
                )}
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className={`relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${more ? "text-bone" : "text-ash"}`}
        >
          <span className="text-[17px] leading-none">⋯</span>
          More
        </button>
      </div>
    </nav>
  );
}

/** Ember line that sweeps across the top on navigation; also resets scroll. */
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
      className="pointer-events-none fixed left-0 top-0 z-[70] h-[2px] w-full bg-gradient-to-r from-ember-deep via-ember to-ember-hot opacity-0 shadow-[0_0_12px_rgba(255,106,43,0.8)]"
    />
  );
}

export function Footer() {
  return (
    <footer className="relative z-10 mt-16 border-t border-white/[0.05] pb-[calc(5rem+env(safe-area-inset-bottom))] xl:pb-0">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex items-center gap-4">
          <Wordmark />
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ash-dim">xTOMB/USDC · xSHARE/USDC on Uniswap v4</span>
        </div>
        <div className="flex flex-wrap items-center gap-5 text-[13px] text-ash">
          <Link to="/docs" className="hover:text-bone">Docs</Link>
          <Link to="/docs#risks" className="hover:text-bone">Risks</Link>
          <Link to="/bridge" className="hover:text-bone">Bridge</Link>
          <span className="font-mono text-[11px] text-ash-dim">merge @ 7e3115f · unaudited</span>
        </div>
      </div>
    </footer>
  );
}
