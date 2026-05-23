/**
 * StatTile — Art Deco data tile. Frame-within-frame border, ornament label in gold,
 * value in ivory display serif, optional hint in dark antique gold.
 *
 * Centered text, vertical symmetry. Used in the hero stats panel and on dashboards.
 */

interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
}

export function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className="deco-panel text-center">
      <div className="label-deco mb-3">{label}</div>
      <div className="font-display text-3xl text-deco-ivory md:text-4xl">{value}</div>
      {hint && (
        <div
          className="mt-2 font-body text-xs uppercase text-deco-gold-dark"
          style={{ letterSpacing: "0.15em" }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
