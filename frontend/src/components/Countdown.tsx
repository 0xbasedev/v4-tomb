import { formatDuration } from "@/lib/format";
import { useNow } from "@/lib/hooks";

/** Ticks once a second on its own, so a countdown never re-renders the page around it. */
export function Countdown({ to, done = "now", className = "" }: { to: number | null; done?: string; className?: string }) {
  const now = useNow();
  if (to === null) return <span className={className}>—</span>;
  return <span className={`num ${className}`}>{to > now ? formatDuration(to - now) : done}</span>;
}
