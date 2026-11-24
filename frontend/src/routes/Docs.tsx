import { Link } from "react-router-dom";

import { RuleTrio } from "@/components/RuleTrio";

/**
 * Docs — player-facing protocol documentation.
 *
 * NOT the auditor doc (docs/AUDIT_HANDOFF.md) and NOT the operator runbook
 * (docs/LAUNCH_RUNBOOK.md). This is the "how do I play" answer for anyone
 * landing on the site.
 *
 * Voice: formal Art Deco. Honest about risk. Concrete actions, not vibes.
 *
 * Structure:
 *   - 60-second summary
 *   - The Three xSHARE ($xTOMB, $xSHARE, $BOND)
 *   - How to Begin (the three entry paths)
 *   - The Liquidity Loop (mint→wrap→stake→exit)
 *   - xROOM (xSHARE staking)
 *   - The Bond Office (Bonds)
 *   - The Treasury Cycle (epochs, expansion, contraction)
 *   - Peg Defense (hook + TWAP-keyed sell tax)
 *   - Risks (honest)
 *   - Glossary
 */

const TOC: { id: string; label: string }[] = [
  { id: "summary", label: "In Sixty Seconds" },
  { id: "tokens", label: "The Two Tokens" },
  { id: "begin", label: "How to Begin" },
  { id: "liquidity", label: "Providing Liquidity" },
  { id: "cycle", label: "The Treasury Cycle" },
  { id: "tax", label: "The Sell Tax" },
  { id: "risks", label: "Risks" },
  { id: "glossary", label: "Glossary" },
];

