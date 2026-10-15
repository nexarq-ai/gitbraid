import type { AiKeyProvider, AiKeysSnapshot, ModelConnection } from '../shared/types';
import { ApiError, requireString } from './domain';
import { decryptAuth, encryptAuth } from './mfa';
import { AI_KEY_PROVIDERS, isAiKeyProvider, modelProvider, type ModelRoute, type OwnGateway } from './gateway-routing';
import { verifyModelConnection } from './model-config';
import type { ModelEnv } from './model-adapter';

export interface StoredAiKey { provider: AiKeyProvider; encrypted: string; last4: string; addedBy: string; addedAt: string; verifiedModel: string }
export interface StoredAiGateway { accountId: string; gatewayId: string; encryptedToken?: string; tokenLast4?: string; updatedBy: string; updatedAt: string }
export interface AiCredentials { keys: StoredAiKey[]; gateway: StoredAiGateway | null }
export interface AiCredentialStore { getAiCredentials(): Promise<AiCredentials> }
export interface AiAccessOptions { AUTH_ENCRYPTION_KEY?: string; EDITION?: 'hosted' | 'self-hosted'; OPERATOR_MODEL_WORKSPACES?: string }

const keyContext = (workspaceId: string, provider: AiKeyProvider) => `ai-key:${workspaceId}:${provider}`;
const gatewayContext = (workspaceId: string) => `ai-gateway:${workspaceId}`;

export function operatorModelAccess(env: AiAccessOptions, workspaceId: string): boolean {
  if (workspaceId === 'legacy' || env.EDITION === 'self-hosted') return true;
  return (env.OPERATOR_MODEL_WORKSPACES ?? '').split(',').map(value => value.trim()).filter(Boolean).includes(workspaceId);
}

export function providerLabel(provider: AiKeyProvider): string {
  return AI_KEY_PROVIDERS.find(entry => entry.id === provider)?.label ?? provider;
}

export function aiKeyProvider(value: unknown): AiKeyProvider {
  if (!isAiKeyProvider(value)) throw new ApiError(400, 'INVALID_AI_PROVIDER', `Choose one of: ${AI_KEY_PROVIDERS.map(entry => entry.id).join(', ')}.`);
  return value;
}

export function providerKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) throw new ApiError(400, 'INVALID_AI_KEY', 'Paste the provider API key exactly, without spaces.');
  return value;
}

export function ownGatewayInput(body: Record<string, unknown>): { accountId: string; gatewayId: string; token?: string } {
  const accountId = requireString(body.accountId, 'Cloudflare account ID', 32, 32);
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new ApiError(400, 'INVALID_AI_GATEWAY', 'The Cloudflare account ID is 32 lowercase hexadecimal characters.');
  const gatewayId = requireString(body.gatewayId, 'AI Gateway ID', 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(gatewayId)) throw new ApiError(400, 'INVALID_AI_GATEWAY', 'Use the AI Gateway ID shown in the Cloudflare dashboard (lowercase letters, numbers, hyphens and underscores).');
  if (body.token === undefined || body.token === null || body.token === '') return { accountId, gatewayId };
  if (typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 256 || !/^[\x21-\x7e]+$/.test(body.token)) throw new ApiError(400, 'INVALID_AI_GATEWAY', 'Paste the AI Gateway authentication token exactly, without spaces.');
  return { accountId, gatewayId, token: body.token };
}

export async function encryptAiKey(env: AiAccessOptions, workspaceId: string, provider: AiKeyProvider, key: string, addedBy: string, verifiedModel: string): Promise<StoredAiKey> {
  return { provider, encrypted: await encryptAuth(key, env.AUTH_ENCRYPTION_KEY, keyContext(workspaceId, provider)), last4: key.slice(-4), addedBy, addedAt: new Date().toISOString(), verifiedModel };
}

export async function encryptAiGateway(env: AiAccessOptions, workspaceId: string, input: { accountId: string; gatewayId: string; token?: string }, updatedBy: string): Promise<StoredAiGateway> {
  return { accountId: input.accountId, gatewayId: input.gatewayId, ...(input.token ? { encryptedToken: await encryptAuth(input.token, env.AUTH_ENCRYPTION_KEY, gatewayContext(workspaceId)), tokenLast4: input.token.slice(-4) } : {}), updatedBy, updatedAt: new Date().toISOString() };
}

async function ownGateway(env: AiAccessOptions, workspaceId: string, stored: StoredAiGateway | null): Promise<OwnGateway | undefined> {
  if (!stored) return undefined;
  return { accountId: stored.accountId, gatewayId: stored.gatewayId, ...(stored.encryptedToken ? { token: await decryptAuth(stored.encryptedToken, env.AUTH_ENCRYPTION_KEY, gatewayContext(workspaceId)) } : {}) };
}

