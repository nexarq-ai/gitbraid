import type { BranchInfo, BranchRule, Repository } from '../shared/types';
import type { ArtifactRepo, ArtifactsBinding } from './artifacts';
import { evaluatePush, ruleFor, ZERO_SHA, type PushDecision, type RefUpdate } from './branch-protection';
import { rateLimitMessage, type GitRateLimits, type RateLimited } from './rate-limits';
import type { Action, Principal } from './security';

export const GIT_PUSH_MAX_BYTES = 104_857_600;
export const GIT_FETCH_REQUEST_MAX_BYTES = 10_485_760;
export const GIT_COMMANDS_MAX_BYTES = 65_536;
const MAX_REF_UPDATES = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const challenge = { 'WWW-Authenticate': 'Basic realm="Gitflare", charset="UTF-8"' };

export interface GitHttpDependencies {
  authenticate(token: string): Promise<Principal>;
  authorize(principal: Principal, action: Action, repositoryId: string): Promise<void>;
  repository(principal: Principal, name: string): Promise<Repository | undefined>;
  rules(repository: Repository): Promise<BranchRule[]>;
  artifacts?: ArtifactsBinding;
  fetcher?: typeof fetch;
  limits?: GitRateLimits;
}

export class GitProtocolError extends Error {}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

function rejectedTokens(limited: RateLimited): Response {
  return text(429, `Too many rejected Gitflare tokens from this address. Wait ${limited.retryAfterSeconds} seconds, then retry with a valid personal token.`, { 'Retry-After': String(limited.retryAfterSeconds) });
}

export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const line = new Uint8Array(bytes.length + 4);
  line.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')));
  line.set(bytes, 4);
  return line;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function parseReceivePackCommands(bytes: Uint8Array): { updates: RefUpdate[]; capabilities: string[]; end: number } | null {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new GitProtocolError('invalid pkt-line length');
    const length = parseInt(header, 16);
    if (length === 0) {
      if (!updates.length) throw new GitProtocolError('no ref updates were sent');
      return { updates, capabilities, end: offset + 4 };
    }
    if (length < 5) throw new GitProtocolError('invalid pkt-line length');
    if (offset + length > bytes.length) return null;
    const line = decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, '');
    offset += length;
    if (line.startsWith('shallow ')) continue;
    if (line.startsWith('push-cert')) throw new GitProtocolError('signed pushes are not supported');
    const [command, capabilityText] = line.split('\0');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\0\s]{1,240})$/.exec(command);
    if (!match || /[\x00-\x1f\x7f~^:?[\\]/.test(match[3])) throw new GitProtocolError('invalid ref update command');
    if (!updates.length && capabilityText !== undefined) capabilities = capabilityText.split(' ').filter(Boolean);
    else if (capabilityText !== undefined) throw new GitProtocolError('capabilities are only allowed on the first command');
    if (match[1] === ZERO_SHA && match[2] === ZERO_SHA) throw new GitProtocolError('invalid ref update command');
    updates.push({ oldSha: match[1], newSha: match[2], ref: match[3] });
    if (updates.length > MAX_REF_UPDATES) throw new GitProtocolError(`push at most ${MAX_REF_UPDATES} refs at once`);
  }
  return null;
}

export async function readReceivePackCommands(reader: ReadableStreamDefaultReader<Uint8Array>, limit = GIT_COMMANDS_MAX_BYTES): Promise<{ updates: RefUpdate[]; capabilities: string[]; prefix: Uint8Array<ArrayBuffer> }> {
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  for (;;) {
    const parsed = parseReceivePackCommands(buffer);
    if (parsed) return { updates: parsed.updates, capabilities: parsed.capabilities, prefix: buffer };
    if (buffer.length > limit) throw new GitProtocolError('ref update commands are too large');
    const next = await reader.read();
    if (next.done) throw new GitProtocolError('the push request ended before its ref update commands');
    buffer = concat([buffer, next.value]);
  }
}

