import type { CommandResult } from '../../runner/sandbox';
import type { CloudflareCall, CloudflareCallInit } from './cloudflare-deploy';
import { ApiError } from './domain';
import { WorkerBuildFailure, type BundleSandbox } from './worker-bundle';

export const MAX_ASSET_SIZE = 25 * 1024 * 1024;
export const MAX_ASSET_COUNT = 20_000;
export const MAX_ASSETS_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_ASSET_PATH_LENGTH = 1024;
export const MAX_ASSET_CONFIG_BYTES = 1024 * 1024;
export const MAX_UPLOAD_ATTEMPTS = 5;
const UPLOAD_REQUEST_BYTES = 10 * 1024 * 1024;
// Multiple of 3 so base64 chunks concatenate into the base64 of the whole file
const READ_CHUNK_BYTES = 6 * 1024 * 1024;
const READ_BATCH_BYTES = 7 * 1024 * 1024;
// Linux caps a single argv string (the bash -lc script) at 128 KiB
const READ_BATCH_PATH_CHARS = 48 * 1024;
const MANIFEST_OUTPUT_CAP = 16 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 60_000;
const SENTINEL = 'GITFLARE_WORKER_ASSETS ';

export interface AssetsOptions { directory: string; binding?: string; html_handling?: string; not_found_handling?: string; run_worker_first?: boolean | string[]; base_path?: string }
export interface AssetManifest { files: Record<string, { hash: string; size: number }>; redirects?: string; headers?: string; hashAlgorithm: 'blake3' | 'sha256'; totalBytes: number }

export const ASSETS_IGNORE_SOURCE = String.raw`
function createIgnore(lines) {
  const special = /[.*+?^$(){}|[\]\\\/]/;
  const literal = (c) => special.test(c) ? '\\' + c : c;
  const rules = [];
  for (const raw of lines) {
    let line = String(raw).replace(/(\\?)\s+$/, (_, escaped) => escaped ? '\\ ' : '');
    if (!line || line[0] === '#') continue;
    let negate = false;
    if (line[0] === '!') { negate = true; line = line.slice(1); }
    let dirOnly = false;
    while (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes('/');
    if (line[0] === '/') line = line.slice(1);
    if (!line) continue;
    let source = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*' && line[i + 1] === '*' && (i === 0 || line[i - 1] === '/') && (i + 2 === line.length || line[i + 2] === '/')) {
        if (i + 2 === line.length) { source += '.*'; i += 1; } else { source += '(?:.*/)?'; i += 2; }
      } else if (c === '*') {
        while (line[i + 1] === '*') i++;
        source += '[^/]*';
      } else if (c === '?') source += '[^/]';
      else if (c === '\\' && i + 1 < line.length) source += literal(line[++i]);
      else if (c === '[') {
        const end = line.indexOf(']', i + 2);
        if (end === -1) { source += '\\['; continue; }
        let body = line.slice(i + 1, end);
        const negated = body[0] === '!' || body[0] === '^';
        if (negated) body = body.slice(1);
        source += '[' + (negated ? '^' : '') + body.replace(/[\\\]]/g, '\\$&') + ']';
        i = end;
      } else source += literal(c);
    }
    try { rules.push({ negate, dirOnly, regex: new RegExp((anchored ? '^' : '^(?:.*/)?') + source + '$') }); } catch {}
  }
  const test = (path, dir) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.negate !== ignored || (rule.dirOnly && !dir)) continue;
      if (rule.regex.test(path)) ignored = !rule.negate;
    }
    return ignored;
  };
  return (path, isDir = false) => {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) if (test(parts.slice(0, i).join('/'), i < parts.length || isDir)) return true;
    return false;
  };
}
`;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const RESOLVE_DIRECTORY = String.raw`
const fail = (code, message) => { process.stderr.write(message + '\n'); process.exit(code); };
const root = realpathSync(process.cwd());
let dir;
try { dir = realpathSync(join(root, process.argv[1])); } catch { fail(69, 'The assets directory ' + process.argv[1] + ' does not exist.'); }
if (dir !== root && !dir.startsWith(root + sep)) fail(70, 'The assets directory ' + process.argv[1] + ' must be inside the repository.');
if (!lstatSync(dir).isDirectory()) fail(69, 'The assets directory ' + process.argv[1] + ' is not a directory.');
`;

