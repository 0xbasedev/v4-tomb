/**
 * TaxScheduleTable — the sell-tax schedule.
 *
 * Renders the PegDefenseHook's tax surface as a vertical list. The active tier
 * (from the TWAP the hook taxes against) is highlighted with a gold left border
 * + ivory value. All other tiers render in muted gold-dark.
 *
 * Source of tier values: contracts/src/hooks/PegDefenseHook.sol. The rate steps
 * DOWN as the TWAP rises: 12% below 1.12, 6% from 1.12, 3% from 1.20.
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
  { fromEth: 1.2, toEth: Infinity, bps: 300 }, // 3%
  { fromEth: 1.12, toEth: 1.2, bps: 600 }, // 6%
  { fromEth: 0, toEth: 1.12, bps: 1200 }, // 12%
];

interface TaxScheduleTableProps {
  /** The TWAP (ETH per MONEY) the hook taxes against. Highlights the active tier. */
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
        The Three Tiers of Tax
      </h3>
      <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mb-6 font-body text-sm italic text-deco-ivory-soft">
        Every sale of MONEY pays a tax set by the time-weighted price, not the
        price of the moment. The stronger the peg, the lighter the tax. Below 1.10
        the tax is burned outright; above it, it accrues to The Treasury.
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
                      {tier.fromEth === 0
                        ? `< ${tier.toEth.toFixed(2)}`
                        : `${tier.fromEth.toFixed(2)} – ${tier.toEth.toFixed(2)}`}
                    </>
                  )}
                </td>
                <td
                  className={`px-3 py-2 text-right font-display text-base italic ${
                    isActive ? "text-deco-ruby" : "text-deco-gold-dark"
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

/** Label for a tax rate read from the hook, for the SwapCard. */
export function tierLabel(bps: number): string {
  const index = TIERS.findIndex((tier) => tier.bps === bps);
  return index === -1 ? "Custom Rate" : `Tier ${index + 1}`;
}
