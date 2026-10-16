import { ApiError, assertMutationOrigin, readJson, requireString } from './domain';
import type { AppEnv } from './env';
import { decryptAuth, encryptAuth } from './mfa';
import { securityClient, type InstallationCredentialRecord, type Principal } from './security';
import { workerPreviewsConfig, type Fetcher, type WorkerPreviewsConfig } from './worker-previews';

const API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const CONTEXT = 'installation-cloudflare-credential';
const WORKER_NOT_FOUND = [10007, 10090];
const DEFAULT_WORKER_NAME = 'gitflare-previews';
export const WORKERS_PERMISSION = 'workers_scripts:edit';
export const D1_PERMISSION = 'd1:edit';
const PERMISSION_LABELS: Record<string, string> = { [WORKERS_PERMISSION]: 'Workers Scripts: Edit', [D1_PERMISSION]: 'D1: Edit' };

type Account = { id: string; name: string };
type Outcome = { ok: boolean; status: number; codes: number[]; result: unknown };
export type InstallationCredentialSource = 'installation' | 'environment' | 'none';
export interface InstallationCredentialStatus {
  manageable: boolean;
  edition: 'hosted' | 'self-hosted';
  source: InstallationCredentialSource;
  state: 'configured' | 'missing_permission' | 'missing';
  accountId?: string;
  workerName?: string;
  permissions?: string[];
  missing?: { key: string; label: string }[];
  verifiedAt?: string;
  tokenPageUrl?: string;
}
export type SetCredentialResult = { stored: true; createdWorker: boolean; status: InstallationCredentialStatus } | { stored: false; accountSelectionRequired: true; accounts: Account[] };

function security(env: AppEnv) { return securityClient(env); }

