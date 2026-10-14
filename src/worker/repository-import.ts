import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { deflateSync, inflateRawSync } from 'node:zlib';
import type { Repository } from '../shared/types';
import type { ArtifactRepo, ArtifactsBinding } from './artifacts';
import { ApiError, requireString } from './domain';
import { boundedBody, buildInitializationPack, packet, parsePackets, requireGitResponse } from './repository-initialization';

export const IMPORT_ZIP_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_REQUEST_MAX_BYTES = Math.ceil(IMPORT_ZIP_MAX_BYTES / 3) * 4 + 2048;
export const IMPORT_EXPANDED_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_FILE_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_FILES = 500;
const zero = '0'.repeat(40);
export interface ImportFile { path: string; data: Uint8Array; mode: '100644' | '100755' }
export interface ImportInput { archiveBase64: string; expectedHeadSha: string | null; message: string }
export interface ImportStatus { allowed: boolean; headSha: string | null; reason: string; branch: string; remote: string | null }
export interface ImportResult { repository: Repository; headSha: string; files: string[]; skipped: string[] }
export interface ImportReceipt { fingerprint: string; timestamp: number; candidateSha?: string; files?: string[]; skipped?: string[]; rejection?: { status: number; code: string; message: string }; result?: ImportResult }
export function validateImportInput(body: Record<string, unknown>): ImportInput {
  if (body.expectedHeadSha !== null && (typeof body.expectedHeadSha !== 'string' || !/^[a-f0-9]{40}$/.test(body.expectedHeadSha))) throw new ApiError(400, 'INVALID_COMMIT', 'Supply the observed repository head, or null for an empty repository.');
  const archiveBase64 = requireString(body.archiveBase64, 'ZIP archive', Math.ceil(IMPORT_ZIP_MAX_BYTES / 3) * 4);
  if (archiveBase64.length % 4 || !isCanonicalBase64(archiveBase64)) throw new ApiError(400, 'INVALID_ARCHIVE', 'The ZIP archive must use standard base64 encoding.');
  const message = body.message === undefined ? 'Import existing code' : requireString(body.message, 'Commit message', 200);
  if (/[\r\n\u0000-\u001f\u007f]/.test(message)) throw new ApiError(400, 'INVALID_IMPORT_MESSAGE', 'Use a single line commit message.');
  return { archiveBase64, expectedHeadSha: body.expectedHeadSha as string | null, message };
}
function isCanonicalBase64(value: string): boolean {
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - pad;
  for (let i = 0; i < end; i++) {
    const c = value.charCodeAt(i);
    if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47)) return false;
  }
  return true;
}
export function importFingerprint(input: ImportInput): string { return createHash('sha256').update(Buffer.from(input.archiveBase64, 'base64')).update(JSON.stringify([input.expectedHeadSha, input.message])).digest('hex'); }
function invalid(message: string): never { throw new ApiError(400, 'INVALID_ARCHIVE', message); }
function limit(message: string): never { throw new ApiError(413, 'ARCHIVE_LIMIT', message); }
function safePath(path: string): string {
  if (!path || path.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) invalid('ZIP paths must be relative and contain no backslashes or control characters.');
  const parts = path.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) invalid('ZIP paths must not contain empty, dot or parent segments.');
  return path;
}
function omitted(path: string): boolean {
  const parts = path.split('/');
  return parts.some(part => ['.git', '.gitflare', 'node_modules', '__MACOSX', '.DS_Store', '__pycache__', '.pytest_cache', '.cache', '.next', '.nuxt', '.turbo', '.output', '.venv', 'venv', 'dist', 'build', 'coverage'].includes(part) || part === '.env' || part.startsWith('.env.') && part !== '.env.example' || /^(id_rsa|id_ed25519|credentials\.json)$/i.test(part) || /\.(pem|key)$/i.test(part));
}
export function crc32(data: Uint8Array): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
export function parseImportArchive(base64: string): { files: ImportFile[]; skipped: string[] } {
  const zip = Buffer.from(base64, 'base64');
  if (zip.length > IMPORT_ZIP_MAX_BYTES) limit('ZIP archives must be at most 5 MiB.');
  if (zip.length < 22) invalid('Upload a complete ZIP archive.');
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) if (zip.readUInt32LE(offset) === 0x06054b50 && offset + 22 + zip.readUInt16LE(offset + 20) === zip.length) { end = offset; break; }
  if (end < 0) invalid('The ZIP directory is missing or truncated.');
  const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12), centralStart = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count || count === 65535 || centralSize === 0xffffffff || centralStart === 0xffffffff || centralStart + centralSize !== end) invalid('Multi-disk and ZIP64 archives are unsupported.');
  if (count > 1000) limit('ZIP archives may contain at most 1000 entries and 500 files.');
  const entries: (ImportFile & { directory: boolean })[] = []; const seen = new Set<string>(); const ranges: [number, number][] = []; let cursor = centralStart, expanded = 0, fileCount = 0;
  const extra = (start: number, length: number) => { const last = start + length; while (start < last) { if (start + 4 > last) invalid('Malformed ZIP extra field.'); const id = zip.readUInt16LE(start), size = zip.readUInt16LE(start + 2); start += 4; if (id === 1 || start + size > last) invalid('ZIP64 or malformed ZIP extra fields are unsupported.'); start += size; } };
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) invalid('Malformed ZIP directory entry.');
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), checksum = zip.readUInt32LE(cursor + 16), packed = zip.readUInt32LE(cursor + 20), size = zip.readUInt32LE(cursor + 24), nameSize = zip.readUInt16LE(cursor + 28), extraSize = zip.readUInt16LE(cursor + 30), commentSize = zip.readUInt16LE(cursor + 32), local = zip.readUInt32LE(cursor + 42);
    const unixMode = zip.readUInt32LE(cursor + 38) >>> 16, fileType = unixMode & 0xf000;
    if (flags & ~0x808 || ![0, 8].includes(method) || packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff || zip.readUInt16LE(cursor + 34)) invalid('Encrypted, unsupported compression and ZIP64 entries are unsupported.');
    if (fileType && ![0x4000, 0x8000].includes(fileType)) invalid('ZIP symlinks and special files are unsupported.');
    if (cursor + 46 + nameSize + extraSize + commentSize > end) invalid('Truncated ZIP filename.');
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!(flags & 0x800) && [...rawName].some(byte => byte > 127)) invalid('Non-ASCII ZIP filenames must use UTF-8.');
    let path: string; try { path = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch { invalid('ZIP filenames must be valid UTF-8.'); }
    safePath(path!); const directory = path!.endsWith('/'); const normalized = path!.replace(/\/$/, '');
    if (seen.has(normalized)) invalid('ZIP archives must not contain duplicate paths.'); seen.add(normalized);
    if (fileType === 0x4000 && !directory || directory && fileType === 0x8000) invalid('ZIP file type and path disagree.');
    extra(cursor + 46 + nameSize, extraSize);
    cursor += 46 + nameSize + extraSize + commentSize;
    if (size > IMPORT_FILE_MAX_BYTES) limit('Each ZIP file must be at most 1 MiB.');
    expanded += size; if (expanded > IMPORT_EXPANDED_MAX_BYTES) limit('Expanded ZIP content must be at most 10 MiB.');
    if (!directory && ++fileCount > IMPORT_MAX_FILES) limit('ZIP archives must contain at most 500 files.');
    if (local + 30 > centralStart || zip.readUInt32LE(local) !== 0x04034b50) invalid('Malformed ZIP local entry.');
    const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28), contentStart = local + 30 + localName + localExtra;
    if (zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method || localName !== rawName.length || !zip.subarray(local + 30, local + 30 + localName).equals(rawName) || contentStart + packed > centralStart) invalid('ZIP local metadata differs from its directory.');
    extra(local + 30 + localName, localExtra);
    if (!(flags & 8) && (zip.readUInt32LE(local + 14) !== checksum || zip.readUInt32LE(local + 18) !== packed || zip.readUInt32LE(local + 22) !== size)) invalid('ZIP local sizes or checksum disagree.');
    let data: Buffer; try { data = method === 0 ? Buffer.from(zip.subarray(contentStart, contentStart + packed)) : inflateRawSync(zip.subarray(contentStart, contentStart + packed), { maxOutputLength: IMPORT_FILE_MAX_BYTES }); } catch { invalid('ZIP decompression failed or exceeded its declared limit.'); }
    if (data!.length !== size || crc32(data!) !== checksum || directory && size) invalid('ZIP checksum or expanded size is invalid.');
    let localEnd = contentStart + packed;
    if (flags & 8) { if (localEnd + 4 > centralStart) invalid('ZIP data descriptor is truncated.'); const descriptor = zip.readUInt32LE(localEnd) === 0x08074b50 ? localEnd + 4 : localEnd; if (descriptor + 12 > centralStart || zip.readUInt32LE(descriptor) !== checksum || zip.readUInt32LE(descriptor + 4) !== packed || zip.readUInt32LE(descriptor + 8) !== size) invalid('ZIP data descriptor is invalid.'); localEnd = descriptor + 12; }
    ranges.push([local, localEnd]);
    entries.push({ path: normalized, data: new Uint8Array(data!), mode: unixMode & 0o111 ? '100755' : '100644', directory });
  }
  if (cursor !== end) invalid('ZIP directory size is invalid.');
  ranges.sort((a, b) => a[0] - b[0]); if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) invalid('ZIP entries overlap.');
  const filesOnly = entries.filter(entry => !entry.directory); const filePaths = new Set(filesOnly.map(entry => entry.path));
  for (const entry of entries) { const parts = entry.path.split('/'); for (let index = 1; index < parts.length; index++) if (filePaths.has(parts.slice(0, index).join('/'))) invalid('ZIP files cannot also be parent folders.'); }
  const meaningful = filesOnly.filter(entry => !entry.path.startsWith('__MACOSX/'));
  const wrapper = meaningful.length && meaningful.every(entry => entry.path.includes('/') && entry.path.split('/')[0] === meaningful[0].path.split('/')[0]) ? meaningful[0].path.split('/')[0] : null;
  const files: ImportFile[] = [], skipped: string[] = [];
  for (const entry of filesOnly) { const path = wrapper && entry.path.startsWith(`${wrapper}/`) ? entry.path.slice(wrapper.length + 1) : entry.path; if (omitted(entry.path) || omitted(path)) skipped.push(entry.path); else files.push({ path, data: entry.data, mode: entry.mode }); }
  if (!files.length) invalid('The ZIP archive has no importable files.');
  return { files, skipped };
}

