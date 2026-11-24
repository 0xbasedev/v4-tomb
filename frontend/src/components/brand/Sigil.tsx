import { useId } from "react";

/**
 * The xTOMB sigil: a pyramid crossed by an X, with its lower cell lit in the
 * brand gradient. The X is the mark; the lit cell is where expansion emerges.
 */
export function Sigil({ size = 28, glow = true, className = "" }: { size?: number; glow?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <defs>
        <linearGradient id={`e${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--iris-hot-rgb))" />
          <stop offset=".55" stopColor="rgb(var(--iris-rgb))" />
          <stop offset="1" stopColor="rgb(var(--iris-deep-rgb))" />
        </linearGradient>
        <filter id={`g${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {glow && <path d="M24 31 33 40H15Z" fill="rgb(var(--iris-rgb))" opacity=".75" filter={`url(#g${id})`} />}
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
        <span className="text-iris">x</span>TOMB
      </span>
    </span>
  );
}
