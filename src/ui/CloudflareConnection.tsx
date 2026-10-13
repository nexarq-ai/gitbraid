import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowClockwiseIcon, ArrowLeftIcon } from "@phosphor-icons/react";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice } from "./components";
import cloudflareIcon from "./assets/cloudflare-icon.svg";
import "./cloudflare-connection.css";

type Account = { id: string; name: string };
type Connection = { configured: boolean; connected: boolean; expiresAt?: number; identity?: { subject: string; email?: string }; account?: Account; scopes?: string[] };
type Resources = { account: Account; workers: { id: string; name: string }[]; durableObjects: { id: string; name: string; script?: string }[]; databases: { id: string; name: string }[] };
type Mapping = { accountId: string; version: string; workerName?: string; d1DatabaseId?: string; durableObjectNamespaceId?: string; updatedAt: string };
type MigrationPlan = { id: string; databaseId: string; commitSha: string; path: string; checksum: string; createdAt: string; status: "pending" | "executing" | "succeeded" | "failed" | "unknown"; content?: string };
type Project = { mapping: Mapping | null; plans: MigrationPlan[] };
type UsageMetric = { available: boolean; reason?: string; data?: unknown; window?: { from: string; to: string; granularity?: string } };
type Usage = { observedAt: string; worker: UsageMetric; d1: UsageMetric; durableObjects: UsageMetric };

