import { useRef, type ReactNode, type RefObject } from "react";

import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/motion";

/**
 * Docs kit — the shared frame every Docs section uses: a numbered header, a
 * short scannable column of facts, and an interactive visual. Visuals animate
 * once when they scroll into view (`useEnter`).
 */

/** Run `build` once when `ref` scrolls into view (immediately if reduced motion). */
export function useEnter(ref: RefObject<HTMLElement | SVGElement | null>, build: (tl: gsap.core.Timeline) => void, deps: unknown[] = []) {
  useGSAP(
    () => {
      if (!ref.current) return;
      const tl = gsap.timeline({ paused: true });
      build(tl);
      if (prefersReducedMotion()) {
        tl.progress(1);
        return;
      }
      const st = ScrollTrigger.create({ trigger: ref.current as Element, start: "top 85%", once: true, onEnter: () => tl.play() });
      return () => st.kill();
    },
    { scope: ref as RefObject<HTMLElement>, dependencies: deps },
  );
}

export function DocSection({
  id,
  numeral,
  title,
  lede,
  facts,
  children,
  wide,
}: {
  id: string;
  numeral: string;
  title: string;
  lede: ReactNode;
  facts?: ReactNode[];
  children: ReactNode;
  /** Visual spans the full width under the text instead of beside it. */
  wide?: boolean;
}) {
  return (
    <section id={id} data-reveal className="panel scroll-mt-24 overflow-hidden p-5 md:p-7">
      <div className={`grid grid-cols-1 gap-6 ${wide ? "" : "xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:items-start"}`}>
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-3">
            <span className="font-mono text-[11px] tracking-[0.2em] text-ember">{numeral}</span>
            <span className="h-px flex-1 bg-gradient-to-r from-ember/40 to-transparent" />
          </div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-bone md:text-[28px]">{title}</h2>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-bone-dim">{lede}</p>
          {facts && facts.length > 0 && (
            <ul className={`mt-4 grid gap-2 ${wide ? "sm:grid-cols-2 lg:grid-cols-3" : ""}`}>
              {facts.map((f, i) => (
                <li key={i} className="flex gap-2.5 text-[13.5px] leading-relaxed text-bone-dim">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

/** A labelled range slider in the house style. */
export function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
  accent = "#ff6a2b",
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  display: string;
  accent?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <span className="num text-[14px] text-bone">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: accent }}
      />
    </div>
  );
}

/** Segmented control (no native select anywhere). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  return (
    <div ref={wrap} className="inline-flex flex-wrap gap-1 rounded-xl border border-white/[0.07] bg-black/30 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
            o.id === value ? "bg-ember/15 text-ember-hot" : "text-ash hover:bg-white/5 hover:text-bone"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Frame for a visual: dark well with an optional caption. */
export function Stage({ children, caption, className = "" }: { children: ReactNode; caption?: ReactNode; className?: string }) {
  return (
    <figure className={`rounded-2xl border border-white/[0.06] bg-black/30 p-4 md:p-5 ${className}`}>
      {children}
      {caption && <figcaption className="mt-3 text-[12px] leading-relaxed text-ash">{caption}</figcaption>}
    </figure>
  );
}
