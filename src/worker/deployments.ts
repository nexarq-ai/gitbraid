import type { Repository } from '../shared/types';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey, requireString } from './domain';
import type { Principal } from './security';
import type { SqlStore } from './store';
import type { CloudflareCall } from './cloudflare-deploy';
import { applyD1Migrations, type D1MigrationEvidence, type D1MigrationSet } from './d1-migrations';
import { applyTriggers, currentMigrationTag, ensureResources, requiredDeployScopes, SCOPE_WORKERS_SCRIPTS_WRITE, scriptMetadata } from './worker-provisioning';
import { validWatchPath, WATCH_PATHS_MAX, watchPathsMatch } from './deploy-changes';
import { previewMigrations, validBuildCommand, WORKER_CONFIG_FILES, WorkerBuildFailure, type WorkerBundle } from './worker-bundle';
import { DEPLOY_ENVIRONMENTS_MAX, ENVIRONMENT_NAME, orderedEnvironments, PRODUCTION, validEnvironmentName, type DeployEnvironment } from './deploy-environments';
import { detectedTargets, liveUrls, productionOnlyConfig, setupChanges, type DetectedSetup, type SavedDetection } from './deploy-detect';

export { ENVIRONMENT_NAME, orderedEnvironments, PRODUCTION, validEnvironmentName, type DeployEnvironment };
export const DEPLOY_STEP_MS = 1_800_000;
export const GRADUAL_INITIAL_PERCENTAGE = 10;
export const GRADUAL_SOAK_MS = 600_000;
export const DEPLOYMENT_HISTORY_LIMIT = 100;
export const DEPLOY_TARGETS_MAX = 5;

export type DeployRollout = 'immediate' | 'gradual';
export type DeployTrigger = 'manual' | 'auto';
export type DeployMode = 'deploy' | 'upload-only';
export type DeploymentStatus = 'awaiting_confirmation' | 'queued' | 'building' | 'deploying' | 'rolling_out' | 'succeeded' | 'uploaded' | 'failed' | 'superseded' | 'skipped';
export type DeploymentTrigger = 'land' | 'manual' | 'rollback' | 'promote';
export type DeployTargetStatus = 'pending' | 'building' | 'uploaded' | 'deploying' | 'rolling_out' | 'succeeded' | 'failed' | 'skipped';
export interface DeployTarget { workerName: string; configPath: string; buildCommand?: string; d1Migrations: boolean; watchPaths?: string[] }
export interface SkippedTarget { workerName: string; configPath: string; reason: string }
export interface DeployTargetRun extends DeployTarget {
  status: DeployTargetStatus;
  percentage: number;
  inheritBindings?: boolean;
  versionId?: string;
  previousVersionId?: string;
  deployedOnUpload?: boolean;
  durableObjectMigration?: { old_tag?: string; new_tag: string };
  migrations?: D1MigrationEvidence[];
  assets?: { uploaded: number; total: number };
  urls?: string[];
  notes?: string[];
  errorCode?: string;
  error?: string;
}
export interface DeployEnvironmentSettings {
  enabled: boolean;
  workerName: string;
  accountId: string;
  rollout: DeployRollout;
  trigger: DeployTrigger;
  mode?: DeployMode;
  targets?: DeployTarget[];
  authorizedBy: Principal;
  updatedAt: string;
}
export interface DeploySettings { environments: Partial<Record<DeployEnvironment, DeployEnvironmentSettings>>; detected?: SavedDetection }
interface LegacyDeploySettings extends Omit<DeployEnvironmentSettings, 'trigger'> { environment: DeployEnvironment; confirmation: DeployTrigger }
export interface DeploymentRecord {
  id: string;
  attemptId: string;
  repositoryId: string;
  workerName: string;
  accountId: string;
  environment: DeployEnvironment;
  rollout: DeployRollout;
  mode?: DeployMode;
  commitSha: string | null;
  baseSha?: string;
  missionId?: string;
  trigger: DeploymentTrigger;
  status: DeploymentStatus;
  percentage: number;
  versionId?: string;
  previousVersionId?: string;
  rollbackOf?: string;
  promotedFrom?: string;
  selectedWorkers?: string[];
  selectedConfigs?: string[];
  skippedTargets?: SkippedTarget[];
  targets?: DeployTargetRun[];
  targetsSource?: 'settings' | 'gitflare.json';
  actorId: string;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  error?: string;
}
export interface DeployState { settings: DeploySettings | null; deployments: DeploymentRecord[] }
export interface DeployParams { kind: 'deploy'; repositoryId: string; deploymentId: string; principal: Principal }

const ACTIVE: DeploymentStatus[] = ['queued', 'building', 'deploying', 'rolling_out'];
const sha = /^[a-f0-9]{40}$/;
const workerNamePattern = /^[a-zA-Z0-9_-]{1,63}$/;
const configPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export const deployWorkflowId = (deploymentId: string) => `deploy-${deploymentId}`;

export function backgroundPrincipal(principal: Principal): Principal {
  return { userId: principal.userId, workspaceId: principal.workspaceId, role: principal.role };
}

export function defaultTrigger(environment: DeployEnvironment): DeployTrigger {
  return environment === 'staging' ? 'auto' : 'manual';
}

export function wranglerEnvironment(environment: DeployEnvironment): string | undefined {
  return environment === PRODUCTION ? undefined : environment;
}

function configuredEnvironments(settings: DeploySettings | null): DeployEnvironment[] {
  return orderedEnvironments(Object.keys(settings?.environments ?? {})).filter((environment) => settings?.environments[environment]);
}

export function normalizeDeploySettings(value: unknown): DeploySettings | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<DeploySettings> & Partial<LegacyDeploySettings>;
  if (stored.environments && typeof stored.environments === 'object') return { environments: stored.environments, ...(stored.detected ? { detected: stored.detected } : {}) };
  if (!validEnvironmentName(stored.environment)) return null;
  const { environment, confirmation, ...rest } = stored as LegacyDeploySettings;
  return { environments: { [environment]: { ...rest, trigger: confirmation === 'auto' ? 'auto' : 'manual' } } };
}

type PublicEnvironmentSettings = Omit<DeployEnvironmentSettings, 'authorizedBy'> & { authorizedBy: string };

export function publicSettings(settings: DeploySettings | null): { environments: Partial<Record<DeployEnvironment, PublicEnvironmentSettings>>; detected?: SavedDetection } | null {
  if (!settings) return null;
  const environments: Partial<Record<DeployEnvironment, PublicEnvironmentSettings>> = {};
  for (const environment of configuredEnvironments(settings)) {
    const value = settings.environments[environment];
    if (!value) continue;
    const { authorizedBy, ...rest } = value;
    environments[environment] = { ...rest, mode: value.mode ?? 'deploy', targets: settingsTargets(value), authorizedBy: authorizedBy.userId };
  }
  return { environments, ...(settings.detected ? { detected: settings.detected } : {}) };
}