type GitObject = { type: 'blob' | 'tree' | 'commit'; data: Buffer; hash: Buffer };
export function buildImportPack(files: ImportFile[], parentSha: string | null, timestamp: number, message: string): { pack: Uint8Array; commitSha: string } {
  const objects: GitObject[] = [];
  const object = (type: GitObject['type'], data: Buffer) => { const value = { type, data, hash: createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest() }; objects.push(value); return value; };
  type Tree = { files: Map<string, ImportFile>; children: Map<string, Tree> };
  const root: Tree = { files: new Map(), children: new Map() };
  for (const file of files) { safePath(file.path); const parts = file.path.split('/'); let current = root; for (const part of parts.slice(0, -1)) { if (current.files.has(part)) invalid('Import paths conflict.'); if (!current.children.has(part)) current.children.set(part, { files: new Map(), children: new Map() }); current = current.children.get(part)!; } const name = parts.at(-1)!; if (current.children.has(name) || current.files.has(name)) invalid('Import paths conflict.'); current.files.set(name, file); }
  const tree = (node: Tree): GitObject => { const entries: { name: string; mode: string; hash: Buffer; sort: string }[] = []; for (const [name, file] of node.files) entries.push({ name, mode: file.mode, hash: object('blob', Buffer.from(file.data)).hash, sort: name }); for (const [name, child] of node.children) entries.push({ name, mode: '40000', hash: tree(child).hash, sort: `${name}/` }); entries.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort))); return object('tree', Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), entry.hash])))); };
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || parentSha !== null && !/^[a-f0-9]{40}$/.test(parentSha)) throw new ApiError(400, 'INVALID_IMPORT', 'Import commit metadata is invalid.');
  const rootTree = tree(root);
  const commit = object('commit', Buffer.from(`tree ${rootTree.hash.toString('hex')}\n${parentSha ? `parent ${parentSha}\n` : ''}author Gitflare <gitflare@localhost> ${timestamp} +0000\ncommitter Gitflare <gitflare@localhost> ${timestamp} +0000\n\n${message}\n`));
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const body = Buffer.concat([header, ...objects.map(value => { let size = value.data.length; const type = { commit: 1, tree: 2, blob: 3 }[value.type]; const bytes = [type << 4 | size & 15]; size = Math.floor(size / 16); if (size) bytes[0] |= 128; while (size) { const byte = size & 127; size = Math.floor(size / 128); bytes.push(byte | (size ? 128 : 0)); } return Buffer.concat([Buffer.from(bytes), deflateSync(value.data)]); })]);
  return { pack: new Uint8Array(Buffer.concat([body, createHash('sha1').update(body).digest()])), commitSha: commit.hash.toString('hex') };
}

