import type { Repository } from '../shared/types';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey, requireString } from './domain';
import type { Principal } from './security';
import type { SqlStore } from './store';
import type { WorkerBundle } from './worker-bundle';
import { WorkerBuildFailure } from './worker-bundle';

export const DEPLOY_STEP_MS = 1_800_000;
export const GRADUAL_INITIAL_PERCENTAGE = 10;
export const GRADUAL_SOAK_MS = 600_000;
export const DEPLOYMENT_HISTORY_LIMIT = 100;

export type DeployEnvironment = 'production' | 'staging';
export type DeployRollout = 'immediate' | 'gradual';
export type DeployConfirmation = 'manual' | 'auto';
export type DeploymentStatus = 'awaiting_confirmation' | 'queued' | 'building' | 'deploying' | 'rolling_out' | 'succeeded' | 'failed' | 'superseded';
export type DeploymentTrigger = 'land' | 'manual' | 'rollback';
export interface DeploySettings {
  enabled: boolean;
  workerName: string;
  accountId: string;
  environment: DeployEnvironment;
  rollout: DeployRollout;
  confirmation: DeployConfirmation;
  authorizedBy: Principal;
  updatedAt: string;
}
export interface DeploymentRecord {
  id: string;
  attemptId: string;
  repositoryId: string;
  workerName: string;
  accountId: string;
  environment: DeployEnvironment;
  rollout: DeployRollout;
  commitSha: string | null;
  missionId?: string;
  trigger: DeploymentTrigger;
  status: DeploymentStatus;
  percentage: number;
  versionId?: string;
  previousVersionId?: string;
  rollbackOf?: string;
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

export const deployWorkflowId = (deploymentId: string) => `deploy-${deploymentId}`;

export function backgroundPrincipal(principal: Principal): Principal {
  return { userId: principal.userId, workspaceId: principal.workspaceId, role: principal.role };
}

export function publicSettings(settings: DeploySettings | null): Omit<DeploySettings, 'authorizedBy'> & { authorizedBy: string } | null {
  if (!settings) return null;
  const { authorizedBy, ...rest } = settings;
  return { ...rest, authorizedBy: authorizedBy.userId };
}

export function deploymentId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}-${crypto.randomUUID()}`;
}

export class DeploymentLedger {
  constructor(private readonly store: SqlStore) {}

  state(limit = 50): DeployState {
    const deployments = this.store.list<DeploymentRecord>('deployment:').reverse().slice(0, limit);
    return { settings: this.store.get<DeploySettings>('deploy-settings') ?? null, deployments };
  }

  settings(): DeploySettings | null { return this.store.get<DeploySettings>('deploy-settings') ?? null; }

  saveSettings(settings: DeploySettings): DeploySettings {
    this.store.put('deploy-settings', settings);
    return settings;
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
    const blocking = (item: DeploymentRecord) => ACTIVE.includes(item.status) && !(record.trigger === 'rollback' && item.status === 'rolling_out');
    if (record.status !== 'awaiting_confirmation' && records.some(blocking)) throw new ApiError(409, 'DEPLOYMENT_IN_PROGRESS', 'Another deployment of this repository is still running. Wait for it to finish.');
    for (const item of records) if (item.status === 'awaiting_confirmation' || (record.trigger === 'rollback' && item.status === 'rolling_out')) this.store.put(`deployment:${item.id}`, { ...item, status: 'superseded', updatedAt: record.createdAt } satisfies DeploymentRecord);
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
    if (this.store.list<DeploymentRecord>('deployment:').some((item) => ACTIVE.includes(item.status))) throw new ApiError(409, 'DEPLOYMENT_IN_PROGRESS', 'Another deployment of this repository is still running. Wait for it to finish.');
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
  uploadVersion(bundle: WorkerBundle, annotations: Record<string, string>): Promise<{ id: string }>;
  latestDeployment(): Promise<WorkerVersionDeployment | null>;
  deploy(versions: { version_id: string; percentage: number }[], message: string): Promise<{ id: string }>;
}

export const DEPLOY_KEEP_BINDINGS = ['plain_text', 'json', 'secret_text', 'secret_key', 'kv_namespace', 'd1', 'r2_bucket', 'durable_object_namespace', 'service', 'queue', 'workflow', 'ai', 'browser', 'vectorize', 'hyperdrive', 'analytics_engine', 'dispatch_namespace', 'mtls_certificate', 'send_email', 'secrets_store_secret', 'version_metadata', 'images', 'pipelines', 'ratelimit', 'assets', 'artifacts'];

export function versionUploadForm(bundle: WorkerBundle, annotations: Record<string, string>): FormData {
  const form = new FormData();
  form.set('metadata', JSON.stringify({
    main_module: bundle.mainModule,
    compatibility_date: bundle.config.compatibilityDate,
    ...(bundle.config.compatibilityFlags.length ? { compatibility_flags: bundle.config.compatibilityFlags } : {}),
    bindings: [],
    keep_bindings: DEPLOY_KEEP_BINDINGS,
    annotations,
  }));
  for (const module of bundle.modules) form.set(module.name, new File([module.content], module.name, { type: module.contentType }));
  return form;
}

export function rolloutVersions(rollout: DeployRollout, versionId: string, previous: WorkerVersionDeployment | null): { versions: { version_id: string; percentage: number }[]; percentage: number; previousVersionId?: string } {
  const previousVersionId = previous?.versions.slice().sort((a, b) => b.percentage - a.percentage).find((version) => version.version_id !== versionId)?.version_id;
  if (rollout === 'gradual' && previousVersionId) return { versions: [{ version_id: versionId, percentage: GRADUAL_INITIAL_PERCENTAGE }, { version_id: previousVersionId, percentage: 100 - GRADUAL_INITIAL_PERCENTAGE }], percentage: GRADUAL_INITIAL_PERCENTAGE, previousVersionId };
  return { versions: [{ version_id: versionId, percentage: 100 }], percentage: 100, ...(previousVersionId ? { previousVersionId } : {}) };
}

export interface DeployCoordinator {
  getRepository(repositoryId: string): Promise<Repository | undefined>;
  getDeployment(id: string): Promise<DeploymentRecord | undefined>;
  updateDeployment(id: string, expected: DeploymentStatus[], patch: Partial<DeploymentRecord>): Promise<DeploymentRecord | null>;
}
export interface DeployDependencies {
  coordinator: DeployCoordinator;
  authorize(principal: Principal, workerName: string): Promise<void>;
  deployer(principal: Principal, record: DeploymentRecord): Promise<WorkerDeployer>;
  build(repository: Repository, record: DeploymentRecord, assertAuthority: () => Promise<void>): Promise<WorkerBundle>;
}
export interface DeployStepRunner {
  do<T>(name: string, config: { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number }, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
}

function failure(error: unknown): { errorCode: string; error: string } {
  if (error instanceof ApiError) return { errorCode: error.code, error: error.detail };
  if (error instanceof WorkerBuildFailure) return { errorCode: error.code, error: error.message };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error instanceof Error) return { errorCode: error.code, error: error.message.slice(0, 700) };
  return { errorCode: 'DEPLOYMENT_FAILED', error: error instanceof Error ? error.message.slice(0, 700) : 'The deployment failed.' };
}

type UploadOutcome = { kind: 'stale' } | { kind: 'failed' } | { kind: 'uploaded'; versionId: string };

export async function runDeployment(params: DeployParams, step: DeployStepRunner, dependencies: DeployDependencies): Promise<void> {
  const { coordinator } = dependencies;
  const { deploymentId: id, principal } = params;
  const fail = async (error: unknown) => { await coordinator.updateDeployment(id, ACTIVE, { status: 'failed', ...failure(error) }); };
  const uploaded = await step.do('build and upload worker version', { retries: { limit: 0, delay: '1 second' }, timeout: DEPLOY_STEP_MS }, async (): Promise<UploadOutcome> => {
    const record = await coordinator.getDeployment(id);
    if (!record || record.status !== 'queued') return { kind: 'stale' };
    try {
      await dependencies.authorize(principal, record.workerName);
      const deployer = await dependencies.deployer(principal, record);
      if (record.trigger === 'rollback') {
        if (!record.versionId) throw new ApiError(409, 'ROLLBACK_TARGET_MISSING', 'No earlier version is recorded for rollback.');
        await coordinator.updateDeployment(id, ['queued'], { status: 'deploying' });
        return { kind: 'uploaded', versionId: record.versionId };
      }
      const repository = await coordinator.getRepository(record.repositoryId);
      if (!repository || !record.commitSha) throw new ApiError(409, 'DEPLOY_COMMIT_INVALID', 'The landed commit for this deployment is unavailable.');
      if (!await coordinator.updateDeployment(id, ['queued'], { status: 'building' })) return { kind: 'stale' };
      const bundle = await dependencies.build(repository, record, () => dependencies.authorize(principal, record.workerName));
      const version = await deployer.uploadVersion(bundle, { 'workers/commit_sha': record.commitSha, 'workers/message': `Gitflare ${record.trigger} ${record.commitSha.slice(0, 12)}`.slice(0, 100), 'workers/tag': record.commitSha.slice(0, 12) });
      await coordinator.updateDeployment(id, ['building'], { status: 'deploying', versionId: version.id });
      return { kind: 'uploaded', versionId: version.id };
    } catch (error) {
      await fail(error);
      return { kind: 'failed' };
    }
  });
  if (uploaded.kind !== 'uploaded') return;
  const first = await step.do('deploy worker version', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
    const record = await coordinator.getDeployment(id);
    if (!record || record.status !== 'deploying') return { gradual: false };
    try {
      await dependencies.authorize(principal, record.workerName);
      const deployer = await dependencies.deployer(principal, record);
      const plan = rolloutVersions(record.trigger === 'rollback' ? 'immediate' : record.rollout, uploaded.versionId, await deployer.latestDeployment());
      await deployer.deploy(plan.versions, `Gitflare ${record.trigger}${record.commitSha ? ` ${record.commitSha.slice(0, 12)}` : ''}`);
      const gradual = plan.percentage < 100;
      await coordinator.updateDeployment(id, ['deploying'], { status: gradual ? 'rolling_out' : 'succeeded', percentage: plan.percentage, ...(record.trigger === 'rollback' ? {} : plan.previousVersionId ? { previousVersionId: plan.previousVersionId } : {}) });
      return { gradual };
    } catch (error) {
      await fail(error);
      return { gradual: false };
    }
  });
  if (!first.gradual) return;
  await step.sleep('observe gradual rollout', GRADUAL_SOAK_MS);
  await step.do('promote worker version', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
    const record = await coordinator.getDeployment(id);
    if (!record || record.status !== 'rolling_out' || !record.versionId) return true;
    try {
      await dependencies.authorize(principal, record.workerName);
      const deployer = await dependencies.deployer(principal, record);
      await deployer.deploy([{ version_id: record.versionId, percentage: 100 }], `Gitflare promote ${record.commitSha?.slice(0, 12) ?? record.versionId}`);
      await coordinator.updateDeployment(id, ['rolling_out'], { status: 'succeeded', percentage: 100 });
    } catch (error) { await fail(error); }
    return true;
  });
}

export function rollbackTarget(deployments: DeploymentRecord[]): { current: DeploymentRecord; versionId: string; commitSha: string | null } {
  const current = deployments.find((item) => item.status === 'succeeded' || item.status === 'rolling_out');
  if (!current?.versionId) throw new ApiError(409, 'NOTHING_TO_ROLL_BACK', 'No successful deployment is recorded for this repository.');
  const versionId = current.trigger === 'rollback' ? deployments.find((item) => item.id !== current.id && item.versionId && item.versionId !== current.versionId && item.status === 'succeeded' && item.createdAt < current.createdAt)?.versionId : current.previousVersionId;
  if (!versionId) throw new ApiError(409, 'ROLLBACK_TARGET_MISSING', 'No earlier Worker version is recorded for rollback.');
  return { current, versionId, commitSha: deployments.find((item) => item.versionId === versionId && item.trigger !== 'rollback')?.commitSha ?? null };
}

export interface DeployApiContext {
  repository: Repository;
  principal: Principal;
  ledger: {
    state(): Promise<DeployState>;
    saveSettings(settings: DeploySettings): Promise<DeploySettings>;
    create(key: string, fingerprint: string, record: DeploymentRecord): Promise<DeploymentRecord>;
    confirm(id: string, actorId: string): Promise<DeploymentRecord>;
  };
  authorizeRead(): Promise<void>;
  authorizeDeploy(workerName: string): Promise<void>;
  canDeploy(workerName: string): Promise<boolean>;
  mappedWorkers(): Promise<{ accountId: string; workers: { id: string; name: string; environment: string }[] } | null>;
  headSha(): Promise<string | null>;
  dispatch(record: DeploymentRecord): Promise<'running' | 'finished' | 'missing'>;
  failDispatch(record: DeploymentRecord): Promise<void>;
}

const ENVIRONMENTS: DeployEnvironment[] = ['production', 'staging'];

export async function deploymentsApi(request: Request, context: DeployApiContext): Promise<Response> {
  const { principal } = context;
  await context.authorizeRead();
  if (request.method === 'GET') {
    const [state, mapping] = await Promise.all([context.ledger.state(), context.mappedWorkers()]);
    const target = state.settings?.workerName;
    return Response.json({ settings: publicSettings(state.settings), deployments: state.deployments, workers: mapping?.workers ?? [], canDeploy: target ? await context.canDeploy(target) : false, requiredScope: 'workers-scripts.write' });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request);
  const action = body.action;
  const now = new Date().toISOString();
  if (action === 'settings') {
    const workerName = requireString(body.workerName, 'Worker', 63);
    const mapping = await context.mappedWorkers();
    if (!mapping?.workers.some((worker) => worker.id === workerName)) throw new ApiError(400, 'WORKER_NOT_MAPPED', 'Choose a Worker linked to this repository in its Cloudflare tab.');
    if (!ENVIRONMENTS.includes(body.environment as DeployEnvironment)) throw new ApiError(400, 'INVALID_ENVIRONMENT', 'Choose production or staging.');
    if (!['immediate', 'gradual'].includes(String(body.rollout))) throw new ApiError(400, 'INVALID_ROLLOUT', 'Choose immediate (100%) or gradual (10% then 100%).');
    if (!['manual', 'auto'].includes(String(body.confirmation))) throw new ApiError(400, 'INVALID_CONFIRMATION', 'Choose manual or automatic deployment after landing.');
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Set enabled to true or false.');
    if (principal.credentialId || !['Owner', 'Deployer'].includes(principal.role)) throw new ApiError(403, 'DEPLOYER_REQUIRED', 'Only an Owner or Deployer can change deployment settings.');
    await context.authorizeDeploy(workerName);
    const settings: DeploySettings = { enabled: body.enabled, workerName, accountId: mapping.accountId, environment: body.environment as DeployEnvironment, rollout: body.rollout as DeployRollout, confirmation: body.confirmation as DeployConfirmation, authorizedBy: backgroundPrincipal(principal), updatedAt: now };
    return Response.json({ settings: publicSettings(await context.ledger.saveSettings(settings)) });
  }
  if (action !== 'deploy' && action !== 'rollback') throw new ApiError(400, 'INVALID_DEPLOY_ACTION', 'Choose settings, deploy or rollback.');
  const state = await context.ledger.state();
  const settings = state.settings;
  if (!settings) throw new ApiError(409, 'DEPLOY_NOT_CONFIGURED', 'Choose a target Worker in deployment settings first.');
  if (principal.credentialId) throw new ApiError(403, 'DEPLOYER_REQUIRED', 'Task credentials cannot deploy.');
  await context.authorizeDeploy(settings.workerName);
  const base = { repositoryId: context.repository.id, workerName: settings.workerName, accountId: settings.accountId, environment: settings.environment, rollout: settings.rollout, actorId: principal.userId, createdAt: now, updatedAt: now, percentage: 0 };
  let record: DeploymentRecord;
  if (action === 'deploy' && body.deploymentId !== undefined) {
    const id = requireString(body.deploymentId, 'Deployment', 80);
    record = await context.ledger.confirm(id, principal.userId);
  } else if (action === 'deploy') {
    const commitSha = requireString(body.commitSha, 'Commit', 40, 40);
    if (!sha.test(commitSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
    if (await context.headSha() !== commitSha) throw new ApiError(409, 'DEPLOY_COMMIT_NOT_HEAD', `Only the current ${context.repository.defaultBranch} head can be deployed. Refresh and try again.`);
    record = await context.ledger.create(key, JSON.stringify(['deploy', commitSha, settings.workerName]), { ...base, id: deploymentId(), attemptId: crypto.randomUUID(), commitSha, trigger: 'manual', status: 'queued' });
  } else {
    const target = rollbackTarget(state.deployments.filter((item) => item.workerName === settings.workerName));
    record = await context.ledger.create(key, JSON.stringify(['rollback', target.current.id, target.versionId]), { ...base, id: deploymentId(), attemptId: crypto.randomUUID(), commitSha: target.commitSha, trigger: 'rollback', status: 'queued', versionId: target.versionId, rollbackOf: target.current.id });
  }
  if (record.status === 'queued' && await context.dispatch(record) === 'missing') {
    await context.failDispatch(record);
    throw new ApiError(503, 'DEPLOYMENT_NOT_STARTED', 'The deployment could not be scheduled. Nothing was deployed; try again.');
  }
  return Response.json({ deployment: record }, { status: 202 });
}

export function landedDeployment(settings: DeploySettings | null, repositoryId: string, missionId: string, commitSha: string): DeploymentRecord | null {
  if (!settings?.enabled || !sha.test(commitSha)) return null;
  const now = new Date().toISOString();
  return { id: deploymentId(), attemptId: crypto.randomUUID(), repositoryId, workerName: settings.workerName, accountId: settings.accountId, environment: settings.environment, rollout: settings.rollout, commitSha, missionId, trigger: 'land', status: settings.confirmation === 'auto' ? 'queued' : 'awaiting_confirmation', percentage: 0, actorId: settings.authorizedBy.userId, createdAt: now, updatedAt: now };
}
