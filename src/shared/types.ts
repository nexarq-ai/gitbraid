export type MissionStatus = 'draft' | 'queued' | 'running' | 'checking' | 'needs_review' | 'approved' | 'integrating' | 'integrated' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
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
  summary?: string;
  error?: string;
  model?: string;
}

export interface Check {
  id: string;
  name: string;
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

export interface Mission {
  authorization?: { principal: import('../worker/security').Principal; workspaceId: string; creatorId: string };
  id: string;
  repositoryId: string;
  title: string;
  prompt: string;
  status: MissionStatus;
  baseSha: string | null;
  candidateSha: string | null;
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

export interface AgentTask { name: string; role: string; task: string }
export interface CreateMissionInput { title: string; prompt: string; repositoryId: string; acceptanceCriteria?: string[]; tasks?: AgentTask[] }
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
