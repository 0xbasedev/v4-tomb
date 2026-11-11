import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { bytesToHex } from "viem";
import { bridgeRoles, masonryRoles } from "../../../../config/create3-plan.mjs";
import { durationDays, lpDay, percent, policy } from "../policy";
import { TokenIcon } from "../TokenIcon";
import {
  addressPatternsFrom, bridgeNetworks, chainInfrastructure, homeNetworks, download, importDraft, infrastructureFields, launchFrom, loadDraft,
  makeDraft, networkFrom, saveDraft, supplyFields, identityFields, type Fields, type LaunchPlan,
} from "./configuration";
import { verifyLaunch, type Verification } from "./verifyLaunch";
import { fieldHelp } from "./fieldHelp";
import { GenesisScheduling } from "./GenesisScheduling";
import "./setup.css";

const roleNames: Record<string, string> = {
  masonryPeg: "xTOMB", masonryShare: "xSHARE", masonryGenesisPass: "Genesis pass",
  masonryTaxHook: "xTOMB Fire Tax hook", masonryShareTaxHook: "xSHARE Fire Tax hook",
  masonryLevelOracle: "xTOMB price oracle", masonryShareOracle: "xSHARE price oracle",
  masonrySwapRouter: "xTOMB swap router", masonryGenesisSchedule: "Genesis clock",
  masonryGenesisStaking: "Genesis staking", masonryGenesisSettlement: "Genesis reward payouts and vesting",
  masonryGenesisLPBurnFee: "Genesis liquidity fee (to Treasury)", masonryLevelUsdcVault: "xTOMB/USDC liquidity vault",
  masonrySquareUsdcVault: "xSHARE/USDC liquidity vault", masonryBuybackGuard: "Buyback price safeguards",
  masonryCompoundGate: "Compounding permissions", masonryCriticalDefense: "Peg defense controls",
  masonryVestingTeam: "Team vesting", masonryVestingDeveloper: "Developer vesting",
  masonryVestingTreasury: "Treasury vesting", masonryVestingArbitrage: "Arbitrage vesting",
  xshareBridge: "xSHARE bridge", bridgedShare: "Wrapped xSHARE",
};
const roleName = (role: string) => roleNames[role] ?? (role.startsWith("masonry")
  ? role.slice("masonry".length).replace(/([a-z])([A-Z])/g, "$1 $2") : role);

function OperatorHeading({ title, children }: { title: string; children: ReactNode }) {
  return <header className="page-heading operator-heading">
    <span className="label">OPERATOR CONSOLE</span>
    <h1>{title}</h1><p>{children}</p>
  </header>;
}

function SetupNav() {
  return <nav className="ops-nav" aria-label="Release tools">
    <NavLink to="/wizard">Setup Wizard</NavLink><NavLink to="/admin">Admin</NavLink>
  </nav>;
}

function ImportDraft({ onImport, onError }: { onImport: (fields: Fields) => void; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  async function read(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      if (file.size > 250_000) throw new Error("Choose a release draft under 250 KB.");
      onImport(importDraft(JSON.parse(await file.text())));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to read the release draft.");
    }
  }
  return <>
    <input className="visually-hidden" tabIndex={-1} type="file" accept=".json,application/json" ref={input} onChange={read} aria-label="Release draft file" />
    <button className="button" type="button" onClick={() => input.current?.click()}>Import draft</button>
  </>;
}

function usePlanner() {
  const worker = useRef<Worker | null>(null);
  const [plan, setPlan] = useState<LaunchPlan>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState("");
  useEffect(() => () => worker.current?.terminate(), []);
  function clear() {
    worker.current?.terminate();
    worker.current = null;
    setPlan(undefined);
    setError("");
    setBusy(false);
    setSearching("");
  }
  function generate(fields: Fields, requireFuture = true) {
    clear();
    setBusy(true);
    try {
      const active = new Worker(new URL("./planner.worker.ts", import.meta.url), { type: "module" });
      worker.current = active;
      const complete = () => {
        if (worker.current !== active) return false;
        active.terminate();
        worker.current = null;
        setBusy(false);
        return true;
      };
      active.onmessage = ({ data }: MessageEvent<{ plan?: LaunchPlan; error?: string; searching?: string }>) => {
        if (worker.current !== active) return;
        if (data.searching) {
          setSearching(data.searching);
          return;
        }
        if (!complete()) return;
        setPlan(data.plan);
        setError(data.error ?? "");
      };
      active.onerror = () => { if (complete()) setError("Unable to calculate the deployment addresses."); };
      active.postMessage({ fields, requireFuture });
    } catch {
      setBusy(false);
      setError("Address calculation is unavailable in this browser.");
    }
  }
  return { plan, error, busy, searching, clear, generate };
}

