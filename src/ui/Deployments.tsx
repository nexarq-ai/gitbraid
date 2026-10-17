import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { OperationTrack } from "./OperationMotion";
import { RouteProgress } from "./WorkspaceLoader";
import "./cloudflare-connection.css";

type Environment = string;
type Status = "awaiting_confirmation" | "queued" | "building" | "deploying" | "rolling_out" | "succeeded" | "uploaded" | "failed" | "superseded" | "skipped";
type TargetStatus = "pending" | "building" | "uploaded" | "deploying" | "rolling_out" | "succeeded" | "failed" | "skipped";
type Trigger = "land" | "manual" | "rollback" | "promote";
interface Target { workerName: string; configPath: string; buildCommand?: string; d1Migrations: boolean; watchPaths?: string[] }
interface TargetRun extends Target { status: TargetStatus; percentage: number; versionId?: string; urls?: string[]; migrations?: { databaseName: string; applied: string[]; pending: string[]; failed?: { name: string; error: string } }[]; durableObjectMigration?: { old_tag?: string; new_tag: string }; assets?: { uploaded: number; total: number }; notes?: string[]; error?: string }
interface Deployment { id: string; workerName: string; environment: Environment; mode?: "deploy" | "upload-only"; commitSha: string | null; trigger: Trigger; status: Status; percentage: number; versionId?: string; targets?: TargetRun[]; skippedTargets?: { workerName: string; reason: string }[]; promotedFrom?: string; targetsSource?: string; actorId: string; createdAt: string; error?: string; errorCode?: string }
interface Settings { enabled: boolean; workerName: string; rollout: "immediate" | "gradual"; trigger: "manual" | "auto"; mode: "deploy" | "upload-only"; targets: Target[] }
interface EnvironmentState {
  settings: Settings | null;
  current: { deploymentId: string; commitSha: string | null; trigger: Trigger; status: Status; updatedAt: string; workers: { workerName: string; versionId: string; percentage: number; urls?: string[] }[] } | null;
  lastChange: { deploymentId: string; commitSha: string | null; trigger: Trigger; status: Status; updatedAt: string; error?: string } | null;
  pending: string | null;
  running: boolean;
  promotable?: { deploymentId: string; commitSha: string } | null;
  canDeploy: boolean;
  deployBlockedReason?: string;
  canConfirm?: boolean;
}
interface State { environmentOrder?: Environment[]; environments: Record<Environment, EnvironmentState>; deployments: Deployment[]; workers: { id: string; name: string; environment: string }[] }
interface DetectedResource { type: "d1" | "r2" | "queue"; name: string; status?: "exists" | "create" | "missing" | "unknown" }
interface DetectedTarget { workerName: string; configPath: string; buildCommand?: string; buildReasons: string[]; d1Migrations: boolean; watchPaths: string[]; dependsOn: string[]; resources: DetectedResource[]; customDomains: string[]; routes: string[]; workersDev: boolean; exists?: boolean | null; urls?: string[] }
interface SetupWarning { id: string; environment: Environment; configPath: string; message: string }
interface DetectedSetup { commitSha: string; fingerprint: string; packageManager: string | null; environments: Record<Environment, { targets: DetectedTarget[]; warnings: SetupWarning[] }>; errors: string[]; notes: string[]; account?: { connected: true; accountId: string; accountName?: string; source: string; subdomain: string | null; notes: string[] } | { connected: false; reason: string } }
interface Detection { setup: DetectedSetup; saved: { fingerprint: string; commitSha: string; appliedAt: string } | null; changed: { path: string; change: "added" | "removed" | "modified" }[]; blocking?: string[]; canApply: boolean; canAcknowledge: boolean }

const PRODUCTION = "production";
const environmentLabel = (environment: Environment) => environment === PRODUCTION ? "Production" : environment === "staging" ? "Staging" : environment;
const resourceLabels: Record<DetectedResource["type"], string> = { d1: "D1", r2: "R2", queue: "Queue" };
const resourceStatus: Record<NonNullable<DetectedResource["status"]>, string> = { exists: "exists", create: "will create", missing: "missing in account", unknown: "not checked" };