export function deploymentId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}-${crypto.randomUUID()}`;
}

export function settingsTargets(settings: Pick<DeployEnvironmentSettings, 'workerName' | 'targets'>): DeployTarget[] {
  return settings.targets?.length ? settings.targets : [{ workerName: settings.workerName, configPath: '', d1Migrations: false }];
}

export function parseDeployTargets(value: unknown, source = 'targets'): DeployTarget[] {
  if (!Array.isArray(value) || !value.length || value.length > DEPLOY_TARGETS_MAX) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source} must list 1 to ${DEPLOY_TARGETS_MAX} deploy targets.`);
  const targets = value.map((item, index): DeployTarget => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source}[${index}] must be an object.`);
    const entry = item as Record<string, unknown>;
    if (typeof entry.workerName !== 'string' || !workerNamePattern.test(entry.workerName)) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source}[${index}].workerName must be a Worker name.`);
    if (typeof entry.configPath !== 'string' || entry.configPath.length > 300 || !configPathPattern.test(entry.configPath) || !WORKER_CONFIG_FILES.some((name) => entry.configPath === name || String(entry.configPath).endsWith(`/${name}`))) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source}[${index}].configPath must be a repository-relative wrangler.jsonc, wrangler.json or wrangler.toml.`);
    if (entry.buildCommand !== undefined && entry.buildCommand !== '' && !validBuildCommand(entry.buildCommand)) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source}[${index}].buildCommand must be a single line of at most 500 characters.`);
    if (entry.d1Migrations !== undefined && typeof entry.d1Migrations !== 'boolean') throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source}[${index}].d1Migrations must be true or false.`);
    if (entry.watchPaths !== undefined && (!Array.isArray(entry.watchPaths) || entry.watchPaths.length > WATCH_PATHS_MAX || !entry.watchPaths.every(validWatchPath))) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', `${source}[${index}].watchPaths must list up to ${WATCH_PATHS_MAX} repository-relative globs (prefix ! to exclude).`);
    const watchPaths = Array.isArray(entry.watchPaths) && entry.watchPaths.length ? { watchPaths: [...new Set(entry.watchPaths as string[])] } : {};
    return { workerName: entry.workerName, configPath: entry.configPath, ...(typeof entry.buildCommand === 'string' && entry.buildCommand.trim() ? { buildCommand: entry.buildCommand.trim() } : {}), d1Migrations: entry.d1Migrations === true, ...watchPaths };
  });
  if (new Set(targets.map((target) => target.workerName)).size !== targets.length) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', 'Each Worker can appear in only one deploy target.');
  return targets;
}

export function policyDeployTargets(text: string | null, environment: DeployEnvironment = 'production'): DeployTarget[] | null {
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ApiError(400, 'DEPLOY_POLICY_INVALID', 'gitflare.json is not valid JSON.'); }
  const deploy = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).deploy : undefined;
  if (deploy === undefined) return null;
  const invalid = () => new ApiError(400, 'DEPLOY_POLICY_INVALID', 'gitflare.json "deploy" must be an object with "targets" or "environments".');
  if (!deploy || typeof deploy !== 'object' || Array.isArray(deploy)) throw invalid();
  const { targets, environments } = deploy as Record<string, unknown>;
  if (environments !== undefined) {
    if (!environments || typeof environments !== 'object' || Array.isArray(environments) || Object.keys(environments).some((name) => !validEnvironmentName(name))) throw new ApiError(400, 'DEPLOY_POLICY_INVALID', 'gitflare.json "deploy.environments" names must be lowercase letters, digits and dashes, starting with a letter.');
    const entry = (environments as Record<string, unknown>)[environment];
    if (entry !== undefined) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ApiError(400, 'DEPLOY_POLICY_INVALID', `gitflare.json "deploy.environments.${environment}" must be an object with "targets".`);
      return parseDeployTargets((entry as Record<string, unknown>).targets, `gitflare.json deploy.environments.${environment}.targets`);
    }
  } else if (targets === undefined) throw invalid();
  if (environment !== 'production' || targets === undefined) return null;
  return parseDeployTargets(targets, 'gitflare.json deploy.targets');
}

function targetRuns(targets: DeployTarget[], inheritBindings = false): DeployTargetRun[] {
  return targets.map((target) => ({ ...target, status: 'pending', percentage: 0, ...(inheritBindings ? { inheritBindings: true } : {}) }));
}

export class DeploymentLedger {
  constructor(private readonly store: SqlStore) {}

  state(limit = 50): DeployState {
    const deployments = this.store.list<DeploymentRecord>('deployment:').reverse().slice(0, limit);
    return { settings: this.settings(), deployments };
  }

  settings(): DeploySettings | null { return normalizeDeploySettings(this.store.get<unknown>('deploy-settings')); }

  saveSettings(settings: DeploySettings): DeploySettings {
    this.store.put('deploy-settings', settings);
    return settings;
  }

  saveEnvironment(environment: DeployEnvironment, value: DeployEnvironmentSettings): DeploySettings {
    const current = this.settings();
    return this.saveSettings({ ...current, environments: { ...current?.environments, [environment]: value } });
  }

  saveDetected(environments: Partial<Record<DeployEnvironment, DeployEnvironmentSettings>>, detected: SavedDetection): DeploySettings {
    const current = this.settings();
    return this.saveSettings({ ...current, environments: { ...current?.environments, ...environments }, detected });
  }

  get(id: string): DeploymentRecord | undefined { return this.store.get<DeploymentRecord>(`deployment:${id}`); }

  create(key: string, fingerprint: string, record: DeploymentRecord): DeploymentRecord {
    const receipt = this.store.get<{ fingerprint: string; id: string }>(`deploy-request:${key}`);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different deployment request.');
      const existing = this.get(receipt.id);
      if (existing) return existing;
    }
    const records = this.store.list<DeploymentRecord>('deployment:');
    const sameEnvironment = (item: DeploymentRecord) => item.environment === record.environment;
    const blocking = (item: DeploymentRecord) => sameEnvironment(item) && ACTIVE.includes(item.status) && !(record.trigger === 'rollback' && item.status === 'rolling_out');
    if (record.status !== 'awaiting_confirmation' && records.some(blocking)) throw new ApiError(409, 'DEPLOYMENT_IN_PROGRESS', `Another ${record.environment} deployment of this repository is still running. Wait for it to finish.`);
    for (const item of records) if (sameEnvironment(item) && (item.status === 'awaiting_confirmation' || (record.trigger === 'rollback' && item.status === 'rolling_out'))) this.store.put(`deployment:${item.id}`, { ...item, status: 'superseded', updatedAt: record.createdAt } satisfies DeploymentRecord);
    this.store.put(`deployment:${record.id}`, record);
    this.store.put(`deploy-request:${key}`, { fingerprint, id: record.id });
    for (const stale of records.slice(0, Math.max(0, records.length + 1 - DEPLOYMENT_HISTORY_LIMIT))) this.store.delete(`deployment:${stale.id}`);
    return record;
  }

  confirm(id: string, actorId: string): DeploymentRecord {
    const record = this.get(id);
    if (!record) throw new ApiError(404, 'DEPLOYMENT_NOT_FOUND', 'This deployment could not be found.');
    if (record.status === 'queued' || ACTIVE.includes(record.status)) return record;
    if (record.status !== 'awaiting_confirmation') throw new ApiError(409, 'DEPLOYMENT_NOT_PENDING', 'This deployment is no longer waiting for confirmation.');
    if (this.store.list<DeploymentRecord>('deployment:').some((item) => item.environment === record.environment && ACTIVE.includes(item.status))) throw new ApiError(409, 'DEPLOYMENT_IN_PROGRESS', `Another ${record.environment} deployment of this repository is still running. Wait for it to finish.`);
    const next = { ...record, status: 'queued' as const, actorId, updatedAt: new Date().toISOString() };
    this.store.put(`deployment:${id}`, next);
    return next;
  }

  update(id: string, expected: DeploymentStatus[], patch: Partial<Omit<DeploymentRecord, 'id' | 'repositoryId' | 'attemptId'>>): DeploymentRecord | null {
    const record = this.get(id);
    if (!record || !expected.includes(record.status)) return null;
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    this.store.put(`deployment:${id}`, next);
    return next;
  }
}

export interface WorkerVersionDeployment { versions: { version_id: string; percentage: number }[] }
export interface WorkerDeployer {
  accountId: string;
  scopes?: string[];
  call?: CloudflareCall;
  uploadVersion(bundle: WorkerBundle, annotations: Record<string, string>, metadata?: Record<string, unknown>): Promise<{ id: string }>;
  uploadScript?(bundle: WorkerBundle, metadata: Record<string, unknown>): Promise<{ id: string }>;
  latestDeployment(): Promise<WorkerVersionDeployment | null>;
  deploy(versions: { version_id: string; percentage: number }[], message: string): Promise<{ id: string }>;
}

export const DEPLOY_KEEP_BINDINGS = ['plain_text', 'json', 'secret_text', 'secret_key', 'kv_namespace', 'd1', 'r2_bucket', 'durable_object_namespace', 'service', 'queue', 'workflow', 'ai', 'browser', 'vectorize', 'hyperdrive', 'analytics_engine', 'dispatch_namespace', 'mtls_certificate', 'send_email', 'secrets_store_secret', 'version_metadata', 'images', 'pipelines', 'ratelimit', 'assets', 'artifacts'];

export function inheritedMetadata(bundle: WorkerBundle, annotations: Record<string, string>, assets?: { jwt: string; config: Record<string, unknown> }): Record<string, unknown> {
  return {
    main_module: bundle.mainModule,
    compatibility_date: bundle.config.compatibilityDate,
    ...(bundle.config.compatibilityFlags.length ? { compatibility_flags: bundle.config.compatibilityFlags } : {}),
    bindings: [],
    keep_bindings: DEPLOY_KEEP_BINDINGS,
    annotations,
    ...(assets ? { assets } : {}),
  };
}

export function workerUploadForm(bundle: WorkerBundle, metadata: Record<string, unknown>): FormData {
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  for (const module of bundle.modules) form.set(module.name, new File([module.content], module.name, { type: module.contentType }));
  return form;
}

export function versionUploadForm(bundle: WorkerBundle, annotations: Record<string, string>, metadata?: Record<string, unknown>): FormData {
  return workerUploadForm(bundle, metadata ?? inheritedMetadata(bundle, annotations));
}

export function rolloutVersions(rollout: DeployRollout, versionId: string, previous: WorkerVersionDeployment | null): { versions: { version_id: string; percentage: number }[]; percentage: number; previousVersionId?: string } {
  const previousVersionId = previous?.versions.slice().sort((a, b) => b.percentage - a.percentage).find((version) => version.version_id !== versionId)?.version_id;
  if (rollout === 'gradual' && previousVersionId) return { versions: [{ version_id: versionId, percentage: GRADUAL_INITIAL_PERCENTAGE }, { version_id: previousVersionId, percentage: 100 - GRADUAL_INITIAL_PERCENTAGE }], percentage: GRADUAL_INITIAL_PERCENTAGE, previousVersionId };
  return { versions: [{ version_id: versionId, percentage: 100 }], percentage: 100, ...(previousVersionId ? { previousVersionId } : {}) };
}

export interface BuiltTarget {
  bundle: WorkerBundle;
  migrations: D1MigrationSet[];
  uploadAssets?(call: CloudflareCall, accountId: string, workerName: string): Promise<{ jwt: string; config: Record<string, unknown>; uploaded: number; total: number }>;
}
export type PublishTarget = <T>(built: BuiltTarget) => Promise<T>;

export interface DeployCoordinator {
  getRepository(repositoryId: string): Promise<Repository | undefined>;
  getDeployment(id: string): Promise<DeploymentRecord | undefined>;
  updateDeployment(id: string, expected: DeploymentStatus[], patch: Partial<DeploymentRecord>): Promise<DeploymentRecord | null>;
}
export interface DeployPlatform {
  ensureResources: typeof ensureResources;
  applyTriggers: typeof applyTriggers;
  currentMigrationTag: typeof currentMigrationTag;
  applyD1Migrations: typeof applyD1Migrations;
  liveUrls?: typeof liveUrls;
}
export interface DeployDependencies {
  coordinator: DeployCoordinator;
  authorize(principal: Principal, workerName: string): Promise<void>;
  deployer(principal: Principal, record: DeploymentRecord, workerName: string): Promise<WorkerDeployer>;
  build<T>(repository: Repository, record: DeploymentRecord, target: DeployTargetRun, index: number, assertAuthority: () => Promise<void>, publish: (built: BuiltTarget) => Promise<T>): Promise<T>;
  policyTargets?(repository: Repository, record: DeploymentRecord): Promise<DeployTarget[] | null>;
  changedPaths?(repository: Repository, record: DeploymentRecord): Promise<string[] | null>;
  mappedWorkers?(principal: Principal, repositoryId: string): Promise<{ accountId: string; workers: string[] } | null>;
  declaresRoutes?(repository: Repository, record: DeploymentRecord, target: DeployTarget): Promise<boolean>;
  platform?: DeployPlatform;
}
export interface DeployStepRunner {
  do<T>(name: string, config: { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number }, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
}

const defaultPlatform: DeployPlatform = { ensureResources, applyTriggers, currentMigrationTag, applyD1Migrations, liveUrls };

function failure(error: unknown): { errorCode: string; error: string } {
  if (error instanceof ApiError) return { errorCode: error.code, error: error.detail };
  if (error instanceof WorkerBuildFailure) return { errorCode: error.code, error: error.message };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error instanceof Error) return { errorCode: error.code, error: error.message.slice(0, 700) };
  return { errorCode: 'DEPLOYMENT_FAILED', error: error instanceof Error ? error.message.slice(0, 700) : 'The deployment failed.' };
}

const TRIGGER_KEYS = ['name', 'workers_dev', 'preview_urls', 'routes', 'route', 'triggers', 'queues', 'workflows', 'exports', 'observability', 'logpush', 'tail_consumers', 'streaming_tail_consumers'];

function triggerConfig(deploy: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(TRIGGER_KEYS.filter((key) => deploy[key] !== undefined).map((key) => [key, deploy[key]]));
}

function serviceDependencies(deploy: Record<string, unknown> | undefined): string[] {
  const services = Array.isArray(deploy?.services) ? deploy.services : [];
  return services.map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).service : undefined).filter((name): name is string => typeof name === 'string');
}

function requireCall(deployer: WorkerDeployer): CloudflareCall {
  if (!deployer.call) throw new ApiError(503, 'DEPLOYER_INCOMPLETE', 'The Cloudflare deployer cannot provision resources.');
  return deployer.call;
}

async function selectTargets(record: DeploymentRecord, targets: DeployTargetRun[], paths: () => Promise<string[] | null>): Promise<{ run: DeployTargetRun[]; skipped: SkippedTarget[] }> {
  const split = (keep: (target: DeployTargetRun) => boolean, reason: string) => ({
    run: targets.filter(keep),
    skipped: targets.filter((target) => !keep(target)).map((target) => ({ workerName: target.workerName, configPath: target.configPath, reason })),
  });
  if (record.trigger === 'rollback') return { run: targets, skipped: [] };
  if (record.selectedWorkers?.length) {
    const unknown = record.selectedWorkers.filter((name) => !targets.some((target) => target.workerName === name));
    if (unknown.length) throw new ApiError(409, 'DEPLOY_TARGET_NOT_CONFIGURED', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${record.environment} deploy targets of this repository.`);
    return split((target) => record.selectedWorkers!.includes(target.workerName), 'not selected');
  }
  if (record.selectedConfigs) return split((target) => record.selectedConfigs!.includes(target.configPath), 'not deployed by the promoted deployment');
  if (record.trigger === 'land' && targets.some((target) => target.watchPaths?.length)) {
    const changed = await paths();
    if (changed) return split((target) => watchPathsMatch(target.watchPaths, changed), 'no changes under watch paths');
  }
  return { run: targets, skipped: [] };
}