function FieldsGroup({ fields, update, entries, numeric = false }: {
  fields: Fields; update: (key: string, value: string) => void;
  entries: ReadonlyArray<readonly [string, string, string?]>; numeric?: boolean;
}) {
  const id = useId();
  return <div className="ops-fields">{entries.map(([key, label, description]) => {
    const help = description ?? fieldHelp[key];
    const fieldId = id + key;
    return <div className="ops-input-group" key={key}>
      <label htmlFor={fieldId}>{label}</label>
      <input id={fieldId} aria-describedby={help ? fieldId + "-help" : undefined} value={fields[key]}
        inputMode={numeric ? "numeric" : undefined} autoComplete="off" spellCheck={false}
        onChange={(event) => update(key, event.target.value)} />
      {help && <small className="ops-help" id={fieldId + "-help"}>{help}</small>}
    </div>;
  })}</div>;
}

function AddressPatternFields({ fields, update, roles }: {
  fields: Fields; update: (key: string, value: string) => void; roles: readonly string[];
}) {
  const [role, setRole] = useState(roles[0]);
  const hasPattern = (candidate: string) => !!(fields["prefix-" + candidate].trim() || fields["suffix-" + candidate].trim());
  const hook = role === "masonryTaxHook" || role === "masonryShareTaxHook";
  return <details className="ops-detail">
    <summary>Custom contract addresses (optional)</summary>
    <p>Give a contract address a recognizable start, end, or both. For example, enter <code>dead</code> as the suffix to look for an address ending in <code>…dead</code>. Leave both fields blank to use the standard address.</p>
    <p>Use 0–9 or A–F. Most contracts allow up to four characters total. Longer searches can take more time. Set these patterns before approving contract builds because constructor inputs may refer to the predicted addresses.</p>
    <label className="ops-field">Contract to customize
      <select value={role} onChange={(event) => setRole(event.target.value)}>
        {roles.map((candidate) => <option key={candidate} value={candidate}>{roleName(candidate)}{hasPattern(candidate) ? " · custom" : ""}</option>)}
      </select>
    </label>
    {hook && <p className="ops-help">Uniswap hook permissions already fix part of the suffix. Try a one-character prefix or a suffix such as <code>35c8</code>. When combining both, use a suffix of up to three characters with the prefix.</p>}
    <FieldsGroup fields={fields} update={update} entries={[
      ["prefix-" + role, "Address prefix", "The characters immediately after 0x. For example, ab looks for 0xab…"],
      ["suffix-" + role, "Address suffix", "The characters at the very end. For example, 01 looks for …01."],
    ]} />
  </details>;
}

