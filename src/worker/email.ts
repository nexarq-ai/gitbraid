export interface InvitationEmailEnv { EMAIL?: SendEmail; EMAIL_FROM?: string }
export interface InvitationEmailInput { email: string; token: string; workspaceName: string; origin: string }
export type InvitationDelivery = { status: 'sent'; messageId: string } | { status: 'unconfigured' | 'error'; code: string; message: string };

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function validEmail(value: string): boolean { return value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value); }
type Message = { subject: string; text: string; html: string };
const DELIVERY_FAILURE_CODES = ['E_SENDER_NOT_VERIFIED','E_SENDER_DOMAIN_NOT_AVAILABLE','E_RECIPIENT_NOT_ALLOWED','E_RECIPIENT_SUPPRESSED','E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED','E_DELIVERY_FAILED'];
export function emailConfigured(env: InvitationEmailEnv): boolean { return !!env.EMAIL && !!env.EMAIL_FROM; }
async function deliver(env: InvitationEmailEnv, input: { email: string; token: string; origin: string }, route: string, compose: (link: string) => Message, wording: { unconfigured: string; prepare: string; origin: string; insecure: string; rejected: string }): Promise<InvitationDelivery> {
  if (!env.EMAIL || !env.EMAIL_FROM) return { status: 'unconfigured', code: 'EMAIL_NOT_CONFIGURED', message: wording.unconfigured };
  if (!validEmail(env.EMAIL_FROM) || !validEmail(input.email) || !/^[a-f0-9]{64}$/i.test(input.token)) return { status: 'error', code: 'INVALID_EMAIL_INPUT', message: wording.prepare };
  let origin: URL;
  try { origin = new URL(input.origin); } catch { return { status: 'error', code: 'INVALID_INVITATION_ORIGIN', message: wording.origin }; }
  if (origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) return { status: 'error', code: 'INVALID_INVITATION_ORIGIN', message: wording.insecure };
  try {
    const result = await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: 'Gitflare' }, to: input.email, ...compose(`${origin.origin}/${route}${encodeURIComponent(input.token)}`) });
    return { status: 'sent', messageId: result.messageId };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error && DELIVERY_FAILURE_CODES.includes(String(error.code)) ? String(error.code) : 'EMAIL_SEND_FAILED';
    return { status: 'error', code, message: wording.rejected };
  }
}
export function deliverInvitation(env: InvitationEmailEnv, input: InvitationEmailInput): Promise<InvitationDelivery> {
  const workspaceName = input.workspaceName.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100);
  return deliver(env, input, 'invite#token=', link => ({
    subject: `Invitation to ${workspaceName}`,
    text: `You have been invited to ${workspaceName} on Gitflare.\n\nAccept your invitation: ${link}\n\nThis invitation expires after 24 hours and can only be used once. Sign in or register with ${input.email}. If you were not expecting this invitation, you can ignore this email.`,
    html: `<h1>You’re invited to Gitflare</h1><p>Join ${escapeHtml(workspaceName)}.</p><p><a href="${escapeHtml(link)}">Accept invitation</a></p><p>This invitation expires after 24 hours and can only be used once. Sign in or register with ${escapeHtml(input.email)}.</p><p>If you were not expecting this invitation, you can ignore this email.</p>`,
  }), { unconfigured: 'The invitation is ready. This installation has no email sender configured.', prepare: 'The invitation email could not be prepared.', origin: 'The invitation link origin is invalid.', insecure: 'The invitation link needs a secure application origin.', rejected: 'The invitation is ready, but the email service did not accept delivery. You can share the invitation securely or retry with a new invitation.' });
}
export interface AccountEmailInput { email: string; token: string; origin: string }
const accountWording = { unconfigured: 'This installation has no email sender configured.', prepare: 'The email could not be prepared.', origin: 'The link origin is invalid.', insecure: 'The link needs a secure application origin.', rejected: 'The email service did not accept delivery.' };
export function deliverVerification(env: InvitationEmailEnv, input: AccountEmailInput): Promise<InvitationDelivery> {
  return deliver(env, input, 'verify-email#', link => ({
    subject: 'Verify your Gitflare email address',
    text: `Confirm that ${input.email} belongs to you: ${link}\n\nThis link expires after 24 hours and can only be used once. If you did not create a Gitflare account, you can ignore this email.`,
    html: `<h1>Verify your email address</h1><p>Confirm that ${escapeHtml(input.email)} belongs to you.</p><p><a href="${escapeHtml(link)}">Verify email address</a></p><p>This link expires after 24 hours and can only be used once. If you did not create a Gitflare account, you can ignore this email.</p>`,
  }), accountWording);
}
export function deliverPasswordReset(env: InvitationEmailEnv, input: AccountEmailInput): Promise<InvitationDelivery> {
  return deliver(env, input, 'reset-password#', link => ({
    subject: 'Reset your Gitflare password',
    text: `Choose a new password for ${input.email}: ${link}\n\nThis link expires after 1 hour and can only be used once. Choosing a new password signs out every session. If you did not ask for this, you can ignore this email and your password stays the same.`,
    html: `<h1>Reset your password</h1><p>Choose a new password for ${escapeHtml(input.email)}.</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>This link expires after 1 hour and can only be used once. Choosing a new password signs out every session.</p><p>If you did not ask for this, you can ignore this email and your password stays the same.</p>`,
  }), accountWording);
}
