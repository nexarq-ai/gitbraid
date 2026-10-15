import { Buffer } from 'node:buffer';
import type { Repository, RepositoryUrlImport, UrlImportPhase } from '../shared/types';
import type { CommandResult, GitPermission } from '../../runner/sandbox';
import { createArtifactsRepository, repositoryHead, type ArtifactsBinding } from './artifacts';
import { ApiError, assertMutationOrigin, readJson, repositoryName, requireIdempotencyKey, requireString } from './domain';
import type { Action, Principal } from './security';

export const URL_IMPORT_LIMITS = {
  packBytes: 256 * 1024 * 1024,
  branches: 500,
  tags: 2000,
  advertisementBytes: 4 * 1024 * 1024,
  discoveryMs: 15_000,
  fetchMs: 300_000,
  pushMs: 300_000,
} as const;

type Provider = RepositoryUrlImport['provider'];
const knownHosts: Record<string, { provider: Provider; segments: [number, number]; username: string }> = {
  'github.com': { provider: 'github', segments: [2, 2], username: 'x-access-token' },
  'gitlab.com': { provider: 'gitlab', segments: [2, 20], username: 'oauth2' },
  'bitbucket.org': { provider: 'bitbucket', segments: [2, 2], username: 'x-token-auth' },
  'codeberg.org': { provider: 'codeberg', segments: [2, 2], username: 'token' },
};
const reservedSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'arpa', 'onion', 'test', 'example', 'invalid'];

export interface ImportSource { url: string; origin: string; path: string; host: string; provider: Provider }
export interface ImportSourceProps { origin: string; path: string; authorization?: string; maxBytes: number }
export interface SourceRefs { defaultBranch: string; headSha: string; branches: number; tags: number }
export interface UrlImportInput { source: ImportSource; name: string; description: string; authorization?: string }
export interface UrlImportJob {
  id: string;
  repositoryId: string;
  workspaceId: string;
  artifactName: string;
  remote: string;
  defaultBranch: string;
  source: ImportSource;
  attempt: number;
  authenticated: boolean;
  principal: Principal;
}

function invalidUrl(message: string): never { throw new ApiError(400, 'INVALID_IMPORT_URL', message); }

export function parseImportUrl(value: unknown, blockedHosts: string[] = []): ImportSource {
  const raw = requireString(value, 'Repository URL', 2048);
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) invalidUrl('The repository URL must not contain spaces, backslashes or control characters.');
  if (!/^https:\/\//i.test(raw)) invalidUrl('Use an https:// repository URL.');
  let url: URL;
  try { url = new URL(raw); } catch { invalidUrl('Enter a valid repository URL.'); }
  if (url.username || url.password || /^https:\/\/[^/]*@/i.test(raw)) invalidUrl('Remove credentials from the URL. Supply a token separately.');
  if (url.search || url.hash) invalidUrl('Remove the query string or fragment from the repository URL.');
  if (url.port) invalidUrl('Custom ports are not supported for imports.');
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) invalidUrl('Use a public hostname, not an IP address.');
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1)!)) invalidUrl('Use a public, fully qualified hostname.');
  if (reservedSuffixes.includes(labels.at(-1)!) || blockedHosts.some(blocked => host === blocked.toLowerCase())) invalidUrl('This host cannot be imported from.');
  const path = url.pathname.replace(/\/+$/, '');
  const segments = path.split('/').slice(1);
  if (!path || path.length > 512 || segments.some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..')) invalidUrl('The repository path may contain only letters, numbers, dots, hyphens, underscores and tildes.');
  if (segments.at(-1) === 'git-upload-pack' || segments.slice(-2).join('/') === 'info/refs') invalidUrl('Use the repository URL, not a Git service endpoint.');
  const known = knownHosts[host];
  const [minimum, maximum] = known?.segments ?? [1, 10];
  if (segments.length < minimum || segments.length > maximum) invalidUrl(known ? `Use a ${host} repository URL such as https://${host}/owner/repository.` : 'The repository path is too deep.');
  return { url: `https://${host}${path}`, origin: `https://${host}`, path, host, provider: known?.provider ?? 'https' };
}

