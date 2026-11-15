import type { Metadata } from "next";
import Link from "next/link";
import WalletProviders from "@/components/WalletProviders";
import TopBar from "@/components/TopBar";
import RouteAnim from "@/components/RouteAnim";
import { PROGRAM_ID } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "xTOMB — Obsidian Crypt (Solana)",
  description: "Solana xTOMB fork. Devnet only. No program deployed yet — all data simulated.",
};
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/genesis", label: "Genesis" },
  { href: "/swap", label: "Swap" },
  { href: "/bridge", label: "Bridge" },
  { href: "/docs", label: "More" },
];
const MORE = [
  { href: "/farm", label: "Farm" },
  { href: "/masonry", label: "Masonry" },
  { href: "/bonds", label: "Bonds" },
  { href: "/admin", label: "Admin" },
  { href: "/wizard", label: "Launch Wizard" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-crypt text-white antialiased">
        <WalletProviders>
          <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
            <div className="animate-drift absolute -top-24 left-1/4 h-72 w-72 rounded-full bg-ember/15 blur-3xl" />
            <div className="animate-drift absolute bottom-0 right-0 h-72 w-72 rounded-full bg-violetx/10 blur-3xl" />
          </div>
          <TopBar />
          <main className="relative mx-auto w-full max-w-3xl px-4 pb-28 pt-6">
            <RouteAnim>{children}</RouteAnim>
            <footer className="mt-10 border-t border-white/10 pt-4">
              <p className="font-mono text-[11px] leading-relaxed text-dust">
                Devnet only. No program deployed yet — every balance, price and APR on this site is
                simulated. No mainnet, no real funds. Program ID (env): {PROGRAM_ID}
              </p>
              <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {MORE.map((m) => (
                  <Link key={m.href} href={m.href} className="text-xs text-ash underline-offset-2 hover:underline">
                    {m.label}
                  </Link>
                ))}
              </nav>
            </footer>
          </main>
          <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-crypt/95 backdrop-blur">
            <div className="mx-auto grid max-w-3xl grid-cols-5">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="flex flex-col items-center py-3 text-[11px] font-medium text-ash hover:text-bone">
                  {n.label}
                  {n.label === "Bridge" && <span className="font-mono text-[8px] tracking-widest text-cyanx">PLANNED</span>}
                </Link>
              ))}
            </div>
          </nav>
        </WalletProviders>
      </body>
    </html>
  );
}
