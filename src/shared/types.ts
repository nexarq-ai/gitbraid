export type MissionStatus = 'draft' | 'queued' | 'running' | 'checking' | 'needs_review' | 'approved' | 'integrating' | 'integrated' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type MissionMode = 'combine' | 'race';
export type CheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Repository {
  workspaceId?: string;
  id: string;
  name: string;
  displayName?: string;
  description: string;
  defaultBranch: string;
  headSha: string | null;
  provider: 'artifacts' | 'local';
  remote?: string;
  urlImport?: RepositoryUrlImport;
  createdAt: string;
  updatedAt: string;
}

export type UrlImportPhase = 'queued' | 'preparing' | 'fetching' | 'verifying' | 'pushing' | 'complete';
export interface RepositoryUrlImport {
  source: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'codeberg' | 'https';
  status: 'importing' | 'ready' | 'failed';
  phase: UrlImportPhase;
  attempt: number;
  requestId: string;
  authenticated: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  branches?: number;
  tags?: number;
  packBytes?: number;
  error?: { code: string; message: string };
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AgentUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unreportedCalls: number;
}

export type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
export interface DependencyChange { section: DependencySection; name: string; change: 'added' | 'removed' | 'changed'; from?: string; to?: string }
export interface ManifestDependencyChanges { path: string; changes: DependencyChange[] }
export interface DependencyApproval { approvedBy: string; approvedAt: string; candidateSha: string; baseSha: string; epoch: number }

export interface AgentRun {
  id: string;
  name: string;
  role: string;
  task: string;
  assignment?: string;
  status: RunStatus;
  forkName?: string;
  branch?: string;
  commitSha?: string;
  startedAt?: string;
  completedAt?: string;
  changedFiles: string[];
  touchedFiles?: string[];
  note?: string;
  summary?: string;
  error?: string;
  model?: string;
  modelConfig?: ModelConnection;
  skills?: { name: string; path: string; commitSha: string; sha256: string }[];
  usage?: AgentUsage;
  skillWarnings?: string[];
  reusedFromEpoch?: number;
  candidateBaseSha?: string;
  skipReason?: string;
  dependencyChanges?: ManifestDependencyChanges[];
  retryGuidance?: string;
  collision?: { files: string[]; epoch: number };
  startFrom?: { reason: 'collision' | 'review'; files?: string[]; candidates: { runId: string; name: string; forkName: string; commitSha: string }[] };
}

export type RunnerSize = 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4';
export type CheckLimitSource = 'owner' | 'gitflare.json' | 'repository' | 'learned' | 'auto' | 'default';

export interface CheckTimeout {
  seconds: number;
  runner: RunnerSize;
  timeoutSource: CheckLimitSource;
  runnerSource: CheckLimitSource;
}

export interface AutoIncrease {
  enabled: boolean;
  maxTimeoutSeconds: number;
  maxRunner: RunnerSize;
}

export interface CheckSettings {
  testTimeoutSeconds?: number;
  runner?: RunnerSize;
  autoIncrease?: AutoIncrease;
  updatedAt?: string;
  updatedBy?: string;
}

export interface CheckOverride {
  testTimeoutSeconds?: number;
  runner?: RunnerSize;
  actorId: string;
  at: string;
}

export interface CheckPlan extends CheckSettings {
  learnedTimeoutSeconds?: number;
  override?: CheckOverride;
}

export interface RepositoryCheckSettings extends CheckSettings {
  repositoryId: string;
  autoIncrease: AutoIncrease;
  history: { samples: number; p90Seconds?: number; learnedTimeoutSeconds?: number };
  limits: { minTimeoutSeconds: number; maxTimeoutSeconds: number; runners: RunnerSize[] };
}

export interface Check {
  id: string;
  name: string;
  runId?: string;
  status: CheckStatus;
  candidateSha?: string;
  output?: string;
  durationMs?: number;
  timeout?: CheckTimeout;
  escalatedFrom?: CheckTimeout;
}

export interface MissionEvent {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  runId?: string;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  runIds: string[];
}

