import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { RouteProgress } from "./WorkspaceLoader";
import "./cloudflare-connection.css";

type Status = "awaiting_confirmation" | "queued" | "building" | "deploying" | "rolling_out" | "succeeded" | "uploaded" | "failed" | "superseded";
type TargetStatus = "pending" | "building" | "uploaded" | "deploying" | "rolling_out" | "succeeded" | "failed" | "skipped";
interface Target { workerName: string; configPath: string; buildCommand?: string; d1Migrations: boolean }
interface TargetRun extends Target { status: TargetStatus; percentage: number; versionId?: string; migrations?: { databaseName: string; applied: string[]; pending: string[]; failed?: { name: string; error: string } }[]; durableObjectMigration?: { old_tag?: string; new_tag: string }; assets?: { uploaded: number; total: number }; notes?: string[]; error?: string }
interface Deployment { id: string; workerName: string; environment: string; mode?: "deploy" | "upload-only"; commitSha: string | null; trigger: "land" | "manual" | "rollback"; status: Status; percentage: number; versionId?: string; targets?: TargetRun[]; targetsSource?: string; actorId: string; createdAt: string; error?: string; errorCode?: string }
interface Settings { enabled: boolean; workerName: string; environment: "production" | "staging"; rollout: "immediate" | "gradual"; confirmation: "manual" | "auto"; mode: "deploy" | "upload-only"; targets: Target[] }
interface State { settings: Settings | null; deployments: Deployment[]; workers: { id: string; name: string; environment: string }[]; canDeploy: boolean }