export function Docs() {
  return (
    <div className="bg-deco-ground">
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">How It Works</div>
          <h1 className="gold-text font-display italic text-section">The Mechanism</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            Two tokens, three places to put them, and one rule that holds the
            peg. Written for the participant, not the auditor.
          </p>
        </div>
      </section>

      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-3xl">
          <div className="deco-panel">
            <div className="label-deco mb-3 text-deco-gold-dark text-center">Contents</div>
            <ul className="grid grid-cols-1 gap-2 text-left md:grid-cols-2">
              {TOC.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    className="font-display text-base italic text-deco-ivory transition-colors hover:text-deco-gold"
                  >
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <Section id="summary" title="In Sixty Seconds">
        <P>
          <Token>$xTOMB</Token> is built to trade at one unit of its paired
          asset. When it trades above that, the Treasury mints new xTOMB and
          pays it to stakers in xROOM. When it trades at or below, the
          Treasury mints nothing. There are no bonds and no debt: the protocol
          never owes anyone before it can expand again.
        </P>
        <P>
          Selling xTOMB or <Token>$xSHARE</Token> for the paired asset pays a
          sell tax of at most 12%. Buying is never taxed, and neither is
          staking or providing liquidity.
        </P>
      </Section>

      <Section id="tokens" title="The Two Tokens">
        <Three
          a={{
            title: "$xTOMB",
            sub: "The Pegged Token",
            body: "Targets a one-to-one price with its paired asset. New supply is minted only when the time-weighted price is above the ceiling, and it goes to xROOM.",
          }}
          b={{
            title: "$xSHARE",
            sub: "The Share Token",
            body: "Fixed supply, released over time to the farms. Its sell tax is collected in the paired asset, used to buy xTOMB, and that xTOMB is burned.",
          }}
          c={{
            title: "LP Positions",
            sub: "What You Stake",
            body: "Liquidity positions are wrapped into tokens you can stake: in The Farms to earn xSHARE, or in xROOM to earn newly minted xTOMB.",
          }}
        />
      </Section>

      <Section id="begin" title="How to Begin">
        <Path
          numeral="I"
          title="Genesis"
          condition="Open for 24 hours, before the first epoch."
          steps={[
            "Visit /farms while Genesis is open and deposit an accepted asset",
            "Earn xTOMB for the duration of the window",
            "Withdraw at any time",
          ]}
        />
        <Path
          numeral="II"
          title="The Farms"
          condition="You want to earn xSHARE."
          steps={[
            "Provide full-range liquidity to the xTOMB pool or the xSHARE pool",
            "Wrap the position on /farms and stake it",
            "Claim xSHARE as it accrues",
          ]}
        />
        <Path
          numeral="III"
          title="xROOM"
          condition="You want a share of every expansion."
          steps={[
            "Provide xTOMB and xSHARE to the staking pool, which cannot be traded",
            "Stake the position on /masonry",
            "Claim xTOMB after each epoch in which the Treasury mints",
          ]}
        />
      </Section>

      <Section id="liquidity" title="Providing Liquidity">
        <P>
          Positions on Uniswap V4 are individual NFTs, so the protocol wraps a
          full-range position into an ordinary token before it can be staked.
          Unwrapping returns the same position.
        </P>
        <SubHeading>The Staking Pool</SubHeading>
        <P>
          The xTOMB and xSHARE pool used by xROOM rejects every swap. Its
          ratio never moves, so you withdraw exactly what you deposited, with
          no fees and no impermanent loss. Depositing and withdrawing are not
          taxed.
        </P>
      </Section>

      <Section id="cycle" title="The Treasury Cycle">
        <P>
          Every six hours the Treasury reads the time-weighted price of xTOMB.
          Genesis finishes before the first epoch, and no epoch pays a
          guaranteed emission.
        </P>
        <Three
          a={{
            title: "Above the Ceiling",
            sub: "price > 1.01",
            body: "The Treasury mints xTOMB in proportion to how far the price is above one, up to a cap set by supply. A configured cut goes to the DAO and development wallets; the rest goes to xROOM.",
          }}
          b={{
            title: "At or Below",
            sub: "price ≤ 1.01",
            body: "Nothing is minted. Nothing is owed. The next epoch above the ceiling expands in full.",
          }}
          c={{
            title: "No Balance Held",
            sub: "always",
            body: "The Treasury contract holds no funds. What it mints leaves in the same transaction, and tax proceeds go to the DAO wallet, never to the Treasury.",
          }}
        />
      </Section>

      <Section id="tax" title="The Sell Tax">
        <P>
          The rate is set by the time-weighted price of xTOMB, so it cannot be
          dodged by moving the price for a moment. It never exceeds 12%, which
          is the most the contract can charge. From 1.12 it is 6%, and from
          1.20 it is 3%. A higher rate applies at once; a lower rate applies
          only after it has been due for seven hours.
        </P>
        <P>
          Tax on xTOMB sales is burned while the price is below 1.10 and sent
          to the DAO wallet above it. Tax on xSHARE sales buys xTOMB, and that
          xTOMB is burned. The schedule is shown live on /swap.
        </P>
      </Section>

      <Section id="risks" title="Risks">
        <P className="text-deco-ruby">
          This is an experimental algorithmic design. Nothing backs xTOMB but
          the mechanism described here. It has not been audited.
        </P>
        <Risk
          title="The Peg Can Break"
          body="If confidence leaves, xTOMB can trade below its target for a long time. With no bonds there is no built-in buyer below the peg; recovery relies on the sell-tax burn and on demand returning."
        />
        <Risk
          title="The Price Is an Average"
          body="The Treasury and the tax both read a time-weighted price. In a fast market they react to where the price has been, not to where it is."
        />
        <Risk
          title="Other Markets Are Untaxed"
          body="The tax applies only in the protocol's own pools. Tokens traded elsewhere pay nothing, and rewards are paid only for liquidity in the official pools."
        />
      </Section>

      <Section id="glossary" title="Glossary">
        <Term term="Epoch" body="A six-hour period. The Treasury acts once per epoch." />
        <Term term="Ceiling" body="The price (1.01 by default) above which the Treasury mints." />
        <Term term="TWAP" body="Time-weighted average price, measured from the protocol's own pool." />
        <Term term="Hook" body="A Uniswap V4 contract that runs on every swap in one specific pool. The protocol uses hooks to collect the sell tax and to make the staking pool untradeable." />
        <Term term="Burn Threshold" body="The price (1.10 by default) below which xTOMB sell tax is burned rather than sent to the DAO wallet." />

        <section className="px-6 py-12 md:px-12 md:py-16">
          <div className="mx-auto max-w-3xl text-center">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link to="/dashboard" className="btn-deco">Dashboard</Link>
              <Link to="/farms" className="btn-deco">The Farms</Link>
              <Link to="/masonry" className="btn-deco">xROOM</Link>
              <Link to="/swap" className="btn-deco">Swap</Link>
            </div>
          </div>
        </section>
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="px-6 pb-14 md:px-12 md:pb-16">
      <div className="mx-auto max-w-3xl">
        <div className="deco-panel">
          <div className="label-deco mb-3 text-deco-gold-dark text-center">{toNumeral(id)}</div>
          <h2
            className="mb-3 text-center font-display text-3xl italic text-deco-ivory md:text-4xl"
            style={{ letterSpacing: "0.06em" }}
          >
            {title}
          </h2>
          <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <div className="text-left">{children}</div>
        </div>
      </div>
    </section>
  );
}

function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`mb-4 font-body text-base italic text-deco-ivory-soft md:text-lg ${className}`}>
      {children}
    </p>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="mb-2 mt-6 font-display text-xl italic text-deco-gold md:text-2xl"
      style={{ letterSpacing: "0.05em" }}
    >
      {children}
    </h3>
  );
}

