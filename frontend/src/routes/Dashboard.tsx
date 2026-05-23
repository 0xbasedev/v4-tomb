import { StatTile } from "@/components/StatTile";
import { FeaturedTile } from "@/components/FeaturedTile";
import { PhaseBanner } from "@/components/PhaseBanner";
import { RuleTrio } from "@/components/RuleTrio";

import { useEpoch, useMoneyMarket, useTokenSupplies, useDeployment } from "@/lib/hooks";
import { formatToken, formatPrice, formatCountdown } from "@/lib/format";

/**
 * Dashboard — "The Ledger." Live operating state of the Trust.
 *
 * Reads via wagmi multicalls (Sprint B):
 *   useEpoch         → epoch counter, next-epoch countdown
 *   useMoneyMarket   → price, peg, ceiling, premium threshold, circulating supply,
 *                       seigniorage reserve, current phase (bootstrap/expansion/etc)
 *   useTokenSupplies → MONEY / ESTATE / TRUSTNOTE totalSupply
 *
 * Pre-Oracle-update (first epoch on a fresh deploy), `useMoneyMarket.price` is 0n
 * because `getMoneyPrice()` reverts until the oracle records its first observation.
 * The format helpers render 0n as "—" so the UI stays honest about the void.
 *
 * Genesis / Main / Share allocations are protocol constants — shown as static values
 * since they're not stored on-chain in a single-call view.
 */

// Roman numeral helper for small integers — used to render the epoch as "I" / "II" / etc.
function toRoman(n: number): string {
  if (n <= 0) return "—";
  const numerals: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let result = "";
  let remaining = n;
  for (const [value, sym] of numerals) {
    while (remaining >= value) {
      result += sym;
      remaining -= value;
    }
  }
  return result;
}

export function Dashboard() {
  const deployment = useDeployment();
  const { epoch, secondsUntilNextEpoch } = useEpoch();
  const market = useMoneyMarket();
  const supplies = useTokenSupplies();

  const epochNum = epoch !== undefined ? Number(epoch) : 0;
  const bootstrapNum = Number(market.bootstrapEpochs);
  const inBootstrap = market.phase === "bootstrap";

  // Phase banner detail line — formal "Epoch X of Y" formatting.
  const phaseDetail = inBootstrap
    ? `Epoch ${toRoman(epochNum + 1)} of ${toRoman(bootstrapNum)}`
    : `Epoch ${toRoman(epochNum)}`;

  // Headline metric — price + band membership.
  const priceStr = formatPrice(market.price);
  const ceilingStr = formatPrice(market.priceCeiling);
  const inBand = market.price > 0n && market.price >= market.priceOne && market.price <= market.priceCeiling;
  const badge =
    market.price === 0n
      ? "Awaiting Oracle"
      : inBand
        ? "Within The Band"
        : market.price < market.priceOne
          ? "Below Par"
          : "Above Ceiling";
  const badgeTone: "gold" | "ruby" | "emerald" = inBand || market.price === 0n
    ? "gold"
    : market.price < market.priceOne
      ? "ruby"
      : "emerald";

  // Disconnected / wrong-chain state — render the Ledger with "—" everywhere
  // rather than crashing or hiding the page.
  const noDeployment = deployment === null;

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            Live State of The Trust · Base · MMXXVI
          </div>
          <h1 className="gold-text font-display italic text-section">
            The Ledger
          </h1>
          <RuleTrio className="mb-2 mt-8" />
          {noDeployment && (
            <p className="mt-6 font-body text-sm italic text-deco-gold-dark">
              Connect a wallet on Base Sepolia to observe live state.
            </p>
          )}
        </div>
      </section>

      {/* ===== Phase indicator ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <PhaseBanner phase={market.phase} detail={phaseDetail} />
      </section>

      {/* ===== Headline metric: MONEY price + epoch countdown ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The Quotation
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <FeaturedTile
              label="MONEY · Quoted in Ether"
              value={priceStr}
              unit="ETH"
              badge={badge}
              badgeTone={badgeTone}
              className="md:col-span-2"
              visual={
                <div className="mx-auto h-20 w-full max-w-md border border-deco-gold/40 bg-deco-ground-soft">
                  <div
                    className="h-full w-full"
                    style={{
                      background:
                        "linear-gradient(180deg, rgba(212,175,55,0.05) 0%, rgba(212,175,55,0.15) 50%, rgba(212,175,55,0.05) 100%)",
                    }}
                  />
                  <div className="label-deco -mt-12 text-center text-deco-gold-dark">
                    Band · {formatPrice(market.priceOne)} – {ceilingStr} ETH
                  </div>
                </div>
              }
            />
            <div className="flex flex-col gap-5">
              <StatTile
                label="Epoch"
                value={epoch !== undefined ? toRoman(epochNum) : "—"}
                hint={inBootstrap ? "The Bootstrap" : "The Cycle"}
              />
              <StatTile
                label="Next Epoch"
                value={formatCountdown(secondsUntilNextEpoch)}
                hint="Until Allocation"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ===== Supply Ledger ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The Supply Ledger
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="MONEY · Circulating"
              value={formatToken(market.circulatingSupply, 0)}
              hint="Per Treasury"
            />
            <StatTile
              label="MONEY · Total Supply"
              value={formatToken(supplies.moneySupply, 0)}
              hint="Token-Level"
            />
            <StatTile
              label="ESTATE · Outstanding"
              value={formatToken(supplies.estateSupply, 0)}
              hint="Hard Cap 70,000"
            />
            <StatTile
              label="Trust Notes · Outstanding"
              value={formatToken(supplies.trustNoteSupply, 0)}
              hint="Bonds Held"
            />
            <StatTile
              label="Treasury · Reserve"
              value={formatToken(market.seigniorageSaved, 0)}
              hint="MONEY · For Redemption"
            />
            <StatTile label="Genesis Pool" value="11,000" hint="MONEY · 24-Hour Window" />
            <StatTile label="Main Pool" value="140,000" hint="MONEY · 9-Day Distribution" />
            <StatTile label="Share Pool" value="59,500" hint="ESTATE · 370-Day Distribution" />
          </div>
        </div>
      </section>

      {/* ===== Mechanism State ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The Mechanism · State
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile label="Bond Discount" value="—" hint="Only Below Peg" />
            <StatTile label="Bond Premium" value="—" hint="Only Above Premium Threshold" />
            <StatTile label="Contraction Headroom" value="—" hint="MONEY · Burnable This Epoch" />
            <StatTile
              label="Peg Ceiling"
              value={ceilingStr}
              hint="Below: Tax · Above: Issue Notes"
            />
          </div>
        </div>
      </section>

      {/* ===== Recent Epochs ===== */}
      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-5xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The Record of Epochs
          </div>

          <div className="deco-panel overflow-x-auto p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-deco-gold/30">
                  <th className="label-deco px-5 py-4 text-deco-gold-dark">Epoch</th>
                  <th className="label-deco px-5 py-4 text-deco-gold-dark">Price · ETH</th>
                  <th className="label-deco px-5 py-4 text-deco-gold-dark">Action</th>
                  <th className="label-deco px-5 py-4 text-right text-deco-gold-dark">Supply After</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-deco-gold/15 last:border-b-0">
                  <td colSpan={4} className="px-5 py-6 text-center font-body text-sm italic text-deco-gold-dark">
                    Event-log scan pending. Records will populate from{" "}
                    <code className="font-ornament text-deco-gold">TreasuryFunded</code> events.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-6 text-center font-body text-sm italic text-deco-gold-dark">
            Records update with each epoch.
          </p>
        </div>
      </section>
    </div>
  );
}
