export interface AiGatewayUniversalRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
}

export interface ModelTransportAi {
  run(model: string, input: Record<string, unknown>, options?: { gateway: { id: string; metadata?: Record<string, string> }; extraHeaders?: Record<string, string>; signal?: AbortSignal }): Promise<unknown>;
  gateway?(id: string): { run(request: AiGatewayUniversalRequest | AiGatewayUniversalRequest[], options?: { extraHeaders?: object; signal?: AbortSignal }): Promise<Response> };
}

export type ModelCall =
  | { kind: 'fetch'; url: string; headers: Record<string, string>; body: string; timeoutMs: number }
  | { kind: 'gateway'; gatewayId: string; request: AiGatewayUniversalRequest; extraHeaders?: Record<string, string>; timeoutMs: number }
  | { kind: 'run'; gatewayId: string; model: string; input: Record<string, unknown>; metadata?: Record<string, string>; extraHeaders?: Record<string, string>; timeoutMs: number };

export interface CallError { name: string; message: string; status?: number; code?: number }
export type ModelCallOutcome =
  | { kind: 'response'; status: number; logId?: string; body: string; colo?: string }
  | { kind: 'value'; value: unknown }
  | { kind: 'error'; error: CallError; colo?: string };
export type RelayedOutcome = ModelCallOutcome & { regions: string[]; locationRefused: boolean };

export const RELAY_REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'] as const;
export type RelayRegion = typeof RELAY_REGIONS[number];
export const DEFAULT_RELAY_REGION: RelayRegion = 'enam';
export const RELAY_SHARDS = 8;

export interface ModelRelayStub { call(call: ModelCall): Promise<ModelCallOutcome> }
export interface ModelRelayNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId, options?: { locationHint?: RelayRegion }): ModelRelayStub;
}
export interface ModelTransportEnv {
  AI?: ModelTransportAi;
  MODEL_RELAY?: ModelRelayNamespace;
  MODEL_RELAY_LOCATION_HINT?: string;
}

export function relayRegions(configured: string | undefined): [RelayRegion, RelayRegion] {
  const primary = RELAY_REGIONS.find(region => region === configured?.trim().toLowerCase()) ?? DEFAULT_RELAY_REGION;
  return [primary, primary === 'enam' ? 'wnam' : 'enam'];
}

const LOCATION_REFUSAL = /request not allowed|unsupported_country|country, region,? or territory not supported|not available in your (?:country|region|location)|unsupported (?:country|region|location)/i;

export function isLocationRefusal(outcome: ModelCallOutcome): boolean {
  if (outcome.kind === 'response') return outcome.status === 403 && LOCATION_REFUSAL.test(outcome.body);
  if (outcome.kind === 'error') return (outcome.error.status === 403 || /\b403\b/.test(outcome.error.message)) && LOCATION_REFUSAL.test(outcome.error.message);
  return false;
}

export async function cloudflareLocation(): Promise<string | undefined> {
  try {
    const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(2000) })).text();
    return /^colo=([A-Z]{3})$/m.exec(trace)?.[1];
  } catch { return undefined; }
}

function callError(error: unknown): CallError {
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = raw.status ?? raw.statusCode;
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof raw.code === 'number' ? { code: raw.code } : {}),
  };
}

export async function performModelCall(env: Pick<ModelTransportEnv, 'AI'>, call: ModelCall, locate: () => Promise<string | undefined> = cloudflareLocation): Promise<ModelCallOutcome> {
  const signal = AbortSignal.timeout(call.timeoutMs);
  try {
    if (call.kind === 'run') {
      if (!env.AI) throw new Error('AI Gateway connection is not configured');
      return { kind: 'value', value: await env.AI.run(call.model, call.input, { gateway: { id: call.gatewayId, ...(call.metadata ? { metadata: call.metadata } : {}) }, ...(call.extraHeaders ? { extraHeaders: call.extraHeaders } : {}), signal }) };
    }
    let response: Response;
    if (call.kind === 'fetch') response = await fetch(call.url, { method: 'POST', headers: call.headers, body: call.body, signal });
    else {
      if (!env.AI?.gateway) throw new Error('AI Gateway connection is not configured');
      response = await env.AI.gateway(call.gatewayId).run(call.request, { ...(call.extraHeaders ? { extraHeaders: call.extraHeaders } : {}), signal });
    }
    const logId = response.headers.get('cf-aig-log-id') ?? undefined;
    let body = '';
    try { body = await response.text(); }
    catch { body = ''; }
    const colo = response.status === 403 ? await locate() : undefined;
    return { kind: 'response', status: response.status, body, ...(logId ? { logId } : {}), ...(colo ? { colo } : {}) };
  } catch (error) {
    const failure = callError(error);
    const colo = failure.status === 403 || /\b403\b/.test(failure.message) ? await locate() : undefined;
    return { kind: 'error', error: failure, ...(colo ? { colo } : {}) };
  }
}

export function outcomeResponse(outcome: Extract<ModelCallOutcome, { kind: 'response' }>): Response {
  return new Response(outcome.status === 204 || outcome.status === 304 ? null : outcome.body, { status: outcome.status, headers: outcome.logId ? { 'cf-aig-log-id': outcome.logId } : {} });
}

export function outcomeError(error: CallError): Error {
  return Object.assign(new Error(error.message), { name: error.name, ...(error.status !== undefined ? { status: error.status } : {}), ...(error.code !== undefined ? { code: error.code } : {}) });
}

async function viaRelay(relay: ModelRelayNamespace, region: RelayRegion, call: ModelCall): Promise<ModelCallOutcome> {
  const shard = Math.floor(Math.random() * RELAY_SHARDS);
  return relay.get(relay.idFromName(`relay-${region}-${shard}`), { locationHint: region }).call(call);
}

export async function sendModelCall(env: ModelTransportEnv, call: ModelCall): Promise<RelayedOutcome> {
  if (!env.MODEL_RELAY) {
    const outcome = await performModelCall(env, call);
    return { ...outcome, regions: [], locationRefused: isLocationRefusal(outcome) };
  }
  const [primary, alternate] = relayRegions(env.MODEL_RELAY_LOCATION_HINT);
  const first = await viaRelay(env.MODEL_RELAY, primary, call);
  if (!isLocationRefusal(first)) return { ...first, regions: [primary], locationRefused: false };
  console.warn(JSON.stringify({ event: 'model_location_refused', region: primary, colo: first.kind === 'value' ? null : first.colo ?? null, retryRegion: alternate }));
  const second = await viaRelay(env.MODEL_RELAY, alternate, call);
  return { ...second, regions: [primary, alternate], locationRefused: isLocationRefusal(second) };
}