export function aiKeyRequired(model: ModelConnection): ApiError {
  const provider = modelProvider(model);
  if (!provider && model.source === 'workers-ai') return new ApiError(412, 'AI_KEY_REQUIRED', `${model.label} runs on the platform's Workers AI account, which this workspace cannot use. Add your AI key in Settings > AI models and choose a model from that provider.`);
  return new ApiError(412, 'AI_KEY_REQUIRED', provider ? `Add your ${providerLabel(provider)} key in Settings > AI models to use ${model.label}, or connect your own AI Gateway.` : `Add your AI key in Settings > AI models to start missions. ${model.label} needs your own AI Gateway with a stored provider key.`);
}

export function hasModelAccess(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials, model: ModelConnection): boolean {
  const provider = modelProvider(model);
  return (!!provider && credentials.keys.some(key => key.provider === provider)) || (!!credentials.gateway && model.source === 'gateway') || operatorModelAccess(env, workspaceId);
}

export function assertModelAccess(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials, models: ModelConnection[]): void {
  for (const model of models) if (!hasModelAccess(env, workspaceId, credentials, model)) throw aiKeyRequired(model);
}

export function assertWorkspaceAi(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials): void {
  if (!operatorModelAccess(env, workspaceId) && !credentials.keys.length && !credentials.gateway) throw new ApiError(412, 'AI_KEY_REQUIRED', 'Add your AI key in Settings > AI models to start missions.');
}

export async function modelRoute(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials, model: ModelConnection): Promise<ModelRoute> {
  const provider = modelProvider(model);
  const stored = provider ? credentials.keys.find(key => key.provider === provider) : undefined;
  const gateway = model.source === 'gateway' ? await ownGateway(env, workspaceId, credentials.gateway) : undefined;
  if (stored && provider) return { workspaceId, credential: { provider, key: await decryptAuth(stored.encrypted, env.AUTH_ENCRYPTION_KEY, keyContext(workspaceId, provider)) }, ...(gateway ? { gateway } : {}) };
  if (gateway) return { workspaceId, gateway };
  if (operatorModelAccess(env, workspaceId)) return { workspaceId };
  throw aiKeyRequired(model);
}

export function createModelAccess(env: AiAccessOptions, workspaceId: string, store: AiCredentialStore): (model: ModelConnection) => Promise<ModelRoute> {
  return async model => modelRoute(env, workspaceId, await store.getAiCredentials(), model);
}

export function aiKeysSnapshot(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials): AiKeysSnapshot {
  const gateway = credentials.gateway;
  return {
    providers: AI_KEY_PROVIDERS.map(({ id, label }) => ({ id, label })),
    keys: credentials.keys.map(({ provider, last4, addedBy, addedAt, verifiedModel }) => ({ provider, last4, addedBy, addedAt, verifiedModel })),
    gateway: gateway ? { accountId: gateway.accountId, gatewayId: gateway.gatewayId, authenticated: !!gateway.encryptedToken, ...(gateway.tokenLast4 ? { tokenLast4: gateway.tokenLast4 } : {}), updatedBy: gateway.updatedBy, updatedAt: gateway.updatedAt } : null,
    operatorAccess: operatorModelAccess(env, workspaceId),
    ready: operatorModelAccess(env, workspaceId) || credentials.keys.length > 0 || !!gateway,
  };
}

export function verificationModel(provider: AiKeyProvider, models: ModelConnection[], requested?: string): ModelConnection {
  if (requested) {
    const model = models.find(entry => entry.id === requested);
    if (!model || modelProvider(model) !== provider) throw new ApiError(400, 'INVALID_MODEL', `Choose an enabled ${providerLabel(provider)} model to test this key.`);
    return model;
  }
  return models.find(entry => modelProvider(entry) === provider) ?? AI_KEY_PROVIDERS.find(entry => entry.id === provider)!.verifyModel;
}

export async function verifyProviderKey(env: ModelEnv, workspaceId: string, provider: AiKeyProvider, key: string, model: ModelConnection, gateway: OwnGateway | undefined): Promise<{ ok: boolean; detail: string }> {
  const verified = await verifyModelConnection({ ...env, modelAccess: async () => ({ workspaceId, credential: { provider, key }, ...(gateway ? { gateway } : {}) }) }, model);
  return { ok: verified.verification?.status === 'verified', detail: verified.verification?.detail ?? 'The key could not be verified.' };
}

export async function storedOwnGateway(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials): Promise<OwnGateway | undefined> {
  return ownGateway(env, workspaceId, credentials.gateway);
}

export async function storedProviderKey(env: AiAccessOptions, workspaceId: string, credentials: AiCredentials, provider: AiKeyProvider): Promise<string> {
  const stored = credentials.keys.find(key => key.provider === provider);
  if (!stored) throw new ApiError(404, 'AI_KEY_NOT_FOUND', `No ${providerLabel(provider)} key is stored for this workspace.`);
  return decryptAuth(stored.encrypted, env.AUTH_ENCRYPTION_KEY, keyContext(workspaceId, provider));
}
