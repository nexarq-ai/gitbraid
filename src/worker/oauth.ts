import OAuthProvider, { AuthorizationError, getOAuthApi, OAuthError, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import type { AppEnv } from './env';
import { ApiError, publicError } from './domain';
import type { Principal } from './security';
import { ACCESS_HEADER, ACCESS_LABELS, ACCESS_LEVELS, accessFromScopes, allows, CLIENT_ACCESS_TOKEN_SECONDS, CLIENT_GRANT_SECONDS, grantedScopes, isAccessLevel, SUPPORTED_SCOPES } from './client-access';

type Authenticate = (request: Request, env: AppEnv, bearerOnly?: boolean) => Promise<Principal>;
type Handler = { fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> };
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const signedOut = (error: unknown) => [401, 403].includes(publicError(error).status);

function page(body: string, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Gitflare</title><style>body{margin:0;background:#f7f8fa;color:#1d2025;font:16px/1.6 system-ui,sans-serif}main{max-width:520px;margin:10vh auto;padding:36px;background:white;border:1px solid #e3e5e8;border-radius:12px}h1{font-size:26px;line-height:1.3}button,.button{display:inline-block;padding:10px 18px;border:1px solid #bbb;border-radius:6px;background:white;color:inherit;font:inherit;cursor:pointer;text-decoration:none}button[value=approve]{background:#161719;color:white;border-color:#161719}label{display:block;margin:12px 0}fieldset{border:1px solid #e3e5e8;border-radius:8px;margin:20px 0;padding:8px 16px}legend{font-weight:600;padding:0 4px}label small{display:block;margin-left:24px}small{color:#555}strong{overflow-wrap:anywhere}@media(max-width:560px){main{margin:24px 16px;padding:24px}}</style><main><small>GITFLARE · CONNECT MCP</small>${body}</main></html>`, { headers });
}

function sameSiteHop(request: Request): Response {
  const url = new URL(request.url);
  const target = escape(`${url.pathname}${url.search}`);
  return page(`<meta http-equiv="refresh" content="0;url=${target}"><h1>Checking your Gitflare sign-in…</h1><p><a class="button" href="${target}">Continue</a></p>`);
}

function accessChoices(ceiling: (typeof ACCESS_LEVELS)[number]): string {
  return ACCESS_LEVELS.filter(level => allows(ceiling, level)).map(level => `<label><input type="radio" name="access" value="${level}"${level === ceiling ? ' checked' : ''} required> ${ACCESS_LABELS[level].title}<small>${ACCESS_LABELS[level].detail}</small></label>`).join('');
}

export async function oauthConsent(request: Request, env: AppEnv, authenticate: Authenticate): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new ApiError(503, 'OAUTH_NOT_CONFIGURED', 'MCP browser authorization is not configured.');
  let principal: Principal;
  try { principal = await authenticate(request, env); } catch (error) {
    if (publicError(error).status !== 401 || request.method !== 'GET') throw error;
    await oauth.parseAuthRequest(request);
    // SameSite=Strict session cookies are withheld on cross-site navigations; a same-origin reload sends them
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return sameSiteHop(request);
    return page('<h1>Sign in to connect</h1><p>Sign in to Gitflare in another tab, then return here to review the connection.</p><p><a class="button" href="/signin" target="_blank" rel="noopener">Sign in</a></p><p><a href="">Continue after signing in</a></p>');
  }
  if (principal.credentialId) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Task credentials cannot authorize personal AI clients.');
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') throw new ApiError(400, 'PKCE_REQUIRED', 'This client must use OAuth PKCE with S256.');
      const details = await oauth.describeConsent(authRequest);
      const transaction = await oauth.beginConsent(authRequest);
      const workspace = await env.GITFLARE_SECURITY.getByName('security').workspace(principal);
      const ceiling = accessFromScopes(authRequest.scope) ?? 'admin';
      return page(`<h1>Connect ${escape(details.clientName)}?</h1><p>${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'This client’s name is self-reported and has not been verified.'}</p><p>Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? '<p>Only continue if you started this connection from an app on your computer.</p>' : ''}<p>Workspace: <strong>${escape(workspace.name)}</strong><br>Role: <strong>${escape(principal.role)}</strong></p><form method="post"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><fieldset><legend>Allow this client to</legend>${accessChoices(ceiling)}</fieldset><p><small>Your workspace role still limits every action. The connection lasts up to 30 days of use and ends when you revoke its session in Settings → Access → Account, or when your membership changes.</small></p><button name="decision" value="approve">Allow connection</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form>`, transaction.headers);
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'ORIGIN_REJECTED', 'Submit authorization from this Gitflare installation.');
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new ApiError(415, 'INVALID_CONTENT_TYPE', 'Use the authorization form.');
    const encoded = await request.text();
    if (encoded.length > 8192) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The authorization form is too large.');
    const form = new URLSearchParams(encoded);
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const access = form.get('access');
    if (!isAccessLevel(access) || !allows(accessFromScopes(approved.request.scope) ?? 'admin', access)) return page('<h1>Connection could not continue</h1><p>Choose one of the offered access levels.</p><p>Restart the connection from your AI client.</p>');
    const scope = grantedScopes(access);
    const client = (await oauth.lookupClient(approved.request.clientId))?.clientName?.trim() || approved.request.clientId;
    const service = env.GITFLARE_SECURITY.getByName('security');
    const session = principal.bootstrap ? { token: await service.legacySession(), session: undefined } : await service.clientSession(principal, client, CLIENT_GRANT_SECONDS * 1000);
    if (!session || typeof session.token !== 'string') throw new ApiError(503, 'SESSION_FAILED', 'The client session could not be created.');
    const { redirectTo } = await oauth.completeAuthorization({ request: { ...approved.request, scope }, userId: principal.userId, metadata: { workspaceId: principal.workspaceId, sessionId: session.session?.id, client, access }, scope, props: { token: session.token, workspaceId: principal.workspaceId } });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return page(`<h1>Connection could not continue</h1><p>${escape(error.description)}</p><p>Restart the connection from your AI client.</p>`);
    throw error;
  }
}

