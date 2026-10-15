import { DurableObject } from 'cloudflare:workers';
import type { BranchChangeResult, CheckPlan, CheckSettings, CreateMissionInput, IssueDetail, IssueList, Mission, MissionAttempt, MissionEvent, MissionSummary, ModelConnection, Release, Repository, RepositorySkillChange, ReviewMissionInput } from '../shared/types';
import { ApiError, assertActiveRun, assertApproval, assertReplayFingerprint } from './domain';
import { repositoryLabel } from '../shared/repository-names';
import type { AppEnv } from './env';
import type { ExecutionResult } from './execution';
import { SqlStore } from './store';
import { securityClient, type Principal } from './security';
import { needsPacking, packMission, summarizeMission, unpackMission, type BlobStore } from './mission-storage';
import { assertLineInCandidate, assertReviewClear, reviewMissionInput } from './proposal-review';
import { skillMissionInput, validateRepositorySkillChange } from './skill-edit';
import type { ImportReceipt, ImportResult } from './repository-import';
import { applyReleaseChange, type ReleaseChange, type ReleaseReceipt } from './releases';
import { defaultModelConnections, pinMissionModels, validateModelConnection } from './model-config';
import { applyIssueChange, issueFingerprint, linkIssueMission, listIssues, readIssue, recordIssueOutcome, type IssueActor, type IssueChange, type IssueQuery } from './issues';
import { branchName, normalizeBranchRules, type StoredBranchProtection } from './branch-protection';
import { capacityError, catalogName, liveSlots, MISSION_SLOT_GRACE_MS, slotKey, WORKSPACE_MISSION_LIMIT, WORKSPACE_PREVIEW_LIMIT, type CapacitySlot } from './capacity';
import { missionStepTimeoutMs, PREVIEW_STEP_MS } from './budgets';
import { AUTO_INCREASE_ACTOR, checkDurations, checkPlan, DURATION_SAMPLES, normalizeCheckSettings, withLearnedLimits, type CheckSettingsInput, type LearnedLimits } from './check-settings';
import { DeploymentLedger, type DeploymentRecord, type DeploymentStatus, type DeploySettings, type DeployState } from './deployments';
import type { AiCredentials, OperatorModelGrant, OperatorUsageKind, StoredAiGateway, StoredAiKey } from './ai-keys';

interface Receipt<T> { fingerprint: string; result: T }
export interface MissionSummaryCache { repositoryId: string; summaries: MissionSummary[]; cachedAt: string }
export interface IntegrationClaim { claimId?: string; missionId: string; epoch: number; candidateSha: string; baseSha: string; claimedAt?: number; phase?: 'preparing' | 'pushing' }
const INTEGRATION_PREPARATION_MS = 600_000;

function eligibleRaceRuns(mission: Mission): Mission['runs'] {
  const checks = mission.raceChecks ?? mission.checks;
  return mission.runs.filter((run) => run.status === 'completed' && !!run.commitSha && !!run.forkName && checks.some((check) => check.runId === run.id && check.status === 'passed' && check.candidateSha === run.commitSha));
}
export interface PreviewCapability { workspaceId?: string; principal?: import('./security').Principal; repositoryId: string; missionId: string; epoch: number; candidateSha: string; sandboxName: string; expiresAt: number; host?: string; isolated?: boolean }
export interface WorkerPreviewInfo { previewName: string; previewUrl: string | null; deploymentUrl: string | null; notes: string[] }
interface PreviewState { claimId: string; epoch: number; candidateSha: string; phase: 'preparing' | 'ready'; expiresAt: number; sandboxName?: string; worker?: WorkerPreviewInfo }
interface WorkerPreviewRecord { previewName: string; claimId: string; expiresAt: number }
export const PREVIEW_LEASE_MS = 120_000;
export const PREVIEW_HEARTBEAT_MS = 30_000;
export const PREVIEW_READY_MS = 900_000;
export const WORKER_PREVIEW_TTL_MS = 86_400_000;
interface PreviewFailureRecord { claimId: string; epoch: number; candidateSha: string; message: string; failedAt: string }
export interface PreviewStatus { status: 'none' | 'starting' | 'ready' | 'failed'; candidateSha: string | null; expiresAt?: string; error?: string; message?: string; kind?: 'worker' | 'container'; worker?: WorkerPreviewInfo }
interface DispatchIntent { workflowId: string; missionId: string; repositoryId: string; epoch: number; attempts: number; nextAttemptAt: number }
export const DISPATCH_FAST_ATTEMPTS = 8;
interface MissionWatch { workflowId: string; missionId: string; epoch: number; deliveredAt: number; lastReportAt: number; checkAt: number; misses: number }
export const MISSION_WATCHDOG_MS = 900_000;
export const WATCHDOG_MISSING_LIMIT = 3;
const WATCHDOG_MISSING_RECHECK_MS = 60_000;
const ACTIVE_WORKFLOW = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];
const TERMINAL_WORKFLOW = ['complete', 'errored', 'terminated'];
interface ApprovalClear { missionId: string; principal: Principal; queuedAt: string; attempts: number; nextAttemptAt: number }
const APPROVAL_CLEAR_RETRY_MS = 30_000;
const APPROVAL_CLEAR_MAX_BACKOFF_MS = 900_000;

const minutes = (ms: number) => Math.ceil(ms / 60_000);

export function failureLine(error: string): string {
  const first = error.trim().split('\n').find((line) => line.trim()) ?? '';
  return first
    .replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, '$1')
    .replace(/\b(authorization|bearer|token|password|secret)([=:\s]+)\S+/gi, '$1$2[redacted]')
    .trim()
    .slice(0, 300);
}

export const EXECUTION_UPDATING_MESSAGE = 'Gitflare is finishing an update and could not start this proposal. Nothing was started. Retry in about a minute; if it still fails after 5 minutes, contact your Gitflare operator.';

export function integrationPendingMessage(candidateSha: string): string {
  return `Landing has not finished: the default branch has not yet confirmed commit ${candidateSha.slice(0, 12)}, so other proposals in this repository cannot land until it does. If landing started in the last ${minutes(INTEGRATION_PREPARATION_MS)} minutes, wait and choose Land again; retries never push twice. If it has been longer, ask a workspace Owner to check the default branch: once it shows ${candidateSha.slice(0, 12)}, choose Land again to record it.`;
}

