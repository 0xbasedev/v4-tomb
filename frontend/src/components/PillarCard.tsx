/**
 * PillarCard — large action card for the protocol's "Three Estates" (The Club /
 * The Vault / Trust Notes). Frame-within-frame, centered axis, ornament label,
 * formal voice CTA. All three pillars share the same palette — Art Deco doesn't
 * vary the palette per card; the cards are siblings, equal in weight.
 *
 * The Roman numeral acts as the ornament marker at the top.
 */

interface PillarCardProps {
  numeral: "I" | "II" | "III";
  title: string;
  blurb: string;
  cta: string;
  href: string;
}

export function PillarCard({ numeral, title, blurb, cta, href }: PillarCardProps) {
  return (
    <a
      href={href}
      className="deco-panel group block text-center transition-colors duration-300 hover:bg-deco-ground-medium"
    >
      <div
        className="font-ornament mb-6 text-3xl font-bold text-deco-gold"
        style={{ letterSpacing: "0.2em" }}
      >
        {numeral}
      </div>
      <h3
        className="mb-5 font-display text-3xl font-medium text-deco-ivory md:text-4xl"
        style={{ letterSpacing: "0.06em" }}
      >
        {title}
      </h3>
      <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mx-auto mb-7 max-w-sm font-body text-base text-deco-ivory-soft md:text-lg">
        {blurb}
      </p>
      <span className="label-deco inline-flex items-center gap-3 text-deco-gold transition-colors group-hover:text-deco-gold-light">
        {cta}
        <span className="font-display text-base">→</span>
      </span>
    </a>
  );
}
