import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/**
 * Motion primitives. Every animation in the app goes through GSAP so timing,
 * easing and reduced-motion handling live in one place.
 *
 * House eases:
 *   rise   — power3.out    page + card entrances
 *   settle — expo.out      numbers, gauges, anything that "lands" on a value
 *   snap   — back.out(1.6) small toggles (flip, tabs, chips)
 *   needle — elastic.out(1, 0.55) the peg gauge needle only
 */
export const EASE = {
  rise: "power3.out",
  settle: "expo.out",
  snap: "back.out(1.6)",
  needle: "elastic.out(1, 0.55)",
} as const;

gsap.defaults({ ease: EASE.rise, duration: 0.6 });

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export { gsap, ScrollTrigger, useGSAP };