type UploadOutcome = { kind: 'stale' } | { kind: 'failed' } | { kind: 'uploaded'; versionId: string; deployed: boolean; previousVersionId?: string; triggers?: Record<string, unknown> };
type DeployOutcome = { kind: 'stale' } | { kind: 'failed' } | { kind: 'done'; gradual: boolean };

export async function runDeployment(params: DeployParams, step: DeployStepRunner, dependencies: DeployDependencies): Promise<void> {
  const { coordinator } = dependencies;
  const platform = dependencies.platform ?? defaultPlatform;
  const { deploymentId: id, principal } = params;
  const fail = async (error: unknown, index?: number) => {
    const details = failure(error);
    const current = await coordinator.getDeployment(id);
    const targets = index !== undefined && current?.targets ? current.targets.map((target, position) => position === index ? { ...target, status: 'failed' as const, ...details } : target.status === 'pending' ? { ...target, status: 'skipped' as const } : target) : current?.targets;
    await coordinator.updateDeployment(id, ACTIVE, { status: 'failed', ...details, ...(targets ? { targets } : {}) });
  };
  const patchTarget = async (index: number, expected: DeploymentStatus[], patch: Partial<DeployTargetRun>, recordPatch: Partial<DeploymentRecord> = {}) => {
    const current = await coordinator.getDeployment(id);
    if (!current?.targets?.[index]) return null;
    const targets = current.targets.map((target, position) => position === index ? { ...target, ...patch } : target);
    const mirror = index === 0 ? { ...(targets[0].versionId ? { versionId: targets[0].versionId } : {}), ...(targets[0].previousVersionId ? { previousVersionId: targets[0].previousVersionId } : {}), percentage: targets[0].percentage } : {};
    return coordinator.updateDeployment(id, expected, { targets, ...mirror, ...recordPatch });
  };

  const planned = await step.do('plan deploy targets', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async (): Promise<number> => {
    const record = await coordinator.getDeployment(id);
    if (!record || record.status !== 'queued') return 0;
    try {
      if (record.trigger === 'rollback') {
        const targets = record.targets?.length ? record.targets : [{ workerName: record.workerName, configPath: '', d1Migrations: false, status: 'pending' as const, percentage: 0, versionId: record.versionId }];
        await coordinator.updateDeployment(id, ['queued'], { targets });
        return targets.length;
      }
      const repository = await coordinator.getRepository(record.repositoryId);
      if (!repository || !record.commitSha) throw new ApiError(409, 'DEPLOY_COMMIT_INVALID', 'The landed commit for this deployment is unavailable.');
      const fromPolicy = await dependencies.policyTargets?.(repository, record) ?? null;
      const targets = fromPolicy ? targetRuns(fromPolicy) : record.targets?.length ? record.targets : targetRuns([{ workerName: record.workerName, configPath: '', d1Migrations: false }], true);
      if (fromPolicy && dependencies.mappedWorkers) {
        const mapping = await dependencies.mappedWorkers(principal, record.repositoryId);
        const unmapped = targets.filter((target) => !mapping?.workers.includes(target.workerName)).map((target) => target.workerName);
        if (unmapped.length) throw new ApiError(409, 'WORKER_NOT_MAPPED', `gitflare.json deploys ${unmapped.join(', ')}, which ${unmapped.length === 1 ? 'is' : 'are'} not linked to this repository in its Cloudflare tab.`);
        if (mapping && mapping.accountId !== record.accountId) throw new ApiError(409, 'CLOUDFLARE_ACCOUNT_CHANGED', 'The repository resource mapping now points at a different Cloudflare account.');
      }
      for (const target of targets) await dependencies.authorize(principal, target.workerName);
      const targetsSource = fromPolicy ? 'gitflare.json' as const : 'settings' as const;
      const { run, skipped } = await selectTargets(record, targets, () => dependencies.changedPaths?.(repository, record) ?? Promise.resolve(null));
      if (!run.length) {
        await coordinator.updateDeployment(id, ['queued'], { status: 'skipped', targets: [], skippedTargets: skipped, targetsSource });
        return 0;
      }
      await coordinator.updateDeployment(id, ['queued'], { targets: run, targetsSource, ...(skipped.length ? { skippedTargets: skipped } : {}) });
      return run.length;
    } catch (error) {
      await fail(error);
      return 0;
    }
  });

  let gradual = false;
  for (let index = 0; index < planned; index++) {
    const uploaded = await step.do(`build and upload target ${index + 1}`, { retries: { limit: 0, delay: '1 second' }, timeout: DEPLOY_STEP_MS }, async (): Promise<UploadOutcome> => {
      const record = await coordinator.getDeployment(id);
      const target = record?.targets?.[index];
      if (!record || !target || !['queued', 'building'].includes(record.status) || target.status !== 'pending') return { kind: 'stale' };
      try {
        await dependencies.authorize(principal, target.workerName);
        const deployer = await dependencies.deployer(principal, record, target.workerName);
        if (record.trigger === 'rollback') {
          if (!target.versionId) throw new ApiError(409, 'ROLLBACK_TARGET_MISSING', 'No earlier version is recorded for rollback.');
          await patchTarget(index, ['queued', 'building'], { status: 'deploying' }, { status: 'deploying' });
          return { kind: 'uploaded', versionId: target.versionId, deployed: false };
        }
        const repository = await coordinator.getRepository(record.repositoryId);
        if (!repository || !record.commitSha) throw new ApiError(409, 'DEPLOY_COMMIT_INVALID', 'The landed commit for this deployment is unavailable.');
        if (!await patchTarget(index, ['queued', 'building'], { status: 'building' }, { status: 'building' })) return { kind: 'stale' };
        const commitSha = record.commitSha;
        const uploadOnly = record.mode === 'upload-only';
        const annotations = { 'workers/commit_sha': commitSha, 'workers/message': `Gitflare ${record.trigger} ${commitSha.slice(0, 12)}`.slice(0, 100), 'workers/tag': commitSha.slice(0, 12) };
        return await dependencies.build(repository, record, target, index, () => dependencies.authorize(principal, target.workerName), async (built): Promise<UploadOutcome> => {
          const notes: string[] = [];
          if (target.inheritBindings) {
            const assets = built.uploadAssets ? await built.uploadAssets(requireCall(deployer), deployer.accountId, target.workerName) : undefined;
            const version = await deployer.uploadVersion(built.bundle, annotations, assets ? inheritedMetadata(built.bundle, annotations, { jwt: assets.jwt, config: assets.config }) : undefined);
            await patchTarget(index, ['building'], { status: uploadOnly ? 'uploaded' : 'deploying', versionId: version.id, ...(assets ? { assets: { uploaded: assets.uploaded, total: assets.total } } : {}) }, { status: 'deploying' });
            return { kind: 'uploaded', versionId: version.id, deployed: false };
          }
          const resolved = built.bundle.config.deploy ?? {};
          const ownRoutes = record.environment !== PRODUCTION && !!await dependencies.declaresRoutes?.(repository, record, target);
          const deploy = productionOnlyConfig(resolved, record.environment, ownRoutes);
          if (deploy !== resolved && (Array.isArray(resolved.routes) ? resolved.routes.length > 0 : resolved.routes !== undefined || resolved.route !== undefined)) notes.push(`Routes and custom domains are production-only unless env.${record.environment} declares its own; ${record.environment} did not attach the inherited ones.`);
          if (typeof deploy.name === 'string' && deploy.name !== target.workerName) throw new WorkerBuildFailure('DEPLOY_TARGET_NAME_MISMATCH', `${target.configPath}${wranglerEnvironment(record.environment) ? ` with env.${wranglerEnvironment(record.environment)}` : ''} names Worker ${deploy.name}, but this ${record.environment} target deploys ${target.workerName}.`);
          const later = (record.targets ?? []).slice(index + 1).map((item) => item.workerName);
          const dependsOnLater = serviceDependencies(deploy).filter((name) => later.includes(name));
          if (dependsOnLater.length) throw new WorkerBuildFailure('DEPLOY_ORDER_INVALID', `${target.workerName} has a service binding to ${dependsOnLater.join(', ')}, which deploys later. Move ${dependsOnLater.join(', ')} earlier in the target list.`);
          if (deployer.scopes) {
            const missing = requiredDeployScopes(deploy, { d1Migrations: target.d1Migrations && !uploadOnly, uploadOnly }).filter((scope) => !deployer.scopes!.includes(scope));
            if (missing.length) throw new ApiError(403, 'CLOUDFLARE_SCOPE_MISSING', `The Cloudflare connection was not granted ${missing.join(', ')}, which deploying ${target.workerName} needs. An Owner must reconnect Cloudflare after the installation requests ${missing.length === 1 ? 'that scope' : 'those scopes'}.`);
          }
          const call = requireCall(deployer);
          for (const name of serviceDependencies(deploy).filter((service) => record.skippedTargets?.some((skipped) => skipped.workerName === service))) {
            if (!(await platform.currentMigrationTag(call, deployer.accountId, name)).exists) throw new WorkerBuildFailure('DEPLOY_DEPENDENCY_MISSING', `${target.workerName} has a service binding to ${name}, which is not part of this deployment and does not exist in ${record.environment} yet. Deploy ${name} first or include it.`);
          }
          const resources = await platform.ensureResources(call, deployer.accountId, deploy);
          notes.push(...resources.notes);
          const migrations: D1MigrationEvidence[] = [];
          if (target.d1Migrations && uploadOnly) notes.push('D1 migrations were not applied because this deployment only uploads a version.');
          else if (target.d1Migrations) {
            if (!built.migrations.length) notes.push('No D1 database in this configuration sets migrations_dir.');
            for (const set of built.migrations) {
              const evidence = await platform.applyD1Migrations(call, deployer.accountId, set, async (progress) => { await patchTarget(index, ['building'], { migrations: [...migrations, progress] }); });
              migrations.push(evidence);
              await patchTarget(index, ['building'], { migrations: [...migrations] });
            }
          }
          const assets = built.uploadAssets ? await built.uploadAssets(call, deployer.accountId, target.workerName) : undefined;
          const live = await platform.currentMigrationTag(call, deployer.accountId, target.workerName);
          const doMigrations = previewMigrations(built.bundle.config, live.tag);
          const viaScript = !live.exists || !!doMigrations;
          if (viaScript && uploadOnly) throw new WorkerBuildFailure(live.exists ? 'DO_MIGRATION_REQUIRES_DEPLOY' : 'WORKER_NOT_FOUND', live.exists ? `${target.workerName} has a pending Durable Object migration (${doMigrations!.new_tag}), which Cloudflare applies only with a full deploy. Switch the mode to deploy.` : `Worker ${target.workerName} does not exist yet; uploading a version needs an existing Worker. Switch the mode to deploy.`);
          const { metadata, notes: metadataNotes } = scriptMetadata({ config: deploy, mainModule: built.bundle.mainModule, annotations, ...(assets ? { assets: { jwt: assets.jwt, config: assets.config } } : {}), ...(viaScript && doMigrations ? { migrations: doMigrations } : {}), resolved: resources.resolved });
          notes.push(...metadataNotes);
          const previousVersionId = viaScript && live.exists ? rolloutVersions('immediate', '', await deployer.latestDeployment()).previousVersionId : undefined;
          if (viaScript && !deployer.uploadScript) throw new ApiError(503, 'DEPLOYER_INCOMPLETE', 'The Cloudflare deployer cannot upload Worker scripts.');
          const version = viaScript ? await deployer.uploadScript!(built.bundle, metadata) : await deployer.uploadVersion(built.bundle, annotations, metadata);
          if (viaScript) notes.push(doMigrations ? `Applied Durable Object migration ${doMigrations.old_tag ?? '(none)'} → ${doMigrations.new_tag} with a full script upload at 100%.` : `Created Worker ${target.workerName} with a full script upload.`);
          await patchTarget(index, ['building'], {
            status: uploadOnly ? 'uploaded' : 'deploying', versionId: version.id, deployedOnUpload: viaScript,
            ...(previousVersionId ? { previousVersionId } : {}),
            ...(doMigrations ? { durableObjectMigration: { ...(doMigrations.old_tag ? { old_tag: doMigrations.old_tag } : {}), new_tag: doMigrations.new_tag } } : {}),
            ...(assets ? { assets: { uploaded: assets.uploaded, total: assets.total } } : {}),
            ...(migrations.length ? { migrations } : {}),
            notes: notes.slice(0, 40).map((note) => note.slice(0, 300)),
          }, { status: 'deploying' });
          return { kind: 'uploaded', versionId: version.id, deployed: viaScript, ...(previousVersionId ? { previousVersionId } : {}), triggers: triggerConfig(deploy) };
        });
      } catch (error) {
        await fail(error, index);
        return { kind: 'failed' };
      }
    });
    if (uploaded.kind !== 'uploaded') return;
    const deployed = await step.do(`deploy target ${index + 1}`, { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async (): Promise<DeployOutcome> => {
      const record = await coordinator.getDeployment(id);
      const target = record?.targets?.[index];
      if (!record || !target || record.status !== 'deploying') return { kind: 'stale' };
      try {
        if (target.status === 'uploaded') {
          await coordinator.updateDeployment(id, ['deploying'], { status: index === planned - 1 ? 'uploaded' : 'building' });
          return { kind: 'done', gradual: false };
        }
        if (target.status !== 'deploying') return { kind: 'stale' };
        await dependencies.authorize(principal, target.workerName);
        const deployer = await dependencies.deployer(principal, record, target.workerName);
        let percentage = 100;
        let previousVersionId = uploaded.previousVersionId;
        if (!uploaded.deployed) {
          const plan = rolloutVersions(record.trigger === 'rollback' ? 'immediate' : record.rollout, uploaded.versionId, await deployer.latestDeployment());
          await deployer.deploy(plan.versions, `Gitflare ${record.trigger}${record.commitSha ? ` ${record.commitSha.slice(0, 12)}` : ''}`);
          percentage = plan.percentage;
          previousVersionId = plan.previousVersionId;
        }
        const notes = [...(target.notes ?? [])];
        if (uploaded.triggers && !target.inheritBindings && record.trigger !== 'rollback') notes.push(...(await platform.applyTriggers(requireCall(deployer), deployer.accountId, target.workerName, uploaded.triggers)).notes);
        const urls = uploaded.triggers && platform.liveUrls && deployer.call ? await platform.liveUrls(deployer.call, deployer.accountId, target.workerName, uploaded.triggers) : undefined;
        const rolling = percentage < 100;
        const last = index === planned - 1;
        await patchTarget(index, ['deploying'], { status: rolling ? 'rolling_out' : 'succeeded', percentage, notes: notes.slice(0, 40).map((note) => note.slice(0, 300)), ...(urls ? { urls } : {}), ...(record.trigger === 'rollback' ? {} : previousVersionId ? { previousVersionId } : {}) }, { status: last ? (rolling || gradual ? 'rolling_out' : 'succeeded') : 'building' });
        return { kind: 'done', gradual: rolling };
      } catch (error) {
        await fail(error, index);
        return { kind: 'failed' };
      }
    });
    if (deployed.kind !== 'done') return;
    gradual ||= deployed.gradual;
  }
  if (!gradual) return;
  await step.sleep('observe gradual rollout', GRADUAL_SOAK_MS);
  await step.do('promote worker versions', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
    const record = await coordinator.getDeployment(id);
    if (!record || record.status !== 'rolling_out' || !record.targets) return true;
    let index = -1;
    try {
      for (index = 0; index < record.targets.length; index++) {
        const target = record.targets[index];
        if (target.status !== 'rolling_out' || !target.versionId) continue;
        await dependencies.authorize(principal, target.workerName);
        const deployer = await dependencies.deployer(principal, record, target.workerName);
        await deployer.deploy([{ version_id: target.versionId, percentage: 100 }], `Gitflare promote ${record.commitSha?.slice(0, 12) ?? target.versionId}`);
        await patchTarget(index, ['rolling_out'], { status: 'succeeded', percentage: 100 });
      }
      await coordinator.updateDeployment(id, ['rolling_out'], { status: 'succeeded', percentage: 100 });
    } catch (error) { await fail(error, index); }
    return true;
  });
}

