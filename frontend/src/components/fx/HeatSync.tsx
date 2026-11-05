import { useEffect } from "react";

import { useProtocol } from "@/lib/hooks";
import { gsap } from "@/lib/motion";
import { heatFor } from "@/lib/market";

/**
 * Tweens the global `--heat` custom property toward the live TWAP so every
 * heat-aware surface (EmberField, panel glints, the ground glow) warms and
 * cools together over ~2s instead of jumping.
 */
export function HeatSync() {
  const { market } = useProtocol();
  const heat = heatFor(market.twap);

  useEffect(() => {
    const root = document.documentElement;
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
