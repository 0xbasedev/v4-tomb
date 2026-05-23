/**
 * MarketStateBanner — Art Deco eligibility banner for Trust Notes.
 *
 * Shows the current bond market state: whether acquisition is open (price below
 * peg) or redemption is open (price above ceiling + premium threshold) or the
 * market is at rest (in the dead zone). Each state has a tone and a formal
 * pronouncement.
 */

export type MarketState = "acquisition" | "redemption" | "at-rest" | "closed";

interface MarketStateBannerProps {
  state: MarketState;
  price: string;
  detail?: string;
}

const STATE_COPY: Record<
  MarketState,
  { label: string; title: string; gloss: string; tone: string }
> = {
  acquisition: {
    label: "Bond Market · Open",
    title: "Notes Are Issued",
    gloss:
      "The Trust trades below par. Burn MONEY at the Treasury and receive Trust Notes at a discount. Hold until recovery.",
    tone: "text-deco-ruby",
  },
  redemption: {
    label: "Bond Market · Premium Active",
    title: "Notes Are Redeemed",
    gloss:
      "The Trust trades above one and one-tenth. Present your Notes at the Treasury and receive MONEY at a premium.",
    tone: "text-deco-emerald",
  },
  "at-rest": {
    label: "Bond Market · At Rest",
    title: "The Trust is Steady",
    gloss:
      "The Trust trades within the band. No Notes are issued. No premium is paid. Observe and wait.",
    tone: "text-deco-ivory",
  },
  closed: {
    label: "Bond Market · Closed",
    title: "No Notes Are Active",
    gloss:
      "The Trust has not yet entered its first contraction. The bond office stands by.",
    tone: "text-deco-gold-dark",
  },
};

export function MarketStateBanner({ state, price, detail }: MarketStateBannerProps) {
  const s = STATE_COPY[state];
  return (
    <div className="deco-panel mx-auto max-w-3xl text-center">
      <div className="label-deco mb-3 text-deco-gold-dark">{s.label}</div>
      <h2
        className={`font-display text-3xl italic md:text-4xl ${s.tone}`}
        style={{ letterSpacing: "0.05em" }}
      >
        {s.title}
      </h2>
      <div className="mx-auto mb-5 mt-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mx-auto max-w-2xl font-body text-base text-deco-ivory-soft md:text-lg">
        {s.gloss}
      </p>
      <div className="mt-5 flex flex-wrap items-baseline justify-center gap-3">
        <span className="label-deco text-deco-gold-dark">Current Quotation</span>
        <span
          className="font-display text-2xl italic text-deco-ivory"
          style={{ letterSpacing: "0.05em" }}
        >
          {price}
        </span>
        <span
          className="font-ornament text-sm text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          ETH
        </span>
      </div>
      {detail && (
        <div
          className="mt-3 font-ornament text-sm text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          {detail}
        </div>
      )}
    </div>
  );
}