function previousVersionFor(deployments: DeploymentRecord[], current: DeploymentRecord, workerName: string, currentVersion: string, previousVersionId?: string): string | undefined {
  if (current.trigger !== 'rollback') return previousVersionId;
  for (const item of deployments) {
    if (item.id === current.id || item.status !== 'succeeded' || item.createdAt >= current.createdAt) continue;
    const version = item.targets?.length ? item.targets.find((target) => target.workerName === workerName)?.versionId : item.workerName === workerName ? item.versionId : undefined;
    if (version && version !== currentVersion) return version;
  }
  return undefined;
}

export function rollbackTarget(deployments: DeploymentRecord[]): { current: DeploymentRecord; versionId: string; commitSha: string | null; targets: DeployTargetRun[] } {
  const current = deployments.find((item) => item.status === 'succeeded' || item.status === 'rolling_out');
  if (!current?.versionId && !current?.targets?.some((target) => target.versionId)) throw new ApiError(409, 'NOTHING_TO_ROLL_BACK', 'No successful deployment is recorded for this repository.');
  const live = current.targets?.length ? current.targets.filter((target) => target.versionId) : [{ workerName: current.workerName, configPath: '', d1Migrations: false, status: 'succeeded' as const, percentage: 100, versionId: current.versionId, previousVersionId: current.previousVersionId }];
  const targets: DeployTargetRun[] = [];
  for (const target of live.slice().reverse()) {
    const versionId = previousVersionFor(deployments, current, target.workerName, target.versionId!, target.previousVersionId);
    if (versionId) targets.push({ workerName: target.workerName, configPath: target.configPath, d1Migrations: false, status: 'pending', percentage: 0, versionId });
  }
  if (!targets.length) throw new ApiError(409, 'ROLLBACK_TARGET_MISSING', 'No earlier Worker version is recorded for rollback.');
  const first = targets[targets.length - 1].versionId!;
  const commitSha = deployments.find((item) => item.trigger !== 'rollback' && (item.versionId === first || item.targets?.some((target) => target.versionId === first)))?.commitSha ?? null;
  return { current, versionId: targets[0].versionId!, commitSha, targets };
}

