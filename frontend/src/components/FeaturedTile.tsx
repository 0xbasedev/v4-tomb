/**
 * FeaturedTile — the larger / spotlighted variant of StatTile. Used for the
 * Dashboard's headline metric (MONEY price · peg). Wider, larger value, optional
 * sparkline area, gold-rimmed.
 *
 * Single-column variant — span 2 columns in a 3-col grid by default.
 */

interface FeaturedTileProps {
  label: string;
  value: string;
  unit?: string;
  badge?: string;
  badgeTone?: "gold" | "ruby" | "emerald";
  /** Optional 80x40 placeholder visual area — sparkline gets dropped here once wired */
  visual?: React.ReactNode;
  className?: string;
}

const BADGE_TONES: Record<NonNullable<FeaturedTileProps["badgeTone"]>, string> = {
  gold: "border-deco-gold text-deco-gold",
  ruby: "border-deco-ruby text-deco-ruby",
  emerald: "border-deco-emerald text-deco-emerald",
};

export function FeaturedTile({
  label,
  value,
  unit,
  badge,
  badgeTone = "gold",
  visual,
  className = "",
}: FeaturedTileProps) {
  return (
    <div className={`deco-panel text-center ${className}`}>
      <div className="label-deco mb-4 text-deco-gold-dark">{label}</div>
      <div className="flex items-baseline justify-center gap-3">
        <div className="font-display text-5xl text-deco-ivory md:text-7xl" style={{ letterSpacing: "0.02em" }}>
          {value}
        </div>
        {unit && (
          <div className="font-ornament text-base text-deco-gold md:text-lg" style={{ letterSpacing: "0.2em" }}>
            {unit}
          </div>
        )}
      </div>
      {badge && (
        <div
          className={`label-deco mt-4 inline-block border px-3 py-1 ${BADGE_TONES[badgeTone]}`}
        >
          {badge}
        </div>
      )}
      {visual && <div className="mt-6">{visual}</div>}
    </div>
  );
}
