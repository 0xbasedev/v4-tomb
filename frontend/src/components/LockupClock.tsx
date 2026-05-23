/**
 * LockupClock — formal Art Deco countdown showing time until an action unlocks.
 *
 * Used in The Club for the withdraw + claim lockup timers, and on Trust Notes for
 * the maturity countdown. Pure display — receives the remaining seconds and
 * formats them; the parent owns the live tick.
 */

interface LockupClockProps {
  label: string;
  /** Total seconds remaining until unlock; <=0 means unlocked now. */
  secondsRemaining: number;
  /** Formal title when unlocked. Default: "Available Now". */
  unlockedLabel?: string;
}

function formatRemaining(seconds: number): { days: number; hours: number; minutes: number } {
  if (seconds <= 0) return { days: 0, hours: 0, minutes: 0 };
  return {
    days: Math.floor(seconds / 86400),
    hours: Math.floor((seconds % 86400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
  };
}

export function LockupClock({
  label,
  secondsRemaining,
  unlockedLabel = "Available Now",
}: LockupClockProps) {
  const unlocked = secondsRemaining <= 0;
  const { days, hours, minutes } = formatRemaining(secondsRemaining);

  return (
    <div className="text-center">
      <div className="label-deco mb-2 text-deco-gold-dark">{label}</div>
      {unlocked ? (
        <div
          className="font-display text-2xl italic text-deco-gold md:text-3xl"
          style={{ letterSpacing: "0.08em" }}
        >
          {unlockedLabel}
        </div>
      ) : (
        <div className="flex items-baseline justify-center gap-3">
          <ClockSegment value={days} unit="D" />
          <span className="text-deco-gold-dark">·</span>
          <ClockSegment value={hours} unit="H" />
          <span className="text-deco-gold-dark">·</span>
          <ClockSegment value={minutes} unit="M" />
        </div>
      )}
    </div>
  );
}

function ClockSegment({ value, unit }: { value: number; unit: string }) {
  const padded = value.toString().padStart(2, "0");
  return (
    <div className="flex items-baseline gap-1">
      <span
        className="font-display text-2xl text-deco-ivory md:text-3xl"
        style={{ letterSpacing: "0.05em" }}
      >
        {padded}
      </span>
      <span className="label-deco text-deco-gold-dark">{unit}</span>
    </div>
  );
}
