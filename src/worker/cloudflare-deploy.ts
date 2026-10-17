import { ApiError } from './domain';
import { inheritedMetadata, workerUploadForm, type WorkerDeployer, type WorkerVersionDeployment } from './deployments';

export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';

export interface CloudflareCallInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  json?: unknown;
  form?: FormData;
  body?: Uint8Array<ArrayBuffer>;
  query?: Record<string, string | string[]>;
  bearer?: string;
  headers?: Record<string, string>;
  allowNotFound?: boolean;
  envelope?: boolean;
}

export type CloudflareCall = <T = unknown>(path: string, init?: CloudflareCallInit) => Promise<T>;

export interface CloudflareDeployClient {
  accountId: string;
  scopes: string[];
  source: 'repository' | 'workspace';
  call: CloudflareCall;
}

export interface CloudflareDeployAccess { accessToken: string; accountId: string; accountName?: string; scopes: string[]; source: 'repository' | 'workspace' }

const safePath = /^\/[A-Za-z0-9_.:@=-]+(?:\/[A-Za-z0-9_.:@=-]+)*$/;

export function cloudflareDeployClient(access: CloudflareDeployAccess, fetcher: (request: Request) => Promise<Response> = (request) => fetch(request)): CloudflareDeployClient {
  const accountPrefix = `/accounts/${access.accountId}/`;
  const call: CloudflareCall = async <T,>(path: string, init: CloudflareCallInit = {}): Promise<T> => {
    if (!safePath.test(path) || path.includes('..') || !(path.startsWith(accountPrefix) || path === '/zones')) throw new ApiError(400, 'INVALID_CLOUDFLARE_PATH', 'Use a resource path inside the selected Cloudflare account.');
    const url = new URL(`${CLOUDFLARE_API_ORIGIN}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item);
    const headers = new Headers({ Authorization: `Bearer ${init.bearer ?? access.accessToken}`, ...init.headers });
    if (init.json !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetcher(new Request(url, { method: init.method ?? 'GET', headers, body: init.form ?? init.body ?? (init.json === undefined ? undefined : JSON.stringify(init.json)), redirect: 'manual', signal: AbortSignal.timeout(90_000) })); }
    catch { throw new ApiError(502, 'CLOUDFLARE_UNAVAILABLE', 'Cloudflare could not be reached. Try again.'); }
    if (response.status === 404 && init.allowNotFound) return null as T;
    const envelope = await response.json().catch(() => ({})) as { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] };
    if (!response.ok || envelope.success === false) {
      const detail = (envelope.errors ?? []).map((error) => `${error.message ?? ''}${error.code ? ` [${error.code}]` : ''}`.trim()).filter(Boolean).join('; ').slice(0, 400);
      const status = response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : response.status === 409 ? 409 : 502;
      throw new ApiError(status, status === 403 ? 'CLOUDFLARE_PERMISSION_DENIED' : status === 404 ? 'CLOUDFLARE_NOT_FOUND' : 'CLOUDFLARE_DEPLOY_REJECTED', `Cloudflare rejected ${init.method ?? 'GET'} ${path.replace(accountPrefix, '/')}${detail ? `: ${detail}` : '.'}`);
    }
    return (init.envelope ? envelope : envelope.result) as T;
  };
  return { accountId: access.accountId, scopes: access.scopes, source: access.source, call };
}

const UPLOAD_QUERY = { bindings_inherit: 'strict' };

export function workerDeployer(client: CloudflareDeployClient, workerName: string): WorkerDeployer {
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(workerName)) throw new ApiError(400, 'INVALID_WORKER_NAME', 'Invalid Worker name.');
  const script = `/accounts/${client.accountId}/workers/scripts/${workerName}`;
  const missing = (error: unknown): never => {
    if (error instanceof ApiError && error.code === 'CLOUDFLARE_NOT_FOUND') throw new ApiError(404, 'WORKER_NOT_FOUND', `Worker ${workerName} was not found in the connected account.`);
    throw error;
  };
  return {
    accountId: client.accountId,
    scopes: client.scopes,
    call: client.call,
    async uploadVersion(bundle, annotations, metadata) {
      const result = await client.call<{ id?: string }>(`${script}/versions`, { method: 'POST', form: workerUploadForm(bundle, metadata ?? inheritedMetadata(bundle, annotations)), ...(metadata ? { query: UPLOAD_QUERY } : {}) }).catch(missing);
      if (typeof result?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return a Worker version.');
      return { id: result.id };
    },
    async uploadScript(bundle, metadata) {
      const result = await client.call<{ deployment_id?: string }>(script, { method: 'PUT', form: workerUploadForm(bundle, metadata), query: { excludeScript: 'true', ...UPLOAD_QUERY } });
      const id = result?.deployment_id;
      if (typeof id !== 'string' || !(id.includes('-') || id.length === 32)) throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return the deployed Worker version.');
      return { id: id.includes('-') ? id : `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` };
    },
    async latestDeployment() {
      const result = await client.call<{ deployments?: WorkerVersionDeployment[] }>(`${script}/deployments`).catch(missing);
      return result?.deployments?.[0] ?? null;
    },
    async deploy(versions, message) {
      const result = await client.call<{ id?: string }>(`${script}/deployments`, { method: 'POST', json: { strategy: 'percentage', versions, annotations: { 'workers/message': message.slice(0, 1000), 'workers/triggered_by': 'gitflare' } } }).catch(missing);
      return { id: String(result?.id ?? '') };
    },
  };
}