const labels: Record<Status, string> = { awaiting_confirmation: "Waiting for Deploy", queued: "Queued", building: "Building", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", uploaded: "Uploaded", failed: "Failed", superseded: "Superseded" };
const targetLabels: Record<TargetStatus, string> = { pending: "Pending", building: "Building", uploaded: "Uploaded", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", failed: "Failed", skipped: "Skipped" };
const ACTIVE: Status[] = ["queued", "building", "deploying", "rolling_out"];

function targetSummary(target: TargetRun): string {
  const parts = [targetLabels[target.status]];
  if (target.versionId) parts.push(`version ${target.versionId.slice(0, 8)}`);
  if (target.migrations?.length) parts.push(target.migrations.map((item) => item.failed ? `D1 ${item.databaseName}: ${item.failed.name} failed` : `D1 ${item.databaseName}: ${item.applied.length} applied`).join(", "));
  if (target.durableObjectMigration) parts.push(`DO migration ${target.durableObjectMigration.new_tag}`);
  if (target.assets) parts.push(`${target.assets.uploaded}/${target.assets.total} assets uploaded`);
  if (target.error) parts.push(target.error);
  return parts.join(" · ");
}

export default function Deployments({ repository, onNotify }: { repository: Repository; onNotify?: (message: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
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
      const fallback = value.workers[0] ? { enabled: false, workerName: value.workers[0].id, environment: "production" as const, rollout: "immediate" as const, confirmation: "manual" as const, mode: "deploy" as const, targets: [{ workerName: value.workers[0].id, configPath: "wrangler.jsonc", d1Migrations: false }] } : null;
      setDraft((current) => current ?? (value.settings ? { ...value.settings, targets: value.settings.targets.map((target) => ({ ...target, configPath: target.configPath || "wrangler.jsonc" })) } : fallback));
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
      await request(path, body, keys.current.get(signature));
      keys.current.delete(signature);
      onNotify?.(done);
      setReload((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The deployment request failed.");
    } finally { setBusy(""); }
  }

  if (!state) return error ? <ErrorNotice message={error} /> : <RouteProgress />;
  const pending = state.deployments.find((item) => item.status === "awaiting_confirmation");
  const live = state.deployments.find((item) => item.status === "succeeded" || item.status === "rolling_out");
  const running = state.deployments.some((item) => ACTIVE.includes(item.status));
  const updateTarget = (index: number, patch: Partial<Target>) => draft && setDraft({ ...draft, targets: draft.targets.map((target, position) => position === index ? { ...target, ...patch } : target) });
  const moveTarget = (index: number, offset: number) => {
    if (!draft) return;
    const targets = draft.targets.slice();
    const [item] = targets.splice(index, 1);
    targets.splice(index + offset, 0, item);
    setDraft({ ...draft, targets });
  };
  const save = () => draft && perform("settings", { action: "settings", enabled: draft.enabled, environment: draft.environment, rollout: draft.rollout, confirmation: draft.confirmation, mode: draft.mode, targets: draft.targets.map((target) => ({ workerName: target.workerName, configPath: target.configPath.trim(), ...(target.buildCommand?.trim() ? { buildCommand: target.buildCommand.trim() } : {}), d1Migrations: target.d1Migrations })) }, "Deployment settings saved.");
  return (
    <section className="panel">
      <div className="panel-header"><h2>Deployments</h2>{state.settings && <span className="cf-state">{state.settings.enabled ? `Deploy on land · ${state.settings.confirmation === "auto" ? "automatic" : "confirm first"}` : "Manual only"}{state.settings.mode === "upload-only" ? " · upload versions only" : ""}</span>}</div>
      <div className="panel-body">
        <p>Ship landed commits to this repository’s Workers with its Cloudflare connection. Each target builds from its Wrangler config with the same bindings, static assets, Durable Object migrations, queues, workflows and custom domains <code>wrangler deploy</code> would set; secrets on the Worker are kept. Targets deploy in order and stop at the first failure. Requires the Owner or Deployer role; automatic production deploys need an Owner.</p>
        {!state.workers.length ? <p>Link a Worker to this repository above to enable deployments.</p> : draft && (
          <>
            <div className="cf-targets">
              {draft.targets.map((target, index) => (
                <fieldset key={index} className="cf-target">
                  <legend>Target {index + 1}</legend>
                  <label>Worker<select value={target.workerName} onChange={(event) => updateTarget(index, { workerName: event.target.value })}>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
                  <label>Wrangler config<input value={target.configPath} placeholder="apps/api/wrangler.jsonc" onChange={(event) => updateTarget(index, { configPath: event.target.value })} /></label>
                  <label>Build command (optional)<input value={target.buildCommand ?? ""} placeholder="pnpm --filter @app/web build" onChange={(event) => updateTarget(index, { buildCommand: event.target.value })} /></label>
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
              <label>Environment<select value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value as Settings["environment"] })}><option value="production">Production</option><option value="staging">Staging</option></select></label>
              <label>Rollout<select value={draft.rollout} onChange={(event) => setDraft({ ...draft, rollout: event.target.value as Settings["rollout"] })}><option value="immediate">100% at once</option><option value="gradual">10%, then 100% after 10 minutes</option></select></label>
              <label>Mode<select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Settings["mode"] })}><option value="deploy">Deploy</option><option value="upload-only">Upload versions only (no traffic, no migrations)</option></select></label>
              <label>After landing<select value={draft.confirmation} onChange={(event) => setDraft({ ...draft, confirmation: event.target.value as Settings["confirmation"] })}><option value="manual">Wait for Deploy</option><option value="auto">Deploy automatically</option></select></label>
              <label className="cf-inline"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Deploy on land</label>
              <Button variant="secondary" size="base" disabled={!!busy} loading={busy === "settings"} onClick={() => void save()}>Save</Button>
            </div>
          </>
        )}
        <div className="cf-actions">
          {pending && <Button variant="primary" size="base" disabled={!!busy || running || !state.canDeploy} loading={busy === "confirm"} onClick={() => void perform("confirm", { action: "deploy", deploymentId: pending.id }, "Deployment started.")}>Deploy {pending.commitSha?.slice(0, 12)}</Button>}
          {!pending && state.settings && repository.headSha && <Button variant="secondary" size="base" disabled={!!busy || running || !state.canDeploy} loading={busy === "deploy"} onClick={() => void perform("deploy", { action: "deploy", commitSha: repository.headSha }, "Deployment started.")}>Deploy {repository.defaultBranch} ({repository.headSha.slice(0, 12)})</Button>}
          {live && <Button variant="secondary" size="base" disabled={!!busy || !state.canDeploy} loading={busy === "rollback"} onClick={() => void perform("rollback", { action: "rollback" }, "Rollback started.")}>Roll back</Button>}
        </div>
        {error && <ErrorNotice message={error} />}
        {state.deployments.length > 0 && (
          <table className="cf-deployments">
            <thead><tr><th>Status</th><th>Commit</th><th>Workers</th><th>Traffic</th><th>When</th></tr></thead>
            <tbody>{state.deployments.map((item) => (
              <tr key={item.id} title={item.error}>
                <td>{labels[item.status]}{item.trigger === "rollback" ? " · rollback" : ""}{item.mode === "upload-only" ? " · upload only" : ""}{item.error ? ` · ${item.error}` : ""}</td>
                <td><code>{item.commitSha?.slice(0, 12) ?? "—"}</code></td>
                <td>{item.targets?.length ? <ul className="cf-target-runs">{item.targets.map((target) => <li key={target.workerName} title={target.notes?.join("\n")}><strong>{target.workerName}</strong> · {targetSummary(target)}</li>)}</ul> : <>{item.workerName} · <code>{item.versionId?.slice(0, 8) ?? "—"}</code></>}{item.targetsSource === "gitflare.json" ? <span className="cf-state"> (targets from gitflare.json)</span> : null} · {item.environment}</td>
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
