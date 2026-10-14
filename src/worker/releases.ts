import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Mission, Release, ReleaseList, ReleaseNotes, Repository } from '../shared/types';
import type { ArtifactsBinding } from './artifacts';
import { ApiError, assertMutationOrigin, publicError, readJson, requireIdempotencyKey, requireString } from './domain';
import { advertisedRefs, discoverRefs, remoteDetails } from './repository-import';
import { boundedBody, packet, parsePackets, requireGitResponse } from './repository-initialization';
import type { Principal } from './security';

// Ref advertisements are read through boundedBody's 64 KiB ceiling, which caps how many tags a repository can advertise
export const RELEASE_LIMIT = 500;
export const RELEASE_NOTES_MAX = 20_000;
export const RELEASE_REQUEST_MAX_BYTES = 131_072;
export const RELEASE_HISTORY_LIMIT = 1000;
export const RELEASE_CLAIM_STALE_MS = 300_000;
const zero = '0'.repeat(40);
const emptyPackHeader = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
export const EMPTY_PACK = new Uint8Array(Buffer.concat([emptyPackHeader, createHash('sha1').update(emptyPackHeader).digest()]));

export interface ReleaseInput { tag: string; name: string; notes: string; targetSha?: string; draft: boolean; prerelease: boolean }
export interface ReleasePatch { tag?: string; name?: string; notes?: string; targetSha?: string; prerelease?: boolean }
export interface ReleaseRejection { status: number; code: string; message: string }
export interface ReleaseReceipt { fingerprint: string; claimedAt?: number; pending?: Release; result?: Release; deleted?: boolean; rejection?: ReleaseRejection }
export type ReleaseChange =
  | { kind: 'save'; release: Release }
  | { kind: 'update'; id: string; patch: ReleasePatch; updatedAt: string }
  | { kind: 'delete'; id: string }
  | { kind: 'claim'; release: Release; claimedAt: number }
  | { kind: 'complete'; publishedAt: string }
  | { kind: 'reject'; rejection: ReleaseRejection };
export interface ReleaseOutcome { receipt: ReleaseReceipt; fresh: boolean; put?: Release; remove?: string; reserve?: string; unreserve?: string }
export interface ReleaseStore {
  listReleases(): Release[] | Promise<Release[]>;
  getRelease(id: string): Release | undefined | Promise<Release | undefined>;
  getReleaseRequest(key: string, fingerprint: string): ReleaseReceipt | undefined | Promise<ReleaseReceipt | undefined>;
  changeRelease(key: string, fingerprint: string, change: ReleaseChange): { receipt: ReleaseReceipt; fresh: boolean } | Promise<{ receipt: ReleaseReceipt; fresh: boolean }>;
  listMissions(): Mission[] | Promise<Mission[]>;
}
export interface ReleaseAccess {
  authorize(principal: Principal, action: 'read' | 'land', resourceType?: string, resourceId?: string, missionId?: string): Promise<unknown>;
  check(principal: Principal, action: 'read' | 'land', resourceType?: string, resourceId?: string, missionId?: string): Promise<unknown>;
}

const invalid = (code: string, message: string) => new ApiError(400, code, message);

export function releaseTag(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/.test(value)) throw invalid('INVALID_TAG', 'Tags start with a letter or number and use up to 100 letters, numbers, ".", "_", "+", "/" or "-".');
  if (value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.') || value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw invalid('INVALID_TAG', 'This is not a valid Git tag name.');
  return value;
}

function commitSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw invalid('INVALID_COMMIT', 'Target commits must be 40 lowercase hexadecimal characters.');
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw invalid('INVALID_INPUT', `${field} must be true or false.`);
  return value === true;
}

function notes(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > RELEASE_NOTES_MAX) throw invalid('INVALID_INPUT', `Release notes must be Markdown up to ${RELEASE_NOTES_MAX.toLocaleString('en-US')} characters.`);
  return value;
}

