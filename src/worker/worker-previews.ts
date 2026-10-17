import { ApiError } from './domain';
import { hostedPreviewBindings, previewExports, previewMigrations, type PreviewBaseBindings, type PreviewD1Database, type WorkerBundle } from './worker-bundle';

// Worker Previews REST endpoints are not in the public API reference yet; paths and payloads mirror Wrangler 4.149 (deploy-helpers/src/preview/api.ts)
const API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const PREVIEW_NOT_FOUND = [10025, 10222];
const WORKER_NOT_FOUND = [10007, 10090];

export interface WorkerPreviewsEnv { PREVIEWS_API_TOKEN?: string; PREVIEWS_ACCOUNT_ID?: string; PREVIEWS_WORKER_NAME?: string }
export interface WorkerPreviewsConfig { accountId: string; workerName: string; token: string; connection?: 'repository' | 'workspace' }
export interface WorkerPreviewResult { previewName: string; previewId: string; previewUrl: string | null; deploymentId: string; deploymentUrl: string | null; notes: string[]; d1Databases?: PreviewD1Database[]; baseBindings?: { name: string; type: string }[] }
export type Fetcher = (input: Request) => Promise<Response>;
interface Envelope<T> { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T }
interface PreviewResource { id?: string; name?: string; slug?: string; urls?: string[] }
interface PreviewDeployment { id?: string; urls?: string[]; migration_tag?: string }

export class WorkerPreviewError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number, readonly apiCodes: number[] = []) {
    super(message.slice(0, 700));
    this.name = 'WorkerPreviewError';
  }
}

export function workerPreviewsConfig(env: WorkerPreviewsEnv): WorkerPreviewsConfig | null {
  const accountId = env.PREVIEWS_ACCOUNT_ID?.trim();
  const workerName = env.PREVIEWS_WORKER_NAME?.trim();
  const token = env.PREVIEWS_API_TOKEN?.trim();
  if (!accountId || !workerName || !token) return null;
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{0,52}$/.test(workerName)) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEWS_ACCOUNT_ID or PREVIEWS_WORKER_NAME is invalid.');
  return { accountId, workerName, token };
}

// Preview hostnames are `<alias>-<worker>`; the combined DNS label is limited to 63 characters
export function previewAlias(missionId: string, workerName: string): string {
  const compact = missionId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const room = 63 - workerName.length - 1 - 'pr-'.length;
  if (room < 4 || !compact) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEWS_WORKER_NAME is too long to form preview hostnames.');
  return `pr-${compact.slice(0, Math.min(12, room))}`;
}

export function validPreviewAlias(alias: string, workerName: string): boolean {
  return /^[a-z][a-z0-9-]*[a-z0-9]$/.test(alias) && alias.length + 1 + workerName.length <= 63;
}

