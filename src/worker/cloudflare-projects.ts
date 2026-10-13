import type { AppEnv } from './env';
import type { Principal, Action } from './security';
import type { Repository, ProjectResource } from '../shared/types';
import { ApiError } from './domain';
import { repositoryHead } from './artifacts';

export interface ProjectMapping {
  repositoryId: string; workspaceId: string; accountId: string; version: string; resources?: ProjectResource[]; workerName?: string; d1DatabaseId?: string; durableObjectNamespaceId?: string; buildTriggerId?: string; updatedAt: string;
}
export function normalizeProjectMapping(mapping: ProjectMapping): ProjectMapping & { resources: ProjectResource[] } {
  const resources = mapping.resources ?? [
    ...(mapping.workerName ? [{ type: 'worker' as const, id: mapping.workerName, name: mapping.workerName, environment: 'production' }] : []),
    ...(mapping.d1DatabaseId ? [{ type: 'd1' as const, id: mapping.d1DatabaseId, name: mapping.d1DatabaseId, environment: 'production' }] : []),
    ...(mapping.durableObjectNamespaceId ? [{ type: 'durable_object' as const, id: mapping.durableObjectNamespaceId, name: mapping.durableObjectNamespaceId, environment: 'production' }] : []),
  ];
  return { ...mapping, resources };
}
export interface MigrationPlan {
  id: string; repositoryId: string; workspaceId: string; accountId: string; mappingVersion: string; databaseId: string; commitSha: string; path: string; checksum: string; createdAt: string; status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown'; error?: string;
}
export type ProjectOperation = 'get' | 'map' | 'usage' | 'migration-plan' | 'migration-execute' | 'build-trigger';
export type ProjectStoreOperation = 'get' | 'set' | 'plan' | 'consume' | 'finish';
export interface ProjectSnapshot { mapping: ProjectMapping | null; plans: MigrationPlan[] }
export const WORKER_USAGE_QUERY = 'query GitflareWorkerUsage($accountTag: string!, $scriptName: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 100, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) { dimensions {scriptName} sum {requests errors} quantiles {cpuTimeP50 cpuTimeP99} } } } }';
export const D1_USAGE_QUERY = 'query GitflareD1Usage($accountTag: string!, $databaseId: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: {accountTag: $accountTag}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {databaseId: $databaseId, date_geq: $start, date_leq: $end}, orderBy: [date_DESC]) { dimensions {date databaseId} sum {readQueries writeQueries rowsRead rowsWritten} } } } }';

export interface ProjectDependencies {
  account(): Promise<{ id: string; name: string }>;
  api(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown; expectedAccountId?: string }): Promise<unknown>;
  analytics(body: { query: string; variables: Record<string, unknown>; expectedAccountId?: string }): Promise<unknown>;
  authorize(action: Action, type: string, id: string): Promise<void>;
  store(operation: ProjectStoreOperation, payload: Record<string, unknown>): Promise<unknown>;
  source(commitSha: string, path: string): Promise<{ content: string; headSha: string | null }>;
}

function failure(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const sqlPath = /^(?:migrations|db\/migrations)\/[a-zA-Z0-9_/-]+\.sql$/;
const checksum = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function projectDependencies(env: AppEnv, principal: Principal, repository: Repository, connection: Pick<ProjectDependencies, 'account' | 'api' | 'analytics'>): ProjectDependencies {
  const access = env.GITFLARE_SECURITY.getByName('security');
  return { ...connection, authorize: async (action, type, id) => { await access.authorize(principal, action, type, id); }, store: async (operation, payload) => access.projectStore(principal, repository.id, operation, payload), source: async (commitSha, path) => {
    if (!env.ARTIFACTS || repository.provider !== 'artifacts') failure(503, 'REPOSITORY_NOT_CONNECTED', 'A connected Artifacts repository is required.');
    using handle = await env.ARTIFACTS.get(repository.name);
    const file = await handle.readFile({ ref: commitSha, path });
    if (!file) failure(404, 'MIGRATION_FILE_NOT_FOUND', 'The migration file was not found at that revision.');
    if (file.size > 65536) failure(413, 'MIGRATION_TOO_LARGE', 'Migration files are limited to 64 KiB.');
    return { content: await file.text(), headSha: await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch) };
  } };
}

function sourceInput(body: Record<string, unknown>): { commitSha: string; path: string } {
  if (typeof body.commitSha !== 'string' || !sha.test(body.commitSha) || typeof body.path !== 'string' || !sqlPath.test(body.path) || body.path.split('/').some(part => !part || part === '.' || part === '..')) failure(400, 'INVALID_MIGRATION_SOURCE', 'Choose a SQL file in migrations/ or db/migrations/ at an exact repository revision.');
  return { commitSha: body.commitSha as string, path: body.path as string };
}

