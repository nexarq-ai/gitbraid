import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { GitflareSecurity } from './security';
import type { Mission, ModelConnection, Repository } from '../shared/types';
import { assertPinnedModel } from './model-config';
import { executeMission, type ExecutionEnv, type ExecutionResult } from './execution';
import type { AppEnv } from './env';
import { landCandidate, preparePreview, type LandingParams, type PreviewParams } from './background-work';
import { missionStepTimeoutMs } from './budgets';
import { catalogName } from './capacity';
import { createModelAccess, type AiAccessOptions, type AiCredentials } from './ai-keys';

export interface MissionRunParams { kind?: 'mission'; repositoryId: string; missionId: string; epoch: number }
export type MissionWorkflowParams = MissionRunParams | LandingParams | PreviewParams;
interface Coordinator {
  getModelConnections(): Promise<ModelConnection[]>;
  getAiCredentials(): Promise<AiCredentials>;
  getRepository(repositoryId: string): Promise<Repository | undefined>;
  getMission(missionId: string): Promise<Mission | undefined>;
  isMissionActive(missionId: string, epoch: number): Promise<boolean>;
  recordExecution(missionId: string, epoch: number, result: ExecutionResult, complete?: boolean): Promise<unknown>;
  releaseMissionSlot(missionId: string, epoch: number): Promise<void>;
}
interface WorkflowEnv extends ExecutionEnv, AiAccessOptions {
  GITFLARE_SECURITY: DurableObjectNamespace<GitflareSecurity>;
  GITFLARE_COORDINATOR: { getByName(name: string): Coordinator };
}

export class MissionWorkflow extends WorkflowEntrypoint<WorkflowEnv, MissionWorkflowParams> {
  async run(event: WorkflowEvent<MissionWorkflowParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    if (params.kind === 'land') return landCandidate(this.env as unknown as AppEnv, params, step);
    if (params.kind === 'preview') return preparePreview(this.env as unknown as AppEnv, params, step);
    const { repositoryId, missionId, epoch } = params;
    const coordinator = this.env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
    const planned = await coordinator.getMission(missionId);
    const timeout = missionStepTimeoutMs(planned ?? { runs: [] });
    try {
      await step.do('execute isolated agents and verify integration', { retries: { limit: 0, delay: '1 second' }, timeout }, async () => {
        const [repository, mission] = await Promise.all([coordinator.getRepository(repositoryId), coordinator.getMission(missionId)]);
        if (!repository || !mission) throw new Error('Mission repository was not found');
        if (!await coordinator.isMissionActive(missionId, epoch)) return;
        const authorization = mission.authorization;
        if (!authorization || (repository.workspaceId ?? 'legacy') !== authorization.workspaceId || authorization.principal.workspaceId !== authorization.workspaceId) throw new Error('Execution authorization is missing or belongs to another workspace');
        const assertAuthority = () => this.env.GITFLARE_SECURITY.getByName('security').check(authorization.principal, 'execute', 'repository', repositoryId, missionId);
        await assertAuthority();
        const catalog = this.env.GITFLARE_COORDINATOR.getByName(authorization.workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${authorization.workspaceId}`);
        const modelConnections = await catalog.getModelConnections();
        const result = await executeMission(
          { repository, mission, modelConnections, testCommand: this.env.TEST_COMMAND ?? 'node --test --test-reporter=tap tests/*.test.mjs' },
          { ...this.env, assertModelAllowed: async model => assertPinnedModel(await catalog.getModelConnections(), model), modelAccess: createModelAccess(this.env, authorization.workspaceId, catalog) },
          async (progress) => { await coordinator.recordExecution(missionId, epoch, progress, false); },
          () => coordinator.isMissionActive(missionId, epoch),
          assertAuthority,
        );
        await coordinator.recordExecution(missionId, epoch, result, true);
      });
    } catch (error) {
      const mission = await coordinator.getMission(missionId);
      if (mission && await coordinator.isMissionActive(missionId, epoch)) await coordinator.recordExecution(missionId, epoch, {
        runs: mission.runs.map((run) => run.status === 'running' || run.status === 'queued' ? { ...run, status: 'failed', error: 'Execution interrupted' } : run),
        checks: mission.checks,
        changes: mission.changes,
        candidateSha: null,
        error: error instanceof Error ? error.message : 'Workflow failed',
      }, true);
      throw error;
    } finally {
      await this.env.GITFLARE_COORDINATOR.getByName(catalogName(planned?.authorization?.workspaceId ?? 'legacy')).releaseMissionSlot(missionId, epoch).catch(() => {});
    }
  }
}
