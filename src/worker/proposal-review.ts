import type { Mission, ReviewMissionInput } from '../shared/types';
import { ApiError, requireString } from './domain';

export function reviewMissionInput(body: Record<string, unknown>): ReviewMissionInput {
  if (!['comment', 'request_changes', 'resolve'].includes(String(body.action))) throw new ApiError(400, 'INVALID_REVIEW', 'Choose a comment, request changes, or resolve a review.');
  if (!Number.isSafeInteger(body.epoch) || Number(body.epoch) < 1) throw new ApiError(400, 'INVALID_REVIEW', 'An exact execution attempt is required.');
  const candidateSha = requireString(body.candidateSha, 'Candidate commit', 40, 40);
  const baseSha = requireString(body.baseSha, 'Base commit', 40, 40);
  if (!/^[a-f0-9]{40}$/.test(candidateSha) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
  const action = body.action as ReviewMissionInput['action'];
  return { action, epoch: Number(body.epoch), candidateSha, baseSha, ...(action === 'resolve' ? { reviewId: requireString(body.reviewId, 'Review', 100) } : { body: requireString(body.body, 'Review message', 8000) }) };
}

export function currentReviewRequests(mission: Mission) {
  return (mission.reviews ?? []).filter((review) => review.kind === 'request_changes' && !review.resolvedAt && review.epoch === mission.epoch && review.candidateSha === mission.candidateSha && review.baseSha === mission.baseSha);
}

export function assertReviewClear(mission: Mission): void {
  if (currentReviewRequests(mission).length) throw new ApiError(409, 'CHANGES_REQUESTED', 'Resolve the current reviewer requests before approving or landing this candidate.');
}