async function loadSource(dependencies: ProjectDependencies, commitSha: string, path: string) {
  const source = await dependencies.source(commitSha, path);
  if (source.headSha !== commitSha) failure(409, 'STALE_MIGRATION_REVISION', 'The repository head changed. Create a plan from the current revision.');
  if (!source.content.trim() || new TextEncoder().encode(source.content).length > 65536 || source.content.includes('\0')) failure(400, 'INVALID_MIGRATION_CONTENT', 'The migration must be non-empty UTF-8 SQL of at most 64 KiB.');
  return source.content;
}

export async function dispatchCloudflareProject(principal: Principal, repository: Repository, operation: ProjectOperation, body: Record<string, unknown>, dependencies: ProjectDependencies): Promise<unknown> {
  if ((repository.workspaceId ?? 'legacy') !== principal.workspaceId) failure(404, 'REPOSITORY_NOT_FOUND', 'The repository was not found in this workspace.');
  await dependencies.authorize('read', 'repository', repository.id);
  const stored = await dependencies.store('get', {}) as ProjectSnapshot;
  const snapshot = { ...stored, mapping: stored.mapping ? normalizeProjectMapping(stored.mapping) : null };
  if (operation === 'get') return { ...snapshot, capabilities: { usage: true, d1Migrations: true, workerBuilds: false, durableObjectMigrations: false } };
  const account = await dependencies.account();
  if (operation !== 'map' && snapshot.mapping && snapshot.mapping.accountId !== account.id) failure(409, 'PROJECT_ACCOUNT_CHANGED', 'Relink this project after changing the Cloudflare account.');
  if (operation === 'map') {
    if (principal.role !== 'Owner') failure(403, 'OWNER_REQUIRED', 'Only a workspace Owner can map Cloudflare project resources.');
    await dependencies.authorize('manage', 'workspace', principal.workspaceId);
    const keys = ['resources', 'workerName', 'd1DatabaseId', 'durableObjectNamespaceId', 'buildTriggerId'];
    if (Object.keys(body).some(key => !keys.includes(key)) || keys.slice(1).some(key => body[key] !== undefined && typeof body[key] !== 'string')) failure(400, 'INVALID_PROJECT_MAPPING', 'Choose resources from the connected account.');
    if (body.buildTriggerId) failure(501, 'BUILD_TRIGGER_UNAVAILABLE', 'Linked Workers Builds triggers are not supported in this release.');
    if (body.resources !== undefined && keys.slice(1).some(key => body[key] !== undefined)) failure(400, 'INVALID_PROJECT_MAPPING', 'Use either resources or legacy resource fields.');
    const requested = body.resources !== undefined ? body.resources : normalizeProjectMapping(body as unknown as ProjectMapping).resources;
    if (!Array.isArray(requested) || requested.length > 100) failure(400, 'INVALID_PROJECT_MAPPING', 'Choose at most 100 resources.');
    const resources: ProjectResource[] = [];
    const seen = new Set<string>();
    let namespaceCatalog: { id: string; name?: string }[] | undefined;
    for (const item of requested) {
      if (!item || typeof item !== 'object' || !['worker','d1','durable_object','container','workflow'].includes(item.type) || typeof item.id !== 'string' || !item.id || item.id.length > 128 || typeof item.name !== 'string' || item.name.length > 200 || typeof item.environment !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(item.environment) || Object.keys(item).some(key => !['type','id','name','environment'].includes(key))) failure(400, 'INVALID_PROJECT_MAPPING', 'Choose valid resources and environment names.');
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) failure(400, 'DUPLICATE_PROJECT_RESOURCE', 'A resource can be linked only once.');
      seen.add(key);
      let name = item.id;
      if (item.type === 'worker') {
        if (!/^[a-zA-Z0-9_-]{1,63}$/.test(item.id)) failure(400, 'INVALID_WORKER_NAME', 'Invalid Worker name.');
        const settings = await dependencies.api(`/workers/scripts/${item.id}/settings`, { expectedAccountId: account.id });
        if (!settings || typeof settings !== 'object') failure(404, 'WORKER_NOT_FOUND', 'This Worker was not found in the connected account.');
      } else if (item.type === 'd1') {
        if (!uuid.test(item.id)) failure(400, 'INVALID_D1_ID', 'Invalid D1 database ID.');
        const database = await dependencies.api(`/d1/database/${item.id}`, { expectedAccountId: account.id }) as { uuid?: string; name?: string };
        if (database?.uuid !== item.id) failure(404, 'D1_NOT_FOUND', 'This D1 database was not found in the connected account.');
        name = database.name ?? item.id;
      } else if (item.type === 'durable_object') {
        if (!/^[a-f0-9]{32}$/.test(item.id)) failure(400, 'INVALID_DO_NAMESPACE', 'Invalid Durable Object namespace ID.');
        namespaceCatalog ??= await dependencies.api('/workers/durable_objects/namespaces', { expectedAccountId: account.id }) as { id: string; name?: string }[];
        const namespace = Array.isArray(namespaceCatalog) ? namespaceCatalog.find(value => value.id === item.id) : undefined;
        if (!namespace) failure(404, 'DO_NAMESPACE_NOT_FOUND', 'This namespace was not found in the connected account.');
        name = namespace.name ?? item.id;
      } else if (item.type === 'workflow') {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) failure(400, 'INVALID_WORKFLOW_NAME', 'Invalid Workflow name.');
        const workflow = await dependencies.api(`/workflows/${item.id}`, { expectedAccountId: account.id }) as { name?: string };
        if (workflow?.name !== item.id) failure(404, 'WORKFLOW_NOT_FOUND', 'This Workflow was not found in the connected account.');
        name = workflow.name;
      } else {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id)) failure(400, 'INVALID_CONTAINER_ID', 'Invalid Container application ID.');
        const application = await dependencies.api(`/containers/applications/${encodeURIComponent(item.id)}`, { expectedAccountId: account.id }) as { id?: string; name?: string };
        if (application?.id !== item.id || !application.name) failure(404, 'CONTAINER_NOT_FOUND', 'This Container application was not found in the connected account.');
        name = application.name;
      }
      if (typeof name !== 'string' || !name || name.length > 200) failure(502, 'INVALID_RESOURCE_NAME', 'Cloudflare returned an invalid resource name.');
      resources.push({ type: item.type, id: item.id, name, environment: item.environment });
    }
    const mapping: ProjectMapping = { repositoryId: repository.id, workspaceId: principal.workspaceId, accountId: account.id, version: crypto.randomUUID(), resources, updatedAt: new Date().toISOString() };
    return dependencies.store('set', { mapping });
  }
  const mapping = snapshot.mapping;
  if (!mapping) failure(409, 'PROJECT_NOT_MAPPED', 'Map Cloudflare resources to this repository first.');
  if (operation === 'usage') return projectUsage(mapping, dependencies);
  if (operation === 'build-trigger') {
    const worker = mapping.resources.find(resource => resource.type === 'worker');
    if (!worker) failure(409, 'WORKER_NOT_MAPPED', 'Map a Worker first.');
    await dependencies.authorize('deploy', 'environment', worker.id);
    failure(501, 'BUILD_TRIGGER_UNAVAILABLE', 'Triggering a Worker build requires a verified linked Workers Builds project, which is not supported in this release.');
  }
  const databases = mapping.resources.filter(resource => resource.type === 'd1');
  if (!databases.length) failure(409, 'D1_NOT_MAPPED', 'Map a D1 database before planning a migration.');
  if (operation === 'migration-plan') {
    if (Object.keys(body).some(key => !['commitSha', 'path', 'databaseId'].includes(key))) failure(400, 'INVALID_MIGRATION_SOURCE', 'Migration plans accept database ID, repository revision and path only.');
    const databaseId = body.databaseId !== undefined ? body.databaseId : (databases.length === 1 ? databases[0].id : undefined);
    if (typeof databaseId !== 'string' || !databases.some(resource => resource.id === databaseId)) failure(400, 'INVALID_MIGRATION_DATABASE', 'Choose an explicitly linked D1 database for this migration.');
    await dependencies.authorize('migrate', 'database', databaseId);
    const { commitSha, path } = sourceInput(body);
    const sql = await loadSource(dependencies, commitSha, path);
    const plan: MigrationPlan = { id: crypto.randomUUID(), repositoryId: repository.id, workspaceId: principal.workspaceId, accountId: account.id, mappingVersion: mapping.version, databaseId, commitSha, path, checksum: await checksum(sql), createdAt: new Date().toISOString(), status: 'pending' };
    await dependencies.store('plan', { plan });
    return { plan, source: { content: sql, commitSha, path } };
  }
  if (operation !== 'migration-execute') failure(400, 'INVALID_PROJECT_OPERATION', 'Unknown project action.');
  if (typeof body.planId !== 'string' || !uuid.test(body.planId) || typeof body.checksum !== 'string' || !checksumPattern.test(body.checksum) || Object.keys(body).some(key => !['planId', 'checksum'].includes(key))) failure(400, 'INVALID_MIGRATION_APPROVAL', 'Choose a pending plan and its exact checksum.');
  const plan = snapshot.plans.find(item => item.id === body.planId);
  if (!plan || plan.status !== 'pending' || plan.checksum !== body.checksum || plan.mappingVersion !== mapping.version || plan.accountId !== account.id || !databases.some(resource => resource.id === plan.databaseId)) failure(409, 'STALE_MIGRATION_PLAN', 'This plan is no longer pending for the current project resources.');
  await dependencies.authorize('migrate', 'database', plan.databaseId);
  sourceInput(plan as unknown as Record<string, unknown>);
  const sql = await loadSource(dependencies, plan.commitSha, plan.path);
  if (await checksum(sql) !== plan.checksum) failure(409, 'MIGRATION_SOURCE_CHANGED', 'The migration source checksum does not match the reviewed plan.');
  await dependencies.store('consume', { planId: plan.id, checksum: plan.checksum });
  let result: unknown;
  try { result = await dependencies.api(`/d1/database/${plan.databaseId}/query`, { method: 'POST', body: { sql }, expectedAccountId: plan.accountId }); }
  catch {
    await dependencies.store('finish', { planId: plan.id, status: 'unknown', error: 'The execution response was uncertain. Inspect D1 before any new plan; this operation will not be retried.' });
    return { plan: { ...plan, status: 'unknown' }, result: null };
  }
  const rows = Array.isArray(result) ? result : [result];
  const succeeded = rows.length > 0 && rows.every(item => item && typeof item === 'object' && 'success' in item && item.success === true);
  await dependencies.store('finish', { planId: plan.id, status: succeeded ? 'succeeded' : 'failed', ...(!succeeded ? { error: 'D1 returned a failed migration result. Inspect the database before preparing another plan.' } : {}) });
  return { plan: { ...plan, status: succeeded ? 'succeeded' : 'failed' }, result: rows.map(item => item && typeof item === 'object' && 'meta' in item ? { meta: item.meta } : null) };
}