async function call<T>(config: WorkerPreviewsConfig, fetcher: Fetcher, path: string, init: { method?: string; json?: unknown; body?: FormData; contentType?: string } = {}): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${config.token}` });
  if (init.json !== undefined) headers.set('Content-Type', init.contentType ?? 'application/json');
  let response: Response;
  try {
    response = await fetcher(new Request(`${API_ORIGIN}/accounts/${config.accountId}/workers/workers/${config.workerName}${path}`, { method: init.method ?? 'GET', headers, body: init.body ?? (init.json === undefined ? undefined : JSON.stringify(init.json)), redirect: 'manual', signal: AbortSignal.timeout(60_000) }));
  } catch { throw new WorkerPreviewError('PREVIEWS_UNAVAILABLE', 'Cloudflare Worker Previews could not be reached.'); }
  const envelope = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok || envelope.success === false) {
    const codes = (envelope.errors ?? []).map((error) => Number(error.code)).filter(Number.isFinite);
    const detail = (envelope.errors ?? []).map((error) => error.message).filter(Boolean).join('; ').slice(0, 300);
    if (WORKER_NOT_FOUND.some((code) => codes.includes(code))) throw new WorkerPreviewError('PREVIEWS_WORKER_MISSING', config.connection ? `Worker ${config.workerName} does not exist on account ${config.accountId}. Deploy it once; Gitflare never creates a Worker for previews.` : `The previews Worker ${config.workerName} does not exist. An Owner can set up the installation credential again in Settings → Cloudflare, which creates it.`, response.status, codes);
    if (response.status === 401 || response.status === 403) throw new WorkerPreviewError('PREVIEWS_FORBIDDEN', config.connection ? `The ${config.connection} Cloudflare connection was refused for Worker ${config.workerName}. It needs workers-scripts.edit; an Owner can reconnect Cloudflare.` : 'The previews API token was rejected. It needs Workers Scripts Edit on the previews account. An Owner can replace it in Settings → Cloudflare → Previews and deploys on this installation.', response.status, codes);
    throw new WorkerPreviewError(response.status === 404 || PREVIEW_NOT_FOUND.some((code) => codes.includes(code)) ? 'PREVIEW_NOT_FOUND' : 'PREVIEWS_REJECTED', `Cloudflare rejected the preview request${detail ? `: ${detail}` : '.'}`, response.status, codes);
  }
  return envelope.result as T;
}

export type PreviewWorkerProbe = 'exists' | 'missing' | 'forbidden';

export async function probePreviewWorker(config: WorkerPreviewsConfig, fetcher: Fetcher = (request) => fetch(request)): Promise<PreviewWorkerProbe> {
  try {
    await call<unknown>(config, fetcher, '/previews?per_page=1');
    return 'exists';
  } catch (error) {
    if (!(error instanceof WorkerPreviewError)) throw error;
    if (error.code === 'PREVIEWS_WORKER_MISSING' || error.status === 404) return 'missing';
    if (error.code === 'PREVIEWS_FORBIDDEN') return 'forbidden';
    throw error;
  }
}

const notFound = (error: unknown) => error instanceof WorkerPreviewError && error.code === 'PREVIEW_NOT_FOUND';

export interface PreviewAssets { jwt: string; config: Record<string, unknown> }
type AssetRules = Partial<Record<'_headers' | '_redirects', string>>;

const ASSET_CONFIG_KEYS = ['html_handling', 'not_found_handling', 'base_path', 'run_worker_first'];

// Wrangler sends _headers and _redirects as deployment modules for previews, not inside assets.config
export function previewAssetsMetadata(assets: PreviewAssets): { metadata: { jwt: string; config: Record<string, unknown> }; rules: AssetRules } {
  const config = Object.fromEntries(ASSET_CONFIG_KEYS.filter((key) => assets.config[key] !== undefined).map((key) => [key, assets.config[key]]));
  const rules: AssetRules = {};
  for (const name of ['_headers', '_redirects'] as const) if (typeof assets.config[name] === 'string') rules[name] = assets.config[name] as string;
  return { metadata: { jwt: assets.jwt, config }, rules };
}

export function previewDeploymentForm(bundle: WorkerBundle, metadata: Record<string, unknown>, rules: AssetRules = {}): FormData {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: bundle.mainModule, ...metadata }));
  for (const module of bundle.modules) form.append('files', new File([module.content], module.name, { type: module.contentType }));
  for (const [name, content] of Object.entries(rules)) form.append('files', new File([content], name, { type: 'text/plain' }));
  return form;
}

export interface UpsertPreviewInput { alias: string; bundle: WorkerBundle; annotations?: Record<string, string>; uploadAssets?: () => Promise<PreviewAssets>; d1?: PreviewD1Database[]; inheritBaseConfig?: boolean; emailRecipients?: string[] }

export async function getPreviewBaseConfig(config: WorkerPreviewsConfig, fetcher: Fetcher = (request) => fetch(request)): Promise<PreviewBaseBindings> {
  const worker = await call<{ previews_base_config?: { env?: unknown } }>(config, fetcher, '');
  const env = worker?.previews_base_config?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([name]) => /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)).map(([name, binding]) => [name, { type: binding && typeof binding === 'object' && typeof (binding as { type?: unknown }).type === 'string' ? String((binding as { type: string }).type).slice(0, 40) : 'binding' }]));
}

export async function upsertWorkerPreview(config: WorkerPreviewsConfig, input: UpsertPreviewInput, fetcher: Fetcher = (request) => fetch(request)): Promise<WorkerPreviewResult> {
  if (!validPreviewAlias(input.alias, config.workerName)) throw new WorkerPreviewError('PREVIEW_NAME_INVALID', 'The preview name is not a valid hostname label.');
  const base = input.inheritBaseConfig ? await getPreviewBaseConfig(config, fetcher) : null;
  let preview: PreviewResource | null = null;
  try { preview = await call<PreviewResource>(config, fetcher, `/previews/${encodeURIComponent(input.alias)}`); }
  catch (error) { if (!notFound(error)) throw error; }
  const created = !preview;
  if (!preview) preview = await call<PreviewResource>(config, fetcher, input.inheritBaseConfig ? '/previews' : '/previews?ignore_base_config=true', { method: 'POST', json: { name: input.alias } });
  if (!preview?.id) throw new WorkerPreviewError('PREVIEWS_REJECTED', 'Cloudflare did not return a preview identifier.');
  let latest: PreviewDeployment | undefined;
  if (!created && input.bundle.config.migrations.length) {
    try { latest = await call<PreviewDeployment>(config, fetcher, `/previews/${encodeURIComponent(preview.id)}/deployments/latest`); }
    catch (error) { if (!notFound(error)) throw error; }
  }
  const plan = hostedPreviewBindings(input.bundle.config, input.d1, base, input.emailRecipients);
  const migrations = previewMigrations(input.bundle.config, latest?.migration_tag);
  const exported = previewExports(input.bundle.config);
  const assets = input.uploadAssets ? previewAssetsMetadata(await input.uploadAssets()) : null;
  const metadata = {
    compatibility_date: input.bundle.config.compatibilityDate,
    ...(input.bundle.config.compatibilityFlags.length ? { compatibility_flags: input.bundle.config.compatibilityFlags } : {}),
    ...(Object.keys(plan.env).length ? { env: plan.env } : {}),
    ...(migrations ? { migrations } : {}),
    ...(exported ? { exports: exported } : {}),
    ...(assets ? { assets: assets.metadata } : {}),
    ...(input.annotations ? { annotations: input.annotations } : {}),
  };
  const deployment = await call<PreviewDeployment>(config, fetcher, `/previews/${encodeURIComponent(preview.id)}/deployments`, { method: 'POST', body: previewDeploymentForm(input.bundle, metadata, assets?.rules) });
  if (!deployment?.id) throw new WorkerPreviewError('PREVIEWS_REJECTED', 'Cloudflare did not return a preview deployment.');
  const https = (urls?: string[]) => urls?.find((url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } }) ?? null;
  return { previewName: input.alias, previewId: preview.id, previewUrl: https(preview.urls), deploymentId: deployment.id, deploymentUrl: https(deployment.urls), notes: plan.notes, ...(input.d1?.length ? { d1Databases: input.d1 } : {}), ...(base ? { baseBindings: Object.entries(base).map(([name, binding]) => ({ name, type: binding.type ?? 'binding' })) } : {}) };
}

export async function deleteWorkerPreview(config: WorkerPreviewsConfig, alias: string, fetcher: Fetcher = (request) => fetch(request)): Promise<'deleted' | 'missing'> {
  if (!validPreviewAlias(alias, config.workerName)) throw new WorkerPreviewError('PREVIEW_NAME_INVALID', 'The preview name is not a valid hostname label.');
  try {
    await call<unknown>(config, fetcher, `/previews/${encodeURIComponent(alias)}`, { method: 'DELETE' });
    return 'deleted';
  } catch (error) {
    if (notFound(error)) return 'missing';
    throw error;
  }
}
