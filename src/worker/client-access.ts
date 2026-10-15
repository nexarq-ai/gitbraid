export const ACCESS_LEVELS = ['read', 'write', 'land', 'admin'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];
export const LEGACY_SCOPE = 'gitflare';
export const ACCESS_HEADER = 'X-Gitflare-Access';
export const CLIENT_GRANT_SECONDS = 30 * 86_400;
export const CLIENT_ACCESS_TOKEN_SECONDS = 3600;

export const ACCESS_LABELS: Record<AccessLevel, { title: string; detail: string }> = {
  read: { title: 'Read only', detail: 'Browse repositories, proposals, issues, releases, checks and documentation. No changes.' },
  write: { title: 'Read and propose', detail: 'Also create repositories, proposals, issues, branches and pull requests, start or cancel agent runs, and comment or request changes.' },
  land: { title: 'Approve and land', detail: 'Also approve exact candidates, land them on the default branch, revoke approvals, publish releases and import code.' },
  admin: { title: 'Full access', detail: 'Also manage members, credentials, model connections, AI settings, branch protection and Cloudflare resources.' },
};

export function accessScope(level: AccessLevel): string { return `gitflare:${level}`; }
export const SUPPORTED_SCOPES = [...ACCESS_LEVELS.map(accessScope), LEGACY_SCOPE];
export function grantedScopes(level: AccessLevel): string[] { return ACCESS_LEVELS.slice(0, ACCESS_LEVELS.indexOf(level) + 1).map(accessScope); }
export function allows(granted: AccessLevel, required: AccessLevel): boolean { return ACCESS_LEVELS.indexOf(granted) >= ACCESS_LEVELS.indexOf(required); }
export function isAccessLevel(value: unknown): value is AccessLevel { return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value); }

export function accessFromScopes(scopes: readonly string[]): AccessLevel | null {
  if (scopes.includes(LEGACY_SCOPE)) return 'admin';
  const levels = ACCESS_LEVELS.filter(level => scopes.includes(accessScope(level)));
  return levels.length ? levels[levels.length - 1] : null;
}

export function accessFromHeader(value: string | null): AccessLevel {
  if (value === null) return 'admin';
  return isAccessLevel(value) ? value : 'read';
}
