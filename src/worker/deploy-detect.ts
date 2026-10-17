import type { ArtifactRepo } from './artifacts';
import type { CloudflareCall } from './cloudflare-deploy';
import { parseJsonc, parseToml } from './config-text';
import { ApiError } from './domain';
import type { DeployTarget } from './deployments';
import { ENVIRONMENT_NAME, orderedEnvironments, PRODUCTION, type DeployEnvironment } from './deploy-environments';
import { detectPackageManager, LOCKFILES, runnerFor, type PackageManager } from './package-manager';
import { workersSubdomain } from './preview-access';
import { requiredDeployScopes, subdomainValues } from './worker-provisioning';
import { WORKER_CONFIG_FILES } from './worker-bundle';

export const SCAN_ENTRY_LIMIT = 20_000;
const SCAN_BATCH = 16;
const DETECT_TARGETS_MAX = 5;
const WALK_SKIP = new Set(['node_modules', '.git', '.gitflare', '.wrangler', '.pnpm-store', '.yarn']);
const CONFIG_SKIP = new Set(['fixtures', '__fixtures__', 'test-fixtures', '__tests__', 'test', 'tests', 'dist', 'build', '.output', 'examples']);
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];
const VITE_PLUGIN = '@cloudflare/vite-plugin';
const INHERITABLE = ['main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls', 'routes', 'route', 'assets', 'build', 'triggers', 'migrations'];
const workerName = /^[a-zA-Z0-9_-]{1,63}$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

type Json = Record<string, unknown>;
type TreeSource = Pick<ArtifactRepo, 'readTree' | 'log'>;
export type ResourceStatus = 'exists' | 'create' | 'missing' | 'unknown';
export type SetupWarningKind = 'inherited-route' | 'shared-resource' | 'production-service' | 'send-email';

export interface RepositoryScan { commitSha: string; files: Map<string, string>; truncated: boolean }
export interface DetectedResource { type: 'd1' | 'r2' | 'queue'; name: string; id?: string; binding?: string; status?: ResourceStatus }
export interface DetectedTarget {
  workerName: string;
  configPath: string;
  packageDir: string;
  buildCommand?: string;
  buildReasons: string[];
  d1Migrations: boolean;
  watchPaths: string[];
  dependsOn: string[];
  resources: DetectedResource[];
  routes: string[];
  customDomains: string[];
  workersDev: boolean;
  requiredScopes: string[];
  exists?: boolean | null;
  urls?: string[];
}
export interface SetupWarning { id: string; kind: SetupWarningKind; environment: DeployEnvironment; configPath: string; message: string }
export interface DetectedEnvironment { targets: DetectedTarget[]; warnings: SetupWarning[] }
export interface DetectedConfig { path: string; workerName?: string; environments: DeployEnvironment[]; error?: string }
export interface AccountFacts { connected: true; accountId: string; accountName?: string; source: 'repository' | 'workspace'; subdomain: string | null; scopes?: string[]; requiredScopes: string[]; missingScopes?: string[]; notes: string[] }
export interface ConnectionFacts { accountName?: string; scopes?: string[] }
export interface DetectedSetup {
  commitSha: string;
  fingerprint: string;
  files: Record<string, string>;
  packageManager: PackageManager | null;
  configs: DetectedConfig[];
  environments: Partial<Record<DeployEnvironment, DetectedEnvironment>>;
  errors: string[];
  notes: string[];
  truncated: boolean;
  account?: AccountFacts | { connected: false; reason: string };
}
export interface SavedDetection { fingerprint: string; commitSha: string; files: Record<string, string>; appliedAt: string; appliedBy: string; acknowledged: string[] }
export interface SetupChange { path: string; change: 'added' | 'removed' | 'modified' }

