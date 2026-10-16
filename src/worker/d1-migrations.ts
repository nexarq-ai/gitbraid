import { ApiError } from './domain';
import type { CloudflareCall } from './cloudflare-deploy';
import { WorkerBuildFailure, type BundleSandbox } from './worker-bundle';

export const D1_MIGRATIONS_TABLE = 'd1_migrations';
export const D1_MIGRATIONS_MAX_FILES = 500;
export const D1_MIGRATIONS_MAX_BYTES = 5 * 1024 * 1024;
const SENTINEL = 'GITFLARE_D1_MIGRATIONS ';

export interface D1MigrationDatabase { binding: string; databaseName: string; databaseId?: string; directory: string; table: string; optional?: boolean }
export interface D1MigrationFile { name: string; sql: string }
export interface D1MigrationSet extends D1MigrationDatabase { files: D1MigrationFile[] }
export interface D1MigrationEvidence { binding: string; databaseName: string; databaseId: string; table: string; pending: string[]; applied: string[]; failed?: { name: string; error: string } }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const migrationsPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
export const migrationsTablePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function migrationDatabases(d1Databases: unknown): D1MigrationDatabase[] {
  if (!Array.isArray(d1Databases)) return [];
  const databases: D1MigrationDatabase[] = [];
  for (const entry of d1Databases) {
    if (!record(entry) || typeof entry.migrations_dir !== 'string') continue;
    if (entry.migrations_pattern !== undefined) throw new WorkerBuildFailure('D1_MIGRATIONS_PATTERN_UNSUPPORTED', `D1 binding ${String(entry.binding)} sets migrations_pattern, which Gitflare does not apply yet. Use the default <migrations_dir>/*.sql layout.`);
    if (typeof entry.binding !== 'string' || typeof entry.database_name !== 'string') throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', 'A D1 database with migrations_dir needs binding and database_name.');
    const directory = entry.migrations_dir.replace(/\/+$/, '') || '.';
    if (directory !== '.' && !migrationsPathPattern.test(directory)) throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', `D1 binding ${entry.binding} has a migrations_dir outside the repository.`);
    const table = typeof entry.migrations_table === 'string' ? entry.migrations_table : D1_MIGRATIONS_TABLE;
    if (!migrationsTablePattern.test(table)) throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', `D1 binding ${entry.binding} has an unsupported migrations_table name.`);
    databases.push({ binding: entry.binding, databaseName: entry.database_name, ...(typeof entry.database_id === 'string' ? { databaseId: entry.database_id } : {}), directory, table });
  }
  return databases;
}

const leadingNumber = (name: string) => parseInt(name.split('/')[0].split('_')[0], 10);

