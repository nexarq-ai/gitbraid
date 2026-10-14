import type { Issue, IssueCloseReason, IssueComment, IssueDetail, IssueList, IssueState, Repository } from '../shared/types';
import { ApiError, assertMutationOrigin, publicError, readJson, requireIdempotencyKey, requireString } from './domain';
import type { Action, Principal } from './security';

export const ISSUE_LIMIT = 5_000;
export const ISSUE_COMMENT_LIMIT = 500;
export const ISSUE_REQUEST_MAX_BYTES = 131_072;
export const ISSUE_BODY_MAX = 20_000;
export const ISSUE_COMMENT_MAX = 10_000;
const PAGE_LIMIT = 50;
const identifier = /^[a-zA-Z0-9-]{1,100}$/;

export interface IssueStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; list<T>(prefix: string): T[] }
export interface IssueActor { userId: string; moderator: boolean }
export interface IssueQuery { state?: IssueState | 'all'; label?: string; q?: string; offset?: number; limit?: number }
export type IssueChange =
  | { action: 'create'; repositoryId: string; title: string; body: string; labels: string[]; assignees: string[]; missionIds: string[] }
  | { action: 'comment'; number: number; body: string; commentId?: string }
  | { action: 'update'; number: number; title?: string; body?: string; labels?: string[]; assignees?: string[]; missionIds?: string[] }
  | { action: 'close'; number: number; reason: IssueCloseReason }
  | { action: 'reopen'; number: number };
export type IssueAction = IssueChange['action'];

const pad = (value: number) => String(value).padStart(6, '0');
const issueKey = (number: number) => `issue:${pad(number)}`;
const commentPrefix = (number: number) => `issue-comment:${pad(number)}:`;

function text(value: unknown, field: string, max: number, min = 0): string {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field} must be text.`);
  if (value.trim().length < min || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field} must contain between ${min} and ${max} characters.`);
  return min ? value.trim() : value;
}