export interface ProposalReview {
  id: string;
  kind: 'comment' | 'request_changes';
  body: string;
  authorId: string;
  createdAt: string;
  epoch: number;
  candidateSha: string;
  baseSha: string;
  resolvedAt?: string;
  resolvedBy?: string;
  path?: string;
  line?: number;
  side?: 'old' | 'new';
}

export interface ReviewMissionInput {
  action: 'comment' | 'request_changes' | 'resolve';
  epoch: number;
  candidateSha: string;
  baseSha: string;
  body?: string;
  reviewId?: string;
  path?: string;
  line?: number;
  side?: 'old' | 'new';
}

export interface MissionAttachment { name: string; content: string }

export interface Mission {
  attachments?: MissionAttachment[];
  skillChange?: RepositorySkillChange;
  revertChange?: RevertChange;
  branchChange?: BranchChange;
  issueNumber?: number;
  authorization?: { principal: import('../worker/security').Principal; workspaceId: string; creatorId: string };
  id: string;
  repositoryId: string;
  title: string;
  prompt: string;
  status: MissionStatus;
  baseSha: string | null;
  candidateSha: string | null;
  mode?: MissionMode;
  selectedRunId?: string;
  raceChecks?: Check[];
  raceChanges?: FileChange[];
  acceptanceCriteria?: string[];
  integrationForkName?: string;
  epoch: number;
  runs: AgentRun[];
  checks: Check[];
  events: MissionEvent[];
  changes: FileChange[];
  reviews?: ProposalReview[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  dependencyChanges?: ManifestDependencyChanges[];
  dependencyApproval?: DependencyApproval;
  error?: string;
}

export type AgentRunSummary = Omit<AgentRun, 'task' | 'modelConfig' | 'skills' | 'skillWarnings' | 'usage'> & { assignment: string };
export type CheckSummary = Omit<Check, 'output'>;

export interface MissionSummary extends Omit<Mission, 'attachments' | 'authorization' | 'skillChange' | 'raceChecks' | 'raceChanges' | 'runs' | 'checks' | 'changes' | 'events' | 'reviews'> {
  runs: AgentRunSummary[];
  checks: CheckSummary[];
  events: MissionEvent[];
  skillChange?: Omit<RepositorySkillChange, 'content'>;
  changeCount: number;
  additions: number;
  deletions: number;
  eventCount: number;
  reviewCount: number;
  openChangeRequests: number;
  attachmentCount: number;
}

export interface MissionAttempt {
  id: string;
  epoch: number;
  recordedAt: string;
  reason: 'completed' | 'retry' | 'cancelled' | 'approved' | 'approval_revoked' | 'integration_failed' | 'integration_uncertain' | 'integrated';
  snapshot: Mission;
}

export interface IntegrationStatus {
  id: 'artifacts' | 'sandbox' | 'model' | 'auth';
  name: string;
  ready: boolean;
  detail: string;
}

export interface Workspace {
  name: string;
  mode: 'local' | 'connected';
  repositories: Repository[];
  missions: MissionSummary[];
  integrations: IntegrationStatus[];
  ai?: AiSettings;
}

export interface AiSettings { enabled: boolean; locked: boolean }

export interface AgentTask { name: string; role: string; task: string; model?: string }
export interface RevertChange { missionId: string; title: string; landedSha: string; previousSha: string }
export interface BranchChange { branch: string; headSha: string; targetBranch: string; description?: string; closedAt?: string; closedBy?: string }
export type PullRequestState = 'open' | 'needs_review' | 'approved' | 'landed' | 'closed';
export type LanderRole = 'Maintainer' | 'Owner';
export interface BranchRule { pattern: string; requirePullRequest: boolean; requiredApprovals: number; requirePassingChecks: true; requiredCheckNames: string[]; preventSelfApproval: boolean; dismissApprovalsOnNewCommits: true; restrictLanders: LanderRole[]; allowForcePush: false }
export type BranchRuleInput = Pick<BranchRule, 'pattern' | 'requirePullRequest' | 'requiredApprovals' | 'requiredCheckNames' | 'preventSelfApproval' | 'restrictLanders'>;
export interface BranchProtection { repositoryId: string; defaultBranch: string; rules: BranchRule[]; configured: boolean; updatedAt?: string; updatedBy?: string }
export interface BranchInfo { name: string; headSha: string; protected: boolean; default: boolean; ahead?: number; behind?: number }
export interface BranchChangeResult { name: string; headSha: string; created?: true; deleted?: true }
export interface BranchList { repositoryId: string; defaultBranch: string; gitUrl: string; branches: BranchInfo[] }
export interface CreatePullRequestInput { title: string; description?: string; branch: string }
export interface RepositorySkillChange { action: 'create' | 'update'; path: string; content: string; baseSha: string }
export interface CreateMissionInput { attachments?: MissionAttachment[]; title: string; prompt: string; repositoryId: string; acceptanceCriteria?: string[]; tasks?: AgentTask[]; skillChange?: RepositorySkillChange; revertChange?: RevertChange; branchChange?: BranchChange; issueNumber?: number; expectedBaseSha?: string; mode?: MissionMode }
export interface CreateRepositoryInput { name: string; description?: string }
export interface ApproveMissionInput { candidateSha: string; baseSha: string }
export interface ApiError { error: { code: string; message: string } }

export interface RepositoryTree { entries: { name: string; path: string; type: 'file' | 'directory'; size?: number }[]; ref: string; commitSha: string }
export interface RepositoryFile { path: string; content: string; commitSha: string }

export type AccessSnapshot = Awaited<ReturnType<import('../worker/security').SecurityService['snapshot']>>;
export type WorkspaceRole = import('../worker/security').Role;

export interface ProjectResource {
  type: 'worker' | 'd1' | 'durable_object' | 'container' | 'workflow';
  id: string;
  name: string;
  environment: string;
}

export interface ModelConnection {
  id: string;
  label: string;
  source: 'gateway' | 'workers-ai';
  protocol: 'responses' | 'chat' | 'anthropic' | 'workers-ai';
  verification?: { status: 'verified' | 'failed'; checkedAt: string; detail: string };
}

export type AiKeyProvider = 'openai' | 'anthropic' | 'google-ai-studio' | 'groq' | 'mistral' | 'deepseek' | 'grok';
export interface AiKeySummary { provider: AiKeyProvider; last4: string; addedBy: string; addedAt: string; verifiedModel: string }
export interface AiGatewaySummary { accountId: string; gatewayId: string; authenticated: boolean; tokenLast4?: string; updatedBy: string; updatedAt: string }
export interface AiKeysSnapshot {
  providers: { id: AiKeyProvider; label: string }[];
  keys: AiKeySummary[];
  gateway: AiGatewaySummary | null;
  operatorAccess: boolean;
  ready: boolean;
  verification?: { provider: AiKeyProvider; model: string; detail: string };
}

export interface ModelConnectionsSnapshot {
  gateway: { id: string | null; configured: boolean };
  workersAI: { enabled: boolean };
  models: ModelConnection[];
  workersAICatalog: ModelConnection[];
  discovery: 'manual';
}

export type IssueState = 'open' | 'closed';
export type IssueCloseReason = 'completed' | 'not_planned';
export interface IssueComment { id: string; authorId: string; body: string; createdAt: string; editedAt?: string }
export interface Issue { repositoryId: string; number: number; title: string; body: string; state: IssueState; closedReason?: IssueCloseReason; labels: string[]; assignees: string[]; missionIds: string[]; authorId: string; createdAt: string; updatedAt: string; closedAt?: string; commentCount: number }
export interface IssueDetail extends Issue { comments: IssueComment[] }
export interface IssueList { items: Issue[]; total: number; openCount: number; closedCount: number; labels: string[]; offset: number; nextOffset: number | null }
export interface Release {
  id: string;
  repositoryId: string;
  tag: string;
  name: string;
  notes: string;
  targetSha: string;
  draft: boolean;
  prerelease: boolean;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface ReleaseList {
  releases: Release[];
  defaultBranch: string;
  headSha: string | null;
  commits: { sha: string; message: string }[];
  limit: number;
}

export interface ReleaseNotes { markdown: string; targetSha: string; previousTag: string | null; commitCount: number; missionCount: number; truncated: boolean }
