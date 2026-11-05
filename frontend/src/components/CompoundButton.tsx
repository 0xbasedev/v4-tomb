import { useRef } from "react";

import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { GENESIS_POLICY } from "@/lib/launch";

const COMPOUND_COOLDOWN_SECONDS = GENESIS_POLICY.compoundCooldownSeconds;

/**
 * Compound — sell part of the liquid half for USDC, add xTOMB/USDC liquidity and restake, in one tx (compoundToLP).
 * Hard-coded to once every 3 hours per pool per wallet. While cooling down
 * the button shows a draining ring and the exact time left, so it reads as
 * "soon" rather than "broken".
 */
export function CompoundButton({
  readyIn,
  pending,
  rewardSymbol,
  disabled,
  onCompound,
  totalSeconds = COMPOUND_COOLDOWN_SECONDS,
  waitReason = "Compounding is limited to once every 3 hours",
  readyTitle,
}: {
  readyIn: number;
  pending: number | null;
  rewardSymbol: string;
  disabled?: boolean;
  onCompound: () => void;
  /** Length of whatever is holding it (the 3h cap by default), for the ring. */
  totalSeconds?: number;
  waitReason?: string;
  readyTitle?: string;
}) {
  const ring = useRef<SVGCircleElement>(null);
  const C = 2 * Math.PI * 9;
  const cooling = readyIn > 0;
  const progress = cooling ? Math.max(0, 1 - readyIn / totalSeconds) : 1;
  const nothing = !(pending && pending > 0);

  useGSAP(
    () => {
      if (!ring.current) return;
      const off = C * (1 - progress);
      if (prefersReducedMotion()) gsap.set(ring.current, { strokeDashoffset: off });
      else gsap.to(ring.current, { strokeDashoffset: off, duration: 0.8, ease: EASE.settle });
    },
    { dependencies: [progress] },
  );

  const h = Math.floor(readyIn / 3600);
  const m = Math.floor((readyIn % 3600) / 60);
  const s = readyIn % 60;
  const label = cooling ? `${h}h ${String(m).padStart(2, "0")}m${h === 0 ? ` ${String(s).padStart(2, "0")}s` : ""}` : nothing ? "Nothing to compound" : "Compound";

  return (
    <button
      type="button"
      onClick={onCompound}
      disabled={disabled || cooling || nothing}
      title={cooling ? waitReason : (readyTitle ?? `Compound ${rewardSymbol} into the xTOMB/USDC LP pool`)}
      className={`btn h-10 gap-2 px-3 text-[13px] ${!cooling && !nothing ? "border-ok/40 text-ok hover:border-ok/70 hover:bg-ok/10" : ""}`}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" className="-rotate-90">
        <circle cx="11" cy="11" r="9" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2.4" />
        <circle
          ref={ring}
          cx="11"
          cy="11"
          r="9"
          fill="none"
          stroke={cooling ? "#7c7a74" : "#34e3a0"}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C}
        />
      </svg>
      <span className="num">{label}</span>
    </button>
  );
}
