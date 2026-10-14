import { Buffer } from 'node:buffer';
import type { BranchChangeResult, Repository } from '../shared/types';
import type { ArtifactsBinding } from './artifacts';
import { branchName, evaluatePush, ruleFor, ZERO_SHA, type StoredBranchProtection, effectiveRules } from './branch-protection';
import { ApiError, assertMutationOrigin, publicError, readJson, requireIdempotencyKey } from './domain';
import { advertisedRefs, discoverRefs, remoteDetails } from './repository-import';
import { boundedBody, packet, parsePackets, requireGitResponse } from './repository-initialization';
import { EMPTY_PACK } from './releases';
import type { Action, Principal } from './security';

const sha = /^[a-f0-9]{40}$/;

export interface BranchCreateInput { name: string; from?: string }
export interface BranchDeleteInput { name: string; expectedHeadSha?: string }

export function newBranchName(value: unknown): string {
  const name = branchName(value, 'Branch name');
  if (name === 'HEAD' || sha.test(name)) throw new ApiError(400, 'INVALID_BRANCH', 'Choose a branch name that is not HEAD or a commit SHA.');
  return name;
}

export function branchCreateInput(body: Record<string, unknown>): BranchCreateInput {
  const from = body.from === undefined || body.from === '' ? undefined : body.from;
  if (from !== undefined && (typeof from !== 'string' || !sha.test(from))) branchName(from, 'Source branch');
  return { name: newBranchName(body.name), ...(from === undefined ? {} : { from: from as string }) };
}

export function branchDeleteInput(body: Record<string, unknown>): BranchDeleteInput {
  if (body.expectedHeadSha !== undefined && (typeof body.expectedHeadSha !== 'string' || !sha.test(body.expectedHeadSha))) throw new ApiError(400, 'INVALID_COMMIT', 'Provide the exact 40 character head SHA you expect the branch to have.');
  return { name: branchName(body.name), ...(body.expectedHeadSha ? { expectedHeadSha: body.expectedHeadSha as string } : {}) };
}

export class BranchWriteFailure extends ApiError {
  constructor(readonly outcome: 'not_pushed' | 'unknown', error: unknown) {
    const failure = publicError(error);
    super(outcome === 'not_pushed' ? failure.status : 503, outcome === 'not_pushed' ? failure.code : 'BRANCH_UNCONFIRMED', outcome === 'not_pushed' ? failure.message : 'The branch write has an uncertain outcome. Refresh the branch list before trying again.');
  }
}

export async function readBranchHeads(artifacts: ArtifactsBinding, repository: Repository, fetcher: typeof fetch = fetch): Promise<Map<string, string>> {
  using source = await artifacts.get(repository.name);
  const { refs } = await advertisedRefs(source, 'read', 'git-upload-pack', fetcher);
  return new Map([...refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, head]) => [ref.slice('refs/heads/'.length), head]));
}

