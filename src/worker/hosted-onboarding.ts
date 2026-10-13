import type { AppEnv } from './env';
import type { Principal } from './security';
export type AuthenticateRequest = (request: Request, env: AppEnv) => Promise<Principal>;
export async function handleHostedOnboarding(_request: Request, _env: AppEnv, _authenticate: AuthenticateRequest): Promise<Response | null> { return null; }
