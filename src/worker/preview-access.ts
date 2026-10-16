import { ApiError } from './domain';
import type { CloudflareCall } from './cloudflare-deploy';

export const ACCESS_SCOPE_MISSING_MESSAGE = 'Needs the Access: Apps and Policies Edit permission on the OAuth client';
const MAX_EMAILS = 200;
const subdomainPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface AccessScopeEnv { CLOUDFLARE_ACCESS_SCOPES?: string }
export interface AccessScopeState { requested: boolean; granted: boolean; scopes: string[]; missing: string[] }
export interface PreviewAccessIncludes { emails: string[]; domains: string[] }
export interface PreviewAccessApp { appId: string; policyId: string; domain: string; created: boolean }

interface AccessPolicy { id?: string; name?: string }
interface AccessApp { id?: string; name?: string; domain?: string; policies?: AccessPolicy[] }

export function accessScopes(env: AccessScopeEnv): string[] {
  return [...new Set((env.CLOUDFLARE_ACCESS_SCOPES ?? '').split(/\s+/).filter((scope) => scope && scope !== 'openid'))];
}

export function accessScopeState(env: AccessScopeEnv, granted: string[] | null): AccessScopeState {
  const scopes = accessScopes(env);
  const missing = granted ? scopes.filter((scope) => !granted.includes(scope)) : scopes;
  return { requested: scopes.length > 0, granted: scopes.length > 0 && !!granted && missing.length === 0, scopes, missing };
}

export function assertAccessScope(env: AccessScopeEnv, granted: string[] | null): void {
  const state = accessScopeState(env, granted);
  if (state.granted) return;
  const detail = !state.requested
    ? 'This installation does not request a Cloudflare Access scope (CLOUDFLARE_ACCESS_SCOPES is not set).'
    : !granted ? 'Connect Cloudflare for this repository or workspace first.' : `The Cloudflare connection was not granted ${state.missing.join(', ')}; an Owner must reconnect Cloudflare.`;
  throw new ApiError(409, 'CLOUDFLARE_ACCESS_SCOPE_MISSING', `${ACCESS_SCOPE_MISSING_MESSAGE}. ${detail} Preview access stays unchanged.`);
}

export function previewAccessDomain(workerName: string, subdomain: string): string {
  return `*-${workerName}.${subdomain}.workers.dev`;
}

export function previewAccessAppName(workerName: string): string {
  return `Gitflare previews: ${workerName}`;
}

export async function workersSubdomain(call: CloudflareCall, accountId: string): Promise<string> {
  const result = await call<{ subdomain?: unknown }>(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = typeof result?.subdomain === 'string' ? result.subdomain.toLowerCase() : '';
  if (!subdomainPattern.test(subdomain)) throw new ApiError(409, 'WORKERS_SUBDOMAIN_MISSING', `Account ${accountId} has no workers.dev subdomain, so its Preview URLs cannot be protected. Set up workers.dev for the account first.`);
  return subdomain;
}

function includeRules(includes: PreviewAccessIncludes): Record<string, unknown>[] {
  const emails = [...new Set(includes.emails.map((email) => email.trim().toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))].slice(0, MAX_EMAILS);
  const rules = [...emails.map((email) => ({ email: { email } })), ...includes.domains.map((domain) => ({ email_domain: { domain } }))];
  if (!rules.length) throw new ApiError(409, 'PREVIEW_ACCESS_EMPTY', 'Cloudflare Access needs at least one workspace member email or email domain to allow.');
  return rules;
}

export async function ensurePreviewAccess(call: CloudflareCall, accountId: string, workerName: string, includes: PreviewAccessIncludes): Promise<PreviewAccessApp> {
  const domain = previewAccessDomain(workerName, await workersSubdomain(call, accountId));
  const name = previewAccessAppName(workerName);
  const policy = { name, decision: 'allow', include: includeRules(includes) };
  const apps = await call<AccessApp[]>(`/accounts/${accountId}/access/apps`, { query: { per_page: '1000' } });
  const existing = (Array.isArray(apps) ? apps : []).find((app) => app?.name === name || app?.domain === domain);
  let policyId = existing?.policies?.find((item) => item?.name === name && typeof item.id === 'string')?.id;
  if (policyId) await call(`/accounts/${accountId}/access/policies/${policyId}`, { method: 'PUT', json: policy });
  else {
    const created = await call<AccessPolicy>(`/accounts/${accountId}/access/policies`, { method: 'POST', json: policy });
    if (typeof created?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return an Access policy.');
    policyId = created.id;
  }
  const app = { name, type: 'self_hosted', domain, destinations: [{ type: 'public', uri: domain }], app_launcher_visible: false, session_duration: '24h', policies: [{ id: policyId, precedence: 1 }] };
  if (existing?.id) {
    await call(`/accounts/${accountId}/access/apps/${existing.id}`, { method: 'PUT', json: app });
    return { appId: existing.id, policyId, domain, created: false };
  }
  const created = await call<AccessApp>(`/accounts/${accountId}/access/apps`, { method: 'POST', json: app });
  if (typeof created?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return an Access application.');
  return { appId: created.id, policyId, domain, created: true };
}
