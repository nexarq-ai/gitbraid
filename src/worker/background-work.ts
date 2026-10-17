import { ApiError } from './domain';
import { securityClient, type Principal } from './security';
import type { AppEnv } from './env';
import { repositoryHead } from './artifacts';
import { landingRule } from './branch-protection';
import { LANDING_STEP_MS, PREVIEW_STEP_MS } from './budgets';
import { catalogName } from './capacity';
import { PREVIEW_HEARTBEAT_MS, type PreviewHost, type WorkerPreviewRecord } from './coordinator';
import { buildLandedWorker, integrateCandidate, IntegrationFailure, prepareCandidatePreview, PreviewFailure } from './execution';
import { deleteWorkerPreview, previewAlias, upsertWorkerPreview, WorkerPreviewError, type WorkerPreviewsConfig } from './worker-previews';
import { resolveWorkerPreviewsConfig } from './installation-credential';
import { WorkerBuildFailure } from './worker-bundle';
import { changedPaths } from './deploy-changes';
import { automaticPromotion, deployWorkflowId, landedDeployments, policyDeployTargets, runDeployment, wranglerEnvironment, type DeploymentRecord, type DeployParams } from './deployments';
import { cloudflareDeployClient, type CloudflareDeployAccess } from './cloudflare-deploy';
import { bindPreviewD1, deletePreviewD1 } from './preview-d1';
import { cloudflareDeployAccess, cloudflareWorkerDeployer } from './cloudflare';
import { previewLifetimeMs } from './preview-settings';
import { previewTarget, resolvePreviewHost, type PreviewTarget, type ProjectWorkers } from './preview-host';
import { ensurePreviewAccess } from './preview-access';
import { previewAccessIncludes } from './preview-settings-api';
import { POLICY_FILE } from './repository-policy';
import type { ProjectSnapshot } from './cloudflare-projects';
import { declaresRoutes, detectDeploySetup, environmentBlock, parseWranglerConfig, scanRepository, withAccountFacts, type DetectedSetup } from './deploy-detect';
import type { Repository } from '../shared/types';

