import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { networks } from "../lib/networks";
import { Gauge } from "./Gauge";
import { AdminPage, BridgePage, WizardPage } from "./setup/SetupPages";
import { durationDays, lpDay, percent, policy, sampleTargetBps, tiers } from "./policy";

const routes = [
  ["/dashboard", "Dashboard"], ["/genesis", "Genesis"], ["/farm", "Farm"],
  ["/masonry", "Masonry"], ["/swap", "Swap"], ["/bridge", "Bridge"], ["/docs", "Docs"], ["/admin", "Admin"],
] as const;

function Wallet() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, isError } = useConnect();
  const { disconnect } = useDisconnect();
  const { chains, switchChain, isPending: switching, isError: switchError } = useSwitchChain();
  return (
    <div className="wallet">
      {isConnected && address ? (
        <>
          <select aria-label="Network" value={chains.some((chain) => chain.id === chainId) ? chainId : ""}
            disabled={switching} onChange={(event) => switchChain({ chainId: Number(event.target.value) })}>
            <option value="" disabled>Select network</option>
            {chains.map((chain) => <option key={chain.id} value={chain.id}>{chain.name}</option>)}
          </select>
          <button className="button wallet-address" type="button" aria-label="Disconnect wallet" onClick={() => disconnect()}>
            {address.slice(0, 6)}…{address.slice(-4)}
          </button>
        </>
      ) : (
        <button className="button" type="button" disabled={isPending || !connectors[0]}
          onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
      )}
      {(isError || switchError) && <span className="wallet-error" role="alert">Check your wallet and try again.</span>}
    </div>
  );
}

