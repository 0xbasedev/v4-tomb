import type { ReactNode } from "react";

import { useNetworkStatus } from "@/lib/hooks";

/**
 * Honesty labels, used everywhere the UI shows something that isn't a live,
 * bound contract value:
 *   Simulated  sample data from Preview
 *   Pending    the screen exists but the backend has no binding yet
 *   Planned    a roadmap item, not in the contracts
 */
export function SimBadge({ className = "", label = "Simulated" }: { className?: string; label?: string }) {
  return (
    <span className={`chip chip-warn h-6 shrink-0 px-2 text-[10px] uppercase tracking-wider ${className}`} title="Sample data — no verified deployment yet">
      {label}
    </span>
  );
}

export function PendingBadge({ className = "", label = "Pending backend" }: { className?: string; label?: string }) {
  return (
    <span className={`chip h-6 shrink-0 border-white/15 px-2 text-[10px] uppercase tracking-wider text-ash ${className}`} title="No contract binding in the merge-branch deployment yet">
      {label}
    </span>
  );
}

export function PlannedBadge({ className = "", label = "Planned" }: { className?: string; label?: string }) {
  return (
    <span className={`chip chip-amethyst h-6 shrink-0 px-2 text-[10px] uppercase tracking-wider ${className}`} title="Roadmap — not in the contracts yet">
      {label}
    </span>
  );
}

/** Inline explanation for a disabled action. */
export function Reason({ children, tone = "ash" }: { children: ReactNode; tone?: "ash" | "warn" | "bad" }) {
  const c = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ash";
  return <p className={`mt-2 text-[12px] leading-snug ${c}`}>{children}</p>;
}

/** A panel that says what's missing instead of showing an empty or fake control. */
export function PendingPanel({ title, children, badge = "pending" }: { title: string; children: ReactNode; badge?: "pending" | "planned" }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/12 bg-black/20 p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-bone">{title}</span>
        {badge === "pending" ? <PendingBadge /> : <PlannedBadge />}
      </div>
      <div className="text-[12.5px] leading-relaxed text-bone-dim">{children}</div>
    </div>
  );
}

/** The network note under the header — role="status" so assistive tech hears changes. */
export function NetworkNote() {
  const net = useNetworkStatus();
  const tone =
    net.status === "ready" ? "border-ok/30 bg-ok/[0.05] text-ok" : net.walletConnected && !net.walletChainSupported ? "border-bad/35 bg-bad/[0.06] text-bad" : "border-warn/30 bg-warn/[0.05] text-warn";
  return (
    <div className="relative z-30 border-b border-white/[0.05] bg-void/60 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-2 md:px-8">
        <span role="status" aria-live="polite" data-testid="network-note" className={`flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-1 text-[12px] leading-snug ${tone}`}>
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
          <span className="min-w-0">{net.message}</span>
        </span>
      </div>
    </div>
  );
}