export interface LandingParams { kind: 'land'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; baseSha: string; claimId: string; principal: Principal }
export interface PreviewParams { kind: 'preview'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; claimId: string; principal: Principal }
export interface PreviewRetireParams { kind: 'preview-retire'; repositoryId: string; missionId: string; previewName: string; workspaceId: string; d1DatabaseIds?: string[]; host?: PreviewHost; principal?: Principal }
export interface StepConfig { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number }
export interface StepRunner { do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>; sleep?(name: string, duration: number): Promise<void> }
interface WorkflowBinding<P> {
  create(options: { id: string; params: P }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
type LandingOutcome = { kind: 'stale' } | { kind: 'pushed'; sha: string } | { kind: 'failed'; outcome: 'not_pushed' | 'unknown'; reason: string };
export type BackgroundState = 'running' | 'finished' | 'missing';

const ACTIVE = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];

export const landingWorkflowId = (claimId: string) => `land-${claimId}`;
export const previewWorkflowId = (claimId: string) => `preview-${claimId}`;
export const previewRetireWorkflowId = (claimId: string) => `preview-retire-${claimId}`;

export async function backgroundState<P>(workflow: WorkflowBinding<P>, id: string): Promise<BackgroundState> {
  try { return ACTIVE.includes((await (await workflow.get(id)).status()).status) ? 'running' : 'finished'; }
  catch { return 'missing'; }
}

export async function dispatchBackground<P>(workflow: WorkflowBinding<P>, id: string, params: P): Promise<BackgroundState> {
  try {
    await workflow.create({ id, params });
    return 'running';
  } catch { return backgroundState(workflow, id); }
}

function staleExecution(error: unknown): boolean { return error instanceof Error && /STALE_EXECUTION/.test(error.message); }

export async function landCandidate(env: AppEnv, params: LandingParams, step: StepRunner): Promise<void> {
  const { repositoryId, missionId, epoch, candidateSha, baseSha, claimId, principal } = params;
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const access = securityClient(env);
  const push = (name: string, integrationAttemptId: string) => step.do(name, { retries: { limit: 0, delay: '1 second' }, timeout: LANDING_STEP_MS }, async (): Promise<LandingOutcome> => {
    const [claim, mission, repository] = await Promise.all([coordinator.integrationClaim(), coordinator.getMission(missionId), coordinator.getRepository(repositoryId)]);
    if (claim?.claimId !== claimId || !mission || !repository || mission.status !== 'integrating') return { kind: 'stale' };
    // A replayed step must not push again once the claim recorded a push attempt
    if (claim.phase === 'pushing') return { kind: 'failed', outcome: 'unknown', reason: 'An earlier landing step had already started the canonical push' };
    try {
      const result = await integrateCandidate(env, {
        repository, mission, integrationAttemptId,
        beforePush: () => coordinator.claimIntegrationPush(missionId, epoch, claimId),
        assertAuthority: async () => {
          await access.check(principal, 'land', 'repository', repositoryId, missionId);
          await access.assertLand(principal, missionId, candidateSha, baseSha, epoch, repositoryId, landingRule(await coordinator.getBranchProtection(), repository.defaultBranch));
        },
      });
      return { kind: 'pushed', sha: result.sha };
    } catch (error) {
      return error instanceof IntegrationFailure ? { kind: 'failed', outcome: error.outcome, reason: error.message } : { kind: 'failed', outcome: 'unknown', reason: 'Landing failed with an unexpected error' };
    }
  });
  const first = await push('push approved candidate', claimId);
  if (first.kind === 'stale') return;
  const retrying = first.kind === 'failed' && first.outcome === 'not_pushed' && await step.do('retry landing that pushed nothing', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const repository = await coordinator.getRepository(repositoryId);
    if (!repository || !env.ARTIFACTS) throw new Error('Repository services are unavailable');
    if (await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch) !== baseSha) return false;
    return coordinator.retryIntegration(missionId, epoch, claimId, first.reason);
  });
  const settled = retrying ? await push('push approved candidate on a fresh runner', `${claimId}-retry`) : first;
  if (settled.kind === 'stale') return;
  const landed = await step.do('record landing outcome', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const repository = await coordinator.getRepository(repositoryId);
    if (!repository || !env.ARTIFACTS) throw new Error('Repository services are unavailable');
    const head = settled.kind === 'pushed' ? settled.sha : await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch).catch(() => null);
    try {
      if (head === candidateSha) {
        await coordinator.completeIntegration(missionId, epoch, candidateSha, claimId);
        const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
        const listed = await catalog.getRepository(repositoryId);
        if (listed) await catalog.saveRepository({ ...listed, headSha: candidateSha, updatedAt: new Date().toISOString() });
        return true;
      }
      const failure = settled.kind === 'failed' ? settled : { outcome: 'unknown' as const, reason: `The default branch did not show pushed commit ${candidateSha.slice(0, 12)}` };
      await coordinator.integrationFailed(missionId, epoch, claimId, failure.outcome, failure.reason);
    } catch (error) { if (!staleExecution(error)) throw error; }
    return false;
  });
  if (!landed) return;
  await step.do('retire candidate preview and schedule deployment', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    await retireWorkerPreview(env, repositoryId, missionId, principal.workspaceId);
    await scheduleLandedDeployment(env, repositoryId, missionId, epoch, candidateSha, baseSha);
    return true;
  });
}

