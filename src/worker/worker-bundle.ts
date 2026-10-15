import type { CommandResult } from '../../runner/sandbox';

export const WORKER_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;
export const WORKER_BUNDLE_MAX_FILES = 200;
export const WORKER_BUILD_TIMEOUT_MS = 240_000;
export const WORKER_CONFIG_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const;
const OUTPUT_DIR = '/tmp/gitflare-worker-bundle';
const SENTINEL = 'GITFLARE_WORKER_BUNDLE ';

export interface WorkerModule { name: string; contentType: string; content: Uint8Array<ArrayBuffer> }
export interface BindingRef { name: string; type: string }
export interface DurableObjectBinding { name: string; class_name: string; script_name?: string }
export interface WorkerBindingSource {
  vars: Record<string, unknown>;
  durableObjects: DurableObjectBinding[];
  bindings: BindingRef[];
}
export interface MigrationStep { tag: string; new_classes?: string[]; new_sqlite_classes?: string[]; renamed_classes?: { from: string; to: string }[]; deleted_classes?: string[] }
export interface ResolvedWorkerConfig {
  configPath: string;
  name?: string;
  main: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  assets: boolean;
  containers: string[];
  migrations: MigrationStep[];
  exports: Record<string, { type?: string }>;
  production: WorkerBindingSource;
  previews: WorkerBindingSource | null;
}
export interface WorkerBundle { config: ResolvedWorkerConfig; mainModule: string; modules: WorkerModule[]; totalBytes: number }

export class WorkerBuildFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message.slice(0, 700));
    this.name = 'WorkerBuildFailure';
  }
}

export interface BundleSandbox {
  check?(script: string, timeoutMs: number): Promise<CommandResult>;
  collect?(script: string, timeoutMs: number, capBytes: number): Promise<CommandResult>;
}

