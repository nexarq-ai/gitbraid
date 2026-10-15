import { repositoryLabel } from "../shared/repository-names";
import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowClockwiseIcon, ArrowLeftIcon, MagnifyingGlassIcon, TrashIcon } from "@phosphor-icons/react";
import type { ProjectResource, Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice } from "./components";
import cloudflareIcon from "./assets/cloudflare-icon.svg";
import "./cloudflare-connection.css";
import { RouteProgress } from "./WorkspaceLoader";

type Account = { id: string; name: string };
type Connection = { configured: boolean; connected: boolean; expiresAt?: number; identity?: { subject: string; email?: string }; account?: Account; scopes?: string[]; source?: "repository" | "workspace" | "none" };
type ResourceType = ProjectResource["type"];
type Resources = { account: Account; workers: { id: string; name: string }[]; durableObjects: { id: string; name: string; script?: string }[]; databases: { id: string; name: string }[]; containers?: { id: string; name: string }[]; workflows?: { id: string; name: string }[]; availability?: Record<string, { available: boolean; reason?: string }> };
const resourceTypes: { type: ResourceType; label: string; plural: string }[] = [{ type: "worker", label: "Worker", plural: "Workers" }, { type: "d1", label: "D1 database", plural: "D1 databases" }, { type: "durable_object", label: "Durable Object", plural: "Durable Objects" }, { type: "container", label: "Container", plural: "Containers" }, { type: "workflow", label: "Workflow", plural: "Workflows" }];
const resourceKey = (resource: Pick<ProjectResource, "type" | "id">) => `${resource.type}:${resource.id}`;
const availabilityTypes: Record<string, ResourceType> = { workers: "worker", databases: "d1", durableObjects: "durable_object", containers: "container", workflows: "workflow" };
const resourceLabel = (type: ResourceType) => resourceTypes.find((item) => item.type === type)?.label ?? type;
function mappedResources(mapping: Mapping | null, catalog?: Resources | null): ProjectResource[] {
  if (mapping?.resources) return mapping.resources;
  if (!mapping) return [];
  const legacy: ProjectResource[] = [];
  if (mapping.workerName) legacy.push({ type: "worker", id: mapping.workerName, name: mapping.workerName, environment: "production" });
  if (mapping.d1DatabaseId) legacy.push({ type: "d1", id: mapping.d1DatabaseId, name: catalog?.databases.find((item) => item.id === mapping.d1DatabaseId)?.name ?? mapping.d1DatabaseId, environment: "production" });
  if (mapping.durableObjectNamespaceId) legacy.push({ type: "durable_object", id: mapping.durableObjectNamespaceId, name: catalog?.durableObjects.find((item) => item.id === mapping.durableObjectNamespaceId)?.name ?? mapping.durableObjectNamespaceId, environment: "production" });
  return legacy;
}
type Mapping = { accountId: string; version: string; resources?: ProjectResource[]; workerName?: string; d1DatabaseId?: string; durableObjectNamespaceId?: string; updatedAt: string };
type MigrationPlan = { id: string; databaseId: string; commitSha: string; path: string; checksum: string; createdAt: string; status: "pending" | "executing" | "succeeded" | "failed" | "unknown"; content?: string };
type Project = { mapping: Mapping | null; plans: MigrationPlan[] };
type UsageMetric = { available: boolean; reason?: string; data?: unknown; window?: { from: string; to: string; granularity?: string } };
type Usage = { observedAt: string; resources: (UsageMetric & { resource: ProjectResource })[] };


const scopeLabels: Record<string, string> = {
  "offline_access": "Stay connected between sign-ins",
  "account-settings.read": "Read account details",
  "workers-scripts.metadata_read": "List Workers and Durable Objects",
  "workers-scripts.read": "Read Workers",
  "d1.read": "Read D1 databases",
  "d1.write": "Apply reviewed D1 migrations",
  "account-analytics.read": "Read usage analytics",
  "containers.read": "List containers",
  "workflows.read": "List workflows",
};

