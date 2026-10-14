import OAuthProvider, { AuthorizationError, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { AppEnv } from './env';
import { ApiError } from './domain';
import type { Principal } from './security';

type Authenticate = (request: Request, env: AppEnv, bearerOnly?: boolean) => Promise<Principal>;
type Handler = { fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> };
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

function page(body: string, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Gitflare</title><style>body{margin:0;background:#f7f8fa;color:#1d2025;font:16px/1.6 system-ui,sans-serif}main{max-width:480px;margin:10vh auto;padding:36px;background:white;border:1px solid #e3e5e8;border-radius:12px}h1{font-size:26px;line-height:1.3}button,.button{display:inline-block;padding:10px 18px;border:1px solid #bbb;border-radius:6px;background:white;color:inherit;font:inherit;cursor:pointer;text-decoration:none}button[value=approve]{background:#161719;color:white;border-color:#161719}label{display:block;margin:16px 0}small{color:#555}strong{overflow-wrap:anywhere}@media(max-width:560px){main{margin:24px 16px;padding:24px}}</style><main><small>GITFLARE · CONNECT MCP</small>${body}</main></html>`, { headers });
}

export async function oauthConsent(request: Request, env: AppEnv, authenticate: Authenticate): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new ApiError(503, 'OAUTH_NOT_CONFIGURED', 'MCP browser authorization is not configured.');
  let principal: Principal;
  try { principal = await authenticate(request, env); } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    if (request.method !== 'GET') throw error;
    await oauth.parseAuthRequest(request);
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
      return page(`<h1>Connect ${escape(details.clientName)}?</h1><p>${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'This client’s name is self-reported and has not been verified.'}</p><p>Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? '<p>Only continue if you started this connection from an app on your computer.</p>' : ''}<p>Workspace: <strong>${escape(workspace.name)}</strong><br>Role: <strong>${escape(principal.role)}</strong></p><p>The client can use your current workspace permissions, including changes and approvals if your role allows them. Permission changes and session revocation take effect on subsequent requests. Reconnect after eight hours.</p><form method="post"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><label><input type="checkbox" name="scope" value="gitflare" checked required> Access this Gitflare workspace</label><button name="decision" value="approve">Allow connection</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form>`, transaction.headers);
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
    const approved = await oauth.approveConsent(request, handle, { scope: ['gitflare'] });
    const service = env.GITFLARE_SECURITY.getByName('security');
    const session = principal.bootstrap ? { token: await service.legacySession() } : await service.action(principal, 'session-create', {});
    if (!session || typeof session !== 'object' || !('token' in session) || typeof session.token !== 'string') throw new ApiError(503, 'SESSION_FAILED', 'The client session could not be created.');
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: principal.userId, metadata: { workspaceId: principal.workspaceId }, scope: ['gitflare'], props: { token: session.token, workspaceId: principal.workspaceId } });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return page(`<h1>Connection could not continue</h1><p>${escape(error.description)}</p><p>Restart the connection from your AI client.</p>`);
    throw error;
  }
}

export function oauthProvider(origin: string, handler: Handler, authenticate: Authenticate) {
  return new OAuthProvider<AppEnv>({
    apiRoute: '/mcp',
    apiHandler: { async fetch(request, env, ctx) {
      const props = ctx.props as { token?: unknown; workspaceId?: unknown };
      if (typeof props.token !== 'string' || typeof props.workspaceId !== 'string') throw new ApiError(401, 'AUTH_REQUIRED', 'Reconnect your client.');
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${props.token}`);
      headers.set('X-Gitflare-Workspace', props.workspaceId);
      headers.delete('Cookie');
      return handler.fetch(new Request(request, { headers }), env, ctx);
    } },
    defaultHandler: handler,
    authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['gitflare'], requiredScopes: ['gitflare'], accessTokenTTL: 3600, refreshTokenTTL: 28800,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Gitflare', authorization_servers: [origin] },
    async resolveExternalToken({ token, request, env }) {
      try { const principal = await authenticate(request, env, true); return { props: { token, workspaceId: principal.workspaceId }, audience: `${origin}/mcp` }; }
      catch (error) { if (error instanceof ApiError && [401, 403].includes(error.status)) return null; throw error; }
    },
  });
}

export type { OAuthHelpers };
