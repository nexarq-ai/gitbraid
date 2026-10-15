import type { Mission, ModelConnection, ModelConnectionsSnapshot } from '../shared/types';
import { ApiError, requireString } from './domain';
import { classifyModelFailure, inferenceMessage, ModelResponseError, type ModelEnv } from './model-adapter';

export const DEFAULT_MODEL = 'openai/gpt-6-luna';
export const ESCALATION_MODEL = 'openai/gpt-6.1-sol';
export const WORKERS_AI_CATALOG: ModelConnection[] = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', source: 'workers-ai', protocol: 'workers-ai' },
];

export function defaultModelConnections(): ModelConnection[] {
  return [
    { id: DEFAULT_MODEL, label: 'GPT-6 Luna', source: 'gateway', protocol: 'responses' },
    { id: ESCALATION_MODEL, label: 'GPT-6.1 Sol', source: 'gateway', protocol: 'responses' },
  ];
}

export function modelIdentifier(value: unknown): string {
  const id = requireString(value, 'Model identifier', 200);
  if (!/^(?:@cf\/[a-z0-9][a-z0-9._-]*|[a-z][a-z0-9_-]*)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) || id.includes('..') || id.includes('//') || id.endsWith('/') || id.startsWith('dynamic/')) throw new ApiError(400, 'INVALID_MODEL', 'Use a provider/model identifier, without URLs, credentials, traversal, or dynamic routes.');
  return id;
}

export function validateModelConnection(value: unknown): ModelConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_MODEL', 'Provide a model identifier, label, source and supported transport.');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['id', 'label', 'source', 'protocol', 'verification'].includes(key))) throw new ApiError(400, 'INVALID_MODEL', 'Model connections accept identifiers and transport settings only. Store provider credentials in AI Gateway.');
  const id = modelIdentifier(raw.id);
  const label = requireString(raw.label, 'Model label', 80);
  const source = raw.source;
  const protocol = raw.protocol;
  if (source === 'workers-ai') {
    if (protocol !== 'workers-ai' || !WORKERS_AI_CATALOG.some(model => model.id === id)) throw new ApiError(400, 'INVALID_MODEL', 'Choose a documented tool-capable Workers AI model from the catalog.');
  } else if (source === 'gateway') {
    if (id.startsWith('@cf/') || !['responses', 'chat', 'anthropic'].includes(String(protocol)) || (protocol === 'responses' && !id.startsWith('openai/')) || (protocol === 'anthropic' && !id.startsWith('anthropic/'))) throw new ApiError(400, 'INVALID_MODEL', 'Gateway connections support OpenAI Responses, compatible chat, or native Anthropic Messages. Workers AI uses its own transport.');
  } else throw new ApiError(400, 'INVALID_MODEL', 'Choose AI Gateway or Workers AI.');
  return { id, label, source, protocol: protocol as ModelConnection['protocol'] };
}

export function modelNotConfiguredMessage(id: string): string {
  return `The model ${id.slice(0, 120)} is not enabled in this workspace, so nothing was started. Choose an enabled model and start again, or ask a workspace Owner to enable it: only Owners can open Settings > AI models.`;
}

export function resolveModelConnection(models: ModelConnection[], id = DEFAULT_MODEL): ModelConnection {
  modelIdentifier(id);
  const model = models.find(entry => entry.id === id);
  if (!model) throw new ApiError(409, 'MODEL_NOT_CONFIGURED', modelNotConfiguredMessage(id));
  return validateModelConnection(model);
}

export function assertPinnedModel(models: ModelConnection[], pinned: ModelConnection): void {
  const current = resolveModelConnection(models, pinned.id);
  if (current.source !== pinned.source || current.protocol !== pinned.protocol) throw new ApiError(409, 'MODEL_CONNECTION_CHANGED', 'The selected model connection changed. Create a new proposal with the current model settings.');
}

export function pinMissionModels(mission: Mission, models: ModelConnection[]): Mission {
  if (mission.skillChange) return mission;
  return { ...mission, runs: mission.runs.map(run => {
    const model = run.modelConfig ?? resolveModelConnection(models, run.model ?? DEFAULT_MODEL);
    assertPinnedModel(models, model);
    return { ...run, model: model.id, modelConfig: structuredClone(model) };
  }) };
}

export function modelConnectionsSnapshot(env: ModelEnv, models: ModelConnection[]): ModelConnectionsSnapshot {
  return { gateway: { id: env.AI_GATEWAY_ID ?? null, configured: !!env.AI && !!env.AI_GATEWAY_ID }, workersAI: { enabled: !!env.AI }, models: structuredClone(models), workersAICatalog: structuredClone(WORKERS_AI_CATALOG), discovery: 'manual' };
}

export async function verifyModelConnection(env: ModelEnv, model: ModelConnection): Promise<ModelConnection> {
  const checkedAt = new Date().toISOString();
  const validated = validateModelConnection(model);
  try {
    const result = await inferenceMessage(env, validated, [{ role: 'user', content: 'Reply with OK.' }], [], 30_000, 16);
    if (!result.text.trim() || result.calls.length) throw new ModelResponseError('unexpected_verification_tools', 'Unexpected verification response');
    return { ...validated, verification: { status: 'verified', checkedAt, detail: 'A bounded inference returned text through the configured AI Gateway. Coding and tool compatibility are not proven by this check.' } };
  } catch (error) {
    const failure = classifyModelFailure(error);
    console.error(JSON.stringify({ event: 'model_verification_failed', ...failure }));
    const rejection = error instanceof Error && error.message.startsWith('AI Gateway rejected') ? error.message : null;
    const reason = rejection ?? (failure.operation === 'normalize' ? `Unexpected model output (${failure.code}).` : failure.errorName === 'TimeoutError' || failure.errorName === 'AbortError' ? 'The bounded inference timed out.' : `The AI binding rejected inference${failure.providerStatus ? ` (HTTP ${failure.providerStatus})` : ''}.`);
    return { ...validated, verification: { status: 'failed', checkedAt, detail: `${reason} Check the model identifier, transport, Gateway default BYOK alias or billing, and Workers AI availability.` } };
  }
}
