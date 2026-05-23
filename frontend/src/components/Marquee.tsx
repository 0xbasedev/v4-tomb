/**
 * Marquee — horizontal scrolling ticker for protocol stats / taglines.
 *
 * Used as a "live wire" band that sits between hero and pillar zones. CSS-only
 * animation. Per docs/eighties-design skill: declarative copy, all caps, separator
 * dots, never apologetic.
 */

interface MarqueeProps {
  items: string[];
  /** Speed in seconds for one full loop. Default 30s. */
  speed?: number;
}

export function Marquee({ items, speed = 30 }: MarqueeProps) {
  // Duplicate items so the marquee can loop seamlessly.
  const doubled = [...items, ...items];

  return (
    <div className="relative overflow-hidden border-y-4 border-miami-night bg-arcade-ground py-4">
      <div
        className="flex whitespace-nowrap"
        style={{
          animation: `marquee ${speed}s linear infinite`,
        }}
      >
        {doubled.map((item, i) => (
          <div
            key={i}
            className="flex shrink-0 items-center gap-8 px-8 font-headline text-xl font-bold italic uppercase text-arcade-cyan neon-text md:text-2xl"
            style={{ letterSpacing: "0.1em" }}
          >
            <span>{item}</span>
            <span className="text-arcade-magenta neon-text">◆</span>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
