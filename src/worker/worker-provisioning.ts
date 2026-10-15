import type { CloudflareCall } from './cloudflare-deploy';
import { WorkerBuildFailure } from './worker-bundle';

export type WorkerDeployConfig = Record<string, unknown>;
type Json = Record<string, unknown>;
export interface ResolvedResources { d1: Record<string, string> }
export interface ScriptMigrations { old_tag?: string; new_tag: string; steps: unknown[] }

export const SCRIPT_UPLOAD_QUERY = { bindings_inherit: 'strict' } as const;
export const SUBDOMAIN_API_DATE = '2025-08-01';
export const SCOPE_WORKERS_SCRIPTS_WRITE = 'workers-scripts.write';
export const SCOPE_D1_WRITE = 'd1.write';
export const SCOPE_R2_WRITE = 'workers-r2-storage.write';
export const SCOPE_QUEUES_WRITE = 'queues.write';
export const SCOPE_WORKERS_ROUTES_WRITE = 'workers-routes.write';
export const SCOPE_ZONE_READ = 'zone.read';
export const DEPLOY_KEEP_SECRET_BINDINGS = ['secret_text', 'secret_key'];

const MAX_ENTRIES = 200;
const MAX_BINDINGS = 500;
const MAX_VAR_BYTES = 5 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_PAGES = 50;
const bindingPattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const resourcePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const apiIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const zoneIdPattern = /^[0-9a-f]{32}$/;
const accountIdPattern = /^[0-9a-f]{32}$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (message: string) => new WorkerBuildFailure('WORKER_CONFIG_INVALID', message);
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const compact = (value: Json): Json => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

function text(value: unknown, where: string, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${where} must be a non-empty string of at most ${max} characters.`);
  return value;
}
const optText = (value: unknown, where: string, max = 512) => value === undefined ? undefined : text(value, where, max);

function optBool(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${where} must be true or false.`);
  return value;
}

function optNumber(value: unknown, where: string, max = 1_000_000_000): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw invalid(`${where} must be a number between 0 and ${max}.`);
  return value;
}

function strings(value: unknown, where: string, maxItems = 100): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(`${where} must be a list of at most ${maxItems} strings.`);
  return value.map((item, index) => text(item, `${where}[${index}]`));
}

function json(value: unknown, where: string, max = MAX_JSON_BYTES): unknown {
  if (value === undefined) return undefined;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { serialized = undefined; }
  if (serialized === undefined || serialized.length > max) throw invalid(`${where} must be JSON of at most ${max} bytes.`);
  return JSON.parse(serialized);
}

function optRecord(value: unknown, where: string, max = MAX_JSON_BYTES): Json | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid(`${where} must be an object.`);
  return json(value, where, max) as Json;
}

function list(config: Json, key: string): Json[] {
  const value = config[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES || !value.every(isRecord)) throw invalid(`${key} must be a list of at most ${MAX_ENTRIES} objects.`);
  return value;
}

function section(config: Json, key: string): Json | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid(`${key} must be an object.`);
  return value;
}

function nested(config: Json, key: string, field: string): Json[] {
  const outer = section(config, key);
  return outer ? list(outer, field) : [];
}

function bindingName(value: unknown, where: string): string {
  if (typeof value !== 'string' || !bindingPattern.test(value)) throw invalid(`${where} must be a binding name of letters, digits and underscores.`);
  return value;
}

function resource(value: unknown, where: string): string {
  if (typeof value !== 'string' || !resourcePattern.test(value)) throw invalid(`${where} must be a resource name of letters, digits, hyphens and underscores (at most 63 characters).`);
  return value;
}

function apiId(value: unknown, where: string): string {
  if (typeof value !== 'string' || !apiIdPattern.test(value)) throw new WorkerBuildFailure('CLOUDFLARE_RESPONSE_INVALID', `Cloudflare returned an unusable ${where}.`);
  return value;
}