export const INTEGRATION_UNCONFIRMED_MESSAGE = 'Landing could not confirm whether the default branch moved to the approved commit, so other proposals in this repository cannot land until it is resolved. Choose Land again to recheck the default branch; it never pushes twice. If the branch does not show the approved commit, ask a workspace Owner to inspect it before landing anything else.';

export const PREVIEW_STARTING_MESSAGE = `Preparing the preview: cloning, installing dependencies and starting the server usually takes 1 to 3 minutes. Status refreshes automatically; if it is not ready after ${minutes(PREVIEW_STEP_MS)} minutes it stops and reports why.`;

export async function startWithDurableDispatch(coordinator: { startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission> }, key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission> {
  try {
    return await coordinator.startMissionWithDispatch(key, id, authorization, models);
  } catch (error) {
    if (error instanceof Error && /startMissionWithDispatch/.test(error.message) && /not a function|does not exist|not implemented|does not implement|missing|unknown method/i.test(error.message)) throw new ApiError(503, 'EXECUTION_DEPLOYMENT_PENDING', EXECUTION_UPDATING_MESSAGE);
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

  listSummaryCache(): MissionSummaryCache[] {
    return this.store.list<MissionSummaryCache>('summary-cache:');
  }

  saveSummaryCache(entries: MissionSummaryCache[]): void {
    this.ctx.storage.transactionSync(() => { for (const entry of entries) this.store.put(`summary-cache:${entry.repositoryId}`, entry); });
  }

  listIssues(query: IssueQuery): IssueList { return listIssues(this.store, query); }

  getIssue(number: number): IssueDetail | undefined { return readIssue(this.store, number); }

  changeIssue(key: string, change: IssueChange, actor: IssueActor): IssueDetail { return readIssue(this.store, this.mutate(key, issueFingerprint(change, actor), () => applyIssueChange(this.store, change, actor)))!; }
  getBranchRequest(key: string, fingerprint: string): BranchChangeResult | undefined {
    const receipt = this.store.get<Receipt<BranchChangeResult>>(`branch-request:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt?.result;
  }

  recordBranchRequest(key: string, fingerprint: string, result: BranchChangeResult): BranchChangeResult {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.store.get<Receipt<BranchChangeResult>>(`branch-request:${key}`);
      if (receipt) { assertReplayFingerprint(receipt.fingerprint, fingerprint); return receipt.result; }
      this.store.put(`branch-request:${key}`, { fingerprint, result });
      return result;
    });
  }

  getCheckSettings(): CheckSettings | undefined { return this.store.get<CheckSettings>('check-settings'); }

  getCheckDurations(): number[] { return this.store.get<number[]>('check-durations') ?? []; }

  getCheckPlan(): CheckPlan { return checkPlan(this.getCheckSettings(), this.getCheckDurations()); }

  applyLearnedCheckLimits(id: string, epoch: number, learned: LearnedLimits): CheckSettings | null {
    return this.ctx.storage.transactionSync(() => {
      const fence = `learned-limits:${id}-${epoch}`;
      if (this.store.get(fence)) return null;
      this.store.put(fence, { at: new Date().toISOString() });
      const next = withLearnedLimits(this.getCheckSettings(), learned);
      if (!next) return null;
      const stored: CheckSettings = { ...normalizeCheckSettings({ ...next }), updatedAt: new Date().toISOString(), updatedBy: AUTO_INCREASE_ACTOR };
      this.store.put('check-settings', stored);
      return stored;
    });
  }

  setCheckSettings(key: string, input: CheckSettingsInput, actorId: string): CheckSettings {
    const normalized = normalizeCheckSettings({ ...input });
    return this.mutate(key, JSON.stringify(['check-settings', normalized]), () => {
      const stored: CheckSettings = { ...normalized, updatedAt: new Date().toISOString(), updatedBy: actorId };
      this.store.put('check-settings', stored);
      return stored;
    });
  }

  getBranchProtection(): StoredBranchProtection | undefined { return this.store.get<StoredBranchProtection>('branch-protection'); }

  setBranchProtection(key: string, rules: unknown, actorId: string): StoredBranchProtection {
    const normalized = normalizeBranchRules(rules);
    return this.mutate(key, JSON.stringify(['branch-protection', normalized]), () => {
      const stored = { rules: normalized, updatedAt: new Date().toISOString(), updatedBy: actorId } satisfies StoredBranchProtection;
      this.store.put('branch-protection', stored);
      return stored;
    });
  }

  pullRequestAction(key: string, id: string, action: 'update' | 'close' | 'reopen', actorId: string, headSha?: string, clearFor?: Principal): Mission {
    return this.mutateMission(key, JSON.stringify(['pull', id, action, headSha ?? null]), id, () => {
      const mission = this.requiredMission(id);
      this.queueApprovalClear(id, clearFor);
      const change = mission.branchChange;
      if (!change) throw new ApiError(409, 'NOT_A_PULL_REQUEST', 'Only a pull request can be updated from its branch, closed or reopened.');
      if (['integrating', 'integrated'].includes(mission.status)) throw new ApiError(409, 'PULL_REQUEST_LANDED', 'This pull request is landing or has landed.');
      if (action === 'close') {
        if (change.closedAt) return mission;
        if (mission.status === 'approved') { this.archive(mission, 'approved'); delete mission.approvedAt; delete mission.approvedBy; this.archive(mission, 'approval_revoked'); }
        this.store.delete(`dispatch:${mission.id}-${mission.epoch}`);
        this.store.delete(`watch:${mission.id}-${mission.epoch}`);
        mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'cancelled', completedAt: new Date().toISOString() } : run);
        mission.status = 'cancelled';
        mission.branchChange = { ...change, closedAt: new Date().toISOString(), closedBy: actorId };
        this.saveMission(mission, `${actorId} closed this pull request. Late execution results will be rejected.`, 'warning');
        this.archive(mission, 'cancelled');
        return mission;
      }
      if (!headSha || !/^[a-f0-9]{40}$/.test(headSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Provide the exact branch head commit.');
      if (action === 'reopen' && !change.closedAt) throw new ApiError(409, 'PULL_REQUEST_OPEN', 'This pull request is already open.');
      if (action === 'update' && change.closedAt) throw new ApiError(409, 'PULL_REQUEST_CLOSED', 'Reopen this pull request before updating it from its branch.');
      if (['queued', 'running', 'checking'].includes(mission.status)) throw new ApiError(409, 'MISSION_ACTIVE', 'Checks are already running for this pull request. Wait or cancel them first.');
      if (mission.status === 'approved') {
        this.archive(mission, 'approved');
        mission.status = 'needs_review';
        delete mission.approvedAt;
        delete mission.approvedBy;
        this.archive(mission, 'approval_revoked');
      }
      const { closedAt: _closedAt, closedBy: _closedBy, ...open } = change;
      mission.branchChange = { ...open, headSha };
      return this.saveMission(mission, action === 'reopen' ? `${actorId} reopened this pull request at ${headSha.slice(0, 12)}.` : `${actorId} updated this pull request from ${change.branch} at ${headSha.slice(0, 12)}. Earlier approvals no longer apply.`);
    });
  }

  getModelConnections(): ModelConnection[] { return this.store.get<ModelConnection[]>('model-connections') ?? defaultModelConnections(); }

  getAiCredentials(): AiCredentials { return { keys: this.store.get<StoredAiKey[]>('ai-keys') ?? [], gateway: this.store.get<StoredAiGateway>('ai-gateway') ?? null, operatorModels: this.store.get<OperatorModelGrant>('operator-models') ?? null }; }

  setOperatorModels(grant: OperatorModelGrant | null): AiCredentials {
    if (grant) this.store.put('operator-models', grant);
    else this.store.delete('operator-models');
    return this.getAiCredentials();
  }

  reserveOperatorUsage(kind: OperatorUsageKind, id: string, now = Date.now()): { allowed: boolean; limit: number } {
    return this.ctx.storage.transactionSync(() => {
      const grant = this.store.get<OperatorModelGrant>('operator-models');
      if (!grant) return { allowed: true, limit: 0 };
      const limit = kind === 'mission' ? grant.missionsPerDay : grant.draftsPerDay;
      const day = new Date(now).toISOString().slice(0, 10);
      const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
      this.store.delete(`operator-usage:${kind}:${yesterday}`);
      const used = this.store.get<string[]>(`operator-usage:${kind}:${day}`) ?? [];
      if (used.includes(id)) return { allowed: true, limit };
      if (used.length >= limit) return { allowed: false, limit };
      this.store.put(`operator-usage:${kind}:${day}`, [...used, id]);
      return { allowed: true, limit };
    });
  }

  saveAiKey(record: StoredAiKey): AiCredentials {
    return this.ctx.storage.transactionSync(() => {
      this.store.put('ai-keys', [...this.getAiCredentials().keys.filter(key => key.provider !== record.provider), record]);
      return this.getAiCredentials();
    });
  }

  removeAiKey(provider: string): AiCredentials {
    return this.ctx.storage.transactionSync(() => {
      const keys = this.getAiCredentials().keys;
      if (!keys.some(key => key.provider === provider)) throw new ApiError(404, 'AI_KEY_NOT_FOUND', 'No key is stored for this provider.');
      this.store.put('ai-keys', keys.filter(key => key.provider !== provider));
      return this.getAiCredentials();
    });
  }

  saveAiGateway(record: StoredAiGateway | null): AiCredentials {
    if (record) this.store.put('ai-gateway', record);
    else this.store.delete('ai-gateway');
    return this.getAiCredentials();
  }

  getAiEnabled(): boolean { return this.store.get<boolean>('ai-enabled') ?? true; }

  setAiEnabled(enabled: boolean): boolean { this.store.put('ai-enabled', enabled); return enabled; }

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

  listReleases(): Release[] { return this.store.list<Release>('release:'); }

  getRelease(id: string): Release | undefined { return this.store.get<Release>(`release:${id}`); }

  getReleaseRequest(key: string, fingerprint: string): ReleaseReceipt | undefined {
    const receipt = this.store.get<ReleaseReceipt>(`release-request:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt;
  }

  changeRelease(key: string, fingerprint: string, change: ReleaseChange): { receipt: ReleaseReceipt; fresh: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const reserved = new Map(this.store.list<{ tag: string; key: string }>('release-pending:').map(item => [item.tag, item.key]));
      const outcome = applyReleaseChange(this.listReleases(), reserved, this.getReleaseRequest(key, fingerprint), key, fingerprint, change);
      if (!outcome.fresh) return { receipt: outcome.receipt, fresh: false };
      if (outcome.put) this.store.put(`release:${outcome.put.id}`, outcome.put);
      if (outcome.remove) this.store.delete(`release:${outcome.remove}`);
      if (outcome.reserve) this.store.put(`release-pending:${outcome.reserve}`, { tag: outcome.reserve, key });
      if (outcome.unreserve) this.store.delete(`release-pending:${outcome.unreserve}`);
      this.store.put(`release-request:${key}`, outcome.receipt);
      return { receipt: outcome.receipt, fresh: true };
    });
  }

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

  async savePreviewCapability(hash: string, capability: PreviewCapability): Promise<void> {
    this.store.put(`preview:${hash}`, capability);
    await this.ensureDispatchAlarm(capability.expiresAt);
  }

  async getPreviewCapability(hash: string): Promise<PreviewCapability | undefined> {
    const capability = this.store.get<PreviewCapability>(`preview:${hash}`);
    if (capability && capability.expiresAt > Date.now()) return capability;
    await this.prunePreviewCapabilities();
    return undefined;
  }

  private async prunePreviewCapabilities(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const [key, capability] of this.store.entries<PreviewCapability>('preview:')) {
      if (capability.expiresAt <= now) this.store.delete(key);
      else next = Math.min(next, capability.expiresAt);
    }
    if (next !== Infinity) await this.ensureDispatchAlarm(next);
  }

  claimPreview(key: string, id: string, epoch: number, candidateSha: string): { sandboxName?: string; worker?: WorkerPreviewInfo; claimId: string; claimed: boolean; expiresAt?: number; previous?: string } {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      if (mission.epoch !== epoch || mission.candidateSha !== candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(mission.status)) throw new ApiError(409, 'STALE_PREVIEW', 'Only the current verified candidate can be previewed.');
      const fingerprint = JSON.stringify(['preview', id, epoch, candidateSha]);
      const receipt = this.store.get<Receipt<boolean>>(`request:${key}`);
      if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
      const current = this.store.get<PreviewState>(`preview-state:${id}`);
      if (current?.claimId && current.epoch === epoch && current.candidateSha === candidateSha && current.expiresAt > Date.now()) {
        if (current.worker) return { worker: current.worker, claimId: current.claimId, claimed: false, expiresAt: current.expiresAt };
        return current.sandboxName ? { sandboxName: current.sandboxName, claimId: current.claimId, claimed: false, expiresAt: current.expiresAt } : { claimId: current.claimId, claimed: false };
      }
      const claimId = crypto.randomUUID();
      this.store.put(`preview-state:${id}`, { claimId, epoch, candidateSha, phase: 'preparing', expiresAt: Date.now() + PREVIEW_LEASE_MS } satisfies PreviewState);
      this.store.delete(`preview-failure:${id}`);
      this.store.put(`request:${key}`, { fingerprint, result: true });
      return current?.claimId ? { claimId, claimed: true, previous: current.sandboxName ?? `preview-${id}-${current.claimId}` } : { claimId, claimed: true };
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

  previewReady(id: string, epoch: number, candidateSha: string, claimId: string, sandboxName: string): number {
    const state = this.previewClaim(id, epoch, candidateSha, claimId);
    if (sandboxName !== `preview-${id}-${claimId}`) throw new ApiError(409, 'STALE_PREVIEW', 'The preview sandbox does not belong to this attempt.');
    const expiresAt = Date.now() + PREVIEW_READY_MS;
    this.store.put(`preview-state:${id}`, { ...state, phase: 'ready', sandboxName, expiresAt } satisfies PreviewState);
    return expiresAt;
  }

  workerPreviewReady(id: string, epoch: number, candidateSha: string, claimId: string, worker: WorkerPreviewInfo): number {
    return this.ctx.storage.transactionSync(() => {
      const state = this.previewClaim(id, epoch, candidateSha, claimId);
      const expiresAt = Date.now() + WORKER_PREVIEW_TTL_MS;
      this.store.put(`preview-state:${id}`, { ...state, phase: 'ready', worker, expiresAt } satisfies PreviewState);
      this.store.put(`worker-preview:${id}`, { previewName: worker.previewName, claimId, expiresAt } satisfies WorkerPreviewRecord);
      return expiresAt;
    });
  }

  workerPreview(id: string): WorkerPreviewRecord | undefined { return this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`); }

  retireWorkerPreview(id: string, claimId?: string): WorkerPreviewRecord | null {
    return this.ctx.storage.transactionSync(() => {
      const record = this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`);
      if (!record || (claimId && record.claimId !== claimId)) return null;
      this.store.delete(`worker-preview:${id}`);
      const state = this.store.get<PreviewState>(`preview-state:${id}`);
      if (state?.worker) this.store.delete(`preview-state:${id}`);
      return record;
    });
  }

  previewFailed(id: string, claimId: string, message?: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.store.get<PreviewState>(`preview-state:${id}`);
      if (state?.claimId !== claimId) return false;
      this.store.delete(`preview-state:${id}`);
      if (message) this.store.put(`preview-failure:${id}`, { claimId, epoch: state.epoch, candidateSha: state.candidateSha, message: message.slice(0, 700), failedAt: new Date().toISOString() } satisfies PreviewFailureRecord);
      return true;
    });
  }

  previewStatus(id: string): PreviewStatus {
    const mission = this.requiredMission(id);
    const current = (entry?: { epoch: number; candidateSha: string }) => !!entry && entry.epoch === mission.epoch && entry.candidateSha === mission.candidateSha;
    const state = this.store.get<PreviewState>(`preview-state:${id}`);
    if (current(state) && state!.expiresAt > Date.now()) return state!.phase === 'ready' ? { status: 'ready', candidateSha: mission.candidateSha, expiresAt: new Date(state!.expiresAt).toISOString(), ...(state!.worker ? { kind: 'worker' as const, worker: state!.worker } : {}) } : { status: 'starting', candidateSha: mission.candidateSha, message: PREVIEW_STARTING_MESSAGE };
    const failure = this.store.get<PreviewFailureRecord>(`preview-failure:${id}`);
    if (current(failure)) return { status: 'failed', candidateSha: mission.candidateSha, error: failure!.message };
    return { status: 'none', candidateSha: mission.candidateSha };
  }

  createRepository(key: string, repository: Repository): Repository {
    return this.mutate(key, JSON.stringify(['repository', repository.name, repository.description]), () => {
      const label = repositoryLabel(repository).toLowerCase();
      if (this.listRepositories().some((item) => item.name.toLowerCase() === repository.name.toLowerCase() || repositoryLabel(item).toLowerCase() === label)) {
        throw new ApiError(409, 'REPOSITORY_EXISTS', `A repository named ${repositoryLabel(repository)} already exists in this workspace.`);
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

  private readonly blobs: BlobStore = { get: (key) => this.store.get<string>(key), putIfAbsent: (key, value) => this.store.putIfAbsent(key, value) };

  listMissions(): Mission[] {
    return this.store.list<Mission>('mission:').map((mission) => unpackMission(mission, this.blobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listMissionSummaries(): MissionSummary[] {
    return this.store.list<Mission>('mission:').map(summarizeMission).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMission(id: string): Mission | undefined {
    const stored = this.store.get<Mission>(`mission:${id}`);
    if (!stored) return undefined;
    const mission = unpackMission(stored, this.blobs);
    if (needsPacking(stored)) this.store.put(`mission:${id}`, packMission(mission, this.blobs));
    return mission;
  }

  missionRepository(id: string): string | undefined { return this.store.get<string>(`mission-repository:${id}`); }

  indexMission(id: string, repositoryId: string): void { this.store.put(`mission-repository:${id}`, repositoryId); }

  listAttempts(id: string): MissionAttempt[] {
    this.requiredMission(id);
    return this.store.list<MissionAttempt>(`attempt:${id}:`).map((attempt) => {
      const snapshot = unpackMission(attempt.snapshot, this.blobs);
      if (needsPacking(attempt.snapshot)) this.store.put(`attempt:${id}:${attempt.id}`, { ...attempt, snapshot: packMission(snapshot, this.blobs) });
      return { ...attempt, snapshot };
    }).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  private archive(mission: Mission, reason: MissionAttempt['reason']): void {
    const id = crypto.randomUUID();
    this.store.insert(`attempt:${mission.id}:${id}`, { id, epoch: mission.epoch, recordedAt: new Date().toISOString(), reason, snapshot: packMission(mission, this.blobs) } satisfies MissionAttempt);
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
    this.store.put(`mission:${mission.id}`, packMission(mission, this.blobs));
    return mission;
  }

  createMission(key: string, input: CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Mission {
    return this.mutate(key, JSON.stringify(['mission', input]), () => this.newMission(input, authorization, models));
  }

  private newMission(input: CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections(), id: string = crypto.randomUUID()): Mission {
      const repository = this.getRepository(input.repositoryId);
      if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
      if (input.expectedBaseSha !== undefined && input.expectedBaseSha !== repository.headSha) throw new ApiError(409, 'STALE_PROPOSAL_BASE', 'The repository changed while you drafted this proposal. Refresh the base and review your assignments before saving.');
      const now = new Date().toISOString();
      const criteria = input.acceptanceCriteria ?? [];
      const skillChange = input.skillChange ? validateRepositorySkillChange(input.skillChange) : undefined;
      if (skillChange && repository.headSha !== skillChange.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill before proposing this edit.');
      const revertChange = input.revertChange;
      if (revertChange && (!/^[a-f0-9]{40}$/.test(revertChange.landedSha) || !/^[a-f0-9]{40}$/.test(revertChange.previousSha))) throw new ApiError(400, 'INVALID_COMMIT', 'A revert needs the exact landed and previous commits.');
      if (input.issueNumber !== undefined && !readIssue(this.store, input.issueNumber)) throw new ApiError(404, 'ISSUE_NOT_FOUND', `Issue #${input.issueNumber} could not be found in this repository.`);
      const branchChange = input.branchChange ? { ...input.branchChange, branch: branchName(input.branchChange.branch), targetBranch: repository.defaultBranch } : undefined;
      if (branchChange && (!/^[a-f0-9]{40}$/.test(branchChange.headSha) || branchChange.branch === repository.defaultBranch)) throw new ApiError(400, 'INVALID_PULL_REQUEST', 'A pull request needs the exact head commit of a branch other than the default branch.');
      const race = input.mode === 'race' && !revertChange && !branchChange;
      const tasks = skillChange ? [{ name: 'Skill editor', role: 'Trusted skill editor', task: `Apply exactly the submitted Markdown to ${skillChange.path}.` }] : branchChange ? [{ name: 'Branch merger', role: 'Trusted branch merger', task: `Merge ${branchChange.branch} at ${branchChange.headSha.slice(0, 12)} into ${branchChange.targetBranch}, fast-forwarding when possible.` }] : revertChange ? [{ name: 'Revert editor', role: 'Trusted revert editor', task: `Undo exactly the change landed by "${revertChange.title}" (${revertChange.previousSha.slice(0, 12)} to ${revertChange.landedSha.slice(0, 12)}) with a new revert commit.` }] : input.tasks ?? (race ? [
        { name: 'Candidate A', role: 'Independent attempt', task: 'Complete the whole mission with the smallest change that satisfies every criterion.' },
        { name: 'Candidate B', role: 'Independent attempt', task: 'Complete the whole mission, favouring clarity and explicit error handling.' },
      ] : [
        { name: 'Implementation agent', role: 'Implementation', task: 'Implement the core change. If this mission assigns explicit agent roles, implement only your assigned role.' },
        { name: 'Compatibility agent', role: 'Compatibility', task: 'Improve compatibility and error handling. If this mission assigns explicit agent roles, implement only your assigned role.' },
      ]);
      const mission: Mission = {
        id, repositoryId: repository.id, title: input.title, prompt: input.prompt,
        acceptanceCriteria: criteria, authorization, ...(input.attachments?.length ? { attachments: input.attachments.map(({ name, content }) => ({ name, content })) } : {}), ...(skillChange ? { skillChange } : {}), ...(revertChange ? { revertChange: { ...revertChange } } : {}), ...(branchChange ? { branchChange } : {}), ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}), ...(race ? { mode: 'race' as const } : {}),
        status: 'draft', baseSha: repository.headSha, candidateSha: null, epoch: 0,
        runs: tasks.map((task) => ({ ...task, assignment: task.task, id: crypto.randomUUID(), task: `${input.prompt}\nYou are ${task.name} (${task.role}). ${race ? 'Complete the whole mission on your own; other agents are attempting it independently and a reviewer will choose one result. Your approach' : 'Your assigned task'}: ${task.task}\nPreserve existing tests and run them.${criteria.length ? `\nAcceptance criteria:\n${criteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''}`, status: 'queued', changedFiles: [] })),
        checks: [], changes: [], events: [], createdAt: now, updatedAt: now,
      };
      if (mission.issueNumber !== undefined) linkIssueMission(this.store, mission.issueNumber, mission.id, now);
      return this.saveMission(pinMissionModels(mission, models), `Mission created${mission.issueNumber !== undefined ? ` for issue #${mission.issueNumber}` : ''}. Agent execution has not started.`);
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
    const missionId = crypto.randomUUID();
    const release = this.getSkillEditRequest(key, repositoryId, change) ? undefined : await this.reserveWorkspaceMission(authorization.workspaceId, missionId, repositoryId, 1, missionStepTimeoutMs({ runs: [], skillChange: change }));
    const created = await this.releaseOnFailure(release, () => this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.getSkillEditRequest(key, repositoryId, change);
      if (existing) return existing;
      if (!this.env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.');
      const access = securityClient(this.env);
      await access.authorize(authorization.principal, 'contribute', 'repository', repositoryId);
      await access.authorize(authorization.principal, 'execute', 'repository', repositoryId);
      return this.mutate(key, JSON.stringify(['skill-edit', repositoryId, change]), () => {
        const mission = this.newMission(skillMissionInput(repositoryId, change), authorization, undefined, missionId);
        mission.status = 'queued';
        mission.epoch = 1;
        this.queueDispatch(mission);
        return this.saveMission(mission, 'Skill edit queued for exact-content execution and repository checks.');
      });
    }));
    if (created.id !== missionId) await release?.();
    return created;
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
    const release = await this.reserveMissionCapacity(key, id, authorization);
    const started = await this.releaseOnFailure(release, () => this.mutateMission(key, JSON.stringify(['start', id]), id, () => {
      const mission = pinMissionModels(this.requiredMission(id), models);
      if (!['draft', 'failed', 'cancelled', 'needs_review'].includes(mission.status)) throw new ApiError(409, 'MISSION_ACTIVE', 'Cancel the active attempt or revoke its approval before starting again.');
      const repository = this.getRepository(mission.repositoryId);
      if (mission.skillChange && repository?.headSha !== mission.skillChange.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill and submit a new edit proposal.');
      if (mission.branchChange?.closedAt) throw new ApiError(409, 'PULL_REQUEST_CLOSED', 'Reopen this pull request before running its checks.');
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
      delete mission.selectedRunId;
      delete mission.raceChecks;
      delete mission.raceChanges;
      mission.runs = mission.runs.map((run) => ({ id: run.id, name: run.name, role: run.role, task: run.task, assignment: run.assignment, model: run.model, modelConfig: run.modelConfig, status: 'queued', changedFiles: [] }));
      this.queueDispatch(mission);
      return this.saveMission(mission, `Execution attempt ${mission.epoch} queued.`);
    }));
    if (started.status === 'cancelled') throw new ApiError(409, 'STALE_REQUEST', 'This start request was cancelled. Use a new request to retry the mission.');
    if (started.status === 'queued') this.queueDispatch(started);
    return started;
  }

  async startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Promise<Mission> {
    return this.startMission(key, id, authorization, models);
  }

  private failDispatch(id: string, epoch: number, error = 'The Workflow ended before mission completion was recorded. Start a new attempt to retry; late results from this attempt will be rejected.', runError = 'Workflow dispatch was not confirmed'): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      assertActiveRun(mission.status, mission.epoch, epoch);
      mission.status = 'failed';
      mission.error = error;
      mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'failed', completedAt: new Date().toISOString(), error: runError } : run);
      this.store.delete(`dispatch:${id}-${epoch}`);
      this.store.delete(`watch:${id}-${epoch}`);
      this.saveMission(mission, mission.error, 'error');
      this.archive(mission, 'completed');
      return mission;
    });
  }

  private watchdogMs(): number {
    const seconds = Number(this.env?.MISSION_WATCHDOG_SECONDS);
    return Number.isFinite(seconds) && seconds >= 60 ? seconds * 1000 : MISSION_WATCHDOG_MS;
  }

  private watchMission(id: string, epoch: number): void {
    const key = `watch:${id}-${epoch}`;
    const now = Date.now();
    const existing = this.store.get<MissionWatch>(key);
    this.store.put(key, { workflowId: `${id}-${epoch}`, missionId: id, epoch, deliveredAt: existing?.deliveredAt ?? now, lastReportAt: now, checkAt: now + this.watchdogMs(), misses: 0 } satisfies MissionWatch);
  }

  listMissionWatches(): MissionWatch[] {
    return this.store.list<MissionWatch>('watch:');
  }

  private async superviseMissions(): Promise<void> {
    const due = this.listMissionWatches().filter((watch) => watch.checkAt <= Date.now()).slice(0, 10);
    for (const watch of due) {
      const key = `watch:${watch.workflowId}`;
      if (!this.isMissionActive(watch.missionId, watch.epoch)) { this.store.delete(key); continue; }
      let status: string | null = null;
      try { status = (await (await this.env.MISSION_WORKFLOW!.get(watch.workflowId)).status()).status; } catch {}
      const current = this.store.get<MissionWatch>(key);
      if (!current || current.lastReportAt !== watch.lastReportAt || !this.isMissionActive(watch.missionId, watch.epoch)) continue;
      const mission = this.requiredMission(watch.missionId);
      const budgetMs = missionStepTimeoutMs(mission) + this.watchdogMs();
      const silentMinutes = Math.max(1, Math.round((Date.now() - watch.lastReportAt) / 60_000));
      const misses = status ? 0 : watch.misses + 1;
      const reason = status && TERMINAL_WORKFLOW.includes(status) ? `The Workflow for attempt ${watch.epoch} ${status === 'complete' ? 'completed' : `ended as ${status}`} without reporting a result (no report for ${silentMinutes} min)`
        : misses >= WATCHDOG_MISSING_LIMIT ? `The Workflow for attempt ${watch.epoch} could not be found after ${misses} checks (no report for ${silentMinutes} min)`
        : Date.now() - watch.deliveredAt > budgetMs ? `Attempt ${watch.epoch} exceeded its ${Math.round(budgetMs / 60_000)}-minute execution budget without a final report`
        : null;
      if (reason) {
        console.error(JSON.stringify({ event: 'mission_watchdog_failed', missionId: watch.missionId, epoch: watch.epoch, workflowStatus: status, misses }));
        this.failDispatch(watch.missionId, watch.epoch, `${reason}. Start a new attempt to retry; late results from this attempt will be rejected.`, 'Execution stopped without reporting a result');
        continue;
      }
      this.store.put(key, { ...watch, misses, checkAt: Date.now() + (status && ACTIVE_WORKFLOW.includes(status) ? this.watchdogMs() : WATCHDOG_MISSING_RECHECK_MS) } satisfies MissionWatch);
    }
  }

  private queueApprovalClear(missionId: string, principal?: Principal): void {
    if (!principal) return;
    this.store.put(`approval-clear:${missionId}`, { missionId, principal, queuedAt: new Date().toISOString(), attempts: 0, nextAttemptAt: Date.now() } satisfies ApprovalClear);
  }

  listApprovalClears(): ApprovalClear[] {
    return this.store.list<ApprovalClear>('approval-clear:');
  }

  async settleApprovalClears(missionId?: string, actor?: Principal, dueOnly = false): Promise<void> {
    const pending = this.listApprovalClears().filter((entry) => (!missionId || entry.missionId === missionId) && (!dueOnly || entry.nextAttemptAt <= Date.now()));
    if (!pending.length) return;
    await this.ensureDispatchAlarm(Date.now() + APPROVAL_CLEAR_RETRY_MS);
    let failure: unknown;
    for (const entry of pending) {
      const key = `approval-clear:${entry.missionId}`;
      try {
        await securityClient(this.env).clearApprovals(actor ?? entry.principal, entry.missionId);
        if (this.store.get<ApprovalClear>(key)?.queuedAt === entry.queuedAt) this.store.delete(key);
      } catch (error) {
        failure ??= error;
        const attempts = entry.attempts + 1;
        console.error(JSON.stringify({ event: 'approval_clear_failed', missionId: entry.missionId, attempts }));
        if (this.store.get<ApprovalClear>(key)?.queuedAt === entry.queuedAt) this.store.put(key, { ...entry, attempts, nextAttemptAt: Date.now() + Math.min(APPROVAL_CLEAR_MAX_BACKOFF_MS, APPROVAL_CLEAR_RETRY_MS * 2 ** (attempts - 1)) } satisfies ApprovalClear);
      }
    }
    if (failure && !dueOnly) throw failure;
  }

  async alarm(): Promise<void> {
    await this.prunePreviewCapabilities();
    await this.deliverDispatches();
    await this.superviseMissions();
    await this.settleApprovalClears(undefined, undefined, true);
    const next = [...this.listDispatches().map((intent) => intent.nextAttemptAt), ...this.listMissionWatches().map((watch) => watch.checkAt), ...this.listApprovalClears().map((entry) => entry.nextAttemptAt)];
    if (next.length) await this.ensureDispatchAlarm(Math.max(Date.now() + 1000, Math.min(...next)));
  }

  private async deliverDispatches(): Promise<void> {
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
          this.watchMission(intent.missionId, intent.epoch);
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
  }

  cancelMission(key: string, id: string): Mission {
    return this.mutateMission(key, JSON.stringify(['cancel', id]), id, () => {
      const mission = this.requiredMission(id);
      if (['integrated', 'approved', 'integrating'].includes(mission.status)) throw new ApiError(409, 'MISSION_FINAL', 'An approved or integrating mission cannot be cancelled.');
      mission.status = 'cancelled';
      this.store.delete(`dispatch:${mission.id}-${mission.epoch}`);
      this.store.delete(`watch:${mission.id}-${mission.epoch}`);
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
    if (complete) this.store.delete(`watch:${id}-${epoch}`);
    else this.watchMission(id, epoch);
    if (result.runs) {
      const previousRuns = new Map(mission.runs.map((run) => [run.id, run]));
      for (const run of result.runs) {
        const previous = previousRuns.get(run.id);
        if (!previous || previous.status === run.status && previous.summary === run.summary) continue;
        const summary = run.status === 'failed' && run.error ? failureLine(run.error) : run.summary?.trim().slice(0, 1000);
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
      const durations = checkDurations(mission.checks);
      if (durations.length) this.store.put('check-durations', [...this.getCheckDurations(), ...durations].slice(-DURATION_SAMPLES));
      const race = mission.mode === 'race';
      const passed = race
        ? eligibleRaceRuns(mission).length > 0
        : !!mission.candidateSha && mission.checks.some((check) => check.candidateSha === mission.candidateSha) && mission.checks.every((check) => check.status === 'passed') && mission.runs.every((run) => run.status === 'completed');
      mission.status = passed && !result.error ? 'needs_review' : 'failed';
      mission.error = result.error;
      return this.ctx.storage.transactionSync(() => {
        this.saveMission(mission, passed && !result.error ? (race ? `${eligibleRaceRuns(mission).length} candidate(s) passed. Compare them and select one to review.` : 'Candidate checks passed. Review the exact commit before approval.') : 'Execution finished without a passing integration candidate.', passed && !result.error ? 'success' : 'error');
        this.archive(mission, 'completed');
        return mission;
      });
    }
    return this.saveMission(mission);
  }

  reviewMission(key: string, id: string, supplied: ReviewMissionInput, actorId: string, clearFor?: Principal): Mission {
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
        assertLineInCandidate(mission, input);
        mission.reviews.push({ id: crypto.randomUUID(), kind: input.action, body: input.body!, authorId: actorId, createdAt: new Date().toISOString(), epoch: input.epoch, candidateSha: input.candidateSha, baseSha: input.baseSha, ...(input.path === undefined ? {} : { path: input.path, line: input.line, side: input.side }) });
        if (input.action === 'request_changes') this.queueApprovalClear(id, clearFor);
        if (input.action === 'request_changes' && mission.status === 'approved') {
          this.archive(mission, 'approved');
          mission.status = 'needs_review';
          delete mission.approvedAt;
          delete mission.approvedBy;
          this.archive(mission, 'approval_revoked');
        }
      }
      return this.saveMission(mission, input.action === 'resolve' ? `Reviewer ${actorId} resolved their change request.` : input.action === 'request_changes' ? `Reviewer ${actorId} requested changes to this revision.` : input.path === undefined ? `${actorId} added a review comment.` : `${actorId} commented on ${input.path.slice(0, 200)}:${input.line}.`, input.action === 'request_changes' ? 'warning' : 'info');
    });
  }

  selectCandidate(key: string, id: string, runId: string, epoch: number, actorId = 'workspace-owner', clearFor?: Principal): Mission {
    return this.mutateMission(key, JSON.stringify(['select', id, runId, epoch]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.mode !== 'race') throw new ApiError(409, 'NOT_A_RACE', 'Only a race mission has candidates to choose between.');
      if (mission.epoch !== epoch) throw new ApiError(409, 'STALE_SELECTION', 'This selection belongs to another attempt. Refresh the mission.');
      if (mission.status !== 'needs_review') throw new ApiError(409, 'SELECTION_LOCKED', 'A candidate can be selected only while the race awaits review. Revoke approval to choose again.');
      const run = eligibleRaceRuns(mission).find((entry) => entry.id === runId);
      if (!run) throw new ApiError(409, 'CANDIDATE_NOT_ELIGIBLE', 'Select an agent whose candidate passed its checks.');
      mission.raceChecks ??= mission.checks;
      mission.raceChanges ??= mission.changes;
      this.queueApprovalClear(id, clearFor);
      mission.selectedRunId = run.id;
      mission.candidateSha = run.commitSha!;
      mission.integrationForkName = run.forkName;
      mission.checks = mission.raceChecks.filter((check) => check.runId === run.id);
      mission.changes = mission.raceChanges.filter((change) => change.runIds.includes(run.id));
      return this.saveMission(mission, `${actorId} selected ${run.name.slice(0, 120)}'s candidate ${run.commitSha!.slice(0, 12)} for review.`);
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

  revokeApproval(key: string, id: string, candidateSha: string, baseSha: string, clearFor?: Principal): Mission {
    return this.mutateMission(key, JSON.stringify(['revoke', id, candidateSha, baseSha]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.status !== 'approved') throw new ApiError(409, 'NOT_APPROVED', 'Only an approved mission can have its approval revoked. Resolve any integration first.');
      if (mission.candidateSha !== candidateSha || mission.baseSha !== baseSha) throw new ApiError(409, 'STALE_APPROVAL', 'Refresh before revoking approval for this exact candidate and base.');
      this.queueApprovalClear(id, clearFor);
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
      this.store.put('integration:claim', { claimId, missionId: id, epoch: mission.epoch, candidateSha, baseSha, claimedAt: Date.now(), phase: 'preparing' });
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
      this.recordLinkedIssues(mission, sha);
      return mission;
    });
  }

  private recordLinkedIssues(mission: Mission, sha: string): void {
    if (mission.issueNumber !== undefined) recordIssueOutcome(this.store, mission.issueNumber, 'closed', `Closed by mission ${mission.title} (${sha.slice(0, 7)}).`);
    const reverted = mission.revertChange ? this.getMission(mission.revertChange.missionId) : undefined;
    if (reverted?.issueNumber !== undefined) recordIssueOutcome(this.store, reverted.issueNumber, 'open', `Reopened because mission ${reverted.title} was reverted (${sha.slice(0, 7)}).`);
  }

  claimIntegrationPush(id: string, epoch: number, claimId: string): void {
    this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || mission.epoch !== epoch || mission.status !== 'integrating' || claim.phase !== 'preparing') throw new ApiError(409, 'STALE_EXECUTION', 'This integration no longer owns a preparation claim.');
      if (claim.claimedAt === undefined || Date.now() - claim.claimedAt >= INTEGRATION_PREPARATION_MS) throw new ApiError(409, 'INTEGRATION_DEADLINE', 'Landing preparation expired before the canonical push.');
      claim.phase = 'pushing';
      this.store.put('integration:claim', claim);
    });
  }

  releaseStaleIntegration(id: string, claimId: string): Mission | null {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== mission.epoch || mission.status !== 'integrating') return null;
      if (claim.phase !== 'preparing' || claim.claimedAt === undefined || Date.now() - claim.claimedAt < INTEGRATION_PREPARATION_MS) return null;
      this.store.delete('integration:claim');
      mission.status = 'approved';
      mission.error = 'Landing preparation expired before permission to push. Its fenced repository claim was released; retry landing.';
      this.saveMission(mission, mission.error, 'warning');
      this.archive(mission, 'integration_failed');
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
      } else {
        claim.phase = 'pushing';
        this.store.put('integration:claim', claim);
        mission.error = INTEGRATION_UNCONFIRMED_MESSAGE;
      }
      this.saveMission(mission, mission.error, 'warning');
      this.archive(mission, outcome === 'not_pushed' ? 'integration_failed' : 'integration_uncertain');
      return mission;
    });
  }

  integrationClaim(): IntegrationClaim | undefined { return this.store.get<IntegrationClaim>('integration:claim'); }

  private async releaseOnFailure<T>(release: (() => Promise<void>) | undefined, operation: () => T | Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { await release?.().catch(() => {}); throw error; }
  }

  private async reserveMissionCapacity(key: string, id: string, authorization?: NonNullable<Mission['authorization']>): Promise<(() => Promise<void>) | undefined> {
    const mission = this.getMission(id);
    if (!mission || this.store.get(`request:${key}`) || ['queued', 'running', 'checking'].includes(mission.status)) return undefined;
    const workspaceId = authorization?.workspaceId ?? mission.authorization?.workspaceId ?? this.getRepository(mission.repositoryId)?.workspaceId ?? 'legacy';
    return this.reserveWorkspaceMission(workspaceId, id, mission.repositoryId, mission.epoch + 1, missionStepTimeoutMs(mission));
  }

  // Without a coordinator namespace there is no workspace catalog to count against
  private async reserveWorkspaceMission(workspaceId: string, missionId: string, repositoryId: string, epoch: number, timeoutMs: number): Promise<(() => Promise<void>) | undefined> {
    if (!this.env?.GITFLARE_COORDINATOR) return undefined;
    const catalog = this.env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
    const reserved = await catalog.reserveMissionSlot(missionId, repositoryId, epoch, Date.now() + timeoutMs + MISSION_SLOT_GRACE_MS);
    return reserved ? () => catalog.releaseMissionSlot(missionId, epoch) : undefined;
  }

  async reserveMissionSlot(missionId: string, repositoryId: string, epoch: number, expiresAt: number): Promise<boolean> {
    const claim = () => this.ctx.storage.transactionSync(() => {
      const existing = this.store.get<CapacitySlot>(slotKey('mission', missionId));
      if (existing && existing.expiresAt > Date.now()) {
        this.store.put(slotKey('mission', missionId), { ...existing, repositoryId, epoch, expiresAt: Math.max(existing.expiresAt, expiresAt) } satisfies CapacitySlot);
        return false;
      }
      if (liveSlots(this.store, 'mission').length >= WORKSPACE_MISSION_LIMIT) return undefined;
      this.store.put(slotKey('mission', missionId), { id: missionId, repositoryId, epoch, expiresAt } satisfies CapacitySlot);
      return true;
    });
    const first = claim();
    if (first !== undefined) return first;
    for (const slot of liveSlots(this.store, 'mission')) {
      let active = false;
      if (slot.repositoryId && slot.epoch !== undefined) {
        try { active = await this.env.GITFLARE_COORDINATOR.getByName(`repository:${slot.repositoryId}`).isMissionActive(slot.id, slot.epoch); }
        catch { active = true; }
      }
      if (!active && this.store.get<CapacitySlot>(slotKey('mission', slot.id))?.epoch === slot.epoch) this.store.delete(slotKey('mission', slot.id));
    }
    const second = claim();
    if (second === undefined) throw capacityError('mission');
    return second;
  }

  releaseMissionSlot(missionId: string, epoch: number): void {
    const slot = this.store.get<CapacitySlot>(slotKey('mission', missionId));
    if (slot && (slot.epoch === undefined || slot.epoch <= epoch)) this.store.delete(slotKey('mission', missionId));
  }

  reservePreviewSlot(missionId: string, expiresAt: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const slots = liveSlots(this.store, 'preview');
      if (slots.some((slot) => slot.id === missionId)) return false;
      if (slots.length >= WORKSPACE_PREVIEW_LIMIT) throw capacityError('preview');
      this.store.put(slotKey('preview', missionId), { id: missionId, expiresAt } satisfies CapacitySlot);
      return true;
    });
  }

  holdPreviewSlot(missionId: string, expiresAt: number): void {
    this.store.put(slotKey('preview', missionId), { id: missionId, expiresAt } satisfies CapacitySlot);
  }

  releasePreviewSlot(missionId: string): void { this.store.delete(slotKey('preview', missionId)); }

  deployState(): DeployState { return new DeploymentLedger(this.store).state(); }

  saveDeploySettings(settings: DeploySettings): DeploySettings { return new DeploymentLedger(this.store).saveSettings(settings); }

  getDeployment(id: string): DeploymentRecord | undefined { return new DeploymentLedger(this.store).get(id); }

  createDeployment(key: string, fingerprint: string, record: DeploymentRecord): DeploymentRecord {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).create(key, fingerprint, record));
  }

  confirmDeployment(id: string, actorId: string): DeploymentRecord {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).confirm(id, actorId));
  }

  updateDeployment(id: string, expected: DeploymentStatus[], patch: Partial<DeploymentRecord>): DeploymentRecord | null {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).update(id, expected, patch));
  }
}
