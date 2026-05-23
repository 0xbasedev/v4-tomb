import { RuleTrio } from "@/components/RuleTrio";
import { Link } from "react-router-dom";

/**
 * PlaceholderPage — formal "under construction" page for routes that are stubbed
 * during the frontend build sprint. Each page that exists in the router but isn't
 * built yet renders this with its own title and gloss.
 *
 * Removed once the actual route component is built in a later turn.
 */

interface PlaceholderPageProps {
  title: string;
  subtitle?: string;
  gloss: string;
  numeral: "I" | "II" | "III" | "IV" | "V";
}

export function PlaceholderPage({ title, subtitle, gloss, numeral }: PlaceholderPageProps) {
  return (
    <section className="relative min-h-[70vh] px-6 py-20 md:px-12 md:py-28">
      <div className="mx-auto max-w-4xl text-center">
        <div className="label-deco mb-3 text-deco-gold-dark">
          {subtitle ?? "A Pavilion of The Trust"}
        </div>
        <div
          className="font-ornament mb-6 text-4xl font-bold text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          {numeral}
        </div>
        <h1 className="gold-text mb-6 font-display italic text-section">{title}</h1>
        <RuleTrio className="mb-10" />
        <p className="mx-auto max-w-xl font-headline text-xl italic text-deco-ivory-soft md:text-2xl">
          {gloss}
        </p>
        <div className="mt-10 inline-flex items-center gap-3 border border-deco-gold/50 px-5 py-3">
          <span
            className="inline-block h-2 w-2 rotate-45 bg-deco-gold"
            aria-hidden
          />
          <span className="label-deco text-deco-gold">
            Under Construction · Returns Forthcoming
          </span>
        </div>
        <div className="mt-12">
          <Link to="/dashboard" className="btn-deco">
            Return to The Ledger
          </Link>
        </div>
      </div>
    </section>
  );
}
