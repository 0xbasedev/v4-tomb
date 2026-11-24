import { useEffect } from "react";

import { useProtocol } from "@/lib/hooks";
import { gsap, prefersReducedMotion } from "@/lib/motion";

/** 0 (well under the ceiling) … 1 (well above). 0.5 when there is no reading. */
function heatFor(twap: number | null, ceiling: number): number {
  if (twap === null) return 0.5;
  return Math.min(1, Math.max(0, 0.5 + (twap - ceiling) * 2.5));
}

/**
 * Tweens the global `--heat` custom property toward the live TWAP so every
 * heat-aware surface (GlowField, panel glints, the ground glow) shifts
 * together over ~2s instead of jumping.
 */
export function HeatSync() {
  const { market } = useProtocol();
  const heat = heatFor(market.twap, market.ceiling);

  useEffect(() => {
    const root = document.documentElement;
    if (prefersReducedMotion()) {
      root.style.setProperty("--heat", heat.toFixed(3));
      return;
    }
    const current = parseFloat(getComputedStyle(root).getPropertyValue("--heat")) || 0.5;
    const o = { h: current };
    const t = gsap.to(o, {
      h: heat,
      duration: 2,
      ease: "sine.inOut",
      onUpdate: () => root.style.setProperty("--heat", o.h.toFixed(3)),
    });
    return () => {
      t.kill();
    };
  }, [heat]);

  return null;
}
