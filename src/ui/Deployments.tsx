import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { RouteProgress } from "./WorkspaceLoader";
import "./cloudflare-connection.css";

type Status = "awaiting_confirmation" | "queued" | "building" | "deploying" | "rolling_out" | "succeeded" | "failed" | "superseded";
interface Deployment { id: string; workerName: string; environment: string; commitSha: string | null; trigger: "land" | "manual" | "rollback"; status: Status; percentage: number; versionId?: string; actorId: string; createdAt: string; error?: string; errorCode?: string }
interface Settings { enabled: boolean; workerName: string; environment: "production" | "staging"; rollout: "immediate" | "gradual"; confirmation: "manual" | "auto" }
interface State { settings: Settings | null; deployments: Deployment[]; workers: { id: string; name: string; environment: string }[]; canDeploy: boolean }

const labels: Record<Status, string> = { awaiting_confirmation: "Waiting for Deploy", queued: "Queued", building: "Building", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", failed: "Failed", superseded: "Superseded" };
const ACTIVE: Status[] = ["queued", "building", "deploying", "rolling_out"];

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
      setDraft((current) => current ?? value.settings ?? (value.workers[0] ? { enabled: false, workerName: value.workers[0].id, environment: "production", rollout: "immediate", confirmation: "manual" } : null));
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
  return (
    <section className="panel">
      <div className="panel-header"><h2>Deployments</h2>{state.settings && <span className="cf-state">{state.settings.enabled ? `Deploy on land · ${state.settings.confirmation === "auto" ? "automatic" : "confirm first"}` : "Manual only"}</span>}</div>
      <div className="panel-body">
        <p>Ship landed commits to this repository’s own Worker with your Cloudflare connection. Bindings and secrets already on the Worker are kept. Requires the Workers Scripts Write grant and the Owner or Deployer role.</p>
        {!state.workers.length ? <p>Link a Worker to this repository above to enable deployments.</p> : draft && (
          <div className="cf-form-row">
            <label>Worker<select value={draft.workerName} disabled={!state.canDeploy && !!state.settings} onChange={(event) => setDraft({ ...draft, workerName: event.target.value })}>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
            <label>Environment<select value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value as Settings["environment"] })}><option value="production">Production</option><option value="staging">Staging</option></select></label>
            <label>Rollout<select value={draft.rollout} onChange={(event) => setDraft({ ...draft, rollout: event.target.value as Settings["rollout"] })}><option value="immediate">100% at once</option><option value="gradual">10%, then 100% after 10 minutes</option></select></label>
            <label>After landing<select value={draft.confirmation} onChange={(event) => setDraft({ ...draft, confirmation: event.target.value as Settings["confirmation"] })}><option value="manual">Wait for Deploy</option><option value="auto">Deploy automatically</option></select></label>
            <label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Deploy on land</label>
            <Button variant="secondary" size="base" disabled={!!busy} loading={busy === "settings"} onClick={() => void perform("settings", { action: "settings", ...draft }, "Deployment settings saved.")}>Save</Button>
          </div>
        )}
        <div className="cf-actions">
          {pending && <Button variant="primary" size="base" disabled={!!busy || running || !state.canDeploy} loading={busy === "confirm"} onClick={() => void perform("confirm", { action: "deploy", deploymentId: pending.id }, "Deployment started.")}>Deploy {pending.commitSha?.slice(0, 12)}</Button>}
          {!pending && state.settings && repository.headSha && <Button variant="secondary" size="base" disabled={!!busy || running || !state.canDeploy} loading={busy === "deploy"} onClick={() => void perform("deploy", { action: "deploy", commitSha: repository.headSha }, "Deployment started.")}>Deploy {repository.defaultBranch} ({repository.headSha.slice(0, 12)})</Button>}
          {live && <Button variant="secondary" size="base" disabled={!!busy || !state.canDeploy} loading={busy === "rollback"} onClick={() => void perform("rollback", { action: "rollback" }, "Rollback started.")}>Roll back</Button>}
        </div>
        {error && <ErrorNotice message={error} />}
        {state.deployments.length > 0 && (
          <table className="cf-deployments">
            <thead><tr><th>Status</th><th>Commit</th><th>Worker</th><th>Version</th><th>Traffic</th><th>When</th></tr></thead>
            <tbody>{state.deployments.map((item) => (
              <tr key={item.id} title={item.error}>
                <td>{labels[item.status]}{item.trigger === "rollback" ? " · rollback" : ""}{item.error ? ` · ${item.error}` : ""}</td>
                <td><code>{item.commitSha?.slice(0, 12) ?? "—"}</code></td>
                <td>{item.workerName} · {item.environment}</td>
                <td><code>{item.versionId?.slice(0, 8) ?? "—"}</code></td>
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
