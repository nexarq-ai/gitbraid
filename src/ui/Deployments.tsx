import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { RouteProgress } from "./WorkspaceLoader";
import "./cloudflare-connection.css";

type Environment = "staging" | "production";
type Status = "awaiting_confirmation" | "queued" | "building" | "deploying" | "rolling_out" | "succeeded" | "uploaded" | "failed" | "superseded" | "skipped";
type TargetStatus = "pending" | "building" | "uploaded" | "deploying" | "rolling_out" | "succeeded" | "failed" | "skipped";
type Trigger = "land" | "manual" | "rollback" | "promote";
interface Target { workerName: string; configPath: string; buildCommand?: string; d1Migrations: boolean; watchPaths?: string[] }
interface TargetRun extends Target { status: TargetStatus; percentage: number; versionId?: string; migrations?: { databaseName: string; applied: string[]; pending: string[]; failed?: { name: string; error: string } }[]; durableObjectMigration?: { old_tag?: string; new_tag: string }; assets?: { uploaded: number; total: number }; notes?: string[]; error?: string }
interface Deployment { id: string; workerName: string; environment: Environment; mode?: "deploy" | "upload-only"; commitSha: string | null; trigger: Trigger; status: Status; percentage: number; versionId?: string; targets?: TargetRun[]; skippedTargets?: { workerName: string; reason: string }[]; promotedFrom?: string; targetsSource?: string; actorId: string; createdAt: string; error?: string; errorCode?: string }
interface Settings { enabled: boolean; workerName: string; rollout: "immediate" | "gradual"; trigger: "manual" | "auto"; mode: "deploy" | "upload-only"; targets: Target[] }
interface EnvironmentState {
  settings: Settings | null;
  current: { deploymentId: string; commitSha: string | null; trigger: Trigger; status: Status; updatedAt: string; workers: { workerName: string; versionId: string; percentage: number }[] } | null;
  lastChange: { deploymentId: string; commitSha: string | null; trigger: Trigger; status: Status; updatedAt: string; error?: string } | null;
  pending: string | null;
  running: boolean;
  promotable?: { deploymentId: string; commitSha: string } | null;
  canDeploy: boolean;
  canConfirm?: boolean;
}
interface State { environments: Record<Environment, EnvironmentState>; deployments: Deployment[]; workers: { id: string; name: string; environment: string }[] }