function CloudflareAccount({ status, accounts, resources, repositories, busy, accountId, onAccount, onUseAccount, onConnect, onDisconnect }: { status: Connection; accounts: Account[]; resources: Resources | null; repositories: Repository[]; busy: string; accountId: string; onAccount: (id: string) => void; onUseAccount: () => void; onConnect: () => void; onDisconnect: () => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ResourceType | "all">("all");
  const [page, setPage] = useState(0);
  const [links, setLinks] = useState<{ repository: Repository; resources: ProjectResource[] }[] | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => {
    if (!status.connected || !status.account) return;
    let active = true;
    void Promise.all(repositories.map(async (repository) => ({ repository, resources: mappedResources((await request<Project>(`/api/repositories/${encodeURIComponent(repository.id)}/cloudflare`).catch(() => ({ mapping: null, plans: [] }))).mapping) })))
      .then((all) => { if (active) setLinks(all.filter((item) => item.resources.length)); });
    return () => { active = false; };
  }, [status.connected, status.account?.id, repositories]);
  if (!status.configured) return <section className="panel"><div className="panel-header"><h2>Account connection</h2><span className="cf-state">Setup required</span></div><div className="panel-body"><p>Cloudflare sign-in is not configured for this installation. The operator needs to configure the Cloudflare OAuth client and callback URL first.</p></div></section>;
  if (!status.connected) return <section className="panel"><div className="panel-header"><h2>Account connection</h2><span className="cf-state">Not connected</span></div><div className="panel-body"><p>Connect a Cloudflare account to link your Workers, D1 databases, Durable Objects, containers and workflows to repositories, see their usage, and apply reviewed D1 migrations. Agents, Git and AI models work without it.</p><Button variant="primary" size="base" disabled={!!busy} onClick={onConnect}>Connect Cloudflare</Button></div></section>;
  const catalog: ProjectResource[] = resources ? [
    ...resources.workers.map((item) => ({ id: item.id, name: item.name, type: "worker" as const, environment: "" })),
    ...resources.databases.map((item) => ({ id: item.id, name: item.name, type: "d1" as const, environment: "" })),
    ...resources.durableObjects.map((item) => ({ id: item.id, name: item.script ? `${item.name}` : item.name, type: "durable_object" as const, environment: "" })),
    ...(resources.containers ?? []).map((item) => ({ id: item.id, name: item.name, type: "container" as const, environment: "" })),
    ...(resources.workflows ?? []).map((item) => ({ id: item.id, name: item.name, type: "workflow" as const, environment: "" })),
  ] : [];
  const counts = Object.fromEntries(resourceTypes.map((item) => [item.type, catalog.filter((resource) => resource.type === item.type).length])) as Record<ResourceType, number>;
  const linkedKeys = new Map<string, string[]>();
  for (const link of links ?? []) for (const resource of link.resources) linkedKeys.set(resourceKey(resource), [...(linkedKeys.get(resourceKey(resource)) ?? []), repositoryLabel(link.repository)]);
  const matches = catalog.filter((item) => (filter === "all" || item.type === filter) && `${item.name} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(matches.length / 15));
  const current = Math.min(page, pages - 1);
  const shown = matches.slice(current * 15, (current + 1) * 15);
  const unavailable = Object.entries(resources?.availability ?? {}).filter(([, value]) => !value.available);
  return <>
    <section className="panel">
      <div className="panel-header"><h2>Connected account</h2><span className="cf-state cf-state-on"><span className="cf-connected-dot" />Connected</span></div>
      <div className="panel-body">
        {status.account ? <dl className="cf-account-facts">
          <div><dt>Account</dt><dd><strong>{status.account.name}</strong></dd></div>
          <div><dt>Account ID</dt><dd><code>{status.account.id}</code></dd></div>
          {status.identity?.email && <div><dt>Signed in as</dt><dd>{status.identity.email}</dd></div>}
        </dl> : <p>Signed in to Cloudflare. Choose which account this workspace uses.</p>}
        {(!status.account || accounts.length > 1) && <div className="cf-form-row"><label htmlFor="cf-account">{status.account ? "Switch account" : "Cloudflare account"}<select id="cf-account" value={accountId} onChange={(event) => onAccount(event.target.value)} disabled={!!busy}><option value="">Choose an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><Button variant="secondary" size="base" disabled={!accountId || accountId === status.account?.id || !!busy} onClick={onUseAccount}>Use account</Button></div>}
        {!!status.scopes?.length && <div className="cf-scopes"><h3>What Gitflare may do</h3><ul>{status.scopes.map((scope) => <li key={scope}>{scopeLabels[scope] ?? scope}</li>)}</ul></div>}
        <div className="cf-actions"><Button variant="secondary" size="base" disabled={!!busy} onClick={onConnect}>Re-authorize</Button><Button variant="secondary" size="base" disabled={!!busy} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button><span className="cf-reconnect-help">Re-authorize after changing permissions or accounts in Cloudflare.</span></div>
      </div>
    </section>
    {status.account && <section className="panel">
      <div className="panel-header"><h2>Account resources</h2><span className="cf-state">{resources ? `${catalog.length} found` : "Loading…"}</span></div>
      <div className="panel-body">
        {!resources ? <RouteProgress /> : <>
          <div className="cf-resource-stats">{resourceTypes.map((item) => <button key={item.type} type="button" aria-pressed={filter === item.type} onClick={() => { setFilter(filter === item.type ? "all" : item.type); setPage(0); }}><span className={`cf-resource-symbol cf-symbol-${item.type}`} aria-hidden="true">{item.type === "d1" ? "D1" : item.type === "durable_object" ? "DO" : item.type === "worker" ? "W" : item.type === "container" ? "C" : "WF"}</span><strong>{counts[item.type]}</strong><span>{item.plural}</span></button>)}</div>
          {unavailable.map(([type, value]) => <p key={type} className="cf-field-hint"><strong>{resourceTypes.find((item) => item.type === (availabilityTypes[type] ?? type))?.plural ?? type}:</strong> {value.reason || "Listing is unavailable with this authorization."}</p>)}
          <div className="cf-catalog-toolbar"><div className="cf-resource-search"><MagnifyingGlassIcon size={17} aria-hidden="true" /><Input aria-label="Search account resources" placeholder="Search by name or ID" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></div>{filter !== "all" && <Button variant="secondary" size="base" onClick={() => { setFilter("all"); setPage(0); }}>Show all types</Button>}</div>
          {shown.length ? <div className="table-scroll"><table className="resource-table cf-account-table"><thead><tr><th>Name</th><th>Type</th><th>Used by</th></tr></thead><tbody>{shown.map((item) => <tr key={resourceKey(item)}><td><div className="cf-resource-identity"><strong>{item.name}</strong>{item.id !== item.name && <span className="cf-resource-id">{item.id}</span>}</div></td><td>{resourceLabel(item.type)}</td><td>{linkedKeys.get(resourceKey(item))?.join(", ") ?? <span className="cf-muted">—</span>}</td></tr>)}</tbody></table></div> : <p className="cf-muted">No resources match this search.</p>}
          {pages > 1 && <div className="cf-catalog-pagination"><span>{matches.length} matches · page {current + 1} of {pages}</span><Button variant="secondary" size="base" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button><Button variant="secondary" size="base" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</Button></div>}
        </>}
      </div>
    </section>}
    {status.account && <section className="panel">
      <div className="panel-header"><h2>Linked to repositories</h2></div>
      <div className="panel-body">
        {!links ? <RouteProgress /> : links.length ? <div className="cf-repository-links">{links.map(({ repository, resources: linked }) => <a key={repository.id} href={`/repository/${repository.id}/cloudflare`}><strong>{repositoryLabel(repository)}</strong><span>{linked.map((item) => `${item.name} · ${item.environment}`).join("  ·  ")}</span></a>)}</div> : <p>No repository is linked to these resources yet. Open a repository’s <strong>Cloudflare</strong> tab to choose the Workers, databases and other services it deploys to.</p>}
      </div>
    </section>}
    <Dialog.Root open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
      <Dialog size="sm" className="dialog-content confirm-dialog">
        <Dialog.Title className="dialog-title">Disconnect Cloudflare?</Dialog.Title>
        <Dialog.Description className="dialog-description">Gitflare stops reading <strong>{status.account?.name ?? "this account"}</strong>. Repository links are kept but show no live data until you connect again. Nothing in your Cloudflare account changes.</Dialog.Description>
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={() => setConfirmDisconnect(false)}>Cancel</Button><Button variant="primary" size="base" type="button" onClick={() => { setConfirmDisconnect(false); onDisconnect(); }}>Disconnect</Button></div>
      </Dialog>
    </Dialog.Root>
  </>;
}

function RepositoryAccount({ status, accounts, busy, accountId, onAccount, onUseAccount, onConnect, onDisconnect }: { status: Connection; accounts: Account[]; busy: string; accountId: string; onAccount: (id: string) => void; onUseAccount: () => void; onConnect: () => void; onDisconnect: () => void }) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const own = status.source === "repository";
  const label = own ? "Own account" : status.source === "workspace" ? "Workspace account" : "Not connected";
  return <section className="panel">
    <div className="panel-header"><h2>Repository Cloudflare account</h2><span className={`cf-state${status.connected && status.account ? " cf-state-on" : ""}`}>{status.connected && status.account && <span className="cf-connected-dot" />}{label}</span></div>
    <div className="panel-body">
      {!status.configured ? <p>Cloudflare OAuth is not configured for this installation. Ask the operator to configure the Cloudflare OAuth client and callback URL before connecting an account.</p> : <>
        <p>{own ? "This repository uses its own Cloudflare connection for its resources, usage, migrations and deploys." : status.source === "workspace" ? "This repository uses the workspace Cloudflare connection. Connect a different account to use it for this repository only." : "Connect a Cloudflare account for this repository, or connect one for the whole workspace in account settings."}</p>
        {status.account ? <dl className="cf-account-facts"><div><dt>Account</dt><dd><strong>{status.account.name}</strong></dd></div><div><dt>Account ID</dt><dd><code>{status.account.id}</code></dd></div></dl> : status.connected && <p>Choose which account this {own ? "repository" : "workspace"} uses.</p>}
        {own && (!status.account || accounts.length > 1) && <div className="cf-form-row"><label htmlFor="cf-repository-account">{status.account ? "Switch account" : "Cloudflare account"}<select id="cf-repository-account" value={accountId} onChange={(event) => onAccount(event.target.value)} disabled={!!busy}><option value="">Choose an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><Button variant="secondary" size="base" disabled={!accountId || accountId === status.account?.id || !!busy} onClick={onUseAccount}>Use account</Button></div>}
        <div className="cf-actions"><Button variant={own ? "secondary" : "primary"} size="base" disabled={!!busy} onClick={onConnect}>{own ? "Reconnect" : status.source === "workspace" ? "Connect a different account" : "Connect Cloudflare"}</Button>{own && <Button variant="secondary" size="base" disabled={!!busy} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>}<a href="/settings/cloudflare">Workspace account settings</a></div>
      </>}
    </div>
    <Dialog.Root open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
      <Dialog size="sm" className="dialog-content confirm-dialog">
        <Dialog.Title className="dialog-title">Disconnect this repository’s account?</Dialog.Title>
        <Dialog.Description className="dialog-description">Gitflare stops using <strong>{status.account?.name ?? "this account"}</strong> for this repository, which then uses the workspace connection if there is one. Nothing in your Cloudflare account changes.</Dialog.Description>
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={() => setConfirmDisconnect(false)}>Cancel</Button><Button variant="primary" size="base" type="button" onClick={() => { setConfirmDisconnect(false); onDisconnect(); }}>Disconnect</Button></div>
      </Dialog>
    </Dialog.Root>
  </section>;
}

export default function CloudflareConnection({ repository, repositoryId, repositories = [], canManage = false }: { repository?: Repository; repositoryId?: string; repositories?: Repository[]; canManage?: boolean }) {
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
  const [selectedResources, setSelectedResources] = useState<ProjectResource[]>([]);
  const [databaseId, setDatabaseId] = useState("");
  const [resourceView, setResourceView] = useState<"selected" | "catalog">("selected");
  const [resourceSearch, setResourceSearch] = useState("");
  const [resourceFilter, setResourceFilter] = useState<ResourceType | "all">("all");
  const [catalogPage, setCatalogPage] = useState(0);
  const [commitSha, setCommitSha] = useState(repository?.headSha ?? "");
  const [migrationPath, setMigrationPath] = useState("");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [migrationSql, setMigrationSql] = useState("");
  const projectBase = `/api/repositories/${encodeURIComponent(repositoryId ?? "")}/cloudflare`;
  const connectionBase = repositoryId ? `${projectBase}/connection` : "/api/cloudflare";

  useEffect(() => {
    let active = true;
    setBusy("load"); setError(""); setStatus(null); setResources(null); setProject(null); setPlan(null); setUsage(null);
    const loadProject = async () => {
      if (!repositoryId) return;
      const data = await request<Project>(projectBase);
      if (!active) return;
      setProject(data); setSelectedResources(mappedResources(data.mapping)); setDatabaseId(mappedResources(data.mapping).find((item) => item.type === "d1")?.id ?? "");
    };
    const loadConnection = async () => {
      if (!canManage) return;
      const connection = await request<Connection>(connectionBase);
      if (!active) return;
      setStatus(connection); setAccountId(connection.account?.id ?? "");
      if (!connection.connected) return;
      if (!repositoryId || connection.source === "repository") {
        const accountList = await request<{ accounts: Account[] }>(`${connectionBase}/accounts`);
        if (!active) return;
        setAccounts(accountList.accounts);
      }
      if (connection.account) {
        const available = await request<Resources>(`${connectionBase}/resources`);
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
    setDatabaseId(selected.databaseId); setCommitSha(selected.commitSha); setMigrationPath(selected.path); setMigrationSql(source.content); setPlan(selected);
  }
  const savedResources = mappedResources(project?.mapping ?? null, resources);
  const savedDatabases = savedResources.filter((item) => item.type === "d1");
  const catalog: ProjectResource[] = resources ? [
    ...resources.workers.map((item) => ({ id: item.id, name: item.name, type: "worker" as const, environment: "production" })),
    ...resources.databases.map((item) => ({ id: item.id, name: item.name, type: "d1" as const, environment: "production" })),
    ...resources.durableObjects.map((item) => ({ id: item.id, name: item.name, type: "durable_object" as const, environment: "production" })),
    ...(resources.containers ?? []).map((item) => ({ id: item.id, name: item.name, type: "container" as const, environment: "production" })),
    ...(resources.workflows ?? []).map((item) => ({ id: item.id, name: item.name, type: "workflow" as const, environment: "production" })),
  ] : [];
  const selectedKeys = new Set(selectedResources.map(resourceKey));
  const filteredCatalog = catalog.filter((item) => (resourceFilter === "all" || item.type === resourceFilter) && `${item.name} ${item.id}`.toLowerCase().includes(resourceSearch.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filteredCatalog.length / 12));
  const currentPage = Math.min(catalogPage, pageCount - 1);
  const visibleCatalog = filteredCatalog.slice(currentPage * 12, (currentPage + 1) * 12);
  const mappingDirty = JSON.stringify(selectedResources) !== JSON.stringify(mappedResources(project?.mapping ?? null));
  const validEnvironments = selectedResources.every((item) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(item.environment));
  const selectionLimitReached = selectedResources.length >= 100;
  const resetPlan = () => { setPlan(null); setMigrationSql(""); setConfirmed(false); };
  function toggleResource(resource: ProjectResource) {
    setSelectedResources((current) => current.some((item) => resourceKey(item) === resourceKey(resource)) ? current.filter((item) => resourceKey(item) !== resourceKey(resource)) : current.length >= 100 ? current : [...current, resource]);
  }
  function metric(label: string, value?: UsageMetric, environment?: string) {
    const rows = Array.isArray(value?.data) ? value.data as { sum?: Record<string, unknown> }[] : [];
    const names: Record<string, string> = { requests: "Requests", errors: "Errors", readQueries: "Read queries", writeQueries: "Write queries", rowsRead: "Rows read", rowsWritten: "Rows written" };
    const totals: Record<string, number> = {};
    for (const row of rows) for (const [key, amount] of Object.entries(row.sum ?? {})) {
      if (names[key] && typeof amount === "number" && Number.isFinite(amount)) totals[key] = (totals[key] ?? 0) + amount;
    }
    return <section className="cf-usage-item"><h3>{label}</h3>{environment && <span className="cf-environment-badge">{environment}</span>}{!value ? <p>Refresh usage to load project metrics.</p> : !value.available ? <p>{value.reason || "Usage is unavailable for this resource."}</p> : <><p>{value.window ? `${new Date(value.window.from).toLocaleDateString()} — ${new Date(value.window.to).toLocaleDateString()}` : "Reported usage"}</p>{Object.keys(totals).length ? <dl>{Object.entries(totals).map(([key, amount]) => <div key={key}><dt>{names[key]}</dt><dd>{amount.toLocaleString()}</dd></div>)}</dl> : <p>No usage records were returned for this period.</p>}</>}</section>;
  }
  if (repositoryId && !repository) return <ErrorNotice message="This repository could not be found." />;
  return <div className="cf-connection-page">
    <a className="header-back" href={repositoryId ? `/repository/${repositoryId}` : "/settings"}><ArrowLeftIcon size={13} />{repositoryId ? repository && repositoryLabel(repository) : "Settings"}</a>
    <div className="page-heading"><div><h1><img src={cloudflareIcon} alt="" width="22" height="22" />Cloudflare{repositoryId ? " resources" : " account"}</h1><p>{repositoryId ? "Associate this repository with your account’s resources and inspect its usage." : "Authorize Cloudflare and choose the account for your workspace."}</p></div><Button variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={!!busy} onClick={() => setRetry((value) => value + 1)}>Refresh</Button></div>
    {error && <ErrorNotice message={error} onRetry={() => setRetry((value) => value + 1)} />}
    {message && <p className="cf-notice" role="status">{message}</p>}
    {canManage && !repositoryId && (status ? <CloudflareAccount status={status} accounts={accounts} resources={resources} repositories={repositories} busy={busy} accountId={accountId} onAccount={setAccountId} onUseAccount={() => void perform("account", async () => { await request("/api/cloudflare/select-account", { accountId }); setRetry((value) => value + 1); })} onConnect={() => void perform("connect", async () => { const result = await request<{ authorizationUrl: string }>("/api/cloudflare/connect", {}); window.location.assign(result.authorizationUrl); })} onDisconnect={() => void perform("disconnect", async () => { await request("/api/cloudflare/disconnect", {}); setAccounts([]); setResources(null); setRetry((value) => value + 1); })} /> : busy === "load" ? <RouteProgress /> : <p role="status">Cloudflare account details are unavailable.</p>)}
    {repositoryId && canManage && (status ? <RepositoryAccount status={status} accounts={accounts} busy={busy} accountId={accountId} onAccount={setAccountId} onUseAccount={() => void perform("account", async () => { await request(`${connectionBase}/select-account`, { accountId }); setRetry((value) => value + 1); })} onConnect={() => void perform("connect", async () => { const result = await request<{ authorizationUrl: string }>(`${connectionBase}/connect`, {}); window.location.assign(result.authorizationUrl); })} onDisconnect={() => void perform("disconnect", async () => { await request(`${connectionBase}/disconnect`, {}); setAccounts([]); setResources(null); setRetry((value) => value + 1); })} /> : busy === "load" ? <RouteProgress /> : <p role="status">Cloudflare account details are unavailable.</p>)}
    {!canManage && !repositoryId && <p>Cloudflare account connections are managed by a workspace owner. Open a repository’s Cloudflare page to view its associated resources.</p>}
    {repositoryId && project && <>
      <section className="panel cf-resource-panel">
        <div className="panel-header"><h2>Project resources</h2><span className="cf-resource-count">{savedResources.length} saved</span></div>
        <div className="panel-body"><p className="cf-description">Group all services for this repository and assign their environments. Save changes to update the project.</p>
          {canManage && resources ? <>
            <div className="cf-resource-tabs" role="tablist" aria-label="Resource view"><button id="cf-selected-tab" role="tab" aria-selected={resourceView === "selected"} aria-controls="cf-resource-view" onClick={() => setResourceView("selected")}>Project resources <span>{selectedResources.length}</span></button><button id="cf-catalog-tab" role="tab" aria-selected={resourceView === "catalog"} aria-controls="cf-resource-view" onClick={() => setResourceView("catalog")}>Add from account <span>{catalog.length}</span></button></div>
            <div id="cf-resource-view" role="tabpanel" aria-labelledby={resourceView === "selected" ? "cf-selected-tab" : "cf-catalog-tab"}>
              {resourceView === "selected" ? <>
                {selectedResources.length ? <div className="cf-selected-list">{selectedResources.map((resource) => <div className="cf-selected-resource" key={resourceKey(resource)}><span className={`cf-resource-symbol cf-symbol-${resource.type}`} aria-hidden="true">{resource.type === "d1" ? "D1" : resource.type === "durable_object" ? "DO" : resource.type === "worker" ? "W" : resource.type === "container" ? "C" : "WF"}</span><div className="cf-resource-identity"><strong>{resource.name}</strong><span>{resourceLabel(resource.type)}</span></div><label className="cf-environment-field">Environment<Input aria-label={`Environment for ${resource.name}`} value={resource.environment} disabled={!!busy} maxLength={40} aria-invalid={!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(resource.environment)} aria-describedby={!validEnvironments ? "cf-environment-hint" : undefined} list="cf-environments" onChange={(event) => setSelectedResources((current) => current.map((item) => resourceKey(item) === resourceKey(resource) ? { ...item, environment: event.target.value } : item))} /></label><button className="cf-remove-resource" aria-label={`Remove ${resource.name}`} title="Remove from project" disabled={!!busy} onClick={() => toggleResource(resource)}><TrashIcon size={17} /></button></div>)}</div> : <div className="cf-resource-empty"><h3>Add your project’s services</h3><p>A project can include multiple Workers, databases, Durable Objects, containers and workflows.</p><Button variant="secondary" size="base" onClick={() => setResourceView("catalog")}>Browse account resources</Button></div>}
                <datalist id="cf-environments"><option value="production" /><option value="staging" /><option value="development" /></datalist>
              </> : <>
                <div className="cf-catalog-toolbar"><div className="cf-resource-search"><MagnifyingGlassIcon size={17} aria-hidden="true" /><Input aria-label="Search account resources" placeholder="Search resources by name or ID" value={resourceSearch} onChange={(event) => { setResourceSearch(event.target.value); setCatalogPage(0); }} /></div><label className="cf-type-filter">Resource type<select aria-label="Filter resource type" value={resourceFilter} onChange={(event) => { setResourceFilter(event.target.value as ResourceType | "all"); setCatalogPage(0); }}><option value="all">All resource types</option>{resourceTypes.map((item) => <option key={item.type} value={item.type}>{item.plural}</option>)}</select></label></div>
                {resources.availability && <div className="cf-catalog-availability">{Object.entries(resources.availability).filter(([, value]) => !value.available).map(([type, value]) => <p key={type}><strong>{resourceTypes.find((item) => item.type === (availabilityTypes[type] ?? type))?.plural ?? type}:</strong> {value.reason || "Resource listing is unavailable with this authorization."}</p>)}</div>}
                <p className="cf-catalog-caption">{filteredCatalog.length} matching resources · Select the services that belong to this project.</p>
                <div className="cf-catalog-list">{visibleCatalog.map((resource) => <label className={`cf-catalog-resource ${selectedKeys.has(resourceKey(resource)) ? "is-selected" : ""}`} key={resourceKey(resource)}><input type="checkbox" checked={selectedKeys.has(resourceKey(resource))} disabled={!!busy || (selectionLimitReached && !selectedKeys.has(resourceKey(resource)))} onChange={() => toggleResource(resource)} /><span className="cf-resource-identity"><strong>{resource.name}</strong><span>{resourceLabel(resource.type)}<span className="cf-resource-id"> · {resource.id}</span></span></span><span className="cf-catalog-selected">{selectedKeys.has(resourceKey(resource)) ? "Added" : "Add"}</span></label>)}</div>
                {!visibleCatalog.length && <div className="cf-resource-empty"><p>{catalog.length ? "No resources match this search." : Object.values(resources.availability ?? {}).some((item) => !item.available) ? "Some resource lists could not be loaded. Review the account permissions shown above." : "No resources were returned for this account."}</p></div>}
                {pageCount > 1 && <div className="cf-catalog-pagination"><span>Page {currentPage + 1} of {pageCount}</span><Button variant="secondary" size="base" disabled={currentPage === 0} onClick={() => setCatalogPage(currentPage - 1)}>Previous</Button><Button variant="secondary" size="base" disabled={currentPage + 1 >= pageCount} onClick={() => setCatalogPage(currentPage + 1)}>Next</Button></div>}
              </>}
            </div>
            {!validEnvironments && <p id="cf-environment-hint" className="cf-field-hint" role="status">Environments must start with a lowercase letter or number and contain only lowercase letters, numbers, underscores or hyphens (up to 40 characters).</p>}
            {selectionLimitReached && <p className="cf-field-hint" role="status">Projects support up to 100 resources. Remove a resource before adding another.</p>}
            <div className="cf-resource-save"><span>{selectedResources.length} selected{mappingDirty ? " · Unsaved changes" : " · Saved"}</span><Button variant="primary" size="base" disabled={!!busy || !mappingDirty || !validEnvironments || selectedResources.length > 100} onClick={() => void perform("map", async () => { const data = await projectAction<Project>("map", { resources: selectedResources }); setProject(data); setSelectedResources(mappedResources(data.mapping)); setUsage(null); resetPlan(); setDatabaseId(mappedResources(data.mapping).find((item) => item.type === "d1")?.id ?? ""); setMessage("Project resources saved."); })}>Save project resources</Button></div>
          </> : <div className="cf-readonly-list">{savedResources.length ? savedResources.map((resource) => <div className="cf-readonly-resource" key={resourceKey(resource)}><div className="cf-resource-identity"><strong>{resource.name}</strong><span>{resourceLabel(resource.type)}</span></div><span className="cf-environment-badge">{resource.environment}</span></div>) : <p>No resources are associated with this project.</p>}</div>}
        </div>
      </section>
      <section className="panel"><div className="panel-header"><h2>Project usage</h2><Button variant="secondary" size="base" disabled={!savedResources.length || !!busy} onClick={() => void perform("usage", async () => { setUsage(await request<Usage>(`${projectBase}/usage`)); })}>Refresh usage</Button></div><div className="panel-body">{usage && <p className="cf-description">Observed {new Date(usage.observedAt).toLocaleString()}</p>}{savedResources.length ? <div className="cf-usage-grid">{savedResources.map((resource) => <div key={resourceKey(resource)}>{metric(resource.name, usage?.resources.find((item) => resourceKey(item.resource) === resourceKey(resource)), resource.environment)}</div>)}</div> : <p>Save project resources to inspect their usage.</p>}</div></section>
      <section className="panel"><div className="panel-header"><h2>D1 migrations</h2></div><div className="panel-body"><p className="cf-description">Prepare a migration from an exact repository revision, then review its checksum before applying it to the selected project database.</p><div className="cf-resource-fields"><label htmlFor="cf-migration-database">Target database<select id="cf-migration-database" value={databaseId} disabled={!!busy} onChange={(event) => { setDatabaseId(event.target.value); resetPlan(); }}><option value="">Choose a saved D1 database</option>{savedDatabases.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.environment}</option>)}</select></label><label htmlFor="cf-migration-sha">Revision SHA<Input id="cf-migration-sha" value={commitSha} onChange={(event) => { setCommitSha(event.target.value); setPlan(null); setMigrationSql(""); setConfirmed(false); }} placeholder="Full 40-character revision SHA" /></label><label htmlFor="cf-migration-path">SQL file path<Input id="cf-migration-path" value={migrationPath} onChange={(event) => { setMigrationPath(event.target.value); setPlan(null); setMigrationSql(""); setConfirmed(false); }} placeholder="migrations/001-example.sql" /></label></div><Button variant="secondary" size="base" disabled={!!busy || !savedDatabases.some((item) => item.id === databaseId) || !/^[a-f0-9]{40}$/i.test(commitSha) || !migrationPath} onClick={() => void perform("plan", async () => { const existing = project.plans.find((entry) => entry.status === "pending" && entry.databaseId === databaseId && entry.commitSha === commitSha && entry.path === migrationPath); if (existing) { await reviewPlan(existing); return; } const data = await projectAction<{ plan: MigrationPlan }>("migration-plan", { databaseId, commitSha, path: migrationPath }); setProject((current) => current ? { ...current, plans: [...current.plans.filter((entry) => entry.id !== data.plan.id), data.plan] } : current); await reviewPlan(data.plan); })}>Prepare migration plan</Button>{plan && <div className="cf-migration-plan"><h3>Migration plan</h3><dl><dt>Database</dt><dd>{savedDatabases.find((item) => item.id === plan.databaseId)?.name ?? plan.databaseId}</dd><dt>Revision</dt><dd><code>{plan.commitSha}</code></dd><dt>Path</dt><dd>{plan.path}</dd><dt>SHA-256</dt><dd><code>{plan.checksum}</code></dd><dt>Status</dt><dd>{plan.status}</dd></dl><h3>Exact SQL preview</h3><pre>{migrationSql}</pre>{plan.status === "pending" ? <><label className="cf-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this SQL and SHA-256 checksum. Applying it changes the selected database and may delete or modify data.</label><Button variant="primary" size="base" disabled={!confirmed || !!busy || !savedDatabases.some((item) => item.id === plan.databaseId)} onClick={() => void perform("apply", async () => { try { const result = await projectAction<{ plan: MigrationPlan }>("migration-execute", { planId: plan.id, checksum: plan.checksum }); setPlan(result.plan); setProject((current) => current ? { ...current, plans: current.plans.map((entry) => entry.id === result.plan.id ? result.plan : entry) } : current); setConfirmed(false); setMessage(`Migration outcome: ${result.plan.status}.`); } catch (failure) { const uncertain: MigrationPlan = { ...plan, status: "unknown" }; setPlan(uncertain); setProject((current) => current ? { ...current, plans: current.plans.map((entry) => entry.id === plan.id ? uncertain : entry) } : current); setConfirmed(false); throw failure; } })}>Apply exact migration</Button></> : <p>{plan.status === "unknown" ? "The outcome is unknown. Inspect the database before taking any further action." : `Migration ${plan.status}.`}</p>}</div>}{!!project?.plans.length && <details className="cf-plan-history"><summary>Previous migration plans ({project.plans.length})</summary>{project.plans.map((entry) => <p key={entry.id}><code>{entry.commitSha.slice(0, 12)}</code> · {entry.path} · {savedDatabases.find((item) => item.id === entry.databaseId)?.name ?? entry.databaseId} · {entry.status}{entry.status === "pending" && <Button variant="secondary" size="base" disabled={!!busy} onClick={() => void perform("review", () => reviewPlan(entry))}>Review saved plan</Button>}</p>)}</details>}</div></section>
      <section className="panel"><div className="panel-header"><h2>Workers Builds</h2></div><div className="panel-body"><p className="cf-description">A verified Workers Builds trigger connection is not available yet.</p><Button variant="secondary" size="base" disabled>Trigger build</Button></div></section>
    </>}
  </div>;
}