function providerOptions(origin: string, handler: Handler, authenticate: Authenticate): OAuthProviderOptions<AppEnv> {
  return {
    apiRoute: '/mcp',
    apiHandler: { async fetch(request, env, ctx) {
      const props = ctx.props as { token?: unknown; workspaceId?: unknown; external?: unknown };
      if (typeof props.token !== 'string' || typeof props.workspaceId !== 'string') throw new ApiError(401, 'AUTH_REQUIRED', 'Reconnect your client.');
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${props.token}`);
      headers.set('X-Gitflare-Workspace', props.workspaceId);
      headers.delete('Cookie');
      if (props.external === true) headers.delete(ACCESS_HEADER);
      else headers.set(ACCESS_HEADER, accessFromScopes((ctx as { auth?: { scope?: string[] } }).auth?.scope ?? []) ?? 'read');
      return handler.fetch(new Request(request, { headers }), env, ctx);
    } },
    defaultHandler: handler,
    authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: SUPPORTED_SCOPES, requiredScopes: grantedScopes('admin'),
    accessTokenTTL: CLIENT_ACCESS_TOKEN_SECONDS, refreshTokenTTL: CLIENT_GRANT_SECONDS,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Gitflare', authorization_servers: [origin] },
    async tokenExchangeCallback({ grantType, props, env }) {
      if (grantType !== 'refresh_token') return;
      const { token, workspaceId } = (props ?? {}) as { token?: unknown; workspaceId?: unknown };
      if (typeof token !== 'string') throw new OAuthError('invalid_grant', { description: 'Reconnect the client.' });
      try { await env.GITFLARE_SECURITY.getByName('security').authenticate(token, typeof workspaceId === 'string' ? workspaceId : undefined); }
      catch (error) { if (signedOut(error)) throw new OAuthError('invalid_grant', { description: 'This connection was revoked or expired. Reconnect the client.' }); throw error; }
    },
    async resolveExternalToken({ token, request, env }) {
      try { const principal = await authenticate(request, env, true); return { props: { token, workspaceId: principal.workspaceId, external: true }, audience: `${origin}/mcp` }; }
      catch (error) { if (signedOut(error)) return null; throw error; }
    },
  };
}

export function oauthProvider(origin: string, handler: Handler, authenticate: Authenticate) {
  return new OAuthProvider<AppEnv>(providerOptions(origin, handler, authenticate));
}

export async function revokeClientGrants(env: AppEnv, origin: string, handler: Handler, authenticate: Authenticate, userId: string, sessionId: string): Promise<number> {
  if (!env.OAUTH_KV) return 0;
  const helpers = getOAuthApi(providerOptions(origin, handler, authenticate), env);
  let cursor: string | undefined; let revoked = 0;
  do {
    const listing = await helpers.listUserGrants(userId, { limit: 100, cursor });
    for (const grant of listing.items) if ((grant.metadata as { sessionId?: unknown } | null)?.sessionId === sessionId) { await helpers.revokeGrant(grant.id, userId); revoked++; }
    cursor = listing.cursor;
  } while (cursor);
  return revoked;
}

export type { OAuthHelpers };
