/**
 * TaxScheduleTable — Tomb-style 14-tier tax schedule.
 *
 * Renders the PegDefenseHook's tax surface as a vertical list. The active tier
 * (passed in via activePriceWad) is highlighted with a gold left border + ivory
 * value. All other tiers render in muted gold-dark.
 *
 * Source of tier values: contracts/src/hooks/PegDefenseHook.sol — the 14-tier
 * table is faithful to Tomb's TaxOfficeV2 with a burn-during-contraction lever.
 */

interface Tier {
  /** Lower bound of the tier, in WETH per MONEY (e.g. 0.95 means price ≥ 0.95). */
  fromEth: number;
  /** Upper bound (exclusive). */
  toEth: number;
  /** Tax rate in basis points. */
  bps: number;
}

const TIERS: Tier[] = [
  { fromEth: 1.0, toEth: Infinity, bps: 0 },
  { fromEth: 0.95, toEth: 1.0, bps: 100 }, // 1%
  { fromEth: 0.9, toEth: 0.95, bps: 200 }, // 2%
  { fromEth: 0.85, toEth: 0.9, bps: 400 }, // 4%
  { fromEth: 0.8, toEth: 0.85, bps: 600 }, // 6%
  { fromEth: 0.75, toEth: 0.8, bps: 800 }, // 8%
  { fromEth: 0.7, toEth: 0.75, bps: 1000 }, // 10%
  { fromEth: 0.65, toEth: 0.7, bps: 1200 }, // 12%
  { fromEth: 0.6, toEth: 0.65, bps: 1400 }, // 14%
  { fromEth: 0.55, toEth: 0.6, bps: 1600 }, // 16%
  { fromEth: 0.5, toEth: 0.55, bps: 1800 }, // 18%
  { fromEth: 0.4, toEth: 0.5, bps: 2200 }, // 22%
  { fromEth: 0.3, toEth: 0.4, bps: 2600 }, // 26%
  { fromEth: 0, toEth: 0.3, bps: 3000 }, // 30%
];

interface TaxScheduleTableProps {
  /** Current MONEY price in ETH. Used to highlight the active tier. */
  activePriceEth: number;
}

export function TaxScheduleTable({ activePriceEth }: TaxScheduleTableProps) {
  return (
    <div className="deco-panel">
      <div className="label-deco mb-3 text-deco-gold-dark">The Schedule</div>
      <h3
        className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
        style={{ letterSpacing: "0.06em" }}
      >
        The Fourteen Tiers of Tax
      </h3>
      <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mb-6 font-body text-sm italic text-deco-ivory-soft">
        When MONEY trades below par, a tax is levied on outgoing sales. The lower the
        price, the steeper the tax. All proceeds accrue to The Treasury and, during
        contraction, are routed to outright burn.
      </p>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-deco-gold/30">
            <th className="label-deco px-3 py-2 text-deco-gold-dark">Tier</th>
            <th className="label-deco px-3 py-2 text-deco-gold-dark">Range · ETH</th>
            <th className="label-deco px-3 py-2 text-right text-deco-gold-dark">Tax</th>
          </tr>
        </thead>
        <tbody>
          {TIERS.map((tier, i) => {
            const isActive =
              activePriceEth >= tier.fromEth && activePriceEth < tier.toEth;
            return (
              <tr
                key={i}
                className={`border-b border-deco-gold/15 last:border-b-0 ${
                  isActive ? "bg-deco-ground-soft" : ""
                }`}
              >
                <td
                  className={`font-ornament px-3 py-2 ${
                    isActive
                      ? "border-l-2 border-deco-gold text-deco-gold"
                      : "text-deco-gold-dark"
                  }`}
                  style={{ letterSpacing: "0.2em" }}
                >
                  {i + 1}
                </td>
                <td
                  className={`px-3 py-2 font-display text-base ${
                    isActive ? "text-deco-ivory" : "text-deco-gold-dark"
                  }`}
                >
                  {tier.toEth === Infinity ? (
                    <>≥ {tier.fromEth.toFixed(2)}</>
                  ) : (
                    <>
                      {tier.fromEth.toFixed(2)} – {tier.toEth.toFixed(2)}
                    </>
                  )}
                </td>
                <td
                  className={`px-3 py-2 text-right font-display text-base italic ${
                    isActive
                      ? tier.bps > 0
                        ? "text-deco-ruby"
                        : "text-deco-emerald"
                      : "text-deco-gold-dark"
                  }`}
                >
                  {(tier.bps / 100).toFixed(0)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Helper: derive the current tier label + bps from a price for the SwapCard. */
export function tierAt(priceEth: number): { label: string; bps: number } {
  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i];
    if (priceEth >= tier.fromEth && priceEth < tier.toEth) {
      if (tier.bps === 0) return { label: "Above Peg", bps: 0 };
      return { label: `Tier ${i + 1}`, bps: tier.bps };
    }
  }
  return { label: "Above Peg", bps: 0 };
}
