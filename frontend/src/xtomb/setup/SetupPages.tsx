import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { bytesToHex } from "viem";
import { masonryRoles } from "../../../../config/create3-plan.mjs";
import { durationDays, lpDay, percent, policy } from "../policy";
import {
  bridgeNetworks, chainInfrastructure, download, importDraft, infrastructureFields, launchFrom, loadDraft,
  makeDraft, networkFrom, saveDraft, supplyFields, identityFields, type Fields, type LaunchPlan,
} from "./configuration";
import { verifyLaunch, type Verification } from "./verifyLaunch";
import "./setup.css";

const roleNames: Record<string, string> = {
  masonryPeg: "xTOMB", masonryShare: "xSHARE", masonryGenesisPass: "Genesis pass",
  masonryTaxHook: "xTOMB Fire Tax hook", masonryShareTaxHook: "xSHARE Fire Tax hook",
  masonryLevelOracle: "xTOMB price oracle", masonryShareOracle: "xSHARE price oracle",
  masonrySwapRouter: "xTOMB swap router",
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
  useEffect(() => () => worker.current?.terminate(), []);
  function clear() {
    worker.current?.terminate();
    worker.current = null;
    setPlan(undefined);
    setError("");
    setBusy(false);
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
      active.onmessage = ({ data }: MessageEvent<{ plan?: LaunchPlan; error?: string }>) => {
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
  return { plan, error, busy, clear, generate };
}

function FieldsGroup({ fields, update, entries, numeric = false }: {
  fields: Fields; update: (key: string, value: string) => void;
  entries: ReadonlyArray<readonly [string, string]>; numeric?: boolean;
}) {
  return <div className="ops-fields">{entries.map(([key, label]) => <label key={key}>{label}
    <input value={fields[key]} inputMode={numeric ? "numeric" : undefined}
      autoComplete="off" spellCheck={false} onChange={(event) => update(key, event.target.value)} />
  </label>)}</div>;
}

function PlanDetails({ plan }: { plan: LaunchPlan }) {
  return <>
    <dl className="ops-facts">
      <div><dt>Home network</dt><dd>{plan.network.name} · {plan.network.id}</dd></div>
      <div><dt>Genesis start</dt><dd>{new Date(plan.launch.genesisStart * 1000).toLocaleString()}</dd></div>
      <div><dt>Approved component hashes</dt><dd>{Object.keys(plan.masonry.initCodeHashes).length} / {masonryRoles.length}</dd></div>
    </dl>
    <details className="ops-detail" open><summary>Predicted contract addresses</summary>
      <dl className="address-list">{Object.entries(plan.masonry.addresses).map(([role, address]) =>
        <div key={role}><dt>{roleName(role)}</dt><dd><code>{address}</code></dd></div>)}</dl>
    </details>
    {plan.bridge && <details className="ops-detail"><summary>Predicted xSHARE bridge addresses</summary>
      <dl className="address-list">{plan.bridge.networks.map((network) => <div key={network.id}>
        <dt>{network.name}</dt><dd><code>{network.bridge}</code><small>Token</small><code>{network.token}</code></dd>
      </div>)}</dl>
    </details>}
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
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const planner = usePlanner();
  useEffect(() => { saveDraft(fields); }, [fields]);

  function replace(next: Fields) { setFields(next); planner.clear(); setError(""); }
  function update(key: string, value: string) { replace({ ...fields, [key]: value }); }
  function selectNetwork(value: string) {
    const selected = bridgeNetworks.find(({ id }) => String(id) === value);
    const defaults = selected && chainInfrastructure[selected.id];
    replace({
      ...fields, network: value, chainId: selected ? String(selected.id) : "", chainName: selected?.name ?? "",
      rpcUrl: selected?.rpcUrl ?? "", nativeSymbol: selected?.nativeCurrency.symbol ?? "",
      ...Object.fromEntries(infrastructureFields.map(([field]) => [field, defaults?.[field] ?? ""])),
      ...(value === "custom" ? { bridge: "off" } : {}),
    });
  }
  function advance() {
    try {
      if (step === 0) networkFrom(fields);
      if (step === 1) launchFrom(fields);
      setError("");
      setStep(step + 1);
      if (step === 2) planner.generate(fields);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Review the highlighted setup step.");
    }
  }

  const selectedNetwork = bridgeNetworks.find(({ id }) => String(id) === fields.network);
  const missingDefaults = Object.entries(selectedNetwork ? chainInfrastructure[selectedNetwork.id] ?? {} : {})
    .filter(([field]) => !fields[field].trim());
  return <>
    <OperatorHeading title="Setup Wizard">Choose the home chain, configure the launch, and calculate the addresses for your release.</OperatorHeading>
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
            <p>Choose the network that holds the original xTOMB and xSHARE. The Wizard fills in known addresses for that chain. Review the defaults and enter any missing addresses.</p>
            <label className="ops-field">Home network
              <select value={fields.network} onChange={(event) => selectNetwork(event.target.value)}>
                <option value="">Select a network</option>{bridgeNetworks.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                <option value="custom">Custom EVM network</option>
              </select>
            </label>
            {fields.network === "custom" && <FieldsGroup fields={fields} update={update}
              entries={[[ "chainName", "Network name" ], [ "chainId", "Chain ID" ], [ "nativeSymbol", "Native currency symbol" ]]} />}
            {selectedNetwork && <p className="ops-meta">{selectedNetwork.name} · Chain {selectedNetwork.id} · {selectedNetwork.nativeCurrency.symbol}</p>}
            {missingDefaults.length > 0 && <button className="button" type="button"
              onClick={() => replace({ ...fields, ...Object.fromEntries(missingDefaults) })}>Fill missing addresses</button>}
            <FieldsGroup fields={fields} update={update} entries={[[ "rpcUrl", "Public RPC URL" ], ...infrastructureFields]} />
            <p className="ops-meta">The Uniswap Universal Router is optional. The Wizard calculates the xTOMB router address separately.</p>
          </>}
          {step === 1 && <>
            <p>Set the release identity, operator addresses, and token allocations. Amounts in the supply table are whole tokens.</p>
            <label className="ops-field">Release ID<input value={fields.releaseId} autoComplete="off" spellCheck={false}
              onChange={(event) => update("releaseId", event.target.value)} /></label>
            <button className="button" type="button" onClick={() => update("releaseId", bytesToHex(crypto.getRandomValues(new Uint8Array(32))))}>Generate release ID</button>
            <FieldsGroup fields={fields} update={update} entries={identityFields} />
            <label className="ops-field">Genesis start (local time)<input type="datetime-local" value={fields.genesisStart}
              onChange={(event) => update("genesisStart", event.target.value)} /></label>
            <details className="ops-detail" open><summary>Supply and vesting</summary>
              <FieldsGroup fields={fields} update={update} entries={supplyFields} numeric />
            </details>
            <details className="ops-detail"><summary>Buyback execution limits</summary>
              <FieldsGroup fields={fields} update={update} numeric entries={[
                ["burnShares", "Maximum LP fee shares per call (base units)"], ["burnUsdc", "Maximum USDC per call (base units)"],
              ]} />
            </details>
            <details className="ops-detail"><summary>Contract rules</summary><p>Genesis runs for {durationDays} days and requires a pass. The official LP opens Day {lpDay}. The xTOMB Genesis sell tax starts at {percent(policy.genesisLevelSellMinimumBps)} and can rise to {percent(policy.fireTaxHardCapBps)} on the same sale. Buys have zero Fire Tax.</p></details>
            <details className="ops-detail"><summary>Approved constructor hashes</summary>
              <p>Add a reviewed creation-code hash to authorize the corresponding component in the exported address plan.</p>
              <FieldsGroup fields={fields} update={update} entries={masonryRoles.map((role) => ["hash-" + role, roleName(role)])} />
            </details>
          </>}
          {step === 2 && <>
            <p>Optionally plan xSHARE bridge deployments. All routes start disabled.</p>
            <label className="ops-check"><input type="checkbox" checked={fields.bridge === "on"} disabled={!selectedNetwork}
              onChange={(event) => update("bridge", event.target.checked ? "on" : "off")} />Include xSHARE bridge in this release</label>
            {!selectedNetwork && <p className="ops-meta">Bridge planning is available for the five supported home networks.</p>}
            {fields.bridge === "on" && bridgeNetworks.map(({ id, name, registryAvailability }) => <details className="ops-detail" key={id} open>
              <summary>{name}{String(id) === fields.network ? " · Home" : ""}</summary>
              {registryAvailability?.status === "disabled" && <p className="ops-meta">Requires a verified Sonic validator and relayer setup before activation.</p>}
              <FieldsGroup fields={fields} update={update} entries={[
                ["owner" + id, name + " bridge owner"], ["ism" + id, name + " message verifier"],
                ...(String(id) === fields.network ? [] : [["cap" + id, name + " route cap (base units)"] as const]),
              ]} />
            </details>)}
          </>}
          {step === 3 && <>
            <p>Review the CREATE3 predictions and export the release files for deployment review. Predicted addresses can be recorded before the contracts are deployed.</p>
            {planner.busy && <p role="status">Calculating deterministic addresses…</p>}
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
      <ImportDraft onImport={(next) => { replace(next); setStep(0); }} onError={setError} />
      <button className="button" type="button" onClick={() => download("xtomb-release-draft.json", makeDraft(fields))}>Download draft</button>
    </div>
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
        <span className="chip">Read-only checks</span></div>
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
