import { ApiError } from './domain';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();
export function randomCapability(bytes = 32): string { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }
export function mfaSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0; let value = 0; let result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
  return result;
}
function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const digit = alphabet.indexOf(character); if (digit < 0) throw new ApiError(400, 'INVALID_MFA_SECRET', 'Authenticator secret is invalid.');
    value = (value << 5) | digit; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return new Uint8Array(bytes);
}
export async function totpCode(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', decodeSecret(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new ArrayBuffer(8); new DataView(counter).setBigUint64(0, BigInt(step));
  const result = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter)); const offset = result[result.length - 1] & 15;
  const value = ((result[offset] & 127) << 24) | (result[offset + 1] << 16) | (result[offset + 2] << 8) | result[offset + 3];
  return (value % 1000000).toString().padStart(6, '0');
}
export async function verifyTotp(secret: string, code: string, now: number, lastStep = -1): Promise<number | undefined> {
  if (!/^\d{6}$/.test(code)) return;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) if (step > lastStep && step >= 0 && await totpCode(secret, step) === code) return step;
}
async function encryptionKey(value?: string): Promise<CryptoKey> {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', 'Configure a 256-bit authentication encryption key.');
  const bytes = new Uint8Array(value.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptAuth(value: string, key: string | undefined, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await encryptionKey(key), encoder.encode(value)));
  return Array.from(new Uint8Array([...iv, ...encrypted]), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function decryptAuth(value: string, key: string | undefined, context: string): Promise<string> {
  const bytes = new Uint8Array(value.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) ?? []);
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(context) }, await encryptionKey(key), bytes.slice(12))); }
  catch { throw new ApiError(503, 'AUTH_ENCRYPTION_FAILED', 'Authentication data could not be decrypted with the configured key.'); }
}
export function authenticatorUri(secret: string, email: string): string {
  return `otpauth://totp/${encodeURIComponent(`Gitflare:${email}`)}?secret=${secret}&issuer=Gitflare&algorithm=SHA1&digits=6&period=30`;
}