export async function writeBranchRef(artifacts: ArtifactsBinding, repository: Repository, branch: string, oldSha: string | null, newSha: string | null, assertAuthority: () => Promise<unknown>, fetcher: typeof fetch = fetch): Promise<void> {
  const ref = `refs/heads/${branchName(branch)}`, deleting = newSha === null;
  let attempted = false, token: { plaintext: string } | undefined;
  using source = await artifacts.get(repository.name).catch((error: unknown) => { throw new BranchWriteFailure('not_pushed', error); });
  try {
    const info = await source.info(); const { base } = remoteDetails(info);
    if (repository.remote && info.remote !== repository.remote) throw new ApiError(409, 'REPOSITORY_REMOTE_CHANGED', 'The repository remote changed. Reconnect it before changing branches.');
    token = await source.createToken('write', 60);
    const { refs, capabilities } = await discoverRefs(base, 'git-receive-pack', token.plaintext, fetcher);
    if ((refs.get(ref) ?? null) !== oldSha) throw new ApiError(409, oldSha ? 'STALE_BRANCH' : 'BRANCH_EXISTS', oldSha ? `Branch ${branch} moved or was deleted. Refresh and try again.` : `Branch ${branch} already exists.`);
    if (!capabilities.has('report-status') || (deleting && !capabilities.has('delete-refs'))) throw new ApiError(502, 'BRANCH_PROTOCOL', 'Git does not support this branch update.');
    await assertAuthority();
    attempted = true;
    const command = packet(`${oldSha ?? ZERO_SHA} ${newSha ?? ZERO_SHA} ${ref}\0report-status${deleting ? ' delete-refs' : ''}\n`);
    const response = await fetcher(`${base}/git-receive-pack`, { method: 'POST', headers: { authorization: `Bearer ${token.plaintext}`, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: new Uint8Array(Buffer.concat([command, Buffer.from('0000'), ...(deleting ? [] : [EMPTY_PACK])])), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    requireGitResponse(response, 'application/x-git-receive-pack-result');
    const status = parsePackets(await boundedBody(response)).filter(Boolean).map(line => line.trimEnd());
    const refused = status.find(line => line.startsWith(`ng ${ref} `));
    if (refused) throw new BranchWriteFailure('not_pushed', new ApiError(409, 'BRANCH_REJECTED', `Git refused to ${deleting ? 'delete' : 'create'} ${branch}: ${refused.slice(ref.length + 4, ref.length + 204)}`));
    if (status.length !== 2 || status[0] !== 'unpack ok' || status[1] !== `ok ${ref}`) throw new ApiError(502, 'BRANCH_PROTOCOL', 'Git returned an unexpected branch status.');
    if ((await readBranchHeads(artifacts, repository, fetcher)).get(branch) !== (newSha ?? undefined)) throw new ApiError(503, 'BRANCH_UNCONFIRMED', 'Git accepted the branch update but it is not visible yet.');
  } catch (error) { throw error instanceof BranchWriteFailure ? error : new BranchWriteFailure(attempted ? 'unknown' : 'not_pushed', error); }
  finally { if (token) await source.revokeToken(token.plaintext).catch(() => false); }
}

async function resolveSource(artifacts: ArtifactsBinding, repository: Repository, heads: Map<string, string>, from: string): Promise<string> {
  if (heads.has(from)) return heads.get(from)!;
  if (!sha.test(from)) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${from} was not found.`);
  using source = await artifacts.get(repository.name);
  const commit = (await source.log({ ref: from, limit: 1 }).catch(() => []))[0];
  if (commit?.hash !== from) throw new ApiError(404, 'COMMIT_NOT_FOUND', `Commit ${from.slice(0, 12)} is not in this repository.`);
  return from;
}

interface BranchAccess { authorize(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>; check(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<unknown> }
interface BranchStore { getBranchProtection(): Promise<StoredBranchProtection | undefined> | StoredBranchProtection | undefined; getBranchRequest(key: string, fingerprint: string): Promise<BranchChangeResult | undefined> | BranchChangeResult | undefined; recordBranchRequest(key: string, fingerprint: string, result: BranchChangeResult): Promise<BranchChangeResult> | BranchChangeResult }
export interface BranchContext { artifacts?: ArtifactsBinding; repository: Repository; coordinator: BranchStore; principal: Principal; access: BranchAccess; fetcher?: typeof fetch }

export async function branchApi(request: Request, context: BranchContext, operation: 'create' | 'delete'): Promise<Response> {
  const { repository, coordinator, principal, access, fetcher } = context;
  await access.authorize(principal, 'contribute', 'repository', repository.id);
  if (!context.artifacts || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to use branches.');
  const artifacts = context.artifacts;
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request), body = await readJson(request, 4096);
  const input = operation === 'create' ? branchCreateInput(body) : branchDeleteInput(body);
  const fingerprint = JSON.stringify(['branch', operation, input]);
  const previous = await coordinator.getBranchRequest(key, fingerprint);
  if (previous) return Response.json(previous, { status: operation === 'create' ? 201 : 200 });
  const rules = effectiveRules(await coordinator.getBranchProtection(), repository.defaultBranch);
  const canLand = !!ruleFor(rules, input.name, repository.defaultBranch) && await access.authorize(principal, 'land', 'repository', repository.id).then(() => true, () => false);
  const heads = await readBranchHeads(artifacts, repository, fetcher);
  const current = heads.get(input.name) ?? null;
  let target: string | null;
  if (operation === 'create') {
    if (current) throw new ApiError(409, 'BRANCH_EXISTS', `Branch ${input.name} already exists.`);
    target = await resolveSource(artifacts, repository, heads, (input as BranchCreateInput).from ?? repository.defaultBranch);
  } else {
    if (!current) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${input.name} was not found.`);
    const expected = (input as BranchDeleteInput).expectedHeadSha;
    if (expected && expected !== current) throw new ApiError(409, 'STALE_BRANCH', `Branch ${input.name} moved to ${current.slice(0, 12)}. Refresh before deleting it.`);
    target = null;
  }
  const [decision] = evaluatePush([{ ref: `refs/heads/${input.name}`, oldSha: current ?? ZERO_SHA, newSha: target ?? ZERO_SHA }], { rules, defaultBranch: repository.defaultBranch, role: principal.role, canLand });
  if (!decision.ok) throw new ApiError(403, 'BRANCH_PROTECTED', `${input.name}: ${decision.reason}.`);
  try { await writeBranchRef(artifacts, repository, input.name, current, target, () => access.check(principal, 'contribute', 'repository', repository.id), fetcher); }
  catch (error) {
    if (error instanceof BranchWriteFailure && error.outcome === 'not_pushed') throw error;
    const actual = await readBranchHeads(artifacts, repository, fetcher).then(refs => refs.get(input.name) ?? null, () => undefined);
    if (actual !== target) throw error;
  }
  const result: BranchChangeResult = operation === 'create' ? { name: input.name, headSha: target!, created: true } : { name: input.name, headSha: current!, deleted: true };
  return Response.json(await coordinator.recordBranchRequest(key, fingerprint, result), { status: operation === 'create' ? 201 : 200 });
}
