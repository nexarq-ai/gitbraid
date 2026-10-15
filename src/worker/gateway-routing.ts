import { isSonnet55, nativeModelId } from './anthropic-adapter';
import type { AiKeyProvider, ModelConnection } from '../shared/types';

export interface OwnGateway { accountId: string; gatewayId: string; token?: string }
export interface ModelRoute { workspaceId: string; credential?: { provider: AiKeyProvider; key: string }; gateway?: OwnGateway }
export interface ProviderRequest { provider: string; endpoint: string; headers: Record<string, string>; body: Record<string, unknown> }

export const AI_KEY_PROVIDERS: { id: AiKeyProvider; label: string; verifyModel: ModelConnection }[] = [
  { id: 'openai', label: 'OpenAI', verifyModel: { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', source: 'gateway', protocol: 'responses' } },
  { id: 'anthropic', label: 'Anthropic', verifyModel: { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'gateway', protocol: 'anthropic' } },
  { id: 'google-ai-studio', label: 'Google AI Studio', verifyModel: { id: 'google-ai-studio/gemini-2.5-flash', label: 'Gemini 2.5 Flash', source: 'gateway', protocol: 'chat' } },
  { id: 'groq', label: 'Groq', verifyModel: { id: 'groq/llama-3.1-8b-instant', label: 'Llama 3.1 8B', source: 'gateway', protocol: 'chat' } },
  { id: 'mistral', label: 'Mistral', verifyModel: { id: 'mistral/mistral-small-latest', label: 'Mistral Small', source: 'gateway', protocol: 'chat' } },
  { id: 'deepseek', label: 'DeepSeek', verifyModel: { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', source: 'gateway', protocol: 'chat' } },
  { id: 'grok', label: 'xAI', verifyModel: { id: 'grok/grok-3-mini', label: 'Grok 3 mini', source: 'gateway', protocol: 'chat' } },
];

const PREFIX_PROVIDERS: Record<string, AiKeyProvider> = { openai: 'openai', anthropic: 'anthropic', google: 'google-ai-studio', 'google-ai-studio': 'google-ai-studio', groq: 'groq', mistral: 'mistral', deepseek: 'deepseek', grok: 'grok', xai: 'grok' };

export function isAiKeyProvider(value: unknown): value is AiKeyProvider {
  return AI_KEY_PROVIDERS.some(provider => provider.id === value);
}

export function modelProvider(model: ModelConnection): AiKeyProvider | null {
  if (model.source !== 'gateway') return null;
  return PREFIX_PROVIDERS[model.id.slice(0, model.id.indexOf('/'))] ?? null;
}

export function gatewayUrl(gateway: OwnGateway, provider: string, endpoint: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/${provider}/${endpoint}`;
}

export function gatewayMetadata(workspaceId: string): Record<string, string> {
  return { workspaceId };
}

export function providerRequest(model: ModelConnection, parameters: Record<string, unknown>, route: ModelRoute): ProviderRequest {
  if (model.source !== 'gateway') throw new Error('Workers AI models run on the deployment account and cannot use a workspace AI key');
  const native = model.id.slice(model.id.indexOf('/') + 1);
  const key = route.credential?.key;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'cf-aig-metadata': JSON.stringify(gatewayMetadata(route.workspaceId)), ...(key ? { 'cf-aig-no-wholesale': 'true' } : {}) };
  if (model.protocol === 'anthropic') {
    return { provider: 'anthropic', endpoint: 'v1/messages', headers: { ...headers, 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }, body: { ...parameters, model: nativeModelId(model.id), ...(isSonnet55(model.id) ? { cache_control: { type: 'ephemeral' } } : {}) } };
  }
  const authorization: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  if (model.protocol === 'responses') return { provider: 'openai', endpoint: 'responses', headers: { ...headers, ...authorization }, body: { ...parameters, model: native } };
  const provider = modelProvider(model);
  if (provider === 'openai') return { provider: 'openai', endpoint: 'chat/completions', headers: { ...headers, ...authorization }, body: { ...parameters, model: native } };
  const prefix = provider ?? model.id.slice(0, model.id.indexOf('/'));
  return { provider: 'compat', endpoint: 'chat/completions', headers: { ...headers, ...authorization }, body: { ...parameters, model: `${prefix}/${native}` } };
}