function remoteDetails(info: { remote: string; defaultBranch: string }): { base: string; ref: string } {
  const remote = new URL(info.remote); const branch = info.defaultBranch;
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(part => part.endsWith('.lock'))) throw new ApiError(502, 'IMPORT_REMOTE', 'Artifacts returned an invalid remote or default branch.');
  return { base: remote.href.replace(/\/$/, ''), ref: `refs/heads/${branch}` };
}
async function advertisedRefs(repository: ArtifactRepo, scope: 'read' | 'write', service: 'git-upload-pack' | 'git-receive-pack', fetcher: typeof fetch): Promise<{ refs: Map<string, string>; capabilities: Set<string> }> {
  const { base } = remoteDetails(await repository.info());
  const token = await repository.createToken(scope, 60);
  try { return await discoverRefs(base, service, token.plaintext, fetcher); }
  finally { await repository.revokeToken(token.plaintext); }
}
async function discoverRefs(base: string, service: string, token: string, fetcher: typeof fetch) {
  const response = await fetcher(`${base}/info/refs?service=${service}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  requireGitResponse(response, `application/x-${service}-advertisement`);
  const lines = parsePackets(await boundedBody(response));
  if (lines[0] !== `# service=${service}\n` || lines[1] !== '') throw new ApiError(502, 'IMPORT_PROTOCOL', 'Git returned an invalid service advertisement.');
  const refs = new Map<string, string>(), capabilities = new Set<string>();
  for (const line of lines.slice(2).filter(Boolean)) { const [advertisement, text] = line.trimEnd().split('\0'); const match = /^([a-f0-9]{40}) (.+)$/.exec(advertisement); if (!match) throw new ApiError(502, 'IMPORT_PROTOCOL', 'Git returned an invalid reference advertisement.'); if (match[1] !== zero) { if (refs.has(match[2])) throw new ApiError(502, 'IMPORT_PROTOCOL', 'Git returned duplicate references.'); refs.set(match[2], match[1]); } else if (match[2] !== 'capabilities^{}') throw new ApiError(502, 'IMPORT_PROTOCOL', 'Git returned an invalid empty reference.'); for (const value of text?.split(' ') ?? []) capabilities.add(value); }
  if ([...capabilities].some(value => value.startsWith('object-format=') && value !== 'object-format=sha1')) throw new ApiError(502, 'IMPORT_PROTOCOL', 'Git must use SHA-1 object identifiers.');
  return { refs, capabilities };
}
function requireOnlyDefault(refs: Map<string, string>, ref: string, sha: string | null): boolean { return [...refs].every(([name, value]) => (name === ref || name === 'HEAD') && value === sha) && (refs.get(ref) ?? null) === sha; }
async function bootstrapFiles(source: ArtifactRepo, repository: Repository, knownBootstrapSha?: string): Promise<ImportFile[] | null> {
  const commits = await source.log({ ref: repository.defaultBranch, limit: 2 });
  const commit = commits[0];
  if (!commit || commits.length !== 1 || commit.message.trim() !== 'Initialize repository') return null;
  const tree = await source.readTree(commit.treeHash);
  if (!tree?.length || tree.length > 3 || tree.some(entry => entry.type !== 'blob' || entry.mode !== '100644' || !['README.md', '.gitignore', 'LICENSE'].includes(entry.name))) return null;
  const files: ImportFile[] = []; const text: Record<string, string> = {};
  for (const entry of tree) { const blob = await source.readFile({ ref: commit.hash, path: entry.name }); if (!blob || blob.size > 16384) return null; const data = new Uint8Array(await blob.arrayBuffer()); try { text[entry.name] = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; } files.push({ path: entry.name, data, mode: '100644' }); }
  if (knownBootstrapSha === commit.hash) return files;
  const start = Math.floor(Date.parse(repository.createdAt) / 1000), end = Math.min(start + 300, Math.floor(Date.parse(repository.updatedAt) / 1000));
  for (let timestamp = start; timestamp <= end; timestamp++) if (buildInitializationPack(text, new Date(timestamp * 1000)).commitSha === commit.hash) return files;
  return null;
}
export async function inspectRepositoryImport(artifacts: ArtifactsBinding | undefined, repository: Repository, knownBootstrapSha?: string, fetcher: typeof fetch = fetch): Promise<ImportStatus & { bootstrap: ImportFile[] }> {
  const unavailable: ImportStatus & { bootstrap: ImportFile[] } = { allowed: false, headSha: repository.headSha, reason: 'Connect an Artifacts repository before importing code.', branch: repository.defaultBranch, remote: repository.remote ?? null, bootstrap: [] };
  if (!artifacts || repository.provider !== 'artifacts') return unavailable;
  using source = await artifacts.get(repository.name); const info = await source.info(); const { ref } = remoteDetails(info);
  if (info.defaultBranch !== repository.defaultBranch || repository.remote && info.remote !== repository.remote) throw new ApiError(409, 'IMPORT_REMOTE_CHANGED', 'Repository remote or default branch changed. Reconnect before importing.');
  const headSha = (await source.log({ ref: repository.defaultBranch, limit: 1 }))[0]?.hash ?? null;
  const { refs } = await advertisedRefs(source, 'read', 'git-upload-pack', fetcher);
  const bootstrap = headSha ? await bootstrapFiles(source, repository, knownBootstrapSha) : [];
  const allowed = requireOnlyDefault(refs, ref, headSha) && bootstrap !== null;
  return { allowed, headSha, reason: allowed ? headSha ? 'Existing code can be imported onto the untouched initial repository commit.' : 'This empty repository is ready for existing code.' : 'This repository already contains established code or other references. Use a proposal to review further changes.', branch: repository.defaultBranch, remote: info.remote, bootstrap: bootstrap ?? [] };
}
export class RepositoryImportFailure extends ApiError {
  constructor(readonly outcome: 'not_pushed' | 'unknown', error: unknown) {
    super(outcome === 'not_pushed' && error instanceof ApiError ? error.status : 503, outcome === 'not_pushed' && error instanceof ApiError ? error.code : 'IMPORT_UNCONFIRMED', outcome === 'not_pushed' && error instanceof ApiError ? error.message : outcome === 'not_pushed' ? 'Import stopped before a canonical write. Try again with a new request.' : 'The import write has an uncertain outcome. Retry the same request to reconcile its canonical commit.');
  }
}
export async function pushRepositoryImport(artifacts: ArtifactsBinding, repository: Repository, expectedHeadSha: string | null, built: { pack: Uint8Array; commitSha: string }, assertAuthority: () => Promise<unknown>, fetcher: typeof fetch = fetch): Promise<void> {
  using source = await artifacts.get(repository.name); const info = await source.info(); const { base, ref } = remoteDetails(info);
  if (info.defaultBranch !== repository.defaultBranch || repository.remote && info.remote !== repository.remote) throw new ApiError(409, 'IMPORT_REMOTE_CHANGED', 'Repository remote or default branch changed.');
  let token: { plaintext: string } | undefined; let attempted = false;
  try {
    token = await source.createToken('write', 60);
    const { refs, capabilities } = await discoverRefs(base, 'git-receive-pack', token.plaintext, fetcher);
    if (!requireOnlyDefault(refs, ref, expectedHeadSha)) throw new ApiError(409, 'STALE_IMPORT_HEAD', 'The repository changed before import. Refresh its current commit.');
    if (!capabilities.has('report-status')) throw new ApiError(502, 'IMPORT_PROTOCOL', 'Git does not support receive status.');
    await assertAuthority();
    const command = packet(`${expectedHeadSha ?? zero} ${built.commitSha} ${ref}\0report-status\n`);
    attempted = true;
    const response = await fetcher(`${base}/git-receive-pack`, { method: 'POST', headers: { authorization: `Bearer ${token.plaintext}`, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: new Uint8Array(Buffer.concat([command, Buffer.from('0000'), built.pack])), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    requireGitResponse(response, 'application/x-git-receive-pack-result');
    const status = parsePackets(await boundedBody(response)).filter(Boolean).map(line => line.trimEnd());
    if (status.length === 2 && status[1].startsWith(`ng ${ref} `)) throw new RepositoryImportFailure('not_pushed', new ApiError(409, 'IMPORT_REJECTED', 'Git rejected the import without updating its branch. Refresh before retrying.'));
    if (status.length !== 2 || status[0] !== 'unpack ok' || status[1] !== `ok ${ref}`) throw new ApiError(409, 'IMPORT_REJECTED', 'Git rejected the import. Refresh repository state before continuing.');
    if ((await source.log({ ref: repository.defaultBranch, limit: 1 }))[0]?.hash !== built.commitSha) throw new ApiError(503, 'IMPORT_UNCONFIRMED', 'Import has no confirmed canonical commit yet. Retry the same request to inspect its outcome.');
  } catch (error) { throw error instanceof RepositoryImportFailure ? error : new RepositoryImportFailure(attempted ? 'unknown' : 'not_pushed', error); }
  finally { if (token) await source.revokeToken(token.plaintext); }
}