export async function retireWorkerPreview(env: AppEnv, repositoryId: string, missionId: string, workspaceId: string): Promise<void> {
  if (!env.MISSION_WORKFLOW) return;
  const record = await env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`).retireWorkerPreview(missionId);
  if (!record) return;
  if (await dispatchBackground(env.MISSION_WORKFLOW, previewRetireWorkflowId(record.claimId), retireParams(repositoryId, missionId, workspaceId, record)) === 'missing') console.error('preview.retire.dispatch.failed', missionId);
}

function retireParams(repositoryId: string, missionId: string, workspaceId: string, record: WorkerPreviewRecord): PreviewRetireParams {
  return { kind: 'preview-retire', repositoryId, missionId, previewName: record.previewName, workspaceId, ...(record.d1DatabaseIds?.length ? { d1DatabaseIds: record.d1DatabaseIds } : {}), ...(record.host ? { host: record.host } : {}), ...(record.principal ? { principal: record.principal } : {}) };
}

export async function scheduleLandedDeployment(env: AppEnv, repositoryId: string, missionId: string, epoch: number, commitSha: string, baseSha?: string): Promise<void> {
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const { settings } = await coordinator.deployState();
  for (const draft of landedDeployments(settings, repositoryId, missionId, commitSha, baseSha)) {
    const principal = settings?.environments[draft.environment]?.authorizedBy;
    if (!principal) continue;
    await createAndDispatchDeployment(env, coordinator, draft, principal, `land-${missionId}-${epoch}${draft.environment === 'production' ? '' : `-${draft.environment}`}`, JSON.stringify(['land', missionId, epoch, commitSha, draft.environment]));
  }
}

async function createAndDispatchDeployment(env: AppEnv, coordinator: ReturnType<AppEnv['GITFLARE_COORDINATOR']['getByName']>, draft: DeploymentRecord, principal: DeployParams['principal'], key: string, fingerprint: string): Promise<void> {
  let record;
  try { record = await coordinator.createDeployment(key, fingerprint, draft); }
  catch (error) {
    if (!(error instanceof Error && /DEPLOYMENT_IN_PROGRESS/.test(error.message))) throw error;
    record = await coordinator.createDeployment(key, fingerprint, { ...draft, status: 'awaiting_confirmation' });
  }
  if (record.status === 'queued' && env.MISSION_WORKFLOW && await dispatchBackground(env.MISSION_WORKFLOW, deployWorkflowId(record.id), { kind: 'deploy', repositoryId: draft.repositoryId, deploymentId: record.id, principal } satisfies DeployParams) === 'missing') {
    await coordinator.updateDeployment(record.id, ['queued'], { status: 'failed', errorCode: 'DEPLOYMENT_NOT_STARTED', error: 'The deployment could not be scheduled. Deploy it manually.' });
  }
}

function previewsCall(config: { token: string; accountId: string }) {
  return cloudflareDeployClient({ accessToken: config.token, accountId: config.accountId, scopes: [], source: 'workspace' }).call;
}

function connectionAccess(env: AppEnv, principal: Principal, repositoryId: string, expectedAccountId?: string): Promise<CloudflareDeployAccess> {
  return cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repositoryId, ...(expectedAccountId ? { expectedAccountId } : {}) }, repositoryId);
}

async function retireConfig(env: AppEnv, params: PreviewRetireParams): Promise<WorkerPreviewsConfig | null> {
  const host = params.host;
  if (host?.kind === 'connection') {
    if (!params.principal) return null;
    try {
      const access = await connectionAccess(env, params.principal, params.repositoryId, host.accountId);
      return { accountId: access.accountId, workerName: host.workerName, token: access.accessToken, connection: access.source };
    } catch (error) {
      console.error('preview.retire.connection.unavailable', params.missionId, error instanceof Error ? error.message : 'unknown');
      return null;
    }
  }
  const config = await resolveWorkerPreviewsConfig(env);
  if (!config || (host && (host.accountId !== config.accountId || host.workerName !== config.workerName))) return null;
  return config;
}

export async function retirePreview(env: AppEnv, params: PreviewRetireParams, step: StepRunner): Promise<void> {
  const config = await retireConfig(env, params);
  if (config) {
    await step.do('delete worker preview', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => deleteWorkerPreview(config, params.previewName));
    const d1DatabaseIds = params.d1DatabaseIds ?? [];
    if (d1DatabaseIds.length) await step.do('delete preview D1 databases', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => deletePreviewD1(previewsCall(config), config.accountId, d1DatabaseIds));
  }
  await step.do('release preview capacity', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${params.repositoryId}`);
    if (!await coordinator.workerPreview(params.missionId)) await env.GITFLARE_COORDINATOR.getByName(catalogName(params.workspaceId)).releasePreviewSlot(params.missionId);
    return true;
  });
}

const DETECT_FILE_MAX_BYTES = 262_144;

async function readText(source: { readFile(args: { ref: string; path: string }): Promise<Blob | null> }, ref: string, path: string): Promise<string | null> {
  const file = await source.readFile({ ref, path });
  if (!file || file.size > DETECT_FILE_MAX_BYTES) return null;
  return file.text();
}

export async function detectRepositorySetup(env: AppEnv, principal: Principal, repository: Repository): Promise<DetectedSetup> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Deploy setup is detected from a connected Artifacts repository.');
  const head = await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch);
  if (!head) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before detecting the deploy setup.');
  using source = await env.ARTIFACTS.get(repository.name);
  const setup = await detectDeploySetup(await scanRepository(source, head), (path) => readText(source, head, path));
  let access: CloudflareDeployAccess;
  try { access = await connectionAccess(env, principal, repository.id); }
  catch (error) { return { ...setup, account: { connected: false, reason: error instanceof ApiError ? error.detail : 'Connect Cloudflare for this repository or workspace first.' } }; }
  return withAccountFacts(setup, cloudflareDeployClient(access).call, access.accountId, access.source);
}

async function policyBase(env: AppEnv, repositoryName: string, record: DeploymentRecord): Promise<string | null> {
  if (record.baseSha) return record.baseSha;
  if (!env.ARTIFACTS || !record.commitSha) return null;
  using repository = await env.ARTIFACTS.get(repositoryName);
  const commits = await repository.log({ ref: record.commitSha, limit: 2 });
  return commits[0]?.hash === record.commitSha ? commits[1]?.hash ?? null : null;
}