export function importAuthorization(source: ImportSource, token: unknown, username: unknown): string | undefined {
  if (token === undefined || token === null || token === '') {
    if (username !== undefined && username !== '') throw new ApiError(400, 'INVALID_INPUT', 'Supply a token with the username.');
    return undefined;
  }
  if (typeof token !== 'string' || token.length > 1024 || !/^[\x21-\x7e]+$/.test(token)) throw new ApiError(400, 'INVALID_IMPORT_TOKEN', 'The access token must be 1–1024 printable characters without spaces.');
  const user = username === undefined || username === '' ? knownHosts[source.host]?.username ?? 'oauth2' : requireString(username, 'Username', 100);
  if (!/^[A-Za-z0-9._@+-]+$/.test(user)) throw new ApiError(400, 'INVALID_INPUT', 'The username may contain letters, numbers and . _ @ + -.');
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

export function importRepositoryName(source: ImportSource): string {
  const last = source.path.split('/').at(-1)!.replace(/\.git$/i, '');
  const name = last.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 64).replace(/\.git$/i, '');
  return name || 'imported-repository';
}

export function urlImportInput(body: Record<string, unknown>, blockedHosts: string[] = []): UrlImportInput {
  const source = parseImportUrl(body.url, blockedHosts);
  const name = repositoryName(body.name === undefined || body.name === '' ? importRepositoryName(source) : body.name);
  const description = body.description === undefined || body.description === '' ? '' : requireString(body.description, 'Description', 500);
  return { source, name, description, authorization: importAuthorization(source, body.token, body.username) };
}

export function validBranchName(branch: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(branch) && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.') && !branch.split('/').some(part => part.endsWith('.lock'));
}

function packetLines(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes); const lines: string[] = []; let offset = 0;
  while (offset < buffer.length) {
    const prefix = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/i.test(prefix)) throw new ApiError(502, 'SOURCE_PROTOCOL', 'The source returned an invalid Git response.');
    const length = parseInt(prefix, 16); offset += 4;
    if (length === 0) { lines.push(''); continue; }
    if (length < 4 || offset + length - 4 > buffer.length) throw new ApiError(502, 'SOURCE_PROTOCOL', 'The source returned a truncated Git response.');
    lines.push(buffer.subarray(offset, offset + length - 4).toString('utf8')); offset += length - 4;
  }
  return lines;
}

async function limitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new ApiError(502, 'SOURCE_PROTOCOL', 'The source returned an empty Git response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ApiError(413, 'SOURCE_TOO_LARGE', `The source advertises more references than the ${maxBytes / 1024 / 1024} MiB import limit allows.`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Uint8Array(Buffer.concat(chunks));
}

export function parseAdvertisement(bytes: Uint8Array): SourceRefs {
  const lines = packetLines(bytes);
  if (lines[0] !== '# service=git-upload-pack\n' || lines[1] !== '') throw new ApiError(502, 'SOURCE_PROTOCOL', 'The source returned an invalid Git service advertisement.');
  const heads = new Map<string, string>(); let tags = 0; let symref: string | undefined;
  for (const [index, line] of lines.slice(2).filter(Boolean).entries()) {
    const [advertisement, capabilities] = line.replace(/\n$/, '').split('\0');
    const match = /^([a-f0-9]{40}) (\S+)$/.exec(advertisement);
    if (!match) throw new ApiError(502, 'SOURCE_PROTOCOL', /^[a-f0-9]{64} /.test(advertisement) ? 'SHA-256 repositories are not supported.' : 'The source returned an invalid reference advertisement.');
    if (index === 0 && capabilities) {
      const values = capabilities.split(' ');
      if (values.some(value => value.startsWith('object-format=') && value !== 'object-format=sha1')) throw new ApiError(422, 'SOURCE_UNSUPPORTED', 'SHA-256 repositories are not supported.');
      symref = values.find(value => value.startsWith('symref=HEAD:refs/heads/'))?.slice('symref=HEAD:refs/heads/'.length);
    }
    const [, sha, ref] = match;
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
    else if (ref.startsWith('refs/tags/') && !ref.endsWith('^{}')) tags++;
  }
  if (!heads.size) throw new ApiError(422, 'SOURCE_EMPTY', 'The source repository has no branches to import.');
  if (heads.size > URL_IMPORT_LIMITS.branches) throw new ApiError(413, 'SOURCE_TOO_LARGE', `Imports support at most ${URL_IMPORT_LIMITS.branches} branches.`);
  if (tags > URL_IMPORT_LIMITS.tags) throw new ApiError(413, 'SOURCE_TOO_LARGE', `Imports support at most ${URL_IMPORT_LIMITS.tags} tags.`);
  const defaultBranch = [symref, 'main', 'master', [...heads.keys()].sort()[0]].find((branch): branch is string => !!branch && heads.has(branch))!;
  if (!validBranchName(defaultBranch)) throw new ApiError(422, 'SOURCE_UNSUPPORTED', 'The source default branch name is not supported.');
  return { defaultBranch, headSha: heads.get(defaultBranch)!, branches: heads.size, tags };
}