export function workerConfigPath(files: string[]): string | null {
  return WORKER_CONFIG_FILES.find((name) => files.includes(name)) ?? null;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// No Cloudflare credential is present in the sandbox; these unset lines guard against an image that sets one
export function workerBuildScript(configPath: string): string {
  return [
    'set -euo pipefail',
    'unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID CF_API_TOKEN CF_ACCOUNT_ID',
    'export WRANGLER_SEND_METRICS=false WRANGLER_LOG=error NO_COLOR=1',
    "test -x node_modules/.bin/wrangler || { echo 'Wrangler is not a dependency of this repository. Add wrangler 4.135 or later to devDependencies.' >&2; exit 64; }",
    `rm -rf ${OUTPUT_DIR}`,
    `node_modules/.bin/wrangler deploy --dry-run --config ${quote(configPath)} --outdir ${OUTPUT_DIR} > /tmp/gitflare-worker-build.log 2>&1 || { tail -c 3000 /tmp/gitflare-worker-build.log >&2; exit 65; }`,
  ].join('\n');
}

export function workerConfigScript(configPath: string): string {
  return `node --input-type=module -e ${quote(CONFIG_PROGRAM)} ${quote(configPath)}`;
}

export function workerBundleScript(configPath: string): string {
  return `node --input-type=module -e ${quote(BUNDLE_PROGRAM)} ${quote(configPath)} ${OUTPUT_DIR}`;
}

const CONFIG_PROGRAM = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const write = (...args) => process.stderr.write(args.map(String).join(' ') + '\\n');
console.log = console.info = console.warn = console.debug = write;
const require = createRequire(process.cwd() + '/');
let entry;
try { entry = require.resolve('wrangler'); } catch { process.exit(64); }
const wrangler = await import(pathToFileURL(entry).href);
const config = wrangler.unstable_readConfig({ config: process.argv[1] }, { hideWarnings: true });
const refs = (list, key = 'binding') => (Array.isArray(list) ? list : []).map((item) => item?.[key]).filter((name) => typeof name === 'string');
const single = (item, type) => item && typeof item.binding === 'string' ? [{ name: item.binding, type }] : [];
const source = (block) => {
  if (!block) return null;
  const bindings = [
    ...refs(block.kv_namespaces).map((name) => ({ name, type: 'kv_namespace' })),
    ...refs(block.d1_databases).map((name) => ({ name, type: 'd1' })),
    ...refs(block.r2_buckets).map((name) => ({ name, type: 'r2_bucket' })),
    ...refs(block.services).map((name) => ({ name, type: 'service' })),
    ...refs(block.queues?.producers).map((name) => ({ name, type: 'queue' })),
    ...refs(block.workflows).map((name) => ({ name, type: 'workflow' })),
    ...refs(block.vectorize).map((name) => ({ name, type: 'vectorize' })),
    ...refs(block.hyperdrive).map((name) => ({ name, type: 'hyperdrive' })),
    ...refs(block.analytics_engine_datasets).map((name) => ({ name, type: 'analytics_engine' })),
    ...refs(block.dispatch_namespaces).map((name) => ({ name, type: 'dispatch_namespace' })),
    ...refs(block.mtls_certificates).map((name) => ({ name, type: 'mtls_certificate' })),
    ...refs(block.pipelines).map((name) => ({ name, type: 'pipelines' })),
    ...refs(block.secrets_store_secrets).map((name) => ({ name, type: 'secrets_store_secret' })),
    ...refs(block.artifacts).map((name) => ({ name, type: 'artifacts' })),
    ...refs(block.ai_search).map((name) => ({ name, type: 'ai_search' })),
    ...refs(block.ai_search_namespaces).map((name) => ({ name, type: 'ai_search_namespace' })),
    ...refs(block.vpc_services).map((name) => ({ name, type: 'vpc_service' })),
    ...refs(block.vpc_networks).map((name) => ({ name, type: 'vpc_network' })),
    ...refs(block.worker_loaders).map((name) => ({ name, type: 'worker_loader' })),
    ...refs(block.flagship).map((name) => ({ name, type: 'flagship' })),
    ...refs(block.send_email, 'name').map((name) => ({ name, type: 'send_email' })),
    ...refs(block.ratelimits, 'name').map((name) => ({ name, type: 'ratelimit' })),
    ...refs(block.unsafe?.bindings, 'name').map((name) => ({ name, type: 'unsafe' })),
    ...refs(block.logfwdr?.bindings, 'name').map((name) => ({ name, type: 'logfwdr' })),
    ...single(block.ai, 'ai'), ...single(block.browser, 'browser'), ...single(block.images, 'images'),
    ...single(block.version_metadata, 'version_metadata'), ...single(block.analytics, 'analytics'),
    ...single(block.stream, 'stream'), ...single(block.media, 'media'),
  ];
  const durableObjects = (block.durable_objects?.bindings ?? []).map((item) => ({ name: item.name, class_name: item.class_name, ...(item.script_name ? { script_name: item.script_name } : {}) }));
  return { vars: block.vars ?? {}, durableObjects, bindings };
};
const output = {
  configPath: process.argv[1],
  name: config.name,
  main: config.main,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags ?? [],
  assets: !!config.assets?.directory,
  containers: (config.containers ?? []).map((item) => item.class_name).filter(Boolean),
  migrations: config.migrations ?? [],
  exports: config.exports ?? {},
  production: source(config),
  previews: source(config.previews),
};
process.stdout.write('${SENTINEL}' + JSON.stringify(output) + '\\n');
`;

const BUNDLE_PROGRAM = `
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const [configPath, outdir] = process.argv.slice(1);
const files = [];
let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(path); continue; }
    const name = relative(outdir, path);
    if (name === 'README.md' || name.endsWith('.map') || name === 'bundle-meta.json') continue;
    total += statSync(path).size;
    if (total > ${WORKER_BUNDLE_MAX_BYTES} || files.length >= ${WORKER_BUNDLE_MAX_FILES}) { process.stderr.write('BUNDLE_TOO_LARGE'); process.exit(66); }
    files.push({ name, data: readFileSync(path).toString('base64') });
  }
};
walk(outdir);
process.stdout.write('${SENTINEL}' + JSON.stringify({ configPath, files }) + '\\n');
`;

function sentinelPayload(stdout: string): unknown {
  const line = stdout.split('\n').reverse().find((value) => value.startsWith(SENTINEL));
  if (!line) throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', 'The Worker build did not report its output.');
  try { return JSON.parse(line.slice(SENTINEL.length)); }
  catch { throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', 'The Worker build reported malformed output.'); }
}

const bindingName = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function bindingSource(value: unknown): WorkerBindingSource | null {
  if (!record(value)) return null;
  const vars = record(value.vars) ? value.vars : {};
  const durableObjects = Array.isArray(value.durableObjects) ? value.durableObjects.filter((item): item is DurableObjectBinding => record(item) && typeof item.name === 'string' && bindingName.test(item.name) && typeof item.class_name === 'string' && bindingName.test(item.class_name) && (item.script_name === undefined || typeof item.script_name === 'string')) : [];
  const bindings = Array.isArray(value.bindings) ? value.bindings.filter((item): item is BindingRef => record(item) && typeof item.name === 'string' && typeof item.type === 'string').map((item) => ({ name: item.name.slice(0, 64), type: item.type.slice(0, 40) })) : [];
  return { vars: Object.fromEntries(Object.entries(vars).filter(([name]) => bindingName.test(name))), durableObjects, bindings };
}

export function parseWorkerConfig(stdout: string): ResolvedWorkerConfig | null {
  const value = sentinelPayload(stdout);
  if (!record(value)) throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', 'The Worker configuration could not be read.');
  if (typeof value.main !== 'string' || !value.main) return null;
  if (typeof value.compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibilityDate)) throw new WorkerBuildFailure('WORKER_COMPATIBILITY_DATE_REQUIRED', 'Set compatibility_date in the Wrangler configuration.');
  const migrations = Array.isArray(value.migrations) ? value.migrations.filter((step): step is MigrationStep => record(step) && typeof step.tag === 'string') : [];
  return {
    configPath: String(value.configPath),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    main: value.main,
    compatibilityDate: value.compatibilityDate,
    compatibilityFlags: strings(value.compatibilityFlags).slice(0, 50),
    assets: value.assets === true,
    containers: strings(value.containers),
    migrations: migrations.map((step) => ({ tag: step.tag, ...(step.new_classes ? { new_classes: strings(step.new_classes) } : {}), ...(step.new_sqlite_classes ? { new_sqlite_classes: strings(step.new_sqlite_classes) } : {}), ...(Array.isArray(step.renamed_classes) ? { renamed_classes: step.renamed_classes.filter((item) => record(item) && typeof item.from === 'string' && typeof item.to === 'string') } : {}), ...(step.deleted_classes ? { deleted_classes: strings(step.deleted_classes) } : {}) })),
    exports: record(value.exports) ? Object.fromEntries(Object.entries(value.exports).filter(([name, entry]) => bindingName.test(name) && record(entry)).map(([name, entry]) => [name, { type: typeof (entry as Record<string, unknown>).type === 'string' ? String((entry as Record<string, unknown>).type) : undefined }])) : {},
    production: bindingSource(value.production) ?? { vars: {}, durableObjects: [], bindings: [] },
    previews: bindingSource(value.previews),
  };
}

export function moduleContentType(name: string): string | null {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'js' || extension === 'mjs') return 'application/javascript+module';
  if (extension === 'cjs') return 'application/javascript';
  if (extension === 'wasm') return 'application/wasm';
  if (extension === 'json') return 'application/json';
  if (['txt', 'html', 'sql', 'md', 'csv', 'svg', 'css'].includes(extension)) return 'text/plain';
  if (extension === 'bin') return 'application/octet-stream';
  return null;
}

export function mainModuleName(main: string): string {
  const base = main.split('/').pop() ?? main;
  const dot = base.lastIndexOf('.');
  return `${dot > 0 ? base.slice(0, dot) : base}.js`;
}

const modulePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export function parseWorkerBundle(stdout: string, config: ResolvedWorkerConfig): WorkerBundle {
  const value = sentinelPayload(stdout);
  if (!record(value) || !Array.isArray(value.files)) throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', 'The Worker bundle could not be read.');
  if (value.files.length > WORKER_BUNDLE_MAX_FILES) throw new WorkerBuildFailure('WORKER_BUNDLE_TOO_LARGE', `The Worker bundle has more than ${WORKER_BUNDLE_MAX_FILES} files.`);
  const modules: WorkerModule[] = [];
  let totalBytes = 0;
  for (const file of value.files) {
    if (!record(file) || typeof file.name !== 'string' || typeof file.data !== 'string' || !modulePath.test(file.name) || file.name.length > 256) throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', 'The Worker bundle contains an unsafe file name.');
    const contentType = moduleContentType(file.name);
    if (!contentType) throw new WorkerBuildFailure('WORKER_MODULE_UNSUPPORTED', `The Worker bundle contains an unsupported module type: ${file.name}.`);
    const content = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
    totalBytes += content.byteLength;
    if (totalBytes > WORKER_BUNDLE_MAX_BYTES) throw new WorkerBuildFailure('WORKER_BUNDLE_TOO_LARGE', `The Worker bundle exceeds ${WORKER_BUNDLE_MAX_BYTES / 1024 / 1024} MiB.`);
    modules.push({ name: file.name, contentType, content });
  }
  const mainModule = mainModuleName(config.main);
  const main = modules.find((module) => module.name === mainModule);
  if (!main) throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', `The Worker build did not produce ${mainModule}.`);
  return { config, mainModule, modules: [main, ...modules.filter((module) => module !== main)], totalBytes };
}

function failureDetail(result: CommandResult): string {
  return (result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(-500);
}

export async function readWorkerConfig(sandbox: BundleSandbox, configPath: string): Promise<ResolvedWorkerConfig | null> {
  if (!sandbox.collect) throw new WorkerBuildFailure('WORKER_BUILD_UNAVAILABLE', 'The runner cannot build Worker bundles.');
  const result = await sandbox.collect(workerConfigScript(configPath), 60_000, 1024 * 1024);
  if (result.exitCode === 64) return null;
  if (result.exitCode !== 0) throw new WorkerBuildFailure('WORKER_CONFIG_INVALID', `The Wrangler configuration could not be read. ${failureDetail(result)}`);
  return parseWorkerConfig(result.stdout);
}

export async function buildWorkerBundle(sandbox: BundleSandbox, config: ResolvedWorkerConfig): Promise<WorkerBundle> {
  if (!sandbox.check || !sandbox.collect) throw new WorkerBuildFailure('WORKER_BUILD_UNAVAILABLE', 'The runner cannot build Worker bundles.');
  const build = await sandbox.check(workerBuildScript(config.configPath), WORKER_BUILD_TIMEOUT_MS);
  if (build.exitCode === 64) throw new WorkerBuildFailure('WRANGLER_DEPENDENCY_REQUIRED', 'Wrangler is not a dependency of this repository. Add wrangler 4.135 or later to devDependencies.');
  if (build.exitCode !== 0) throw new WorkerBuildFailure('WORKER_BUILD_FAILED', `wrangler deploy --dry-run failed (exit ${build.exitCode}). ${failureDetail(build)}`);
  const output = await sandbox.collect(workerBundleScript(config.configPath), 60_000, Math.ceil(WORKER_BUNDLE_MAX_BYTES * 1.4) + 65_536);
  if (output.exitCode === 66) throw new WorkerBuildFailure('WORKER_BUNDLE_TOO_LARGE', `The Worker bundle exceeds ${WORKER_BUNDLE_MAX_BYTES / 1024 / 1024} MiB or ${WORKER_BUNDLE_MAX_FILES} files.`);
  if (output.exitCode !== 0) throw new WorkerBuildFailure('WORKER_BUILD_OUTPUT_INVALID', `The Worker bundle could not be collected. ${failureDetail(output)}`);
  return parseWorkerBundle(output.stdout, config);
}

export type PreviewBinding = { type: 'plain_text'; text: string } | { type: 'json'; json: unknown } | { type: 'durable_object_namespace'; class_name: string };
export interface PreviewBindingPlan { env: Record<string, PreviewBinding>; notes: string[] }

export function declaredDurableObjectClasses(config: ResolvedWorkerConfig): Set<string> {
  const declared = new Set<string>();
  for (const step of config.migrations) {
    for (const name of step.deleted_classes ?? []) declared.delete(name);
    for (const { from, to } of step.renamed_classes ?? []) { declared.delete(from); declared.add(to); }
    for (const name of [...(step.new_classes ?? []), ...(step.new_sqlite_classes ?? [])]) declared.add(name);
  }
  for (const [name, entry] of Object.entries(config.exports)) if (entry.type === 'durable-object') declared.add(name);
  return declared;
}

export function hostedPreviewBindings(config: ResolvedWorkerConfig): PreviewBindingPlan {
  const source = config.previews ?? config.production;
  const env: Record<string, PreviewBinding> = {};
  const notes: string[] = [];
  for (const [name, value] of Object.entries(source.vars)) {
    if (typeof value === 'string') env[name] = { type: 'plain_text', text: value.slice(0, 5120) };
    else env[name] = { type: 'json', json: value };
  }
  const declared = declaredDurableObjectClasses(config);
  for (const binding of source.durableObjects) {
    if (binding.script_name) notes.push(`Binding ${binding.name} (Durable Object in ${binding.script_name}) is not available in hosted previews.`);
    else if (!declared.has(binding.class_name)) notes.push(`Binding ${binding.name} (Durable Object ${binding.class_name}) has no migration or export and is not available in hosted previews.`);
    else env[binding.name] = { type: 'durable_object_namespace', class_name: binding.class_name };
  }
  for (const binding of source.bindings) notes.push(`Binding ${binding.name} (${binding.type}) is not available in hosted previews.`);
  if (config.containers.length) notes.push('Containers are not available in hosted previews.');
  return { env, notes };
}

export interface PreviewMigrations { old_tag?: string; new_tag: string; steps: Omit<MigrationStep, 'tag'>[] }

export function previewMigrations(config: ResolvedWorkerConfig, currentTag: string | undefined): PreviewMigrations | undefined {
  const steps = config.migrations;
  if (!steps.length) return undefined;
  const strip = (list: MigrationStep[]) => list.map(({ tag: _tag, ...rest }) => rest);
  const newTag = steps[steps.length - 1].tag;
  if (!currentTag) return { new_tag: newTag, steps: strip(steps) };
  const index = steps.findIndex((step) => step.tag === currentTag);
  if (index === steps.length - 1) return undefined;
  return { old_tag: currentTag, new_tag: newTag, steps: strip(index === -1 ? steps : steps.slice(index + 1)) };
}

export function previewExports(config: ResolvedWorkerConfig): Record<string, { type: string }> | undefined {
  const entries = Object.entries(config.exports).filter(([, entry]) => entry.type === 'durable-object');
  return entries.length ? Object.fromEntries(entries.map(([name]) => [name, { type: 'durable-object' }])) : undefined;
}
