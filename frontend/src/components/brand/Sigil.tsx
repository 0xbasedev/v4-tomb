import { useId } from "react";

/**
 * The xTomb sigil: a pyramid crossed by an X, its lower chamber glowing.
 * The X is the fork's mark; the lit chamber is where value is buried and
 * re-emerges (seigniorage).
 */
export function Sigil({ size = 28, glow = true, className = "" }: { size?: number; glow?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <defs>
        <linearGradient id={`e${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd27a" />
          <stop offset=".55" stopColor="#ff6a2b" />
          <stop offset="1" stopColor="#c2410c" />
        </linearGradient>
        <filter id={`g${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {glow && <path d="M24 31 33 40H15Z" fill="#ff6a2b" opacity=".75" filter={`url(#g${id})`} />}
      <path d="M24 5 43 40H5Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M14.5 22.5 33 40M33.5 22.5 15 40" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M24 31 33 40H15Z" fill={`url(#e${id})`} />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 text-bone ${className}`}>
      <Sigil size={26} />
      <span className="font-display text-[17px] font-bold tracking-[-0.03em]">
        <span className="text-ember">x</span>TOMB
      </span>
    </span>
  );
}
