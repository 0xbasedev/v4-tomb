import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";

/**
 * Modal — the one dialog shell every flow uses (token picker, claim, compound,
 * pass mint). Sheet on mobile, centred card on desktop.
 *
 * Mount it to open; it portals to <body> (so a transformed or clipped parent
 * card can't trap it), animates in, traps scroll, closes on Esc / backdrop,
 * and animates out before calling `onClose`. Children may be a render
 * function receiving `close`, so a flow can dismiss itself after success
 * with the same exit animation.
 */
export function Modal({
  kicker,
  title,
  onClose,
  children,
  width = 560,
  tone = "ember",
}: {
  kicker?: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
  tone?: "ember" | "spectre" | "amethyst" | "ok";
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  function close() {
    if (closing.current) return;
    closing.current = true;
    if (prefersReducedMotion() || !panel.current) return onClose();
    gsap.to(panel.current, { y: 20, autoAlpha: 0, scale: 0.985, duration: 0.2, ease: "power2.in" });
    gsap.to(backdrop.current, { autoAlpha: 0, duration: 0.25, onComplete: onClose });
  }

  useEffect(() => {
    if (!prefersReducedMotion()) {
      gsap.fromTo(backdrop.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 });
      gsap.fromTo(panel.current, { y: 28, autoAlpha: 0, scale: 0.98 }, { y: 0, autoAlpha: 1, scale: 1, duration: 0.5, ease: EASE.snap });
    }
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const glow = {
    ember: "from-ember/[0.10]",
    spectre: "from-spectre/[0.10]",
    amethyst: "from-amethyst/[0.12]",
    ok: "from-ok/[0.10]",
  }[tone];

  return createPortal(
    <div
      ref={backdrop}
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => e.target === backdrop.current && close()}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : kicker}
    >
      <div
        ref={panel}
        tabIndex={-1}
        style={{ maxWidth: width }}
        className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-white/10 bg-basalt-2 p-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-[0_40px_120px_-30px_rgba(0,0,0,1)] outline-none sm:rounded-3xl sm:p-6"
      >
        <div className={`pointer-events-none absolute inset-x-0 top-0 h-32 rounded-t-3xl bg-gradient-to-b ${glow} to-transparent`} />
        <div className="relative mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {kicker && <div className="label mb-1.5">{kicker}</div>}
            <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-bone">{title}</h2>
          </div>
          <button onClick={close} aria-label="Close" className="rounded-lg px-2 text-2xl leading-none text-ash hover:bg-white/5 hover:text-bone">
            ×
          </button>
        </div>
        <div className="relative">{typeof children === "function" ? children(close) : children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Label/value row used inside modals and receipts. */
export function Row({ k, v, sub, strong, tone }: { k: ReactNode; v: ReactNode; sub?: string; strong?: boolean; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 whitespace-nowrap text-ash">{k}</dt>
      <dd className={`num text-right ${tone ?? (strong ? "text-[15px] text-bone" : "text-bone-dim")}`}>
        {v}
        {sub && <span className="ml-2 text-[11px] text-ash">{sub}</span>}
      </dd>
    </div>
  );
}
