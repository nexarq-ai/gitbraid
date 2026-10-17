import { ApiError } from './domain';

export const PREVIEW_LIFETIME_CHOICES = [15, 60, 240, 1440] as const;
export type PreviewLifetimeMinutes = typeof PREVIEW_LIFETIME_CHOICES[number];
export type PreviewAccessMode = 'link' | 'cloudflare-access';
export const DEFAULT_PREVIEW_LIFETIME_MINUTES: PreviewLifetimeMinutes = 15;
export const DEFAULT_PREVIEW_MAX_LIFETIME_MINUTES = 1440;
const MAX_EMAIL_DOMAINS = 20;
export const MAX_PREVIEW_EMAIL_RECIPIENTS = 50;
const workerNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface PreviewSettings {
  lifetimeMinutes: PreviewLifetimeMinutes;
  access: PreviewAccessMode;
  accessEmailDomains: string[];
  previewEmailRecipients: string[];
  targetWorker?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface PreviewSettingsEnv { PREVIEW_MAX_LIFETIME_MINUTES?: string }

export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = { lifetimeMinutes: DEFAULT_PREVIEW_LIFETIME_MINUTES, access: 'link', accessEmailDomains: [], previewEmailRecipients: [] };

export function previewMaxLifetimeMinutes(env: PreviewSettingsEnv): number {
  const raw = env.PREVIEW_MAX_LIFETIME_MINUTES?.trim();
  if (!raw) return DEFAULT_PREVIEW_MAX_LIFETIME_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEW_MAX_LIFETIME_MINUTES must be a whole number of minutes.');
  return Math.min(value, DEFAULT_PREVIEW_MAX_LIFETIME_MINUTES);
}

export function storedPreviewSettings(value: Partial<PreviewSettings> | undefined): PreviewSettings {
  return { ...DEFAULT_PREVIEW_SETTINGS, ...(value ?? {}), accessEmailDomains: value?.accessEmailDomains ?? [], previewEmailRecipients: value?.previewEmailRecipients ?? [] };
}

export function effectiveLifetimeMinutes(settings: Pick<PreviewSettings, 'lifetimeMinutes'>, env: PreviewSettingsEnv): number {
  return Math.min(settings.lifetimeMinutes, previewMaxLifetimeMinutes(env));
}

export function previewLifetimeMs(settings: Pick<PreviewSettings, 'lifetimeMinutes'>, env: PreviewSettingsEnv): number {
  return effectiveLifetimeMinutes(settings, env) * 60_000;
}

export function lifetimeChoices(env: PreviewSettingsEnv): PreviewLifetimeMinutes[] {
  const cap = previewMaxLifetimeMinutes(env);
  const allowed = PREVIEW_LIFETIME_CHOICES.filter((minutes) => minutes <= cap);
  return allowed.length ? allowed : [DEFAULT_PREVIEW_LIFETIME_MINUTES];
}

function emailDomains(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EMAIL_DOMAINS) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', `List at most ${MAX_EMAIL_DOMAINS} email domains.`);
  const domains = value.map((item) => typeof item === 'string' ? item.trim().toLowerCase().replace(/^@/, '') : '');
  const invalid = domains.find((domain) => !domainPattern.test(domain));
  if (invalid !== undefined) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', `${invalid || 'An empty value'} is not an email domain such as example.com.`);
  return [...new Set(domains)];
}

// Cloudflare send_email bindings restrict recipients only by exact address (allowed_destination_addresses)
function emailRecipients(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PREVIEW_EMAIL_RECIPIENTS) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', `List at most ${MAX_PREVIEW_EMAIL_RECIPIENTS} preview email recipients.`);
  const addresses = value.map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '');
  const domainOnly = addresses.find((address) => address.startsWith('@') || domainPattern.test(address));
  if (domainOnly !== undefined) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', `${domainOnly} is a domain. Cloudflare send_email bindings can only be restricted to exact addresses, so list each preview email recipient such as person@example.com.`);
  const invalid = addresses.find((address) => address.length > 254 || !emailPattern.test(address));
  if (invalid !== undefined) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', `${invalid || 'An empty value'} is not an email address such as person@example.com.`);
  return [...new Set(addresses)];
}

export function normalizePreviewSettings(body: Record<string, unknown>, current: PreviewSettings, env: PreviewSettingsEnv): Omit<PreviewSettings, 'updatedAt' | 'updatedBy'> {
  const lifetimeMinutes = body.lifetimeMinutes === undefined ? current.lifetimeMinutes : body.lifetimeMinutes;
  if (!PREVIEW_LIFETIME_CHOICES.includes(lifetimeMinutes as PreviewLifetimeMinutes)) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', `Choose a preview lifetime of ${PREVIEW_LIFETIME_CHOICES.join(', ')} minutes.`);
  const cap = previewMaxLifetimeMinutes(env);
  if ((lifetimeMinutes as number) > cap && lifetimeMinutes !== DEFAULT_PREVIEW_LIFETIME_MINUTES) throw new ApiError(400, 'PREVIEW_LIFETIME_ABOVE_LIMIT', `This installation allows previews to live at most ${cap} minutes.`);
  const access = body.access === undefined ? current.access : body.access;
  if (access !== 'link' && access !== 'cloudflare-access') throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', 'Choose preview access link or cloudflare-access.');
  const accessEmailDomains = body.accessEmailDomains === undefined ? current.accessEmailDomains : emailDomains(body.accessEmailDomains);
  const previewEmailRecipients = body.previewEmailRecipients === undefined ? current.previewEmailRecipients : emailRecipients(body.previewEmailRecipients);
  const rawTarget = body.targetWorker === undefined ? current.targetWorker : body.targetWorker;
  if (rawTarget !== undefined && rawTarget !== null && rawTarget !== '' && (typeof rawTarget !== 'string' || !workerNamePattern.test(rawTarget))) throw new ApiError(400, 'INVALID_PREVIEW_SETTINGS', 'The preview Worker must be a Worker name.');
  return { lifetimeMinutes: lifetimeMinutes as PreviewLifetimeMinutes, access, accessEmailDomains, previewEmailRecipients, ...(typeof rawTarget === 'string' && rawTarget ? { targetWorker: rawTarget } : {}) };
}
