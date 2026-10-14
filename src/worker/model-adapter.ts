import { anthropicInput, anthropicOutput, isSonnet55, nativeModelId } from './anthropic-adapter';
import type { ModelConnection, ModelUsage } from '../shared/types';

export interface AiGatewayUniversalRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
}
export interface ModelEnv {
  AI?: {
    run(model: string, input: Record<string, unknown>, options?: { gateway: { id: string }; extraHeaders?: Record<string, string>; signal?: AbortSignal }): Promise<unknown>;
    gateway?(id: string): { run(request: AiGatewayUniversalRequest | AiGatewayUniversalRequest[], options?: { extraHeaders?: object; signal?: AbortSignal }): Promise<Response> };
  };
  AI_GATEWAY_ID?: string;
}
export type InputItem = Record<string, unknown>;
export type ToolCall = { call_id: string; name: string; arguments: string };
export interface ModelMessage { output: InputItem[]; calls: ToolCall[]; text: string; usage?: ModelUsage }
export type ModelFailureCode = 'invalid_shape' | 'provider_error' | 'incomplete_response' | 'invalid_tool_call' | 'empty_response' | 'tool_limit' | 'unexpected_verification_tools' | 'invalid_final_summary';

export class ModelResponseError extends Error {
  constructor(public readonly code: ModelFailureCode, message: string, public readonly nativeEmptyToolResponse = false) { super(message); this.name = 'ModelResponseError'; }
}

export interface ModelFailure {
  operation: 'inference' | 'normalize';
  errorName: 'ModelResponseError' | 'AbortError' | 'TimeoutError' | 'InferenceUpstreamError' | 'AiInternalError' | 'AiGatewayInternalError' | 'Error';
  code?: ModelFailureCode;
  providerStatus?: number;
  providerCode?: number;
}

export function classifyModelFailure(error: unknown): ModelFailure {
  if (error instanceof ModelResponseError) return { operation: 'normalize', errorName: 'ModelResponseError', code: error.code };
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const knownNames = ['AbortError', 'TimeoutError', 'InferenceUpstreamError', 'AiInternalError', 'AiGatewayInternalError'];
  const errorName = knownNames.includes(String(raw.name)) ? raw.name as ModelFailure['errorName'] : 'Error';
  const status = raw.status ?? raw.statusCode;
  const code = raw.code;
  return { operation: 'inference', errorName, ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { providerStatus: status } : {}), ...(typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 100_000 ? { providerCode: code } : {}) };
}

export function modelOutputShape(body: unknown): Record<string, string | number | boolean | string[]> {
  const bodyType = body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body;
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const knownKeys = ['response', 'tool_calls', 'choices', 'output', 'error', 'errors', 'result', 'success', 'status', 'usage'];
  return { bodyType, knownKeys: knownKeys.filter(key => Object.hasOwn(raw, key)), responseType: raw.response === null ? 'null' : typeof raw.response, responseLength: typeof raw.response === 'string' ? raw.response.length : 0, toolCallsPresent: Object.hasOwn(raw, 'tool_calls'), toolCallsCount: Array.isArray(raw.tool_calls) ? raw.tool_calls.length : -1, choicesCount: Array.isArray(raw.choices) ? raw.choices.length : -1, outputCount: Array.isArray(raw.output) ? raw.output.length : -1 };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelResponseError('invalid_shape', 'Model returned no usable response');
  return value as Record<string, unknown>;
}

export function chatMessages(input: InputItem[]): InputItem[] {
  const result: InputItem[] = [];
  for (const item of input) {
    if (item.type === 'function_call') {
      const previous = result.at(-1);
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
      else result.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') result.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    else if (item.role && typeof item.content === 'string') result.push({ role: item.role, content: item.content });
    else if (item.type === 'message' && Array.isArray(item.content)) result.push({ role: 'assistant', content: item.content.filter(content => content.type === 'output_text').map(content => content.text).join('\n') });
  }
  return result;
}

export function workersAIMessages(input: InputItem[]): InputItem[] {
  const names = new Map(input.filter(item => item.type === 'function_call').map(item => [item.call_id, item.name]));
  return input.flatMap(item => {
    if (item.type === 'function_call') return [{ role: 'assistant', content: JSON.stringify({ tool_calls: [{ name: item.name, arguments: JSON.parse(String(item.arguments)) }] }) }];
    if (item.type === 'function_call_output') return [{ role: 'tool', name: names.get(item.call_id), content: String(item.output) }];
    return chatMessages([item]);
  });
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nativeUsage(raw: Record<string, unknown>): ModelUsage | undefined {
  const usage = raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage) ? raw.usage as Record<string, unknown> : undefined;
  if (!usage) return undefined;
  const inputTokens = safeCount(usage.input_tokens);
  const outputTokens = safeCount(usage.output_tokens);
  const cacheReadTokens = safeCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = safeCount(usage.cache_creation_input_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}), ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}) };
}