export interface DeployApiContext {
  repository: Repository;
  principal: Principal;
  ledger: {
    state(): Promise<DeployState>;
    get(id: string): Promise<DeploymentRecord | undefined>;
    saveEnvironment(environment: DeployEnvironment, settings: DeployEnvironmentSettings): Promise<DeploySettings>;
    create(key: string, fingerprint: string, record: DeploymentRecord): Promise<DeploymentRecord>;
    confirm(id: string, actorId: string): Promise<DeploymentRecord>;
    saveDetected?(environments: Partial<Record<DeployEnvironment, DeployEnvironmentSettings>>, detected: SavedDetection): Promise<DeploySettings>;
  };
  detectSetup?(): Promise<DetectedSetup>;
  linkWorkers?(accountId: string, workers: { id: string; environment: DeployEnvironment }[]): Promise<void>;
  authorizeRead(): Promise<void>;
  authorizeDeploy(workerName: string): Promise<void>;
  canDeploy(workerName: string): Promise<boolean>;
  mappedWorkers(): Promise<{ accountId: string; workers: { id: string; name: string; environment: string }[] } | null>;
  headSha(): Promise<string | null>;
  dispatch(record: DeploymentRecord): Promise<'running' | 'finished' | 'missing'>;
  failDispatch(record: DeploymentRecord): Promise<void>;
  audit?(action: string): Promise<void>;
}