function Token({ children }: { children: React.ReactNode }) {
  return <span className="font-ornament text-deco-gold">{children}</span>;
}

function Three({
  a,
  b,
  c,
}: {
  a: { title: string; sub: string; body: string };
  b: { title: string; sub: string; body: string };
  c: { title: string; sub: string; body: string };
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {[a, b, c].map((x) => (
        <div key={x.title} className="border-l-2 border-deco-gold/40 pl-4">
          <div
            className="font-ornament text-base text-deco-gold"
            style={{ letterSpacing: "0.15em" }}
          >
            {x.title}
          </div>
          <div className="label-deco mb-2 text-deco-gold-dark">{x.sub}</div>
          <p className="font-body text-sm italic text-deco-ivory-soft">{x.body}</p>
        </div>
      ))}
    </div>
  );
}

function Path({
  numeral,
  title,
  condition,
  steps,
}: {
  numeral: string;
  title: string;
  condition: string;
  steps: string[];
}) {
  return (
    <div className="mb-5 border-l-2 border-deco-gold/40 pl-5">
      <div className="flex items-baseline gap-3">
        <span className="font-ornament text-lg text-deco-gold" style={{ letterSpacing: "0.2em" }}>
          {numeral}
        </span>
        <span
          className="font-display text-xl italic text-deco-ivory"
          style={{ letterSpacing: "0.05em" }}
        >
          {title}
        </span>
      </div>
      <p className="mb-2 font-body text-sm italic text-deco-gold-dark">{condition}</p>
      <ol className="ml-4 list-decimal font-body text-sm italic text-deco-ivory-soft">
        {steps.map((s, i) => (
          <li key={i} className="mb-1">{s}</li>
        ))}
      </ol>
    </div>
  );
}

function Risk({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-4 border border-deco-ruby/30 bg-deco-ruby/5 p-4">
      <div className="label-deco mb-1 text-deco-ruby">{title}</div>
      <p className="font-body text-sm italic text-deco-ivory-soft">{body}</p>
    </div>
  );
}

function Term({ term, body }: { term: string; body: string }) {
  return (
    <div className="mb-3 border-l border-deco-gold/30 pl-4">
      <span
        className="font-ornament text-base text-deco-gold"
        style={{ letterSpacing: "0.1em" }}
      >
        {term}
      </span>
      <p className="font-body text-sm italic text-deco-ivory-soft">{body}</p>
    </div>
  );
}

/** Map TOC ids to Roman numerals for section headings. */
function toNumeral(id: string): string {
  const idx = TOC.findIndex((t) => t.id === id);
  const numerals = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  return idx >= 0 ? numerals[idx] : "·";
}
