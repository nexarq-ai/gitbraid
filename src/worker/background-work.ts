import { securityClient, type Principal } from './security';
import type { AppEnv } from './env';
import { repositoryHead } from './artifacts';
import { landingRule } from './branch-protection';
import { LANDING_STEP_MS, PREVIEW_STEP_MS } from './budgets';
import { catalogName } from './capacity';
import { PREVIEW_HEARTBEAT_MS, WORKER_PREVIEW_TTL_MS } from './coordinator';
import { buildLandedWorker, integrateCandidate, IntegrationFailure, prepareCandidatePreview, PreviewFailure } from './execution';
import { deleteWorkerPreview, previewAlias, upsertWorkerPreview, WorkerPreviewError, workerPreviewsConfig } from './worker-previews';
import { WorkerBuildFailure } from './worker-bundle';
import { deployWorkflowId, landedDeployment, policyDeployTargets, runDeployment, type DeploymentRecord, type DeployParams } from './deployments';
import { cloudflareWorkerDeployer } from './cloudflare';
import { POLICY_FILE } from './repository-policy';
import type { ProjectSnapshot } from './cloudflare-projects';

export interface LandingParams { kind: 'land'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; baseSha: string; claimId: string; principal: Principal }
export interface PreviewParams { kind: 'preview'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; claimId: string; principal: Principal }
export interface PreviewRetireParams { kind: 'preview-retire'; repositoryId: string; missionId: string; previewName: string; workspaceId: string }
export interface StepConfig { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number }
export interface StepRunner { do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>; sleep?(name: string, duration: number): Promise<void> }
interface WorkflowBinding<P> {
  create(options: { id: string; params: P }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
type LandingOutcome = { kind: 'stale' } | { kind: 'pushed'; sha: string } | { kind: 'failed'; outcome: 'not_pushed' | 'unknown' };
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
  const outcome = await step.do('push approved candidate', { retries: { limit: 0, delay: '1 second' }, timeout: LANDING_STEP_MS }, async (): Promise<LandingOutcome> => {
    const [claim, mission, repository] = await Promise.all([coordinator.integrationClaim(), coordinator.getMission(missionId), coordinator.getRepository(repositoryId)]);
    if (claim?.claimId !== claimId || !mission || !repository || mission.status !== 'integrating') return { kind: 'stale' };
    // A replayed step must not push again once the claim recorded a push attempt
    if (claim.phase === 'pushing') return { kind: 'failed', outcome: 'unknown' };
    try {
      const result = await integrateCandidate(env, {
        repository, mission, integrationAttemptId: claimId,
        beforePush: () => coordinator.claimIntegrationPush(missionId, epoch, claimId),
        assertAuthority: async () => {
          await access.check(principal, 'land', 'repository', repositoryId, missionId);
          await access.assertLand(principal, missionId, candidateSha, baseSha, epoch, repositoryId, landingRule(await coordinator.getBranchProtection(), repository.defaultBranch));
        },
      });
      return { kind: 'pushed', sha: result.sha };
    } catch (error) {
      return { kind: 'failed', outcome: error instanceof IntegrationFailure ? error.outcome : 'unknown' };
    }
  });
  if (outcome.kind === 'stale') return;
  const landed = await step.do('record landing outcome', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const repository = await coordinator.getRepository(repositoryId);
    if (!repository || !env.ARTIFACTS) throw new Error('Repository services are unavailable');
    const head = outcome.kind === 'pushed' ? outcome.sha : await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch).catch(() => null);
    try {
      if (head === candidateSha) {
        await coordinator.completeIntegration(missionId, epoch, candidateSha, claimId);
        const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
        const listed = await catalog.getRepository(repositoryId);
        if (listed) await catalog.saveRepository({ ...listed, headSha: candidateSha, updatedAt: new Date().toISOString() });
        return true;
      }
      await coordinator.integrationFailed(missionId, epoch, claimId, outcome.kind === 'failed' ? outcome.outcome : 'unknown');
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
  if (await dispatchBackground(env.MISSION_WORKFLOW, previewRetireWorkflowId(record.claimId), { kind: 'preview-retire', repositoryId, missionId, previewName: record.previewName, workspaceId }) === 'missing') console.error('preview.retire.dispatch.failed', missionId);
}

export async function scheduleLandedDeployment(env: AppEnv, repositoryId: string, missionId: string, epoch: number, commitSha: string, baseSha?: string): Promise<void> {
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const { settings } = await coordinator.deployState();
  const draft = landedDeployment(settings, repositoryId, missionId, commitSha, baseSha);
  if (!draft || !settings) return;
  const key = `land-${missionId}-${epoch}`;
  const fingerprint = JSON.stringify(['land', missionId, epoch, commitSha]);
  let record;
  try { record = await coordinator.createDeployment(key, fingerprint, draft); }
  catch (error) {
    if (!(error instanceof Error && /DEPLOYMENT_IN_PROGRESS/.test(error.message))) throw error;
    record = await coordinator.createDeployment(key, fingerprint, { ...draft, status: 'awaiting_confirmation' });
  }
  if (record.status === 'queued' && env.MISSION_WORKFLOW && await dispatchBackground(env.MISSION_WORKFLOW, deployWorkflowId(record.id), { kind: 'deploy', repositoryId, deploymentId: record.id, principal: settings.authorizedBy } satisfies DeployParams) === 'missing') {
    await coordinator.updateDeployment(record.id, ['queued'], { status: 'failed', errorCode: 'DEPLOYMENT_NOT_STARTED', error: 'The deployment could not be scheduled. Deploy it manually.' });
  }
}

export async function retirePreview(env: AppEnv, params: PreviewRetireParams, step: StepRunner): Promise<void> {
  const config = workerPreviewsConfig(env);
  if (!config) return;
  await step.do('delete worker preview', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => deleteWorkerPreview(config, params.previewName));
  await step.do('release preview capacity', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${params.repositoryId}`);
    if (!await coordinator.workerPreview(params.missionId)) await env.GITFLARE_COORDINATOR.getByName(catalogName(params.workspaceId)).releasePreviewSlot(params.missionId);
    return true;
  });
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
    build: (repository, record, target, index, assertAuthority, publish) => buildLandedWorker(env, { repository, commitSha: record.commitSha!, attemptId: record.attemptId, assertAuthority, ...(target.inheritBindings ? {} : { target }), index }, publish),
    policyTargets: async (repository, record) => {
      if (!env.ARTIFACTS) return null;
      const base = await policyBase(env, repository.name, record);
      if (!base) return null;
      using source = await env.ARTIFACTS.get(repository.name);
      const file = await source.readFile({ ref: base, path: POLICY_FILE });
      return policyDeployTargets(file ? await file.text() : null);
    },
    mappedWorkers: async (principal, repositoryId) => {
      const { mapping } = await access.projectStore(principal, repositoryId, 'get') as ProjectSnapshot;
      return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map((resource) => resource.id) } : null;
    },
  });
}

export async function preparePreview(env: AppEnv, params: PreviewParams, step: StepRunner): Promise<void> {
  const { repositoryId, missionId, epoch, candidateSha, claimId, principal } = params;
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  const access = securityClient(env);
  const prepared = await step.do('prepare candidate preview', { retries: { limit: 0, delay: '1 second' }, timeout: PREVIEW_STEP_MS }, async (): Promise<{ worker: boolean }> => {
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
      const previews = workerPreviewsConfig(env);
      const prepared = await prepareCandidatePreview(env, { repository, mission, previewAttemptId: claimId, workerPreviews: !!previews, assertAuthority: () => access.check(principal, 'read', 'repository', repositoryId, missionId) });
      if (prepared.kind === 'worker') {
        if (!previews) throw new PreviewFailure('Worker previews are not configured for this installation.');
        const alias = previewAlias(missionId, previews.workerName);
        await access.check(principal, 'read', 'repository', repositoryId, missionId);
        const result = await upsertWorkerPreview(previews, { alias, bundle: prepared.bundle, annotations: { 'workers/commit_sha': candidateSha, 'workers/message': mission.title.slice(0, 100), 'workers/pull_request_title': mission.title.slice(0, 100) } });
        const expiresAt = await coordinator.workerPreviewReady(missionId, epoch, candidateSha, claimId, { previewName: alias, previewUrl: result.previewUrl, deploymentUrl: result.deploymentUrl, notes: result.notes.slice(0, 50) });
        await catalog.holdPreviewSlot(missionId, expiresAt);
        return { worker: true };
      }
      const expiresAt = await coordinator.previewReady(missionId, epoch, candidateSha, claimId, prepared.sandboxName);
      await env.SANDBOX.getByName(prepared.sandboxName).expireAt(expiresAt);
      await catalog.holdPreviewSlot(missionId, expiresAt);
    } catch (error) {
      const message = error instanceof PreviewFailure || error instanceof WorkerPreviewError || error instanceof WorkerBuildFailure ? error.message : 'The preview could not be started.';
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
  await step.sleep('hold worker preview until expiry', WORKER_PREVIEW_TTL_MS);
  const expired = await step.do('retire expired worker preview', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => coordinator.retireWorkerPreview(missionId, claimId));
  if (expired) await retirePreview(env, { kind: 'preview-retire', repositoryId, missionId, previewName: expired.previewName, workspaceId: principal.workspaceId }, step);
}
