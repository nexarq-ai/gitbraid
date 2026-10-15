import type { Mission, PullRequestState } from './types';

export function pullRequestState(mission: Pick<Mission, 'status' | 'branchChange'>): PullRequestState {
  if (mission.branchChange?.closedAt) return 'closed';
  if (mission.status === 'integrated') return 'landed';
  if (mission.status === 'approved' || mission.status === 'integrating') return 'approved';
  if (mission.status === 'needs_review') return 'needs_review';
  return 'open';
}
