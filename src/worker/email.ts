export interface InvitationEmailEnv { EMAIL?: SendEmail; EMAIL_FROM?: string }
export interface InvitationEmailInput { email: string; token: string; workspaceName: string; origin: string }
export type InvitationDelivery = { status: 'sent'; messageId: string } | { status: 'unconfigured' | 'error'; code: string; message: string };

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function validEmail(value: string): boolean { return value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value); }
export async function deliverInvitation(env: InvitationEmailEnv, input: InvitationEmailInput): Promise<InvitationDelivery> {
  if (!env.EMAIL || !env.EMAIL_FROM) return { status: 'unconfigured', code: 'EMAIL_NOT_CONFIGURED', message: 'The invitation is ready. This installation has no email sender configured.' };
  if (!validEmail(env.EMAIL_FROM) || !validEmail(input.email) || !/^[a-f0-9]{64}$/i.test(input.token)) return { status: 'error', code: 'INVALID_EMAIL_INPUT', message: 'The invitation email could not be prepared.' };
  let origin: URL;
  try { origin = new URL(input.origin); } catch { return { status: 'error', code: 'INVALID_INVITATION_ORIGIN', message: 'The invitation link origin is invalid.' }; }
  if (origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) return { status: 'error', code: 'INVALID_INVITATION_ORIGIN', message: 'The invitation link needs a secure application origin.' };
  const link = `${origin.origin}/#invite?token=${encodeURIComponent(input.token)}`;
  const workspaceName = input.workspaceName.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100);
  try {
    const result = await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: 'Gitflare' }, to: input.email, subject: `Invitation to ${workspaceName}`,
      text: `You have been invited to ${workspaceName} on Gitflare.\n\nAccept your invitation: ${link}\n\nThis invitation expires after 24 hours and can only be used once. Sign in or register with ${input.email}. If you were not expecting this invitation, you can ignore this email.`,
      html: `<h1>You’re invited to Gitflare</h1><p>Join ${escapeHtml(workspaceName)}.</p><p><a href="${escapeHtml(link)}">Accept invitation</a></p><p>This invitation expires after 24 hours and can only be used once. Sign in or register with ${escapeHtml(input.email)}.</p><p>If you were not expecting this invitation, you can ignore this email.</p>`,
    });
    return { status: 'sent', messageId: result.messageId };
  } catch (error) {
    const knownCodes = ['E_SENDER_NOT_VERIFIED','E_SENDER_DOMAIN_NOT_AVAILABLE','E_RECIPIENT_NOT_ALLOWED','E_RECIPIENT_SUPPRESSED','E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED','E_DELIVERY_FAILED'];
    const code = typeof error === 'object' && error && 'code' in error && knownCodes.includes(String(error.code)) ? String(error.code) : 'EMAIL_SEND_FAILED';
    return { status: 'error', code, message: 'The invitation is ready, but the email service did not accept delivery. You can share the invitation securely or retry with a new invitation.' };
  }
}
