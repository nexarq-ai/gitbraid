import { ApiError, assertMutationOrigin, readJson } from './domain';
import { deliverPasswordReset, deliverVerification, emailConfigured, type InvitationDelivery } from './email';
import type { AppEnv } from './env';
import { handleHostedOnboarding, type AuthenticateRequest } from './hosted-onboarding';

function authenticatedResponse(result: { token: string; user: unknown; workspaceId: string; recoveryCodes?: string[] }): Response {
  const { token, ...body } = result;
  return Response.json({ ok: true, ...body }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': `gitflare_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` } });
}
const noStore = { headers: { 'Cache-Control': 'no-store' } };
const RESET_REQUESTED = { ok: true, message: 'If an account exists for that address, a password reset link is on its way.' };
type Verification = { status: InvitationDelivery['status']; code?: string };
function requireEmail(env: AppEnv) { if (!emailConfigured(env)) throw new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'This installation has no email sender configured, so account email cannot be sent.'); }
async function sendVerification(env: AppEnv, email: string, token: string, origin: string): Promise<Verification> {
  const delivery = await deliverVerification(env, { email, token, origin });
  return delivery.status === 'sent' ? { status: 'sent' } : { status: delivery.status, code: delivery.code };
}
async function withVerification<T extends { verificationToken: string; user: { email: string } }>(env: AppEnv, result: T, origin: string): Promise<Omit<T, 'verificationToken'> & { verification: Verification }> {
  const { verificationToken, ...rest } = result;
  return { ...rest, verification: await sendVerification(env, result.user.email, verificationToken, origin) };
}
export async function signupWithVerification(env: AppEnv, body: Record<string, unknown>, origin: string) {
  return withVerification(env, await env.GITFLARE_SECURITY.getByName('security').signup(body), origin);
}
async function handleAccountEmail(request: Request, env: AppEnv, authenticate: AuthenticateRequest): Promise<Response | null> {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method !== 'POST' || !['/api/auth/verify-email', '/api/auth/resend-verification', '/api/auth/password-reset/request', '/api/auth/password-reset/confirm'].includes(path)) return null;
  assertMutationOrigin(request);
  const service = env.GITFLARE_SECURITY.getByName('security');
  await service.rateLimit(`account-email:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 10, 900000);
  const body = await readJson(request);
  if (path === '/api/auth/verify-email') return Response.json(await service.verifyEmail(body), noStore);
  if (path === '/api/auth/password-reset/confirm') return Response.json(await service.confirmPasswordReset(body), noStore);
  if (path === '/api/auth/resend-verification') {
    const principal = await authenticate(request, env);
    requireEmail(env);
    const pending = await service.resendVerification(principal);
    const delivery = await sendVerification(env, pending.email, pending.token, url.origin);
    if (delivery.status !== 'sent') throw new ApiError(502, delivery.code ?? 'EMAIL_SEND_FAILED', 'The email service did not accept the verification email. Try again later.');
    return Response.json({ ok: true }, noStore);
  }
  requireEmail(env);
  const pending = await service.requestPasswordReset(body);
  if (pending) await deliverPasswordReset(env, { ...pending, origin: url.origin });
  return Response.json(RESET_REQUESTED, noStore);
}
export async function handleOnboarding(request: Request, env: AppEnv, authenticate: AuthenticateRequest): Promise<Response | null> {
  const path = new URL(request.url).pathname; const service = env.GITFLARE_SECURITY.getByName('security');
  if (path === '/api/auth/config' && request.method === 'GET') return Response.json({ ...await service.authConfig(), passwordReset: emailConfigured(env), emailVerification: env.EDITION !== 'self-hosted' && emailConfigured(env) }, noStore);
  const account = await handleAccountEmail(request, env, authenticate);
  if (account) return account;
  if (request.method !== 'POST' || !['/api/setup/start', '/api/setup/verify', '/api/mfa/verify', '/api/mfa/enroll', '/api/users/create', '/api/invitations/register'].includes(path)) return handleHostedOnboarding(request, env, authenticate);
  assertMutationOrigin(request);
  await service.rateLimit(`onboarding:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
  const body = await readJson(request);
  if (path === '/api/setup/start') return Response.json(await service.startSetup(body), { headers: { 'Cache-Control': 'no-store' } });
  if (path === '/api/setup/verify' || path === '/api/mfa/verify') return authenticatedResponse(await service.verifyMfa(body, path === '/api/setup/verify'));
  if (path === '/api/invitations/register') { const result = await service.registerInvitedUser(body); return 'token' in result ? authenticatedResponse(await withVerification(env, result, new URL(request.url).origin)) : Response.json(result, { headers: { 'Cache-Control': 'no-store' } }); }
  const principal = await authenticate(request, env);
  if (path === '/api/mfa/enroll') return Response.json(await service.enrollMfa(principal), { headers: { 'Cache-Control': 'no-store' } });
  return Response.json(await service.createInstallationUser(principal, body), { headers: { 'Cache-Control': 'no-store' } });
}