export interface EnvironmentStatus {
  current: { deploymentId: string; commitSha: string | null; trigger: DeploymentTrigger; status: DeploymentStatus; updatedAt: string; workers: { workerName: string; versionId: string; percentage: number; urls: string[] }[] } | null;
  lastChange: { deploymentId: string; commitSha: string | null; trigger: DeploymentTrigger; status: DeploymentStatus; updatedAt: string; error?: string } | null;
  pending: string | null;
  running: boolean;
  promotable?: { deploymentId: string; commitSha: string } | null;
}

const isLive = (item: DeploymentRecord) => item.status === 'succeeded' || item.status === 'rolling_out';
const isPromotable = (item: DeploymentRecord) => item.environment !== PRODUCTION && item.status === 'succeeded' && item.trigger !== 'rollback' && item.mode !== 'upload-only' && !!item.commitSha && sha.test(item.commitSha);

export function environmentStatus(deployments: DeploymentRecord[], environment: DeployEnvironment): EnvironmentStatus {
  const own = deployments.filter((item) => item.environment === environment);
  const current = own.find(isLive);
  const latest = own[0];
  const urlsFor = (workerName: string) => own.flatMap((item) => item.targets ?? []).find((target) => target.workerName === workerName && target.urls)?.urls ?? [];
  const workers = !current ? [] : current.targets?.length
    ? current.targets.filter((target) => target.versionId).map((target) => ({ workerName: target.workerName, versionId: target.versionId!, percentage: target.percentage, urls: target.urls ?? urlsFor(target.workerName) }))
    : current.versionId ? [{ workerName: current.workerName, versionId: current.versionId, percentage: current.percentage, urls: urlsFor(current.workerName) }] : [];
  const promotable = environment !== PRODUCTION ? own.find(isPromotable) : undefined;
  return {
    current: current ? { deploymentId: current.id, commitSha: current.commitSha, trigger: current.trigger, status: current.status, updatedAt: current.updatedAt, workers } : null,
    lastChange: latest ? { deploymentId: latest.id, commitSha: latest.commitSha, trigger: latest.trigger, status: latest.status, updatedAt: latest.updatedAt, ...(latest.error ? { error: latest.error } : {}) } : null,
    pending: own.find((item) => item.status === 'awaiting_confirmation')?.id ?? null,
    running: own.some((item) => ACTIVE.includes(item.status)),
    ...(environment !== PRODUCTION ? { promotable: promotable ? { deploymentId: promotable.id, commitSha: promotable.commitSha! } : null } : {}),
  };
}

function parseEnvironment(value: unknown): DeployEnvironment {
  if (!validEnvironmentName(value)) throw new ApiError(400, 'INVALID_ENVIRONMENT', 'Environment names use lowercase letters, digits and dashes and start with a letter, for example production, staging or qa.');
  return value as DeployEnvironment;
}

function chooseEnvironment(value: unknown, settings: DeploySettings | null): DeployEnvironment {
  if (value !== undefined) return parseEnvironment(value);
  const configured = configuredEnvironments(settings);
  if (configured.length === 1) return configured[0];
  if (!configured.length) throw new ApiError(409, 'DEPLOY_NOT_CONFIGURED', 'Choose target Workers in deployment settings first.');
  throw new ApiError(400, 'ENVIRONMENT_REQUIRED', `This repository deploys to ${configured.join(', ')}. Choose the environment.`);
}

function environmentSettings(settings: DeploySettings | null, environment: DeployEnvironment): DeployEnvironmentSettings {
  const value = settings?.environments[environment];
  if (!value) throw new ApiError(409, 'DEPLOY_NOT_CONFIGURED', `Choose target Workers for ${environment} in deployment settings first.`);
  return value;
}

function environmentRecord(repositoryId: string, environment: DeployEnvironment, value: DeployEnvironmentSettings, actorId: string, fields: Pick<DeploymentRecord, 'commitSha' | 'trigger' | 'status'> & Partial<DeploymentRecord>): DeploymentRecord {
  const now = new Date().toISOString();
  return {
    id: deploymentId(), attemptId: crypto.randomUUID(), repositoryId, workerName: value.workerName, accountId: value.accountId, environment, rollout: value.rollout, mode: value.mode ?? 'deploy',
    percentage: 0, actorId, createdAt: now, updatedAt: now,
    ...(value.targets?.length ? { targets: targetRuns(value.targets) } : {}),
    ...fields,
  };
}

