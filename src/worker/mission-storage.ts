import { createHash } from 'node:crypto';
import type { Mission, MissionSummary } from '../shared/types';
import { ApiError } from './domain';
import { currentReviewRequests } from './proposal-review';

export const MISSION_BLOB_MIN_CHARS = 256;
const SUMMARY_EVENTS = 20;
const SUMMARY_TEXT = 600;

interface BlobRef { $blob: string }
export interface BlobStore { get(key: string): string | undefined; putIfAbsent(key: string, value: string): void }

const itemFields = [['changes', 'patch'], ['raceChanges', 'patch'], ['checks', 'output'], ['raceChecks', 'output'], ['reviews', 'body'], ['attachments', 'content'], ['runs', 'task']] as const;
type Item = Record<string, unknown>;

export const missionBlobKey = (missionId: string, hash: string) => `mission-blob:${missionId}:${hash}`;
const isRef = (value: unknown): value is BlobRef => !!value && typeof value === 'object' && typeof (value as BlobRef).$blob === 'string';
const large = (value: unknown): value is string => typeof value === 'string' && value.length >= MISSION_BLOB_MIN_CHARS;

function mapFields(mission: Mission, transform: (value: unknown) => unknown): Mission {
  const copy = { ...mission } as unknown as Record<string, unknown>;
  for (const [list, field] of itemFields) {
    const items = copy[list];
    if (Array.isArray(items)) copy[list] = items.map((item: Item) => field in item ? { ...item, [field]: transform(item[field]) } : item);
  }
  if (mission.skillChange) copy.skillChange = { ...mission.skillChange, content: transform(mission.skillChange.content) };
  return copy as unknown as Mission;
}

function someField(mission: Mission, test: (value: unknown) => boolean): boolean {
  let found = false;
  mapFields(mission, (value) => { found ||= test(value); return value; });
  return found;
}

export function packMission(mission: Mission, blobs: BlobStore): Mission {
  return mapFields(mission, (value) => {
    if (!large(value)) return value;
    const hash = createHash('sha256').update(value).digest('hex');
    blobs.putIfAbsent(missionBlobKey(mission.id, hash), value);
    return { $blob: hash } satisfies BlobRef;
  });
}

export function unpackMission(stored: Mission, blobs: BlobStore): Mission {
  if (!someField(stored, isRef)) return stored;
  return mapFields(stored, (value) => {
    if (!isRef(value)) return value;
    const content = blobs.get(missionBlobKey(stored.id, value.$blob));
    if (content === undefined) throw new ApiError(500, 'MISSION_STORAGE_INCONSISTENT', 'Part of this mission record is missing. Its stored evidence was not changed.');
    return content;
  });
}

export const needsPacking = (stored: Mission) => someField(stored, large);

const text = (value: unknown) => typeof value === 'string' ? value.slice(0, SUMMARY_TEXT) : '';

export function summarizeMission(mission: Mission): MissionSummary {
  const { attachments, authorization: _authorization, skillChange, raceChecks: _raceChecks, raceChanges: _raceChanges, runs, checks, changes, events, reviews, prompt, ...rest } = mission;
  return {
    ...rest,
    prompt: text(prompt),
    ...(skillChange ? { skillChange: { action: skillChange.action, path: skillChange.path, baseSha: skillChange.baseSha } } : {}),
    runs: runs.map(({ task, modelConfig: _modelConfig, skills: _skills, skillWarnings: _skillWarnings, usage: _usage, assignment, summary, ...run }) => ({ ...run, assignment: text(assignment ?? task), ...(summary !== undefined ? { summary: text(summary) } : {}) })),
    checks: checks.map(({ output: _output, ...check }) => check),
    events: events.slice(-SUMMARY_EVENTS),
    changeCount: changes.length,
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
    eventCount: events.length,
    reviewCount: reviews?.length ?? 0,
    openChangeRequests: currentReviewRequests(mission).length,
    attachmentCount: attachments?.length ?? 0,
  };
}
