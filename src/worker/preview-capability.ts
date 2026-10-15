import { ApiError } from './domain';
import type { PreviewCapability } from './coordinator';
import type { AppEnv } from './env';

export const PREVIEW_CAPABILITY_MS = 900_000;
export const PREVIEW_ISOLATION_HEADER = 'X-Gitflare-Preview-Isolation';
export const LEGACY_PREVIEW_STORE = 'catalog:owner';
const SECRET = /^[a-f0-9]{64}$/;
const WORKSPACE = /^[a-z0-9-]{1,64}$/;
const HOST = /^(?=.{1,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LIVE_STATUSES = ['needs_review', 'approved', 'integrating', 'integrated'];

export interface PreviewToken { token: string; workspaceId: string | null }
export interface PreviewTarget { origin: string; host: string; isolated: boolean }
type RelayEnv = Pick<AppEnv, 'GITFLARE_COORDINATOR' | 'SANDBOX'>;

const encoder = new TextEncoder();

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function capabilityHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parsePreviewToken(value: string | null | undefined): PreviewToken | null {
  if (!value) return null;
  if (SECRET.test(value)) return { token: value, workspaceId: null };
  const separator = value.lastIndexOf('.');
  const workspaceId = value.slice(0, separator);
  if (separator < 1 || !WORKSPACE.test(workspaceId) || !SECRET.test(value.slice(separator + 1))) return null;
  return { token: value, workspaceId };
}

export function mintPreviewToken(workspaceId: string): string {
  if (!WORKSPACE.test(workspaceId)) throw new ApiError(400, 'INVALID_WORKSPACE', 'This workspace cannot hold previews.');
  return `${workspaceId}.${randomHex(32)}`;
}

export function previewCapabilityStore(workspaceId: string | null): string {
  return workspaceId ? `previews:${workspaceId}` : LEGACY_PREVIEW_STORE;
}

export function previewTarget(configured: string | undefined, appOrigin: string, label = randomHex(16)): PreviewTarget {
  const invalid = new ApiError(503, 'PREVIEW_ORIGIN_INVALID', 'Previews require a separate HTTPS origin.');
  if (!configured) throw new ApiError(503, 'PREVIEW_NOT_CONFIGURED', 'Configure the isolated preview service before creating a preview.');
  const appHost = new URL(appOrigin).hostname;
  const wildcard = /^https:\/\/\*\.([^/:]+)\/?$/.exec(configured);
  if (wildcard) {
    const suffix = wildcard[1]!.toLowerCase();
    if (!HOST.test(suffix) || appHost === suffix || appHost.endsWith(`.${suffix}`)) throw invalid;
    const host = `${label}.${suffix}`;
    return { origin: `https://${host}`, host, isolated: true };
  }
  if (configured.includes('*')) throw invalid;
  let url: URL;
  try { url = new URL(configured); } catch { throw invalid; }
  if (url.protocol !== 'https:' || url.origin === new URL(appOrigin).origin) throw invalid;
  return { origin: url.origin, host: url.host, isolated: false };
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

export async function relayPreview(env: RelayEnv, request: Request, authorize: (capability: PreviewCapability & { principal: NonNullable<PreviewCapability['principal']> }) => Promise<void>): Promise<Response> {
  const parsed = parsePreviewToken(request.headers.get('X-Gitflare-Preview'));
  if (!parsed) return new Response('Preview access is required.', { status: 401 });
  const capability = await env.GITFLARE_COORDINATOR.getByName(previewCapabilityStore(parsed.workspaceId)).getPreviewCapability(await capabilityHash(parsed.token));
  if (!capability || !env.SANDBOX) return new Response('This preview has expired.', { status: 410 });
  if (parsed.workspaceId && capability.workspaceId !== parsed.workspaceId) return new Response('This preview has expired.', { status: 410 });
  if (capability.host && capability.host !== new URL(request.url).host) return new Response('This preview belongs to a different preview origin.', { status: 410 });
  const principal = capability.principal;
  if (!principal) return new Response('This preview requires renewal.', { status: 410 });
  try { await authorize({ ...capability, principal }); } catch { return new Response('Preview authority has been revoked.', { status: 410 }); }
  const mission = await env.GITFLARE_COORDINATOR.getByName(`repository:${capability.repositoryId}`).getMission(capability.missionId);
  if (!mission || mission.epoch !== capability.epoch || mission.candidateSha !== capability.candidateSha || !LIVE_STATUSES.includes(mission.status)) return new Response('This candidate preview is no longer current.', { status: 410 });
  const isolation = capability.isolated ? 'origin' : 'sandbox';
  if (request.headers.get('X-Gitflare-Preview-Validate') === '1') return new Response(null, { status: 204, headers: { [PREVIEW_ISOLATION_HEADER]: isolation } });
  const headers = new Headers(request.headers);
  for (const name of ['Authorization', 'Cookie', 'X-Gitflare-Preview', 'X-Gitflare-Preview-Validate', PREVIEW_ISOLATION_HEADER]) headers.delete(name);
  const sandbox = env.SANDBOX.getByName(capability.sandboxName);
  const forwarded = new Request(request, { headers });
  const response = isWebSocketUpgrade(request) ? await sandbox.fetch(forwarded) : await sandbox.preview(forwarded);
  const safeHeaders = new Headers(response.headers);
  safeHeaders.delete('Set-Cookie');
  safeHeaders.set(PREVIEW_ISOLATION_HEADER, isolation);
  if (response.webSocket) return new Response(null, { status: 101, webSocket: response.webSocket, headers: safeHeaders });
  safeHeaders.set('Cache-Control', 'no-store');
  safeHeaders.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: safeHeaders });
}