export async function discoverSource(source: ImportSource, authorization: string | undefined, fetcher: typeof fetch = fetch): Promise<SourceRefs> {
  let response: Response;
  try {
    response = await fetcher(`${source.url}/info/refs?service=git-upload-pack`, { headers: { accept: 'application/x-git-upload-pack-advertisement', 'user-agent': 'git/2.47.0 gitflare-import', ...(authorization ? { authorization } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(URL_IMPORT_LIMITS.discoveryMs) });
  } catch { throw new ApiError(502, 'SOURCE_UNAVAILABLE', 'The source repository could not be reached.'); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ApiError(422, 'SOURCE_REDIRECT', 'The source redirected the request. Use the repository’s current HTTPS URL.'); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ApiError(422, 'SOURCE_AUTH_REQUIRED', authorization ? 'The source rejected the supplied token. Check its repository read access.' : 'The source requires authentication. Supply a token with repository read access.'); }
  if (response.status === 404) { await response.body?.cancel(); throw new ApiError(404, 'SOURCE_NOT_FOUND', authorization ? 'The source repository was not found or the token cannot read it.' : 'The source repository was not found. Private repositories need a token.'); }
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(502, 'SOURCE_UNAVAILABLE', `The source returned HTTP ${response.status}.`); }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-git-upload-pack-advertisement') { await response.body?.cancel(); throw new ApiError(422, 'SOURCE_NOT_GIT', 'The URL does not serve Git over smart HTTP.'); }
  return parseAdvertisement(await limitedBody(response, URL_IMPORT_LIMITS.advertisementBytes));
}

export function importSourceRequestAllowed(request: Request, props: Pick<ImportSourceProps, 'origin' | 'path'>): boolean {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.origin !== props.origin || url.username || url.password) return false;
  if (request.method === 'GET') return url.pathname === `${props.path}/info/refs` && url.search === '?service=git-upload-pack';
  return request.method === 'POST' && url.pathname === `${props.path}/git-upload-pack` && !url.search;
}

export function capStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) controller.error(new Error('Import source exceeded its size limit'));
      else controller.enqueue(chunk);
    },
  }));
}

export async function proxyImportSource(request: Request, props: ImportSourceProps, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!importSourceRequestAllowed(request, props)) return new Response('Import destination is not allowed', { status: 403 });
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'content-encoding', 'git-protocol', 'user-agent']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  if (props.authorization) headers.set('authorization', props.authorization);
  const response = await fetcher(request.url, { method: request.method, headers, body: request.method === 'POST' ? request.body : undefined, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return new Response('Import source redirects are not allowed', { status: 502 }); }
  const type = response.headers.get('content-type');
  return new Response(response.body ? capStream(response.body, props.maxBytes) : null, { status: response.status, headers: type ? { 'content-type': type } : {} });
}

