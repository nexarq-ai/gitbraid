import { ApiError } from './domain';
import type { CloudflareCall } from './cloudflare-deploy';
import { applyD1Migrations, D1_MIGRATIONS_TABLE, migrationsPathPattern, migrationsTablePattern, type D1MigrationDatabase, type D1MigrationSet } from './d1-migrations';
import { WorkerBuildFailure, type PreviewD1Database, type ResolvedWorkerConfig } from './worker-bundle';
import { WorkerPreviewError } from './worker-previews';

export const PREVIEW_D1_LIMIT = 3;
const D1_NAME_MAX = 63;
const D1_NOT_FOUND = '[7404]';
export const PREVIEW_D1_FORBIDDEN_MESSAGE = 'The previews API token cannot manage D1 databases. This preview binds D1, so the token needs Account → D1 → Edit on the previews account in addition to Workers Scripts → Edit. An Owner can replace the token in Settings → Cloudflare → Previews and deploys on this installation; the prefilled token page includes both permissions.';

export function previewD1Migrations(config: ResolvedWorkerConfig): D1MigrationDatabase[] {
  const entries = (config.previews ?? config.production).d1Databases ?? [];
  if (entries.length > PREVIEW_D1_LIMIT) throw new WorkerBuildFailure('PREVIEW_D1_LIMIT', `Hosted previews support at most ${PREVIEW_D1_LIMIT} D1 databases; this configuration binds ${entries.length}.`);
  return entries.map((entry) => {
    if (entry.migrationsPattern) throw new WorkerBuildFailure('D1_MIGRATIONS_PATTERN_UNSUPPORTED', `D1 binding ${entry.binding} sets migrations_pattern, which Gitflare does not apply yet. Use the default <migrations_dir>/*.sql layout.`);
    const directory = entry.migrationsDir?.replace(/\/+$/, '') || (entry.migrationsDir === null ? null : '.');
    if (directory === null || (directory !== '.' && !migrationsPathPattern.test(directory))) throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', `D1 binding ${entry.binding} has a migrations_dir outside the repository.`);
    const table = entry.migrationsTable ?? D1_MIGRATIONS_TABLE;
    if (!migrationsTablePattern.test(table)) throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', `D1 binding ${entry.binding} has an unsupported migrations_table name.`);
    return { binding: entry.binding, databaseName: entry.binding, directory, table, ...(entry.migrationsDirSet ? {} : { optional: true }) };
  });
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function previewDatabaseName(alias: string, binding: string): string {
  const name = `gfp-${alias}-${binding.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
  if (name.length <= D1_NAME_MAX) return name;
  const suffix = `-${shortHash(name)}`;
  return `${name.slice(0, D1_NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function forbidden(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CLOUDFLARE_PERMISSION_DENIED';
}

async function findDatabase(call: CloudflareCall, accountId: string, name: string): Promise<string | null> {
  const found = await call<{ uuid?: string; name?: string }[]>(`/accounts/${accountId}/d1/database`, { query: { name } });
  return (Array.isArray(found) ? found : []).find((item) => item?.name === name && typeof item.uuid === 'string')?.uuid ?? null;
}

async function ensureDatabase(call: CloudflareCall, accountId: string, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await findDatabase(call, accountId, name);
  if (existing) return { id: existing, created: false };
  try {
    const created = await call<{ uuid?: string }>(`/accounts/${accountId}/d1/database`, { method: 'POST', json: { name } });
    if (typeof created?.uuid !== 'string') throw new WorkerPreviewError('PREVIEW_D1_REJECTED', `Cloudflare did not return an id for D1 database ${name}.`);
    return { id: created.uuid, created: true };
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'CLOUDFLARE_DEPLOY_REJECTED')) throw error;
    const raced = await findDatabase(call, accountId, name);
    if (!raced) throw error;
    return { id: raced, created: false };
  }
}

export async function provisionPreviewD1(call: CloudflareCall, accountId: string, alias: string, sets: D1MigrationSet[], created: string[] = []): Promise<PreviewD1Database[]> {
  const names = sets.map((set) => previewDatabaseName(alias, set.binding));
  if (new Set(names).size !== names.length) throw new WorkerPreviewError('PREVIEW_D1_CONFIG_INVALID', 'Two D1 bindings differ only by letter case; hosted previews need distinct binding names.');
  const databases: PreviewD1Database[] = [];
  try {
    for (const [index, set] of sets.entries()) {
      const databaseName = names[index];
      const database = await ensureDatabase(call, accountId, databaseName);
      if (database.created) created.push(database.id);
      try {
        await applyD1Migrations(call, accountId, { ...set, databaseName, databaseId: database.id });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'D1_MIGRATION_FAILED') throw new WorkerPreviewError('PREVIEW_D1_MIGRATION_FAILED', error.detail);
        throw error;
      }
      databases.push({ binding: set.binding, databaseName, databaseId: database.id, migrationsApplied: set.files.length });
    }
  } catch (error) {
    if (forbidden(error)) throw new WorkerPreviewError('PREVIEWS_D1_FORBIDDEN', PREVIEW_D1_FORBIDDEN_MESSAGE, 403);
    if (error instanceof ApiError) throw new WorkerPreviewError('PREVIEW_D1_REJECTED', error.detail, error.status);
    throw error;
  }
  return databases;
}

export async function deletePreviewD1(call: CloudflareCall, accountId: string, ids: string[]): Promise<{ deleted: string[]; missing: string[] }> {
  const result = { deleted: [] as string[], missing: [] as string[] };
  for (const id of ids) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) continue;
    try {
      const response = await call<unknown>(`/accounts/${accountId}/d1/database/${id}`, { method: 'DELETE', allowNotFound: true, envelope: true });
      (response === null ? result.missing : result.deleted).push(id);
    } catch (error) {
      if (error instanceof ApiError && error.detail.includes(D1_NOT_FOUND)) { result.missing.push(id); continue; }
      if (forbidden(error)) throw new WorkerPreviewError('PREVIEWS_D1_FORBIDDEN', PREVIEW_D1_FORBIDDEN_MESSAGE, 403);
      throw error;
    }
  }
  return result;
}