export default function CloudflareConnection({ repository, repositoryId, canManage = false }: { repository?: Repository; repositoryId?: string; canManage?: boolean }) {
  const [status, setStatus] = useState<Connection | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [resources, setResources] = useState<Resources | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [retry, setRetry] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [databaseId, setDatabaseId] = useState("");
  const [namespaceId, setNamespaceId] = useState("");
  const [commitSha, setCommitSha] = useState(repository?.headSha ?? "");
  const [migrationPath, setMigrationPath] = useState("");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [migrationSql, setMigrationSql] = useState("");
  const projectBase = `/api/repositories/${encodeURIComponent(repositoryId ?? "")}/cloudflare`;

  useEffect(() => {
    let active = true;
    setBusy("load"); setError(""); setStatus(null); setResources(null); setProject(null); setPlan(null); setUsage(null);
    const loadProject = async () => {
      if (!repositoryId) return;
      const data = await request<Project>(projectBase);
      if (!active) return;
      setProject(data); setWorkerName(data.mapping?.workerName ?? ""); setDatabaseId(data.mapping?.d1DatabaseId ?? ""); setNamespaceId(data.mapping?.durableObjectNamespaceId ?? "");
    };
    const loadConnection = async () => {
      if (!canManage) return;
      const connection = await request<Connection>("/api/cloudflare");
      if (!active) return;
      setStatus(connection); setAccountId(connection.account?.id ?? "");
      if (!connection.connected) return;
      const accountList = await request<{ accounts: Account[] }>("/api/cloudflare/accounts");
      if (!active) return;
      setAccounts(accountList.accounts);
      if (connection.account) {
        const available = await request<Resources>("/api/cloudflare/resources");
        if (active) setResources(available);
      }
    };
    void Promise.allSettled([loadProject(), loadConnection()]).then((results) => {
      if (!active) return;
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) setError(failures.map((result) => result.reason instanceof Error ? result.reason.message : "Cloudflare details could not be loaded.").join(" "));
      setBusy("");
    });
    return () => { active = false; };
  }, [retry, repositoryId, canManage]);

  async function perform(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setError(""); setMessage("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "The action could not be completed."); } finally { setBusy(""); }
  }
  async function projectAction<T>(action: string, fields: Record<string, unknown>) {
    return request<T>(`${projectBase}/action`, { action, ...fields });
  }
  async function reviewPlan(selected: MigrationPlan) {
    setPlan(null); setMigrationSql(""); setConfirmed(false);
    const source = await request<{ content: string; commitSha: string; path: string }>(`/api/repositories/${encodeURIComponent(repositoryId ?? "")}/file?${new URLSearchParams({ ref: selected.commitSha, path: selected.path })}`);
    if (source.commitSha !== selected.commitSha || source.path !== selected.path) throw new Error("Migration source does not match the prepared plan.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.content));
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (checksum !== selected.checksum) throw new Error("Migration SQL does not match the prepared checksum.");
    setCommitSha(selected.commitSha); setMigrationPath(selected.path); setMigrationSql(source.content); setPlan(selected);
  }
  function metric(label: string, value?: UsageMetric) {
    const rows = Array.isArray(value?.data) ? value.data as { sum?: Record<string, unknown> }[] : [];
    const names: Record<string, string> = { requests: "Requests", errors: "Errors", readQueries: "Read queries", writeQueries: "Write queries", rowsRead: "Rows read", rowsWritten: "Rows written" };
    const totals: Record<string, number> = {};
    for (const row of rows) for (const [key, amount] of Object.entries(row.sum ?? {})) {
      if (names[key] && typeof amount === "number" && Number.isFinite(amount)) totals[key] = (totals[key] ?? 0) + amount;
    }
    return <section className="cf-usage-item"><h3>{label}</h3>{!value ? <p>Refresh usage to load project metrics.</p> : !value.available ? <p>{value.reason || "Usage is unavailable for this resource."}</p> : <><p>{value.window ? `${new Date(value.window.from).toLocaleDateString()} — ${new Date(value.window.to).toLocaleDateString()}` : "Reported usage"}</p>{Object.keys(totals).length ? <dl>{Object.entries(totals).map(([key, amount]) => <div key={key}><dt>{names[key]}</dt><dd>{amount.toLocaleString()}</dd></div>)}</dl> : <p>No usage records were returned for this period.</p>}</>}</section>;
  }
  if (repositoryId && !repository) return <ErrorNotice message="This repository could not be found." />;
  return <div className="cf-connection-page">
    <a className="header-back" href={repositoryId ? `#repository/${repositoryId}` : "#settings"}><ArrowLeftIcon size={13} />{repositoryId ? repository?.name : "Settings"}</a>
    <div className="page-heading"><div><h1><img src={cloudflareIcon} alt="" width="22" height="22" />Cloudflare{repositoryId ? " resources" : " account"}</h1><p>{repositoryId ? "Associate this repository with your account’s resources and inspect its usage." : "Authorize Cloudflare and choose the account for your workspace."}</p></div><Button variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={!!busy} onClick={() => setRetry((value) => value + 1)}>Refresh</Button></div>
    {error && <ErrorNotice message={error} onRetry={() => setRetry((value) => value + 1)} />}
    {message && <p className="cf-notice" role="status">{message}</p>}
    {canManage && (!status ? <p role="status">{busy === "load" ? "Loading Cloudflare connection…" : "Cloudflare account details are unavailable."}</p> : <section className="panel"><div className="panel-header"><h2>Account connection</h2><span className="cf-state">{status.connected ? "Connected" : status.configured ? "Not connected" : "Setup required"}</span></div><div className="panel-body">
      {!status.configured ? <p>Cloudflare OAuth is not configured for this installation. Ask the operator to configure the Cloudflare OAuth client and callback URL before connecting an account.</p> : !status.connected ? <p>Connect through Cloudflare to authorize account access. You choose the account after signing in.</p> : <><p>{status.identity?.email || "Cloudflare authorization active"}{status.account ? ` · ${status.account.name}` : " · Choose an account below"}</p><div className="cf-form-row"><label htmlFor="cf-account">Cloudflare account<select id="cf-account" value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={!!busy}><option value="">Choose an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><Button variant="secondary" size="base" disabled={!accountId || !!busy} onClick={() => void perform("account", async () => { await request("/api/cloudflare/select-account", { accountId }); setRetry((value) => value + 1); })}>Use account</Button></div></>}
      <div className="cf-actions">{!status.connected ? <Button variant="primary" size="base" disabled={!status.configured || !!busy} onClick={() => void perform("connect", async () => { const result = await request<{ authorizationUrl: string }>("/api/cloudflare/connect", {}); window.location.assign(result.authorizationUrl); })}>Connect Cloudflare</Button> : <Button variant="secondary" size="base" disabled={!!busy} onClick={() => void perform("disconnect", async () => { await request("/api/cloudflare/disconnect", {}); setAccounts([]); setResources(null); setRetry((value) => value + 1); })}>Disconnect</Button>}{repositoryId && <a href="#settings/cloudflare">Account settings</a>}</div>
    </div></section>)}
    {!canManage && !repositoryId && <p>Cloudflare account connections are managed by a workspace owner. Open a repository’s Cloudflare page to view its associated resources.</p>}
    {repositoryId && project && <>
      <section className="panel"><div className="panel-header"><h2>Repository resources</h2><span>{resources?.account.name || project.mapping?.accountId || "No account associated"}</span></div><div className="panel-body"><p className="cf-description">Only selected resources are associated with this repository. Resource association does not deploy code or migrate a database.</p>{canManage && resources ? <><div className="cf-resource-fields">{[{ id: "cf-worker", label: "Worker", value: workerName, update: setWorkerName, options: resources.workers.map((item) => ({ value: item.name, name: item.name })) }, { id: "cf-database", label: "D1 database", value: databaseId, update: setDatabaseId, options: resources.databases.map((item) => ({ value: item.id, name: item.name })) }, { id: "cf-namespace", label: "Durable Object namespace", value: namespaceId, update: setNamespaceId, options: resources.durableObjects.map((item) => ({ value: item.id, name: item.name })) }].map((field) => <label key={field.id} htmlFor={field.id}>{field.label}<select id={field.id} value={field.value} disabled={!!busy} onChange={(event) => field.update(event.target.value)}><option value="">Not associated</option>{field.options.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select></label>)}</div><Button variant="primary" size="base" disabled={!!busy || (!workerName && !databaseId && !namespaceId)} onClick={() => void perform("map", async () => { const data = await projectAction<Project>("map", { workerName: workerName || undefined, d1DatabaseId: databaseId || undefined, durableObjectNamespaceId: namespaceId || undefined }); setProject(data); setPlan(null); setMessage("Repository resources saved."); })}>Save resource association</Button></> : <dl className="cf-readonly-resources"><dt>Worker</dt><dd>{project.mapping?.workerName || "Not associated"}</dd><dt>D1 database</dt><dd>{project.mapping?.d1DatabaseId || "Not associated"}</dd><dt>Durable Object namespace</dt><dd>{project.mapping?.durableObjectNamespaceId || "Not associated"}</dd></dl>}</div></section>
      <section className="panel"><div className="panel-header"><h2>Project usage</h2><Button variant="secondary" size="base" disabled={!project?.mapping || !!busy} onClick={() => void perform("usage", async () => { setUsage(await request<Usage>(`${projectBase}/usage`)); })}>Refresh usage</Button></div><div className="panel-body">{usage && <p className="cf-description">Observed {new Date(usage.observedAt).toLocaleString()}</p>}<div className="cf-usage-grid">{metric("Worker", usage?.worker)}{metric("D1", usage?.d1)}{metric("Durable Objects", usage?.durableObjects)}</div></div></section>
      <section className="panel"><div className="panel-header"><h2>D1 migrations</h2></div><div className="panel-body"><p className="cf-description">Prepare a migration from an exact repository revision, then review its checksum before applying it to the associated database.</p><div className="cf-resource-fields"><label htmlFor="cf-migration-sha">Commit SHA<Input id="cf-migration-sha" value={commitSha} onChange={(event) => { setCommitSha(event.target.value); setPlan(null); setMigrationSql(""); setConfirmed(false); }} placeholder="Full 40-character commit SHA" /></label><label htmlFor="cf-migration-path">SQL file path<Input id="cf-migration-path" value={migrationPath} onChange={(event) => { setMigrationPath(event.target.value); setPlan(null); setMigrationSql(""); setConfirmed(false); }} placeholder="migrations/001-example.sql" /></label></div><Button variant="secondary" size="base" disabled={!!busy || !project?.mapping?.d1DatabaseId || !/^[a-f0-9]{40}$/i.test(commitSha) || !migrationPath} onClick={() => void perform("plan", async () => { const existing = project.plans.find((entry) => entry.status === "pending" && entry.commitSha === commitSha && entry.path === migrationPath); if (existing) { await reviewPlan(existing); return; } const data = await projectAction<{ plan: MigrationPlan }>("migration-plan", { commitSha, path: migrationPath }); setProject((current) => current ? { ...current, plans: [...current.plans.filter((entry) => entry.id !== data.plan.id), data.plan] } : current); await reviewPlan(data.plan); })}>Prepare migration plan</Button>{plan && <div className="cf-migration-plan"><h3>Migration plan</h3><dl><dt>Database</dt><dd>{plan.databaseId}</dd><dt>Revision</dt><dd><code>{plan.commitSha}</code></dd><dt>Path</dt><dd>{plan.path}</dd><dt>SHA-256</dt><dd><code>{plan.checksum}</code></dd><dt>Status</dt><dd>{plan.status}</dd></dl><h3>Exact SQL preview</h3><pre>{migrationSql}</pre>{plan.status === "pending" ? <><label className="cf-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this SQL and SHA-256 checksum. Applying it changes the selected database and may delete or modify data.</label><Button variant="primary" size="base" disabled={!confirmed || !!busy} onClick={() => void perform("apply", async () => { try { const result = await projectAction<{ plan: MigrationPlan }>("migration-execute", { planId: plan.id, checksum: plan.checksum }); setPlan(result.plan); setProject((current) => current ? { ...current, plans: current.plans.map((entry) => entry.id === result.plan.id ? result.plan : entry) } : current); setConfirmed(false); setMessage(`Migration outcome: ${result.plan.status}.`); } catch (failure) { const uncertain: MigrationPlan = { ...plan, status: "unknown" }; setPlan(uncertain); setProject((current) => current ? { ...current, plans: current.plans.map((entry) => entry.id === plan.id ? uncertain : entry) } : current); setConfirmed(false); throw failure; } })}>Apply exact migration</Button></> : <p>{plan.status === "unknown" ? "The outcome is unknown. Inspect the database before taking any further action." : `Migration ${plan.status}.`}</p>}</div>}{!!project?.plans.length && <details className="cf-plan-history"><summary>Previous migration plans ({project.plans.length})</summary>{project.plans.map((entry) => <p key={entry.id}><code>{entry.commitSha.slice(0, 12)}</code> · {entry.path} · {entry.status}{entry.status === "pending" && <Button variant="secondary" size="base" disabled={!!busy} onClick={() => void perform("review", () => reviewPlan(entry))}>Review saved plan</Button>}</p>)}</details>}</div></section>
      <section className="panel"><div className="panel-header"><h2>Workers Builds</h2></div><div className="panel-body"><p className="cf-description">A verified Workers Builds trigger connection is not available yet.</p><Button variant="secondary" size="base" disabled>Trigger build</Button></div></section>
    </>}
  </div>;
}