export interface ImportHost {
  prepare(repositories: GitPermission[]): Promise<void>;
  command(argv: string[], cwd?: string, timeoutMs?: number): Promise<CommandResult>;
  transfer(argv: string[], timeoutMs: number, source?: ImportSourceProps): Promise<CommandResult>;
  destroy(): Promise<void>;
}
export interface ImportProgress { phase: UrlImportPhase; status?: RepositoryUrlImport['status']; headSha?: string | null; branches?: number; tags?: number; packBytes?: number; error?: { code: string; message: string } }
export interface ImportJobDependencies {
  report(job: UrlImportJob, progress: ImportProgress): Promise<void>;
  assertAuthority(job: UrlImportJob): Promise<void>;
  head(job: UrlImportJob): Promise<string | null>;
}

class ImportJobError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const bare = '/workspace/import.git';

function diagnostic(result: CommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(line => line && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Total)/.test(line));
  return lines.slice(-3).join(' ').slice(0, 400);
}

export async function runUrlImportJob(host: ImportHost, deps: ImportJobDependencies, job: UrlImportJob, authorization?: string): Promise<void> {
  try {
    await deps.report(job, { phase: 'preparing' });
    await host.prepare([{ name: job.artifactName, remote: job.remote, write: true }]);
    await deps.report(job, { phase: 'fetching' });
    const init = await host.command(['git', 'init', '--bare', '--quiet', bare], '/workspace', 30_000);
    if (init.exitCode !== 0) throw new ImportJobError('IMPORT_FAILED', 'The import workspace could not be prepared.');
    const fetched = await host.transfer(['git', '-C', bare, '-c', 'http.followRedirects=false', '-c', 'credential.helper=', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', job.source.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], URL_IMPORT_LIMITS.fetchMs, { origin: job.source.origin, path: job.source.path, authorization, maxBytes: URL_IMPORT_LIMITS.packBytes });
    if (fetched.exitCode !== 0) throw new ImportJobError(/size limit/i.test(fetched.stderr) ? 'SOURCE_TOO_LARGE' : 'SOURCE_FETCH_FAILED', `Fetching the source failed. Repositories over ${URL_IMPORT_LIMITS.packBytes / 1024 / 1024} MiB, redirects, and revoked tokens are not supported. ${diagnostic(fetched)}`.trim());
    await deps.report(job, { phase: 'verifying' });
    const counted = await host.command(['git', '-C', bare, 'count-objects', '-v'], '/workspace', 60_000);
    const refs = await host.command(['git', '-C', bare, 'for-each-ref', '--format=%(objectname) %(refname)'], '/workspace', 60_000);
    if (counted.exitCode !== 0 || refs.exitCode !== 0) throw new ImportJobError('IMPORT_FAILED', 'The fetched repository could not be inspected.');
    const kib = (field: string) => Number(new RegExp(`^${field}: (\\d+)$`, 'm').exec(counted.stdout)?.[1] ?? 0);
    const packBytes = (kib('size-pack') + kib('size')) * 1024;
    const entries = refs.stdout.split('\n').map(line => /^([a-f0-9]{40}) (refs\/\S+)$/.exec(line.trim())).filter((entry): entry is RegExpExecArray => !!entry);
    const branches = entries.filter(entry => entry[2].startsWith('refs/heads/')).length, tags = entries.filter(entry => entry[2].startsWith('refs/tags/')).length;
    if (packBytes > URL_IMPORT_LIMITS.packBytes) throw new ImportJobError('SOURCE_TOO_LARGE', `The repository is larger than the ${URL_IMPORT_LIMITS.packBytes / 1024 / 1024} MiB import limit.`);
    if (branches > URL_IMPORT_LIMITS.branches || tags > URL_IMPORT_LIMITS.tags) throw new ImportJobError('SOURCE_TOO_LARGE', `Imports support at most ${URL_IMPORT_LIMITS.branches} branches and ${URL_IMPORT_LIMITS.tags} tags.`);
    const headSha = entries.find(entry => entry[2] === `refs/heads/${job.defaultBranch}`)?.[1];
    if (!headSha) throw new ImportJobError('SOURCE_CHANGED', `The source no longer has its default branch ${job.defaultBranch}.`);
    await deps.assertAuthority(job);
    await deps.report(job, { phase: 'pushing', branches, tags, packBytes });
    const pushed = await host.transfer(['git', '-C', bare, 'push', '--quiet', '--force', job.remote, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'], URL_IMPORT_LIMITS.pushMs);
    if (pushed.exitCode !== 0) throw new ImportJobError('IMPORT_PUSH_FAILED', `Writing the history to Gitflare failed. ${diagnostic(pushed)}`.trim());
    if (await deps.head(job) !== headSha) throw new ImportJobError('IMPORT_UNCONFIRMED', 'The imported default branch could not be confirmed. Retry the import.');
    await deps.report(job, { phase: 'complete', status: 'ready', headSha, branches, tags, packBytes });
  } catch (error) {
    const failure = error instanceof ImportJobError ? { code: error.code, message: error.message } : error instanceof ApiError ? { code: error.code, message: error.message } : { code: 'IMPORT_FAILED', message: error instanceof Error && /deadline/i.test(error.message) ? 'The import exceeded its time limit.' : 'The import stopped unexpectedly. Retry the import.' };
    console.error(JSON.stringify({ event: 'url_import_failed', repositoryId: job.repositoryId, attempt: job.attempt, code: failure.code }));
    await deps.report(job, { phase: 'complete', status: 'failed', error: failure }).catch(() => console.error(JSON.stringify({ event: 'url_import_report_failed', repositoryId: job.repositoryId })));
  }
}

interface StoredImport { job: UrlImportJob; state: 'queued' | 'running' | 'done' }
type ImportStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'setAlarm'>;

export async function beginUrlImportJob(storage: ImportStorage, credentials: Map<string, string>, job: UrlImportJob, authorization?: string): Promise<{ started: boolean }> {
  const current = await storage.get<StoredImport>('url-import');
  if (current && current.state !== 'done') return { started: current.job.id === job.id };
  credentials.clear();
  if (authorization) credentials.set(job.id, authorization);
  await storage.put('url-import', { job, state: 'queued' } satisfies StoredImport);
  await storage.setAlarm(Date.now());
  return { started: true };
}

export async function resumeUrlImportJob(storage: ImportStorage, credentials: Map<string, string>, host: ImportHost, deps: ImportJobDependencies): Promise<void> {
  const record = await storage.get<StoredImport>('url-import');
  if (!record || record.state === 'done') return;
  const authorization = credentials.get(record.job.id);
  credentials.clear();
  const finish = async (error?: { code: string; message: string }) => {
    if (error) await deps.report(record.job, { phase: 'complete', status: 'failed', error }).catch(() => console.error(JSON.stringify({ event: 'url_import_report_failed', repositoryId: record.job.repositoryId })));
    await storage.put('url-import', { ...record, state: 'done' } satisfies StoredImport);
  };
  if (record.state === 'running') { await host.destroy().catch(() => {}); return finish({ code: 'IMPORT_INTERRUPTED', message: 'The import was interrupted. Retry the import.' }); }
  if (record.job.authenticated && !authorization) return finish({ code: 'IMPORT_CREDENTIAL_EXPIRED', message: 'The import restarted after its token was discarded. Retry and supply the token again.' });
  await storage.put('url-import', { ...record, state: 'running' } satisfies StoredImport);
  try { await runUrlImportJob(host, deps, record.job, authorization); }
  finally {
    await host.destroy().catch(() => console.error(JSON.stringify({ event: 'url_import_cleanup_failed', repositoryId: record.job.repositoryId })));
    await finish();
  }
}

interface RepositoryRecords { getRepository(id: string): Promise<Repository | undefined>; saveRepository(repository: Repository): Promise<void> }
export interface UrlImportEnv {
  ARTIFACTS?: ArtifactsBinding;
  GITFLARE_COORDINATOR?: { getByName(name: string): RepositoryRecords };
  GITFLARE_SECURITY?: { getByName(name: string): { check(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void> } };
}

function catalogName(workspaceId: string) { return workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${workspaceId}`; }

export function importJobDependencies(env: UrlImportEnv): ImportJobDependencies {
  return {
    async report(job, progress) {
      if (!env.GITFLARE_COORDINATOR) throw new Error('Repository records are not configured');
      const now = new Date().toISOString();
      for (const name of [catalogName(job.workspaceId), `repository:${job.repositoryId}`]) {
        const records = env.GITFLARE_COORDINATOR.getByName(name);
        const repository = await records.getRepository(job.repositoryId);
        if (!repository?.urlImport || repository.urlImport.attempt !== job.attempt || repository.urlImport.status !== 'importing') continue;
        const { headSha, status, ...fields } = progress;
        await records.saveRepository({
          ...repository,
          ...(headSha !== undefined ? { headSha } : {}),
          urlImport: { ...repository.urlImport, ...fields, status: status ?? 'importing', updatedAt: now, ...(status ? { completedAt: now } : {}) },
          updatedAt: now,
        });
      }
    },
    async assertAuthority(job) {
      if (!env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.');
      await env.GITFLARE_SECURITY.getByName('security').check(job.principal, 'manage');
    },
    async head(job) {
      if (!env.ARTIFACTS) return null;
      return repositoryHead(env.ARTIFACTS, job.artifactName, job.defaultBranch);
    },
  };
}

interface Catalog {
  getRepository(id: string): Promise<Repository | undefined>;
  saveRepository(repository: Repository): Promise<void>;
  createRepository(key: string, repository: Repository): Promise<Repository>;
  claimProvision(id: string): Promise<boolean>;
}
interface ImportAccess {
  authorize(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>;
  rateLimit(key: string, max?: number, windowMs?: number): Promise<void>;
}
export interface UrlImportContext {
  env: { ARTIFACTS?: ArtifactsBinding; SANDBOX?: { getByName(name: string): { beginUrlImport(job: UrlImportJob, authorization?: string): Promise<{ started: boolean }> } } };
  principal: Principal;
  access: ImportAccess;
  catalog: Catalog;
  repositoryRecords(id: string): { saveRepository(repository: Repository): Promise<void> };
  fetcher?: typeof fetch;
}

const ROUTE = /^\/api\/repositories\/(?:import-url|([a-zA-Z0-9-]+)\/import-url(?:\/(retry))?)$/;

async function saveEverywhere(context: UrlImportContext, repository: Repository): Promise<void> {
  await context.catalog.saveRepository(repository);
  await context.repositoryRecords(repository.id).saveRepository(repository);
}

async function dispatch(context: UrlImportContext, repository: Repository, authorization?: string): Promise<Response> {
  const job: UrlImportJob = { id: `${repository.id}:${repository.urlImport!.attempt}`, repositoryId: repository.id, workspaceId: context.principal.workspaceId, artifactName: repository.name, remote: repository.remote!, defaultBranch: repository.defaultBranch, source: parseImportUrl(repository.urlImport!.source), attempt: repository.urlImport!.attempt, authenticated: !!authorization, principal: context.principal };
  let started = false;
  try { started = (await context.env.SANDBOX!.getByName(`url-import:${repository.id}`).beginUrlImport(job, authorization)).started; }
  catch { started = false; }
  if (!started) {
    const failed: Repository = { ...repository, urlImport: { ...repository.urlImport!, status: 'failed', phase: 'complete', error: { code: 'IMPORT_START_FAILED', message: 'The import job could not start. Retry the import.' }, updatedAt: new Date().toISOString() } };
    await saveEverywhere(context, failed);
    return Response.json(failed, { status: 202 });
  }
  return Response.json(repository, { status: 202 });
}

export async function handleUrlImport(request: Request, url: URL, context: UrlImportContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, repositoryId, retry] = match;
  const { principal, access, catalog, env } = context;
  if (request.method === 'GET' && repositoryId && !retry) {
    const repository = await catalog.getRepository(repositoryId);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'read', 'repository', repository.id);
    return Response.json({ repositoryId: repository.id, defaultBranch: repository.defaultBranch, headSha: repository.headSha, urlImport: repository.urlImport ?? null });
  }
  if (request.method !== 'POST' || (repositoryId && !retry)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported import operation.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request);
  if (!env.ARTIFACTS || !env.SANDBOX) throw new ApiError(503, 'IMPORT_NOT_CONFIGURED', 'Connect Artifacts and the container sandbox before importing from a URL.');
  if (retry) {
    const repository = await catalog.getRepository(repositoryId);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'manage', 'repository', repository.id);
    const current = repository.urlImport;
    if (!current || !repository.remote) throw new ApiError(409, 'NOT_URL_IMPORT', 'This repository was not imported from a URL.');
    if (current.requestId === key) return Response.json(repository, { status: 202 });
    if (current.status === 'importing') throw new ApiError(409, 'IMPORT_IN_PROGRESS', 'This import is still running.');
    if (current.status === 'ready') throw new ApiError(409, 'IMPORT_COMPLETE', 'This import already finished.');
    await access.rateLimit(`url-import:${principal.userId}`, 20, 3_600_000);
    const source = parseImportUrl(current.source, [url.hostname]);
    const authorization = importAuthorization(source, body.token, body.username);
    await discoverSource(source, authorization, context.fetcher);
    const now = new Date().toISOString();
    const next: Repository = { ...repository, urlImport: { ...current, status: 'importing', phase: 'queued', attempt: current.attempt + 1, requestId: key, authenticated: !!authorization, startedAt: now, updatedAt: now, completedAt: undefined, error: undefined }, updatedAt: now };
    await saveEverywhere(context, next);
    return dispatch(context, next, authorization);
  }
  await access.authorize(principal, 'manage');
  const input = urlImportInput(body, [url.hostname]);
  if (principal.workspaceId === 'legacy' && /^w-[a-f0-9]{32}-/.test(input.name)) throw new ApiError(403, 'RESERVED_NAMESPACE', 'This repository prefix is reserved for isolated workspaces.');
  await access.rateLimit(`url-import:${principal.userId}`, 20, 3_600_000);
  const refs = await discoverSource(input.source, input.authorization, context.fetcher);
  const name = principal.workspaceId === 'legacy' ? input.name : repositoryName(`w-${principal.workspaceId.replace(/-/g, '')}-${input.name.slice(0, 29)}`);
  const now = new Date().toISOString();
  let repository = await catalog.createRepository(key, {
    id: crypto.randomUUID(), workspaceId: principal.workspaceId, name, description: input.description, defaultBranch: refs.defaultBranch, headSha: null, provider: 'artifacts', createdAt: now, updatedAt: now,
    urlImport: { source: input.source.url, provider: input.source.provider, status: 'importing', phase: 'queued', attempt: 1, requestId: key, authenticated: !!input.authorization, startedAt: now, updatedAt: now },
  });
  repository = await catalog.getRepository(repository.id) ?? repository;
  const pending = repository.urlImport;
  if (!pending) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key belongs to another repository creation.');
  if (repository.remote) return Response.json(repository, { status: 202 });
  if (!await catalog.claimProvision(repository.id)) throw new ApiError(409, 'PROVISIONING_PENDING', 'This repository is being provisioned or needs reconciliation after an interrupted request. Its creation will not be repeated.');
  try {
    const provisioned = await createArtifactsRepository(env, { name, description: input.description, defaultBranch: repository.defaultBranch });
    repository = { ...repository, remote: provisioned.remote, updatedAt: new Date().toISOString() };
  } catch {
    const failed: Repository = { ...repository, urlImport: { ...pending, status: 'failed', phase: 'complete', error: { code: 'PROVISIONING_INTERRUPTED', message: 'Repository storage could not be created.' }, updatedAt: new Date().toISOString() } };
    await saveEverywhere(context, failed);
    throw new ApiError(503, 'PROVISIONING_INTERRUPTED', 'Repository provisioning did not finish. Inspect its Artifacts state before retrying to avoid creating duplicate resources.');
  }
  await saveEverywhere(context, repository);
  return dispatch(context, repository, input.authorization);
}