export async function deployLandedWorker(env: AppEnv, params: DeployParams, step: StepRunner & { sleep(name: string, duration: number): Promise<void> }): Promise<void> {
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${params.repositoryId}`);
  const access = securityClient(env);
  await runDeployment(params, step, {
    coordinator,
    authorize: (principal, workerName) => access.check(principal, 'deploy', 'environment', workerName),
    deployer: (principal, record, workerName) => cloudflareWorkerDeployer(env, principal, workerName, record.accountId, undefined, record.repositoryId),
    build: (repository, record, target, index, assertAuthority, publish) => buildLandedWorker(env, { repository, commitSha: record.commitSha!, attemptId: record.attemptId, assertAuthority, ...(target.inheritBindings ? {} : { target }), index, environment: wranglerEnvironment(record.environment) }, publish),
    policyTargets: async (repository, record) => {
      if (!env.ARTIFACTS) return null;
      const base = await policyBase(env, repository.name, record);
      if (!base) return null;
      using source = await env.ARTIFACTS.get(repository.name);
      const file = await source.readFile({ ref: base, path: POLICY_FILE });
      return policyDeployTargets(file ? await file.text() : null, record.environment);
    },
    changedPaths: async (repository, record) => {
      if (!env.ARTIFACTS || !record.baseSha || !record.commitSha) return null;
      using source = await env.ARTIFACTS.get(repository.name);
      return changedPaths(source, record.baseSha, record.commitSha);
    },
    mappedWorkers: async (principal, repositoryId) => {
      const { mapping } = await access.projectStore(principal, repositoryId, 'get') as ProjectSnapshot;
      return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map((resource) => resource.id) } : null;
    },
    declaresRoutes: async (repository, record, target) => {
      if (!env.ARTIFACTS || !record.commitSha || !target.configPath) return false;
      using source = await env.ARTIFACTS.get(repository.name);
      const content = await readText(source, record.commitSha, target.configPath);
      if (content === null) return false;
      try { return declaresRoutes(environmentBlock(parseWranglerConfig(target.configPath, content), record.environment)); } catch { return false; }
    },
  });
  await step.do('promote to production', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const [staging, { settings }] = await Promise.all([coordinator.getDeployment(params.deploymentId), coordinator.deployState()]);
    const draft = automaticPromotion(settings, staging);
    const principal = settings?.environments.production?.authorizedBy;
    if (draft && principal) await createAndDispatchDeployment(env, coordinator, draft, principal, `promote-${params.deploymentId}`, JSON.stringify(['promote', params.deploymentId]));
    return true;
  });
}

function durablePrincipal({ userId, workspaceId, role, credentialId, bootstrap }: Principal): Principal {
  return { userId, workspaceId, role, ...(credentialId ? { credentialId } : {}), ...(bootstrap ? { bootstrap } : {}) };
}

async function projectWorkers(env: AppEnv, principal: Principal, repositoryId: string): Promise<ProjectWorkers | null> {
  try {
    const { mapping } = await securityClient(env).projectStore(principal, repositoryId, 'get') as ProjectSnapshot;
    return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map((resource) => resource.id) } : null;
  } catch { return null; }
}

export async function preparePreview(env: AppEnv, params: PreviewParams, step: StepRunner): Promise<void> {
  const { repositoryId, missionId, epoch, candidateSha, claimId, principal } = params;
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  const access = securityClient(env);
  const prepared = await step.do('prepare candidate preview', { retries: { limit: 0, delay: '1 second' }, timeout: PREVIEW_STEP_MS }, async (): Promise<{ worker: boolean; expiresAt?: number; lifetimeMs?: number }> => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      try { await coordinator.renewPreview(missionId, epoch, candidateSha, claimId); }
      catch {}
      if (!finished) timer = setTimeout(renew, PREVIEW_HEARTBEAT_MS);
    };
    timer = setTimeout(renew, PREVIEW_HEARTBEAT_MS);
    try {
      const [mission, repository] = await Promise.all([coordinator.getMission(missionId), coordinator.getRepository(repositoryId)]);
      if (!mission || !repository || mission.epoch !== epoch || mission.candidateSha !== candidateSha) throw new PreviewFailure('The candidate changed before its preview started.');
      if (!env.SANDBOX) throw new PreviewFailure('The preview runner is unavailable.');
      const settings = await coordinator.getPreviewSettings();
      const lifetimeMs = previewLifetimeMs(settings, env);
      const lifetime = { lifetimeMs, extendMs: lifetimeMs };
      const { settings: deploy } = await coordinator.deployState();
      const target = previewTarget(settings, deploy, await projectWorkers(env, principal, repositoryId));
      const plan = await resolvePreviewHost(env, settings, target, {
        connection: (wanted: PreviewTarget) => connectionAccess(env, principal, repositoryId, wanted.accountId),
        installation: () => resolveWorkerPreviewsConfig(env),
      });
      const previews = plan.config;
      const host = plan.host;
      const alias = previews ? previewAlias(missionId, previews.workerName) : '';
      const previewCall = previews ? previewsCall(previews) : null;
      const prepared = await prepareCandidatePreview(env, {
        repository, mission, previewAttemptId: claimId, workerPreviews: !!previews, ...(plan.configPath ? { configPath: plan.configPath } : {}),
        assertAuthority: () => access.check(principal, 'read', 'repository', repositoryId, missionId),
        publishWorker: async (built) => {
          if (!previews || !previewCall || !host) throw new PreviewFailure('Worker previews are not configured for this installation.');
          if (host.access === 'cloudflare-access') await ensurePreviewAccess(previewCall, previews.accountId, previews.workerName, await previewAccessIncludes(env, principal, repositoryId, settings));
          const { uploadAssets } = built;
          const d1 = built.d1?.length ? await bindPreviewD1(previewCall, previews.accountId, built.d1) : undefined;
          return upsertWorkerPreview(previews, {
            alias,
            bundle: built.bundle,
            annotations: { 'workers/commit_sha': candidateSha, 'workers/message': mission.title.slice(0, 100), 'workers/pull_request_title': mission.title.slice(0, 100) },
            ...(uploadAssets ? { uploadAssets: () => uploadAssets(previewCall, previews.accountId, previews.workerName) } : {}),
            ...(d1 ? { d1 } : {}),
            inheritBaseConfig: host.kind === 'connection',
            emailRecipients: settings.previewEmailRecipients,
          });
        },
      });
      if (prepared.kind === 'worker') {
        const result = prepared.published;
        if (!result || !host) throw new PreviewFailure('The Worker preview was not published.');
        const expiresAt = await coordinator.workerPreviewReady(missionId, epoch, candidateSha, claimId, { previewName: alias, previewUrl: result.previewUrl, deploymentUrl: result.deploymentUrl, notes: [...plan.notes, ...result.notes].slice(0, 50), host, ...(result.baseBindings ? { baseBindings: result.baseBindings.slice(0, 50) } : {}), ...(result.d1Databases?.length ? { d1Databases: result.d1Databases } : {}) }, lifetime, durablePrincipal(principal));
        await catalog.holdPreviewSlot(missionId, expiresAt);
        return { worker: true, expiresAt, lifetimeMs };
      }
      const expiresAt = await coordinator.previewReady(missionId, epoch, candidateSha, claimId, prepared.sandboxName, lifetime);
      await env.SANDBOX.getByName(prepared.sandboxName).expireAt(expiresAt);
      await catalog.holdPreviewSlot(missionId, expiresAt);
    } catch (error) {
      const message = error instanceof PreviewFailure || error instanceof WorkerPreviewError || error instanceof WorkerBuildFailure ? error.message : error instanceof ApiError ? `The preview could not be started. ${error.detail}` : 'The preview could not be started.';
      const released = await coordinator.previewFailed(missionId, claimId, message).catch(() => false);
      await env.SANDBOX?.getByName(`preview-${missionId}-${claimId}`).destroy().catch(() => {});
      if (released) await catalog.releasePreviewSlot(missionId).catch(() => {});
    } finally {
      finished = true;
      clearTimeout(timer);
    }
    return { worker: false };
  });
  if (!prepared.worker || !step.sleep) return;
  await step.sleep('hold worker preview until expiry', prepared.lifetimeMs ?? 0);
  const extendedUntil = await step.do('read worker preview expiry', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
    const record = await coordinator.workerPreview(missionId);
    return record?.claimId === claimId ? record.expiresAt : 0;
  });
  if (extendedUntil > (prepared.expiresAt ?? 0)) await step.sleep('hold extended worker preview until expiry', extendedUntil - (prepared.expiresAt ?? 0));
  const expired = await step.do('retire expired worker preview', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => coordinator.retireWorkerPreview(missionId, claimId));
  if (expired) await retirePreview(env, retireParams(repositoryId, missionId, principal.workspaceId, expired), step);
}