async function projectUsage(mapping: ProjectMapping, dependencies: ProjectDependencies) {
  const to = new Date().toISOString();
  const from = new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString();
  const query = async (statement: string, variables: Record<string, unknown>, node: string, resourceKey: string, resourceId: string) => {
    try {
      const response = await dependencies.analytics({ query: statement, variables, expectedAccountId: mapping.accountId });
      const envelope = response as { data?: { viewer?: { accounts?: Record<string, unknown>[] } }; errors?: unknown[]; viewer?: { accounts?: Record<string, unknown>[] } };
      if (envelope.errors?.length) return { available: false, reason: 'Cloudflare analytics is unavailable for this connection.' };
      const accounts = (envelope.data ?? envelope).viewer?.accounts;
      const data = accounts?.[0]?.[node];
      if (!Array.isArray(data) || data.some(item => !item?.dimensions || item.dimensions[resourceKey] !== resourceId)) return { available: false, reason: 'Cloudflare did not return verified resource-scoped analytics.' };
      return { available: true, data };
    } catch { return { available: false, reason: 'Analytics permissions or this dataset are unavailable. No usage values were estimated.' }; }
  };
  const resources = await Promise.all(normalizeProjectMapping(mapping).resources.map(async resource => {
    if (resource.type === 'worker') return { resource, ...await query(WORKER_USAGE_QUERY, { accountTag: mapping.accountId, scriptName: resource.id, start: from, end: to }, 'workersInvocationsAdaptive', 'scriptName', resource.id), window: { from, to } };
    if (resource.type === 'd1') return { resource, ...await query(D1_USAGE_QUERY, { accountTag: mapping.accountId, databaseId: resource.id, start: from.slice(0, 10), end: to.slice(0, 10) }, 'd1AnalyticsAdaptiveGroups', 'databaseId', resource.id), window: { from: from.slice(0, 10), to: to.slice(0, 10), granularity: 'day' } };
    return { resource, available: false, reason: `${resource.type} usage counters are not supported by this integration.` };
  }));
  return { observedAt: to, resources, worker: resources.find(item => item.resource.type === 'worker') ?? { available: false, reason: 'No Worker is mapped.' }, d1: resources.find(item => item.resource.type === 'd1') ?? { available: false, reason: 'No D1 database is mapped.' }, durableObjects: { available: false, reason: 'Durable Object usage counters are not supported by this integration.' } };
}