function PlanDetails({ plan }: { plan: LaunchPlan }) {
  return <>
    <dl className="ops-facts">
      <div><dt>Home network</dt><dd>{plan.network.name} · {plan.network.id}</dd></div>
      <div><dt>Genesis start in this plan</dt><dd>{plan.launch.genesisStart
        ? new Date(plan.launch.genesisStart * 1000).toLocaleString() : "Set later in Admin"}</dd></div>
      <div><dt>Approved component hashes</dt><dd>{Object.keys(plan.masonry.initCodeHashes).length} / {masonryRoles.length}</dd></div>
    </dl>
    <details className="ops-detail" open><summary>Predicted contract addresses</summary>
      <p>CreateX uses CREATE3 to calculate where your contracts will live before they are deployed. Share this list with the person handling deployment.</p>
      <dl className="address-list">{Object.entries(plan.masonry.addresses).map(([role, address]) =>
        <div key={role}><dt>{roleName(role)}</dt><dd><code>{address}</code></dd></div>)}</dl>
    </details>
    {plan.bridge && <details className="ops-detail"><summary>Predicted xSHARE bridge addresses</summary>
      <dl className="address-list">{plan.bridge.networks.map((network) => <div key={network.id}>
        <dt>{network.name}</dt><dd><code>{network.bridge}</code><small>Token</small><code>{network.token}</code></dd>
      </div>)}</dl>
    </details>}
    {!!plan.release.addressPatterns && <details className="ops-detail" open><summary>Custom address patterns</summary>
      <dl className="address-list">{Object.entries(plan.release.addressPatterns).map(([role, { prefix, suffix }]) =>
        <div key={role}><dt>{roleName(role)}</dt><dd><code>0x{prefix}…{suffix}</code></dd></div>)}</dl>
    </details>}
    <details className="ops-detail" open><summary>Which files should I download?</summary>
      <ul className="ops-explainer">
        <li><strong>Address plan</strong> lists the predicted contract addresses and any approved build fingerprints.</li>
        <li><strong>Release inputs</strong> lets a developer regenerate the same plan from the Release ID, signer and chain.</li>
        <li><strong>Launch settings</strong> records the network, token amounts, roles and Genesis timing.</li>
        {plan.bridge && <li><strong>Bridge plan</strong> records addresses and limits for the optional xSHARE bridge.</li>}
      </ul>
    </details>
    <div className="actions ops-actions">
      <button className="button primary" type="button" onClick={() => download("masonry.release.json", plan.masonry)}>Download address plan</button>
      <button className="button" type="button" onClick={() => download("release.json", plan.release)}>Download release inputs</button>
      <button className="button" type="button" onClick={() => download("masonry-launch.json", { ...plan.launch, network: plan.network })}>Download launch settings</button>
      {plan.bridge && <button className="button" type="button" onClick={() => download("xshare-bridge.release.json", plan.bridge)}>Download bridge plan</button>}
    </div>
  </>;
}

const steps = ["Network", "Launch settings", "Bridge", "Review"] as const;