function list(value: unknown, field: string, max: number, item: (entry: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field} must be a list of at most ${max} entries.`);
  const seen = new Set<string>(), result: string[] = [];
  for (const entry of value) { const normalized = item(entry); if (!seen.has(normalized.toLowerCase())) { seen.add(normalized.toLowerCase()); result.push(normalized); } }
  return result;
}

export function issueLabels(value: unknown): string[] {
  return list(value, 'Labels', 10, (entry) => {
    if (typeof entry !== 'string') throw new ApiError(400, 'INVALID_LABEL', 'Labels must be text.');
    const label = entry.trim().replace(/\s+/g, ' ');
    if (!label || label.length > 40 || /[\u0000-\u001f\u007f,]/.test(label)) throw new ApiError(400, 'INVALID_LABEL', 'Each label must contain 1 to 40 characters without commas.');
    return label;
  });
}

function identifiers(value: unknown, field: string, max: number): string[] {
  return list(value, field, max, (entry) => { if (typeof entry !== 'string' || !identifier.test(entry)) throw new ApiError(400, 'INVALID_INPUT', `${field} must contain valid identifiers.`); return entry; });
}

export function issueNumber(value: unknown): number {
  const number = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > ISSUE_LIMIT) throw new ApiError(400, 'INVALID_ISSUE_NUMBER', 'Provide a valid issue number.');
  return number as number;
}

export function parseIssueChange(action: IssueAction, body: Record<string, unknown>, context: { repositoryId: string; number?: number }): IssueChange {
  if (action === 'create') return {
    action, repositoryId: context.repositoryId, title: text(body.title, 'Title', 200, 1), body: text(body.body, 'Description', ISSUE_BODY_MAX),
    labels: body.labels === undefined ? [] : issueLabels(body.labels), assignees: body.assignees === undefined ? [] : identifiers(body.assignees, 'Assignees', 10), missionIds: body.missionIds === undefined ? [] : identifiers(body.missionIds, 'Linked missions', 20),
  };
  const number = issueNumber(context.number);
  if (action === 'comment') return { action, number, body: text(body.body, 'Comment', ISSUE_COMMENT_MAX, 1), ...(body.commentId === undefined ? {} : { commentId: requireString(body.commentId, 'Comment', 100) }) };
  if (action === 'close') {
    const reason = body.reason ?? 'completed';
    if (reason !== 'completed' && reason !== 'not_planned') throw new ApiError(400, 'INVALID_CLOSE_REASON', 'Close as completed or not planned.');
    return { action, number, reason };
  }
  if (action === 'reopen') return { action, number };
  const change: IssueChange = {
    action, number,
    ...(body.title === undefined ? {} : { title: text(body.title, 'Title', 200, 1) }),
    ...(body.body === undefined ? {} : { body: text(body.body, 'Description', ISSUE_BODY_MAX) }),
    ...(body.labels === undefined ? {} : { labels: issueLabels(body.labels) }),
    ...(body.assignees === undefined ? {} : { assignees: identifiers(body.assignees, 'Assignees', 10) }),
    ...(body.missionIds === undefined ? {} : { missionIds: identifiers(body.missionIds, 'Linked missions', 20) }),
  };
  if (Object.keys(change).length === 2) throw new ApiError(400, 'EMPTY_ISSUE_UPDATE', 'Change the title, description, labels, assignees, or linked missions.');
  return change;
}

export function requiresModeration(change: IssueChange, issue: Issue | undefined, userId: string): boolean {
  if (change.action === 'create') return change.labels.length > 0 || change.assignees.length > 0;
  if (change.action === 'comment') return false;
  if (change.action === 'close' || change.action === 'reopen') return true;
  return change.labels !== undefined || change.assignees !== undefined || issue?.authorId !== userId;
}

export function issueFingerprint(change: IssueChange, actor: IssueActor): string { return JSON.stringify(['issue', change, actor.userId]); }

function required(store: IssueStore, number: number): Issue {
  const issue = store.get<Issue>(issueKey(number));
  if (!issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
  return issue;
}

function assertMissions(store: IssueStore, ids: string[]): void {
  for (const id of ids) if (!store.get(`mission:${id}`)) throw new ApiError(404, 'MISSION_NOT_FOUND', 'Every linked mission must belong to this repository.');
}

export function applyIssueChange(store: IssueStore, change: IssueChange, actor: IssueActor, now = new Date().toISOString()): number {
  const issue = change.action === 'create' ? undefined : required(store, change.number);
  if (requiresModeration(change, issue, actor.userId) && !actor.moderator) throw new ApiError(403, 'FORBIDDEN', 'Closing, reopening, labeling, assigning, and editing other people’s issues require review access.');
  if (change.action === 'create') {
    const number = (store.get<number>('issue-count') ?? 0) + 1;
    if (number > ISSUE_LIMIT) throw new ApiError(409, 'ISSUE_LIMIT', `A repository can hold at most ${ISSUE_LIMIT} issues.`);
    assertMissions(store, change.missionIds);
    store.put('issue-count', number);
    store.put(issueKey(number), { repositoryId: change.repositoryId, number, title: change.title, body: change.body, state: 'open', labels: change.labels, assignees: change.assignees, missionIds: change.missionIds, authorId: actor.userId, createdAt: now, updatedAt: now, commentCount: 0 } satisfies Issue);
    return number;
  }
  const current = issue!;
  if (change.action === 'comment') {
    if (change.commentId) {
      const comment = store.list<IssueComment & { key: string }>(commentPrefix(current.number)).find((item) => item.id === change.commentId);
      if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'This comment could not be found.');
      if (comment.authorId !== actor.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the comment author can edit it.');
      store.put(comment.key, { ...comment, body: change.body, editedAt: now });
    } else {
      if (current.commentCount >= ISSUE_COMMENT_LIMIT) throw new ApiError(409, 'COMMENT_LIMIT', `An issue can hold at most ${ISSUE_COMMENT_LIMIT} comments.`);
      const key = `${commentPrefix(current.number)}${pad(current.commentCount + 1)}`;
      store.put(key, { key, id: crypto.randomUUID(), authorId: actor.userId, body: change.body, createdAt: now });
      current.commentCount++;
    }
  } else if (change.action === 'close') {
    if (current.state === 'closed') throw new ApiError(409, 'ISSUE_ALREADY_CLOSED', 'This issue is already closed.');
    Object.assign(current, { state: 'closed', closedReason: change.reason, closedAt: now });
  } else if (change.action === 'reopen') {
    if (current.state === 'open') throw new ApiError(409, 'ISSUE_ALREADY_OPEN', 'This issue is already open.');
    current.state = 'open'; delete current.closedReason; delete current.closedAt;
  } else {
    if (change.missionIds) assertMissions(store, change.missionIds.filter((id) => !current.missionIds.includes(id)));
    const { action: _action, number: _number, ...fields } = change;
    Object.assign(current, fields);
  }
  current.updatedAt = now;
  store.put(issueKey(current.number), current);
  return current.number;
}

export function readIssue(store: IssueStore, number: number): IssueDetail | undefined {
  const issue = store.get<Issue>(issueKey(number));
  if (!issue) return undefined;
  return { ...issue, comments: store.list<IssueComment & { key?: string }>(commentPrefix(number)).map(({ key: _key, ...comment }) => comment) };
}

export function listIssues(store: IssueStore, query: IssueQuery = {}): IssueList {
  const all = store.list<Issue>('issue:').reverse();
  const term = query.q?.trim().toLowerCase();
  const label = query.label?.trim().toLowerCase();
  const matching = all.filter((issue) => (!label || issue.labels.some((item) => item.toLowerCase() === label)) && (!term || issue.title.toLowerCase().includes(term) || issue.body.toLowerCase().includes(term) || `#${issue.number}` === term || String(issue.number) === term));
  const state = query.state ?? 'open';
  const filtered = state === 'all' ? matching : matching.filter((issue) => issue.state === state);
  const offset = query.offset ?? 0, limit = Math.min(query.limit ?? PAGE_LIMIT, PAGE_LIMIT);
  const items = filtered.slice(offset, offset + limit);
  const labels = [...new Map(all.flatMap((issue) => issue.labels).map((item) => [item.toLowerCase(), item])).values()].sort((a, b) => a.localeCompare(b));
  return { items, total: filtered.length, openCount: matching.filter((issue) => issue.state === 'open').length, closedCount: matching.filter((issue) => issue.state === 'closed').length, labels, offset, nextOffset: offset + items.length < filtered.length ? offset + items.length : null };
}

