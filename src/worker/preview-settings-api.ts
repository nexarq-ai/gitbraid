import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey } from './domain';
import type { AppEnv } from './env';
import { securityClient, type Principal } from './security';
import { cloudflareDeployAccess } from './cloudflare';
import { cloudflareDeployClient, type CloudflareDeployAccess } from './cloudflare-deploy';
import type { DeployState } from './deployments';
import type { ProjectSnapshot } from './cloudflare-projects';
import { ACCESS_SCOPE_MISSING_MESSAGE, accessScopeState, assertAccessScope, ensurePreviewAccess, type PreviewAccessIncludes } from './preview-access';
import { previewTarget, WORKERS_SCRIPTS_EDIT_SCOPE, type PreviewTarget, type ProjectWorkers } from './preview-host';
import { effectiveLifetimeMinutes, lifetimeChoices, normalizePreviewSettings, previewMaxLifetimeMinutes, type PreviewSettings } from './preview-settings';
import type { Fetcher } from './worker-previews';

export const PREVIEW_ACCESS_DESCRIPTIONS = {
  link: 'Worker Preview URLs are unguessable links. They are public: anyone with the link can open the preview.',
  'cloudflare-access': 'Worker Preview URLs sit behind Cloudflare Access on the connected account; only the allowed emails or email domains can sign in.',
  container: 'Container previews on Gitflare’s preview origin always need a capability link issued to a signed-in workspace member.',
} as const;

export const PREVIEW_EMAIL_DESCRIPTION = 'Preview email goes only to these addresses; leave empty to block all preview email. Every send_email binding a Worker Preview gets is restricted to them, and container previews have no outbound email at all. Cloudflare restricts send_email by exact address, so domains such as @example.com cannot be listed. Staging and production deploys are unaffected.';

export interface PreviewSettingsStore {
  getPreviewSettings(): PreviewSettings | Promise<PreviewSettings>;
  setPreviewSettings(key: string, settings: Omit<PreviewSettings, 'updatedAt' | 'updatedBy'>, actorId: string): PreviewSettings | Promise<PreviewSettings>;
  deployState(): DeployState | Promise<DeployState>;
}

export interface PreviewSettingsDeps {
  store: PreviewSettingsStore;
  connection(target: PreviewTarget | null): Promise<CloudflareDeployAccess | null>;
  project(): Promise<ProjectWorkers | null>;
  includes(settings: PreviewSettings): Promise<PreviewAccessIncludes>;
  audit(action: string): Promise<void>;
  fetcher?: Fetcher;
}

export async function previewAccessIncludes(env: AppEnv, principal: Principal, repositoryId: string, settings: Pick<PreviewSettings, 'accessEmailDomains'>): Promise<PreviewAccessIncludes> {
  if (settings.accessEmailDomains.length) return { emails: [], domains: settings.accessEmailDomains };
  const snapshot = await securityClient(env).snapshot(principal) as { members?: { repositoryIds?: string[]; user?: { email?: unknown } | null }[] };
  const emails = (snapshot.members ?? []).filter((member) => !member.repositoryIds || member.repositoryIds.includes(repositoryId)).map((member) => member.user?.email).filter((email): email is string => typeof email === 'string');
  return { emails, domains: [] };
}

async function resolvedTarget(settings: PreviewSettings, deps: PreviewSettingsDeps): Promise<PreviewTarget | null> {
  const { settings: deploy } = await deps.store.deployState();
  return previewTarget(settings, deploy, await deps.project());
}

export async function previewSettingsSnapshot(env: AppEnv, repositoryId: string, deps: PreviewSettingsDeps, canChange: boolean) {
  const settings = await deps.store.getPreviewSettings();
  const target = await resolvedTarget(settings, deps);
  const connection = await deps.connection(target).catch(() => null);
  const scope = accessScopeState(env, connection?.scopes ?? null);
  return {
    repositoryId, settings, canChange,
    email: { recipients: settings.previewEmailRecipients, blocked: !settings.previewEmailRecipients.length, description: PREVIEW_EMAIL_DESCRIPTION },
    lifetime: { minutes: effectiveLifetimeMinutes(settings, env), choices: lifetimeChoices(env), maxMinutes: previewMaxLifetimeMinutes(env), extendOnce: true },
    target: target ? { workerName: target.workerName, ...(target.configPath ? { configPath: target.configPath } : {}), ...(connection ? { accountId: connection.accountId, connection: connection.source } : {}), connectionCanPreview: !!connection?.scopes.includes(WORKERS_SCRIPTS_EDIT_SCOPE) } : null,
    access: {
      mode: settings.access,
      description: PREVIEW_ACCESS_DESCRIPTIONS[settings.access],
      containerDescription: PREVIEW_ACCESS_DESCRIPTIONS.container,
      cloudflareAccess: { available: scope.granted, ...(scope.granted ? {} : { reason: ACCESS_SCOPE_MISSING_MESSAGE }), requestedScopes: scope.scopes, missingScopes: scope.missing },
    },
  };
}

