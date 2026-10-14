export type MissionStatus = 'draft' | 'queued' | 'running' | 'checking' | 'needs_review' | 'approved' | 'integrating' | 'integrated' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type MissionMode = 'combine' | 'race';
export type CheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Repository {
  workspaceId?: string;
  id: string;
  name: string;
  description: string;
  defaultBranch: string;
  headSha: string | null;
  provider: 'artifacts' | 'local';
  remote?: string;
  createdAt: string;
  updatedAt: string;
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
}

export interface Check {
  id: string;
  name: string;
  runId?: string;
  status: CheckStatus;
  candidateSha?: string;
  output?: string;
  durationMs?: number;
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
}

export interface ReviewMissionInput {
  action: 'comment' | 'request_changes' | 'resolve';
  epoch: number;
  candidateSha: string;
  baseSha: string;
  body?: string;
  reviewId?: string;
}

export interface MissionAttachment { name: string; content: string }

export interface Mission {
  attachments?: MissionAttachment[];
  skillChange?: RepositorySkillChange;
  revertChange?: RevertChange;
  branchChange?: BranchChange;
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
  error?: string;
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
  missions: Mission[];
  integrations: IntegrationStatus[];
}

export interface AgentTask { name: string; role: string; task: string; model?: string }
export interface RevertChange { missionId: string; title: string; landedSha: string; previousSha: string }
export interface BranchChange { branch: string; headSha: string; targetBranch: string; description?: string; closedAt?: string; closedBy?: string }
export type PullRequestState = 'open' | 'needs_review' | 'approved' | 'landed' | 'closed';
export type LanderRole = 'Maintainer' | 'Owner';
export interface BranchRule { pattern: string; requirePullRequest: boolean; requiredApprovals: number; requirePassingChecks: true; requiredCheckNames: string[]; preventSelfApproval: boolean; dismissApprovalsOnNewCommits: true; restrictLanders: LanderRole[]; allowForcePush: false }
export type BranchRuleInput = Pick<BranchRule, 'pattern' | 'requirePullRequest' | 'requiredApprovals' | 'requiredCheckNames' | 'preventSelfApproval' | 'restrictLanders'>;
export interface BranchProtection { repositoryId: string; defaultBranch: string; rules: BranchRule[]; configured: boolean; updatedAt?: string; updatedBy?: string }
export interface BranchInfo { name: string; headSha: string; protected: boolean; default: boolean; ahead?: number; behind?: number }
export interface BranchList { repositoryId: string; defaultBranch: string; gitUrl: string; branches: BranchInfo[] }
export interface CreatePullRequestInput { title: string; description?: string; branch: string }
export interface RepositorySkillChange { action: 'create' | 'update'; path: string; content: string; baseSha: string }
export interface CreateMissionInput { attachments?: MissionAttachment[]; title: string; prompt: string; repositoryId: string; acceptanceCriteria?: string[]; tasks?: AgentTask[]; skillChange?: RepositorySkillChange; revertChange?: RevertChange; branchChange?: BranchChange; expectedBaseSha?: string; mode?: MissionMode }
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

export interface ModelConnectionsSnapshot {
  gateway: { id: string | null; configured: boolean };
  workersAI: { enabled: boolean };
  models: ModelConnection[];
  workersAICatalog: ModelConnection[];
  discovery: 'manual';
}
