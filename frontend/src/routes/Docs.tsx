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
 *   - The Three Estates ($MONEY, $ESTATE, $TRUSTNOTE)
 *   - How to Begin (the three entry paths)
 *   - The Liquidity Loop (mint→wrap→stake→exit)
 *   - The Club (ESTATE staking)
 *   - The Bond Office (Trust Notes)
 *   - The Treasury Cycle (epochs, expansion, contraction)
 *   - Peg Defense (hook + 14-tier tax)
 *   - Risks (honest)
 *   - Glossary
 */

const TOC: { id: string; label: string }[] = [
  { id: "summary", label: "In Sixty Seconds" },
  { id: "estates", label: "The Three Estates" },
  { id: "begin", label: "How to Begin" },
  { id: "loop", label: "The Liquidity Loop" },
  { id: "club", label: "The Club" },
  { id: "bonds", label: "The Bond Office" },
  { id: "cycle", label: "The Treasury Cycle" },
  { id: "defense", label: "Peg Defense" },
  { id: "risks", label: "Risks" },
  { id: "glossary", label: "Glossary" },
];

export function Docs() {
  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            The Field Guide · How to Play
          </div>
          <h1 className="gold-text font-display italic text-section">The Mechanism</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            A complete primer on the three tokens, the four user paths, and the
            mechanical loops that hold the peg. Written for the participant, not
            the auditor.
          </p>
        </div>
      </section>

      {/* ===== TOC ===== */}
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

      {/* ===== In Sixty Seconds ===== */}
      <Section id="summary" title="In Sixty Seconds">
        <P>
          Old Money is an algorithmic stable protocol where <Token>$MONEY</Token>
          is pegged 1:1 to <Token>WETH</Token>. The peg is held by three forces:
          a Uniswap V4 swap hook that taxes sells when MONEY trades below par; a
          Treasury that mints fresh MONEY to <Token>$ESTATE</Token> stakers when
          MONEY trades above par; and a bond office that issues{" "}
          <Token>$TRUSTNOTE</Token> at a discount when MONEY is depressed and
          redeems them at a premium when MONEY recovers.
        </P>
        <P>
          Participants enter through Genesis, the 24-hour bootstrap pool, or by
          providing MONEY-WETH liquidity to one of two reward pools. Holders of
          ESTATE stake in The Club to receive a share of every expansion epoch's
          seigniorage. Speculators trade the bond market on the difference
          between depressed and recovered prices.
        </P>
      </Section>

      {/* ===== The Three Estates ===== */}
      <Section id="estates" title="The Three Estates">
        <Three
          a={{
            title: "$MONEY",
            sub: "The Stable",
            body: "Pegged 1:1 to WETH. Used as collateral, in swaps, and burned in exchange for Trust Notes. Distributed at deploy across the reward pools and an airdrop allocation; minted further by the Treasury during expansion epochs.",
          }}
          b={{
            title: "$ESTATE",
            sub: "The Share",
            body: "Hard-capped at 70,000. Earned by providing MONEY-WETH liquidity (Share Pool, 370 days). Stake in The Club to receive a pro-rata cut of every expansion epoch's freshly-minted MONEY. The longer the stake, the deeper the role.",
          }}
          c={{
            title: "$TRUSTNOTE",
            sub: "The Bond",
            body: "Issued when MONEY trades below par. Burn MONEY at the Treasury to mint Notes. Hold until MONEY trades above the premium threshold (1.10 ETH), then present the Notes for more MONEY than you originally burned. A wager on recovery.",
          }}
        />
      </Section>

      {/* ===== How to Begin ===== */}
      <Section id="begin" title="How to Begin">
        <P>
          Four paths in. Pick the one that matches what you hold and how patient
          you are.
        </P>
        <Path
          numeral="I"
          title="The Founder"
          condition="You hold ETH and want to enter at launch."
          steps={[
            "Wrap your ETH to WETH",
            "Visit /vault during the 24-hour Genesis Window and deposit",
            "Earn MONEY pro-rata over the window's duration",
            "Withdraw your WETH + claim MONEY when the window closes",
          ]}
        />
        <Path
          numeral="II"
          title="The Provider of Liquidity"
          condition="You hold MONEY and ETH and want to earn yield."
          steps={[
            "On /vault Main, mint a full-range MONEY-WETH liquidity position",
            "Wrap the resulting V4 LP NFT into ERC-20 share certificates",
            "Stake the certificates in the Main Pool to earn MONEY (9 days) or Share Pool to earn ESTATE (370 days)",
            "Withdraw, unwrap, and burn the position to reclaim your underlying assets",
          ]}
        />
        <Path
          numeral="III"
          title="The Member"
          condition="You hold ESTATE and want a share of every expansion."
          steps={[
            "Visit /club and stake your ESTATE in the Boardroom",
            "Wait through the six-epoch withdraw lockup and three-epoch reward lockup",
            "Each expansion epoch, claim your share of freshly-minted MONEY",
            "Withdraw your ESTATE when you are done",
          ]}
        />
        <Path
          numeral="IV"
          title="The Bondholder"
          condition="You believe MONEY's peg will recover."
          steps={[
            "Watch /notes for the Acquisition Open state (MONEY below 1.00 WETH)",
            "Burn MONEY in exchange for TRUSTNOTE at the current discount rate",
            "Wait for MONEY to recover above 1.10 WETH (the premium threshold)",
            "Present TRUSTNOTE for MONEY at the recovered premium rate",
          ]}
        />
      </Section>

      {/* ===== The Liquidity Loop ===== */}
      <Section id="loop" title="The Liquidity Loop">
        <P>
          The Main and Share reward pools accept only the wrapper's ERC-20
          share certificates — not raw V4 LP NFTs. The full loop is six steps,
          three to enter and three to exit:
        </P>
        <Loop
          steps={[
            { dir: "in", title: "Mint", body: "Provide MONEY + WETH at the pool's current ratio. Receive a full-range V4 LP NFT in your wallet (Uniswap V4 standard, ERC-721)." },
            { dir: "in", title: "Wrap", body: "Approve the V4PositionWrapper to take your NFT. The wrapper validates the exact full-range tick range, then mints you ERC-20 shares equal to your position's liquidity." },
            { dir: "in", title: "Stake", body: "Approve the reward pool to spend your shares. Deposit. Begin accruing MONEY (Main) or ESTATE (Share)." },
            { dir: "out", title: "Withdraw", body: "Withdraw your shares from the pool. Any pending rewards are claimed automatically. Wrapper shares return to your wallet." },
            { dir: "out", title: "Unwrap", body: "Burn your wrapper shares. Receive the original V4 LP NFT back. Only the original wrapper can unwrap." },
            { dir: "out", title: "Burn", body: "Submit the NFT to the V4 PositionManager. Receive your MONEY + WETH back, less any swap fees the position absorbed during its lifetime." },
          ]}
        />
      </Section>

      {/* ===== The Club ===== */}
      <Section id="club" title="The Club">
        <P>
          The Club is what the protocol calls its Boardroom — the contract that
          receives every expansion epoch's freshly-minted MONEY and distributes
          it pro-rata to ESTATE stakers.
        </P>
        <P>
          Two timelocks govern member behavior. The <strong>withdraw lockup</strong>{" "}
          (six epochs, thirty-six hours) blocks you from removing staked ESTATE
          for that window after any deposit, withdraw, or claim. The{" "}
          <strong>reward lockup</strong> (three epochs, eighteen hours) blocks
          claiming the most recent expansion's MONEY for that window. Both
          counters reset on every interaction. The Trust does not reward
          impatience.
        </P>
        <P>
          Mechanically: when the Treasury enters an expansion epoch, it mints
          MONEY directly to the Boardroom and calls{" "}
          <code className="font-ornament text-deco-gold">
            boardroom.allocateSeigniorage(amount)
          </code>
          . The Boardroom records a per-share snapshot. When you call{" "}
          <code className="font-ornament text-deco-gold">claimReward()</code> the
          contract computes your earned amount as{" "}
          <code className="font-ornament text-deco-gold">
            stake × (latestSnapshot.rewardPerShare − yourLastSnapshot)
          </code>
          .
        </P>
      </Section>

      {/* ===== Bond Office ===== */}
      <Section id="bonds" title="The Bond Office">
        <P>
          The bond market activates only outside the peg band. There are two
          sides — acquisition (below par) and presentation (above premium) —
          and each has hard caps the Treasury enforces on every call.
        </P>
        <SubHeading>Acquisition (price &lt; 1.00 WETH per MONEY)</SubHeading>
        <P>
          When MONEY trades below par, the Treasury issues TRUSTNOTE at a
          discount. Burn N MONEY, receive N × discount rate TRUSTNOTE. The
          discount is set by{" "}
          <code className="font-ornament text-deco-gold">discountPercent</code> on
          the Treasury and defaults to zero (1:1 exchange) at deploy. Two hard
          caps gate each call:
        </P>
        <ul className="mb-4 ml-6 list-disc font-body text-base italic text-deco-ivory-soft">
          <li>
            <strong>Epoch contraction cap</strong> — at most 3% of circulating
            supply can be burned per epoch (
            <code className="font-ornament text-deco-gold">
              maxSupplyContractionPercent
            </code>
            ).
          </li>
          <li>
            <strong>Debt ratio cap</strong> — outstanding TRUSTNOTE may not
            exceed 35% of MONEY supply (
            <code className="font-ornament text-deco-gold">
              maxDebtRatioPercent
            </code>
            ).
          </li>
        </ul>
        <SubHeading>Presentation (price ≥ 1.10 WETH per MONEY)</SubHeading>
        <P>
          When MONEY recovers above the premium threshold, the Treasury redeems
          TRUSTNOTE at a premium. Present N TRUSTNOTE, receive N × premium rate
          MONEY. The premium is computed from how far above peg the price is, up
          to a configurable cap. The Treasury must hold sufficient MONEY reserve
          (the{" "}
          <code className="font-ornament text-deco-gold">seigniorageSaved</code>{" "}
          accumulated from prior expansion epochs).
        </P>
        <SubHeading>The Strict Price Match</SubHeading>
        <P>
          Both calls require the price you read at click time to match the price
          observed when the transaction includes. If the oracle updates between
          your read and your broadcast, the Treasury reverts with{" "}
          <code className="font-ornament text-deco-gold">PriceMoved</code>. You
          keep your MONEY (or TRUSTNOTE); only gas is spent. Retry on the next
          oracle observation.
        </P>
      </Section>

      {/* ===== Treasury Cycle ===== */}
      <Section id="cycle" title="The Treasury Cycle">
        <P>
          The protocol's heartbeat is the Treasury's <strong>epoch</strong> — a
          six-hour window. At each epoch boundary, anyone may call{" "}
          <code className="font-ornament text-deco-gold">
            treasury.allocateSeigniorage()
          </code>{" "}
          and the Treasury executes its expansion or contraction logic. In
          practice a keeper bot fires this every thirty minutes.
        </P>
        <Three
          a={{
            title: "Bootstrap",
            sub: "Epochs 0 – 27",
            body: "Unconditional expansion. The Treasury mints 4.5% of circulating supply each epoch and routes it to The Club regardless of price. Seven days. This period is load-bearing — it incentivizes early staking so that subsequent oracle-driven expansion has somewhere to land.",
          }}
          b={{
            title: "Expansion",
            sub: "price ≥ 1.01 WETH",
            body: "Above the ceiling. Treasury mints fresh MONEY scaled by the price premium. Either funds the seigniorage reserve (for future bond redemptions) or routes to The Club, depending on whether outstanding bonds need backing. DaoFund and DevFund take their configured cuts.",
          }}
          c={{
            title: "Contraction",
            sub: "price < 1.00 WETH",
            body: "Below par. No new MONEY is minted. The bond office accepts MONEY burns in exchange for TRUSTNOTE. The hook taxes MONEY sells per the 14-tier schedule. Both mechanisms work to retire supply and rebuild scarcity.",
          }}
        />
      </Section>

      {/* ===== Peg Defense ===== */}
      <Section id="defense" title="Peg Defense">
        <P>
          Every swap on MONEY-WETH passes through the PegDefenseHook. The hook
          serves three roles in one call:
        </P>
        <ol className="mb-4 ml-6 list-decimal font-body text-base italic text-deco-ivory-soft">
          <li>
            <strong>Observation.</strong> The hook records each swap's pre-trade
            tick and timestamp. The Oracle reads these accumulating values to
            compute a time-weighted average price.
          </li>
          <li>
            <strong>Dynamic LP fee.</strong> The hook adjusts the pool's swap
            fee based on how far the current tick is from the peg tick. Cheaper
            to trade when MONEY is moving toward par; more expensive when it is
            drifting.
          </li>
          <li>
            <strong>Sell-side tax.</strong> When the operator enables{" "}
            <code className="font-ornament text-deco-gold">autoCalculateTax</code>{" "}
            and MONEY trades below par, the hook intercepts MONEY sells and
            takes a slice per the 14-tier schedule. Below the burn threshold
            (1.10 WETH), the slice is destroyed outright; above, it accrues to
            the Treasury reserve.
          </li>
        </ol>
        <SubHeading>The Fourteen Tiers</SubHeading>
        <P>
          The tax schedule was ported directly from Tomb Finance's BOMB token,
          one of the more battle-tested algorithmic-stable peg-defense
          structures. Below par, the rate climbs steeply: 1% just under one
          ETH, 15% at par, 22% near 0.40 ETH, 30% in the deepest contraction.
          The schedule's full table is rendered live on /swap when MONEY-WETH is
          selected.
        </P>
      </Section>

      {/* ===== Risks ===== */}
      <Section id="risks" title="Risks">
        <P className="text-deco-ruby">
          Algorithmic stables are speculative instruments. The peg holds while
          the mechanism's incentives outweigh the participants' willingness to
          exit. When confidence breaks, peg can break with it. Old Money is the
          experiment, not the guarantee.
        </P>
        <Risk
          title="Bond Death Spiral"
          body="The classic algorithmic-stable failure mode. If MONEY trades far below par and bond buyers stop believing in eventual recovery, no one burns MONEY to mint Notes. Supply doesn't retire. Price drifts further down. Tomb hit this in mid-2022. Mitigations: the hook's burn-on-sell removes supply even without bond demand; the 14-tier tax scales steeply downward to drain exit pressure."
        />
        <Risk
          title="Bootstrap Drift"
          body="The first 28 epochs (seven days) mint unconditionally. If demand for ESTATE is weak in this window, the resulting MONEY supply can exceed market appetite and push price below par before the price-aware mechanisms activate at epoch 29. Mitigations: Genesis pool gives early participants a first-mover advantage; the protocol launches with the 1-ESTATE construction mint to seed Boardroom from day one."
        />
        <Risk
          title="Oracle Lag"
          body="The TWAP oracle reports a moving average, not the spot price. In fast-moving markets, the bond office and tax mechanism react to where price was, not where it is. A sudden dump can mint cheap bonds at a lagged price; a sudden rally can let sellers escape the tax. Mitigations: oracle updates every six hours via the same allocateSeigniorage call that ticks the epoch."
        />
        <Risk
          title="Operator Risk (pre-rotation)"
          body="At deploy, all admin powers (setting tax tiers, fund cut percentages, governance addresses) sit with the deployer EOA. The launch runbook calls for rotating these to a 24-hour Timelock before mainnet. Until rotation, the deployer can change parameters within the contracts' declared bounds. Verify the rotation has happened on /admin's Rotation Status panel."
        />
        <Risk
          title="V4 Newness"
          body="Uniswap V4 launched in early 2025; the contract surface and tooling are less battle-tested than V2 or V3. The PoolManager itself has been audited extensively, but the hooks ecosystem is young, and integration patterns are still emerging. Our hook is purpose-built and tested, but novel attack surfaces are easier to find in newer systems."
        />
      </Section>

      {/* ===== Glossary ===== */}
      <Section id="glossary" title="Glossary">
        <Term term="Epoch" body="A six-hour window. The Treasury ticks at each boundary, advancing the epoch counter and executing expansion or contraction logic." />
        <Term term="Seigniorage" body="Newly-minted MONEY distributed during expansion epochs. Routed primarily to The Club, with optional cuts to the daoFund and devFund." />
        <Term term="Bootstrap" body="The first 28 epochs (seven days) after deploy. Unconditional 4.5% expansion regardless of price, to seed Boardroom and establish initial economy." />
        <Term term="Hook" body="A Uniswap V4 contract that runs on every swap of a specific pool. Old Money's PegDefenseHook handles observation, dynamic fees, and the sell-side tax." />
        <Term term="The Club / Boardroom" body="The contract that holds staked ESTATE and distributes seigniorage. Same thing, two names — the contract is named Boardroom for auditor familiarity; the user-facing label is The Club." />
        <Term term="TWAP" body="Time-Weighted Average Price. The oracle reports this rather than spot, smoothing short-term volatility. Computed from the hook's accumulated tick observations." />
        <Term term="V4 LP NFT" body="An ERC-721 representing a Uniswap V4 liquidity position. Holds the position's exact tick range and accumulated fees. Not directly stake-able in our reward pools — must be wrapped first." />
        <Term term="Wrapper Shares" body="ERC-20 tokens minted 1:1 with V4 LP NFT liquidity by the V4PositionWrapper. Stake-able in Main and Share pools." />
        <Term term="Debt Ratio" body="Outstanding TRUSTNOTE divided by MONEY supply. The Treasury caps this at 35% to prevent runaway bond issuance during prolonged contraction." />
        <Term term="Burn Threshold" body="The price (default 1.10 WETH per MONEY) above which the hook's tax accrues to Treasury reserve. Below the threshold, the tax is burned outright." />
      </Section>

      {/* ===== CTAs ===== */}
      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-3xl">
          <div className="deco-panel text-center">
            <div className="label-deco mb-3 text-deco-gold-dark">Ready</div>
            <h2
              className="mb-4 font-display text-3xl italic text-deco-ivory md:text-4xl"
              style={{ letterSpacing: "0.06em" }}
            >
              Enter The Trust
            </h2>
            <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
            <p className="mx-auto mb-8 max-w-xl font-body text-base italic text-deco-ivory-soft">
              The mechanism is here for you to participate in. Pick a path.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link to="/dashboard" className="btn-deco">The Ledger</Link>
              <Link to="/vault" className="btn-deco">The Vault</Link>
              <Link to="/club" className="btn-deco">The Club</Link>
              <Link to="/notes" className="btn-deco">Trust Notes</Link>
              <Link to="/swap" className="btn-deco">The Exchange</Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ===========================================================
   Composition helpers
   =========================================================== */

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

function Loop({
  steps,
}: {
  steps: { dir: "in" | "out"; title: string; body: string }[];
}) {
  const inSteps = steps.filter((s) => s.dir === "in");
  const outSteps = steps.filter((s) => s.dir === "out");
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div>
        <div className="label-deco mb-3 text-deco-emerald">Going In</div>
        {inSteps.map((s, i) => (
          <LoopStep key={s.title} numeral={String(i + 1)} title={s.title} body={s.body} />
        ))}
      </div>
      <div>
        <div className="label-deco mb-3 text-deco-ruby">Going Out</div>
        {outSteps.map((s, i) => (
          <LoopStep key={s.title} numeral={String(i + 1)} title={s.title} body={s.body} />
        ))}
      </div>
    </div>
  );
}

function LoopStep({ numeral, title, body }: { numeral: string; title: string; body: string }) {
  return (
    <div className="mb-3 border-l border-deco-gold/30 pl-4">
      <div className="flex items-baseline gap-2">
        <span className="font-ornament text-sm text-deco-gold">{numeral}</span>
        <span className="font-display text-base italic text-deco-ivory">{title}</span>
      </div>
      <p className="font-body text-sm italic text-deco-ivory-soft">{body}</p>
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