const ENVIRONMENTS: Environment[] = ["staging", "production"];
const names: Record<Environment, string> = { staging: "Staging", production: "Production" };
const labels: Record<Status, string> = { awaiting_confirmation: "Waiting for confirmation", queued: "Queued", building: "Building", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", uploaded: "Uploaded", failed: "Failed", superseded: "Superseded", skipped: "Nothing to deploy" };
const triggers: Record<Trigger, string> = { land: "on land", manual: "manual", rollback: "rollback", promote: "promoted from staging" };
const targetLabels: Record<TargetStatus, string> = { pending: "Pending", building: "Building", uploaded: "Uploaded", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", failed: "Failed", skipped: "Skipped" };
const ACTIVE: Status[] = ["queued", "building", "deploying", "rolling_out"];
const defaults: Record<Environment, Settings["trigger"]> = { staging: "auto", production: "manual" };

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
  const saved = state.environments[environment].settings;
  if (saved) return { ...saved, targets: saved.targets.map((target) => ({ ...target, configPath: target.configPath || "wrangler.jsonc" })) };
  const production = state.environments.production.settings;
  if (environment === "staging" && production) return { ...production, enabled: true, trigger: "auto", targets: production.targets.map((target) => ({ ...target, workerName: state.workers.find((worker) => worker.id === `${target.workerName}-staging`)?.id ?? target.workerName })) };
  const worker = state.workers[0];
  return worker ? { enabled: environment === "staging", workerName: worker.id, rollout: "immediate", trigger: defaults[environment], mode: "deploy", targets: [{ workerName: worker.id, configPath: "wrangler.jsonc", d1Migrations: false }] } : null;
}

export default function Deployments({ repository, onNotify }: { repository: Repository; onNotify?: (message: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [editing, setEditing] = useState<Environment>("staging");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [selection, setSelection] = useState<Record<Environment, string[] | null>>({ staging: null, production: null });
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
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The deployment request failed.");
    } finally { setBusy(""); }
  }

  if (!state) return error ? <ErrorNotice message={error} /> : <RouteProgress />;
  const switchEditing = (environment: Environment) => { setEditing(environment); setDraft(draftFor(environment, state)); };
  const updateTarget = (index: number, patch: Partial<Target>) => draft && setDraft({ ...draft, targets: draft.targets.map((target, position) => position === index ? { ...target, ...patch } : target) });
  const moveTarget = (index: number, offset: number) => {
    if (!draft) return;
    const targets = draft.targets.slice();
    const [item] = targets.splice(index, 1);
    targets.splice(index + offset, 0, item);
    setDraft({ ...draft, targets });
  };
  const save = () => draft && perform("settings", { action: "settings", environment: editing, enabled: draft.enabled, rollout: draft.rollout, trigger: draft.trigger, mode: draft.mode, targets: draft.targets.map((target) => ({ workerName: target.workerName, configPath: target.configPath.trim(), ...(target.buildCommand?.trim() ? { buildCommand: target.buildCommand.trim() } : {}), d1Migrations: target.d1Migrations, ...(target.watchPaths?.length ? { watchPaths: target.watchPaths } : {}) })) }, `${names[editing]} deployment settings saved.`);
  const confirmProduction = (action: string) => window.confirm(`${action} to production? This changes live traffic.`);

  function environmentCard(environment: Environment) {
    const view = state!.environments[environment];
    const settings = view.settings;
    const targets = settings?.targets ?? [];
    const chosen = selection[environment] ?? targets.map((target) => target.workerName);
    const toggle = (workerName: string) => setSelection({ ...selection, [environment]: chosen.includes(workerName) ? chosen.filter((name) => name !== workerName) : targets.map((target) => target.workerName).filter((name) => name === workerName || chosen.includes(name)) });
    const production = environment === "production";
    const confirmWithOwner = production && view.canConfirm && settings?.trigger !== "auto";
    const deployBody = { action: "deploy", environment, commitSha: repository.headSha, ...(chosen.length < targets.length ? { targets: chosen } : {}), ...(confirmWithOwner ? { confirm: true } : {}) };
    const promotable = state!.environments.staging.promotable;
    return (
      <section key={environment} className="cf-environment" aria-label={`${names[environment]} environment`}>
        <h3>{names[environment]}</h3>
        {!settings ? <p className="cf-muted">Not configured.</p> : (
          <>
            <p className="cf-state">{settings.enabled ? (production ? (settings.trigger === "auto" ? "Deploys automatically after staging (Owner opt-in)" : "Promote or deploy with Owner confirmation") : settings.trigger === "auto" ? "Deploys automatically on land" : "Deploy on land waits for confirmation") : "Manual only"}{settings.mode === "upload-only" ? " · upload versions only" : ""}</p>
            <dl className="cf-environment-facts">
              <dt>Current commit</dt><dd>{view.current?.commitSha ? <code>{view.current.commitSha.slice(0, 12)}</code> : "—"}{view.current ? ` · ${labels[view.current.status]}` : ""}</dd>
              <dt>Workers</dt><dd>{view.current?.workers.length ? <ul className="cf-target-runs">{view.current.workers.map((worker) => <li key={worker.workerName}><strong>{worker.workerName}</strong> · <code>{worker.versionId.slice(0, 8)}</code>{worker.percentage < 100 ? ` · ${worker.percentage}%` : ""}</li>)}</ul> : "—"}</dd>
              <dt>Last change</dt><dd>{view.lastChange ? <>{labels[view.lastChange.status]} · {triggers[view.lastChange.trigger]} · {relativeTime(view.lastChange.updatedAt)}{view.lastChange.error ? ` · ${view.lastChange.error}` : ""}</> : "—"}</dd>
            </dl>
            {targets.length > 1 && (
              <fieldset className="cf-target-choice">
                <legend>Targets to deploy</legend>
                {targets.map((target) => <label key={target.workerName} className="cf-inline"><input type="checkbox" checked={chosen.includes(target.workerName)} onChange={() => toggle(target.workerName)} /> {target.workerName}</label>)}
              </fieldset>
            )}
            <div className="cf-actions">
              {view.pending && (!production || view.canConfirm) && <Button variant="primary" size="base" disabled={!!busy || view.running || !view.canDeploy} loading={busy === `${environment}-confirm`} onClick={() => (!production || confirmProduction("Deploy")) && void perform(`${environment}-confirm`, { action: "deploy", deploymentId: view.pending }, "Deployment started.")}>Confirm pending deploy</Button>}
              {view.pending && production && !view.canConfirm && <span className="cf-muted">Waiting for an Owner to confirm.</span>}
              {production && promotable && state!.environments.staging.settings && <Button variant="primary" size="base" disabled={!!busy || view.running || !view.canDeploy} loading={busy === "promote"} onClick={() => (!confirmWithOwner || confirmProduction("Promote")) && void perform("promote", { action: "promote", deploymentId: promotable.deploymentId, ...(confirmWithOwner ? { confirm: true } : {}) }, "Promotion to production started.")}>Promote {promotable.commitSha.slice(0, 12)} to production</Button>}
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
        <p>Ship landed commits to this repository’s Workers with its Cloudflare connection. Staging builds each Wrangler config with its <code>env.staging</code> block, as <code>wrangler deploy --env staging</code> does; production uses the top level. Staging deploys on land; production is promoted from a successful staging deployment or deployed directly, with an Owner’s confirmation unless an Owner turned on automatic production deploys. Requires the Owner or Deployer role.</p>
        <div className="cf-environments">{ENVIRONMENTS.map(environmentCard)}</div>
        {error && <ErrorNotice message={error} />}
        {!state.workers.length ? <p>Link a Worker to this repository above to enable deployments.</p> : draft && (
          <details className="cf-environment-settings">
            <summary>Settings</summary>
            <div className="cf-form-row">
              <label>Environment<select value={editing} onChange={(event) => switchEditing(event.target.value as Environment)}>{ENVIRONMENTS.map((environment) => <option key={environment} value={environment}>{names[environment]}</option>)}</select></label>
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
              <label>{editing === "production" ? "After staging succeeds" : "After landing"}<select value={draft.trigger} onChange={(event) => setDraft({ ...draft, trigger: event.target.value as Settings["trigger"] })}><option value="manual">{editing === "production" ? "Wait for Owner confirmation" : "Wait for Deploy"}</option><option value="auto">{editing === "production" ? "Deploy automatically (Owner only)" : "Deploy automatically"}</option></select></label>
              <label className="cf-inline"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Deploy on land</label>
              <Button variant="secondary" size="base" disabled={!!busy} loading={busy === "settings"} onClick={() => void save()}>Save {names[editing].toLowerCase()}</Button>
            </div>
          </details>
        )}
        {state.deployments.length > 0 && (
          <table className="cf-deployments">
            <thead><tr><th>Environment</th><th>Status</th><th>Commit</th><th>Workers</th><th>Traffic</th><th>When</th></tr></thead>
            <tbody>{state.deployments.map((item) => (
              <tr key={item.id} title={item.error}>
                <td>{names[item.environment] ?? item.environment}</td>
                <td>{labels[item.status]} · {triggers[item.trigger]}{item.mode === "upload-only" ? " · upload only" : ""}{item.error ? ` · ${item.error}` : ""}</td>
                <td><code>{item.commitSha?.slice(0, 12) ?? "—"}</code></td>
                <td>
                  {item.targets?.length ? <ul className="cf-target-runs">{item.targets.map((target) => <li key={target.workerName} title={target.notes?.join("\n")}><strong>{target.workerName}</strong> · {targetSummary(target)}</li>)}</ul> : !item.skippedTargets?.length ? <>{item.workerName} · <code>{item.versionId?.slice(0, 8) ?? "—"}</code></> : null}
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
