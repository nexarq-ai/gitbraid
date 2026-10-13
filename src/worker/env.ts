import type { OAuthHelpers } from './oauth';
import type { AgentSandbox } from '../../runner/sandbox';
import type { ArtifactsBinding } from './artifacts';
import type { GitflareSecurity } from './security';
import type { GitflareCoordinator } from './coordinator';

export type AppEnv = Omit<Env, 'EDITION' | 'EMAIL_FROM' | 'OAUTH_KV' | 'GITFLARE_SECURITY' | 'APP_ENV' | 'GITFLARE_COORDINATOR' | 'ARTIFACTS' | 'SANDBOX' | 'MISSION_WORKFLOW' | 'MODEL' | 'AI' | 'AI_GATEWAY_ID' | 'TEST_COMMAND'> & {
  GITFLARE_SECURITY: DurableObjectNamespace<GitflareSecurity>;
  APP_ENV: 'local' | 'production';
  GITFLARE_COORDINATOR: DurableObjectNamespace<GitflareCoordinator>;
  OWNER_TOKEN?: string;
  EDITION?: 'hosted' | 'self-hosted';
  SETUP_TOKEN?: string;
  AUTH_ENCRYPTION_KEY?: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  ARTIFACTS?: ArtifactsBinding;
  SANDBOX?: DurableObjectNamespace<AgentSandbox>;
  MISSION_WORKFLOW?: Workflow<{ repositoryId: string; missionId: string; epoch: number }>;
  MODEL?: string;
  AI?: Ai;
  AI_GATEWAY_ID?: string;
  TEST_COMMAND?: string;
  PREVIEW_ORIGIN?: string;
};