const MANIFEST_PROGRAM = String.raw`
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { extname, join, relative, sep } from 'node:path';
${RESOLVE_DIRECTORY}
${ASSETS_IGNORE_SOURCE}
let hashAlgorithm = 'blake3';
let digest;
try {
  const wrangler = createRequire(join(dir, 'noop.js')).resolve('wrangler/package.json');
  const blake3 = createRequire(wrangler)('blake3-wasm');
  digest = (data) => blake3.hash(data).toString('hex');
} catch {
  hashAlgorithm = 'sha256';
  digest = (data) => createHash('sha256').update(data).digest('hex');
}
const optional = (name) => {
  let stat;
  try { stat = lstatSync(join(dir, name)); } catch { return undefined; }
  if (!stat.isFile()) return undefined;
  if (stat.size > ${MAX_ASSET_CONFIG_BYTES}) fail(72, name + ' is larger than ${MAX_ASSET_CONFIG_BYTES / 1024 / 1024} MiB.');
  return readFileSync(join(dir, name), 'utf8');
};
const assetsIgnore = optional('.assetsignore');
const ignored = createIgnore(['/.assetsignore', '/_redirects', '/_headers', ...(assetsIgnore === undefined ? [] : assetsIgnore.split('\n'))]);
const entries = [];
let totalBytes = 0;
const walk = (path) => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    const rel = relative(dir, full).split(sep).join('/');
    if (entry.isSymbolicLink()) continue;
    const isDir = entry.isDirectory();
    if (ignored(rel, isDir)) continue;
    if (isDir) { walk(full); continue; }
    if (!entry.isFile()) continue;
    if (assetsIgnore === undefined && rel.startsWith('_worker.js')) fail(71, 'The assets directory contains the Pages Worker /' + rel + ', which would expose server-side code. Remove it or list it in .assetsignore; an empty .assetsignore uploads it.');
    if (rel.length + 1 > ${MAX_ASSET_PATH_LENGTH}) fail(73, 'Asset path /' + rel.slice(0, 200) + '... is longer than ${MAX_ASSET_PATH_LENGTH} characters.');
    const size = lstatSync(full).size;
    if (size > ${MAX_ASSET_SIZE}) fail(66, 'Asset /' + rel + ' is ' + (size / 1048576).toFixed(1) + ' MiB; Workers static assets are limited to ${MAX_ASSET_SIZE / 1024 / 1024} MiB per file.');
    if (entries.length >= ${MAX_ASSET_COUNT}) fail(67, 'The assets directory has more than ${MAX_ASSET_COUNT} files.');
    totalBytes += size;
    if (totalBytes > ${MAX_ASSETS_TOTAL_BYTES}) fail(68, 'The assets directory exceeds ${MAX_ASSETS_TOTAL_BYTES / 1024 / 1024} MiB in total.');
    entries.push(['/' + rel, { hash: digest(readFileSync(full).toString('base64') + extname(full).slice(1)).slice(0, 32), size }]);
  }
};
walk(dir);
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const output = { files: Object.fromEntries(entries), redirects: optional('_redirects'), headers: optional('_headers'), hashAlgorithm, totalBytes };
process.stdout.write('${SENTINEL}' + JSON.stringify(output) + '\n');
`;

const READ_PROGRAM = String.raw`
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
${RESOLVE_DIRECTORY}
const paths = JSON.parse(process.argv[2]);
const range = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const files = {};
for (const path of paths) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) fail(74, 'Invalid asset path.');
  const full = join(dir, path.slice(1));
  let real;
  try { real = realpathSync(full); } catch { fail(74, 'Asset ' + path + ' no longer exists.'); }
  if (!real.startsWith(dir + sep) || !lstatSync(full).isFile()) fail(74, 'Asset ' + path + ' is not a regular file in the assets directory.');
  if (!range) { files[path] = readFileSync(full).toString('base64'); continue; }
  const buffer = Buffer.alloc(range.length);
  const fd = openSync(full, 'r');
  const read = readSync(fd, buffer, 0, range.length, range.offset);
  closeSync(fd);
  files[path] = buffer.subarray(0, read).toString('base64');
}
process.stdout.write('${SENTINEL}' + JSON.stringify({ files }) + '\n');
`;

export function assetManifestScript(directory: string): string {
  return `node --input-type=module -e ${quote(MANIFEST_PROGRAM)} ${quote(directory)}`;
}