const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): Json[] => Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function join(directory: string, relative: string): string | null {
  const parts = directory ? directory.split('/') : [];
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

export async function scanRepository(source: TreeSource, commitSha: string, limit = SCAN_ENTRY_LIMIT): Promise<RepositoryScan> {
  const [head] = await source.log({ ref: commitSha, limit: 1 });
  if (!head || head.hash !== commitSha) throw new ApiError(409, 'DEPLOY_SETUP_HEAD_MISSING', 'The default branch head could not be read.');
  const files = new Map<string, string>();
  let pending: [string, string][] = [[head.treeHash, '']];
  let entries = 0;
  while (pending.length) {
    const next: [string, string][] = [];
    for (let start = 0; start < pending.length; start += SCAN_BATCH) {
      const batch = pending.slice(start, start + SCAN_BATCH);
      const trees = await Promise.all(batch.map(([hash]) => source.readTree(hash)));
      for (const [position, tree] of trees.entries()) {
        for (const entry of tree ?? []) {
          if (++entries > limit) return { commitSha, files, truncated: true };
          const path = `${batch[position][1]}${entry.name}`;
          if (entry.type === 'tree') { if (!WALK_SKIP.has(entry.name)) next.push([entry.hash, `${path}/`]); }
          else if (entry.type === 'blob' || entry.type === 'exec') files.set(path, entry.hash);
        }
      }
    }
    pending = next;
  }
  return { commitSha, files, truncated: false };
}

export function configPaths(files: Iterable<string>): string[] {
  const byDirectory = new Map<string, string>();
  for (const path of files) {
    const name = basename(path);
    const rank = WORKER_CONFIG_FILES.indexOf(name as typeof WORKER_CONFIG_FILES[number]);
    if (rank < 0 || path.split('/').slice(0, -1).some((segment) => CONFIG_SKIP.has(segment) || WALK_SKIP.has(segment))) continue;
    const directory = dirname(path);
    const current = byDirectory.get(directory);
    if (!current || WORKER_CONFIG_FILES.indexOf(basename(current) as typeof WORKER_CONFIG_FILES[number]) > rank) byDirectory.set(directory, path);
  }
  return [...byDirectory.values()].sort();
}

export function parseWranglerConfig(path: string, content: string): Json {
  const parsed = path.endsWith('.toml') ? parseToml(content) : parseJsonc(content);
  if (!isRecord(parsed)) throw new Error('The configuration is not an object');
  return parsed;
}

function environmentConfig(top: Json, block: Json, name: string, environment: string): Json {
  const inherited = Object.fromEntries(INHERITABLE.filter((key) => top[key] !== undefined).map((key) => [key, top[key]]));
  return { ...inherited, ...block, name: text(block.name) ?? `${name}-${environment}` };
}

export function declaresRoutes(block: unknown): boolean {
  return isRecord(block) && (block.routes !== undefined || block.route !== undefined);
}

export function environmentBlock(config: Json, environment: string): Json | null {
  const environments = isRecord(config.env) ? config.env : {};
  return isRecord(environments[environment]) ? environments[environment] : null;
}

interface RouteInfo { routes: string[]; customDomains: string[] }

function routeInfo(config: Json): RouteInfo {
  const value = config.routes !== undefined ? config.routes : config.route !== undefined ? [config.route] : [];
  const entries = Array.isArray(value) ? value : [];
  const routes: string[] = [];
  const customDomains: string[] = [];
  for (const item of entries) {
    if (typeof item === 'string') routes.push(item);
    else if (isRecord(item) && typeof item.pattern === 'string') (item.custom_domain === true ? customDomains : routes).push(item.pattern);
  }
  return { routes, customDomains };
}

export function workersDevEnabled(config: Json): boolean {
  try { return subdomainValues(config).enabled; } catch { return false; }
}

export function productionOnlyConfig(config: Json, environment: DeployEnvironment, ownRoutes = false): Json {
  if (environment === PRODUCTION || ownRoutes || (config.routes === undefined && config.route === undefined)) return config;
  const { routes: _routes, route: _route, ...rest } = config;
  return rest;
}

function resources(config: Json): DetectedResource[] {
  const found: DetectedResource[] = [];
  const add = (item: DetectedResource) => { if (!found.some((entry) => entry.type === item.type && entry.name === item.name)) found.push(item); };
  for (const item of list(config.d1_databases)) {
    const name = text(item.database_name) ?? text(item.database_id);
    if (name) add({ type: 'd1', name, ...(text(item.database_id) ? { id: text(item.database_id) } : {}), ...(text(item.binding) ? { binding: text(item.binding) } : {}) });
  }
  for (const item of list(config.r2_buckets)) {
    const name = text(item.bucket_name);
    if (name) add({ type: 'r2', name, ...(text(item.binding) ? { binding: text(item.binding) } : {}) });
  }
  const queues = isRecord(config.queues) ? config.queues : {};
  for (const item of list(queues.producers)) { const name = text(item.queue); if (name) add({ type: 'queue', name, ...(text(item.binding) ? { binding: text(item.binding) } : {}) }); }
  for (const item of list(queues.consumers)) {
    for (const name of [text(item.queue), text(item.dead_letter_queue)]) if (name) add({ type: 'queue', name });
  }
  return found;
}

function dependencies(config: Json, self: string): string[] {
  const services = list(config.services).map((item) => text(item.service));
  const durable = isRecord(config.durable_objects) ? list(config.durable_objects.bindings).map((item) => text(item.script_name)) : [];
  return [...new Set([...services, ...durable].filter((name): name is string => !!name && name !== self))];
}

function hasMigrations(config: Json, directory: string, directories: Set<string>, files: Map<string, string>): boolean {
  return list(config.d1_databases).some((item) => {
    if (typeof item.migrations_dir !== 'string') return false;
    const path = join(directory, item.migrations_dir);
    return path !== null && directories.has(path) && [...files.keys()].some((file) => file.startsWith(`${path}/`) && file.endsWith('.sql'));
  });
}

function packageDirectory(directory: string, files: Map<string, string>): string | null {
  let current: string | null = directory;
  for (;;) {
    if (files.has(current ? `${current}/package.json` : 'package.json')) return current;
    if (!current) return null;
    current = dirname(current);
  }
}

function manifest(content: string | null): Json | null {
  if (content === null) return null;
  try { const parsed = JSON.parse(content) as unknown; return isRecord(parsed) ? parsed : null; } catch { return null; }
}

function dependsOnPlugin(pkg: Json | null): boolean {
  return [pkg?.dependencies, pkg?.devDependencies].some((deps) => isRecord(deps) && VITE_PLUGIN in deps);
}

export function buildCommandFor(manager: PackageManager, directory: string, name: string | undefined): string {
  if (!directory) return `${manager} run build`;
  if (manager === 'pnpm') return name && packageName.test(name) ? `pnpm --filter ${name} build` : `pnpm --dir ${directory} run build`;
  if (manager === 'npm') return `npm --prefix ${directory} run build`;
  return `cd ${directory} && yarn run build`;
}

function sharedWatchPaths(files: Map<string, string>, directories: Set<string>): string[] {
  return [
    ...(directories.has('packages') ? ['packages/**'] : []),
    ...LOCKFILES.filter((name) => files.has(name)),
    ...(files.has('package.json') ? ['package.json'] : []),
    ...(files.has('pnpm-workspace.yaml') ? ['pnpm-workspace.yaml'] : []),
  ];
}

function order(targets: DetectedTarget[], environment: DeployEnvironment, errors: string[]): DetectedTarget[] {
  const names = new Set(targets.map((target) => target.workerName));
  const remaining = new Map(targets.map((target) => [target.workerName, target.dependsOn.filter((name) => names.has(name))]));
  const ordered: DetectedTarget[] = [];
  while (remaining.size) {
    const ready = targets.find((target) => remaining.has(target.workerName) && remaining.get(target.workerName)!.every((name) => !remaining.has(name)));
    if (!ready) {
      const cycle = [...remaining.keys()];
      errors.push(`${environment}: service bindings form a cycle between ${cycle.join(', ')}, so no deploy order exists. Remove one binding or deploy one Worker without it first.`);
      return [...ordered, ...targets.filter((target) => remaining.has(target.workerName))];
    }
    ordered.push(ready);
    remaining.delete(ready.workerName);
  }
  return ordered;
}

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function setupFingerprint(files: Record<string, string>): Promise<string> {
  return digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

export function setupChanges(saved: Record<string, string>, current: Record<string, string>): SetupChange[] {
  const paths = [...new Set([...Object.keys(saved), ...Object.keys(current)])].sort();
  return paths.flatMap((path): SetupChange[] => saved[path] === current[path] ? [] : [{ path, change: !(path in saved) ? 'added' : !(path in current) ? 'removed' : 'modified' }]);
}

interface ParsedConfig {
  path: string;
  directory: string;
  name: string;
  top: Json;
  environments: Record<string, Json>;
  packageDir: string | null;
  packageJson: Json | null;
  buildReasons: string[];
}

export async function detectDeploySetup(scan: RepositoryScan, read: (path: string) => Promise<string | null>): Promise<DetectedSetup> {
  const { files } = scan;
  const directories = new Set<string>();
  for (const path of files.keys()) for (let directory = dirname(path); directory; directory = dirname(directory)) directories.add(directory);
  const rootFiles = [...files.keys()].filter((path) => !path.includes('/'));
  const rootPackage = files.has('package.json') ? await read('package.json') : null;
  const plan = detectPackageManager({ files: rootFiles, packageJson: rootPackage, lockHead: files.has('pnpm-lock.yaml') ? (await read('pnpm-lock.yaml'))?.slice(0, 200) : null });
  const packageManager = plan ? runnerFor(plan) : null;
  const errors: string[] = [];
  const notes: string[] = [];
  const configs: DetectedConfig[] = [];
  const parsed: ParsedConfig[] = [];
  const fingerprintFiles: Record<string, string> = {};
  const manifests = new Map<string, Json | null>();
  const readManifest = async (directory: string) => {
    if (!manifests.has(directory)) manifests.set(directory, manifest(await read(directory ? `${directory}/package.json` : 'package.json')));
    return manifests.get(directory) ?? null;
  };
  if (scan.truncated) notes.push(`The repository has more than ${SCAN_ENTRY_LIMIT} files and folders; only the first were searched for Wrangler configs.`);

  for (const path of configPaths(files.keys())) {
    fingerprintFiles[path] = files.get(path)!;
    const content = await read(path);
    let top: Json;
    try { top = parseWranglerConfig(path, content ?? ''); }
    catch (error) {
      const detail = `${path} could not be read: ${error instanceof Error ? error.message : 'invalid syntax'}.`;
      configs.push({ path, environments: [], error: detail });
      errors.push(detail);
      continue;
    }
    const name = text(top.name);
    if (!name || !workerName.test(name)) {
      const detail = `${path} has no valid top-level "name", so the Worker cannot be named.`;
      configs.push({ path, environments: [], error: detail });
      errors.push(detail);
      continue;
    }
    const directory = dirname(path);
    const environments: Record<string, Json> = {};
    for (const [environment, block] of Object.entries(isRecord(top.env) ? top.env : {})) {
      if (!isRecord(block)) continue;
      if (environment === PRODUCTION) notes.push(`${path} defines env.production, which Gitflare ignores: production is always the top level of the config.`);
      else if (!ENVIRONMENT_NAME.test(environment)) notes.push(`${path} defines env.${environment}; environment names must be lowercase letters, digits and dashes starting with a letter, so it is not deployed.`);
      else environments[environment] = block;
    }
    const packageDir = packageDirectory(directory, files);
    const packageJson = packageDir === null ? null : await readManifest(packageDir);
    const buildReasons: string[] = [];
    const viteConfig = VITE_CONFIGS.map((file) => join(directory, file)!).find((file) => files.has(file));
    if ((viteConfig && (await read(viteConfig))?.includes(VITE_PLUGIN)) || dependsOnPlugin(packageJson)) buildReasons.push('uses the Cloudflare Vite plugin');
    const main = text(top.main);
    if (main) { const resolved = join(directory, main); if (!resolved || !files.has(resolved)) buildReasons.push(`main ${main} is not committed`); }
    const assets = isRecord(top.assets) ? text(top.assets.directory) : undefined;
    if (assets) { const resolved = join(directory, assets); if (!resolved || !directories.has(resolved)) buildReasons.push(`assets directory ${assets} is not committed`); }
    configs.push({ path, workerName: name, environments: orderedEnvironments([PRODUCTION, ...Object.keys(environments)]) });
    parsed.push({ path, directory, name, top, environments, packageDir, packageJson, buildReasons });
  }
  if (!parsed.length && !errors.length) notes.push('No wrangler.jsonc, wrangler.json or wrangler.toml was found outside node_modules, test fixtures and .gitflare.');

  const shared = sharedWatchPaths(files, directories);
  const targetFor = (config: ParsedConfig, environment: DeployEnvironment): DetectedTarget => {
    const block = environment === PRODUCTION ? null : config.environments[environment];
    const resolved = block ? environmentConfig(config.top, block, config.name, environment) : config.top;
    const effective = productionOnlyConfig(resolved, environment, declaresRoutes(block));
    const name = text(effective.name)!;
    const scripts = isRecord(config.packageJson?.scripts) ? config.packageJson!.scripts as Json : {};
    let buildCommand: string | undefined;
    if (config.buildReasons.length) {
      if (packageManager && config.packageDir !== null && typeof scripts.build === 'string' && scripts.build.trim()) buildCommand = buildCommandFor(packageManager, config.packageDir, text(config.packageJson?.name));
      else errors.push(`${config.path} needs a build (${config.buildReasons.join('; ')}), but ${config.packageDir === null ? 'no package.json was found above it' : `${config.packageDir ? `${config.packageDir}/` : ''}package.json has no "build" script`}.`);
    }
    const routes = routeInfo(effective);
    const d1Migrations = hasMigrations(effective, config.directory, directories, files);
    const watchPaths = config.packageDir ? [...new Set([`${config.packageDir}/**`, ...(config.directory !== config.packageDir && config.directory ? [`${config.directory}/**`] : []), ...shared])] : [];
    return {
      workerName: name, configPath: config.path, packageDir: config.packageDir ?? config.directory,
      ...(buildCommand ? { buildCommand } : {}), buildReasons: config.buildReasons,
      d1Migrations,
      watchPaths, dependsOn: dependencies(effective, name), resources: resources(effective),
      routes: routes.routes, customDomains: routes.customDomains,
      workersDev: workersDevEnabled(effective),
      requiredScopes: requiredDeployScopes(effective, { d1Migrations, uploadOnly: false }),
    };
  };

  const result: Partial<Record<DeployEnvironment, DetectedEnvironment>> = {};
  const productionTargets = parsed.map((config) => targetFor(config, PRODUCTION));
  if (productionTargets.length) result.production = { targets: order(productionTargets, PRODUCTION, errors), warnings: [] };
  const productionWorkers = new Set(productionTargets.map((target) => target.workerName));
  const productionResources = productionTargets.flatMap((target) => target.resources);
  const names = orderedEnvironments(parsed.flatMap((config) => Object.keys(config.environments))).filter((environment) => environment !== PRODUCTION);
  for (const environment of names) {
    const members = parsed.filter((config) => config.environments[environment]);
    for (const config of parsed.filter((item) => !item.environments[environment])) notes.push(`${config.path} has no env.${environment} block, so ${environment} does not deploy ${config.name}.`);
    const targets = members.map((config) => targetFor(config, environment));
    const workers = new Set(targets.map((target) => target.workerName));
    const warnings: SetupWarning[] = [];
    const warn = (kind: SetupWarningKind, config: ParsedConfig, detail: string, message: string) => warnings.push({ id: `${kind}:${environment}:${config.path}${detail ? `:${detail}` : ''}`, kind, environment, configPath: config.path, message });
    for (const [position, config] of members.entries()) {
      const target = targets[position];
      const block = config.environments[environment];
      const inherited = routeInfo(config.top);
      if ((inherited.routes.length || inherited.customDomains.length) && !declaresRoutes(block)) {
        warn('inherited-route', config, '', `${target.workerName} inherits the production routes ${[...inherited.customDomains, ...inherited.routes].join(', ')} because env.${environment} in ${config.path} does not set "routes". wrangler deploy --env ${environment} would attach them; Gitflare applies routes and custom domains only to production unless the environment declares its own. Add "routes": [] to env.${environment}.`);
      }
      for (const resource of target.resources) {
        const kind = resource.type === 'd1' ? 'D1 database' : resource.type === 'r2' ? 'R2 bucket' : 'queue';
        if (productionResources.some((item) => item.type === resource.type && (item.name === resource.name || (!!item.id && item.id === resource.id)))) warn('shared-resource', config, `${resource.type}:${resource.name}`, `${target.workerName} binds ${kind} ${resource.name}, the same one production uses, so ${environment} would read and write production data. Give env.${environment} its own ${kind}.`);
      }
      for (const service of target.dependsOn) {
        if (productionWorkers.has(service) && !workers.has(service)) warn('production-service', config, service, `${target.workerName} has a binding to ${service}, a production Worker. Point env.${environment} at the ${environment} Worker instead.`);
      }
      for (const binding of list(block.send_email)) {
        const allowed = Array.isArray(binding.allowed_destination_addresses) && binding.allowed_destination_addresses.length > 0;
        const label = text(binding.name) ?? 'send_email';
        if (!text(binding.destination_address) && !allowed) warn('send-email', config, label, `${target.workerName} send_email binding ${label} has no destination_address or allowed_destination_addresses: ${environment} can email real recipients.`);
      }
    }
    result[environment] = { targets: order(targets, environment, errors), warnings };
  }
  for (const [environment, value] of Object.entries(result) as [DeployEnvironment, DetectedEnvironment][]) {
    if (value.targets.length > DETECT_TARGETS_MAX) errors.push(`${environment} has ${value.targets.length} Workers; Gitflare deploys at most ${DETECT_TARGETS_MAX} per environment.`);
    const seen = new Set<string>();
    for (const target of value.targets) {
      if (seen.has(target.workerName)) errors.push(`${environment}: more than one config deploys ${target.workerName}.`);
      seen.add(target.workerName);
    }
  }
  return { commitSha: scan.commitSha, fingerprint: await setupFingerprint(fingerprintFiles), files: fingerprintFiles, packageManager, configs, environments: result, errors: [...new Set(errors)], notes, truncated: scan.truncated };
}

async function status(check: () => Promise<boolean>, absent: ResourceStatus = 'create'): Promise<ResourceStatus> {
  try { return await check() ? 'exists' : absent; } catch { return 'unknown'; }
}

export function workersDevUrl(worker: string, subdomain: string): string {
  return `https://${worker}.${subdomain}.workers.dev`;
}

export async function withAccountFacts(setup: DetectedSetup, call: CloudflareCall, accountId: string, source: 'repository' | 'workspace', connection: ConnectionFacts = {}): Promise<DetectedSetup> {
  const notes: string[] = [];
  let subdomain: string | null = null;
  try { subdomain = await workersSubdomain(call, accountId); }
  catch (error) { notes.push(error instanceof ApiError ? error.detail : 'The workers.dev subdomain could not be read.'); }
  let workers: Set<string> | null = null;
  try {
    const scripts = await call<unknown>(`/accounts/${accountId}/workers/scripts`);
    workers = new Set((Array.isArray(scripts) ? scripts : []).map((item) => isRecord(item) ? item.id : undefined).filter((id): id is string => typeof id === 'string'));
  } catch { notes.push('The Workers in the account could not be listed with this connection.'); }
  const cache = new Map<string, Promise<ResourceStatus>>();
  const lookup = (resource: DetectedResource): Promise<ResourceStatus> => {
    const key = `${resource.type}:${resource.id ?? resource.name}`;
    if (!cache.has(key)) cache.set(key, resource.type === 'd1'
      ? resource.id
        ? status(async () => !!await call(`/accounts/${accountId}/d1/database/${resource.id}`, { allowNotFound: true }), 'missing')
        : status(async () => { const found = await call<unknown>(`/accounts/${accountId}/d1/database`, { query: { name: resource.name } }); return Array.isArray(found) && found.some((item) => isRecord(item) && item.name === resource.name); })
      : resource.type === 'r2'
        ? status(async () => !!await call(`/accounts/${accountId}/r2/buckets/${resource.name}`, { allowNotFound: true }))
        : status(async () => { const found = await call<unknown>(`/accounts/${accountId}/queues`, { query: { name: resource.name } }); return Array.isArray(found) && found.some((item) => isRecord(item) && item.queue_name === resource.name); }));
    return cache.get(key)!;
  };
  const environments: Partial<Record<DeployEnvironment, DetectedEnvironment>> = {};
  for (const [environment, value] of Object.entries(setup.environments) as [DeployEnvironment, DetectedEnvironment][]) {
    environments[environment] = {
      ...value,
      targets: await Promise.all(value.targets.map(async (target) => ({
        ...target,
        exists: workers ? workers.has(target.workerName) : null,
        resources: await Promise.all(target.resources.map(async (resource) => ({ ...resource, status: await lookup(resource) }))),
        urls: [...(target.workersDev && subdomain ? [workersDevUrl(target.workerName, subdomain)] : []), ...target.customDomains.map((domain) => `https://${domain}`)],
      }))),
    };
  }
  const requiredScopes = [...new Set(Object.values(setup.environments).flatMap((value) => value?.targets.flatMap((target) => target.requiredScopes) ?? []))];
  const missingScopes = connection.scopes ? requiredScopes.filter((scope) => !connection.scopes!.includes(scope)) : undefined;
  return { ...setup, environments, account: { connected: true, accountId, ...(connection.accountName ? { accountName: connection.accountName } : {}), source, subdomain, ...(connection.scopes ? { scopes: connection.scopes } : {}), requiredScopes, ...(missingScopes ? { missingScopes } : {}), notes } };
}

export function detectedTargets(environment: DetectedEnvironment): DeployTarget[] {
  return environment.targets.map((target) => ({
    workerName: target.workerName, configPath: target.configPath,
    ...(target.buildCommand ? { buildCommand: target.buildCommand } : {}),
    d1Migrations: target.d1Migrations,
    ...(target.watchPaths.length ? { watchPaths: target.watchPaths } : {}),
  }));
}

export async function liveUrls(call: CloudflareCall, accountId: string, worker: string, config: Json): Promise<string[]> {
  const urls: string[] = [];
  if (workersDevEnabled(config)) {
    try { urls.push(workersDevUrl(worker, await workersSubdomain(call, accountId))); } catch {}
  }
  urls.push(...routeInfo(config).customDomains.map((domain) => `https://${domain}`));
  return urls;
}
