import { ApiError } from './domain';
import type { CloudflareCall } from './cloudflare-deploy';
import { applyD1Migrations, D1_MIGRATIONS_TABLE, migrationsPathPattern, migrationsTablePattern, type D1MigrationDatabase, type D1MigrationSet } from './d1-migrations';
import { WorkerBuildFailure, type PreviewD1Database, type ResolvedWorkerConfig } from './worker-bundle';
import { WorkerPreviewError } from './worker-previews';

export const PREVIEW_D1_LIMIT = 3;
const D1_NOT_FOUND = '[7404]';
export const PREVIEW_D1_FORBIDDEN_MESSAGE = 'The Cloudflare credential hosting this preview cannot use D1 databases. This preview binds a preview D1 database, so the credential needs D1 Edit on that account (d1.write for a Cloudflare connection, Account → D1 → Edit for the installation token) in addition to Workers Scripts Edit. An Owner can reconnect Cloudflare, or replace the installation token in Settings → Cloudflare → Previews and deploys on this installation.';

export function previewD1Migrations(config: ResolvedWorkerConfig): D1MigrationDatabase[] {
  const entries = (config.previews?.d1Databases ?? []).filter((entry) => entry.databaseId);
  if (entries.length > PREVIEW_D1_LIMIT) throw new WorkerBuildFailure('PREVIEW_D1_LIMIT', `Hosted previews bind at most ${PREVIEW_D1_LIMIT} preview D1 databases; previews.d1_databases declares ${entries.length}.`);
  return entries.map((entry) => {
    if (entry.migrationsPattern) throw new WorkerBuildFailure('D1_MIGRATIONS_PATTERN_UNSUPPORTED', `D1 binding ${entry.binding} sets migrations_pattern, which Gitflare does not apply yet. Use the default <migrations_dir>/*.sql layout.`);
    const directory = entry.migrationsDir?.replace(/\/+$/, '') || (entry.migrationsDir === null ? null : '.');
    if (directory === null || (directory !== '.' && !migrationsPathPattern.test(directory))) throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', `D1 binding ${entry.binding} has a migrations_dir outside the repository.`);
    const table = entry.migrationsTable ?? D1_MIGRATIONS_TABLE;
    if (!migrationsTablePattern.test(table)) throw new WorkerBuildFailure('D1_MIGRATIONS_CONFIG_INVALID', `D1 binding ${entry.binding} has an unsupported migrations_table name.`);
    return { binding: entry.binding, databaseName: entry.databaseName ?? entry.binding, databaseId: entry.databaseId, directory, table, ...(entry.migrationsDirSet ? {} : { optional: true }) };
  });
}

function forbidden(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CLOUDFLARE_PERMISSION_DENIED';
}

export async function bindPreviewD1(call: CloudflareCall, accountId: string, sets: D1MigrationSet[]): Promise<PreviewD1Database[]> {
  const databases: PreviewD1Database[] = [];
  try {
    for (const set of sets) {
      if (!set.databaseId) continue;
      try {
        await applyD1Migrations(call, accountId, set);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'D1_MIGRATION_FAILED') throw new WorkerPreviewError('PREVIEW_D1_MIGRATION_FAILED', error.detail);
        if (error instanceof ApiError && (error.code === 'CLOUDFLARE_NOT_FOUND' || error.detail.includes(D1_NOT_FOUND))) throw new WorkerPreviewError('PREVIEW_D1_NOT_FOUND', `Preview D1 database ${set.databaseName} (${set.databaseId}) for binding ${set.binding} was not found on account ${accountId}, which hosts this preview. Point previews.d1_databases at a database on that account.`);
        throw error;
      }
      databases.push({ binding: set.binding, databaseName: set.databaseName, databaseId: set.databaseId, migrationsApplied: set.files.length });
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
