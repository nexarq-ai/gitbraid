import { assertMutationOrigin, readJson } from './domain';
import type { AppEnv } from './env';
import { handleHostedOnboarding, type AuthenticateRequest } from './hosted-onboarding';

function authenticatedResponse(result: { token: string; user: unknown; workspaceId: string; recoveryCodes?: string[] }): Response {
  const { token, ...body } = result;
  return Response.json({ ok: true, ...body }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': `gitflare_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` } });
}
export async function handleOnboarding(request: Request, env: AppEnv, authenticate: AuthenticateRequest): Promise<Response | null> {
  const path = new URL(request.url).pathname; const service = env.GITFLARE_SECURITY.getByName('security');
  if (path === '/api/auth/config' && request.method === 'GET') return Response.json(await service.authConfig(), { headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST' || !['/api/setup/start', '/api/setup/verify', '/api/mfa/verify', '/api/mfa/enroll', '/api/users/create', '/api/invitations/register'].includes(path)) return handleHostedOnboarding(request, env, authenticate);
  assertMutationOrigin(request);
  await service.rateLimit(`onboarding:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
  const body = await readJson(request);
  if (path === '/api/setup/start') return Response.json(await service.startSetup(body), { headers: { 'Cache-Control': 'no-store' } });
  if (path === '/api/setup/verify' || path === '/api/mfa/verify') return authenticatedResponse(await service.verifyMfa(body, path === '/api/setup/verify'));
  if (path === '/api/invitations/register') { const result = await service.registerInvitedUser(body); return 'token' in result ? authenticatedResponse(result) : Response.json(result, { headers: { 'Cache-Control': 'no-store' } }); }
  const principal = await authenticate(request, env);
  if (path === '/api/mfa/enroll') return Response.json(await service.enrollMfa(principal), { headers: { 'Cache-Control': 'no-store' } });
  return Response.json(await service.createInstallationUser(principal, body), { headers: { 'Cache-Control': 'no-store' } });
}