export function assetReadScript(directory: string, paths: string[], range?: { offset: number; length: number }): string {
  return `node --input-type=module -e ${quote(READ_PROGRAM)} ${quote(directory)} ${quote(JSON.stringify(paths))}${range ? ` ${quote(JSON.stringify(range))}` : ''}`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function sentinelPayload(stdout: string): unknown {
  const line = stdout.split('\n').reverse().find((value) => value.startsWith(SENTINEL));
  if (!line) throw new WorkerBuildFailure('WORKER_ASSETS_OUTPUT_INVALID', 'The static assets step did not report its output.');
  try { return JSON.parse(line.slice(SENTINEL.length)); }
  catch { throw new WorkerBuildFailure('WORKER_ASSETS_OUTPUT_INVALID', 'The static assets step reported malformed output.'); }
}

export function validAssetPath(path: string): boolean {
  return path.length >= 2 && path.length <= MAX_ASSET_PATH_LENGTH && path.startsWith('/') && !path.includes('\0') && !path.includes('\\')
    && path.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function parseAssetManifest(stdout: string): AssetManifest {
  const value = sentinelPayload(stdout);
  const invalid = (detail: string) => new WorkerBuildFailure('WORKER_ASSETS_OUTPUT_INVALID', `The static assets manifest is invalid: ${detail}`);
  if (!record(value) || !record(value.files)) throw invalid('missing files.');
  if (value.hashAlgorithm !== 'blake3' && value.hashAlgorithm !== 'sha256') throw invalid('unknown hash algorithm.');
  const entries = Object.entries(value.files);
  if (entries.length > MAX_ASSET_COUNT) throw new WorkerBuildFailure('WORKER_ASSETS_TOO_MANY', `The assets directory has more than ${MAX_ASSET_COUNT} files.`);
  const files: AssetManifest['files'] = {};
  let totalBytes = 0;
  for (const [path, entry] of entries) {
    if (!validAssetPath(path)) throw invalid(`bad path ${JSON.stringify(path.slice(0, 120))}.`);
    if (!record(entry) || typeof entry.hash !== 'string' || !/^[a-f0-9]{32}$/.test(entry.hash)) throw invalid(`bad hash for ${path.slice(0, 120)}.`);
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ASSET_SIZE) throw invalid(`bad size for ${path.slice(0, 120)}.`);
    files[path] = { hash: entry.hash, size: entry.size };
    totalBytes += entry.size;
  }
  if (totalBytes > MAX_ASSETS_TOTAL_BYTES) throw new WorkerBuildFailure('WORKER_ASSETS_TOO_LARGE', `The assets directory exceeds ${MAX_ASSETS_TOTAL_BYTES / 1024 / 1024} MiB in total.`);
  const config = (name: 'redirects' | 'headers') => {
    const text = value[name];
    if (text === undefined) return {};
    if (typeof text !== 'string' || text.length > MAX_ASSET_CONFIG_BYTES) throw invalid(`bad _${name}.`);
    return { [name]: text };
  };
  return { files, ...config('redirects'), ...config('headers'), hashAlgorithm: value.hashAlgorithm, totalBytes };
}

const MIME_TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', shtml: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'application/node',
  json: 'application/json', map: 'application/json', jsonld: 'application/ld+json', webmanifest: 'application/manifest+json', xml: 'application/xml',
  xsl: 'application/xml', xslt: 'application/xslt+xml', xhtml: 'application/xhtml+xml', rss: 'application/rss+xml', atom: 'application/atom+xml',
  txt: 'text/plain', text: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  ics: 'text/calendar', yaml: 'text/yaml', yml: 'text/yaml', toml: 'application/toml', vtt: 'text/vtt', jsx: 'text/jsx', srt: 'application/x-subrip',
  wasm: 'application/wasm', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', rtf: 'application/rtf',
  epub: 'application/epub+zip', bin: 'application/octet-stream', exe: 'application/octet-stream', dmg: 'application/octet-stream',
  svg: 'image/svg+xml', svgz: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/vnd.microsoft.icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', apng: 'image/apng', jxl: 'image/jxl', ktx2: 'image/ktx2',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/x-flac',
  aac: 'audio/aac', weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi',
  mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp', ts: 'video/mp2t',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', usdz: 'model/vnd.usdz+zip', swf: 'application/x-shockwave-flash',
};

// Mirrors mime@4 getType as used by Wrangler: dotless and dot-only names have no type
export function assetContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  const type = dot > 0 ? MIME_TYPES[name.slice(dot + 1)] : undefined;
  if (!type) return 'application/null';
  return type.startsWith('text/') ? `${type}; charset=utf-8` : type;
}

