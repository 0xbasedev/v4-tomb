import type { RefObject } from "react";

import { EASE, gsap, prefersReducedMotion, useGSAP } from "./index";

/**
 * Stagger-reveal every `[data-reveal]` descendant of `scope` on mount.
 *
 * Items rise 18px out of a soft blur — "surfacing from the obsidian". Pass
 * `deps` to replay when the content set changes (e.g. switching tabs).
 */
export function useReveal(scope: RefObject<HTMLElement>, deps: unknown[] = []) {
  useGSAP(
    () => {
      const items = gsap.utils.toArray<HTMLElement>("[data-reveal]", scope.current);
      if (!items.length) return;
      if (prefersReducedMotion()) {
        gsap.set(items, { autoAlpha: 1, y: 0, filter: "none" });
        return;
      }
      gsap.fromTo(
        items,
        { autoAlpha: 0, y: 18, filter: "blur(6px)" },
        {
          autoAlpha: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.75,
          ease: EASE.rise,
          stagger: { each: 0.055, from: "start" },
          clearProps: "filter",
        },
      );
    },
    { scope, dependencies: deps, revertOnUpdate: true },
  );
}