export function receivePackReport(decisions: PushDecision[], capabilities: string[]): Uint8Array<ArrayBuffer> {
  const rejected = decisions.find(decision => !decision.ok);
  const report = concat([pktLine('unpack ok\n'), ...decisions.map(decision => pktLine(`ng ${decision.ref} ${decision.ok ? `not updated because ${rejected && !rejected.ok ? rejected.ref : 'another ref'} was rejected` : decision.reason}\n`)), encoder.encode('0000')]);
  const band = capabilities.includes('side-band-64k') ? 65_515 : capabilities.includes('side-band') ? 995 : 0;
  if (!band) return report;
  const message = decisions.filter((decision): decision is Extract<PushDecision, { ok: false }> => !decision.ok).map(decision => `Gitflare rejected ${decision.ref}: ${decision.reason}\n`).join('');
  const packets = [pktLine(concat([Uint8Array.of(2), encoder.encode(message.slice(0, band))]))];
  for (let offset = 0; offset < report.length; offset += band) packets.push(pktLine(concat([Uint8Array.of(1), report.subarray(offset, offset + band)])));
  return concat([...packets, encoder.encode('0000')]);
}

function suppliedToken(request: Request): string | undefined {
  const header = request.headers.get('Authorization');
  if (!header) return undefined;
  if (header.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  if (!header.startsWith('Basic ')) return undefined;
  let decoded: string;
  try { decoded = decoder.decode(Uint8Array.from(atob(header.slice(6).trim()), character => character.charCodeAt(0))); } catch { return undefined; }
  const separator = decoded.indexOf(':');
  const value = separator < 0 ? decoded : decoded.slice(separator + 1) || decoded.slice(0, separator);
  return value && value.length <= 1024 ? value : undefined;
}

function decodedBody(request: Request): ReadableStream<Uint8Array> {
  if (!request.body) throw new GitProtocolError('the request has no body');
  const encoding = request.headers.get('Content-Encoding')?.toLowerCase();
  if (!encoding || encoding === 'identity') return request.body;
  if (encoding === 'gzip' || encoding === 'x-gzip') return request.body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  throw new GitProtocolError('unsupported request encoding');
}

function limitedStream(prefix: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let size = prefix.length;
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) { started = true; if (prefix.length) { controller.enqueue(prefix); return; } }
      const next = await reader.read();
      if (next.done) { controller.close(); return; }
      size += next.value.length;
      if (size > limit) { await reader.cancel(); controller.error(new GitProtocolError('push exceeds the size limit')); return; }
      controller.enqueue(next.value);
    },
    async cancel() { await reader.cancel(); },
  });
}

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > limit) { await reader.cancel(); throw new GitProtocolError('request exceeds the size limit'); }
    chunks.push(next.value);
  }
  return concat(chunks);
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): Promise<void> {
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
    size += next.value.length;
    if (size > limit) { await reader.cancel(); return; }
  }
}

const HEAD_REWRITE_MAX_BYTES = 4_194_304;

function packets(bytes: Uint8Array): Uint8Array[] | null {
  const result: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return null;
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) return null;
    const length = parseInt(header, 16);
    if (length === 3) return null;
    const size = length < 4 ? 4 : length;
    if (offset + size > bytes.length) return null;
    result.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return result;
}

export function rewriteAdvertisedHead(bytes: Uint8Array<ArrayBuffer>, defaultBranch: string): Uint8Array<ArrayBuffer> {
  const lines = packets(bytes);
  if (!lines) return bytes;
  const target = `refs/heads/${defaultBranch}`;
  const payload = (line: Uint8Array) => line.length > 4 ? decoder.decode(line.subarray(4)) : null;
  const sha = lines.map(payload).map(text => text && /^([0-9a-f]{40}) (\S+)/.exec(text.split('\0')[0]!)).find(match => match?.[2] === target)?.[1];
  if (!sha) return bytes;
  const rewritten = lines.map(line => {
    const text = payload(line);
    if (!text) return line;
    const newline = text.endsWith('\n') ? '\n' : '';
    const [ref, capabilities] = text.slice(0, text.length - newline.length).split('\0');
    const head = /^[0-9a-f]{40} HEAD((?: \S+)*)$/.exec(ref!);
    if (!head) return line;
    const attributes = head[1]!.replace(/ symref-target:\S+/, ` symref-target:${target}`);
    const advertised = capabilities === undefined ? '' : `\0${capabilities.replace(/(^| )symref=HEAD:\S+/, `$1symref=HEAD:${target}`)}`;
    return pktLine(`${sha} HEAD${attributes}${advertised}${newline}`);
  });
  return concat(rewritten);
}

async function withAdvertisedHead(body: ReadableStream<Uint8Array>, defaultBranch: string): Promise<BodyInit> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) return rewriteAdvertisedHead(concat(chunks), defaultBranch);
    chunks.push(next.value);
    size += next.value.length;
    if (size > HEAD_REWRITE_MAX_BYTES) return new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
      async pull(controller) { const more = await reader.read(); if (more.done) controller.close(); else controller.enqueue(more.value); },
      cancel() { return reader.cancel(); },
    });
  }
}

