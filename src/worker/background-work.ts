import type { Principal } from './security';
import type { AppEnv } from './env';
import { repositoryHead } from './artifacts';
import { landingRule } from './branch-protection';
import { LANDING_STEP_MS, PREVIEW_STEP_MS } from './budgets';
import { catalogName } from './capacity';
import { PREVIEW_HEARTBEAT_MS } from './coordinator';
import { integrateCandidate, IntegrationFailure, prepareCandidatePreview, PreviewFailure } from './execution';

export interface LandingParams { kind: 'land'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; baseSha: string; claimId: string; principal: Principal }
export interface PreviewParams { kind: 'preview'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; claimId: string; principal: Principal }
export interface StepConfig { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number }
export interface StepRunner { do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T> }
interface WorkflowBinding<P> {
  create(options: { id: string; params: P }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
type LandingOutcome = { kind: 'stale' } | { kind: 'pushed'; sha: string } | { kind: 'failed'; outcome: 'not_pushed' | 'unknown' };
export type BackgroundState = 'running' | 'finished' | 'missing';

const ACTIVE = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];

export const landingWorkflowId = (claimId: string) => `land-${claimId}`;
export const previewWorkflowId = (claimId: string) => `preview-${claimId}`;

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
  const access = env.GITFLARE_SECURITY.getByName('security');
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
  await step.do('record landing outcome', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const repository = await coordinator.getRepository(repositoryId);
    if (!repository || !env.ARTIFACTS) throw new Error('Repository services are unavailable');
    const head = outcome.kind === 'pushed' ? outcome.sha : await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch).catch(() => null);
    try {
      if (head === candidateSha) {
        await coordinator.completeIntegration(missionId, epoch, candidateSha, claimId);
        const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
        const listed = await catalog.getRepository(repositoryId);
        if (listed) await catalog.saveRepository({ ...listed, headSha: candidateSha, updatedAt: new Date().toISOString() });
      } else await coordinator.integrationFailed(missionId, epoch, claimId, outcome.kind === 'failed' ? outcome.outcome : 'unknown');
    } catch (error) { if (!staleExecution(error)) throw error; }
    return true;
  });
}

export async function preparePreview(env: AppEnv, params: PreviewParams, step: StepRunner): Promise<void> {
  const { repositoryId, missionId, epoch, candidateSha, claimId, principal } = params;
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  const access = env.GITFLARE_SECURITY.getByName('security');
  await step.do('prepare candidate preview', { retries: { limit: 0, delay: '1 second' }, timeout: PREVIEW_STEP_MS }, async () => {
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
      const prepared = await prepareCandidatePreview(env, { repository, mission, previewAttemptId: claimId, assertAuthority: () => access.check(principal, 'read', 'repository', repositoryId, missionId) });
      const expiresAt = await coordinator.previewReady(missionId, epoch, candidateSha, claimId, prepared.sandboxName);
      await env.SANDBOX.getByName(prepared.sandboxName).expireAt(expiresAt);
      await catalog.holdPreviewSlot(missionId, expiresAt);
    } catch (error) {
      const released = await coordinator.previewFailed(missionId, claimId, error instanceof PreviewFailure ? error.message : 'The preview could not be started.').catch(() => false);
      await env.SANDBOX?.getByName(`preview-${missionId}-${claimId}`).destroy().catch(() => {});
      if (released) await catalog.releasePreviewSlot(missionId).catch(() => {});
    } finally {
      finished = true;
      clearTimeout(timer);
    }
    return true;
  });
}
