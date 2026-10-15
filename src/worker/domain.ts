import { MAX_MISSION_AGENTS } from '../shared/mission-draft';
import { repositoryLabel } from '../shared/repository-names';
import type { CreateMissionInput, Repository } from '../shared/types';
import { validateAttachments } from './mission-context';
import { modelIdentifier } from './model-config';

export const MISSION_REQUEST_MAX_BYTES = 262_144;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly detail: string) {
    super(`GITFLARE:${status}:${code}:${detail}`);
    this.name = 'ApiError';
  }
}

export function publicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.detail };
  if (error instanceof Error) {
    const match = /^GITFLARE:(4\d\d|5\d\d):([A-Z_]+):(.+)$/s.exec(error.message);
    if (match) return { status: Number(match[1]), code: match[2], message: match[3] };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'The request could not be completed. Please try again.' };
}

export function requireString(value: unknown, field: string, maxLength: number, minLength = 1): string {
  if (typeof value !== 'string' || value.trim().length < minLength || value.trim().length > maxLength) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} must contain between ${minLength} and ${maxLength} characters.`);
  }
  return value.trim();
}

export function agentRunIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 10 || value.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id))) throw new ApiError(400, 'INVALID_INPUT', 'runIds must be a list of at most 10 agent IDs from this mission.');
  return [...new Set(value as string[])];
}

export function repositoryName(value: unknown): string {
  const name = requireString(value, 'Repository name', 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith('.git')) {
    throw new ApiError(400, 'INVALID_REPOSITORY_NAME', 'Use letters, numbers, dots, hyphens, or underscores. Do not include the .git suffix.');
  }
  return name;
}

const ISOLATED_SUFFIX_MAX = 29;
const ISOLATED_STEM = 20;

function isolatedPrefix(workspaceId: string): string { return `w-${workspaceId.replace(/-/g, '')}-`; }

export async function storageRepositoryName(workspaceId: string, name: string): Promise<string> {
  if (workspaceId === 'legacy') return name;
  if (name.length <= ISOLATED_SUFFIX_MAX) return repositoryName(isolatedPrefix(workspaceId) + name);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.toLowerCase())));
  const tag = Array.from(digest.subarray(0, 4), byte => byte.toString(16).padStart(2, '0')).join('');
  return repositoryName(`${isolatedPrefix(workspaceId)}${name.slice(0, ISOLATED_STEM)}-${tag}`);
}

export function findRepositoryByName<T extends Pick<Repository, 'name' | 'displayName'>>(repositories: T[], workspaceId: string, name: string): T | undefined {
  return repositories.find(item => item.name === name)
    ?? repositories.find(item => repositoryLabel(item) === name)
    ?? (workspaceId === 'legacy' ? undefined : repositories.find(item => !item.displayName && item.name === `${isolatedPrefix(workspaceId)}${name.slice(0, ISOLATED_SUFFIX_MAX)}`));
}

export function repositoryPath(value: string, allowRoot = true): string {
  if ((!value && !allowRoot) || value.length > 2000 || value.split('/').length > 32 || /[\\\u0000-\u001f\u007f]/.test(value) || (value && value.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new ApiError(400, 'INVALID_PATH', 'Use a repository-relative path without empty segments or parent traversal.');
  }
  return value;
}

export function repositoryRef(value: string): string {
  if (!value || value.length > 200 || !/^[a-zA-Z0-9/_\-.]+$/.test(value) || value.includes('..') || value.startsWith('-')) {
    throw new ApiError(400, 'INVALID_REF', 'Use a branch name, tag, or full commit SHA.');
  }
  return value;
}

export function missionInput(body: Record<string, unknown>): CreateMissionInput {
  if (body.skillChange !== undefined) throw new ApiError(400, 'SKILL_ENDPOINT_REQUIRED', 'Create skill proposals through the repository Skills endpoint.');
  const input: CreateMissionInput = { title: requireString(body.title, 'Title', 120), prompt: requireString(body.prompt, 'Prompt', 8000, 10), repositoryId: requireString(body.repositoryId, 'Repository', 100) };
  if (body.expectedBaseSha !== undefined) {
    if (typeof body.expectedBaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(body.expectedBaseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Provide the exact lowercase 40 character proposal base commit SHA.');
    input.expectedBaseSha = body.expectedBaseSha;
  }
  if (body.acceptanceCriteria !== undefined) {
    if (!Array.isArray(body.acceptanceCriteria) || body.acceptanceCriteria.length > 12) throw new ApiError(400, 'INVALID_CRITERIA', 'Provide up to 12 acceptance criteria.');
    input.acceptanceCriteria = body.acceptanceCriteria.map((criterion) => requireString(criterion, 'Acceptance criterion', 500));
  }
  if (body.attachments !== undefined) {
    const attachments = validateAttachments(body.attachments, (message) => { throw new ApiError(400, 'INVALID_ATTACHMENTS', message); });
    if (attachments.length) input.attachments = attachments;
  }
  if (body.issueNumber !== undefined) {
    if (!Number.isInteger(body.issueNumber) || (body.issueNumber as number) < 1 || (body.issueNumber as number) > 5_000) throw new ApiError(400, 'INVALID_ISSUE_NUMBER', 'Provide a valid issue number.');
    input.issueNumber = body.issueNumber as number;
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'combine' && body.mode !== 'race') throw new ApiError(400, 'INVALID_MODE', 'Choose combine or race.');
    input.mode = body.mode;
  }
  if (body.tasks !== undefined) {
    if (!Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > MAX_MISSION_AGENTS) throw new ApiError(400, 'INVALID_TASKS', `Assign between one and ${MAX_MISSION_AGENTS} agent tasks.`);
    input.tasks = body.tasks.map((task: unknown) => {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new ApiError(400, 'INVALID_TASKS', 'Each task must include a name, role, and task description.');
      const fields = task as Record<string, unknown>;
      return { name: requireString(fields.name, 'Agent name', 60), role: requireString(fields.role, 'Agent role', 80), task: requireString(fields.task, 'Agent task', 2500, 10), ...(fields.model === undefined ? {} : { model: modelIdentifier(fields.model) }) };
    });
    if (new Set(input.tasks.map(task => task.name.toLowerCase())).size !== input.tasks.length) throw new ApiError(400, 'INVALID_TASKS', 'Give each agent a distinct name.');
  }
  return input;
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get('Idempotency-Key');
  if (!value || !/^[a-zA-Z0-9_-]{16,128}$/.test(value)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Include an Idempotency-Key containing 16–128 letters, numbers, hyphens, or underscores.');
  }
  return value;
}

export function assertMutationOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== new URL(request.url).origin) || fetchSite === 'cross-site') {
    throw new ApiError(403, 'ORIGIN_REJECTED', 'Requests must originate from this application.');
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'JSON_REQUIRED', 'Send this request as application/json.');
  }
}

export function isLocalRequest(request: Request, appEnv: string | undefined): boolean {
  return appEnv === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
}

export async function readJson(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_JSON', 'A JSON object is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, 'REQUEST_TOO_LARGE', `Requests must not exceed ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'A valid JSON object is required.');
  }
}

export function assertActiveRun(status: string, expectedEpoch: number, epoch: number): void {
  if (expectedEpoch !== epoch || !['queued', 'running', 'checking'].includes(status)) {
    throw new ApiError(409, 'STALE_EXECUTION', 'This result belongs to a cancelled or superseded run.');
  }
}

export function assertApproval(input: {
  status: string;
  candidateSha: string | null | undefined;
  baseSha: string | null | undefined;
  currentHead: string | null | undefined;
  requestedCandidate: string;
  requestedBase: string;
  checksPassed: boolean;
}): void {
  if (input.status !== 'needs_review') {
    throw new ApiError(409, 'NOT_READY', 'This mission is not ready for review.');
  }
  if (!input.checksPassed) throw new ApiError(409, 'CHECKS_REQUIRED', 'All required checks must pass before approval.');
  if (!input.candidateSha || !input.baseSha || input.requestedCandidate !== input.candidateSha || input.requestedBase !== input.baseSha || input.currentHead !== input.baseSha) {
    throw new ApiError(409, 'STALE_APPROVAL', 'The candidate or repository changed. Refresh and review the current commit.');
  }
}

export function assertReplayFingerprint(stored: string, incoming: string): void {
  if (stored !== incoming) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request key has already been used for a different action.');
}