function account(accountId: string): string {
  if (!accountIdPattern.test(accountId)) throw invalid('The Cloudflare account ID is invalid.');
  return accountId;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queueProducers(config: Json): Json[] { return nested(config, 'queues', 'producers'); }
function queueConsumers(config: Json): Json[] { return nested(config, 'queues', 'consumers'); }

function bindingEntries(config: Json, resolved: ResolvedResources | undefined): { bindings: Json[]; notes: string[] } {
  const bindings: Json[] = [];
  const notes: string[] = [];
  const inherit = (name: string, reason: string) => {
    bindings.push({ name, type: 'inherit' });
    notes.push(`Binding ${name} keeps its current deployed value because ${reason}.`);
  };
  const raw = (item: Json, where: string) => optBool(item.raw, `${where}.raw`);

  const vars = section(config, 'vars') ?? {};
  for (const [name, value] of Object.entries(vars)) {
    bindingName(name, `vars.${name}`);
    if (typeof value === 'string') {
      if (value.length > MAX_VAR_BYTES) throw invalid(`vars.${name} exceeds ${MAX_VAR_BYTES} bytes.`);
      bindings.push({ name, type: 'plain_text', text: value });
    } else bindings.push({ name, type: 'json', json: json(value, `vars.${name}`, MAX_VAR_BYTES) });
  }

  list(config, 'kv_namespaces').forEach((item, index) => {
    const name = bindingName(item.binding, `kv_namespaces[${index}].binding`);
    const id = optText(item.id, `kv_namespaces[${index}].id`, 64);
    if (id === undefined) inherit(name, 'the KV namespace has no id');
    else bindings.push(compact({ name, type: 'kv_namespace', namespace_id: id, raw: raw(item, `kv_namespaces[${index}]`) }));
  });

  list(config, 'send_email').forEach((item, index) => {
    const where = `send_email[${index}]`;
    const shared = compact({ name: bindingName(item.name, `${where}.name`), type: 'send_email', allowed_sender_addresses: strings(item.allowed_sender_addresses, `${where}.allowed_sender_addresses`) });
    if (item.destination_address !== undefined) bindings.push({ ...shared, destination_address: text(item.destination_address, `${where}.destination_address`, 320) });
    else if (item.allowed_destination_addresses !== undefined) bindings.push({ ...shared, allowed_destination_addresses: strings(item.allowed_destination_addresses, `${where}.allowed_destination_addresses`) });
    else bindings.push(shared);
  });

  nested(config, 'durable_objects', 'bindings').forEach((item, index) => {
    const where = `durable_objects.bindings[${index}]`;
    bindings.push(compact({ name: bindingName(item.name, `${where}.name`), type: 'durable_object_namespace', class_name: bindingName(item.class_name, `${where}.class_name`), script_name: optText(item.script_name, `${where}.script_name`, 63), environment: optText(item.environment, `${where}.environment`, 63) }));
  });

  list(config, 'workflows').forEach((item, index) => {
    const where = `workflows[${index}]`;
    bindings.push(compact({ type: 'workflow', name: bindingName(item.binding, `${where}.binding`), workflow_name: resource(item.name, `${where}.name`), class_name: bindingName(item.class_name, `${where}.class_name`), script_name: optText(item.script_name, `${where}.script_name`, 63), raw: raw(item, where) }));
  });

  queueProducers(config).forEach((item, index) => {
    const where = `queues.producers[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    if (item.queue === undefined) inherit(name, 'the queue producer names no queue');
    else bindings.push(compact({ type: 'queue', name, queue_name: resource(item.queue, `${where}.queue`), delivery_delay: optNumber(item.delivery_delay, `${where}.delivery_delay`, 86_400), raw: raw(item, where) }));
  });

  list(config, 'r2_buckets').forEach((item, index) => {
    const where = `r2_buckets[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    if (item.bucket_name === undefined) inherit(name, 'the R2 binding has no bucket_name');
    else bindings.push(compact({ name, type: 'r2_bucket', bucket_name: resource(item.bucket_name, `${where}.bucket_name`), jurisdiction: optText(item.jurisdiction, `${where}.jurisdiction`, 32), raw: raw(item, where) }));
  });

  list(config, 'd1_databases').forEach((item, index) => {
    const where = `d1_databases[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    const id = optText(item.database_id, `${where}.database_id`, 64) ?? resolved?.d1[name];
    if (id === undefined) inherit(name, 'the D1 binding has no database_id');
    else bindings.push(compact({ name, type: 'd1', id, internalEnv: optText(item.database_internal_env, `${where}.database_internal_env`, 64), raw: raw(item, where) }));
  });

  list(config, 'vectorize').forEach((item, index) => {
    const where = `vectorize[${index}]`;
    bindings.push(compact({ name: bindingName(item.binding, `${where}.binding`), type: 'vectorize', index_name: text(item.index_name, `${where}.index_name`, 64), raw: raw(item, where) }));
  });

  list(config, 'ai_search_namespaces').forEach((item, index) => {
    const where = `ai_search_namespaces[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    if (item.namespace === undefined) inherit(name, 'the AI Search namespace binding has no namespace');
    else bindings.push({ name, type: 'ai_search_namespace', namespace: text(item.namespace, `${where}.namespace`, 64) });
  });

  list(config, 'ai_search').forEach((item, index) => {
    const where = `ai_search[${index}]`;
    bindings.push(compact({ name: bindingName(item.binding, `${where}.binding`), type: 'ai_search', instance_name: optText(item.instance_name, `${where}.instance_name`, 64) }));
  });

  list(config, 'hyperdrive').forEach((item, index) => {
    const where = `hyperdrive[${index}]`;
    bindings.push({ name: bindingName(item.binding, `${where}.binding`), type: 'hyperdrive', id: text(item.id, `${where}.id`, 64) });
  });

  list(config, 'secrets_store_secrets').forEach((item, index) => {
    const where = `secrets_store_secrets[${index}]`;
    bindings.push({ name: bindingName(item.binding, `${where}.binding`), type: 'secrets_store_secret', store_id: text(item.store_id, `${where}.store_id`, 64), secret_name: text(item.secret_name, `${where}.secret_name`, 255) });
  });

  list(config, 'artifacts').forEach((item, index) => {
    const where = `artifacts[${index}]`;
    bindings.push(compact({ name: bindingName(item.binding, `${where}.binding`), type: 'artifacts', namespace: optText(item.namespace, `${where}.namespace`, 64) }));
  });

  list(config, 'flagship').forEach((item, index) => {
    const where = `flagship[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    if (item.app_id === undefined) inherit(name, 'the Flagship binding has no app_id');
    else bindings.push({ name, type: 'flagship', app_id: text(item.app_id, `${where}.app_id`, 64) });
  });

  list(config, 'ratelimits').forEach((item, index) => {
    const where = `ratelimits[${index}]`;
    bindings.push(compact({ name: bindingName(item.name, `${where}.name`), type: 'ratelimit', namespace_id: text(String(item.namespace_id ?? ''), `${where}.namespace_id`, 64), simple: optRecord(item.simple, `${where}.simple`) }));
  });

  list(config, 'vpc_services').forEach((item, index) => {
    const where = `vpc_services[${index}]`;
    bindings.push({ name: bindingName(item.binding, `${where}.binding`), type: 'vpc_service', service_id: text(item.service_id, `${where}.service_id`, 64) });
  });

  list(config, 'vpc_networks').forEach((item, index) => {
    const where = `vpc_networks[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    bindings.push(item.tunnel_id !== undefined ? { name, type: 'vpc_network', tunnel_id: text(item.tunnel_id, `${where}.tunnel_id`, 64) } : { name, type: 'vpc_network', network_id: text(item.network_id, `${where}.network_id`, 64) });
  });

  list(config, 'services').forEach((item, index) => {
    const where = `services[${index}]`;
    bindings.push(compact({ name: bindingName(item.binding, `${where}.binding`), type: 'service', service: text(item.service, `${where}.service`, 63), cross_account_grant: optText(item.cross_account_grant, `${where}.cross_account_grant`, 128), environment: optText(item.environment, `${where}.environment`, 63), entrypoint: optText(item.entrypoint, `${where}.entrypoint`, 128), props: optRecord(item.props, `${where}.props`) }));
  });

  list(config, 'analytics_engine_datasets').forEach((item, index) => {
    const where = `analytics_engine_datasets[${index}]`;
    bindings.push(compact({ name: bindingName(item.binding, `${where}.binding`), type: 'analytics_engine', dataset: optText(item.dataset, `${where}.dataset`, 128) }));
  });

  list(config, 'dispatch_namespaces').forEach((item, index) => {
    const where = `dispatch_namespaces[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    if (item.namespace === undefined) { inherit(name, 'the dispatch namespace binding has no namespace'); return; }
    const outbound = optRecord(item.outbound, `${where}.outbound`);
    bindings.push(compact({
      name, type: 'dispatch_namespace', namespace: text(item.namespace, `${where}.namespace`, 64),
      outbound: outbound && compact({ worker: compact({ service: text(outbound.service, `${where}.outbound.service`, 63), environment: optText(outbound.environment, `${where}.outbound.environment`, 63) }), params: strings(outbound.parameters, `${where}.outbound.parameters`)?.map((param) => ({ name: param })) }),
    }));
  });

  list(config, 'mtls_certificates').forEach((item, index) => {
    const where = `mtls_certificates[${index}]`;
    bindings.push({ name: bindingName(item.binding, `${where}.binding`), type: 'mtls_certificate', certificate_id: text(item.certificate_id, `${where}.certificate_id`, 64) });
  });

  list(config, 'pipelines').forEach((item, index) => {
    const where = `pipelines[${index}]`;
    const name = bindingName(item.binding, `${where}.binding`);
    if (item.stream) bindings.push({ name, type: 'pipelines', stream: text(item.stream, `${where}.stream`, 128) });
    else if (item.pipeline) bindings.push({ name, type: 'pipelines', pipeline: text(item.pipeline, `${where}.pipeline`, 128) });
    else throw invalid(`${where} must specify a stream or pipeline.`);
  });

  list(config, 'worker_loaders').forEach((item, index) => {
    bindings.push({ name: bindingName(item.binding, `worker_loaders[${index}].binding`), type: 'worker_loader' });
  });

  nested(config, 'logfwdr', 'bindings').forEach((item, index) => {
    const where = `logfwdr.bindings[${index}]`;
    bindings.push({ name: bindingName(item.name, `${where}.name`), type: 'logfwdr', destination: text(item.destination, `${where}.destination`, 255) });
  });

  const browser = section(config, 'browser');
  if (browser) bindings.push(compact({ name: bindingName(browser.binding, 'browser.binding'), type: 'browser', raw: raw(browser, 'browser') }));
  const ai = section(config, 'ai');
  if (ai) bindings.push(compact({ name: bindingName(ai.binding, 'ai.binding'), staging: optBool(ai.staging, 'ai.staging'), type: 'ai', raw: raw(ai, 'ai') }));
  const images = section(config, 'images');
  if (images) bindings.push(compact({ name: bindingName(images.binding, 'images.binding'), type: 'images', raw: raw(images, 'images') }));
  const versionMetadata = section(config, 'version_metadata');
  if (versionMetadata) bindings.push({ name: bindingName(versionMetadata.binding, 'version_metadata.binding'), type: 'version_metadata' });
  const assets = section(config, 'assets');
  if (assets?.binding !== undefined) bindings.push({ name: bindingName(assets.binding, 'assets.binding'), type: 'assets' });

  const unsafe = section(config, 'unsafe');
  if (unsafe) {
    list(unsafe, 'bindings').forEach((item, index) => inherit(bindingName(item.name, `unsafe.bindings[${index}].name`), 'unsafe bindings are not translated by Gitflare'));
    if (unsafe.metadata !== undefined) notes.push('unsafe.metadata is not sent by Gitflare.');
    if (unsafe.capnp !== undefined) notes.push('unsafe.capnp is not sent by Gitflare.');
  }

  if (bindings.length > MAX_BINDINGS) throw invalid(`The Worker declares more than ${MAX_BINDINGS} bindings.`);
  const seen = new Set<string>();
  for (const binding of bindings) {
    const name = binding.name as string;
    if (seen.has(name)) throw new WorkerBuildFailure('WORKER_BINDING_DUPLICATE', `Binding name ${name} is declared more than once.`);
    seen.add(name);
  }
  return { bindings, notes };
}

export function metadataBindings(config: WorkerDeployConfig, resolved?: ResolvedResources): { bindings: Record<string, unknown>[]; notes: string[] } {
  if (!isRecord(config)) throw invalid('The Worker configuration must be an object.');
  return bindingEntries(config, resolved);
}

function placement(value: unknown): Json | undefined {
  const config = optRecord(value, 'placement', 2048);
  if (!config) return undefined;
  const hint = optText(config.hint, 'placement.hint', 128);
  if (!hint && config.mode === 'off') return undefined;
  if (hint || config.mode === 'smart') return compact({ mode: 'smart', hint });
  for (const key of ['region', 'host', 'hostname'] as const) if (config[key]) return { mode: 'targeted', [key]: text(config[key], `placement.${key}`, 255) };
  return undefined;
}

function consumers(value: unknown, where: string): Json[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || !value.every(isRecord)) throw invalid(`${where} must be a list of at most 50 objects.`);
  return value.map((item, index) => compact({ service: text(item.service, `${where}[${index}].service`, 63), environment: optText(item.environment, `${where}[${index}].environment`, 63) }));
}

function uploadExports(config: Json): { exports?: Json; hasDurableObjects: boolean } {
  const entries = optRecord(config.exports, 'exports');
  if (!entries) return { hasDurableObjects: false };
  const worker: Json = {};
  const durable: Json = {};
  const workflow: Json = {};
  for (const [name, entry] of Object.entries(entries)) {
    bindingName(name, `exports.${name}`);
    if (!isRecord(entry)) continue;
    if (entry.type === 'worker') worker[name] = entry;
    else if (entry.type === 'durable-object') durable[name] = entry;
    else if (entry.type === 'workflow') workflow[name] = { type: 'workflow', name: resource(entry.name, `exports.${name}.name`) };
  }
  const combined = { ...worker, ...durable, ...workflow };
  return { ...(Object.keys(combined).length ? { exports: combined } : {}), hasDurableObjects: Object.keys(durable).length > 0 };
}

function migrationsPayload(value: ScriptMigrations): Json {
  if (!isRecord(value) || !Array.isArray(value.steps) || value.steps.length > 100) throw invalid('migrations must contain at most 100 steps.');
  return compact({ old_tag: optText(value.old_tag, 'migrations.old_tag', 128), new_tag: text(value.new_tag, 'migrations.new_tag', 128), steps: json(value.steps, 'migrations.steps', 64 * 1024) });
}

function containers(value: unknown, notes: string[]): Json[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20 || !value.every(isRecord)) throw invalid('containers must be a list of at most 20 objects.');
  if (value.length) notes.push('Container images are not built or pushed by Gitflare; the upload references the configured container classes only.');
  return value.map((item, index) => compact({ name: optText(item.name, `containers[${index}].name`, 128), class_name: optText(item.class_name, `containers[${index}].class_name`, 128), images: item.images === undefined ? undefined : json(item.images, `containers[${index}].images`) }));
}

export function scriptMetadata(input: { config: WorkerDeployConfig; mainModule: string; annotations?: Record<string, string>; assets?: { jwt: string; config: Record<string, unknown> }; migrations?: ScriptMigrations; resolved?: ResolvedResources }): { metadata: Record<string, unknown>; notes: string[] } {
  const { config } = input;
  if (!isRecord(config)) throw invalid('The Worker configuration must be an object.');
  const { bindings, notes } = bindingEntries(config, input.resolved);
  const compatibilityDate = config.compatibility_date;
  if (typeof compatibilityDate !== 'string' || !datePattern.test(compatibilityDate)) throw new WorkerBuildFailure('WORKER_COMPATIBILITY_DATE_REQUIRED', 'Set compatibility_date in the Wrangler configuration.');
  const { exports, hasDurableObjects } = uploadExports(config);
  let migrations = input.migrations && migrationsPayload(input.migrations);
  if (migrations && hasDurableObjects) {
    notes.push('Durable Object exports replace migrations; the configured migrations were not sent.');
    migrations = undefined;
  }
  const annotations = input.annotations === undefined ? undefined : Object.fromEntries(Object.entries(input.annotations).map(([key, value]) => [text(key, 'annotation name', 64), text(value, `annotation ${key}`, 1024)]));
  const assets = input.assets && { jwt: text(input.assets.jwt, 'assets.jwt', 8192), config: optRecord(input.assets.config, 'assets.config') ?? {} };
  const metadata = compact({
    main_module: text(input.mainModule, 'main module', 255),
    bindings,
    containers: containers(config.containers, notes),
    compatibility_date: compatibilityDate,
    compatibility_flags: strings(config.compatibility_flags, 'compatibility_flags', 50),
    migrations,
    exports,
    keep_bindings: [...DEPLOY_KEEP_SECRET_BINDINGS],
    logpush: optBool(config.logpush, 'logpush'),
    placement: placement(config.placement),
    tail_consumers: consumers(config.tail_consumers, 'tail_consumers'),
    streaming_tail_consumers: consumers(config.streaming_tail_consumers, 'streaming_tail_consumers'),
    limits: optRecord(config.limits, 'limits', 1024),
    annotations,
    assets,
    observability: optRecord(config.observability, 'observability'),
  });
  return { metadata, notes };
}

async function pagedList<T>(call: CloudflareCall, path: string, query: Record<string, string | string[]>): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const envelope = await call<{ result?: unknown; result_info?: { page?: number; per_page?: number; total_count?: number } }>(path, { query: { ...query, page: String(page) }, envelope: true });
    if (!Array.isArray(envelope?.result)) throw new WorkerBuildFailure('CLOUDFLARE_RESPONSE_INVALID', `Cloudflare returned an unusable list for ${path.split('/').slice(3).join('/')}.`);
    results.push(...envelope.result as T[]);
    const info = envelope.result_info;
    if (!info || info.page === undefined || info.per_page === undefined || info.total_count === undefined || info.page * info.per_page >= info.total_count) break;
  }
  return results;
}

interface QueueRecord { queue_id?: unknown; queue_name?: unknown; consumers?: unknown }

async function findQueue(call: CloudflareCall, accountId: string, name: string): Promise<QueueRecord | undefined> {
  const queues = await pagedList<QueueRecord>(call, `/accounts/${accountId}/queues`, { name });
  return queues.find((queue) => isRecord(queue) && queue.queue_name === name);
}

export async function ensureResources(call: CloudflareCall, accountId: string, config: WorkerDeployConfig): Promise<{ notes: string[]; created: string[]; resolved: ResolvedResources }> {
  account(accountId);
  if (!isRecord(config)) throw invalid('The Worker configuration must be an object.');
  const notes: string[] = [];
  const created: string[] = [];
  const resolved: ResolvedResources = { d1: {} };

  const buckets = new Map<string, { name: string; jurisdiction?: string }>();
  list(config, 'r2_buckets').forEach((item, index) => {
    if (item.bucket_name === undefined) return;
    const name = resource(item.bucket_name, `r2_buckets[${index}].bucket_name`);
    const jurisdiction = optText(item.jurisdiction, `r2_buckets[${index}].jurisdiction`, 32);
    if (jurisdiction !== undefined && !/^[a-z0-9]+$/.test(jurisdiction)) throw invalid(`r2_buckets[${index}].jurisdiction is invalid.`);
    buckets.set(`${jurisdiction ?? ''}/${name}`, { name, jurisdiction });
  });
  const queueNames = new Set<string>();
  queueProducers(config).forEach((item, index) => { if (item.queue !== undefined) queueNames.add(resource(item.queue, `queues.producers[${index}].queue`)); });
  queueConsumers(config).forEach((item, index) => {
    queueNames.add(resource(item.queue, `queues.consumers[${index}].queue`));
    if (item.dead_letter_queue !== undefined) queueNames.add(resource(item.dead_letter_queue, `queues.consumers[${index}].dead_letter_queue`));
  });
  const pendingDatabases: { binding: string; name: string }[] = [];
  list(config, 'd1_databases').forEach((item, index) => {
    if (item.database_id !== undefined || item.database_name === undefined) return;
    pendingDatabases.push({ binding: bindingName(item.binding, `d1_databases[${index}].binding`), name: resource(item.database_name, `d1_databases[${index}].database_name`) });
  });

  for (const { name, jurisdiction } of buckets.values()) {
    const headers = jurisdiction ? { headers: { 'cf-r2-jurisdiction': jurisdiction } } : {};
    const existing = await call(`/accounts/${accountId}/r2/buckets/${name}`, { allowNotFound: true, ...headers });
    if (existing) { notes.push(`R2 bucket ${name} already exists.`); continue; }
    await call(`/accounts/${accountId}/r2/buckets`, { method: 'POST', json: { name }, ...headers });
    created.push(`R2 bucket ${name}`);
  }

  if (queueNames.size) {
    const existing = new Set((await pagedList<QueueRecord>(call, `/accounts/${accountId}/queues`, { name: [...queueNames] })).map((queue) => isRecord(queue) ? queue.queue_name : undefined));
    for (const name of queueNames) {
      if (existing.has(name)) { notes.push(`Queue ${name} already exists.`); continue; }
      await call(`/accounts/${accountId}/queues`, { method: 'POST', json: { queue_name: name } });
      created.push(`Queue ${name}`);
    }
  }

  const databases = new Map<string, string>();
  for (const { binding, name } of pendingDatabases) {
    let id = databases.get(name);
    if (!id) {
      const matches = await call<unknown>(`/accounts/${accountId}/d1/database`, { query: { name } });
      const match = Array.isArray(matches) ? matches.find((database): database is Json => isRecord(database) && database.name === name) : undefined;
      if (match) {
        id = apiId(match.uuid, 'D1 database id');
        notes.push(`D1 database ${name} already exists.`);
      } else {
        const database = await call<unknown>(`/accounts/${accountId}/d1/database`, { method: 'POST', json: { name } });
        id = apiId(isRecord(database) ? database.uuid : undefined, 'D1 database id');
        created.push(`D1 database ${name}`);
      }
      databases.set(name, id);
    }
    resolved.d1[binding] = id;
  }
  return { notes, created, resolved };
}

interface RouteEntry { pattern: string; customDomain: boolean; zoneId?: string; zoneName?: string }

function routes(config: Json): RouteEntry[] {
  const value = config.routes !== undefined ? config.routes : config.route !== undefined ? [config.route] : [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid(`routes must be a list of at most ${MAX_ENTRIES} entries.`);
  return value.map((item, index) => {
    if (typeof item === 'string') return { pattern: text(item, `routes[${index}]`, 255), customDomain: false };
    if (!isRecord(item)) throw invalid(`routes[${index}] must be a string or an object.`);
    return { pattern: text(item.pattern, `routes[${index}].pattern`, 255), customDomain: item.custom_domain === true, zoneId: optText(item.zone_id, `routes[${index}].zone_id`, 32), zoneName: optText(item.zone_name, `routes[${index}].zone_name`, 253) };
  });
}

export function subdomainValues(config: WorkerDeployConfig): { enabled: boolean; previews_enabled?: boolean } {
  const workersDev = optBool(config.workers_dev, 'workers_dev') ?? routes(config).length === 0;
  const previews = optBool(config.preview_urls, 'preview_urls');
  return { enabled: workersDev, ...(previews === undefined ? {} : { previews_enabled: previews }) };
}

interface OwnedWorkflow { name: string; class_name: string; limits?: unknown; concurrency?: unknown; schedules?: unknown; default_retention?: unknown }

function ownedWorkflows(config: Json, workerName: string): OwnedWorkflow[] {
  const owned = new Map<string, OwnedWorkflow>();
  list(config, 'workflows').forEach((item, index) => {
    const where = `workflows[${index}]`;
    const name = resource(item.name, `${where}.name`);
    const scriptName = optText(item.script_name, `${where}.script_name`, 63);
    if (scriptName === undefined || scriptName === workerName) {
      owned.set(name, { name, class_name: bindingName(item.class_name, `${where}.class_name`), limits: item.limits, concurrency: item.concurrency, schedules: item.schedules, default_retention: item.default_retention });
      return;
    }
    for (const key of ['limits', 'concurrency', 'schedules', 'default_retention'] as const) if (item[key]) throw invalid(`Workflow "${name}" has "${key}" configured but references external script "${scriptName}". Configure ${key} on the Worker that defines the workflow.`);
  });
  const exports = optRecord(config.exports, 'exports') ?? {};
  for (const [className, entry] of Object.entries(exports)) {
    if (!isRecord(entry) || entry.type !== 'workflow') continue;
    const name = resource(entry.name, `exports.${className}.name`);
    const binding = owned.get(name);
    owned.set(name, { name, class_name: bindingName(className, `exports.${className}`), limits: binding?.limits ?? entry.limits, concurrency: binding?.concurrency ?? entry.concurrency, schedules: binding?.schedules ?? entry.schedules, default_retention: binding?.default_retention ?? entry.default_retention });
  }
  return [...owned.values()];
}

function workflowBody(workflow: OwnedWorkflow, workerName: string): Json {
  const where = `workflow ${workflow.name}`;
  const schedules = workflow.schedules ? (Array.isArray(workflow.schedules) ? workflow.schedules : [workflow.schedules]).map((cron) => ({ cron: text(cron, `${where} schedule`, 128) })) : undefined;
  return {
    script_name: workerName,
    class_name: workflow.class_name,
    ...(workflow.limits ? { limits: optRecord(workflow.limits, `${where} limits`) } : {}),
    ...(workflow.concurrency ? { concurrency: json(workflow.concurrency, `${where} concurrency`) } : {}),
    ...(schedules ? { schedules } : {}),
    ...(workflow.default_retention ? { default_retention: json(workflow.default_retention, `${where} default_retention`) } : {}),
  };
}

function zoneCandidates(hostname: string): string[] {
  const labels = hostname.split('.');
  const candidates: string[] = [];
  for (let start = 0; start <= labels.length - 2; start++) candidates.push(labels.slice(start).join('.'));
  return candidates;
}

async function resolveZone(call: CloudflareCall, accountId: string, route: RouteEntry): Promise<string> {
  if (route.zoneId) {
    if (!zoneIdPattern.test(route.zoneId)) throw invalid(`The zone_id for ${route.pattern} is invalid.`);
    return route.zoneId;
  }
  for (const name of route.zoneName ? [route.zoneName] : zoneCandidates(route.pattern)) {
    const zones = await call<unknown>('/zones', { query: { name, 'account.id': accountId } });
    const zone = Array.isArray(zones) ? zones.find((item) => isRecord(item) && item.name === name && typeof item.id === 'string' && zoneIdPattern.test(item.id)) as Json | undefined : undefined;
    if (zone) return zone.id as string;
  }
  throw new WorkerBuildFailure('CUSTOM_DOMAIN_ZONE_NOT_FOUND', `No zone in this Cloudflare account contains ${route.pattern}.`);
}

async function attachCustomDomain(call: CloudflareCall, accountId: string, workerName: string, route: RouteEntry, notes: string[]): Promise<void> {
  const hostname = route.pattern;
  const existing = await call<unknown>(`/accounts/${accountId}/workers/domains`, { query: { hostname } });
  const matches = (Array.isArray(existing) ? existing : []).filter((item): item is Json => isRecord(item) && typeof item.hostname === 'string' && item.hostname.toLowerCase() === hostname.toLowerCase());
  if (matches.some((item) => item.service === workerName)) { notes.push(`Custom domain ${hostname} is already attached to ${workerName}.`); return; }
  const other = matches.find((item) => item.service !== workerName);
  if (other) throw new WorkerBuildFailure('CUSTOM_DOMAIN_CONFLICT', `Custom domain ${hostname} is attached to ${typeof other.service === 'string' ? other.service : 'another Worker'}. Detach it there before deploying ${workerName}.`);
  const zoneId = await resolveZone(call, accountId, route);
  await call(`/accounts/${accountId}/workers/domains`, { method: 'PUT', json: { hostname, service: workerName, environment: 'production', zone_id: zoneId } });
  notes.push(`Attached custom domain ${hostname} to ${workerName}.`);
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof WorkerBuildFailure) throw error;
    throw new WorkerBuildFailure('WORKER_TRIGGER_FAILED', `Updating ${label} failed: ${message(error)}`);
  }
}

export async function applyTriggers(call: CloudflareCall, accountId: string, workerName: string, config: WorkerDeployConfig): Promise<{ notes: string[] }> {
  account(accountId);
  resource(workerName, 'Worker name');
  if (!isRecord(config)) throw invalid('The Worker configuration must be an object.');
  const notes: string[] = [];
  const scriptPath = `/accounts/${accountId}/workers/scripts/${workerName}`;
  const routeEntries = routes(config);
  const subdomain = subdomainValues(config);
  const triggers = section(config, 'triggers');
  const crons = triggers?.crons === undefined ? undefined : strings(triggers.crons, 'triggers.crons', 100);
  const customDomains = routeEntries.filter((entry) => entry.customDomain);
  for (const route of customDomains) if (!hostnamePattern.test(route.pattern)) throw invalid(`Custom domain ${route.pattern} must be a hostname without a path or wildcard.`);
  const consumerPlans = queueConsumers(config).map((consumer, index) => {
    const where = `queues.consumers[${index}]`;
    const timeout = optNumber(consumer.max_batch_timeout, `${where}.max_batch_timeout`, 3600);
    return {
      queue: resource(consumer.queue, `${where}.queue`),
      body: compact({
        type: 'worker',
        dead_letter_queue: consumer.dead_letter_queue === undefined ? undefined : resource(consumer.dead_letter_queue, `${where}.dead_letter_queue`),
        script_name: workerName,
        settings: compact({
          batch_size: optNumber(consumer.max_batch_size, `${where}.max_batch_size`, 10_000),
          max_retries: optNumber(consumer.max_retries, `${where}.max_retries`, 1000),
          max_wait_time_ms: timeout === undefined ? undefined : timeout * 1000,
          max_concurrency: optNumber(consumer.max_concurrency, `${where}.max_concurrency`, 1000),
          retry_delay: optNumber(consumer.retry_delay, `${where}.retry_delay`, 86_400),
        }),
      }),
    };
  });
  const workflowPlans = ownedWorkflows(config, workerName).map((workflow) => ({ name: workflow.name, body: workflowBody(workflow, workerName) }));
  const settings = compact({
    observability: optRecord(config.observability, 'observability') ?? { enabled: false },
    logpush: optBool(config.logpush, 'logpush'),
    tail_consumers: consumers(config.tail_consumers, 'tail_consumers'),
  });

  await step('the workers.dev subdomain', () => call(`${scriptPath}/subdomain`, { method: 'POST', json: subdomain, headers: { 'Cloudflare-Workers-Script-Api-Date': SUBDOMAIN_API_DATE } }));

  for (const route of customDomains) await step(`custom domain ${route.pattern}`, () => attachCustomDomain(call, accountId, workerName, route, notes));
  const zoneRoutes = routeEntries.filter((entry) => !entry.customDomain).map((entry) => entry.pattern);
  if (zoneRoutes.length) notes.push(`Zone routes were left unchanged: ${zoneRoutes.join(', ')}.`);

  if (crons) {
    await step('cron schedules', () => call(`${scriptPath}/schedules`, { method: 'PUT', json: crons.map((cron) => ({ cron })) }));
    notes.push(crons.length ? `Cron schedules set: ${crons.join(', ')}.` : 'Cron schedules cleared.');
  }

  for (const { queue: queueName, body } of consumerPlans) {
    await step(`the consumer for queue ${queueName}`, async () => {
      const queue = await findQueue(call, accountId, queueName);
      if (!queue) throw new WorkerBuildFailure('WORKER_TRIGGER_FAILED', `Updating the consumer for queue ${queueName} failed: the queue does not exist.`);
      const queueId = apiId(queue.queue_id, 'queue id');
      const existing = (Array.isArray(queue.consumers) ? queue.consumers : []).find((item): item is Json => isRecord(item) && (item.script === workerName || item.service === workerName));
      if (existing) await call(`/accounts/${accountId}/queues/${queueId}/consumers/${apiId(existing.consumer_id, 'queue consumer id')}`, { method: 'PUT', json: body });
      else await call(`/accounts/${accountId}/queues/${queueId}/consumers`, { method: 'POST', json: body });
    });
  }

  for (const { name, body } of workflowPlans) await step(`workflow ${name}`, () => call(`/accounts/${accountId}/workflows/${name}`, { method: 'PUT', json: body }));

  await step('observability settings', () => call(`${scriptPath}/script-settings`, { method: 'PATCH', json: settings }));
  return { notes };
}

export async function currentMigrationTag(call: CloudflareCall, accountId: string, workerName: string): Promise<{ exists: boolean; tag?: string }> {
  account(accountId);
  resource(workerName, 'Worker name');
  const service = await call<unknown>(`/accounts/${accountId}/workers/services/${workerName}`, { allowNotFound: true });
  if (!service) return { exists: false };
  const script = isRecord(service) && isRecord(service.default_environment) ? service.default_environment.script : undefined;
  const tag = isRecord(script) && typeof script.migration_tag === 'string' && script.migration_tag ? script.migration_tag : undefined;
  return tag ? { exists: true, tag } : { exists: true };
}

function nonEmptyList(value: unknown): boolean { return Array.isArray(value) && value.length > 0; }

export function requiredDeployScopes(config: WorkerDeployConfig, options: { d1Migrations: boolean; uploadOnly: boolean }): string[] {
  const scopes = [SCOPE_WORKERS_SCRIPTS_WRITE];
  const d1 = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  if (options.d1Migrations || d1.some((item) => !isRecord(item) || item.database_id === undefined)) scopes.push(SCOPE_D1_WRITE);
  if (nonEmptyList(config.r2_buckets)) scopes.push(SCOPE_R2_WRITE);
  const queues = isRecord(config.queues) ? config.queues : {};
  if (nonEmptyList(queues.producers) || nonEmptyList(queues.consumers)) scopes.push(SCOPE_QUEUES_WRITE);
  const routeList = Array.isArray(config.routes) ? config.routes : config.route !== undefined ? [config.route] : [];
  if (!options.uploadOnly && routeList.some((route) => isRecord(route) && route.custom_domain === true)) scopes.push(SCOPE_WORKERS_ROUTES_WRITE, SCOPE_ZONE_READ);
  return scopes;
}