export function WizardPage() {
  const [fields, setFields] = useState(loadDraft);
  const [chooseStart, setChooseStart] = useState(() => !!fields.genesisStart);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const planner = usePlanner();
  useEffect(() => { saveDraft(fields); }, [fields]);

  function replace(next: Fields) { setFields(next); planner.clear(); setError(""); }
  function update(key: string, value: string) { replace({ ...fields, [key]: value }); }
  function selectNetwork(value: string) {
    const selected = homeNetworks.find(({ id }) => String(id) === value);
    const defaults = selected && chainInfrastructure[selected.id];
    replace({
      ...fields, network: value, chainId: selected ? String(selected.id) : "", chainName: selected?.name ?? "",
      rpcUrl: selected?.rpcUrl ?? "", nativeSymbol: selected?.nativeCurrency.symbol ?? "",
      ...Object.fromEntries(infrastructureFields.map(([field]) => [field, defaults?.[field] ?? ""])),
      ...(bridgeNetworks.some(({ id }) => String(id) === value) ? {} : { bridge: "off" }),
    });
  }
  function advance() {
    try {
      if (step === 0) networkFrom(fields);
      if (step === 1) {
        if (chooseStart && !fields.genesisStart) throw new Error("Choose a Genesis date and time, or select Set later in Admin.");
        launchFrom(fields);
        addressPatternsFrom(fields, masonryRoles);
      }
      if (step === 2 && fields.bridge === "on") addressPatternsFrom(fields, bridgeRoles);
      setError("");
      setStep(step + 1);
      if (step === 2) planner.generate(fields);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Review the highlighted setup step.");
    }
  }

  const selectedNetwork = homeNetworks.find(({ id }) => String(id) === fields.network);
  const bridgeHome = bridgeNetworks.some(({ id }) => String(id) === fields.network);
  const missingDefaults = Object.entries(selectedNetwork ? chainInfrastructure[selectedNetwork.id] ?? {} : {})
    .filter(([field]) => !fields[field].trim());
  return <>
    <OperatorHeading title="Setup Wizard">Build your xTOMB launch plan in four steps. The Wizard saves your work in this browser and calculates contract addresses before deployment. You can plan without connecting a wallet.</OperatorHeading>
    <SetupNav />
    <div className="ops-layout">
      <aside aria-label="Setup steps" className="ops-steps">
        {steps.map((title, index) => <button key={title} type="button" aria-current={step === index ? "step" : undefined}
          disabled={index > step} onClick={() => { setStep(index); setError(""); }}><span>0{index + 1}</span>{title}</button>)}
      </aside>
      <section className="panel ops-workspace" aria-labelledby="setup-step">
        <div className="ops-section-head"><div><span className="label">STEP {step + 1} OF {steps.length}</span><h2 id="setup-step">{steps[step]}</h2></div>
          <span className="chip ember">Release draft</span></div>
        <form onSubmit={(event) => { event.preventDefault(); if (step < 3) advance(); }}>
          {step === 0 && <>
            <p>Your home network is where the original xTOMB and xSHARE will live. If you use the optional bridge later, the other chains will hold wrapped copies of xSHARE.</p>
            <label className="ops-field">Home network
              <select aria-describedby="home-network-help" value={fields.network} onChange={(event) => selectNetwork(event.target.value)}>
                <option value="">Select a network</option>{homeNetworks.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                <option value="custom">Custom EVM network</option>
              </select>
            </label>
            <p className="ops-help" id="home-network-help">Base has every address filled in. Other networks may need additional addresses from your deployment team. Switching networks replaces the address fields with that network’s defaults.</p>
            {fields.network === "custom" && <FieldsGroup fields={fields} update={update}
              entries={[[ "chainName", "Network name" ], [ "chainId", "Chain ID" ], [ "nativeSymbol", "Native currency symbol" ]]} />}
            {selectedNetwork && <p className="ops-meta token-line">
              <span>{selectedNetwork.name} · Chain {selectedNetwork.id}</span>
              <span className="token-line">{selectedNetwork.nativeCurrency.symbol === "ETH" && <TokenIcon token="ETH" />}
                {selectedNetwork.nativeCurrency.symbol} for network fees</span>
            </p>}
            {missingDefaults.length > 0 && <button className="button" type="button"
              onClick={() => replace({ ...fields, ...Object.fromEntries(missingDefaults) })}>Fill missing addresses</button>}
            <FieldsGroup fields={fields} update={update} entries={[[ "rpcUrl", "Public RPC URL" ], ...infrastructureFields]} />
          </>}
          {step === 1 && <>
            <p>Identify this launch, choose who controls it, and decide where the initial tokens go. Use public wallet addresses for the roles below. Keep recovery phrases and private keys in your wallet.</p>
            <label className="ops-field">Release ID<input aria-describedby="release-id-help" value={fields.releaseId} autoComplete="off" spellCheck={false}
              onChange={(event) => update("releaseId", event.target.value)} /></label>
            <p className="ops-help" id="release-id-help">A public identifier for this deployment. For a new launch, click Generate release ID. For an existing plan, paste its original ID. The ID and deployment signer determine the contract addresses, so keep both the same once you share or deploy the plan.</p>
            <button className="button ops-actions" type="button" disabled={!!fields.releaseId.trim()}
              onClick={() => update("releaseId", bytesToHex(crypto.getRandomValues(new Uint8Array(32))))}>Generate release ID</button>
            <FieldsGroup fields={fields} update={update} entries={identityFields} />
            <label className="ops-field">When should Genesis start?
              <select aria-describedby="genesis-timing-help" value={chooseStart ? "now" : "later"} onChange={(event) => {
                setChooseStart(event.target.value === "now");
                if (event.target.value === "later") update("genesisStart", "");
                else setError("");
              }}>
                <option value="later">Set later in Admin</option>
                <option value="now">Choose a date for deployment</option>
              </select>
            </label>
            <p id="genesis-timing-help" className="ops-help">If the launch date is undecided, deploy with Genesis unscheduled. Once the staking contract is funded and connected, use the governance wallet in Admin to set a future start. The date is permanent once saved on-chain.</p>
            {chooseStart && <label className="ops-field">Genesis start (local time)<input type="datetime-local" value={fields.genesisStart}
              aria-describedby="genesis-timing-help" onChange={(event) => update("genesisStart", event.target.value)} /></label>}
            <details className="ops-detail" open><summary>Supply and vesting</summary>
              <p>Enter whole tokens, without commas or decimals. Vesting means tokens unlock over time. Enter 0 for each unused allocation. For xSHARE, the farm, sale, signer, initial and vesting amounts must add up to the maximum supply.</p>
              <FieldsGroup fields={fields} update={update} entries={supplyFields} numeric />
            </details>
            <details className="ops-detail"><summary>Fixed Genesis rules</summary><p>Genesis runs for {durationDays} days and requires a pass. The official xTOMB/USDC liquidity pool opens on Day {lpDay}. Each xTOMB sell during Genesis pays one tax from {percent(policy.genesisLevelSellMinimumBps)} to {percent(policy.fireTaxHardCapBps)}, burned in the same transaction. Buys and wallet transfers pay zero Fire Tax.</p></details>
            <AddressPatternFields fields={fields} update={update} roles={masonryRoles} />
            <details className="ops-detail"><summary>Advanced · Approved contract builds</summary>
              <p>A constructor hash is the fingerprint of a compiled contract and its setup inputs. Your developer provides it after reviewing the build. Leave these blank while planning addresses. Deployment requires the approved fingerprint for each contract.</p>
              <FieldsGroup fields={fields} update={update} entries={masonryRoles.map((role) => ["hash-" + role, roleName(role), "Paste the developer-provided fingerprint for this contract. It starts with 0x and contains 64 hexadecimal characters after that."])} />
            </details>
          </>}
          {step === 2 && <>
            <p>A bridge lets users move xSHARE between chains. Leave this off for a single-chain launch or if you do not have the bridge owner addresses, message verifiers and limits ready. Exporting a bridge plan leaves all transfers disabled.</p>
            <label className="ops-check"><input type="checkbox" checked={fields.bridge === "on"} disabled={!bridgeHome}
              onChange={(event) => update("bridge", event.target.checked ? "on" : "off")} />Include xSHARE bridge in this release</label>
            {!bridgeHome && <p className="ops-meta">Bridge planning is available when the home network is one of the four bridge networks. Robinhood Chain and custom networks launch without a bridge.</p>}
            {fields.bridge === "on" && <AddressPatternFields fields={fields} update={update} roles={bridgeRoles} />}
            {fields.bridge === "on" && bridgeNetworks.map(({ id, name, registryAvailability }) => <details className="ops-detail" key={id} open>
              <summary>{name}{String(id) === fields.network ? " · Home" : ""}</summary>
              {registryAvailability?.status === "disabled" && <p className="ops-meta">Requires a verified Sonic validator and relayer setup before activation.</p>}
              <FieldsGroup fields={fields} update={update} entries={[
                ["owner" + id, name + " bridge owner", "Public address that manages this bridge deployment and can enable routes."],
                ["ism" + id, name + " message verifier", "Address of the Hyperlane contract that verifies messages coming from other chains. Get it from the bridge deployment team."],
                ...(String(id) === fields.network ? [] : [["cap" + id, name + " route cap (base units)", "Maximum xSHARE that can be backed on this chain at one time. For 1 xSHARE, enter 1000000000000000000."] as const]),
              ]} />
            </details>)}
          </>}
          {step === 3 && <>
            <p>Check your settings and download the files for whoever is deploying the contracts. After deployment, open Admin to check the on-chain addresses and set the Genesis date if you deferred it.</p>
            {planner.busy && <>
              <p role="status">{planner.searching ? `Searching for the ${roleName(planner.searching)} address…` : "Calculating deterministic addresses…"}</p>
              <button className="button" type="button" onClick={planner.clear}>Cancel address search</button>
            </>}
            {planner.plan && <PlanDetails plan={planner.plan} />}
            {planner.error && <p className="callout" role="alert">{planner.error}</p>}
            {!planner.plan && !planner.busy && <button className="button" type="button" onClick={() => planner.generate(fields)}>Calculate addresses</button>}
          </>}
          {error && <p className="callout" role="alert">{error}</p>}
          <div className="actions ops-actions">
            {step > 0 && <button className="button" type="button" onClick={() => { setError(""); setStep(step - 1); }}>Back</button>}
            {step < 3 && <button className="button primary" type="submit">{step === 2 ? "Calculate addresses" : "Continue"}</button>}
            {step === 3 && <Link className="button" to="/admin">Open Admin</Link>}
          </div>
        </form>
      </section>
    </div>
    <div className="actions ops-actions">
      <ImportDraft onImport={(next) => { replace(next); setChooseStart(!!next.genesisStart); setStep(0); }} onError={setError} />
      <button className="button" type="button" onClick={() => download("xtomb-release-draft.json", makeDraft(fields))}>Download draft</button>
    </div>
    <p className="ops-help">Download a draft to back up your answers or continue in another browser. Importing a draft replaces the answers currently saved here.</p>
  </>;
}

export function AdminPage() {
  const [fields, setFields] = useState(loadDraft);
  const [error, setError] = useState("");
  const [verification, setVerification] = useState<Verification>();
  const [checking, setChecking] = useState(false);
  const [checkNetwork, setCheckNetwork] = useState<number>();
  const check = useRef<AbortController | null>(null);
  const planner = usePlanner();
  useEffect(() => () => check.current?.abort(), []);

  async function verify(plan: LaunchPlan) {
    check.current?.abort();
    const controller = new AbortController();
    check.current = controller;
    setChecking(true);
    setVerification(undefined);
    setError("");
    try {
      const result = await verifyLaunch(plan, checkNetwork ?? plan.network.id, controller.signal);
      if (!controller.signal.aborted) setVerification(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "RPC verification failed.");
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }

  return <>
    <OperatorHeading title="Admin">Review a release plan and check its deployment against the selected network.</OperatorHeading>
    <SetupNav />
    <section className="panel ops-workspace">
      <div className="ops-section-head"><div><span className="label">RELEASE MANAGEMENT</span><h2>Deployment review</h2></div>
        <span className="chip">Launch review</span></div>
      <p>{fields.chainName ? `Local draft · ${fields.chainName} · Chain ${fields.chainId}` : "Choose a home network in the Wizard or import a saved draft."}</p>
      <div className="actions ops-actions">
        <Link className="button primary" to="/wizard">Configure release</Link>
        <ImportDraft onImport={(next) => {
          check.current?.abort(); setChecking(false); planner.clear(); setVerification(undefined);
          setError(""); setCheckNetwork(undefined); setFields(next); saveDraft(next);
        }} onError={setError} />
        <button className="button" type="button" disabled={!fields.network || planner.busy || checking}
          onClick={() => { setError(""); setVerification(undefined); planner.generate(fields, false); }}>Load address plan</button>
      </div>
      {planner.busy && <p role="status">Calculating deterministic addresses…</p>}
      {planner.plan && <PlanDetails plan={planner.plan} />}
      {planner.plan && <GenesisScheduling key={planner.plan.masonry.addresses.masonryGenesisSchedule} plan={planner.plan} />}
      {planner.plan?.bridge && <label className="ops-field">Verification network
        <select value={checkNetwork ?? planner.plan.network.id} disabled={checking} onChange={(event) => {
          setCheckNetwork(Number(event.target.value)); setVerification(undefined); setError("");
        }}>
          {planner.plan.bridge.networks.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>}
      {planner.plan && <div className="actions ops-actions"><button className="button" type="button" disabled={checking}
        onClick={() => planner.plan && void verify(planner.plan)}>{checking ? "Checking RPC…" : "Check on-chain code"}</button></div>}
      {(error || planner.error) && <p role="alert" className="callout">{error || planner.error}</p>}
      {verification && <section className="ops-verification" aria-label="On-chain check results">
        <h2>On-chain check</h2><p role="status">Chain {verification.chainId} · Block {verification.block}. Code presence and factory bytecode checked.</p>
        <dl className="address-list">{verification.checks.map(({ label, status }) =>
          <div key={label}><dt>{roleName(label)}</dt><dd className={"check-status " + status}>{status === "present" ? "Code present" : status === "factory" ? "CreateX bytecode verified" : status === "missing" ? "No code" : "Unexpected CreateX bytecode"}</dd></div>)}</dl>
        <p className="ops-meta">Review constructor inputs, contract ownership, and wiring before publishing a deployment.</p>
      </section>}
    </section>
  </>;
}

export function BridgePage() {
  return <>
    <OperatorHeading title="xSHARE Bridge">Move xSHARE between the home chain and supported networks once routes are verified.</OperatorHeading>
    <section className="panel ops-workspace" aria-labelledby="bridge-networks">
      <div className="ops-section-head"><div><span className="label">HYPERLANE · xSHARE</span><h2 id="bridge-networks">Supported networks</h2></div>
        <span className="chip">Awaiting deployment</span></div>
      <ul className="ops-network-list">{bridgeNetworks.map(({ id, name, registryAvailability }) => <li key={id}>
        <div><strong>{name}</strong><small>{registryAvailability?.status === "disabled" ? "Validator and relayer setup required" : `Chain ${id} · Route inactive`}</small></div>
        <button className="button" type="button" disabled aria-label={`Bridge to ${name} unavailable`}>Unavailable</button>
      </li>)}</ul>
      <p>Bridge addresses are generated from the release plan. Transfers become available after deployment and verified round trips.</p>
    </section>
  </>;
}