export function previewsTokenPageUrl(workerName: string, accountId?: string): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify([{ key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' }]));
  url.searchParams.set('name', workerName);
  if (accountId) url.searchParams.set('accountId', accountId);
  return url.toString();
}

function configuredWorkerName(env: AppEnv): string {
  const name = env.PREVIEWS_WORKER_NAME?.trim() || DEFAULT_WORKER_NAME;
  if (!/^[a-z0-9][a-z0-9-]{0,52}$/.test(name)) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEWS_WORKER_NAME is invalid.');
  return name;
}

function configuredAccountId(env: AppEnv): string | undefined {
  const id = env.PREVIEWS_ACCOUNT_ID?.trim();
  if (id && !/^[a-f0-9]{32}$/.test(id)) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEWS_ACCOUNT_ID is invalid.');
  return id || undefined;
}

async function cloudflare(token: string, path: string, fetcher: Fetcher, init: { method?: string; json?: unknown } = {}): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetcher(new Request(`${API_ORIGIN}${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: init.json === undefined ? undefined : JSON.stringify(init.json), redirect: 'manual', signal: AbortSignal.timeout(15_000) }));
  } catch { throw new ApiError(502, 'CLOUDFLARE_UNAVAILABLE', 'Cloudflare could not be reached. Try again.'); }
  const envelope = await response.json().catch(() => ({})) as { success?: boolean; errors?: { code?: number }[]; result?: unknown };
  return { ok: response.ok && envelope.success !== false, status: response.status, codes: (envelope.errors ?? []).map((error) => Number(error.code)).filter(Number.isFinite), result: envelope.result };
}

const denied = (outcome: Outcome) => outcome.status === 401 || outcome.status === 403;

function accountList(result: unknown): Account[] {
  return (Array.isArray(result) ? result : []).filter((item) => item && typeof item.id === 'string' && /^[a-f0-9]{32}$/.test(item.id)).map((item) => ({ id: item.id as string, name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.id as string }));
}

function activeToken(outcome: Outcome): boolean {
  return outcome.ok && (outcome.result as { status?: unknown } | undefined)?.status === 'active';
}

export interface VerifiedCredential { accountId: string; workerName: string; permissions: string[]; missing: string[]; createdWorker: boolean }

export async function verifyPreviewsToken(token: string, input: { accountId?: string; workerName: string }, fetcher: Fetcher): Promise<VerifiedCredential | { accountSelectionRequired: true; accounts: Account[] }> {
  const accountsOutcome = await cloudflare(token, '/accounts?per_page=50', fetcher);
  const accounts = accountsOutcome.ok ? accountList(accountsOutcome.result) : [];
  let accountId = input.accountId;
  if (!accountId) {
    if (accounts.length > 1) return { accountSelectionRequired: true, accounts };
    accountId = accounts[0]?.id;
  }
  const userVerify = await cloudflare(token, '/user/tokens/verify', fetcher);
  const verified = activeToken(userVerify) || (!!accountId && activeToken(await cloudflare(token, `/accounts/${accountId}/tokens/verify`, fetcher)));
  if (!verified) throw new ApiError(400, 'CLOUDFLARE_TOKEN_INVALID', 'Cloudflare did not accept this token as active. Create a new token from the prefilled Cloudflare page and paste it again.');
  if (!accountId) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_REQUIRED', 'This token cannot see any Cloudflare account. Create it with access to the account that should host previews.');
  if (input.accountId && accountsOutcome.ok && accounts.length && !accounts.some((account) => account.id === accountId)) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_NOT_GRANTED', `This token does not grant access to account ${accountId}. Create it for that account.`);
  const workerPath = `/accounts/${accountId}/workers/workers`;
  const missingWorkers = () => new ApiError(422, 'CLOUDFLARE_PERMISSION_MISSING', `This token cannot manage Workers on account ${accountId}. Recreate it with Account → Workers Scripts → Edit (the prefilled page includes it).`);
  let createdWorker = false;
  const previews = await cloudflare(token, `${workerPath}/${input.workerName}/previews`, fetcher);
  if (!previews.ok) {
    if (denied(previews)) throw missingWorkers();
    if (!(previews.status === 404 || WORKER_NOT_FOUND.some((code) => previews.codes.includes(code)))) throw new ApiError(502, 'CLOUDFLARE_VERIFY_FAILED', `Cloudflare could not list previews for ${input.workerName}. Try again.`);
    const created = await cloudflare(token, workerPath, fetcher, { method: 'POST', json: { name: input.workerName, subdomain: { enabled: true, previews_enabled: true } } });
    if (!created.ok) {
      if (denied(created)) throw missingWorkers();
      throw new ApiError(502, 'CLOUDFLARE_VERIFY_FAILED', `Cloudflare could not create the previews Worker ${input.workerName}. Try again.`);
    }
    createdWorker = true;
  }
  const d1 = await cloudflare(token, `/accounts/${accountId}/d1/database?per_page=1`, fetcher);
  if (!d1.ok && !denied(d1)) throw new ApiError(502, 'CLOUDFLARE_VERIFY_FAILED', 'Cloudflare could not list D1 databases. Try again.');
  return { accountId, workerName: input.workerName, permissions: d1.ok ? [WORKERS_PERMISSION, D1_PERMISSION] : [WORKERS_PERMISSION], missing: d1.ok ? [] : [D1_PERMISSION], createdWorker };
}

async function storedRecord(env: AppEnv): Promise<InstallationCredentialRecord | null> {
  if (!env.GITFLARE_SECURITY) return null;
  return security(env).installationCredential();
}

async function openRecord(env: AppEnv, record: InstallationCredentialRecord): Promise<WorkerPreviewsConfig | null> {
  if (!env.AUTH_ENCRYPTION_KEY) return null;
  try {
    const { token } = JSON.parse(await decryptAuth(record.encrypted, env.AUTH_ENCRYPTION_KEY, CONTEXT)) as { token?: unknown };
    return typeof token === 'string' && token ? { accountId: record.accountId, workerName: record.workerName, token } : null;
  } catch { return null; }
}

export async function resolveWorkerPreviewsConfig(env: AppEnv): Promise<WorkerPreviewsConfig | null> {
  const record = await storedRecord(env);
  const stored = record ? await openRecord(env, record) : null;
  return stored ?? workerPreviewsConfig(env);
}

function envFallback(env: AppEnv): WorkerPreviewsConfig | null {
  try { return workerPreviewsConfig(env); } catch { return null; }
}

export async function installationCredentialStatus(env: AppEnv, p: Principal): Promise<InstallationCredentialStatus> {
  const manageable = await security(env).installationCredentialAdmin(p);
  const edition = env.EDITION === 'self-hosted' ? 'self-hosted' : 'hosted';
  const record = await storedRecord(env);
  const usable = record ? await openRecord(env, record) : null;
  const fallback = envFallback(env);
  const source: InstallationCredentialSource = usable ? 'installation' : fallback ? 'environment' : 'none';
  const missing = usable ? record!.missing : [];
  const state = source === 'none' ? 'missing' : missing.length ? 'missing_permission' : 'configured';
  if (!manageable) return { manageable, edition, source, state };
  const workerName = usable?.workerName ?? fallback?.workerName ?? configuredWorkerName(env);
  const accountId = usable?.accountId ?? fallback?.accountId ?? configuredAccountId(env);
  return {
    manageable, edition, source, state, workerName, ...(accountId ? { accountId } : {}),
    ...(usable ? { permissions: record!.permissions, verifiedAt: record!.verifiedAt } : {}),
    missing: missing.map((key) => ({ key, label: PERMISSION_LABELS[key] ?? key })),
    tokenPageUrl: previewsTokenPageUrl(workerName, accountId),
  };
}

export async function setInstallationCredential(env: AppEnv, p: Principal, body: Record<string, unknown>, fetcher: Fetcher = (request) => fetch(request)): Promise<SetCredentialResult> {
  if (!await security(env).installationCredentialAdmin(p)) throw new ApiError(403, 'INSTALLATION_OWNER_REQUIRED', 'Only an owner of the installation workspace can change its Cloudflare credential.');
  if (!env.AUTH_ENCRYPTION_KEY) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', 'This installation has no AUTH_ENCRYPTION_KEY, so it cannot store credentials.');
  const token = requireString(body.token, 'API token', 400, 20);
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new ApiError(400, 'CLOUDFLARE_TOKEN_INVALID', 'Paste the API token exactly as Cloudflare shows it.');
  const fixedAccount = configuredAccountId(env);
  const requested = body.accountId === undefined || body.accountId === '' ? undefined : requireString(body.accountId, 'Cloudflare account', 32, 32);
  if (requested && !/^[a-f0-9]{32}$/.test(requested)) throw new ApiError(400, 'INVALID_INPUT', 'Select a valid Cloudflare account.');
  if (fixedAccount && requested && requested !== fixedAccount) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_FIXED', `Previews on this installation use account ${fixedAccount}.`);
  const verified = await verifyPreviewsToken(token, { accountId: fixedAccount ?? requested, workerName: configuredWorkerName(env) }, fetcher);
  if ('accountSelectionRequired' in verified) return { stored: false, ...verified };
  const record: InstallationCredentialRecord = {
    version: crypto.randomUUID(),
    encrypted: await encryptAuth(JSON.stringify({ token }), env.AUTH_ENCRYPTION_KEY, CONTEXT),
    accountId: verified.accountId, workerName: verified.workerName, permissions: verified.permissions, missing: verified.missing,
    verifiedAt: new Date().toISOString(), setBy: p.userId,
  };
  await security(env).changeInstallationCredential(p, record);
  return { stored: true, createdWorker: verified.createdWorker, status: await installationCredentialStatus(env, p) };
}

export async function removeInstallationCredential(env: AppEnv, p: Principal): Promise<InstallationCredentialStatus> {
  await security(env).changeInstallationCredential(p, null);
  return installationCredentialStatus(env, p);
}

export async function handleInstallationCredential(request: Request, env: AppEnv, p: Principal, action: string): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method === 'GET' && action === '') return Response.json(await installationCredentialStatus(env, p), { headers });
  if (request.method !== 'POST' || !['', 'remove'].includes(action)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported installation credential action.');
  assertMutationOrigin(request);
  const body = await readJson(request);
  if (action === 'remove') return Response.json(await removeInstallationCredential(env, p), { headers });
  if (request.headers.has('Authorization') || !p.sessionId || p.bootstrap) throw new ApiError(403, 'BROWSER_REQUIRED', 'Paste the Cloudflare token in Settings → Cloudflare while signed in through the browser. API tokens are never accepted from API or MCP clients.');
  return Response.json(await setInstallationCredential(env, p, body), { headers });
}