export function compareMigrationNames(a: string, b: string): number {
  const left = leadingNumber(a);
  const right = leadingNumber(b);
  if (left !== right && !(Number.isNaN(left) && Number.isNaN(right))) {
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    if (Number.isFinite(left)) return -1;
    if (Number.isFinite(right)) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const PROGRAM = `
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const directories = JSON.parse(process.argv[1]);
let total = 0;
let count = 0;
const result = {};
for (const directory of directories) {
  let names;
  try { names = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name); }
  catch { result[directory] = null; continue; }
  result[directory] = names.map((name) => {
    const size = statSync(join(directory, name)).size;
    total += size; count += 1;
    if (total > ${D1_MIGRATIONS_MAX_BYTES} || count > ${D1_MIGRATIONS_MAX_FILES}) { process.stderr.write('D1_MIGRATIONS_TOO_LARGE'); process.exit(66); }
    return { name, sql: readFileSync(join(directory, name), 'utf8') };
  });
}
process.stdout.write('${SENTINEL}' + JSON.stringify(result) + '\\n');
`;

export function d1MigrationsScript(directories: string[]): string {
  return `node --input-type=module -e ${quote(PROGRAM)} ${quote(JSON.stringify(directories))}`;
}

export function parseMigrationFiles(stdout: string, databases: D1MigrationDatabase[]): D1MigrationSet[] {
  const line = stdout.split('\n').reverse().find((value) => value.startsWith(SENTINEL));
  let value: unknown;
  try { value = line ? JSON.parse(line.slice(SENTINEL.length)) : undefined; } catch { value = undefined; }
  if (!record(value)) throw new WorkerBuildFailure('D1_MIGRATIONS_OUTPUT_INVALID', 'The D1 migration files could not be read.');
  return databases.map((database) => {
    const files = value[database.directory];
    if ((files === null || files === undefined) && database.optional) return { ...database, files: [] };
    if (files === null || files === undefined) throw new WorkerBuildFailure('D1_MIGRATIONS_DIRECTORY_MISSING', `No migrations present at ${database.directory} for D1 binding ${database.binding}.`);
    if (!Array.isArray(files)) throw new WorkerBuildFailure('D1_MIGRATIONS_OUTPUT_INVALID', 'The D1 migration files could not be read.');
    const parsed = files.filter((file): file is D1MigrationFile => record(file) && typeof file.name === 'string' && /^[A-Za-z0-9._@+-]{1,200}\.sql$/.test(file.name) && typeof file.sql === 'string');
    if (parsed.length !== files.length) throw new WorkerBuildFailure('D1_MIGRATIONS_OUTPUT_INVALID', `D1 migrations for ${database.binding} include an unsupported file name.`);
    return { ...database, files: parsed.sort((a, b) => compareMigrationNames(a.name, b.name)) };
  });
}

export async function readMigrationFiles(sandbox: BundleSandbox, databases: D1MigrationDatabase[]): Promise<D1MigrationSet[]> {
  if (!databases.length) return [];
  if (!sandbox.collect) throw new WorkerBuildFailure('WORKER_BUILD_UNAVAILABLE', 'The runner cannot read D1 migrations.');
  const result = await sandbox.collect(d1MigrationsScript([...new Set(databases.map((database) => database.directory))]), 60_000, Math.ceil(D1_MIGRATIONS_MAX_BYTES * 1.2) + 65_536);
  if (result.exitCode === 66) throw new WorkerBuildFailure('D1_MIGRATIONS_TOO_LARGE', `D1 migrations exceed ${D1_MIGRATIONS_MAX_FILES} files or ${D1_MIGRATIONS_MAX_BYTES / 1024 / 1024} MiB.`);
  if (result.exitCode !== 0) throw new WorkerBuildFailure('D1_MIGRATIONS_OUTPUT_INVALID', 'The D1 migration files could not be read.');
  return parseMigrationFiles(result.stdout, databases);
}

const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function createMigrationsTableQuery(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${identifier(table)}(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
}

export function listMigrationsQuery(table: string): string {
  return `SELECT *
		FROM ${identifier(table)}
		ORDER BY id`;
}

export function normalizeSqlLineEndings(sql: string): string {
  let normalized = '';
  let quoteEnd: string | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (quoteEnd !== undefined) {
      normalized += char;
      if (char === quoteEnd) {
        if (next === quoteEnd) { normalized += next; index++; }
        else quoteEnd = undefined;
      }
      continue;
    }
    if (char === '\r' && next === '\n') {
      normalized += '\n';
      index++;
      lineComment = false;
      continue;
    }
    if (lineComment) { normalized += char; lineComment = char !== '\n'; continue; }
    if (blockComment) {
      normalized += char;
      if (char === '*' && next === '/') { normalized += next; index++; blockComment = false; }
      continue;
    }
    if (char === '-' && next === '-') { normalized += '--'; index++; lineComment = true; continue; }
    if (char === '/' && next === '*') { normalized += '/*'; index++; blockComment = true; continue; }
    if (char === "'" || char === '"' || char === '`') quoteEnd = char;
    normalized += char;
  }
  return normalized;
}

export function migrationQuery(file: D1MigrationFile, table: string): string {
  return `${file.sql}
INSERT INTO ${identifier(table)} (name)
values ('${file.name.replace(/'/g, "''")}');`;
}

interface QueryResult { success?: boolean; results?: unknown[] }

async function query(call: CloudflareCall, accountId: string, databaseId: string, sql: string): Promise<QueryResult[]> {
  const result = await call<QueryResult[] | QueryResult>(`/accounts/${accountId}/d1/database/${databaseId}/query`, { method: 'POST', json: { sql: normalizeSqlLineEndings(sql) } });
  const results = Array.isArray(result) ? result : result ? [result] : [];
  if (results.some((item) => item?.success === false)) throw new ApiError(502, 'D1_QUERY_FAILED', 'D1 reported a failed statement.');
  return results;
}

export async function resolveDatabaseId(call: CloudflareCall, accountId: string, database: D1MigrationDatabase): Promise<string> {
  if (database.databaseId) return database.databaseId;
  const found = await call<{ uuid?: string; name?: string }[]>(`/accounts/${accountId}/d1/database`, { query: { name: database.databaseName } });
  const match = (Array.isArray(found) ? found : []).find((item) => item?.name === database.databaseName && typeof item.uuid === 'string');
  if (!match?.uuid) throw new ApiError(404, 'D1_DATABASE_NOT_FOUND', `D1 database ${database.databaseName} was not found in the connected account.`);
  return match.uuid;
}

export async function applyD1Migrations(call: CloudflareCall, accountId: string, set: D1MigrationSet, onApplied?: (evidence: D1MigrationEvidence) => Promise<void>): Promise<D1MigrationEvidence> {
  const databaseId = await resolveDatabaseId(call, accountId, set);
  await query(call, accountId, databaseId, createMigrationsTableQuery(set.table));
  const listed = await query(call, accountId, databaseId, listMigrationsQuery(set.table));
  const applied = new Set(listed.flatMap((item) => Array.isArray(item.results) ? item.results : []).map((row) => record(row) ? row.name : undefined).filter((name): name is string => typeof name === 'string'));
  const pending = set.files.filter((file) => !applied.has(file.name));
  const evidence: D1MigrationEvidence = { binding: set.binding, databaseName: set.databaseName, databaseId, table: set.table, pending: pending.map((file) => file.name), applied: [] };
  for (const file of pending) {
    try { await query(call, accountId, databaseId, migrationQuery(file, set.table)); }
    catch (error) {
      evidence.failed = { name: file.name, error: (error instanceof ApiError ? error.detail : error instanceof Error ? error.message : 'The migration failed.').slice(0, 500) };
      await onApplied?.(evidence);
      throw new ApiError(502, 'D1_MIGRATION_FAILED', `D1 migration ${file.name} on ${set.databaseName} failed: ${evidence.failed.error}`);
    }
    evidence.applied.push(file.name);
    await onApplied?.(evidence);
  }
  return evidence;
}
