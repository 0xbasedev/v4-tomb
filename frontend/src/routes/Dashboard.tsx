import { StatTile } from "@/components/StatTile";
import { FeaturedTile } from "@/components/FeaturedTile";
import { PhaseBanner } from "@/components/PhaseBanner";
import { RuleTrio } from "@/components/RuleTrio";

/**
 * Dashboard — "The Ledger." Live operating state of the Trust.
 *
 * Layout zones (centered axis, formal voice):
 *   1. Hero: section header + rule trio
 *   2. PhaseBanner: declarative phase indicator (Bootstrap / Expansion / Contraction / Rest)
 *   3. Featured metric row — MONEY price + peg in a 2/3-width feature tile, plus a
 *      smaller epoch countdown tile in the remaining column
 *   4. Supply ledger — 4-up grid of MONEY/ESTATE/TRUSTNOTE/Treasury reserve tiles
 *   5. Mechanism state — 4-up grid of bond rate, premium rate, contraction headroom,
 *      next epoch action
 *   6. Recent epochs table (placeholder rows — wired in Sprint B)
 *
 * All values are PLACEHOLDERS until Sprint B wires wagmi reads against deployed
 * contracts (Oracle.consult, Treasury.epoch, money.totalSupply, trustnote.totalSupply,
 * etc).
 */

// Recent epochs table — placeholder data; replaced by event log reads in Sprint B.
const RECENT_EPOCHS: { epoch: string; price: string; action: string; supply: string }[] = [
  { epoch: "I", price: "1.0000", action: "Genesis Distribution", supply: "160,001" },
];

export function Dashboard() {
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
        </div>
      </section>

      {/* ===== Phase indicator ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <PhaseBanner phase="bootstrap" detail="Epoch I of XXVIII" />
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
              value="1.0000"
              unit="ETH"
              badge="Within The Band"
              badgeTone="gold"
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
                    Twenty-Four Hour Trace · Coming Soon
                  </div>
                </div>
              }
            />
            <div className="flex flex-col gap-5">
              <StatTile label="Epoch" value="I" hint="The First Cycle" />
              <StatTile label="Next Epoch" value="06:00:00" hint="HH : MM : SS" />
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
            <StatTile label="MONEY · Circulating" value="160,001" hint="Total Outstanding" />
            <StatTile label="MONEY · Treasury" value="0" hint="Reserve · Held by Treasury" />
            <StatTile label="ESTATE · Outstanding" value="70,001" hint="Hard Cap 70,000 + Seed" />
            <StatTile label="ESTATE · in The Club" value="0" hint="Staked at Boardroom" />
            <StatTile label="Trust Notes · Outstanding" value="0" hint="No Issuance Yet" />
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
            <StatTile label="Bond Premium" value="—" hint="Only Above 1.10 ETH" />
            <StatTile label="Contraction Headroom" value="0" hint="MONEY · Burnable This Epoch" />
            <StatTile label="Tax Rate · This Tier" value="15.00%" hint="Tier VII · At Peg" />
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
                {RECENT_EPOCHS.map((row, i) => (
                  <tr key={i} className="border-b border-deco-gold/15 last:border-b-0">
                    <td className="font-ornament px-5 py-4 text-deco-gold" style={{ letterSpacing: "0.2em" }}>
                      {row.epoch}
                    </td>
                    <td className="font-display px-5 py-4 text-lg text-deco-ivory">{row.price}</td>
                    <td className="px-5 py-4 font-body text-base italic text-deco-ivory-soft">{row.action}</td>
                    <td className="font-display px-5 py-4 text-right text-lg text-deco-ivory">{row.supply}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-6 text-center font-body text-sm italic text-deco-gold-dark">
            Records update with each epoch. Live event reads arrive with the wiring sprint.
          </p>
        </div>
      </section>
    </div>
  );
}