function Layout() {
  const { pathname } = useLocation();
  const activeChain = useChainId();
  const account = useAccount();
  const network = networks.find(({ id }) => id === (account.isConnected ? account.chainId : activeChain));
  useEffect(() => {
    const title = pathname === "/wizard" ? "Setup Wizard" : routes.find(([path]) => path === pathname)?.[1];
    document.title = title ? `${title} · xTOMB` : "xTOMB";
  }, [pathname]);
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="top">
        <div className="shell top-inner">
          <Link className="brand" to="/" aria-label="xTOMB home"><img src="/favicon.svg" alt="" /><span><em>x</em>TOMB</span></Link>
          <nav className="nav" aria-label="Main navigation">
            {routes.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
          </nav>
          <Wallet />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="shell content">
        <div className="network-note" role="status"><span aria-hidden="true" />{network
          ? `${network.name} has no protocol deployment configured for xTOMB. Transactions are unavailable.`
          : "Your wallet is on an unsupported network. Select a configured network to continue."}</div>
        <Outlet />
      </main>
      <footer className="shell footer"><Link to="/" className="brand"><em>x</em>TOMB</Link><span>xTOMB and xSHARE on Uniswap v4</span><Link to="/docs">Protocol guide</Link></footer>
    </>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return <header className="page-heading"><h1>{title}</h1><p>{children}</p></header>;
}

function Stats({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return <dl className="stats">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function GaugePanel({ sample }: { sample?: number }) {
  return <section className="panel gauge-panel" aria-label="xTOMB peg monitor">
    <div className="gauge-label"><span><i /> xTOMB peg monitor</span><span className="chip">{sample === undefined ? "Reference" : "Simulation"}</span></div>
    <Gauge sample={sample} />
    <Stats items={[["Target", "$1.00"], ["Expansion gate", `>$${(policy.requiresFreshTwapStrictlyAbovePegBps / 10_000).toFixed(2)}`],
      ["Defense threshold", `≤$${(policy.criticalDefenseEntryBps / 10_000).toFixed(2)}`]]} />
  </section>;
}

function Landing() {
  return <>
    <section className="hero">
      <div className="hero-copy">
        <div className="chips"><span className="chip ember">Algorithmic peg</span><span className="chip">Uniswap v4</span></div>
        <h1><em>x</em>TOMB</h1>
        <p>xTOMB targets $1 in USDC. Genesis opens the first path into the protocol, with xTOMB/USDC liquidity staking from Day {lpDay}.</p>
        <div className="actions"><Link className="button primary" to="/dashboard">Open dashboard <span aria-hidden="true">↗</span></Link><Link className="button" to="/genesis">Explore Genesis</Link></div>
      </div>
      <GaugePanel />
    </section>
    <Link className="launch-strip panel" to="/genesis">
      <div><span className="label">Genesis</span><h2>{durationDays} days to build liquidity</h2></div>
      <div><span className="label">Official LP pool</span><strong>Opens Day {lpDay}</strong></div>
      <div><span className="label">Entry</span><strong>Genesis NFT</strong></div>
      <span className="launch-arrow" aria-hidden="true">↗</span>
    </Link>
    <section className="token-section" aria-label="Protocol assets">
      <article className="panel token-card ember"><span className="label">Peg asset</span><h2>xTOMB</h2><p>Genesis rewards and the USDC peg. Official sells use the Fire Tax.</p><Link to="/swap">Explore the swap desk <span aria-hidden="true">↗</span></Link></article>
      <article className="panel token-card spectre"><span className="label">Share asset</span><h2>xSHARE</h2><p>Official xSHARE/USDC sell fees fund protocol liquidity and Treasury reserves.</p><Link to="/masonry">See Treasury routing <span aria-hidden="true">↗</span></Link></article>
    </section>
  </>;
}

function Dashboard() {
  const [price, setPrice] = useState(10_000);
  return <>
    <Heading title="Dashboard">Inspect the peg, Genesis schedule and the protocol’s thresholds.</Heading>
    <div className="split">
      <GaugePanel sample={price / 10_000} />
      <section className="panel control-panel">
        <h2>Peg simulator</h2>
        <p>Move the price to see how the reference thresholds respond. The simulator uses sample values.</p>
        <label htmlFor="price">Sample xTOMB price <strong>${(price / 10_000).toFixed(4)}</strong></label>
        <input id="price" type="range" min="8000" max="12000" step="5" value={price} onChange={(event) => setPrice(Number(event.target.value))} />
        <div className="chips"><button className="button" type="button" onClick={() => setPrice(policy.criticalDefenseEntryBps)}>Defense</button><button className="button" type="button" onClick={() => setPrice(10000)}>At peg</button><button className="button" type="button" onClick={() => setPrice(policy.requiresFreshTwapStrictlyAbovePegBps + 100)}>Above gate</button></div>
        <p className="callout">{price <= policy.criticalDefenseEntryBps ? "At or below the Critical Defense threshold." : price > policy.requiresFreshTwapStrictlyAbovePegBps ? "Above the expansion price gate. A fresh, validated price is required on-chain." : "Inside the range between the defense and expansion thresholds."}</p>
      </section>
    </div>
  </>;
}

function Genesis() {
  return <>
    <Heading title="Genesis">A {durationDays}-day launch for Genesis NFT holders. The xTOMB/USDC LP pool opens {policy.genesisLpOpenDelaySeconds / 3600} hours after the start.</Heading>
    <Stats items={[["Duration", `${durationDays} days`], ["LP opens", `Day ${lpDay}`], ["LP emission share from Day 2", "75%"], ["LP deposit and compound fee", percent(policy.genesisLevelUsdcLpBurnFeeBps)]]} />
    <h2 className="section-title">Choose a Genesis pass</h2>
    <div className="tier-grid">{tiers.map((tier) => <article key={tier.name} className={`panel tier ${tier.tone}`}>
      <h3>{tier.name}</h3><div className="price">{tier.price} <span>USDC</span></div>
      <ul>{tier.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
      <button type="button" className="button" disabled>Mint {tier.name}</button>
    </article>)}</div>
    <div className="split below">
      <section className="panel"><h2>Standard staking</h2><p>Earn xTOMB from Day 1. After the official LP pool opens, standard staking receives the remaining 25% of scheduled emissions.</p></section>
      <section className="panel"><h2>xTOMB/USDC LP</h2><p>Deposit or compound from Day {lpDay} until Genesis ends. Only net shares earn rewards after the {percent(policy.genesisLevelUsdcLpBurnFeeBps)} LP fee.</p></section>
    </div>
  </>;
}

function Swap() {
  const [asset, setAsset] = useState<"xTOMB" | "xSHARE">("xTOMB");
  const [sell, setSell] = useState(true);
  const [genesis, setGenesis] = useState(true);
  const [twap, setTwap] = useState("1.0000");
  const [projected, setProjected] = useState("0.9500");
  const [recovery, setRecovery] = useState("1");
  const floor = asset === "xTOMB" ? policy.genesisLevelSellMinimumBps : policy.squareGenesisSellMinimumBps;
  const validPrices = [twap, projected].every((value) => value !== "" && Number(value) > 0 && Number(value) <= 10);
  const recoveryBps = Math.round(Number(recovery) * 100);
  const valid = validPrices && recovery !== "" && recoveryBps >= policy.fireTaxBaselineBps && recoveryBps <= policy.fireTaxHardCapBps;
  const exampleBps = sell && valid ? Math.max(
    sampleTargetBps(Math.round(Number(twap) * 10_000)),
    sampleTargetBps(Math.round(Number(projected) * 10_000)),
    recoveryBps,
    genesis ? floor : 0,
  ) : 0;
  return <>
    <Heading title="Swap">Explore the Fire Tax on official USDC pools before a live deployment is configured.</Heading>
    <div className="split">
      <section className="panel control-panel">
        <h2>Fire Tax simulator</h2>
        <div className="fields">
          <label>Asset<select value={asset} onChange={(event) => setAsset(event.target.value === "xSHARE" ? "xSHARE" : "xTOMB")}><option>xTOMB</option><option>xSHARE</option></select></label>
          <label>Direction<select value={sell ? "sell" : "buy"} onChange={(event) => setSell(event.target.value === "sell")}><option value="sell">Sell</option><option value="buy">Buy</option></select></label>
        </div>
        <label className="checkbox"><input type="checkbox" checked={genesis} onChange={(event) => setGenesis(event.target.checked)} /> During Genesis</label>
        {sell && <div className="fields">
          <label>TWAP / reference<input type="number" step=".0001" min=".0001" max="10" value={twap} onChange={(event) => setTwap(event.target.value)} /></label>
          <label>Projected price / reference<input type="number" step=".0001" min=".0001" max="10" value={projected} onChange={(event) => setProjected(event.target.value)} /></label>
          <label>Recovery floor (%)<input type="number" step=".01" min="1" max="12" value={recovery} onChange={(event) => setRecovery(event.target.value)} /></label>
        </div>}
      </section>
      <section className="panel control-panel">
        <h2>Estimated Fire Tax</h2><div className="result" aria-label="Estimated Fire Tax" aria-live="polite">{!sell || valid ? percent(exampleBps) : "—"}</div>
        <p>{sell ? "The hook takes the highest applicable rate once, up to the 12% ceiling. The result here uses your sample prices and recovery floor." : "Official buys have zero Fire Tax. Pool trading fees are separate."}</p>
        {sell && !valid && <p className="callout">Enter positive price ratios up to 10 and a recovery floor from 1% to 12%.</p>}
        {sell && genesis && asset === "xTOMB" && <p className="callout">During Genesis the entire xTOMB sell tax burns in the same transaction.</p>}
        <button className="button" type="button" disabled>Swap unavailable</button>
      </section>
    </div>
  </>;
}

function Masonry() {
  return <>
    <Heading title="Masonry">Follow how xSHARE sell fees fund Treasury assets and xTOMB defense.</Heading>
    <Stats items={[["Protocol liquidity", percent(policy.squareTaxPolBps)], ["USDC reserve", percent(policy.squareTaxUsdcReserveBps)], ["Retained xSHARE", percent(policy.squareTaxSquareReserveBps)]]} />
    <div className="split below">
      <section className="panel"><h2>xSHARE/USDC liquidity</h2><p>Under normal routing, part of the collected xSHARE funds redeemable protocol liquidity shares held by Treasury.</p></section>
      <section className="panel"><h2>Critical Defense</h2><p>A fresh xTOMB TWAP at or below $0.90 activates defense. New xSHARE sell fees are earmarked to buy and burn xTOMB. Earlier allocations keep their purpose.</p></section>
    </div>
  </>;
}

function Farm() {
  return <>
    <Heading title="Farm">Post-Genesis staking and migration.</Heading>
    <section className="panel"><span className="chip">Integration pending</span><h2>After Genesis</h2><p>Genesis principal and earned rewards remain accessible after Genesis ends. Farm staking and automatic migration require separate integration.</p><Link className="button" to="/genesis">Review Genesis</Link></section>
  </>;
}

function Docs() {
  return <>
    <Heading title="Protocol guide">The Genesis, Fire Tax, and Treasury rules behind xTOMB and xSHARE.</Heading>
    <div className="guide">
      <details className="panel" open><summary>Genesis access and emissions</summary><p>Genesis runs for {durationDays} days. A soulbound Genesis, Pro, or Ultra NFT is required. The official xTOMB/USDC LP pool opens on Day {lpDay} and receives 75% of emissions from then on.</p></details>
      <details className="panel"><summary>Claims and compounding</summary><p>{percent(policy.genesisLiquidRewardBps)} of settled xTOMB rewards are liquid. The remainder goes into {policy.genesisVestingInstallments} claim-gated installments with {policy.genesisVestingIntervalSeconds / 3600} hours between releases. Wallet claims pay {percent(policy.genesisWalletClaimFeeBps)}. Keeper compounding charges {percent(policy.genesisAutomationFeeBps)} on the liquid amount processed. Only the liquid portion can compound, and each compound pays the LP fee once.</p></details>
      <details className="panel"><summary>Fire Tax and oracle availability</summary><p>The official pools use a sell-only tax. During Genesis, xTOMB has a {percent(policy.genesisLevelSellMinimumBps)} minimum and xSHARE has a {percent(policy.squareGenesisSellMinimumBps)} minimum. The tax can rise on the same sale, up to {percent(policy.fireTaxHardCapBps)}, and the entire xTOMB fee burns during Genesis. Buys and wallet transfers have zero Fire Tax. Official sells can be unavailable while the native oracle warms up or after it becomes stale.</p></details>
      <details className="panel"><summary>Deployment and risks</summary><p>xTOMB targets $1. Market conditions can move it away from that target. This preview has no live balances, prices or contract transactions. The launch chain and deployment addresses are still pending.</p></details>
    </div>
  </>;
}

export function XTombApp() {
  return <Routes><Route element={<Layout />}>
    <Route index element={<Landing />} />
    <Route path="dashboard" element={<Dashboard />} />
    <Route path="genesis" element={<Genesis />} />
    <Route path="farm" element={<Farm />} />
    <Route path="masonry" element={<Masonry />} />
    <Route path="swap" element={<Swap />} />
    <Route path="docs" element={<Docs />} />
    <Route path="vault" element={<Navigate to="/genesis" replace />} />
    <Route path="club" element={<Navigate to="/masonry" replace />} />
    <Route path="notes" element={<Navigate to="/docs" replace />} />
    <Route path="wizard" element={<WizardPage />} />
    <Route path="admin" element={<AdminPage />} />
    <Route path="bridge" element={<BridgePage />} />
    <Route path="*" element={<Heading title="Page unavailable"><Link to="/">Return home</Link></Heading>} />
  </Route></Routes>;
}
