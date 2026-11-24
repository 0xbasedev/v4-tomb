import { useEffect, useRef } from "react";

import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";

interface AnimatedNumberProps {
  /** Target value. `null` renders the placeholder. */
  value: number | null;
  /** Formatter applied every frame. */
  format?: (n: number) => string;
  /** Rendered when value is null (not yet loaded / unknown). */
  placeholder?: string;
  duration?: number;
  className?: string;
}

const defaultFormat = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });

/**
 * Tween a number to its new value instead of snapping. Counting motion makes
 * every refresh legible — you see the direction a balance or price moved, not
 * just its new digits. Writes textContent directly (no React re-render per
 * frame).
 */
export function AnimatedNumber({
  value,
  format = defaultFormat,
  placeholder = "—",
  duration = 1.1,
  className = "",
}: AnimatedNumberProps) {
  const el = useRef<HTMLSpanElement>(null);
  const state = useRef({ n: 0, initialised: false });
  const fmt = useRef(format);
  fmt.current = format;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (value === null || !isFinite(value)) {
      node.textContent = placeholder;
      state.current.initialised = false;
      return;
    }
    if (prefersReducedMotion()) {
      state.current.n = value;
      node.textContent = fmt.current(value);
      return;
    }
    // First paint counts up from zero; later updates glide from the old value.
    if (!state.current.initialised) {
      state.current.n = 0;
      state.current.initialised = true;
    }
    const tween = gsap.to(state.current, {
      n: value,
      duration,
      ease: EASE.settle,
      onUpdate: () => {
        node.textContent = fmt.current(state.current.n);
      },
    });
    return () => {
      tween.kill();
    };
  }, [value, duration, placeholder]);

  return (
    <span ref={el} className={`num ${className}`}>
      {value === null ? placeholder : format(0)}
    </span>
  );
}
