import { useEffect, type RefObject } from "react";

import { EASE, gsap, prefersReducedMotion } from "./index";

/**
 * Magnetic pull toward the cursor — reserved for the ONE action we want you to
 * take on a screen. Ghost/danger buttons never get it, so the recommended path
 * literally reaches for your pointer and the discouraged one sits still.
 */
export function useMagnetic(ref: RefObject<HTMLElement>, strength = 0.28) {
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || window.matchMedia("(pointer: coarse)").matches) return;

    const xTo = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3.out" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3.out" });

    function move(e: PointerEvent) {
      if (!el || (el as HTMLButtonElement).disabled) return;
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * strength);
      yTo((e.clientY - (r.top + r.height / 2)) * strength);
    }
    function leave() {
      gsap.to(el, { x: 0, y: 0, duration: 0.7, ease: EASE.needle });
    }
    function down() {
      gsap.to(el, { scale: 0.97, duration: 0.12, ease: "power2.out" });
    }
    function up() {
      gsap.to(el, { scale: 1, duration: 0.4, ease: EASE.snap });
    }

    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      gsap.killTweensOf(el);
    };
  }, [ref, strength]);
}
