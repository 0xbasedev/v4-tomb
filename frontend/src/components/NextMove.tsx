import { useRef } from "react";
import { Link } from "react-router-dom";

import { useMagnetic } from "@/lib/motion/useMagnetic";
import { usePlan, type Tone } from "@/lib/plan";

/**
 * NextMove — the interface's opinion, stated plainly.
 *
 * One primary action (big, coloured, magnetic), one alternative (quiet), one
 * thing to avoid (struck, greyed, with the reason). The plan re-computes from
 * the live phase, so as the peg moves the recommended path moves with it and
 * the discouraged path is always named rather than silently hidden.
 */

const BTN: Record<Tone, string> = {
  ember: "btn btn-primary",
  spectre: "btn btn-spectre",
  amethyst: "btn btn-amethyst",
  neutral: "btn",
};
const ACCENT: Record<Tone, string> = {
  ember: "from-ember/25",
  spectre: "from-spectre/20",
  amethyst: "from-amethyst/25",
  neutral: "from-white/10",
};

export function NextMove({ className = "" }: { className?: string }) {
  const plan = usePlan();
  const cta = useRef<HTMLAnchorElement>(null);
  useMagnetic(cta, 0.22);

  return (
    <div data-reveal className={`panel panel-raised flex flex-col overflow-hidden p-0 ${className}`}>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${ACCENT[plan.primary.tone]} via-transparent to-transparent opacity-60`} />
      <div className="relative flex-1 p-6 md:p-7">
        <div className="mb-5 flex items-center gap-2">
          <span className="label text-bone-dim">Your next move</span>
          <span className="h-px flex-1 bg-white/5" />
        </div>
        <p className="mb-6 text-[15px] leading-relaxed text-bone-dim">{plan.headline}</p>

        <h3 className="font-display text-2xl font-semibold tracking-[-0.03em] text-bone md:text-[28px]">
          {plan.primary.title}
        </h3>
        <p className="mt-2 max-w-md text-[14px] leading-relaxed text-bone-dim">{plan.primary.why}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link ref={cta} to={plan.primary.to} className={`${BTN[plan.primary.tone]} h-12 px-6`}>
            {plan.primary.cta}
            <span aria-hidden>→</span>
          </Link>
          <Link to={plan.secondary.to} className="btn btn-ghost h-12" title={plan.secondary.why}>
            or {plan.secondary.title.charAt(0).toLowerCase() + plan.secondary.title.slice(1)}
          </Link>
        </div>
      </div>

      <div className="relative flex items-start gap-3 border-t border-white/5 bg-black/20 px-6 py-4 md:px-7">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-bad/40 text-[11px] text-bad">
          ✕
        </span>
        <div className="text-[13px] leading-snug">
          <span className="text-ash line-through decoration-bad/50">{plan.avoid.title}</span>
          <span className="text-ash-dim"> — {plan.avoid.why}</span>
        </div>
      </div>
    </div>
  );
}
