/**
 * Sunburst — radiating rays from a central point, the Art Deco signature motif.
 *
 * Per docs/skill-art-deco.md: "Radiating lines from a central point — as a background
 * element, a section divider, or a logo mark. This is the Art Deco signature."
 *
 * Renders as SVG so it scales cleanly. Used behind the hero title.
 */

interface SunburstProps {
  /** Number of rays. 16, 24, or 32 — even multiples of 8 for symmetric beauty. */
  rays?: number;
  /** Color of the rays. Defaults to deco-gold-deep at low opacity. */
  color?: string;
  /** Opacity. */
  opacity?: number;
  /** className for layout. */
  className?: string;
  /** If true, rotates very slowly (60s+ per turn). */
  animated?: boolean;
}

export function Sunburst({
  rays = 24,
  color = "#a67c00",
  opacity = 0.35,
  className = "",
  animated = true,
}: SunburstProps) {
  // Each "ray" is a thin wedge triangle from center outward. We render half (every other)
  // longer than the others to create the alternating ray-length classic Deco fan look.
  const wedges: { d: string; long: boolean }[] = [];
  const sectorAngle = 360 / rays;

  for (let i = 0; i < rays; i++) {
    const long = i % 2 === 0;
    // half-width of each wedge in degrees
    const halfAngle = sectorAngle * 0.18;
    const a1 = (i * sectorAngle - halfAngle) * (Math.PI / 180);
    const a2 = (i * sectorAngle + halfAngle) * (Math.PI / 180);
    const radius = long ? 500 : 360;
    const x1 = 500 + radius * Math.cos(a1 - Math.PI / 2);
    const y1 = 500 + radius * Math.sin(a1 - Math.PI / 2);
    const x2 = 500 + radius * Math.cos(a2 - Math.PI / 2);
    const y2 = 500 + radius * Math.sin(a2 - Math.PI / 2);
    wedges.push({ d: `M 500 500 L ${x1} ${y1} L ${x2} ${y2} Z`, long });
  }

  return (
    <svg
      viewBox="0 0 1000 1000"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={`pointer-events-none ${animated ? "animate-sunburst-rotate" : ""} ${className}`}
      style={{ opacity }}
    >
      {wedges.map((w, i) => (
        <path key={i} d={w.d} fill={color} fillOpacity={w.long ? 1 : 0.5} />
      ))}
      {/* Central disk — the "anchor" of the burst */}
      <circle cx="500" cy="500" r="40" fill={color} fillOpacity={0.8} />
      <circle cx="500" cy="500" r="22" fill="#0d0a05" />
      <circle cx="500" cy="500" r="14" fill={color} />
    </svg>
  );
}