export function normalizeModelMessage(body: unknown, protocol: ModelConnection['protocol']): ModelMessage {
  const raw = object(body);
  if (protocol === 'anthropic') {
    try {
      const result = anthropicOutput(raw);
      const usage = nativeUsage(raw);
      return usage ? { ...result, usage } : result;
    }
    catch { throw new ModelResponseError('invalid_shape', 'Model returned invalid or incomplete Anthropic output'); }
  }
  if (raw.error) throw new ModelResponseError('provider_error', 'Model returned no usable completed response');
  const calls: ToolCall[] = [];
  const texts: string[] = [];
  let output: InputItem[];
  if (protocol === 'responses') {
    if ((raw.status && raw.status !== 'completed') || !Array.isArray(raw.output)) throw new ModelResponseError('incomplete_response', 'Model returned no usable completed response');
    output = raw.output;
    for (const value of output) {
      const item = object(value);
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new ModelResponseError('invalid_tool_call', 'Model returned an invalid function call');
        calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments });
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const content of item.content) if (content.type === 'output_text' && typeof content.text === 'string') texts.push(content.text);
      }
    }
  } else {
    let message: Record<string, unknown>;
    if (protocol === 'chat') {
      if (!Array.isArray(raw.choices) || raw.choices.length !== 1) throw new ModelResponseError('invalid_shape', 'Model returned no usable completed response');
      const choice = object(raw.choices[0]);
      if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))) throw new ModelResponseError('incomplete_response', 'Model returned no usable completed response');
      message = object(choice.message);
      if (typeof message.content === 'string') texts.push(message.content);
    } else {
      message = raw;
      if (typeof raw.response === 'string') texts.push(raw.response);
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new ModelResponseError('invalid_tool_call', 'Model returned invalid tool calls');
    for (const value of (message.tool_calls as unknown[] | undefined) ?? []) {
      const call = object(value);
      const fn = call.function ? object(call.function) : call;
      if (typeof fn.name !== 'string' || (typeof fn.arguments !== 'string' && (!fn.arguments || typeof fn.arguments !== 'object' || Array.isArray(fn.arguments)))) throw new ModelResponseError('invalid_tool_call', 'Model returned an invalid function call');
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
      const callId = typeof call.id === 'string' && call.id ? call.id : crypto.randomUUID();
      calls.push({ call_id: callId, name: fn.name, arguments: args });
    }
    output = [ ...(texts.length ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texts.join('\n') }] }] : []), ...calls.map(call => ({ type: 'function_call', ...call })) ];
  }
  if (!calls.length && !texts.some(text => text.trim())) {
    const validUsage = raw.usage === undefined || (!!raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage));
    const nativeEmptyTools = protocol === 'workers-ai' && Object.hasOwn(raw, 'response') && Object.hasOwn(raw, 'tool_calls') && raw.response === '' && Array.isArray(raw.tool_calls) && raw.tool_calls.length === 0 && validUsage && Object.keys(raw).every(key => ['response', 'tool_calls', 'usage'].includes(key));
    throw new ModelResponseError('empty_response', 'Model returned no usable response', nativeEmptyTools);
  }
  if (calls.length > 4) throw new ModelResponseError('tool_limit', 'Model exceeded the per-turn tool limit');
  if (new Set(calls.map(call => call.call_id)).size !== calls.length || calls.some(call => !call.call_id || call.call_id.length > 200 || call.name.length > 100 || call.arguments.length > 16_000)) throw new ModelResponseError('invalid_tool_call', 'Model returned an invalid function call');
  const usage = nativeUsage(raw);
  return usage ? { output, calls, text: texts.join('\n'), usage } : { output, calls, text: texts.join('\n') };
}

