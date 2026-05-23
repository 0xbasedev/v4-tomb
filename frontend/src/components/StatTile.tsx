/**
 * StatTile — a single data tile in the Arcade-mode stats panel.
 *
 * Per docs/eighties-design skill:
 *   - Dark ground (Arcade palette) for data-heavy zones
 *   - Neon-edge headline color, chrome/cyan value
 *   - Hard offset border + hard shadow in contrasting color
 *
 * Variants:
 *   - "pink"   — magenta accent, cyan shadow
 *   - "cyan"   — cyan accent, magenta shadow
 *   - "gold"   — gold accent, magenta shadow
 *   - "purple" — laser purple accent, gold shadow
 */

type Variant = "pink" | "cyan" | "gold" | "purple";

interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, { border: string; label: string; value: string; shadow: string }> = {
  pink: {
    border: "border-arcade-magenta",
    label: "text-arcade-magenta",
    value: "text-arcade-chrome",
    shadow: "shadow-[6px_6px_0px_#00ffff]",
  },
  cyan: {
    border: "border-arcade-cyan",
    label: "text-arcade-cyan",
    value: "text-arcade-chrome",
    shadow: "shadow-[6px_6px_0px_#ff1493]",
  },
  gold: {
    border: "border-arcade-gold",
    label: "text-arcade-gold",
    value: "text-arcade-chrome",
    shadow: "shadow-[6px_6px_0px_#ff1493]",
  },
  purple: {
    border: "border-arcade-purple",
    label: "text-arcade-purple",
    value: "text-arcade-chrome",
    shadow: "shadow-[6px_6px_0px_#ffd700]",
  },
};

export function StatTile({ label, value, hint, variant = "pink" }: StatTileProps) {
  const v = VARIANT_CLASSES[variant];
  return (
    <div className={`relative border-2 ${v.border} ${v.shadow} bg-arcade-ground p-5`}>
      <div
        className={`mb-2 text-label uppercase ${v.label} neon-text`}
        style={{ letterSpacing: "0.15em" }}
      >
        {label}
      </div>
      <div className={`font-headline text-3xl font-black italic ${v.value} md:text-4xl`}>
        {value}
      </div>
      {hint && (
        <div className="mt-2 font-body text-xs text-arcade-chrome/60 uppercase tracking-wider">
          {hint}
        </div>
      )}
    </div>
  );
}