export async function changePreviewSettings(env: AppEnv, repositoryId: string, key: string, body: Record<string, unknown>, actorId: string, deps: PreviewSettingsDeps) {
  const current = await deps.store.getPreviewSettings();
  const next = normalizePreviewSettings(body, current, env);
  let accessApp: { appId: string; domain: string; accountId: string; workerName: string } | undefined;
  if (next.access === 'cloudflare-access') {
    const target = await resolvedTarget({ ...current, ...next }, deps);
    if (!target) throw new ApiError(409, 'PREVIEW_TARGET_REQUIRED', 'Cloudflare Access protects the Previews of this repository’s own Worker. Set the preview Worker, a deploy target or a linked Worker first.');
    const connection = await deps.connection(target).catch(() => null);
    assertAccessScope(env, connection?.scopes ?? null);
    if (!connection!.scopes.includes(WORKERS_SCRIPTS_EDIT_SCOPE)) throw new ApiError(409, 'CLOUDFLARE_SCOPE_MISSING', `The Cloudflare connection was not granted ${WORKERS_SCRIPTS_EDIT_SCOPE}, so previews cannot run on Worker ${target.workerName}. Preview access stays unchanged.`);
    const call = cloudflareDeployClient(connection!, deps.fetcher).call;
    const ensured = await ensurePreviewAccess(call, connection!.accountId, target.workerName, await deps.includes({ ...current, ...next }));
    accessApp = { appId: ensured.appId, domain: ensured.domain, accountId: connection!.accountId, workerName: target.workerName };
  }
  const saved = await deps.store.setPreviewSettings(key, next, actorId);
  await deps.audit(`repository.preview-settings.lifetime-${next.lifetimeMinutes}m.access-${next.access}`);
  if (current.previewEmailRecipients.join('\n') !== next.previewEmailRecipients.join('\n')) await deps.audit(`repository.preview-settings.email-recipients-${next.previewEmailRecipients.length}`);
  return { settings: saved, ...(accessApp ? { accessApp } : {}) };
}

interface RepositoryCoordinator extends PreviewSettingsStore {}

export function previewSettingsDeps(env: AppEnv, principal: Principal, repositoryId: string, coordinator: RepositoryCoordinator): PreviewSettingsDeps {
  const security = securityClient(env);
  return {
    store: coordinator,
    connection: async (target) => {
      try { return await cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repositoryId, ...(target?.accountId ? { expectedAccountId: target.accountId } : {}) }, repositoryId); }
      catch { return null; }
    },
    project: async () => {
      try {
        const { mapping } = await security.projectStore(principal, repositoryId, 'get') as ProjectSnapshot;
        return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map((resource) => resource.id) } : null;
      } catch { return null; }
    },
    includes: (settings) => previewAccessIncludes(env, principal, repositoryId, settings),
    audit: (action) => security.auditRepositoryChange(principal, action, repositoryId),
  };
}

export async function handlePreviewSettings(request: Request, env: AppEnv, principal: Principal, repositoryId: string, coordinator: RepositoryCoordinator): Promise<Response> {
  const security = securityClient(env);
  const deps = previewSettingsDeps(env, principal, repositoryId, coordinator);
  if (request.method === 'GET') {
    await security.authorize(principal, 'read', 'repository', repositoryId);
    const canChange = await security.check(principal, 'manage', 'repository', repositoryId).then(() => true, () => false);
    return Response.json(await previewSettingsSnapshot(env, repositoryId, deps, canChange), { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for preview settings.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request), body = await readJson(request, 16384);
  await security.authorize(principal, 'manage', 'repository', repositoryId);
  const changed = await changePreviewSettings(env, repositoryId, key, body, principal.userId, deps);
  return Response.json({ ...await previewSettingsSnapshot(env, repositoryId, deps, true), ...(changed.accessApp ? { accessApp: changed.accessApp } : {}) });
}
