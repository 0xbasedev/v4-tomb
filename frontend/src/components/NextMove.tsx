import { useRef } from "react";
import { Link } from "react-router-dom";

import { useMagnetic } from "@/lib/motion/useMagnetic";
import { useNextMove } from "@/lib/useNextMove";

/**
 * NextMove — the interface's opinion, stated plainly.
 *
 * One primary action (the gradient button, magnetic), one alternative (quiet),
 * and one thing to avoid (named, with the reason). It is recomputed from live
 * state, so the recommended path moves as the protocol does and the costly
 * path is always named rather than silently hidden.
 */
export function NextMove({ className = "" }: { className?: string }) {
  const plan = useNextMove();
  const cta = useRef<HTMLAnchorElement>(null);
  useMagnetic(cta, 0.22);

  return (
    <div role="region" aria-label="Your next move" data-reveal className={`panel panel-raised flex flex-col overflow-hidden p-0 ${className}`}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet/25 via-transparent to-blue/10 opacity-70" />
      <div className="relative flex-1 p-6 md:p-7">
        <div className="mb-5 flex items-center gap-2">
          <span className="label text-bone-dim">Your next move</span>
          <span className="h-px flex-1 bg-white/5" />
        </div>
        <p className="mb-6 text-[15px] leading-relaxed text-bone-dim">{plan.headline}</p>

        <h3 className="font-display text-2xl font-semibold tracking-[-0.03em] text-bone md:text-[28px]">{plan.primary.title}</h3>
        <p className="mt-2 max-w-md text-[14px] leading-relaxed text-bone-dim">{plan.primary.why}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link ref={cta} to={plan.primary.to} className="btn btn-primary h-auto min-h-12 max-w-full whitespace-normal px-5 py-3 text-center">
            {plan.primary.cta}
            <span aria-hidden>→</span>
          </Link>
          <Link to={plan.secondary.to} className="btn btn-ghost h-auto min-h-12 max-w-full whitespace-normal break-words px-3 py-3 text-center" title={plan.secondary.why}>
            or {plan.secondary.title.charAt(0).toLowerCase() + plan.secondary.title.slice(1)}
          </Link>
        </div>
      </div>

      <div className="relative flex items-start gap-3 border-t border-white/5 bg-black/25 px-5 py-4 md:px-7">
        <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-bad/50 text-[11px] text-bad">
          ×
        </span>
        <p className="text-[13px] leading-relaxed text-bone-dim">
          <span className="font-semibold text-bone">Avoid: {plan.avoid.title}.</span> {plan.avoid.why}
        </p>
      </div>
    </div>
  );
}
