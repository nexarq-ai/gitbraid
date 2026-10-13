import { DurableObject } from 'cloudflare:workers';
import type { CreateMissionInput, Mission, MissionAttempt, MissionEvent, ModelConnection, Repository, RepositorySkillChange, ReviewMissionInput } from '../shared/types';
import { ApiError, assertActiveRun, assertApproval, assertReplayFingerprint } from './domain';
import type { AppEnv } from './env';
import type { ExecutionResult } from './execution';
import { SqlStore } from './store';
import { assertReviewClear, reviewMissionInput } from './proposal-review';
import { skillMissionInput, validateRepositorySkillChange } from './skill-edit';
import type { ImportReceipt, ImportResult } from './repository-import';
import { defaultModelConnections, pinMissionModels, validateModelConnection } from './model-config';

interface Receipt<T> { fingerprint: string; result: T }
interface IntegrationClaim { claimId?: string; missionId: string; epoch: number; candidateSha: string; baseSha: string }
export interface PreviewCapability { workspaceId?: string; principal?: import('./security').Principal; repositoryId: string; missionId: string; epoch: number; candidateSha: string; sandboxName: string; expiresAt: number }
interface PreviewState { claimId: string; epoch: number; candidateSha: string; phase: 'preparing' | 'ready'; expiresAt: number; sandboxName?: string }
export const PREVIEW_LEASE_MS = 120_000;
export const PREVIEW_HEARTBEAT_MS = 30_000;
interface DispatchIntent { workflowId: string; missionId: string; repositoryId: string; epoch: number; attempts: number; nextAttemptAt: number }
export const DISPATCH_FAST_ATTEMPTS = 8;