export function assetUploadConfig(options: AssetsOptions, manifest: AssetManifest, _compatibility?: { date: string; flags: string[] }): Record<string, unknown> {
  const config: Record<string, unknown> = {
    html_handling: options.html_handling,
    not_found_handling: options.not_found_handling,
    base_path: options.base_path,
    run_worker_first: options.run_worker_first,
    _redirects: manifest.redirects,
    _headers: manifest.headers,
  };
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

export function singleAssetUploadMode(jwt: string): boolean {
  try {
    const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).wrangler_single_asset_uploads === true;
  } catch { return false; }
}

const base64Length = (size: number) => Math.ceil(size / 3) * 4;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(attempt: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempts = 1; ; attempts++) {
    try { return await attempt(); }
    catch (error) {
      const permanent = error instanceof ApiError && error.status === 403;
      if (permanent || attempts >= MAX_UPLOAD_ATTEMPTS) {
        const detail = error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);
        throw new WorkerBuildFailure('WORKER_ASSETS_UPLOAD_FAILED', `Uploading static assets failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${detail}`);
      }
      await sleep(2 ** (attempts - 1) * 1000);
    }
  }
}

interface PendingAsset { hash: string; path: string; size: number }

function splitBySize(bucket: PendingAsset[]): PendingAsset[][] {
  const groups: PendingAsset[][] = [];
  let group: PendingAsset[] = [];
  let bytes = 0;
  for (const asset of bucket) {
    const size = base64Length(asset.size);
    if (group.length && bytes + size > UPLOAD_REQUEST_BYTES) { groups.push(group); group = []; bytes = 0; }
    group.push(asset);
    bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export async function uploadAssets(input: { call: CloudflareCall; accountId: string; workerName: string; manifest: AssetManifest; read(paths: string[]): Promise<Record<string, string>>; sleep?(ms: number): Promise<void> }): Promise<{ jwt: string; uploaded: number; total: number }> {
  const { call, accountId, workerName, manifest } = input;
  const sleep = input.sleep ?? defaultSleep;
  const total = Object.keys(manifest.files).length;
  const session = await call<{ jwt?: unknown; buckets?: unknown } | null>(`/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`, { method: 'POST', json: { manifest: manifest.files } });
  if (!record(session) || typeof session.jwt !== 'string' || !session.jwt) throw new WorkerBuildFailure('WORKER_ASSETS_UPLOAD_FAILED', 'Cloudflare did not start an asset upload session.');
  const sessionJwt = session.jwt;
  const byHash = new Map<string, PendingAsset>();
  for (const [path, entry] of Object.entries(manifest.files)) if (!byHash.has(entry.hash)) byHash.set(entry.hash, { hash: entry.hash, path, size: entry.size });
  const buckets = (Array.isArray(session.buckets) ? session.buckets : []).map((bucket) => (Array.isArray(bucket) ? bucket : []).map((hash) => {
    const asset = typeof hash === 'string' ? byHash.get(hash) : undefined;
    if (!asset) throw new WorkerBuildFailure('WORKER_ASSETS_UNKNOWN_HASH', 'Cloudflare requested an asset that is not in the manifest.');
    return asset;
  })).filter((bucket) => bucket.length);
  if (!buckets.length) return { jwt: sessionJwt, uploaded: 0, total };
  const single = singleAssetUploadMode(sessionJwt);
  const requests = single ? buckets.flat().map((asset) => [asset]) : buckets.flatMap(splitBySize);
  let completion = '';
  let uploaded = 0;
  for (const group of requests) {
    const contents = await input.read(group.map((asset) => asset.path));
    for (const asset of group) {
      const content = contents[asset.path];
      if (typeof content !== 'string' || content.length !== base64Length(asset.size)) throw new WorkerBuildFailure('WORKER_ASSETS_READ_FAILED', `Asset ${asset.path.slice(0, 200)} changed or could not be read during upload.`);
    }
    const send = (): Promise<{ jwt?: unknown } | null> => {
      if (single) {
        const [asset] = group;
        const init = { method: 'POST', bearer: sessionJwt, headers: { 'Content-Type': assetContentType(asset.path) }, body: decodeBase64(contents[asset.path]) } satisfies CloudflareCallInit;
        return call(`/accounts/${accountId}/workers/assets/upload/${asset.hash}`, init);
      }
      const form = new FormData();
      for (const asset of group) form.append(asset.hash, new File([contents[asset.path]], asset.hash, { type: assetContentType(asset.path) }), asset.hash);
      return call(`/accounts/${accountId}/workers/assets/upload`, { method: 'POST', form, query: { base64: 'true' }, bearer: sessionJwt });
    };
    const result = await withRetry(send, sleep);
    if (record(result) && typeof result.jwt === 'string' && result.jwt) completion = result.jwt;
    uploaded += group.length;
  }
  if (!completion) throw new WorkerBuildFailure('WORKER_ASSETS_UPLOAD_FAILED', 'Cloudflare did not confirm the asset upload. Try again.');
  return { jwt: completion, uploaded, total };
}

function failureDetail(result: CommandResult): string {
  return (result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(-500);
}

const MANIFEST_FAILURES: Record<number, string> = {
  66: 'WORKER_ASSET_TOO_LARGE',
  67: 'WORKER_ASSETS_TOO_MANY',
  68: 'WORKER_ASSETS_TOO_LARGE',
  69: 'WORKER_ASSETS_DIRECTORY_MISSING',
  70: 'WORKER_ASSETS_DIRECTORY_INVALID',
  71: 'WORKER_ASSETS_PAGES_WORKER',
  72: 'WORKER_ASSETS_CONFIG_TOO_LARGE',
  73: 'WORKER_ASSET_PATH_INVALID',
};

async function collectFiles(collect: NonNullable<BundleSandbox['collect']>, directory: string, paths: string[], bytes: number, range?: { offset: number; length: number }): Promise<Record<string, string>> {
  const script = assetReadScript(directory, paths, range);
  const result = await collect(script, READ_TIMEOUT_MS, base64Length(bytes) + script.length + 65_536);
  if (result.exitCode !== 0) throw new WorkerBuildFailure('WORKER_ASSETS_READ_FAILED', `Static assets could not be read. ${failureDetail(result)}`);
  const payload = sentinelPayload(result.stdout);
  if (!record(payload) || !record(payload.files)) throw new WorkerBuildFailure('WORKER_ASSETS_OUTPUT_INVALID', 'The static assets step reported malformed output.');
  const files: Record<string, string> = {};
  for (const path of paths) {
    const content = payload.files[path];
    if (typeof content !== 'string') throw new WorkerBuildFailure('WORKER_ASSETS_READ_FAILED', `Asset ${path.slice(0, 200)} could not be read.`);
    files[path] = content;
  }
  return files;
}

export async function collectAndUploadAssets(sandbox: BundleSandbox, input: { call: CloudflareCall; accountId: string; workerName: string; options: AssetsOptions; sleep?(ms: number): Promise<void> }): Promise<{ jwt: string; config: Record<string, unknown>; uploaded: number; total: number; hashAlgorithm: string; totalBytes: number }> {
  if (!sandbox.collect) throw new WorkerBuildFailure('WORKER_BUILD_UNAVAILABLE', 'The runner cannot collect static assets.');
  const collect = (script: string, timeoutMs: number, capBytes: number) => sandbox.collect!(script, timeoutMs, capBytes);
  const { directory } = input.options;
  const result = await collect(assetManifestScript(directory), MANIFEST_TIMEOUT_MS, MANIFEST_OUTPUT_CAP);
  if (result.exitCode !== 0) throw new WorkerBuildFailure(MANIFEST_FAILURES[result.exitCode] ?? 'WORKER_ASSETS_MANIFEST_FAILED', `Static assets in ${directory} could not be prepared. ${failureDetail(result)}`);
  const manifest = parseAssetManifest(result.stdout);
  const read = async (paths: string[]): Promise<Record<string, string>> => {
    const files: Record<string, string> = {};
    let batch: string[] = [];
    let bytes = 0;
    let chars = 0;
    const flush = async () => {
      if (batch.length) Object.assign(files, await collectFiles(collect, directory, batch, bytes));
      batch = []; bytes = 0; chars = 0;
    };
    for (const path of paths) {
      const size = manifest.files[path]?.size ?? 0;
      if (size > READ_CHUNK_BYTES) {
        const chunks: string[] = [];
        for (let offset = 0; offset < size; offset += READ_CHUNK_BYTES) {
          const length = Math.min(READ_CHUNK_BYTES, size - offset);
          chunks.push((await collectFiles(collect, directory, [path], length, { offset, length }))[path]);
        }
        files[path] = chunks.join('');
        continue;
      }
      const pathChars = JSON.stringify(path).length + 1;
      if (bytes + size > READ_BATCH_BYTES || chars + pathChars > READ_BATCH_PATH_CHARS) await flush();
      batch.push(path); bytes += size; chars += pathChars;
    }
    await flush();
    return files;
  };
  const upload = await uploadAssets({ call: input.call, accountId: input.accountId, workerName: input.workerName, manifest, read, sleep: input.sleep });
  return { ...upload, config: assetUploadConfig(input.options, manifest), hashAlgorithm: manifest.hashAlgorithm, totalBytes: manifest.totalBytes };
}
