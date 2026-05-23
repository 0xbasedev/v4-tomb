/**
 * PhaseBanner — large declarative indicator of the protocol's current operating
 * phase. Acts as the visual centerpiece of the Dashboard, framed in metallic gold
 * with a centered ornament.
 *
 * Phases per the Treasury mechanics:
 *   - Bootstrap (epoch < 28): unconditional 4.5% supply expansion to Boardroom
 *   - Expansion (price ≥ 1.01 ETH): seigniorage minted, distributed pro-rata
 *   - Redemption (price ≥ premium): Trust Notes can be presented at premium
 *   - Contraction (price < 1.00 ETH): MONEY can be burned for Trust Notes
 *   - At Rest (1.00 ≤ price ≤ 1.01): no action — the dead zone
 */

export type Phase = "bootstrap" | "expansion" | "redemption" | "contraction" | "rest";

interface PhaseBannerProps {
  phase: Phase;
  detail?: string;
}

const PHASE_COPY: Record<
  Phase,
  { label: string; title: string; gloss: string; tone: string }
> = {
  bootstrap: {
    label: "Phase · Bootstrap",
    title: "The Trust is Founding",
    gloss:
      "For the first twenty-eight epochs, four and one-half per cent of supply is minted to The Club each cycle regardless of the price. Patience is rewarded.",
    tone: "text-deco-gold",
  },
  expansion: {
    label: "Phase · Expansion",
    title: "Seigniorage Flows",
    gloss:
      "MONEY trades above the peg. The Treasury mints, the daoFund and devFund take their cuts, and the remainder is distributed to Members of The Club.",
    tone: "text-deco-gold",
  },
  redemption: {
    label: "Phase · Premium",
    title: "Notes Are Redeemed",
    gloss:
      "MONEY trades above one and one-tenth Ether. Holders of Trust Notes may present them at the Treasury and receive MONEY at premium.",
    tone: "text-deco-emerald",
  },
  contraction: {
    label: "Phase · Contraction",
    title: "The Notes Are Active",
    gloss:
      "MONEY trades below the peg. Holders may burn MONEY for Trust Notes at a discount. The Hook burns supply on every sale. The peg shall recover.",
    tone: "text-deco-ruby",
  },
  rest: {
    label: "Phase · At Rest",
    title: "The Trust is Steady",
    gloss:
      "MONEY is at peg. No seigniorage is minted. No Notes are issued. The Trust observes its own equilibrium.",
    tone: "text-deco-ivory",
  },
};

export function PhaseBanner({ phase, detail }: PhaseBannerProps) {
  const p = PHASE_COPY[phase];
  return (
    <div className="deco-panel mx-auto max-w-3xl text-center">
      <div className="label-deco mb-3 text-deco-gold-dark">{p.label}</div>
      <h2
        className={`font-display text-3xl italic md:text-5xl ${p.tone}`}
        style={{ letterSpacing: "0.05em" }}
      >
        {p.title}
      </h2>
      <div className="mx-auto mb-5 mt-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mx-auto max-w-2xl font-body text-base text-deco-ivory-soft md:text-lg">
        {p.gloss}
      </p>
      {detail && (
        <div className="mt-5 font-ornament text-sm text-deco-gold" style={{ letterSpacing: "0.2em" }}>
          {detail}
        </div>
      )}
    </div>
  );
}
