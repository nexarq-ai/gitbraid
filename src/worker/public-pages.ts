import type { AppEnv } from './env';
export const ROBOTS_TXT = 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mcp\nDisallow: /oauth/\n';
export function publicPageResponse(request: Request, _env: AppEnv): Response | null { return ['GET', 'HEAD'].includes(request.method) && new URL(request.url).pathname === '/robots.txt' ? new Response(request.method === 'HEAD' ? null : ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }) : null; }
