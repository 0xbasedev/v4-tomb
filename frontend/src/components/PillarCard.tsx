/**
 * PillarCard — large action card for the three protocol pillars. Used in a
 * 3-column grid directly under the hero. Each pillar has a different palette
 * color, an icon-shape badge, a one-line value proposition, and a CTA.
 */

interface PillarCardProps {
  number: string;
  title: string;
  blurb: string;
  cta: string;
  href: string;
  variant: "pink" | "yellow" | "orange";
}

const VARIANTS: Record<
  PillarCardProps["variant"],
  {
    bg: string;
    border: string;
    title: string;
    shadow: string;
    cta: string;
    hover: string;
  }
> = {
  pink: {
    bg: "bg-miami-ground-blush",
    border: "border-miami-pink",
    title: "text-miami-pink",
    shadow: "shadow-[8px_8px_0px_#00ced1]",
    cta: "bg-miami-pink text-miami-ground",
    hover: "hover:shadow-[12px_12px_0px_#00ced1]",
  },
  yellow: {
    bg: "bg-miami-ground-blush",
    border: "border-miami-yellow",
    title: "text-miami-night",
    shadow: "shadow-[8px_8px_0px_#ff1493]",
    cta: "bg-miami-yellow text-miami-night",
    hover: "hover:shadow-[12px_12px_0px_#ff1493]",
  },
  orange: {
    bg: "bg-miami-ground-blush",
    border: "border-miami-orange",
    title: "text-miami-orange",
    shadow: "shadow-[8px_8px_0px_#0a0a1a]",
    cta: "bg-miami-orange text-miami-ground",
    hover: "hover:shadow-[12px_12px_0px_#0a0a1a]",
  },
};

export function PillarCard({ number, title, blurb, cta, href, variant }: PillarCardProps) {
  const v = VARIANTS[variant];
  return (
    <a
      href={href}
      className={`group relative block border-4 ${v.border} ${v.bg} ${v.shadow} ${v.hover} p-7 transition-shadow duration-150`}
    >
      <div className="mb-4 flex items-center justify-between">
        <span
          className={`font-headline text-5xl font-black italic ${v.title}`}
          style={{ letterSpacing: "-0.02em" }}
        >
          {number}
        </span>
        <span className="font-headline text-3xl text-miami-night/40 group-hover:translate-x-1 transition-transform">
          →
        </span>
      </div>
      <h3
        className={`mb-3 font-headline text-3xl font-black italic ${v.title} md:text-4xl`}
        style={{ letterSpacing: "-0.01em" }}
      >
        {title}
      </h3>
      <p className="mb-6 font-body text-sm text-miami-night/80 md:text-base">{blurb}</p>
      <span
        className={`inline-flex items-center gap-2 ${v.cta} px-4 py-2 font-headline text-sm font-bold italic uppercase tracking-wider`}
        style={{ letterSpacing: "0.08em" }}
      >
        {cta}
      </span>
    </a>
  );
}
