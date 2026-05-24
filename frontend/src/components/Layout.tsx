import { Link, NavLink, Outlet } from "react-router-dom";

import { ConnectButton } from "@/components/ConnectButton";
import { RuleTrio } from "@/components/RuleTrio";
import { useIsAdmin } from "@/lib/hooks";

/**
 * Layout — shared chrome across every route. Top nav with brand mark + section
 * links + ConnectButton, footer with closing rule trio and house signature.
 *
 * The Landing page does NOT use Layout — it has its own full-bleed nav and footer.
 * Every other route renders inside this shell.
 */

const NAV_ITEMS: { label: string; to: string }[] = [
  { label: "The Ledger", to: "/dashboard" },
  { label: "The Club", to: "/club" },
  { label: "The Vault", to: "/vault" },
  { label: "Trust Notes", to: "/notes" },
  { label: "Exchange", to: "/swap" },
  { label: "Docs", to: "/docs" },
];

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col bg-deco-ground">
      <Nav />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  const admin = useIsAdmin();
  return (
    <nav className="sticky top-0 z-30 border-b border-deco-gold/30 bg-deco-ground/95 backdrop-blur supports-[backdrop-filter]:bg-deco-ground/80">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-4 md:gap-6 md:px-12 md:py-5">
        <Link to="/" className="flex shrink-0 items-baseline gap-3">
          <span
            className="font-display text-2xl font-bold text-deco-gold md:text-3xl"
            style={{ letterSpacing: "0.15em" }}
          >
            OM
          </span>
          <span className="label-deco hidden text-deco-gold-dark lg:inline">
            The Trust · Base
          </span>
        </Link>

        {/* Nav links — horizontal scroll on narrow viewports so all routes
            stay reachable on mobile, instead of being hidden entirely. */}
        <div className="flex flex-1 items-center gap-5 overflow-x-auto md:gap-6 md:overflow-visible">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `label-deco shrink-0 transition-colors ${
                  isActive
                    ? "text-deco-gold-light"
                    : "text-deco-gold-dark hover:text-deco-gold"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          {admin.isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `label-deco shrink-0 border px-2 py-1 transition-colors ${
                  isActive
                    ? "border-deco-gold bg-deco-gold/10 text-deco-gold-light"
                    : "border-deco-gold/40 text-deco-gold hover:border-deco-gold"
                }`
              }
            >
              Admin
            </NavLink>
          )}
        </div>

        <div className="shrink-0">
          <ConnectButton />
        </div>
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="relative px-6 py-12 md:px-12 md:py-16">
      <div className="mx-auto max-w-4xl">
        <RuleTrio className="mb-8" />
        <div className="text-center">
          <p
            className="font-display text-xl italic text-deco-ivory md:text-2xl"
            style={{ letterSpacing: "0.1em" }}
          >
            Wealth Engineered with Precision.
          </p>
          <div
            className="mt-3 font-ornament text-sm text-deco-gold"
            style={{ letterSpacing: "0.3em" }}
          >
            MMXXVI · The House of Old Money
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-5">
            <Link to="/dashboard" className="label-deco hover:text-deco-gold-light">
              The Ledger
            </Link>
            <span className="text-deco-gold-dark">·</span>
            <Link to="/docs" className="label-deco hover:text-deco-gold-light">
              The Mechanism
            </Link>
            <span className="text-deco-gold-dark">·</span>
            <Link to="/club" className="label-deco hover:text-deco-gold-light">
              The Club
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