export function releaseInput(body: Record<string, unknown>): ReleaseInput {
  return { tag: releaseTag(body.tag), name: requireString(body.name, 'Release name', 120), notes: notes(body.notes), ...(body.targetSha === undefined || body.targetSha === null || body.targetSha === '' ? {} : { targetSha: commitSha(body.targetSha) }), draft: boolean(body.draft, 'Draft'), prerelease: boolean(body.prerelease, 'Pre-release') };
}

export function releasePatch(body: Record<string, unknown>): ReleasePatch {
  const patch: ReleasePatch = {};
  if (body.tag !== undefined) patch.tag = releaseTag(body.tag);
  if (body.name !== undefined) patch.name = requireString(body.name, 'Release name', 120);
  if (body.notes !== undefined) patch.notes = notes(body.notes);
  if (body.targetSha !== undefined) patch.targetSha = commitSha(body.targetSha);
  if (body.prerelease !== undefined) patch.prerelease = boolean(body.prerelease, 'Pre-release');
  if (!Object.keys(patch).length) throw invalid('INVALID_INPUT', 'Change at least one release field.');
  return patch;
}

function assertTagAvailable(releases: Release[], reserved: Map<string, string>, tag: string, key: string, exceptId?: string) {
  if (releases.some(release => release.tag === tag && release.id !== exceptId)) throw new ApiError(409, 'TAG_EXISTS', `A release for tag ${tag} already exists.`);
  const holder = reserved.get(tag);
  if (holder && holder !== key) throw new ApiError(409, 'RELEASE_PENDING', `Tag ${tag} is being published by another request.`);
}

export function applyReleaseChange(releases: Release[], reserved: Map<string, string>, existing: ReleaseReceipt | undefined, key: string, fingerprint: string, change: ReleaseChange): ReleaseOutcome {
  if (change.kind === 'complete' || change.kind === 'reject') {
    if (!existing?.pending) throw new ApiError(409, 'RELEASE_NOT_PENDING', 'This release request has no pending tag write.');
    if (existing.result || existing.rejection) return { receipt: existing, fresh: false };
    if (change.kind === 'reject') return { receipt: { fingerprint, claimedAt: existing.claimedAt, pending: existing.pending, rejection: change.rejection }, fresh: true, unreserve: existing.pending.tag };
    const release = { ...existing.pending, draft: false, publishedAt: change.publishedAt, updatedAt: change.publishedAt };
    return { receipt: { fingerprint, claimedAt: existing.claimedAt, pending: existing.pending, result: release }, fresh: true, put: release, unreserve: release.tag };
  }
  if (existing) return { receipt: existing, fresh: false };
  const current = (id: string) => { const release = releases.find(item => item.id === id); if (!release) throw new ApiError(404, 'RELEASE_NOT_FOUND', 'This release could not be found.'); return release; };
  const unlocked = (release: Release) => { if (reserved.has(release.tag)) throw new ApiError(409, 'RELEASE_PENDING', 'This release is being published. Wait for the tag write to finish.'); return release; };
  if (change.kind === 'delete') { const release = unlocked(current(change.id)); return { receipt: { fingerprint, result: release, deleted: true }, fresh: true, remove: release.id }; }
  if (change.kind === 'update') {
    const release = unlocked(current(change.id));
    if (!release.draft && (change.patch.tag !== undefined && change.patch.tag !== release.tag || change.patch.targetSha !== undefined && change.patch.targetSha !== release.targetSha)) throw new ApiError(409, 'RELEASE_TAG_IMMUTABLE', 'A published release keeps its tag and target commit. Git tags are never moved.');
    if (change.patch.tag) assertTagAvailable(releases, reserved, change.patch.tag, key, release.id);
    const updated = { ...release, ...change.patch, updatedAt: change.updatedAt };
    return { receipt: { fingerprint, result: updated }, fresh: true, put: updated };
  }
  const existingRelease = releases.find(item => item.id === change.release.id);
  if (existingRelease && (!existingRelease.draft || change.kind === 'save')) throw new ApiError(409, 'RELEASE_ALREADY_PUBLISHED', 'This release is already published.');
  if (existingRelease) unlocked(existingRelease);
  if (!existingRelease && releases.length >= RELEASE_LIMIT) throw new ApiError(409, 'RELEASE_LIMIT', `A repository can hold at most ${RELEASE_LIMIT} releases. Delete unused drafts first.`);
  assertTagAvailable(releases, reserved, change.release.tag, key, change.release.id);
  if (change.kind === 'save') return { receipt: { fingerprint, result: change.release }, fresh: true, put: change.release };
  return { receipt: { fingerprint, claimedAt: change.claimedAt, pending: change.release }, fresh: true, reserve: change.release.tag };
}