// Provider error bodies carry the actionable reason (bad key, no model access, billing); credentials are never echoed
async function cloudflareLocation(): Promise<string | null> {
  try {
    const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(2000) })).text();
    return /^colo=([A-Z]{3})$/m.exec(trace)?.[1] ?? null;
  } catch { return null; }
}

export async function gatewayRejection(response: Response, modelId: string): Promise<string> {
  let reason = '';
  try {
    const body = (await response.text()).slice(0, 4000);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } | unknown; message?: unknown; errors?: { message?: unknown }[] };
      const error = parsed.error as { message?: unknown } | undefined;
      reason = String((typeof error === 'object' && error?.message) || (typeof parsed.error === 'string' && parsed.error) || parsed.message || parsed.errors?.[0]?.message || '');
    } catch { reason = body; }
  } catch {}
  reason = reason.replace(/\s+/g, ' ').replace(/(sk-|key-|Bearer\s+)[\w-]{6,}/gi, '$1[redacted]').trim().slice(0, 240);
  const advice = response.status === 401 || response.status === 403 ? ' Check this provider key in the AI Gateway (BYOK) and that the account can use this model, or choose another model for the mission and retry.' : '';
  const location = response.status === 403 ? await cloudflareLocation() : null;
  return `AI Gateway rejected ${modelId} with status ${response.status}${reason ? `: ${reason}` : ''}.${location ? ` The call came from Cloudflare location ${location}; some providers refuse requests from locations they do not serve.` : ''}${advice}`;
}

export async function inferenceMessage(env: ModelEnv, model: ModelConnection, input: InputItem[], tools: InputItem[], timeoutMs: number, maxTokens = 4096, onUsage?: (usage: ModelUsage | undefined) => Promise<void>): Promise<ModelMessage> {
  if (!env.AI || !env.AI_GATEWAY_ID) throw new Error('AI Gateway connection is not configured');
  let parameters: Record<string, unknown>;
  if (model.protocol === 'anthropic') parameters = anthropicInput(input, tools, maxTokens, model.id);
  else if (model.protocol === 'responses') parameters = { input, ...(tools.length ? { tools } : {}), max_output_tokens: maxTokens, ...(model.id === 'openai/gpt-6-luna' || model.id === 'openai/gpt-6.1-sol' ? { reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'] } : {}), store: false };
  else parameters = { messages: model.protocol === 'workers-ai' ? workersAIMessages(input) : chatMessages(input), ...(tools.length ? { tools: tools.map(tool => model.protocol === 'workers-ai' ? { name: tool.name, description: tool.description, parameters: tool.parameters } : { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }) } : {}), max_tokens: maxTokens, stream: false };
  let body: unknown;
  if (model.protocol === 'anthropic' && isSonnet55(model.id)) {
    if (!env.AI.gateway) throw new Error('AI Gateway connection is not configured');
    const response = await env.AI.gateway(env.AI_GATEWAY_ID).run({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      headers: { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'cf-aig-no-wholesale': 'true' },
      query: { ...parameters, model: nativeModelId(model.id), cache_control: { type: 'ephemeral' } },
    }, { extraHeaders: { 'cf-aig-no-wholesale': 'true' }, signal: AbortSignal.timeout(Math.min(90_000, timeoutMs)) });
    if (!response.ok) throw new Error(await gatewayRejection(response, model.id));
    try { body = await response.json(); }
    catch { throw new Error('AI Gateway returned an unparsable response'); }
  } else {
    body = await env.AI.run(model.id, parameters, { gateway: { id: env.AI_GATEWAY_ID }, ...(model.source === 'gateway' ? { extraHeaders: { 'cf-aig-no-wholesale': 'true' } } : {}), signal: AbortSignal.timeout(Math.min(90_000, timeoutMs)) });
  }
  try {
    const message = normalizeModelMessage(body, model.protocol);
    if (onUsage) await onUsage(message.usage);
    return message;
  }
  catch (error) {
    console.error(JSON.stringify({ event: 'model_output_rejected', ...classifyModelFailure(error), ...modelOutputShape(body) }));
    throw error;
  }
}