export function isLsRefsRequest(bytes: Uint8Array): boolean {
  const first = packets(bytes)?.[0];
  return !!first && first.length > 4 && decoder.decode(first.subarray(4)).replace(/\n$/, '') === 'command=ls-refs';
}

function remoteBase(remote: string): string {
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Artifacts returned an invalid remote');
  return url.href.replace(/\/$/, '');
}

async function forward(source: ArtifactRepo, service: 'git-upload-pack' | 'git-receive-pack', kind: 'refs' | 'rpc', request: Request, body: BodyInit | undefined, fetcher: typeof fetch, headBranch?: string): Promise<Response> {
  const base = remoteBase((await source.info()).remote);
  const token = await source.createToken(service === 'git-receive-pack' ? 'write' : 'read', 60);
  const headers = new Headers({ Authorization: `Bearer ${token.plaintext}`, 'User-Agent': 'gitflare-git-proxy' });
  const protocol = request.headers.get('Git-Protocol');
  if (protocol && /^version=[12]$/.test(protocol)) headers.set('Git-Protocol', protocol);
  if (kind === 'rpc') { headers.set('Content-Type', `application/x-${service}-request`); headers.set('Accept', `application/x-${service}-result`); }
  const upstream = await fetcher(kind === 'refs' ? `${base}/info/refs?service=${service}` : `${base}/${service}`, { method: kind === 'refs' ? 'GET' : 'POST', headers, body, redirect: 'manual' });
  const expected = kind === 'refs' ? `application/x-${service}-advertisement` : `application/x-${service}-result`;
  if (!upstream.ok || upstream.headers.get('Content-Type')?.split(';')[0]?.trim() !== expected) {
    await upstream.body?.cancel();
    return text(502, 'Gitflare could not reach the repository storage. Try again shortly.');
  }
  const advertised = headBranch && upstream.body ? await withAdvertisedHead(upstream.body, headBranch) : upstream.body;
  return new Response(advertised, { status: 200, headers: { 'Content-Type': expected, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleGitRequest(request: Request, deps: GitHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/git/')) return null;
  const match = /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return text(404, `Clone with ${url.origin}/git/<repository>.git`);
  const service = match[2] === 'info/refs' ? url.searchParams.get('service') : match[2];
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return text(403, 'Gitflare supports smart HTTP Git clients only.');
  const kind = match[2] === 'info/refs' ? 'refs' : 'rpc';
  if (request.method !== (kind === 'refs' ? 'GET' : 'POST')) return text(405, 'This Git operation uses a different HTTP method.');
  const token = suppliedToken(request);
  if (!token) return text(401, 'Authenticate with a Gitflare personal token as the password. Create one in Settings → Account.', challenge);
  const client = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const blocked = deps.limits?.blocked(client);
  if (blocked) return rejectedTokens(blocked);
  let principal: Principal;
  try { principal = await deps.authenticate(token); }
  catch {
    const limited = await deps.limits?.failure(client);
    if (limited) return rejectedTokens(limited);
    return text(401, 'The Gitflare token was not accepted. Create a new personal token in Settings → Account.', challenge);
  }
  const limited = await deps.limits?.credential(principal);
  if (limited) return text(429, rateLimitMessage(limited, 'Git requests'), { 'Retry-After': String(limited.retryAfterSeconds) });
  const repository = await deps.repository(principal, match[1]);
  if (!repository) return text(404, 'This repository was not found in your Gitflare workspace.');
  if (repository.provider !== 'artifacts' || !deps.artifacts) return text(409, 'This repository is not connected to Git storage.');
  const writing = service === 'git-receive-pack';
  try { await deps.authorize(principal, writing ? 'contribute' : 'read', repository.id); }
  catch { return text(403, writing ? 'Your Gitflare role cannot push to this repository. Ask an Owner for Contributor access.' : 'Your Gitflare role cannot read this repository.'); }
  const fetcher = deps.fetcher ?? fetch;
  using source = await deps.artifacts.get(repository.name);
  // Artifacts has no API to move HEAD, so clients see Repository.defaultBranch instead
  if (kind === 'refs') return await forward(source, service, 'refs', request, undefined, fetcher, writing ? undefined : repository.defaultBranch);
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== `application/x-${service}-request`) return text(415, 'Use a Git client for this request.');
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (!writing) {
    if (declared > GIT_FETCH_REQUEST_MAX_BYTES) return text(413, 'This fetch request is too large.');
    try {
      const commands = await boundedBytes(decodedBody(request), GIT_FETCH_REQUEST_MAX_BYTES);
      return await forward(source, service, 'rpc', request, commands, fetcher, isLsRefsRequest(commands) ? repository.defaultBranch : undefined);
    }
    catch (error) { if (error instanceof GitProtocolError) return text(400, `Invalid Git request: ${error.message}.`); throw error; }
  }
  if (declared > GIT_PUSH_MAX_BYTES) return text(413, `Pushes are limited to ${GIT_PUSH_MAX_BYTES / 1_048_576} MiB. Push fewer commits at once.`);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let parsed: Awaited<ReturnType<typeof readReceivePackCommands>>;
  try { reader = decodedBody(request).getReader(); parsed = await readReceivePackCommands(reader); }
  catch (error) { if (error instanceof GitProtocolError) return text(400, `Invalid Git push: ${error.message}.`); throw error; }
  const rules = await deps.rules(repository);
  const touchesProtected = parsed.updates.some(update => update.ref.startsWith('refs/heads/') && ruleFor(rules, update.ref.slice(11), repository.defaultBranch));
  const canLand = touchesProtected && await deps.authorize(principal, 'land', repository.id).then(() => true, () => false);
  const decisions = evaluatePush(parsed.updates, { rules, defaultBranch: repository.defaultBranch, role: principal.role, canLand });
  if (decisions.some(decision => !decision.ok)) {
    await drain(reader, GIT_PUSH_MAX_BYTES);
    if (!parsed.capabilities.includes('report-status') && !parsed.capabilities.includes('report-status-v2')) return text(403, decisions.filter(decision => !decision.ok).map(decision => `${decision.ref}: ${(decision as { reason: string }).reason}`).join('\n'));
    return new Response(receivePackReport(decisions, parsed.capabilities), { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-store' } });
  }
  return await forward(source, service, 'rpc', request, limitedStream(parsed.prefix, reader, GIT_PUSH_MAX_BYTES), fetcher);
}

export function parseAdvertisedRefs(bytes: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) throw new GitProtocolError('invalid reference advertisement');
    if (length === 0) { offset += 4; continue; }
    if (length < 4 || offset + length > bytes.length) throw new GitProtocolError('invalid reference advertisement');
    const line = decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, '').split('\0')[0];
    offset += length;
    const ref = /^([0-9a-f]{40}) (refs\/heads\/\S+)$/.exec(line);
    if (ref && ref[1] !== ZERO_SHA) refs.set(ref[2].slice('refs/heads/'.length), ref[1]);
  }
  return refs;
}

export async function listBranches(artifacts: ArtifactsBinding, repository: Repository, rules: BranchRule[], fetcher: typeof fetch = fetch): Promise<BranchInfo[]> {
  using source = await artifacts.get(repository.name);
  const base = remoteBase((await source.info()).remote);
  const token = await source.createToken('read', 60);
  let refs: Map<string, string>;
  try {
    const response = await fetcher(`${base}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${token.plaintext}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new GitProtocolError('reference discovery failed'); }
    refs = parseAdvertisedRefs(await boundedBytes(response.body ?? new ReadableStream(), 4_194_304));
  } finally { await source.revokeToken(token.plaintext).catch(() => false); }
  const defaultLog = refs.has(repository.defaultBranch) ? (await source.log({ ref: repository.defaultBranch, limit: 200 })).map(commit => commit.hash) : [];
  const defaultIndex = new Map(defaultLog.map((hash, index) => [hash, index]));
  const names = [...refs.keys()].sort((a, b) => a === repository.defaultBranch ? -1 : b === repository.defaultBranch ? 1 : a.localeCompare(b)).slice(0, 500);
  return Promise.all(names.map(async (name, index): Promise<BranchInfo> => {
    const info: BranchInfo = { name, headSha: refs.get(name)!, protected: !!ruleFor(rules, name, repository.defaultBranch), default: name === repository.defaultBranch };
    if (info.default || index > 20 || !defaultLog.length) return info;
    const history = (await source.log({ ref: info.headSha, limit: 200 }).catch(() => [])).map(commit => commit.hash);
    const ahead = history.findIndex(hash => defaultIndex.has(hash));
    return ahead < 0 ? info : { ...info, ahead, behind: defaultIndex.get(history[ahead]!)! };
  }));
}
