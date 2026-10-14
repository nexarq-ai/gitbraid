import type { MissionAttachment } from '../shared/types';

export const ATTACHMENT_MAX_FILES = 5;
export const ATTACHMENT_MAX_FILE_BYTES = 16_384;
export const ATTACHMENT_MAX_TOTAL_BYTES = 49_152;

const SECRET_NAME = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials?(\..*)?|secrets?(\..*)?|\.dev\.vars|wrangler\.(toml|jsonc?)|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|crt|cer))$/i;

export function validateAttachments(value: unknown, fail: (message: string) => never): MissionAttachment[] {
  if (!Array.isArray(value)) return fail('Attachments must be a list.');
  if (value.length > ATTACHMENT_MAX_FILES) return fail(`Attach at most ${ATTACHMENT_MAX_FILES} files.`);
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let total = 0;
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('Each attachment needs a name and content.');
    const { name, content, ...extra } = item as Record<string, unknown>;
    if (Object.keys(extra).length) return fail('Attachments accept only name and content.');
    if (typeof name !== 'string' || typeof content !== 'string') return fail('Each attachment needs a text name and content.');
    if (!name || name.length > 120 || name !== name.trim() || /[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..')) return fail(`Attachment name "${name.slice(0, 60)}" is not a safe relative path.`);
    if (SECRET_NAME.test(name)) return fail(`Attachment "${name}" looks like a credential or configuration file and cannot be attached.`);
    const key = name.toLowerCase();
    if (seen.has(key)) return fail(`Attachment "${name}" is duplicated.`);
    seen.add(key);
    if (content.includes('\u0000') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(content)) return fail(`Attachment "${name}" is not plain UTF-8 text.`);
    const bytes = encoder.encode(content).length;
    if (bytes > ATTACHMENT_MAX_FILE_BYTES) return fail(`Attachment "${name}" exceeds 16 KiB.`);
    total += bytes;
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) return fail('Attachments exceed 48 KiB in total.');
    return { name, content };
  });
}
