import type { AgentTask, ModelConnection } from './types';

export const DRAFT_GOAL_MIN = 10;
export const DRAFT_GOAL_MAX = 4000;
export const MISSION_PROMPT_MAX = 8000;
export const MAX_MISSION_AGENTS = 10;

export interface MissionDraftResult { title: string; acceptanceCriteria: string[]; tasks: AgentTask[]; warnings?: string[] }
export interface DraftRequestState { repositoryId: string; goal: string }

export function draftGoalProblem(goal: string): string | null {
  const length = goal.trim().length;
  if (length < DRAFT_GOAL_MIN) return `Describe the goal in at least ${DRAFT_GOAL_MIN} characters to draft with AI.`;
  if (length > DRAFT_GOAL_MAX) return `Drafting with AI accepts goals up to ${DRAFT_GOAL_MAX.toLocaleString('en-US')} characters (this one has ${length.toLocaleString('en-US')}). Shorten it, or fill the fields yourself: missions accept up to ${MISSION_PROMPT_MAX.toLocaleString('en-US')}.`;
  return null;
}

export function draftIsStale(requested: DraftRequestState, latest: DraftRequestState): boolean {
  return requested.repositoryId !== latest.repositoryId || requested.goal.trim() !== latest.goal.trim();
}

export function fillBlank(current: string, drafted: string): string {
  return current.trim() ? current : drafted;
}

export function mergeDraftAgents<T extends AgentTask & { id: string }>(current: T[], tasks: AgentTask[], requestedIds: string[]): T[] {
  return current.map(agent => {
    const drafted = tasks[requestedIds.indexOf(agent.id)];
    if (!drafted) return agent;
    return { ...agent, name: fillBlank(agent.name, drafted.name), role: fillBlank(agent.role, drafted.role), task: fillBlank(agent.task, drafted.task) };
  });
}

export function modelVerificationLabel(model: ModelConnection): string {
  if (model.verification?.status === 'verified') return 'Verified';
  if (model.verification?.status === 'failed') return 'Verification failed';
  return 'Not verified';
}

export function modelOptionLabel(model: ModelConnection): string {
  return `${model.label}${model.source === 'workers-ai' ? ' · Workers AI' : ''} · ${modelVerificationLabel(model)}`;
}

export function modelVerificationNote(model: ModelConnection): string {
  if (!model.verification) return 'This model has not been verified. Its first use is the first inference check.';
  const checked = Number.isNaN(Date.parse(model.verification.checkedAt)) ? model.verification.checkedAt : new Date(model.verification.checkedAt).toLocaleString();
  if (model.verification.status === 'failed') return `The last verification failed (${checked}): ${model.verification.detail} This may have changed since; verify it again in AI model settings before relying on it.`;
  return `Text inference verified ${checked}.`;
}
