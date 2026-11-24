import { useRef, useState, type ReactNode } from "react";

import { gsap } from "@/lib/motion";

interface HoldButtonProps {
  children: ReactNode;
  onConfirm: () => void;
  /** Hold duration in seconds. Longer = more friction. */
  hold?: number;
  disabled?: boolean;
  className?: string;
  /** Tone of the fill sweep. */
  tone?: "bad" | "warn";
  title?: string;
}

/**
 * Press-and-hold to confirm. Used for actions that cost the user something
 * (forfeiting rewards, selling into a heavy peg tax). A plain click does
 * nothing but shake and hint — so the expensive path takes *intent*, while
 * the recommended path next to it is one tap.
 */
export function HoldButton({
  children,
  onConfirm,
  hold = 1.4,
  disabled = false,
  className = "",
  tone = "bad",
  title,
}: HoldButtonProps) {
  const fill = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const tween = useRef<gsap.core.Tween | null>(null);
  const [hint, setHint] = useState(false);

  function start() {
    if (disabled || !fill.current) return;
    setHint(false);
    tween.current?.kill();
    tween.current = gsap.fromTo(
      fill.current,
      { scaleX: 0 },
      {
        scaleX: 1,
        duration: hold,
        ease: "none",
        onComplete: () => {
          gsap.to(fill.current, { scaleX: 0, duration: 0.35, delay: 0.15 });
          onConfirm();
        },
      },
    );
  }
  function cancel() {
    if (!tween.current || !fill.current) return;
    const progress = tween.current.progress();
    tween.current.kill();
    tween.current = null;
    gsap.to(fill.current, { scaleX: 0, duration: 0.3, ease: "power2.out" });
    if (progress < 0.25 && btn.current) {
      // A quick tap — tell them it needs a hold.
      setHint(true);
      gsap.fromTo(btn.current, { x: -4 }, { x: 0, duration: 0.4, ease: "elastic.out(1.2, 0.3)" });
    }
  }

  const fillColor = tone === "bad" ? "bg-bad/25" : "bg-warn/25";

  return (
    <div className="w-full">
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        title={title}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") cancel();
        }}
        className={`btn btn-danger relative w-full overflow-hidden ${className}`}
      >
        <span
          ref={fill}
          aria-hidden
          className={`absolute inset-0 origin-left scale-x-0 ${fillColor}`}
        />
        <span className="relative">{children}</span>
      </button>
      <p className={`mt-2 text-center font-mono text-[11px] uppercase tracking-[0.14em] transition-opacity ${hint ? "text-bad/80 opacity-100" : "text-ash-dim opacity-70"}`}>
        {hint ? "Hold to confirm — this costs you" : `Hold ${hold.toFixed(1)}s to confirm`}
      </p>
    </div>
  );
}
