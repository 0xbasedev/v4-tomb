import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { useNetworkStatus } from "@/lib/hooks";

/** Inline explanation for a disabled action. A disabled control always says why. */
export function Reason({ children, tone = "ash" }: { children: ReactNode; tone?: "ash" | "ok" | "warn" | "bad" }) {
  const c = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ash";
  return (
    <p data-reason className={`mt-2 text-[12px] leading-snug ${c}`}>
      {children}
    </p>
  );
}

/** A small "this is a fixed contract rule, not a live reading" tag. */
export function RuleBadge({ className = "" }: { className?: string }) {
  return (
    <span className={`chip h-6 shrink-0 px-2 text-[10px] ${className}`} title="A constant or constructor default in the contracts — not a live reading">
      Contract rule
    </span>
  );
}

/**
 * Shown in place of live controls when the network in view has no deployment.
 * It never shows sample numbers: an undeployed protocol has no numbers.
 */
export function NotDeployed({ what, children }: { what: string; children?: ReactNode }) {
  const net = useNetworkStatus();
  return (
    <div data-reveal data-testid="not-deployed" className="rounded-2xl border border-dashed border-white/15 bg-black/25 p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="chip chip-warn">Not deployed on this network</span>
        <span className="font-mono text-[11px] text-ash">{net.network.name}</span>
      </div>
      <p className="text-[14px] font-semibold text-bone">{what} is unavailable until a deployment is published.</p>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-bone-dim">
        {children ?? "Nothing on this page is live data. The rules below come from the contracts and stay accurate, but every balance, price and button waits for a deployment."}{" "}
        <Link to="/docs" className="text-iris-hot underline-offset-4 hover:underline">
          Read how it works
        </Link>
        .
      </p>
    </div>
  );
}

/** The network line under the header. role="status" so assistive tech hears changes. */
export function NetworkNote() {
  const net = useNetworkStatus();
  const tone =
    net.status === "unsupported"
      ? "border-bad/40 bg-bad/[0.07] text-bad"
      : !net.deployment
        ? "border-warn/35 bg-warn/[0.06] text-warn"
        : net.status === "ready"
          ? "border-ok/30 bg-ok/[0.05] text-ok"
          : "border-white/10 bg-white/[0.03] text-bone-dim";
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
