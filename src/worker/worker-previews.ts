import { ApiError } from './domain';
import { hostedPreviewBindings, previewExports, previewMigrations, type WorkerBundle } from './worker-bundle';

// Worker Previews REST endpoints are not in the public API reference yet; paths and payloads mirror Wrangler 4.149 (deploy-helpers/src/preview/api.ts)
const API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const PREVIEW_NOT_FOUND = [10025, 10222];
const WORKER_NOT_FOUND = [10007, 10090];

export interface WorkerPreviewsEnv { PREVIEWS_API_TOKEN?: string; PREVIEWS_ACCOUNT_ID?: string; PREVIEWS_WORKER_NAME?: string }
export interface WorkerPreviewsConfig { accountId: string; workerName: string; token: string }
export interface WorkerPreviewResult { previewName: string; previewId: string; previewUrl: string | null; deploymentId: string; deploymentUrl: string | null; notes: string[] }
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
    if (WORKER_NOT_FOUND.some((code) => codes.includes(code))) throw new WorkerPreviewError('PREVIEWS_WORKER_MISSING', `The previews Worker ${config.workerName} does not exist. Create it once in the operator account before enabling previews.`, response.status, codes);
    if (response.status === 401 || response.status === 403) throw new WorkerPreviewError('PREVIEWS_FORBIDDEN', 'The previews API token was rejected. It needs Workers Scripts Write on the previews account.', response.status, codes);
    throw new WorkerPreviewError(response.status === 404 || PREVIEW_NOT_FOUND.some((code) => codes.includes(code)) ? 'PREVIEW_NOT_FOUND' : 'PREVIEWS_REJECTED', `Cloudflare rejected the preview request${detail ? `: ${detail}` : '.'}`, response.status, codes);
  }
  return envelope.result as T;
}

const notFound = (error: unknown) => error instanceof WorkerPreviewError && error.code === 'PREVIEW_NOT_FOUND';

export function previewDeploymentForm(bundle: WorkerBundle, metadata: Record<string, unknown>): FormData {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: bundle.mainModule, ...metadata }));
  for (const module of bundle.modules) form.append('files', new File([module.content], module.name, { type: module.contentType }));
  return form;
}

export interface UpsertPreviewInput { alias: string; bundle: WorkerBundle; annotations?: Record<string, string> }

export async function upsertWorkerPreview(config: WorkerPreviewsConfig, input: UpsertPreviewInput, fetcher: Fetcher = (request) => fetch(request)): Promise<WorkerPreviewResult> {
  if (!validPreviewAlias(input.alias, config.workerName)) throw new WorkerPreviewError('PREVIEW_NAME_INVALID', 'The preview name is not a valid hostname label.');
  let preview: PreviewResource | null = null;
  try { preview = await call<PreviewResource>(config, fetcher, `/previews/${encodeURIComponent(input.alias)}`); }
  catch (error) { if (!notFound(error)) throw error; }
  const created = !preview;
  if (!preview) preview = await call<PreviewResource>(config, fetcher, '/previews?ignore_base_config=true', { method: 'POST', json: { name: input.alias } });
  if (!preview?.id) throw new WorkerPreviewError('PREVIEWS_REJECTED', 'Cloudflare did not return a preview identifier.');
  let latest: PreviewDeployment | undefined;
  if (!created && input.bundle.config.migrations.length) {
    try { latest = await call<PreviewDeployment>(config, fetcher, `/previews/${encodeURIComponent(preview.id)}/deployments/latest`); }
    catch (error) { if (!notFound(error)) throw error; }
  }
  const plan = hostedPreviewBindings(input.bundle.config);
  const migrations = previewMigrations(input.bundle.config, latest?.migration_tag);
  const exported = previewExports(input.bundle.config);
  const metadata = {
    compatibility_date: input.bundle.config.compatibilityDate,
    ...(input.bundle.config.compatibilityFlags.length ? { compatibility_flags: input.bundle.config.compatibilityFlags } : {}),
    ...(Object.keys(plan.env).length ? { env: plan.env } : {}),
    ...(migrations ? { migrations } : {}),
    ...(exported ? { exports: exported } : {}),
    ...(input.annotations ? { annotations: input.annotations } : {}),
  };
  const deployment = await call<PreviewDeployment>(config, fetcher, `/previews/${encodeURIComponent(preview.id)}/deployments`, { method: 'POST', body: previewDeploymentForm(input.bundle, metadata) });
  if (!deployment?.id) throw new WorkerPreviewError('PREVIEWS_REJECTED', 'Cloudflare did not return a preview deployment.');
  const https = (urls?: string[]) => urls?.find((url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } }) ?? null;
  return { previewName: input.alias, previewId: preview.id, previewUrl: https(preview.urls), deploymentId: deployment.id, deploymentUrl: https(deployment.urls), notes: plan.notes };
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
