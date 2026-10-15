import type { Principal } from './security';

export type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type RateLimitEnv = { MCP_WRITE_RATE_LIMIT?: RateLimitBinding; MCP_READ_RATE_LIMIT?: RateLimitBinding; API_RATE_LIMIT?: RateLimitBinding };
export type RateLimitName = keyof RateLimitEnv;
export type RateLimited = { limit: number; windowSeconds: number; retryAfterSeconds: number };

// Mirrored by the `ratelimits` bindings in wrangler.jsonc and distribution/wrangler.self-hosted.json; Cloudflare allows only 10 or 60 second periods
export const RATE_LIMITS: Record<RateLimitName, { namespaceId: string; limit: number; period: 10 | 60 }> = {
  MCP_WRITE_RATE_LIMIT: { namespaceId: '4101', limit: 120, period: 60 },
  MCP_READ_RATE_LIMIT: { namespaceId: '4102', limit: 100, period: 10 },
  API_RATE_LIMIT: { namespaceId: '4103', limit: 600, period: 60 },
};

export function rateSubject(principal: Principal): string {
  if (principal.credentialId) return `credential:${principal.credentialId}`;
  if (principal.sessionId) return `session:${principal.sessionId}`;
  return `user:${principal.workspaceId}:${principal.userId}`;
}

export async function consume(env: RateLimitEnv, name: RateLimitName, subject: string): Promise<RateLimited | null> {
  const binding = env[name];
  if (!binding) return null;
  const { success } = await binding.limit({ key: subject });
  if (success) return null;
  const { limit, period } = RATE_LIMITS[name];
  return { limit, windowSeconds: period, retryAfterSeconds: period };
}

export function rateLimitMessage(limited: RateLimited, scope: string): string {
  return `Too many ${scope}: this connection allows ${limited.limit} every ${limited.windowSeconds} seconds. Wait ${limited.retryAfterSeconds} seconds before retrying.`;
}

export function rateLimitedResponse(limited: RateLimited, scope: string): Response {
  return Response.json({ error: { code: 'RATE_LIMITED', message: rateLimitMessage(limited, scope), ...limited } }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } });
}