interface IssueAccess { authorize(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>; snapshot(principal: Principal): Promise<{ members: { userId: string }[] }> }
interface IssueCoordinator { listIssues(query: IssueQuery): Promise<IssueList>; getIssue(number: number): Promise<IssueDetail | undefined>; changeIssue(key: string, change: IssueChange, actor: IssueActor): Promise<IssueDetail> }
const ROUTE = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/issues(?:\/(\d{1,6})(?:\/(comment|update|close|reopen))?)?$/;

async function contributeOrReview(access: IssueAccess, principal: Principal, repositoryId: string): Promise<void> {
  try { await access.authorize(principal, 'contribute', 'repository', repositoryId); }
  catch (error) { if (publicError(error).code !== 'FORBIDDEN') throw error; await access.authorize(principal, 'review', 'repository', repositoryId); }
}

export async function handleIssues(request: Request, url: URL, principal: Principal, access: IssueAccess, catalog: { getRepository(id: string): Promise<Repository | undefined> }, coordinatorFor: (repositoryId: string) => IssueCoordinator): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, repositoryId, numberText, operation] = match;
  if (!await catalog.getRepository(repositoryId)) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
  const coordinator = coordinatorFor(repositoryId);
  if (request.method === 'GET' && !operation) {
    await access.authorize(principal, 'read', 'repository', repositoryId);
    if (numberText) { const issue = await coordinator.getIssue(issueNumber(numberText)); if (!issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.'); return Response.json(issue); }
    const state = url.searchParams.get('state') ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) throw new ApiError(400, 'INVALID_INPUT', 'Filter by open, closed, or all issues.');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'INVALID_INPUT', 'Offset must be a non-negative integer.');
    return Response.json(await coordinator.listIssues({ state: state as IssueQuery['state'], label: url.searchParams.get('label')?.slice(0, 40) || undefined, q: url.searchParams.get('q')?.slice(0, 200) || undefined, offset }));
  }
  if (request.method !== 'POST' || (numberText ? !operation : !!operation)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported issue operation.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, ISSUE_REQUEST_MAX_BYTES);
  const change = parseIssueChange((operation ?? 'create') as IssueAction, body, { repositoryId, number: numberText ? Number(numberText) : undefined });
  const issue = change.action === 'create' ? undefined : await coordinator.getIssue(change.number);
  if (change.action !== 'create' && !issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
  const moderator = requiresModeration(change, issue, principal.userId);
  if (change.action === 'comment') await contributeOrReview(access, principal, repositoryId);
  else await access.authorize(principal, change.action === 'create' || !moderator ? 'contribute' : 'review', 'repository', repositoryId);
  if (change.action === 'create' && moderator) await access.authorize(principal, 'review', 'repository', repositoryId);
  const added = 'assignees' in change && change.assignees ? change.assignees.filter((id) => !issue?.assignees.includes(id)) : [];
  if (added.length) {
    const members = new Set([principal.userId, ...await access.snapshot(principal).then((snapshot) => snapshot.members.map((member) => member.userId), () => [])]);
    if (added.some((id) => !members.has(id))) throw new ApiError(400, 'UNKNOWN_ASSIGNEE', 'Assign issues only to members of this workspace.');
  }
  const result = await coordinator.changeIssue(key, change, { userId: principal.userId, moderator });
  return Response.json(result, { status: change.action === 'create' ? 201 : 200 });
}
