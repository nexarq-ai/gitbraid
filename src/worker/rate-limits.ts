import type { Principal } from './security';

export type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type RateLimitEnv = { MCP_WRITE_RATE_LIMIT?: RateLimitBinding; MCP_READ_RATE_LIMIT?: RateLimitBinding; API_RATE_LIMIT?: RateLimitBinding; GIT_RATE_LIMIT?: RateLimitBinding; GIT_AUTH_FAILURE_RATE_LIMIT?: RateLimitBinding };
export type RateLimitName = keyof RateLimitEnv;
export type RateLimited = { limit: number; windowSeconds: number; retryAfterSeconds: number };

// Mirrored by the `ratelimits` bindings in wrangler.jsonc and distribution/wrangler.self-hosted.json; Cloudflare allows only 10 or 60 second periods
export const RATE_LIMITS: Record<RateLimitName, { namespaceId: string; limit: number; period: 10 | 60 }> = {
  MCP_WRITE_RATE_LIMIT: { namespaceId: '4101', limit: 120, period: 60 },
  MCP_READ_RATE_LIMIT: { namespaceId: '4102', limit: 100, period: 10 },
  API_RATE_LIMIT: { namespaceId: '4103', limit: 600, period: 60 },
  GIT_RATE_LIMIT: { namespaceId: '4104', limit: 600, period: 60 },
  GIT_AUTH_FAILURE_RATE_LIMIT: { namespaceId: '4105', limit: 20, period: 60 },
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

export interface GitRateLimits {
  blocked(client: string): RateLimited | null;
  failure(client: string): Promise<RateLimited | null>;
  credential(principal: Principal): Promise<RateLimited | null>;
}

const GIT_BLOCKS_MAX = 10_000;

// The binding has no read-only check, so a tripped address is remembered per isolate to refuse it before any token lookup
export function gitRateLimits(env: RateLimitEnv, blocks: Map<string, number>, now: () => number = Date.now): GitRateLimits {
  return {
    blocked(client) {
      const until = blocks.get(client);
      if (until === undefined) return null;
      const remaining = Math.ceil((until - now()) / 1000);
      if (remaining <= 0) { blocks.delete(client); return null; }
      const { limit, period } = RATE_LIMITS.GIT_AUTH_FAILURE_RATE_LIMIT;
      return { limit, windowSeconds: period, retryAfterSeconds: remaining };
    },
    async failure(client) {
      const limited = await consume(env, 'GIT_AUTH_FAILURE_RATE_LIMIT', `ip:${client}`);
      if (limited) {
        if (blocks.size >= GIT_BLOCKS_MAX) blocks.clear();
        blocks.set(client, now() + limited.retryAfterSeconds * 1000);
      }
      return limited;
    },
    credential: principal => consume(env, 'GIT_RATE_LIMIT', rateSubject(principal)),
  };
}