function selectedWorkers(value: unknown, settings: DeployEnvironmentSettings): string[] | undefined {
  if (value === undefined || value === 'all') return undefined;
  if (!Array.isArray(value) || !value.length || value.length > DEPLOY_TARGETS_MAX || !value.every((name) => typeof name === 'string' && workerNamePattern.test(name)) || new Set(value).size !== value.length) throw new ApiError(400, 'INVALID_DEPLOY_TARGETS', 'targets must be "all" or a list of Worker names from the deploy targets.');
  const configured = settingsTargets(settings).map((target) => target.workerName);
  if (settings.targets?.length) {
    const unknown = (value as string[]).filter((name) => !configured.includes(name));
    if (unknown.length) throw new ApiError(400, 'DEPLOY_TARGET_NOT_CONFIGURED', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not deploy targets of this environment.`);
    if (configured.every((name) => value.includes(name))) return undefined;
  }
  return value as string[];
}

function promotedConfigs(source: DeploymentRecord): string[] | undefined {
  return source.targets?.length && source.targets.every((target) => target.configPath) ? source.targets.map((target) => target.configPath) : undefined;
}

function productionStatus(production: DeployEnvironmentSettings, principal: Principal, confirmed: unknown): DeploymentStatus {
  return production.trigger === 'auto' || (principal.role === 'Owner' && !principal.credentialId && confirmed === true) ? 'queued' : 'awaiting_confirmation';
}

const canConfigure = (principal: Principal) => !principal.credentialId && ['Owner', 'Deployer'].includes(principal.role);

async function detectedSetup(context: DeployApiContext): Promise<DetectedSetup> {
  if (!context.detectSetup) throw new ApiError(503, 'DEPLOY_DETECTION_UNAVAILABLE', 'Deploy setup detection is unavailable on this installation.');
  return context.detectSetup();
}

async function applyDetected(body: Record<string, unknown>, context: DeployApiContext): Promise<Response> {
  const { principal } = context;
  if (!canConfigure(principal)) throw new ApiError(403, 'DEPLOYER_REQUIRED', 'Only an Owner or Deployer can change deployment settings.');
  if (!context.ledger.saveDetected || !context.linkWorkers) throw new ApiError(503, 'DEPLOY_DETECTION_UNAVAILABLE', 'Deploy setup detection is unavailable on this installation.');
  const setup = await detectedSetup(context);
  if (typeof body.fingerprint !== 'string' || body.fingerprint !== setup.fingerprint) throw new ApiError(409, 'DEPLOY_SETUP_CHANGED', 'The Wrangler configs changed since this setup was detected. Detect again and review the new plan.');
  if (setup.errors.length) throw new ApiError(409, 'DEPLOY_SETUP_INVALID', setup.errors.join(' ').slice(0, 700));
  const available = orderedEnvironments(Object.keys(setup.environments)).filter((environment) => setup.environments[environment]?.targets.length);
  if (!available.length) throw new ApiError(409, 'DEPLOY_SETUP_NOT_FOUND', 'No Wrangler config with a Worker name was found at the default branch head.');
  const chosen = body.environment !== undefined ? [parseEnvironment(body.environment)] : available;
  for (const environment of chosen) if (!available.includes(environment)) throw new ApiError(409, 'DEPLOY_SETUP_NOT_FOUND', `No Wrangler config defines ${environment === PRODUCTION ? 'a production Worker' : `env.${environment}`}.`);
  const account = setup.account;
  if (!account?.connected) throw new ApiError(409, 'CLOUDFLARE_NOT_CONNECTED', account?.reason ?? 'Connect Cloudflare for this repository or workspace first.');
  const acknowledged = Array.isArray(body.acknowledge) ? body.acknowledge.filter((item): item is string => typeof item === 'string') : [];
  const warnings = chosen.filter((environment) => environment !== PRODUCTION).flatMap((environment) => setup.environments[environment]?.warnings ?? []);
  const unacknowledged = warnings.filter((warning) => !acknowledged.includes(warning.id));
  if (unacknowledged.length) throw new ApiError(409, 'DEPLOY_WARNINGS_UNACKNOWLEDGED', `Acknowledge these warnings before enabling ${chosen.filter((environment) => environment !== PRODUCTION).join(', ')}: ${unacknowledged.map((warning) => warning.id).join(', ')}.`);
  if (warnings.length && principal.role !== 'Owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only an Owner can acknowledge environment safety warnings.');
  const workers = chosen.flatMap((environment) => setup.environments[environment]!.targets.map((target) => ({ id: target.workerName, environment })));
  for (const worker of workers) await context.authorizeDeploy(worker.id);
  const state = await context.ledger.state();
  const now = new Date().toISOString();
  const environments: Partial<Record<DeployEnvironment, DeployEnvironmentSettings>> = {};
  for (const environment of chosen) {
    const targets = detectedTargets(setup.environments[environment]!);
    const existing = state.settings?.environments[environment];
    environments[environment] = {
      enabled: true, workerName: targets[0].workerName, accountId: account.accountId,
      rollout: existing?.rollout ?? 'immediate', trigger: environment === PRODUCTION ? (existing?.trigger === 'auto' && principal.role === 'Owner' ? 'auto' : 'manual') : existing?.trigger ?? defaultTrigger(environment), mode: existing?.mode ?? 'deploy',
      targets, authorizedBy: backgroundPrincipal(principal), updatedAt: now,
    };
  }
  await context.linkWorkers(account.accountId, workers);
  const detected: SavedDetection = { fingerprint: setup.fingerprint, commitSha: setup.commitSha, files: setup.files, appliedAt: now, appliedBy: principal.userId, acknowledged: warnings.map((warning) => warning.id) };
  await context.audit?.(`repository.deploy-settings.detected.${chosen.join('+')}`);
  return Response.json({ settings: publicSettings(await context.ledger.saveDetected(environments, detected)), linked: workers });
}

export async function deploymentsApi(request: Request, context: DeployApiContext): Promise<Response> {
  const { principal } = context;
  await context.authorizeRead();
  if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/deployments/detect')) {
    const [setup, state] = await Promise.all([detectedSetup(context), context.ledger.state()]);
    const saved = state.settings?.detected ?? null;
    return Response.json({ setup, saved, changed: saved ? setupChanges(saved.files, setup.files) : [], canApply: canConfigure(principal), canAcknowledge: canConfigure(principal) && principal.role === 'Owner' });
  }
  if (request.method === 'GET') {
    const [state, mapping] = await Promise.all([context.ledger.state(), context.mappedWorkers()]);
    const publicValue = publicSettings(state.settings);
    const names = orderedEnvironments([...Object.keys(state.settings?.environments ?? {}), ...state.deployments.map((item) => item.environment)]);
    const environments = Object.fromEntries(await Promise.all(names.map(async (environment) => {
      const value = state.settings?.environments[environment];
      const canDeploy = value ? (await Promise.all(settingsTargets(value).map((target) => context.canDeploy(target.workerName)))).every(Boolean) : false;
      return [environment, { settings: publicValue?.environments[environment] ?? null, ...environmentStatus(state.deployments, environment), canDeploy, ...(environment === 'production' ? { canConfirm: canDeploy && principal.role === 'Owner' && !principal.credentialId } : {}) }];
    })));
    const canDeploy = names.some((environment) => environments[environment].canDeploy);
    return Response.json({ settings: publicValue, environmentOrder: names, environments, deployments: state.deployments, workers: mapping?.workers ?? [], canDeploy, requiredScope: SCOPE_WORKERS_SCRIPTS_WRITE });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request);
  const action = body.action;
  const now = new Date().toISOString();
  if (action === 'apply_detected') return applyDetected(body, context);
  if (action === 'settings') {
    const environment = parseEnvironment(body.environment);
    const targets = body.targets !== undefined ? parseDeployTargets(body.targets) : undefined;
    const workerName = targets ? targets[0].workerName : requireString(body.workerName, 'Worker', 63);
    const mapping = await context.mappedWorkers();
    for (const name of targets ? targets.map((target) => target.workerName) : [workerName]) if (!mapping?.workers.some((worker) => worker.id === name)) throw new ApiError(400, 'WORKER_NOT_MAPPED', `Choose Workers linked to this repository in its Cloudflare tab (${name} is not linked).`);
    const trigger = body.trigger ?? body.confirmation ?? defaultTrigger(environment);
    if (!['immediate', 'gradual'].includes(String(body.rollout))) throw new ApiError(400, 'INVALID_ROLLOUT', 'Choose immediate (100%) or gradual (10% then 100%).');
    if (!['manual', 'auto'].includes(String(trigger))) throw new ApiError(400, 'INVALID_TRIGGER', 'Choose manual or automatic deployment.');
    if (body.mode !== undefined && !['deploy', 'upload-only'].includes(String(body.mode))) throw new ApiError(400, 'INVALID_DEPLOY_MODE', 'Choose deploy or upload-only.');
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Set enabled to true or false.');
    if (principal.credentialId || !['Owner', 'Deployer'].includes(principal.role)) throw new ApiError(403, 'DEPLOYER_REQUIRED', 'Only an Owner or Deployer can change deployment settings.');
    if (environment === PRODUCTION && trigger === 'auto' && principal.role !== 'Owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only an Owner can turn on automatic production deployment.');
    const configured = configuredEnvironments((await context.ledger.state()).settings);
    if (!configured.includes(environment) && configured.length >= DEPLOY_ENVIRONMENTS_MAX) throw new ApiError(409, 'DEPLOY_ENVIRONMENTS_LIMIT', `A repository can deploy to at most ${DEPLOY_ENVIRONMENTS_MAX} environments.`);
    for (const name of targets ? targets.map((target) => target.workerName) : [workerName]) await context.authorizeDeploy(name);
    const value: DeployEnvironmentSettings = { enabled: body.enabled, workerName, accountId: mapping!.accountId, rollout: body.rollout as DeployRollout, trigger: trigger as DeployTrigger, mode: (body.mode as DeployMode | undefined) ?? 'deploy', ...(targets ? { targets } : {}), authorizedBy: backgroundPrincipal(principal), updatedAt: now };
    await context.audit?.(`repository.deploy-settings.${environment}.${value.trigger}.${value.mode}${value.enabled ? '' : '.disabled'}`);
    return Response.json({ settings: publicSettings(await context.ledger.saveEnvironment(environment, value)) });
  }
  if (action !== 'deploy' && action !== 'rollback' && action !== 'promote') throw new ApiError(400, 'INVALID_DEPLOY_ACTION', 'Choose settings, apply_detected, deploy, promote or rollback.');
  if (principal.credentialId) throw new ApiError(403, 'DEPLOYER_REQUIRED', 'Task credentials cannot deploy.');
  const state = await context.ledger.state();
  let record: DeploymentRecord;
  if (action === 'deploy' && body.deploymentId !== undefined) {
    const id = requireString(body.deploymentId, 'Deployment', 80);
    const pending = await context.ledger.get(id);
    if (!pending) throw new ApiError(404, 'DEPLOYMENT_NOT_FOUND', 'This deployment could not be found.');
    if (body.environment !== undefined && parseEnvironment(body.environment) !== pending.environment) throw new ApiError(409, 'ENVIRONMENT_MISMATCH', `This deployment targets ${pending.environment}.`);
    if (pending.environment === 'production' && pending.status === 'awaiting_confirmation' && principal.role !== 'Owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only an Owner can confirm a production deployment.');
    const workers = pending.targets?.length ? pending.targets.map((target) => target.workerName) : [pending.workerName];
    for (const name of workers) await context.authorizeDeploy(name);
    record = await context.ledger.confirm(id, principal.userId);
  } else if (action === 'deploy') {
    const environment = chooseEnvironment(body.environment, state.settings);
    const value = environmentSettings(state.settings, environment);
    for (const target of settingsTargets(value)) await context.authorizeDeploy(target.workerName);
    const commitSha = requireString(body.commitSha, 'Commit', 40, 40);
    if (!sha.test(commitSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
    if (await context.headSha() !== commitSha) throw new ApiError(409, 'DEPLOY_COMMIT_NOT_HEAD', `Only the current ${context.repository.defaultBranch} head can be deployed. Refresh and try again.`);
    const selection = selectedWorkers(body.targets, value);
    const status = environment === 'production' ? productionStatus(value, principal, body.confirm) : 'queued';
    record = await context.ledger.create(key, JSON.stringify(['deploy', environment, commitSha, value.workerName, selection ?? 'all']), environmentRecord(context.repository.id, environment, value, principal.userId, { commitSha, trigger: 'manual', status, ...(selection ? { selectedWorkers: selection } : {}) }));
  } else if (action === 'promote') {
    const destination = body.environment !== undefined ? parseEnvironment(body.environment) : PRODUCTION;
    const from = body.from !== undefined ? parseEnvironment(body.from) : undefined;
    if (from === PRODUCTION) throw new ApiError(400, 'INVALID_ENVIRONMENT', 'Production deployments cannot be promoted; promote from a non-production environment.');
    const target = environmentSettings(state.settings, destination);
    const source = body.deploymentId !== undefined ? await context.ledger.get(requireString(body.deploymentId, 'Deployment', 80)) : state.deployments.find((item) => isPromotable(item) && item.environment !== destination && (!from || item.environment === from));
    if (!source) throw new ApiError(404, 'DEPLOYMENT_NOT_FOUND', `No successful ${from ?? 'non-production'} deployment is recorded to promote.`);
    if (!isPromotable(source) || source.environment === destination) throw new ApiError(409, 'DEPLOYMENT_NOT_PROMOTABLE', `Only a successful deployment of a landed commit in another non-production environment can be promoted to ${destination}.`);
    if (from && source.environment !== from) throw new ApiError(409, 'ENVIRONMENT_MISMATCH', `This deployment ran in ${source.environment}, not ${from}.`);
    for (const item of settingsTargets(target)) await context.authorizeDeploy(item.workerName);
    record = await context.ledger.create(key, JSON.stringify(['promote', source.id, destination]), environmentRecord(context.repository.id, destination, target, principal.userId, {
      commitSha: source.commitSha, trigger: 'promote', status: destination === PRODUCTION ? productionStatus(target, principal, body.confirm) : 'queued', promotedFrom: source.id,
      ...(promotedConfigs(source) ? { selectedConfigs: promotedConfigs(source) } : {}),
      ...(source.baseSha ? { baseSha: source.baseSha } : {}), ...(source.missionId ? { missionId: source.missionId } : {}),
    }));
  } else {
    const environment = chooseEnvironment(body.environment, state.settings);
    const value = environmentSettings(state.settings, environment);
    for (const target of settingsTargets(value)) await context.authorizeDeploy(target.workerName);
    const target = rollbackTarget(state.deployments.filter((item) => item.environment === environment));
    for (const item of target.targets) await context.authorizeDeploy(item.workerName);
    record = await context.ledger.create(key, JSON.stringify(['rollback', target.current.id, target.versionId]), { ...environmentRecord(context.repository.id, environment, value, principal.userId, { commitSha: target.commitSha, trigger: 'rollback', status: 'queued' }), mode: 'deploy', versionId: target.versionId, rollbackOf: target.current.id, targets: target.targets });
  }
  if (record.status === 'queued' && await context.dispatch(record) === 'missing') {
    await context.failDispatch(record);
    throw new ApiError(503, 'DEPLOYMENT_NOT_STARTED', 'The deployment could not be scheduled. Nothing was deployed; try again.');
  }
  return Response.json({ deployment: record, ...(record.status === 'awaiting_confirmation' ? { confirmationRequired: 'Owner' } : {}) }, { status: 202 });
}

export function landedDeployments(settings: DeploySettings | null, repositoryId: string, missionId: string, commitSha: string, baseSha?: string): DeploymentRecord[] {
  if (!settings || !sha.test(commitSha)) return [];
  const fields = { commitSha, missionId, trigger: 'land' as const, ...(baseSha && sha.test(baseSha) ? { baseSha } : {}) };
  const enabled = configuredEnvironments(settings).filter((environment) => settings.environments[environment]?.enabled);
  const preProduction = enabled.filter((environment) => environment !== PRODUCTION);
  return (preProduction.length ? preProduction : enabled).map((environment) => {
    const value = settings.environments[environment]!;
    return environmentRecord(repositoryId, environment, value, value.authorizedBy.userId, { ...fields, status: value.trigger === 'auto' ? 'queued' : 'awaiting_confirmation' });
  });
}

export function promotionSource(settings: DeploySettings | null): DeployEnvironment | null {
  const candidates = configuredEnvironments(settings).filter((environment) => environment !== PRODUCTION && settings?.environments[environment]?.enabled);
  return candidates[0] ?? null;
}

export function automaticPromotion(settings: DeploySettings | null, staging: DeploymentRecord | undefined): DeploymentRecord | null {
  const production = settings?.environments.production;
  if (!staging || !isPromotable(staging) || staging.environment !== promotionSource(settings) || !production?.enabled || production.trigger !== 'auto') return null;
  return environmentRecord(staging.repositoryId, 'production', production, production.authorizedBy.userId, {
    commitSha: staging.commitSha, trigger: 'promote', status: 'queued', promotedFrom: staging.id,
    ...(promotedConfigs(staging) ? { selectedConfigs: promotedConfigs(staging) } : {}),
    ...(staging.baseSha ? { baseSha: staging.baseSha } : {}), ...(staging.missionId ? { missionId: staging.missionId } : {}),
  });
}