export async function startWithDurableDispatch(coordinator: { startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission> }, key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission> {
  try {
    return await coordinator.startMissionWithDispatch(key, id, authorization, models);
  } catch (error) {
    if (error instanceof Error && /startMissionWithDispatch/.test(error.message) && /not a function|does not exist|not implemented|does not implement|missing|unknown method/i.test(error.message)) throw new ApiError(503, 'EXECUTION_DEPLOYMENT_PENDING', 'Execution services are updating. Wait briefly and retry; this request has not started a mission.');
    throw error;
  }
}

export class GitflareCoordinator extends DurableObject<AppEnv> {
  private readonly store: SqlStore;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
  }

  async setAuthorization(id: string, authorization: NonNullable<Mission['authorization']>): Promise<void> {
    this.ctx.storage.transactionSync(() => { const mission = this.getMission(id); if (!mission) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This Stream could not be found.'); if (mission.authorization) return; if (['queued', 'running', 'checking', 'integrating', 'integrated'].includes(mission.status)) throw new ApiError(409, 'AUTHORITY_LOCKED', 'An active Stream cannot change its execution authority.'); mission.authorization = authorization; this.saveMission(mission); });
  }

  private mutate<T>(key: string, fingerprint: string, operation: () => T): T {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.store.get<Receipt<T>>(`request:${key}`);
      if (receipt) {
        assertReplayFingerprint(receipt.fingerprint, fingerprint);
        return receipt.result;
      }
      const result = operation();
      this.store.put(`request:${key}`, { fingerprint, result });
      return result;
    });
  }

  private mutateMission(key: string, fingerprint: string, id: string, operation: () => Mission): Mission {
    const result = this.mutate(key, fingerprint, operation);
    const current = this.requiredMission(id);
    if (result.epoch !== current.epoch) throw new ApiError(409, 'STALE_REQUEST', 'This request belongs to an earlier attempt. Refresh before taking a new action.');
    return current;
  }

  listRepositories(): Repository[] {
    return this.store.list<Repository>('repository:');
  }

  getRepository(id: string): Repository | undefined {
    return this.store.get<Repository>(`repository:${id}`);
  }

  saveRepository(repository: Repository): void {
    this.store.put(`repository:${repository.id}`, repository);
  }

  getModelConnections(): ModelConnection[] { return this.store.get<ModelConnection[]>('model-connections') ?? defaultModelConnections(); }

  getModelRequest(key: string, fingerprint: string): { result?: ModelConnection[] } | undefined {
    const receipt = this.store.get<Receipt<ModelConnection[] | undefined>>(`model-request:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt ? { result: receipt.result } : undefined;
  }

  claimModelVerification(key: string, fingerprint: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.getModelRequest(key, fingerprint)) return false;
      this.store.put(`model-request:${key}`, { fingerprint });
      return true;
    });
  }

  changeModelConnections(key: string, fingerprint: string, action: 'add' | 'remove', value: ModelConnection | string): ModelConnection[] {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getModelRequest(key, fingerprint);
      if (receipt?.result) return receipt.result;
      if (receipt) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'This model request is pending verification.');
      const models = this.getModelConnections();
      let updated: ModelConnection[];
      if (action === 'add') {
        const model = validateModelConnection(value);
        if (models.some(existing => existing.id === model.id)) throw new ApiError(409, 'MODEL_ALREADY_CONFIGURED', 'This model is already enabled. Remove it before changing its transport.');
        if (models.length >= 20) throw new ApiError(400, 'MODEL_LIMIT', 'Enable at most 20 models in a workspace.');
        updated = [...models, model];
      } else {
        if (!models.some(model => model.id === value)) throw new ApiError(404, 'MODEL_NOT_FOUND', 'This model is not enabled.');
        updated = models.filter(model => model.id !== value);
      }
      this.store.put('model-connections', updated);
      this.store.put(`model-request:${key}`, { fingerprint, result: updated });
      return updated;
    });
  }

  completeModelVerification(key: string, fingerprint: string, verified: ModelConnection): ModelConnection[] {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getModelRequest(key, fingerprint);
      if (!receipt) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'Model verification has no active request.');
      if (receipt.result) return receipt.result;
      const models = this.getModelConnections();
      const current = models.find(model => model.id === verified.id);
      if (!current || current.source !== verified.source || current.protocol !== verified.protocol) throw new ApiError(409, 'MODEL_CONNECTION_CHANGED', 'The model connection changed while verification was running.');
      const updated = models.map(model => model.id === verified.id ? { ...model, verification: verified.verification } : model);
      this.store.put('model-connections', updated);
      this.store.put(`model-request:${key}`, { fingerprint, result: updated });
      return updated;
    });
  }

  repositoryBootstrapSha(): string | undefined { return this.store.get<string>('repository-bootstrap'); }

  saveRepositoryBootstrapSha(sha: string): void { this.store.put('repository-bootstrap', sha); }

  getImportRequest(key: string, fingerprint: string): ImportReceipt | undefined {
    const receipt = this.store.get<ImportReceipt>(`repository-import:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt;
  }

  claimRepositoryImport(key: string, fingerprint: string): { claimed: boolean; receipt: ImportReceipt } {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (receipt) return { claimed: false, receipt };
      if (this.store.get<string>('repository-import-active')) throw new ApiError(409, 'IMPORT_PENDING', 'A repository import is pending reconciliation. Retry its original request before importing again.');
      const next = { fingerprint, timestamp: Math.floor(Date.now() / 1000) } satisfies ImportReceipt;
      this.store.put(`repository-import:${key}`, next);
      this.store.put('repository-import-active', key);
      return { claimed: true, receipt: next };
    });
  }

  prepareRepositoryImport(key: string, fingerprint: string, candidateSha: string, files: string[], skipped: string[]): void {
    this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (!receipt || this.store.get<string>('repository-import-active') !== key || receipt.candidateSha) throw new ApiError(409, 'IMPORT_PENDING', 'This import has already been prepared or is no longer active.');
      this.store.put(`repository-import:${key}`, { ...receipt, candidateSha, files, skipped } satisfies ImportReceipt);
    });
  }

  rejectRepositoryImport(key: string, fingerprint: string, rejection: NonNullable<ImportReceipt['rejection']>): void {
    this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (!receipt || receipt.result || this.store.get<string>('repository-import-active') !== key) throw new ApiError(409, 'IMPORT_PENDING', 'The import is not active.');
      this.store.put(`repository-import:${key}`, { ...receipt, rejection } satisfies ImportReceipt);
      this.store.delete('repository-import-active');
    });
  }

  completeRepositoryImport(key: string, fingerprint: string, repository: Repository): ImportResult {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (!receipt?.candidateSha || repository.headSha !== receipt.candidateSha) throw new ApiError(409, 'IMPORT_UNCONFIRMED', 'The canonical import commit has not been confirmed.');
      if (receipt.result) return receipt.result;
      if (this.store.get<string>('repository-import-active') !== key) throw new ApiError(409, 'IMPORT_PENDING', 'This import is no longer active.');
      const result = { repository, headSha: receipt.candidateSha, files: receipt.files ?? [], skipped: receipt.skipped ?? [] } satisfies ImportResult;
      this.saveRepository(repository);
      this.store.put(`repository-import:${key}`, { ...receipt, result } satisfies ImportReceipt);
      this.store.delete('repository-import-active');
      return result;
    });
  }

  claimProvision(id: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.store.get<boolean>(`provision:${id}`)) return false;
      this.store.put(`provision:${id}`, true);
      return true;
    });
  }

  savePreviewCapability(hash: string, capability: PreviewCapability): void {
    this.store.put(`preview:${hash}`, capability);
  }

  getPreviewCapability(hash: string): PreviewCapability | undefined {
    const capability = this.store.get<PreviewCapability>(`preview:${hash}`);
    if (capability && capability.expiresAt <= Date.now()) {
      this.store.delete(`preview:${hash}`);
      return undefined;
    }
    return capability;
  }

  claimPreview(key: string, id: string, epoch: number, candidateSha: string): { sandboxName?: string; claimId: string; claimed: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      if (mission.epoch !== epoch || mission.candidateSha !== candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(mission.status)) throw new ApiError(409, 'STALE_PREVIEW', 'Only the current verified candidate can be previewed.');
      const fingerprint = JSON.stringify(['preview', id, epoch, candidateSha]);
      const receipt = this.store.get<Receipt<boolean>>(`request:${key}`);
      if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
      const current = this.store.get<PreviewState>(`preview-state:${id}`);
      if (current?.claimId && current.epoch === epoch && current.candidateSha === candidateSha && current.expiresAt > Date.now()) return { sandboxName: current.sandboxName, claimId: current.claimId, claimed: false };
      const claimId = crypto.randomUUID();
      this.store.put(`preview-state:${id}`, { claimId, epoch, candidateSha, phase: 'preparing', expiresAt: Date.now() + PREVIEW_LEASE_MS } satisfies PreviewState);
      this.store.put(`request:${key}`, { fingerprint, result: true });
      return { claimId, claimed: true };
    });
  }

  private previewClaim(id: string, epoch: number, candidateSha: string, claimId: string): PreviewState {
    const mission = this.requiredMission(id);
    const state = this.store.get<PreviewState>(`preview-state:${id}`);
    if (mission.epoch !== epoch || mission.candidateSha !== candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(mission.status) || !state || state.claimId !== claimId || state.epoch !== epoch || state.candidateSha !== candidateSha || state.expiresAt <= Date.now()) throw new ApiError(409, 'STALE_PREVIEW', 'This preview attempt is no longer current.');
    return state;
  }

  renewPreview(id: string, epoch: number, candidateSha: string, claimId: string): void {
    const state = this.previewClaim(id, epoch, candidateSha, claimId);
    if (state.phase !== 'preparing') return;
    this.store.put(`preview-state:${id}`, { ...state, expiresAt: Date.now() + PREVIEW_LEASE_MS });
  }

  previewReady(id: string, epoch: number, candidateSha: string, claimId: string, sandboxName: string): void {
    const state = this.previewClaim(id, epoch, candidateSha, claimId);
    if (sandboxName !== `preview-${id}-${claimId}`) throw new ApiError(409, 'STALE_PREVIEW', 'The preview sandbox does not belong to this attempt.');
    this.store.put(`preview-state:${id}`, { ...state, phase: 'ready', sandboxName, expiresAt: Date.now() + 600_000 } satisfies PreviewState);
  }

  previewFailed(id: string, claimId: string): boolean {
    const state = this.store.get<PreviewState>(`preview-state:${id}`);
    if (state?.claimId !== claimId) return false;
    this.store.delete(`preview-state:${id}`);
    return true;
  }

  createRepository(key: string, repository: Repository): Repository {
    return this.mutate(key, JSON.stringify(['repository', repository.name, repository.description]), () => {
      if (this.listRepositories().some((item) => item.name.toLowerCase() === repository.name.toLowerCase())) {
        throw new ApiError(409, 'REPOSITORY_EXISTS', 'A repository with this name already exists.');
      }
      this.saveRepository(repository);
      return repository;
    });
  }

  connectRepository(key: string, repository: Repository): Repository {
    return this.mutate(key, JSON.stringify(['connect', repository.name, repository.description, repository.remote]), () => {
      const existing = this.listRepositories().find((item) => item.name.toLowerCase() === repository.name.toLowerCase());
      if (existing?.remote && existing.remote !== repository.remote) throw new ApiError(409, 'REMOTE_MISMATCH', 'This repository is connected to a different remote.');
      const connected = existing ? { ...repository, id: existing.id, createdAt: existing.createdAt } : repository;
      this.saveRepository(connected);
      return connected;
    });
  }

  listMissions(): Mission[] {
    return this.store.list<Mission>('mission:').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMission(id: string): Mission | undefined {
    return this.store.get<Mission>(`mission:${id}`);
  }

  listAttempts(id: string): MissionAttempt[] {
    this.requiredMission(id);
    return this.store.list<MissionAttempt>(`attempt:${id}:`).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  private archive(mission: Mission, reason: MissionAttempt['reason']): void {
    const id = crypto.randomUUID();
    this.store.insert(`attempt:${mission.id}:${id}`, { id, epoch: mission.epoch, recordedAt: new Date().toISOString(), reason, snapshot: mission } satisfies MissionAttempt);
  }

  private requiredMission(id: string): Mission {
    const mission = this.getMission(id);
    if (!mission) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This mission could not be found.');
    return mission;
  }

  private saveMission(mission: Mission, message?: string, type: MissionEvent['type'] = 'info'): Mission {
    mission.updatedAt = new Date().toISOString();
    if (message) mission.events.push({ id: crypto.randomUUID(), timestamp: mission.updatedAt, type, message });
    mission.events = mission.events.slice(-200);
    this.store.put(`mission:${mission.id}`, mission);
    return mission;
  }

  createMission(key: string, input: CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Mission {
    return this.mutate(key, JSON.stringify(['mission', input]), () => this.newMission(input, authorization, models));
  }

  private newMission(input: CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Mission {
      const repository = this.getRepository(input.repositoryId);
      if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
      if (input.expectedBaseSha !== undefined && input.expectedBaseSha !== repository.headSha) throw new ApiError(409, 'STALE_PROPOSAL_BASE', 'The repository changed while you drafted this proposal. Refresh the base and review your assignments before saving.');
      const now = new Date().toISOString();
      const criteria = input.acceptanceCriteria ?? [];
      const skillChange = input.skillChange ? validateRepositorySkillChange(input.skillChange) : undefined;
      if (skillChange && repository.headSha !== skillChange.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill before proposing this edit.');
      const tasks = skillChange ? [{ name: 'Skill editor', role: 'Trusted skill editor', task: `Apply exactly the submitted Markdown to ${skillChange.path}.` }] : input.tasks ?? [
        { name: 'Implementation agent', role: 'Implementation', task: 'Implement the core change. If this mission assigns explicit agent roles, implement only your assigned role.' },
        { name: 'Compatibility agent', role: 'Compatibility', task: 'Improve compatibility and error handling. If this mission assigns explicit agent roles, implement only your assigned role.' },
      ];
      const mission: Mission = {
        id: crypto.randomUUID(), repositoryId: repository.id, title: input.title, prompt: input.prompt,
        acceptanceCriteria: criteria, authorization, ...(skillChange ? { skillChange } : {}),
        status: 'draft', baseSha: repository.headSha, candidateSha: null, epoch: 0,
        runs: tasks.map((task) => ({ ...task, assignment: task.task, id: crypto.randomUUID(), task: `${input.prompt}\nYou are ${task.name} (${task.role}). Your assigned task: ${task.task}\nPreserve existing tests and run them.${criteria.length ? `\nAcceptance criteria:\n${criteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''}`, status: 'queued', changedFiles: [] })),
        checks: [], changes: [], events: [], createdAt: now, updatedAt: now,
      };
      return this.saveMission(pinMissionModels(mission, models), 'Mission created. Agent execution has not started.');
  }

  getSkillEditRequest(key: string, repositoryId: string, supplied: RepositorySkillChange): Mission | undefined {
    const change = validateRepositorySkillChange(supplied);
    const receipt = this.store.get<Receipt<Mission>>(`request:${key}`);
    if (!receipt) return undefined;
    assertReplayFingerprint(receipt.fingerprint, JSON.stringify(['skill-edit', repositoryId, change]));
    return this.requiredMission(receipt.result.id);
  }

  async createSkillMissionWithDispatch(key: string, repositoryId: string, supplied: RepositorySkillChange, authorization: NonNullable<Mission['authorization']>): Promise<Mission> {
    const change = validateRepositorySkillChange(supplied);
    await this.ensureDispatchAlarm(Date.now() + 1000);
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.getSkillEditRequest(key, repositoryId, change);
      if (existing) return existing;
      if (!this.env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.');
      const access = this.env.GITFLARE_SECURITY.getByName('security');
      await access.authorize(authorization.principal, 'contribute', 'repository', repositoryId);
      await access.authorize(authorization.principal, 'execute', 'repository', repositoryId);
      return this.mutate(key, JSON.stringify(['skill-edit', repositoryId, change]), () => {
        const mission = this.newMission(skillMissionInput(repositoryId, change), authorization);
        mission.status = 'queued';
        mission.epoch = 1;
        this.queueDispatch(mission);
        return this.saveMission(mission, 'Skill edit queued for exact-content execution and repository checks.');
      });
    });
  }

  private async ensureDispatchAlarm(when: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > when) await this.ctx.storage.setAlarm(when);
  }

  private queueDispatch(mission: Mission): void {
    const workflowId = `${mission.id}-${mission.epoch}`;
    if (!this.store.get(`dispatch:${workflowId}`) && !this.store.get(`delivered:${workflowId}`)) this.store.put(`dispatch:${workflowId}`, { workflowId, missionId: mission.id, repositoryId: mission.repositoryId, epoch: mission.epoch, attempts: 0, nextAttemptAt: Date.now() } satisfies DispatchIntent);
  }

  listDispatches(): DispatchIntent[] {
    return this.store.list<DispatchIntent>('dispatch:');
  }

  async startMission(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Promise<Mission> {
    await this.ensureDispatchAlarm(Date.now() + 1000);
    const started = this.mutateMission(key, JSON.stringify(['start', id]), id, () => {
      const mission = pinMissionModels(this.requiredMission(id), models);
      if (!['draft', 'failed', 'cancelled', 'needs_review'].includes(mission.status)) throw new ApiError(409, 'MISSION_ACTIVE', 'Cancel the active attempt or revoke its approval before starting again.');
      const repository = this.getRepository(mission.repositoryId);
      if (mission.skillChange && repository?.headSha !== mission.skillChange.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill and submit a new edit proposal.');
      if (mission.epoch > 0) this.archive(mission, 'retry');
      if (authorization) mission.authorization = { ...authorization, creatorId: mission.authorization?.creatorId ?? authorization.creatorId };
      mission.status = 'queued';
      mission.epoch += 1;
      mission.baseSha = repository?.headSha ?? null;
      mission.candidateSha = null;
      mission.checks = [];
      mission.changes = [];
      delete mission.error;
      delete mission.approvedAt;
      delete mission.approvedBy;
      delete mission.integrationForkName;
      mission.runs = mission.runs.map((run) => ({ id: run.id, name: run.name, role: run.role, task: run.task, assignment: run.assignment, model: run.model, modelConfig: run.modelConfig, status: 'queued', changedFiles: [] }));
      this.queueDispatch(mission);
      return this.saveMission(mission, `Execution attempt ${mission.epoch} queued.`);
    });
    if (started.status === 'cancelled') throw new ApiError(409, 'STALE_REQUEST', 'This start request was cancelled. Use a new request to retry the mission.');
    if (started.status === 'queued') this.queueDispatch(started);
    return started;
  }

  async startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Promise<Mission> {
    return this.startMission(key, id, authorization, models);
  }

  private failDispatch(id: string, epoch: number): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      assertActiveRun(mission.status, mission.epoch, epoch);
      mission.status = 'failed';
      mission.error = 'The Workflow ended before mission completion was recorded. Start a new attempt to retry; late results from this attempt will be rejected.';
      mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'failed', completedAt: new Date().toISOString(), error: 'Workflow dispatch was not confirmed' } : run);
      this.store.delete(`dispatch:${id}-${epoch}`);
      this.saveMission(mission, mission.error, 'error');
      this.archive(mission, 'completed');
      return mission;
    });
  }

  async alarm(): Promise<void> {
    const existing = this.listDispatches();
    if (!existing.length) return;
    const due = existing.filter((intent) => intent.nextAttemptAt <= Date.now()).slice(0, 10);
    if (!due.length) {
      await this.ensureDispatchAlarm(Math.min(...existing.map((intent) => intent.nextAttemptAt)));
      return;
    }
    await this.ensureDispatchAlarm(Date.now() + 60_000);
    for (const intent of due) {
      const key = `dispatch:${intent.workflowId}`;
      if (!this.isMissionActive(intent.missionId, intent.epoch)) {
        this.store.delete(key);
        continue;
      }
      let confirmed = false;
      let terminal = false;
      try {
        if (!this.env.MISSION_WORKFLOW) throw new Error('Workflow binding unavailable');
        await this.env.MISSION_WORKFLOW.create({ id: intent.workflowId, params: { repositoryId: intent.repositoryId, missionId: intent.missionId, epoch: intent.epoch } });
        confirmed = true;
      } catch {
        try {
          const status = await (await this.env.MISSION_WORKFLOW!.get(intent.workflowId)).status();
          confirmed = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(status.status);
          terminal = ['complete', 'errored', 'terminated'].includes(status.status);
        } catch {}
      }
      if (!this.store.get(key)) continue;
      if (!this.isMissionActive(intent.missionId, intent.epoch)) {
        this.store.delete(key);
        continue;
      }
      if (confirmed) {
        this.ctx.storage.transactionSync(() => {
          this.store.delete(key);
          this.store.put(`delivered:${intent.workflowId}`, { confirmedAt: new Date().toISOString() });
          const mission = this.requiredMission(intent.missionId);
          delete mission.error;
          this.saveMission(mission, `Workflow dispatch confirmed for attempt ${intent.epoch}.`);
        });
        continue;
      }
      const attempts = intent.attempts + 1;
      if (terminal) {
        this.failDispatch(intent.missionId, intent.epoch);
        continue;
      }
      this.ctx.storage.transactionSync(() => {
        this.store.put(key, { ...intent, attempts, nextAttemptAt: Date.now() + (attempts >= DISPATCH_FAST_ATTEMPTS ? 300_000 : Math.min(60_000, 1000 * 2 ** attempts)) });
        const mission = this.requiredMission(intent.missionId);
        mission.error = `Workflow dispatch is awaiting confirmation after ${attempts} attempts. Automatic retries use the same Workflow ID. Cancel this attempt to reject any late execution.`;
        this.saveMission(mission, mission.error, 'warning');
      });
    }
    const pending = this.listDispatches();
    if (pending.length) await this.ensureDispatchAlarm(Math.max(Date.now() + 1000, Math.min(...pending.map((intent) => intent.nextAttemptAt))));
  }

  cancelMission(key: string, id: string): Mission {
    return this.mutateMission(key, JSON.stringify(['cancel', id]), id, () => {
      const mission = this.requiredMission(id);
      if (['integrated', 'approved', 'integrating'].includes(mission.status)) throw new ApiError(409, 'MISSION_FINAL', 'An approved or integrating mission cannot be cancelled.');
      mission.status = 'cancelled';
      this.store.delete(`dispatch:${mission.id}-${mission.epoch}`);
      mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'cancelled', completedAt: new Date().toISOString() } : run);
      this.saveMission(mission, 'Mission cancelled. Late execution results will be rejected.', 'warning');
      this.archive(mission, 'cancelled');
      return mission;
    });
  }

  isMissionActive(id: string, epoch: number): boolean {
    const mission = this.getMission(id);
    return !!mission && mission.epoch === epoch && ['queued', 'running', 'checking'].includes(mission.status);
  }

  recordExecution(id: string, epoch: number, result: Partial<ExecutionResult>, complete = false): Mission {
    const mission = this.requiredMission(id);
    assertActiveRun(mission.status, mission.epoch, epoch);
    if (this.store.get(`dispatch:${id}-${epoch}`)) delete mission.error;
    this.store.delete(`dispatch:${id}-${epoch}`);
    this.store.put(`delivered:${id}-${epoch}`, { confirmedAt: new Date().toISOString() });
    if (result.runs) {
      const previousRuns = new Map(mission.runs.map((run) => [run.id, run]));
      for (const run of result.runs) {
        const previous = previousRuns.get(run.id);
        if (!previous || previous.status === run.status && previous.summary === run.summary) continue;
        const summary = run.summary?.trim().slice(0, 1000);
        mission.events.push({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId: run.id, type: run.status === 'failed' ? 'error' : run.status === 'completed' ? 'success' : run.status === 'cancelled' ? 'warning' : 'info', message: `Attempt ${epoch} · ${run.name.slice(0, 120)}: ${run.status}${summary ? ` — ${summary}` : ''}` });
      }
      mission.runs = result.runs;
    }
    if (result.checks) mission.checks = result.checks;
    if (result.changes) mission.changes = result.changes;
    if (result.candidateSha !== undefined) mission.candidateSha = result.candidateSha;
    if (result.integrationForkName !== undefined) mission.integrationForkName = result.integrationForkName;
    mission.status = 'running';
    if (complete) {
      const passed = !!mission.candidateSha && mission.checks.some((check) => check.candidateSha === mission.candidateSha) && mission.checks.every((check) => check.status === 'passed') && mission.runs.every((run) => run.status === 'completed');
      mission.status = passed && !result.error ? 'needs_review' : 'failed';
      mission.error = result.error;
      return this.ctx.storage.transactionSync(() => {
        this.saveMission(mission, passed && !result.error ? 'Candidate checks passed. Review the exact commit before approval.' : 'Execution finished without a passing integration candidate.', passed && !result.error ? 'success' : 'error');
        this.archive(mission, 'completed');
        return mission;
      });
    }
    return this.saveMission(mission);
  }

  reviewMission(key: string, id: string, supplied: ReviewMissionInput, actorId: string): Mission {
    const input = reviewMissionInput({ ...supplied });
    return this.mutateMission(key, JSON.stringify(['review', id, actorId, input]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.epoch !== input.epoch || mission.candidateSha !== input.candidateSha || mission.baseSha !== input.baseSha) throw new ApiError(409, 'STALE_REVIEW', 'This review belongs to another revision. Refresh the proposal.');
      if (!['needs_review', 'approved'].includes(mission.status)) throw new ApiError(409, 'REVIEW_LOCKED', 'Only a candidate awaiting review or approval can receive a review.');
      mission.reviews ??= [];
      if (input.action === 'resolve') {
        const review = mission.reviews.find((entry) => entry.id === input.reviewId);
        if (!review || review.kind !== 'request_changes' || review.epoch !== input.epoch || review.candidateSha !== input.candidateSha || review.baseSha !== input.baseSha) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'This current revision review could not be found.');
        if (review.authorId !== actorId) throw new ApiError(403, 'REVIEW_AUTHOR_REQUIRED', 'Only the reviewer who requested changes can resolve their request.');
        if (review.resolvedAt) throw new ApiError(409, 'REVIEW_RESOLVED', 'This review request is already resolved.');
        review.resolvedAt = new Date().toISOString();
        review.resolvedBy = actorId;
      } else {
        if (mission.reviews.length >= 500) throw new ApiError(409, 'REVIEW_LIMIT', 'This proposal has reached its discussion limit.');
        mission.reviews.push({ id: crypto.randomUUID(), kind: input.action, body: input.body!, authorId: actorId, createdAt: new Date().toISOString(), epoch: input.epoch, candidateSha: input.candidateSha, baseSha: input.baseSha });
        if (input.action === 'request_changes' && mission.status === 'approved') {
          this.archive(mission, 'approved');
          mission.status = 'needs_review';
          delete mission.approvedAt;
          delete mission.approvedBy;
          this.archive(mission, 'approval_revoked');
        }
      }
      return this.saveMission(mission, input.action === 'resolve' ? `Reviewer ${actorId} resolved their change request.` : input.action === 'request_changes' ? `Reviewer ${actorId} requested changes to this revision.` : `${actorId} added a review comment.`, input.action === 'request_changes' ? 'warning' : 'info');
    });
  }

  approveMission(key: string, id: string, candidateSha: string, baseSha: string, actorId = 'workspace-owner'): Mission {
    return this.mutateMission(key, JSON.stringify(['approve', id, candidateSha, baseSha]), id, () => {
      const mission = this.requiredMission(id);
      const repository = this.getRepository(mission.repositoryId);
      assertReviewClear(mission);
      assertApproval({ status: mission.status, candidateSha: mission.candidateSha, baseSha: mission.baseSha, currentHead: repository?.headSha, requestedCandidate: candidateSha, requestedBase: baseSha, checksPassed: mission.checks.some((check) => check.candidateSha === mission.candidateSha) && mission.checks.every((check) => check.status === 'passed') });
      mission.status = 'approved';
      mission.approvedAt = new Date().toISOString();
      mission.approvedBy = actorId;
      this.saveMission(mission, `Reviewer ${actorId} approved commit ${candidateSha.slice(0, 12)}. Approval does not merge or deploy this change.`, 'success');
      this.archive(mission, 'approved');
      return mission;
    });
  }

  revokeApproval(key: string, id: string, candidateSha: string, baseSha: string): Mission {
    return this.mutateMission(key, JSON.stringify(['revoke', id, candidateSha, baseSha]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.status !== 'approved') throw new ApiError(409, 'NOT_APPROVED', 'Only an approved mission can have its approval revoked. Resolve any integration first.');
      if (mission.candidateSha !== candidateSha || mission.baseSha !== baseSha) throw new ApiError(409, 'STALE_APPROVAL', 'Refresh before revoking approval for this exact candidate and base.');
      this.archive(mission, 'approved');
      mission.status = 'needs_review';
      delete mission.approvedAt;
      delete mission.approvedBy;
      this.saveMission(mission, 'Approval was revoked. Review this candidate again or rerun the mission against the current branch.', 'warning');
      this.archive(mission, 'approval_revoked');
      return mission;
    });
  }

  beginIntegration(key: string, id: string, candidateSha: string, baseSha: string): { mission: Mission; claimed: boolean; claimId?: string } {
    return this.ctx.storage.transactionSync(() => {
      const fingerprint = JSON.stringify(['integrate', id, candidateSha, baseSha]);
      const receipt = this.store.get<Receipt<boolean>>(`request:${key}`);
      if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
      const mission = this.requiredMission(id);
      if (mission.candidateSha !== candidateSha || mission.baseSha !== baseSha || !mission.approvedAt) throw new ApiError(409, 'STALE_APPROVAL', 'Approve this exact candidate and base before integration.');
      if (mission.status === 'integrated') return { mission, claimed: false };
      assertReviewClear(mission);
      if (!['approved', 'integrating'].includes(mission.status)) throw new ApiError(409, 'APPROVAL_REQUIRED', 'Approve this candidate before integration.');
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (claim) {
        if (claim.missionId !== id || claim.epoch !== mission.epoch || claim.candidateSha !== candidateSha) throw new ApiError(409, 'INTEGRATION_BUSY', 'Another integration is in progress for this repository.');
        if (!claim.claimId) {
          claim.claimId = crypto.randomUUID();
          this.store.put('integration:claim', claim);
        }
        return { mission, claimed: false, claimId: claim.claimId };
      }
      if (this.getRepository(mission.repositoryId)?.headSha !== baseSha) throw new ApiError(409, 'STALE_APPROVAL', 'The repository changed after approval. Run and review the change again.');
      if (!mission.integrationForkName || !mission.checks.some((check) => check.candidateSha === candidateSha && check.status === 'passed') || mission.checks.some((check) => check.status !== 'passed')) throw new ApiError(409, 'CHECKS_REQUIRED', 'The exact candidate must have passing verification and an integration fork.');
      const claimId = crypto.randomUUID();
      this.store.put('integration:claim', { claimId, missionId: id, epoch: mission.epoch, candidateSha, baseSha });
      this.store.put(`request:${key}`, { fingerprint, result: true });
      mission.status = 'integrating';
      delete mission.error;
      return { mission: this.saveMission(mission, `Integrating approved commit ${candidateSha.slice(0, 12)} into the default branch.`), claimed: true, claimId };
    });
  }

  completeIntegration(id: string, epoch: number, sha: string, claimId: string): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (mission.status === 'integrated' && mission.epoch === epoch && mission.candidateSha === sha) return mission;
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || claim.candidateSha !== sha || mission.status !== 'integrating') throw new ApiError(409, 'STALE_EXECUTION', 'This integration report does not match the active claim.');
      const repository = this.getRepository(mission.repositoryId);
      if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
      this.saveRepository({ ...repository, headSha: sha, updatedAt: new Date().toISOString() });
      this.store.delete('integration:claim');
      mission.status = 'integrated';
      delete mission.error;
      this.saveMission(mission, `Verified canonical branch at approved commit ${sha.slice(0, 12)}. No production deployment was triggered.`, 'success');
      this.archive(mission, 'integrated');
      return mission;
    });
  }

  integrationFailed(id: string, epoch: number, claimId: string, outcome: 'not_pushed' | 'unknown'): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || mission.status !== 'integrating') throw new ApiError(409, 'STALE_EXECUTION', 'This integration no longer owns the repository claim.');
      if (outcome === 'not_pushed') {
        this.store.delete('integration:claim');
        mission.status = 'approved';
        mission.error = 'Integration stopped before attempting a canonical push. Retry integration, or revoke approval to rerun this mission.';
      } else mission.error = 'Integration could not be confirmed. Recheck the canonical commit before retrying; other integrations remain blocked.';
      this.saveMission(mission, mission.error, 'warning');
      this.archive(mission, outcome === 'not_pushed' ? 'integration_failed' : 'integration_uncertain');
      return mission;
    });
  }
}