function orderEnvironments(names: Environment[]): Environment[] {
  const unique = [...new Set(names)];
  return [PRODUCTION, ...(unique.includes("staging") ? ["staging"] : []), ...unique.filter((name) => name !== PRODUCTION && name !== "staging").sort()];
}
const labels: Record<Status, string> = { awaiting_confirmation: "Waiting for confirmation", queued: "Queued", building: "Building", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", uploaded: "Uploaded", failed: "Failed", superseded: "Superseded", skipped: "Nothing to deploy" };
const triggers: Record<Trigger, string> = { land: "on land", manual: "manual", rollback: "rollback", promote: "promoted from staging" };
const targetLabels: Record<TargetStatus, string> = { pending: "Pending", building: "Building", uploaded: "Uploaded", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", failed: "Failed", skipped: "Skipped" };
const ACTIVE: Status[] = ["queued", "building", "deploying", "rolling_out"];
const defaultTrigger = (): Settings["trigger"] => "manual";

function targetSummary(target: TargetRun): string {
  const parts = [targetLabels[target.status]];
  if (target.versionId) parts.push(`version ${target.versionId.slice(0, 8)}`);
  if (target.migrations?.length) parts.push(target.migrations.map((item) => item.failed ? `D1 ${item.databaseName}: ${item.failed.name} failed` : `D1 ${item.databaseName}: ${item.applied.length} applied`).join(", "));
  if (target.durableObjectMigration) parts.push(`DO migration ${target.durableObjectMigration.new_tag}`);
  if (target.assets) parts.push(`${target.assets.uploaded}/${target.assets.total} assets uploaded`);
  if (target.error) parts.push(target.error);
  return parts.join(" · ");
}

function draftFor(environment: Environment, state: State): Settings | null {
  const saved = state.environments[environment]?.settings;
  if (saved) return { ...saved, targets: saved.targets.map((target) => ({ ...target, configPath: target.configPath || "wrangler.jsonc" })) };
  const production = state.environments[PRODUCTION]?.settings;
  if (environment !== PRODUCTION && production) return { ...production, enabled: true, trigger: defaultTrigger(), targets: production.targets.map((target) => ({ ...target, workerName: state.workers.find((worker) => worker.id === `${target.workerName}-${environment}`)?.id ?? target.workerName })) };
  const worker = state.workers[0];
  return worker ? { enabled: environment !== PRODUCTION, workerName: worker.id, rollout: "immediate", trigger: defaultTrigger(), mode: "deploy", targets: [{ workerName: worker.id, configPath: "wrangler.jsonc", d1Migrations: false }] } : null;
}

function WorkerUrls({ urls }: { urls?: string[] }) {
  if (!urls?.length) return null;
  return <>{urls.map((url) => <span key={url}> · <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https:\/\//, "")}</a></span>)}</>;
}

export default function Deployments({ repository, onNotify }: { repository: Repository; onNotify?: (message: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [editing, setEditing] = useState<Environment>("staging");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [detectError, setDetectError] = useState("");
  const [detectReload, setDetectReload] = useState(0);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [selection, setSelection] = useState<Record<Environment, string[] | null>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const keys = useRef(new Map<string, string>());
  const path = `/api/repositories/${encodeURIComponent(repository.id)}/deployments`;

  useEffect(() => {
    let active = true;
    let timer = 0;
    const load = () => request<State>(path).then((value) => {
      if (!active) return;
      setState(value);
      setDraft((current) => current ?? draftFor(editing, value));
      if (value.deployments.some((item) => ACTIVE.includes(item.status))) timer = window.setTimeout(load, 5000);
    }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "Deployments could not be loaded."); });
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [path, reload]);

  useEffect(() => {
    let active = true;
    setDetectError("");
    request<Detection>(`${path}/detect`).then((value) => { if (active) setDetection(value); }).catch((failure) => { if (active) setDetectError(failure instanceof Error ? failure.message : "The deploy setup could not be detected."); });
    return () => { active = false; };
  }, [path, detectReload]);

  async function perform(name: string, body: Record<string, unknown>, done: string) {
    const signature = JSON.stringify(body);
    if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
    setBusy(name);
    setError("");
    try {
      const result = await request<{ confirmationRequired?: string }>(path, body, keys.current.get(signature));
      keys.current.delete(signature);
      onNotify?.(result?.confirmationRequired ? "Waiting for an Owner to confirm the production deployment." : done);
      setReload((value) => value + 1);
      if (name === "apply-detected") setDetectReload((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The deployment request failed.");
    } finally { setBusy(""); }
  }

  if (!state) return error ? <ErrorNotice message={error} /> : <RouteProgress />;
  const environmentNames = orderEnvironments([...(state.environmentOrder ?? Object.keys(state.environments)), ...Object.keys(detection?.setup.environments ?? {})]);
  const switchEditing = (environment: Environment) => { setEditing(environment); setDraft(draftFor(environment, state)); };
  const updateTarget = (index: number, patch: Partial<Target>) => draft && setDraft({ ...draft, targets: draft.targets.map((target, position) => position === index ? { ...target, ...patch } : target) });
  const moveTarget = (index: number, offset: number) => {
    if (!draft) return;
    const targets = draft.targets.slice();
    const [item] = targets.splice(index, 1);
    targets.splice(index + offset, 0, item);
    setDraft({ ...draft, targets });
  };
  const save = () => draft && perform("settings", { action: "settings", environment: editing, enabled: draft.enabled, rollout: draft.rollout, trigger: draft.trigger, mode: draft.mode, targets: draft.targets.map((target) => ({ workerName: target.workerName, configPath: target.configPath.trim(), ...(target.buildCommand?.trim() ? { buildCommand: target.buildCommand.trim() } : {}), d1Migrations: target.d1Migrations, ...(target.watchPaths?.length ? { watchPaths: target.watchPaths } : {}) })) }, `${environmentLabel(editing)} deployment settings saved.`);
  const confirmProduction = (action: string) => window.confirm(`${action} to production? This changes live traffic.`);

  function detectedPanel() {
    if (detectError) return <ErrorNotice message={detectError} />;
    if (!detection) return <p className="cf-muted">Detecting the deploy setup from the Wrangler configs…</p>;
    const { setup, saved, changed } = detection;
    const environments = orderEnvironments(Object.keys(setup.environments)).filter((environment) => setup.environments[environment]);
    const warnings = environments.filter((environment) => environment !== PRODUCTION).flatMap((environment) => setup.environments[environment].warnings);
    const pending = warnings.filter((warning) => !acknowledged.includes(warning.id));
    const current = saved?.fingerprint === setup.fingerprint;
    const blocked = !detection.canApply || setup.errors.length > 0 || !setup.account?.connected || !environments.length || pending.length > 0;
    return (
      <section className="cf-detected" aria-label="Detected setup">
        <h3>Detected setup</h3>
        <p className="cf-state">From the Wrangler configs at <code>{setup.commitSha.slice(0, 12)}</code>{setup.packageManager ? ` · ${setup.packageManager}` : ""}{setup.account?.connected ? ` · account ${setup.account.accountName ? `${setup.account.accountName} ` : ""}${setup.account.accountId} (${setup.account.source} connection)${setup.account.subdomain ? ` · ${setup.account.subdomain}.workers.dev` : ""}` : ""}</p>
        {saved && changed.length > 0 && <p role="status">Setup changed in {changed.map((item) => item.path).join(", ")} since it was saved. Review the new plan and use it again.</p>}
        {saved && current && <p className="cf-state">This repository uses this detected setup (saved {relativeTime(saved.appliedAt)}).</p>}
        {setup.account && !setup.account.connected && <p className="cf-muted">{setup.account.reason}</p>}
        {setup.errors.map((item) => <ErrorNotice key={item} message={item} />)}
        {detection.blocking?.map((item) => <ErrorNotice key={item} message={item} />)}
        {!environments.length && !setup.errors.length && <p className="cf-muted">No Wrangler config was found at the default branch head.</p>}
        <div className="cf-environments">
          {environments.map((environment) => (
            <div key={environment} className="cf-environment">
              <h4>{environmentLabel(environment)}</h4>
              <p className="cf-state">{environment === PRODUCTION ? "Promote with Owner confirmation" : "Deploy on land waits for confirmation until an Owner turns on automatic deploys"}</p>
              <ol className="cf-target-runs">
                {setup.environments[environment].targets.map((target) => (
                  <li key={target.workerName}>
                    <strong>{target.workerName}</strong>{target.exists === false ? " · will be created" : target.exists ? " · exists" : ""} · <code>{target.configPath}</code>
                    <div className="cf-state">{target.buildCommand ? <>Build <code>{target.buildCommand}</code> ({target.buildReasons.join("; ")})</> : "No build step"}{target.d1Migrations ? " · D1 migrations" : ""}{target.dependsOn.length ? ` · after ${target.dependsOn.join(", ")}` : ""}</div>
                    {target.watchPaths.length > 0 && <div className="cf-state">Watch {target.watchPaths.join(", ")}</div>}
                    {target.resources.length > 0 && <div className="cf-state">{target.resources.map((resource) => `${resourceLabels[resource.type]} ${resource.name}${resource.status ? ` (${resourceStatus[resource.status]})` : ""}`).join(" · ")}</div>}
                    <div className="cf-state">{target.urls?.length ? <WorkerUrls urls={target.urls} /> : target.workersDev ? "workers.dev URL after the account subdomain is read" : "No public URL (workers.dev off)"}</div>
                  </li>
                ))}
              </ol>
              {setup.environments[environment].warnings.map((warning) => (
                <label key={warning.id} className="cf-inline cf-warning"><input type="checkbox" disabled={!detection.canAcknowledge} checked={acknowledged.includes(warning.id)} onChange={(event) => setAcknowledged(event.target.checked ? [...acknowledged, warning.id] : acknowledged.filter((id) => id !== warning.id))} /> {warning.message}</label>
              ))}
            </div>
          ))}
        </div>
        {setup.notes.map((note) => <p key={note} className="cf-muted">{note}</p>)}
        <div className="cf-actions">
          <Button variant={current ? "secondary" : "primary"} size="base" disabled={!!busy || blocked} loading={busy === "apply-detected"} onClick={() => void perform("apply-detected", { action: "apply_detected", fingerprint: setup.fingerprint, acknowledge: acknowledged }, "Detected deploy setup saved and its Workers linked.")}>Use detected setup</Button>
          <Button variant="secondary" size="base" disabled={!!busy} onClick={() => setDetectReload((value) => value + 1)}>Re-detect</Button>
          {pending.length > 0 && <span className="cf-muted">{detection.canAcknowledge ? "Acknowledge every warning first." : "An Owner must acknowledge the warnings."}</span>}
          {!detection.canApply && <span className="cf-muted">Requires the Owner or Deployer role.</span>}
        </div>
      </section>
    );
  }

  function environmentCard(environment: Environment) {
    const view: EnvironmentState = state!.environments[environment] ?? { settings: null, current: null, lastChange: null, pending: null, running: false, canDeploy: false };
    const latest = state!.deployments.find(item => item.environment === environment && ACTIVE.includes(item.status)) ?? state!.deployments.find(item => item.id === view.lastChange?.deploymentId);
    const stages = latest?.mode === "upload-only" ? ["Queued", "Build", "Upload", "Uploaded"] : ["Queued", "Build", "Deploy", "Rollout", "Live"];
    const stage = latest ? ({ queued: 0, building: 1, deploying: 2, rolling_out: 3, succeeded: 4, uploaded: 3 } as Partial<Record<Status, number>>)[latest.status] : undefined;
    const settings = view.settings;
    const targets = settings?.targets ?? [];
    const chosen = selection[environment] ?? targets.map((target) => target.workerName);
    const toggle = (workerName: string) => setSelection({ ...selection, [environment]: chosen.includes(workerName) ? chosen.filter((name) => name !== workerName) : targets.map((target) => target.workerName).filter((name) => name === workerName || chosen.includes(name)) });
    const production = environment === PRODUCTION;
    const confirmWithOwner = production && view.canConfirm && settings?.trigger !== "auto";
    const deployBody = { action: "deploy", environment, commitSha: repository.headSha, ...(chosen.length < targets.length ? { targets: chosen } : {}), ...(confirmWithOwner ? { confirm: true } : {}) };
    const promotions = production ? environmentNames.filter((name) => name !== PRODUCTION && state!.environments[name]?.promotable).map((name) => ({ from: name, ...state!.environments[name].promotable! })) : [];
    return (
      <section key={environment} className="cf-environment" aria-label={`${environmentLabel(environment)} environment`}>
        <h3>{environmentLabel(environment)}</h3>
        {latest && <div className="operation-deployment"><div className="operation-deployment-heading"><strong>{labels[latest.status]}</strong><span>{latest.commitSha?.slice(0, 12) ?? "Deployment"}</span></div><OperationTrack kind="deploy" active={ACTIVE.includes(latest.status)} step={stage ?? 0} steps={stages.length} failed={latest.status === "failed"} />{stage !== undefined && <ol className="operation-deployment-steps" aria-label="Deployment stages">{stages.map((label, index) => <li key={label} aria-current={index === stage ? "step" : undefined}>{label}</li>)}</ol>}</div>}
        {!settings ? <p className="cf-muted">Not configured.</p> : (
          <>
            <p className="cf-state">{settings.enabled ? (production ? (settings.trigger === "auto" ? "Deploys automatically after staging (Owner opt-in)" : "Promote or deploy with Owner confirmation") : settings.trigger === "auto" ? "Deploys automatically on land" : "Deploy on land waits for confirmation") : "Manual only"}{settings.mode === "upload-only" ? " · upload versions only" : ""}</p>
            <dl className="cf-environment-facts">
              <dt>Current commit</dt><dd>{view.current?.commitSha ? <code>{view.current.commitSha.slice(0, 12)}</code> : "—"}{view.current ? ` · ${labels[view.current.status]}` : ""}</dd>
              <dt>Workers</dt><dd>{view.current?.workers.length ? <ul className="cf-target-runs">{view.current.workers.map((worker) => <li key={worker.workerName}><strong>{worker.workerName}</strong> · <code>{worker.versionId.slice(0, 8)}</code>{worker.percentage < 100 ? ` · ${worker.percentage}%` : ""}<WorkerUrls urls={worker.urls} /></li>)}</ul> : "—"}</dd>
              <dt>Last change</dt><dd>{view.lastChange ? <>{labels[view.lastChange.status]} · {triggers[view.lastChange.trigger]} · {relativeTime(view.lastChange.updatedAt)}{view.lastChange.error ? ` · ${view.lastChange.error}` : ""}</> : "—"}</dd>
            </dl>
            {view.deployBlockedReason && <ErrorNotice message={view.deployBlockedReason} />}
            {targets.length > 1 && (
              <fieldset className="cf-target-choice">
                <legend>Targets to deploy</legend>
                {targets.map((target) => <label key={target.workerName} className="cf-inline"><input type="checkbox" checked={chosen.includes(target.workerName)} onChange={() => toggle(target.workerName)} /> {target.workerName}</label>)}
              </fieldset>
            )}
            <div className="cf-actions">
              {view.pending && (!production || view.canConfirm) && <Button variant="primary" size="base" disabled={!!busy || view.running || !view.canDeploy} loading={busy === `${environment}-confirm`} onClick={() => (!production || confirmProduction("Deploy")) && void perform(`${environment}-confirm`, { action: "deploy", deploymentId: view.pending }, "Deployment started.")}>Confirm pending deploy</Button>}
              {view.pending && production && !view.canConfirm && <span className="cf-muted">Waiting for an Owner to confirm.</span>}
              {promotions.map((promotable) => <Button key={promotable.from} variant="primary" size="base" disabled={!!busy || view.running || !view.canDeploy} loading={busy === `promote-${promotable.from}`} onClick={() => (!confirmWithOwner || confirmProduction("Promote")) && void perform(`promote-${promotable.from}`, { action: "promote", deploymentId: promotable.deploymentId, ...(confirmWithOwner ? { confirm: true } : {}) }, "Promotion to production started.")}>Promote {promotable.commitSha.slice(0, 12)} from {environmentLabel(promotable.from)}</Button>)}
              {repository.headSha && <Button variant="secondary" size="base" disabled={!!busy || view.running || !view.canDeploy || !chosen.length} loading={busy === `${environment}-deploy`} onClick={() => (!confirmWithOwner || confirmProduction("Deploy")) && void perform(`${environment}-deploy`, deployBody, "Deployment started.")}>Deploy {repository.defaultBranch} ({repository.headSha.slice(0, 12)}){chosen.length < targets.length ? ` · ${chosen.length} of ${targets.length}` : ""}</Button>}
              {view.current && <Button variant="secondary" size="base" disabled={!!busy || !view.canDeploy} loading={busy === `${environment}-rollback`} onClick={() => (!production || confirmProduction("Roll back")) && void perform(`${environment}-rollback`, { action: "rollback", environment }, "Rollback started.")}>Roll back</Button>}
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header"><h2>Deployments</h2></div>
      <div className="panel-body">
        <p>Ship landed commits to this repository’s Workers with its Cloudflare connection. Every <code>env.&lt;name&gt;</code> block in the Wrangler configs is an environment, built as <code>wrangler deploy --env &lt;name&gt;</code> does; production uses the top level. Staging deploys on land, other environments wait for Deploy unless switched to automatic, and production is promoted from a successful deployment with an Owner’s confirmation. Requires the Owner or Deployer role.</p>
        {detectedPanel()}
        <div className="cf-environments">{environmentNames.map(environmentCard)}</div>
        {error && <ErrorNotice message={error} />}
        {!state.workers.length ? <p className="cf-muted">Use the detected setup above, or link a Worker to this repository, to configure deployments by hand.</p> : draft && (
          <details className="cf-environment-settings">
            <summary>Settings</summary>
            <div className="cf-form-row">
              <label>Environment<select value={editing} onChange={(event) => switchEditing(event.target.value as Environment)}>{environmentNames.map((environment) => <option key={environment} value={environment}>{environmentLabel(environment)}</option>)}</select></label>
            </div>
            <div className="cf-targets">
              {draft.targets.map((target, index) => (
                <fieldset key={index} className="cf-target">
                  <legend>Target {index + 1}</legend>
                  <label>Worker<select value={target.workerName} onChange={(event) => updateTarget(index, { workerName: event.target.value })}>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
                  <label>Wrangler config<input value={target.configPath} placeholder="apps/api/wrangler.jsonc" onChange={(event) => updateTarget(index, { configPath: event.target.value })} /></label>
                  <label>Build command (optional)<input value={target.buildCommand ?? ""} placeholder="pnpm --filter @app/web build" onChange={(event) => updateTarget(index, { buildCommand: event.target.value })} /></label>
                  <label>Watch paths (optional, one per line)<textarea rows={3} value={(target.watchPaths ?? []).join("\n")} placeholder={"apps/api/**\npackages/**\npnpm-lock.yaml"} onChange={(event) => updateTarget(index, { watchPaths: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} /></label>
                  <label className="cf-inline"><input type="checkbox" checked={target.d1Migrations} onChange={(event) => updateTarget(index, { d1Migrations: event.target.checked })} /> Apply D1 migrations first</label>
                  <div className="cf-target-actions">
                    <Button variant="secondary" size="sm" disabled={index === 0} onClick={() => moveTarget(index, -1)}>Move up</Button>
                    <Button variant="secondary" size="sm" disabled={index === draft.targets.length - 1} onClick={() => moveTarget(index, 1)}>Move down</Button>
                    <Button variant="secondary" size="sm" disabled={draft.targets.length === 1} onClick={() => setDraft({ ...draft, targets: draft.targets.filter((_, position) => position !== index) })}>Remove</Button>
                  </div>
                </fieldset>
              ))}
              {draft.targets.length < 5 && <Button variant="secondary" size="sm" onClick={() => setDraft({ ...draft, targets: [...draft.targets, { workerName: state.workers.find((worker) => !draft.targets.some((target) => target.workerName === worker.id))?.id ?? state.workers[0].id, configPath: "", d1Migrations: false }] })}>Add target</Button>}
            </div>
            <div className="cf-form-row">
              <label>Rollout<select value={draft.rollout} onChange={(event) => setDraft({ ...draft, rollout: event.target.value as Settings["rollout"] })}><option value="immediate">100% at once</option><option value="gradual">10%, then 100% after 10 minutes</option></select></label>
              <label>Mode<select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Settings["mode"] })}><option value="deploy">Deploy</option><option value="upload-only">Upload versions only (no traffic, no migrations)</option></select></label>
              <label>{editing === PRODUCTION ? "After a promotable deployment succeeds" : "After landing"}<select value={draft.trigger} onChange={(event) => setDraft({ ...draft, trigger: event.target.value as Settings["trigger"] })}><option value="manual">{editing === PRODUCTION ? "Wait for Owner confirmation" : "Wait for Deploy"}</option><option value="auto">{editing === PRODUCTION ? "Deploy automatically (Owner only)" : "Deploy automatically"}</option></select></label>
              <label className="cf-inline"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Deploy on land</label>
              <Button variant="secondary" size="base" disabled={!!busy} loading={busy === "settings"} onClick={() => void save()}>Save {environmentLabel(editing).toLowerCase()}</Button>
            </div>
          </details>
        )}
        {state.deployments.length > 0 && (
          <table className="cf-deployments">
            <thead><tr><th>Environment</th><th>Status</th><th>Commit</th><th>Workers</th><th>Traffic</th><th>When</th></tr></thead>
            <tbody>{state.deployments.map((item) => (
              <tr key={item.id} title={item.error}>
                <td>{environmentLabel(item.environment)}</td>
                <td>{labels[item.status]} · {triggers[item.trigger]}{item.mode === "upload-only" ? " · upload only" : ""}{item.error ? ` · ${item.error}` : ""}</td>
                <td><code>{item.commitSha?.slice(0, 12) ?? "—"}</code></td>
                <td>
                  {item.targets?.length ? <ul className="cf-target-runs">{item.targets.map((target) => <li key={target.workerName} title={target.notes?.join("\n")}><strong>{target.workerName}</strong> · {targetSummary(target)}<WorkerUrls urls={target.urls} /></li>)}</ul> : !item.skippedTargets?.length ? <>{item.workerName} · <code>{item.versionId?.slice(0, 8) ?? "—"}</code></> : null}
                  {item.skippedTargets?.length ? <ul className="cf-target-runs">{item.skippedTargets.map((target) => <li key={target.workerName} className="cf-muted">{target.workerName} · skipped: {target.reason}</li>)}</ul> : null}
                  {item.targetsSource === "gitflare.json" ? <span className="cf-state"> (targets from gitflare.json)</span> : null}
                </td>
                <td>{item.percentage}%</td>
                <td>{relativeTime(item.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