export class ReleaseTagFailure extends ApiError {
  constructor(readonly outcome: 'not_pushed' | 'unknown', error: unknown) {
    const failure = publicError(error);
    super(outcome === 'not_pushed' ? failure.status : 503, outcome === 'not_pushed' ? failure.code : 'RELEASE_UNCONFIRMED', outcome === 'not_pushed' ? failure.message : 'The tag write has an uncertain outcome. Retry the same request to confirm it; the tag is never pushed twice.');
  }
}

function connected(artifacts: ArtifactsBinding | undefined, repository: Repository): ArtifactsBinding {
  if (!artifacts || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository before creating releases.');
  return artifacts;
}

export async function readReleaseTag(artifacts: ArtifactsBinding, repository: Repository, tag: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  using source = await artifacts.get(repository.name);
  const { refs } = await advertisedRefs(source, 'read', 'git-upload-pack', fetcher);
  return refs.get(`refs/tags/${tag}`) ?? null;
}

export async function pushReleaseTag(artifacts: ArtifactsBinding, repository: Repository, tag: string, targetSha: string, assertAuthority: () => Promise<unknown>, fetcher: typeof fetch = fetch): Promise<void> {
  const ref = `refs/tags/${releaseTag(tag)}`;
  let attempted = false, token: { plaintext: string } | undefined;
  using source = await artifacts.get(repository.name).catch((error: unknown) => { throw new ReleaseTagFailure('not_pushed', error); });
  try {
    const info = await source.info(); const { base } = remoteDetails(info);
    if (repository.remote && info.remote !== repository.remote) throw new ApiError(409, 'RELEASE_REMOTE_CHANGED', 'The repository remote changed. Reconnect it before publishing.');
    token = await source.createToken('write', 60);
    const { refs, capabilities } = await discoverRefs(base, 'git-receive-pack', token.plaintext, fetcher);
    if (refs.has(ref)) throw new ApiError(409, 'TAG_EXISTS', `Tag ${tag} already exists. Existing tags are never moved or replaced.`);
    if (!capabilities.has('report-status')) throw new ApiError(502, 'RELEASE_PROTOCOL', 'Git does not support receive status.');
    await assertAuthority();
    attempted = true;
    const response = await fetcher(`${base}/git-receive-pack`, { method: 'POST', headers: { authorization: `Bearer ${token.plaintext}`, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: new Uint8Array(Buffer.concat([packet(`${zero} ${targetSha} ${ref}\0report-status\n`), Buffer.from('0000'), EMPTY_PACK])), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    requireGitResponse(response, 'application/x-git-receive-pack-result');
    const status = parsePackets(await boundedBody(response)).filter(Boolean).map(line => line.trimEnd());
    if (status.length === 2 && status[1].startsWith(`ng ${ref} `)) throw new ReleaseTagFailure('not_pushed', new ApiError(409, 'TAG_REJECTED', `Git refused to create tag ${tag}: ${status[1].slice(ref.length + 4, ref.length + 204)}`));
    if (status.length !== 2 || status[0] !== 'unpack ok' || status[1] !== `ok ${ref}`) throw new ApiError(502, 'RELEASE_PROTOCOL', 'Git returned an unexpected tag status.');
    if (await readReleaseTag(artifacts, repository, tag, fetcher) !== targetSha) throw new ApiError(503, 'RELEASE_UNCONFIRMED', 'Git accepted the tag but it is not visible at the target commit.');
  } catch (error) { throw error instanceof ReleaseTagFailure ? error : new ReleaseTagFailure(attempted ? 'unknown' : 'not_pushed', error); }
  finally { if (token) await source.revokeToken(token.plaintext); }
}

async function history(artifacts: ArtifactsBinding, repository: Repository) {
  using source = await artifacts.get(repository.name);
  const commits = await source.log({ ref: repository.defaultBranch, limit: RELEASE_HISTORY_LIMIT });
  if (!commits.length) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before creating a release.');
  return commits;
}

export async function resolveReleaseTarget(artifacts: ArtifactsBinding, repository: Repository, targetSha?: string): Promise<string> {
  const commits = await history(artifacts, repository);
  if (!targetSha) return commits[0].hash;
  if (!commits.some(commit => commit.hash === targetSha)) throw new ApiError(422, 'TARGET_NOT_IN_HISTORY', `The target must be one of the latest ${RELEASE_HISTORY_LIMIT.toLocaleString('en-US')} commits on ${repository.defaultBranch}.`);
  return targetSha;
}

const inline = (value: string) => value.split('\n')[0].trim().replace(/[\\`*_[\]<>#|~]/g, match => `\\${match}`).slice(0, 200) || 'Untitled';

export async function generateReleaseNotes(artifacts: ArtifactsBinding, repository: Repository, releases: Release[], missions: Mission[], targetSha?: string): Promise<ReleaseNotes> {
  const commits = await history(artifacts, repository);
  const target = targetSha ?? commits[0].hash, start = commits.findIndex(commit => commit.hash === target);
  if (start < 0) throw new ApiError(422, 'TARGET_NOT_IN_HISTORY', `The target must be one of the latest ${RELEASE_HISTORY_LIMIT.toLocaleString('en-US')} commits on ${repository.defaultBranch}.`);
  let end = commits.length, previous: Release | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const index = commits.findIndex(commit => commit.hash === release.targetSha);
    if (index > start && index < end) { end = index; previous = release; }
  }
  const range = commits.slice(start, end), shas = new Set(range.map(commit => commit.hash));
  const landed = missions.filter(mission => mission.status === 'integrated' && mission.candidateSha && shas.has(mission.candidateSha));
  const lines = [`## ${previous ? `Changes since ${previous.tag}` : 'Changes'}`, ''];
  if (landed.length) lines.push('### Missions', '', ...landed.map(mission => `- ${inline(mission.title)} (\`${mission.candidateSha!.slice(0, 7)}\`)`), '');
  lines.push('### Commits', '', ...range.map(commit => `- ${inline(commit.message)} (\`${commit.hash.slice(0, 7)}\`)`));
  const truncated = !previous && commits.length >= RELEASE_HISTORY_LIMIT;
  if (truncated) lines.push('', `_Only the latest ${RELEASE_HISTORY_LIMIT.toLocaleString('en-US')} commits are listed._`);
  let markdown = `${lines.join('\n')}\n`;
  if (markdown.length > RELEASE_NOTES_MAX) markdown = `${markdown.slice(0, markdown.lastIndexOf('\n', RELEASE_NOTES_MAX - 80))}\n\n_Notes were shortened to fit the release limit._\n`;
  return { markdown, targetSha: target, previousTag: previous?.tag ?? null, commitCount: range.length, missionCount: landed.length, truncated };
}

export function sortReleases(releases: Release[]): Release[] {
  return [...releases].sort((a, b) => Number(b.draft) - Number(a.draft) || (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
}

interface ReleaseContext { artifacts?: ArtifactsBinding; repository: Repository; coordinator: ReleaseStore; principal: Principal; access: ReleaseAccess; fetcher?: typeof fetch }

async function reconcile(context: ReleaseContext, key: string, fingerprint: string, receipt: ReleaseReceipt): Promise<Release> {
  if (receipt.result) return receipt.result;
  if (receipt.rejection) throw new ApiError(receipt.rejection.status, receipt.rejection.code, receipt.rejection.message);
  const pending = receipt.pending!;
  const actual = await readReleaseTag(connected(context.artifacts, context.repository), context.repository, pending.tag, context.fetcher).catch(() => undefined);
  if (actual === pending.targetSha) return (await context.coordinator.changeRelease(key, fingerprint, { kind: 'complete', publishedAt: new Date().toISOString() })).receipt.result!;
  if (actual === null && Date.now() - (receipt.claimedAt ?? 0) > RELEASE_CLAIM_STALE_MS) {
    const rejection = { status: 409, code: 'RELEASE_NOT_PUBLISHED', message: `Tag ${pending.tag} was not created. Publish again with a new request.` };
    await context.coordinator.changeRelease(key, fingerprint, { kind: 'reject', rejection });
    throw new ApiError(rejection.status, rejection.code, rejection.message);
  }
  if (actual) throw new ApiError(409, 'TAG_EXISTS', `Tag ${pending.tag} points at a different commit. Existing tags are never moved.`);
  throw new ApiError(409, 'RELEASE_PENDING', 'This tag write is still unconfirmed. It will not be repeated; retry the same request shortly.');
}

async function publish(context: ReleaseContext, key: string, fingerprint: string, release: Release): Promise<Release> {
  const artifacts = connected(context.artifacts, context.repository);
  const claim = await context.coordinator.changeRelease(key, fingerprint, { kind: 'claim', release, claimedAt: Date.now() });
  if (!claim.fresh) return reconcile(context, key, fingerprint, claim.receipt);
  try { await pushReleaseTag(artifacts, context.repository, release.tag, release.targetSha, () => context.access.check(context.principal, 'land', 'repository', context.repository.id), context.fetcher); }
  catch (error) {
    if (error instanceof ReleaseTagFailure && error.outcome === 'not_pushed') {
      await context.coordinator.changeRelease(key, fingerprint, { kind: 'reject', rejection: publicError(error) });
      throw error;
    }
    const actual = await readReleaseTag(artifacts, context.repository, release.tag, context.fetcher).catch(() => undefined);
    if (actual !== release.targetSha) throw error;
  }
  return (await context.coordinator.changeRelease(key, fingerprint, { kind: 'complete', publishedAt: new Date().toISOString() })).receipt.result!;
}

export async function releaseApi(request: Request, context: ReleaseContext, releaseId?: string, operation?: string): Promise<Response> {
  const { repository, coordinator, principal, access } = context;
  if (request.method === 'GET' && !operation) {
    await access.authorize(principal, 'read', 'repository', repository.id);
    if (releaseId) {
      const release = await coordinator.getRelease(releaseId);
      if (!release) throw new ApiError(404, 'RELEASE_NOT_FOUND', 'This release could not be found.');
      return Response.json(release);
    }
    let commits: ReleaseList['commits'] = [];
    if (context.artifacts && repository.provider === 'artifacts') { using source = await context.artifacts.get(repository.name); commits = (await source.log({ ref: repository.defaultBranch, limit: 30 })).map(commit => ({ sha: commit.hash, message: commit.message.split('\n')[0].slice(0, 200) })); }
    return Response.json({ releases: sortReleases(await coordinator.listReleases()), defaultBranch: repository.defaultBranch, headSha: commits[0]?.sha ?? null, commits, limit: RELEASE_LIMIT } satisfies ReleaseList);
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET to read releases and POST to change them.');
  assertMutationOrigin(request);
  const body = await readJson(request, RELEASE_REQUEST_MAX_BYTES);
  if (releaseId === 'notes' && !operation) {
    await access.authorize(principal, 'read', 'repository', repository.id);
    const visible: Mission[] = [];
    for (const mission of await coordinator.listMissions()) { try { await access.check(principal, 'read', 'repository', repository.id, mission.id); visible.push(mission); } catch {} }
    return Response.json(await generateReleaseNotes(connected(context.artifacts, repository), repository, await coordinator.listReleases(), visible, body.targetSha === undefined || body.targetSha === '' ? undefined : commitSha(body.targetSha)));
  }
  const key = requireIdempotencyKey(request);
  await access.authorize(principal, 'land', 'repository', repository.id);
  const artifacts = connected(context.artifacts, repository);
  if (!releaseId) {
    const input = releaseInput(body), fingerprint = JSON.stringify(['release-create', input]);
    const previous = await coordinator.getReleaseRequest(key, fingerprint);
    if (previous) return Response.json(await reconcile(context, key, fingerprint, previous), { status: 201 });
    const targetSha = await resolveReleaseTarget(artifacts, repository, input.targetSha);
    const now = new Date().toISOString();
    const release: Release = { id: crypto.randomUUID(), repositoryId: repository.id, tag: input.tag, name: input.name, notes: input.notes, targetSha, draft: input.draft, prerelease: input.prerelease, authorId: principal.userId, createdAt: now, updatedAt: now, publishedAt: null };
    if (input.draft) {
      if (await readReleaseTag(artifacts, repository, input.tag, context.fetcher)) throw new ApiError(409, 'TAG_EXISTS', `Tag ${input.tag} already exists. Choose a new tag.`);
      return Response.json((await coordinator.changeRelease(key, fingerprint, { kind: 'save', release })).receipt.result, { status: 201 });
    }
    return Response.json(await publish(context, key, fingerprint, release), { status: 201 });
  }
  if (!operation) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  if (operation === 'publish') {
    const fingerprint = JSON.stringify(['release-publish', releaseId]);
    const previous = await coordinator.getReleaseRequest(key, fingerprint);
    if (previous) return Response.json(await reconcile(context, key, fingerprint, previous));
    const release = await coordinator.getRelease(releaseId);
    if (!release) throw new ApiError(404, 'RELEASE_NOT_FOUND', 'This release could not be found.');
    if (!release.draft) throw new ApiError(409, 'RELEASE_ALREADY_PUBLISHED', 'This release is already published.');
    await resolveReleaseTarget(artifacts, repository, release.targetSha);
    return Response.json(await publish(context, key, fingerprint, release));
  }
  if (operation === 'delete') {
    const result = await coordinator.changeRelease(key, JSON.stringify(['release-delete', releaseId]), { kind: 'delete', id: releaseId });
    return Response.json({ deleted: true, release: result.receipt.result, tagRetained: !result.receipt.result?.draft, message: result.receipt.result?.draft ? 'The draft was deleted.' : 'The release record was deleted. Its Git tag is immutable and remains in the repository.' });
  }
  const patch = releasePatch(body), fingerprint = JSON.stringify(['release-update', releaseId, patch]);
  const previous = await coordinator.getReleaseRequest(key, fingerprint);
  if (previous) return Response.json(previous.result);
  if (patch.targetSha) await resolveReleaseTarget(artifacts, repository, patch.targetSha);
  const current = await coordinator.getRelease(releaseId);
  if (patch.tag && current?.draft && patch.tag !== current.tag && await readReleaseTag(artifacts, repository, patch.tag, context.fetcher)) throw new ApiError(409, 'TAG_EXISTS', `Tag ${patch.tag} already exists. Choose a new tag.`);
  return Response.json((await coordinator.changeRelease(key, fingerprint, { kind: 'update', id: releaseId, patch, updatedAt: new Date().toISOString() })).receipt.result);
}
