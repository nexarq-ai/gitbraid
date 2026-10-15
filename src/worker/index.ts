import { listRepositorySkills } from './repository-skills';
import { assertReviewClear, reviewMissionInput } from './proposal-review';
import { timingSafeEqual } from 'node:crypto';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AiSettings, IntegrationStatus, Mission, Repository, Workspace } from '../shared/types';
import { createArtifactsRepository, repositoryHead } from './artifacts';
import { ApiError, assertMutationOrigin, isLocalRequest, MISSION_REQUEST_MAX_BYTES, missionInput, publicError, readJson, repositoryName, repositoryPath, repositoryRef, requireIdempotencyKey, requireString } from './domain';
import { checkSettingsSnapshot, normalizeCheckSettings, retryCheckSettings } from './check-settings';
import type { AppEnv } from './env';
import { executionReadiness } from './execution';
import { backgroundState, dispatchBackground, landingWorkflowId, previewWorkflowId, retireWorkerPreview } from './background-work';
import { backgroundPrincipal, deploymentsApi, deployWorkflowId, type DeployParams } from './deployments';
import type { ProjectSnapshot } from './cloudflare-projects';
import { PREVIEW_STEP_MS } from './budgets';
import { handleMcp, mcpToolNames } from './mcp';
import { integrationPendingMessage, PREVIEW_STARTING_MESSAGE, startWithDurableDispatch } from './coordinator';
import { hashToken, securityClient, type Principal, type Action } from './security';
import { consume, rateLimitedResponse, rateSubject } from './rate-limits';
import { listDocs, readDoc } from './docs';
import { documentationImage, documentationMarkdown } from './docs-markdown';
import { handleOnboarding } from './onboarding';
import { listPublicDocs, readPublicDoc, publicSourceResponse } from './distribution';
import { oauthConsent, oauthProvider, revokeClientGrants } from './oauth';
import { publicPageResponse } from './public-pages';
import { publicGitResponse } from './hosted-source';
import { deliverInvitation } from './email';
import { CLOUDFLARE_LINK_COOKIE, requestCookie, handleCloudflare, cloudflareAccount, cloudflareApiRequest, cloudflareAnalyticsRequest } from './cloudflare';
import { dispatchCloudflareProject, projectDependencies, type ProjectOperation } from './cloudflare-projects';
import { validateRepositoryInitialization, initializeArtifactsRepository } from './repository-initialization';
import { SKILL_REQUEST_MAX_BYTES, validateRepositorySkillChange, verifyRepositorySkillChange } from './skill-edit';
import { draftMission, draftRequest, repositorySnapshot } from './mission-draft';
import { handleIssues } from './issues';
import { releaseApi } from './releases';
import { modelConnectionsSnapshot, modelIdentifier, resolveModelConnection, validateModelConnection, verifyModelConnection } from './model-config';
import { aiKeyProvider, aiKeysSnapshot, assertModelAccess, assertWorkspaceAi, createModelAccess, encryptAiGateway, encryptAiKey, ownGatewayInput, providerKey, reserveOperatorUsage, storedOwnGateway, storedProviderKey, verificationModel, verifyProviderKey, type AiCredentials } from './ai-keys';
import { IMPORT_REQUEST_MAX_BYTES, RepositoryImportFailure, buildImportPack, importFingerprint, inspectRepositoryImport, parseImportArchive, pushRepositoryImport, validateImportInput } from './repository-import';
import { handleGitRequest, listBranches, type GitHttpDependencies } from './git-http';
import { branchApi } from './branches';
import { branchName, effectiveRules, landingRule, protectionSnapshot } from './branch-protection';
import { handleUrlImport } from './url-import';
import { capabilityHash, mintPreviewToken, PREVIEW_CAPABILITY_MS, previewCapabilityStore, previewTarget, relayPreview } from './preview-capability';

export { GitflareSecurity } from './security';
export { GitflareCoordinator } from './coordinator';
export { MissionWorkflow } from './workflow';
export { AgentSandbox, BootstrapOutbound, GitOutbound, ImportOutbound, RegistryOutbound } from '../../runner/sandbox';

const encoder = new TextEncoder();

export class PreviewRelay extends WorkerEntrypoint<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    return relayPreview(this.env, request, (capability) => security(this.env).check(capability.principal, 'read', 'repository', capability.repositoryId, capability.missionId));
  }
}

async function tokenMatches(token: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

function security(env: AppEnv) { if (!env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.'); return securityClient(env); }
async function coordinatorRead<T>(operation: 'getModelConnections' | 'repositoryBootstrapSha', read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    const missingMethod = error instanceof Error && /not a function|does not exist|not implemented|does not implement|missing|unknown method|no such method|not supported/i.test(error.message);
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : 'UnknownError';
    console.warn(JSON.stringify({ operation, errorName, missingMethod }));
    if (missingMethod) throw new ApiError(503, operation === 'getModelConnections' ? 'MODEL_DEPLOYMENT_PENDING' : 'IMPORT_DEPLOYMENT_PENDING', 'Repository services are updating. Wait briefly and refresh before trying again.');
    throw error;
  }
}

async function aiCredentials(catalog: { getAiCredentials?(): Promise<AiCredentials> }): Promise<AiCredentials> {
  return typeof catalog.getAiCredentials === 'function' ? catalog.getAiCredentials() : { keys: [], gateway: null };
}
function catalogName(workspaceId: string) { return workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${workspaceId}`; }
function cookieValue(request: Request) { return request.headers.get('Cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith('gitflare_session='))?.slice(17); }
function sessionResponse(result: { token?: string; user?: unknown; workspaceId?: string; mfaRequired?: boolean }, clearLink = false) { const headers = new Headers(); if (clearLink) headers.append('Set-Cookie', `${CLOUDFLARE_LINK_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`); if (!result.token) return Response.json(result, { headers }); const { token, ...body } = result; headers.append('Set-Cookie', `gitflare_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`); return Response.json({ ok: true, ...body }, { headers }); }
async function authorize(request: Request, env: AppEnv, bearerOnly = false): Promise<Principal> {
  const authorization = request.headers.get('Authorization'); const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (env.EDITION !== 'self-hosted' && !bearerOnly && isLocalRequest(request, env.APP_ENV) && !bearer && !cookieValue(request)) return security(env).bootstrap();
  if (env.EDITION !== 'self-hosted' && bearer && env.OWNER_TOKEN && env.OWNER_TOKEN.length >= 32 && await tokenMatches(bearer, env.OWNER_TOKEN)) {
    const workspace = request.headers.get('X-Gitflare-Workspace'); if (workspace && workspace !== 'legacy') throw new ApiError(403, 'FORBIDDEN', 'The legacy key cannot access other workspaces.'); return security(env).bootstrap();
  }
  const value = bearer ?? (!bearerOnly ? cookieValue(request) : undefined);
  if (value) return security(env).authenticate(value, request.headers.get('X-Gitflare-Workspace') ?? undefined);
  throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Gitflare.');
}

async function landingReviewRule(env: AppEnv, repository: Repository) { return landingRule(await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).getBranchProtection(), repository.defaultBranch); }
function gitDependencies(env: AppEnv): GitHttpDependencies {
  return {
    authenticate: async (token) => env.EDITION !== 'self-hosted' && env.OWNER_TOKEN && env.OWNER_TOKEN.length >= 32 && await tokenMatches(token, env.OWNER_TOKEN) ? security(env).bootstrap() : security(env).authenticate(token),
    authorize: (principal, action, repositoryId) => security(env).authorize(principal, action, 'repository', repositoryId),
    repository: async (principal, name) => (await env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)).listRepositories()).find(item => item.name === name || principal.workspaceId !== 'legacy' && item.name === `w-${principal.workspaceId.replace(/-/g, '')}-${name.slice(0, 29)}`),
    rules: async (repository) => effectiveRules(await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).getBranchProtection(), repository.defaultBranch),
    artifacts: env.ARTIFACTS,
  };
}

function integrations(env: AppEnv, local: boolean): IntegrationStatus[] {
  const modelConfigured = !!(env.MODEL && env.AI && env.AI_GATEWAY_ID);
  return [
    { id: 'artifacts', name: 'Cloudflare Artifacts', ready: !!env.ARTIFACTS, detail: env.ARTIFACTS ? 'Repository binding configured' : 'Connect Artifacts to create Git repositories and isolated forks' },
    { id: 'sandbox', name: 'Cloudflare Sandbox', ready: !!env.SANDBOX, detail: env.SANDBOX ? 'Isolated execution binding configured' : 'Connect Sandbox to run agents and tests' },
    { id: 'model', name: 'AI model', ready: modelConfigured, detail: modelConfigured ? 'Gateway configured; provider credentials are verified when a mission runs' : 'Configure AI Gateway with a provider key and model' },
    { id: 'auth', name: 'Workspace authentication', ready: !local && !!env.GITFLARE_SECURITY, detail: local ? 'Localhost development access only' : 'Account authentication enabled' },
  ];
}

async function seedLocal(env: AppEnv): Promise<void> {
  const catalog = env.GITFLARE_COORDINATOR.getByName('catalog:owner');
  if ((await catalog.listRepositories()).length) return;
  const now = new Date().toISOString();
  const repository = await catalog.createRepository('local-seed-repository-v1', {
    id: 'local-example', name: 'edge-store', description: 'Local workspace example. Connect Artifacts to add source code and run agents.',
    defaultBranch: 'main', headSha: null, provider: 'local', createdAt: now, updatedAt: now,
  });
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
  await coordinator.saveRepository(repository);
  await coordinator.createMission('local-seed-mission-v1', { repositoryId: repository.id, title: 'Make checkout resilient to retries', prompt: 'Add idempotent checkout handling and improve compatibility around order creation. Verify independent agent changes together before review.' });
}

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> { try { return await read(); } catch { return undefined; } }

async function findMission(env: AppEnv, missionId: string, workspaceId: string): Promise<{ mission: Mission; repository: Repository }> {
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
  const indexed = await optional(() => catalog.missionRepository(missionId));
  const repository = indexed ? await catalog.getRepository(indexed) : undefined;
  const mission = repository ? await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).getMission(missionId) : undefined;
  if (repository && mission) return { mission, repository };
  const repositories = await catalog.listRepositories();
  const candidates = await Promise.all(repositories.map(async (item) => ({ repository: item, mission: await env.GITFLARE_COORDINATOR.getByName(`repository:${item.id}`).getMission(missionId) })));
  const found = candidates.find((item) => item.mission);
  if (!found?.mission) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This mission could not be found.');
  await optional(() => catalog.indexMission(missionId, found.repository.id));
  return { mission: found.mission, repository: found.repository };
}

async function currentRepository(env: AppEnv, repository: Repository): Promise<Repository> {
  if (repository.provider !== 'artifacts' || !env.ARTIFACTS) throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'This is a local workspace record. Create a connected Artifacts repository before running agents.');
  const updated = { ...repository, headSha: await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch), updatedAt: new Date().toISOString() };
  await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).saveRepository(updated);
  await env.GITFLARE_COORDINATOR.getByName(catalogName(repository.workspaceId ?? 'legacy')).saveRepository(updated);
  return updated;
}

async function browseRepository(env: AppEnv, repository: Repository, kind: string, url: URL): Promise<Response> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to browse its source.');
  const ref = repositoryRef(url.searchParams.get('ref') || repository.defaultBranch);
  const path = repositoryPath(url.searchParams.get('path') ?? '', kind === 'tree');
  using source = await env.ARTIFACTS.get(repository.name);
  const commit = (await source.log({ ref, limit: 1 }))[0];
  if (!commit) throw new ApiError(404, 'REF_NOT_FOUND', 'This branch, tag, or commit does not exist. Push an initial commit if the repository is empty.');
  if (kind === 'file') {
    const blob = await source.readFile({ ref: commit.hash, path });
    if (!blob) throw new ApiError(404, 'FILE_NOT_FOUND', 'This file could not be found at the selected commit.');
    if (blob.size > 524_288) throw new ApiError(413, 'FILE_TOO_LARGE', 'The source viewer supports files up to 512 KB. Clone the repository to inspect this file.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    } catch {
      throw new ApiError(415, 'BINARY_FILE', 'This file contains binary data. Clone the repository to inspect it.');
    }
    if (content.includes('\0')) throw new ApiError(415, 'BINARY_FILE', 'This file contains binary data. Clone the repository to inspect it.');
    return Response.json({ path, content, commitSha: commit.hash });
  }
  let tree = await source.readTree(commit.treeHash);
  for (const segment of path ? path.split('/') : []) {
    const entry = tree?.find((item) => item.name === segment && item.type === 'tree');
    if (!entry) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'This directory could not be found at the selected commit.');
    tree = await source.readTree(entry.hash);
  }
  if (!tree) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'This directory could not be found at the selected commit.');
  if (tree.length > 5000) throw new ApiError(413, 'DIRECTORY_TOO_LARGE', 'This directory contains more than 5,000 entries. Clone the repository to browse it.');
  const entries = tree.map((entry) => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, type: entry.type === 'tree' ? 'directory' : 'file' })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return Response.json({ entries, ref, commitSha: commit.hash });
}

async function api(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const local = env.EDITION !== 'self-hosted' && isLocalRequest(request, env.APP_ENV);
  if (request.method === 'GET' && url.pathname === '/api/public/docs') return Response.json({ items: listPublicDocs() });
  if (request.method === 'GET' && url.pathname.startsWith('/api/public/docs/diagrams/')) return documentationImage(url.pathname.slice('/api/public/docs/diagrams/'.length));
  if (request.method === 'GET' && url.pathname.startsWith('/api/public/docs/')) {
    const id = url.pathname.slice('/api/public/docs/'.length);
    const markdown = id.endsWith('.md');
    const doc = readPublicDoc(markdown ? id.slice(0, -3) : id);
    if (!doc) throw new ApiError(404, 'DOC_NOT_FOUND', 'This guide does not exist.');
    return markdown ? documentationMarkdown(doc, listPublicDocs(), request.url, true) : Response.json(doc);
  }
  if (url.pathname.startsWith('/api/public/source')) return publicSourceResponse(request, env.ASSETS);
  const cloudflare = await handleCloudflare(request, env, authorize);
  if (cloudflare) return cloudflare;
  const onboarding = await handleOnboarding(request, env, authorize, ctx);
  if (onboarding) return onboarding;
  if (request.method === 'POST' && ['/api/login', '/api/session'].includes(url.pathname)) {
    assertMutationOrigin(request);
    await security(env).rateLimit(`auth:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
    const body = await readJson(request);
    if (url.pathname === '/api/login') { const link = requestCookie(request, CLOUDFLARE_LINK_COOKIE); return sessionResponse(await security(env).login(body, request.headers.get('CF-Connecting-IP') ?? 'local', link), !!link); }
    const token = requireString(body.token, 'Token', 1024, 32);
    if (env.EDITION === 'self-hosted' || !env.OWNER_TOKEN || !await tokenMatches(token, env.OWNER_TOKEN)) throw new ApiError(401, 'AUTH_REQUIRED', 'The owner token was not accepted.');
    return sessionResponse({ token: await security(env).legacySession(), workspaceId: 'legacy' });
  }
  const principal = await authorize(request, env);
  const access = security(env);
  if (request.method === 'GET' && (['/api/docs', '/api/mcp', '/api/workspace'].includes(url.pathname) || url.pathname.startsWith('/api/docs/'))) await access.authorizeMetadata(principal);
  if (url.pathname === '/api/access' && request.method === 'GET') return Response.json(await access.snapshot(principal));
  if (url.pathname.startsWith('/api/access/') && request.method === 'POST') {
    assertMutationOrigin(request); const body = await readJson(request); const action = url.pathname.slice('/api/access/'.length);
    if (action === 'accept-invite') return Response.json(await access.acceptInvite(principal, requireString(body.token, 'Invitation token', 128)));
    if (action === 'membership' && body.repositoryIds !== undefined) { if (!Array.isArray(body.repositoryIds)) throw new ApiError(400, 'INVALID_SCOPE', 'Provide repository IDs.'); const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)); for (const id of body.repositoryIds) if (typeof id !== 'string' || !await catalog.getRepository(id)) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Every scoped repository must belong to this workspace.'); }
    if (action === 'credential-create') { const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)); if (!await catalog.getRepository(String(body.repositoryId))) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Select a repository in this workspace.'); }
    const result = await access.action(principal, action, body);
    if (action === 'session-revoke' && typeof body.id === 'string') await revokeClientGrants(env, url.origin, application, authorize, principal.userId, body.id);
    if (action === 'invite' && result && typeof result === 'object' && 'token' in result && typeof result.token === 'string') { const workspace = await access.workspace(principal); const delivery = await deliverInvitation(env, { email: String(body.email), token: result.token, workspaceName: workspace.name, origin: url.origin }); return Response.json({ ...result, delivery }); }
    return Response.json(result);
  }
  if (request.method === 'GET' && url.pathname === '/api/docs') return Response.json({ items: listDocs() });
  if (request.method === 'GET' && url.pathname.startsWith('/api/docs/')) {
    const id = url.pathname.slice('/api/docs/'.length);
    const markdown = id.endsWith('.md');
    const document = readDoc(markdown ? id.slice(0, -3) : id);
    if (!document) throw new ApiError(404, 'DOC_NOT_FOUND', 'This documentation page could not be found.');
    return markdown ? documentationMarkdown(document, listDocs(), request.url, false) : Response.json(document);
  }
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  if (request.method === 'GET' && url.pathname === '/api/models') {
    await access.authorizeMetadata(principal);
    return Response.json(modelConnectionsSnapshot(env, await coordinatorRead('getModelConnections', () => catalog.getModelConnections())));
  }
  if (url.pathname === '/api/settings/ai') {
    if (request.method === 'GET') { await access.authorizeMetadata(principal); return Response.json(await aiSettings(env, catalog)); }
    if (request.method === 'POST') {
      assertMutationOrigin(request);
      await access.authorize(principal, 'manage');
      requireIdempotencyKey(request);
      const body = await readJson(request);
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Send enabled as true or false.');
      if (body.enabled && env.AI_FEATURES === 'disabled') throw new ApiError(409, 'AI_LOCKED', 'AI features are turned off for this installation with AI_FEATURES=disabled.');
      await catalog.setAiEnabled(body.enabled);
      return Response.json(await aiSettings(env, catalog));
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/models/action') {
    assertMutationOrigin(request);
    await access.authorize(principal, 'manage');
    const key = requireIdempotencyKey(request), body = await readJson(request);
    if (body.action !== 'remove') await requireAi(env, catalog);
    if (!['add', 'remove', 'verify'].includes(String(body.action))) throw new ApiError(400, 'INVALID_MODEL_ACTION', 'Choose add, remove or verify.');
    const model = body.action === 'add' ? validateModelConnection(body.model) : undefined;
    const modelId = model?.id ?? modelIdentifier(body.modelId);
    const fingerprint = JSON.stringify(['model', body.action, model ?? modelId]);
    const receipt = await catalog.getModelRequest(key, fingerprint);
    if (receipt?.result) return Response.json(modelConnectionsSnapshot(env, receipt.result));
    if (receipt) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'This model verification is running or interrupted. An unconfirmed billed call will not be repeated.');
    if (body.action === 'verify') {
      const configured = resolveModelConnection(await coordinatorRead('getModelConnections', () => catalog.getModelConnections()), modelId);
      if (!await catalog.claimModelVerification(key, fingerprint)) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'Model verification is already in progress.');
      await access.check(principal, 'manage');
      const credentials = await aiCredentials(catalog);
      assertModelAccess(env, principal.workspaceId, credentials, [configured]);
      const verified = await verifyModelConnection({ ...env, modelAccess: createModelAccess(env, principal.workspaceId, { getAiCredentials: () => aiCredentials(catalog) }) }, configured);
      return Response.json(modelConnectionsSnapshot(env, await catalog.completeModelVerification(key, fingerprint, verified)));
    }
    return Response.json(modelConnectionsSnapshot(env, await catalog.changeModelConnections(key, fingerprint, body.action as 'add' | 'remove', model ?? modelId)));
  }
  if (request.method === 'GET' && url.pathname === '/api/ai-keys') {
    await access.authorizeMetadata(principal);
    return Response.json(aiKeysSnapshot(env, principal.workspaceId, await aiCredentials(catalog)));
  }
  if (request.method === 'POST' && url.pathname === '/api/ai-keys/action') {
    assertMutationOrigin(request);
    await access.authorize(principal, 'manage');
    requireIdempotencyKey(request);
    const body = await readJson(request);
    if (!['add', 'remove', 'test'].includes(String(body.action))) throw new ApiError(400, 'INVALID_AI_KEY_ACTION', 'Choose add, remove or test.');
    const provider = aiKeyProvider(body.provider);
    if (body.action === 'remove') return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.removeAiKey(provider)));
    await requireAi(env, catalog);
    await security(env).rateLimit(`ai-key:${principal.workspaceId}`, 20, 3_600_000);
    const credentials = await aiCredentials(catalog);
    const key = body.action === 'add' ? providerKey(body.key) : await storedProviderKey(env, principal.workspaceId, credentials, provider);
    const model = verificationModel(provider, await coordinatorRead('getModelConnections', () => catalog.getModelConnections()), typeof body.modelId === 'string' ? body.modelId : undefined);
    const result = await verifyProviderKey(env, principal.workspaceId, provider, key, model, await storedOwnGateway(env, principal.workspaceId, credentials));
    if (!result.ok) throw new ApiError(400, 'AI_KEY_INVALID', `The ${model.id} check failed. ${result.detail}`);
    await access.check(principal, 'manage');
    const saved = body.action === 'add' ? await catalog.saveAiKey(await encryptAiKey(env, principal.workspaceId, provider, key, principal.userId, model.id)) : credentials;
    return Response.json({ ...aiKeysSnapshot(env, principal.workspaceId, saved), verification: { provider, model: model.id, detail: result.detail } });
  }
  if (request.method === 'POST' && url.pathname === '/api/ai-gateway') {
    assertMutationOrigin(request);
    await access.authorize(principal, 'manage');
    requireIdempotencyKey(request);
    const body = await readJson(request);
    if (body.action === 'clear') return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.saveAiGateway(null)));
    if (body.action !== 'set') throw new ApiError(400, 'INVALID_AI_GATEWAY_ACTION', 'Choose set or clear.');
    await requireAi(env, catalog);
    const record = await encryptAiGateway(env, principal.workspaceId, ownGatewayInput(body), principal.userId);
    return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.saveAiGateway(record)));
  }
  if (request.method === 'GET' && url.pathname === '/api/mcp') {
    return Response.json({ endpoint: `${url.origin}/mcp`, transport: 'streamable-http', authentication: env.OAUTH_KV ? 'oauth' : 'bearer', configured: !!env.OAUTH_KV, tools: mcpToolNames, ownerApprovalRequired: true, ownerActions: 'ui_and_mcp' });
  }
  if (request.method === 'POST' && url.pathname === '/api/session/logout') {
    assertMutationOrigin(request);
    await access.logout(principal);
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'gitflare_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' } });
  }
  if (request.method === 'GET' && url.pathname === '/api/workspace') {
    if (local) await seedLocal(env);
    const repositories = await catalog.listRepositories();
    const readable = await access.checkMany(principal, 'read', repositories.map((repository) => ({ resourceType: 'repository', resourceId: repository.id })));
    const visible = repositories.filter((_, index) => readable[index]);
    const listed = (await Promise.all(visible.map((repository) => env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).listMissionSummaries()))).flat();
    const allowed = await access.checkMany(principal, 'read', listed.map((mission) => ({ resourceType: 'repository', resourceId: mission.repositoryId, missionId: mission.id })));
    const missions = listed.filter((_, index) => allowed[index]);
    const workspace: Workspace = { name: principal.workspaceId === 'legacy' ? env.WORKSPACE_NAME : (await access.workspace(principal)).name, mode: local ? 'local' : 'connected', repositories: visible, missions: missions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), integrations: integrations(env, local), ai: await aiSettings(env, catalog) };
    return Response.json(workspace);
  }
  const cloudflareProject = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/cloudflare(?:\/(usage|action))?$/.exec(url.pathname);
  if (cloudflareProject) {
    const repository = await catalog.getRepository(cloudflareProject[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    let operation: ProjectOperation = cloudflareProject[2] === 'usage' ? 'usage' : 'get';
    let body: Record<string, unknown> = {};
    if (request.method === 'POST' && cloudflareProject[2] === 'action') {
      assertMutationOrigin(request);
      const input = await readJson(request);
      if (!['map', 'migration-plan', 'migration-execute', 'build-trigger'].includes(String(input.action))) throw new ApiError(400, 'INVALID_PROJECT_OPERATION', 'Choose a supported project operation.');
      const { action, ...fields } = input; operation = action as ProjectOperation; body = fields;
    } else if (request.method !== 'GET' || cloudflareProject[2] === 'action') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported project operation.');
    const read = { action: 'read' as const, resourceType: 'repository', resourceId: repository.id };
    const dependencies = projectDependencies(env, principal, { ...repository, workspaceId: principal.workspaceId }, {
      account: () => cloudflareAccount(env, principal, read),
      api: (path, options) => cloudflareApiRequest(env, principal, path, { ...options, authorization: options?.method === 'POST' ? { action: 'migrate', resourceType: 'database', resourceId: path.split('/')[3] } : read }),
      analytics: (query) => cloudflareAnalyticsRequest(env, principal, query, { ...read, expectedAccountId: query.expectedAccountId }),
    });
    return Response.json(await dispatchCloudflareProject(principal, { ...repository, workspaceId: principal.workspaceId }, operation, body, dependencies));
  }
  const deploymentsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/deployments$/.exec(url.pathname);
  if (deploymentsRoute) {
    const repository = await catalog.getRepository(deploymentsRoute[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    return deploymentsApi(request, {
      repository, principal,
      ledger: { state: () => coordinator.deployState(), saveSettings: (settings) => coordinator.saveDeploySettings(settings), create: (key, fingerprint, record) => coordinator.createDeployment(key, fingerprint, record), confirm: (id, actorId) => coordinator.confirmDeployment(id, actorId) },
      authorizeRead: () => access.authorize(principal, 'read', 'repository', repository.id),
      authorizeDeploy: (workerName) => access.authorize(principal, 'deploy', 'environment', workerName),
      canDeploy: async (workerName) => (await access.checkMany(principal, 'deploy', [{ resourceType: 'environment', resourceId: workerName }]))[0] === true,
      mappedWorkers: async () => {
        const { mapping } = await access.projectStore(principal, repository.id, 'get') as ProjectSnapshot;
        return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map(({ id, name, environment }) => ({ id, name, environment })) } : null;
      },
      headSha: () => env.ARTIFACTS ? repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch) : Promise.resolve(null),
      dispatch: async (record) => {
        if (!env.MISSION_WORKFLOW || !env.SANDBOX || !env.ARTIFACTS) return 'missing';
        return dispatchBackground(env.MISSION_WORKFLOW, deployWorkflowId(record.id), { kind: 'deploy', repositoryId: repository.id, deploymentId: record.id, principal: backgroundPrincipal(principal) } satisfies DeployParams);
      },
      failDispatch: async (record) => { await coordinator.updateDeployment(record.id, ['queued'], { status: 'failed', errorCode: 'DEPLOYMENT_NOT_STARTED', error: 'The deployment could not be scheduled.' }); },
    });
  }
  const issues = await handleIssues(request, url, principal, access, catalog, (id) => env.GITFLARE_COORDINATOR.getByName(`repository:${id}`));
  if (issues) return issues;
  const urlImport = await handleUrlImport(request, url, { env, principal, access, catalog, repositoryRecords: (id) => env.GITFLARE_COORDINATOR.getByName(`repository:${id}`) });
  if (urlImport) return urlImport;
  const releaseRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/releases(?:\/([a-zA-Z0-9-]+)(?:\/(publish|update|delete))?)?$/.exec(url.pathname);
  if (releaseRoute) {
    const repository = await catalog.getRepository(releaseRoute[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    return releaseApi(request, { artifacts: env.ARTIFACTS, repository, coordinator: env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`), principal, access }, releaseRoute[2], releaseRoute[3]);
  }
  const repositoryMatch = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/(tree|file|skills|proposal-base|import)$/.exec(url.pathname);
  if (request.method === 'GET' && repositoryMatch) {
    const repository = await catalog.getRepository(repositoryMatch[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'read', 'repository', repository.id);
    if (repositoryMatch[2] === 'import') {
      const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
      const { bootstrap: _bootstrap, ...status } = await inspectRepositoryImport(env.ARTIFACTS, repository, await coordinatorRead('repositoryBootstrapSha', () => coordinator.repositoryBootstrapSha()));
      return Response.json(status);
    }
    if (repositoryMatch[2] === 'proposal-base') {
      if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository before creating a proposal.');
      using source = await env.ARTIFACTS.get(repository.name);
      const commit = (await source.log({ ref: repository.defaultBranch, limit: 1 }))[0];
      if (!commit) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before creating a proposal.');
      return Response.json({ branch: repository.defaultBranch, commitSha: commit.hash, commitMessage: commit.message });
    }
    if (repositoryMatch[2] === 'skills') return Response.json(await listRepositorySkills(env.ARTIFACTS, repository, url.searchParams.get('ref') ?? undefined));
    return browseRepository(env, repository, repositoryMatch[2], url);
  }
  const branchWrite = request.method === 'POST' ? /^\/api\/repositories\/([a-zA-Z0-9-]+)\/branches(?:\/(delete))?$/.exec(url.pathname) : null;
  if (branchWrite) {
    const repository = await catalog.getRepository(branchWrite[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    return branchApi(request, { artifacts: env.ARTIFACTS, repository, coordinator: env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`), principal, access }, branchWrite[2] ? 'delete' : 'create');
  }
  const checkSettingsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/check-settings$/.exec(url.pathname);
  if (checkSettingsRoute) {
    const repository = await catalog.getRepository(checkSettingsRoute[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    if (request.method === 'GET') {
      await access.authorize(principal, 'read', 'repository', repository.id);
      return Response.json(checkSettingsSnapshot(repository.id, await coordinator.getCheckSettings(), await coordinator.getCheckDurations()));
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for check settings.');
    assertMutationOrigin(request);
    const key = requireIdempotencyKey(request), body = await readJson(request, 4096);
    await access.authorize(principal, 'land', 'repository', repository.id);
    const saved = await coordinator.setCheckSettings(key, normalizeCheckSettings(body), principal.userId);
    await access.auditRepositoryChange(principal, 'repository.check-settings', repository.id);
    return Response.json(checkSettingsSnapshot(repository.id, saved, await coordinator.getCheckDurations()));
  }
  const branchRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/(branches|branch-protection|pulls)$/.exec(url.pathname);
  if (branchRoute) {
    const repository = await catalog.getRepository(branchRoute[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const writing = request.method === 'POST';
    if (!writing && (request.method !== 'GET' || branchRoute[2] === 'pulls')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported branch operation.');
    await access.authorize(principal, !writing ? 'read' : branchRoute[2] === 'branch-protection' ? 'manage' : 'contribute', 'repository', repository.id);
    if (!writing && branchRoute[2] === 'branch-protection') return Response.json(protectionSnapshot(repository.id, repository.defaultBranch, await coordinator.getBranchProtection()));
    if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to use streams.');
    if (!writing) return Response.json({ repositoryId: repository.id, defaultBranch: repository.defaultBranch, gitUrl: `${url.origin}/git/${repository.name}.git`, branches: await listBranches(env.ARTIFACTS, repository, effectiveRules(await coordinator.getBranchProtection(), repository.defaultBranch)) });
    assertMutationOrigin(request);
    const key = requireIdempotencyKey(request), body = await readJson(request, 65_536);
    if (branchRoute[2] === 'branch-protection') { await coordinator.setBranchProtection(key, body.rules, principal.userId); return Response.json(protectionSnapshot(repository.id, repository.defaultBranch, await coordinator.getBranchProtection())); }
    await access.authorize(principal, 'execute', 'repository', repository.id);
    if (!env.MISSION_WORKFLOW || !executionReadiness(env, 'skill-edit').ready) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect the required services before opening a pull request.');
    const title = requireString(body.title, 'Title', 120), branch = branchName(body.branch);
    const description = body.description === undefined || body.description === '' ? undefined : requireString(body.description, 'Description', 8000);
    if (branch === repository.defaultBranch) throw new ApiError(400, 'INVALID_PULL_REQUEST', 'Choose a branch other than the default branch.');
    const current = await currentRepository(env, repository);
    if (!current.headSha) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit to the default branch first.');
    const headSha = await repositoryHead(env.ARTIFACTS, repository.name, branch).catch(() => null);
    if (!headSha) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${branch} was not found. Push it first.`);
    if (headSha === current.headSha) throw new ApiError(409, 'NOTHING_TO_MERGE', `${branch} has no commits that are not already on ${repository.defaultBranch}.`);
    const models = await coordinatorRead('getModelConnections', () => catalog.getModelConnections());
    const authorization = { principal, workspaceId: principal.workspaceId, creatorId: principal.userId };
    const draft = await coordinator.createMission(key, { repositoryId: repository.id, expectedBaseSha: current.headSha, title, prompt: description ?? `Merge ${branch} into ${repository.defaultBranch}.`, branchChange: { branch, headSha, targetBranch: repository.defaultBranch, ...(description ? { description } : {}) } }, authorization, models);
    return Response.json(await startWithDurableDispatch(coordinator, `${key.slice(0, 120)}-start`, draft.id, authorization, models), { status: 202 });
  }
  const match = /^\/api\/missions\/([a-zA-Z0-9-]+)(?:\/(start|cancel|approve|revoke|integrate|preview|attempts|review|select|revert|pull|retry-checks))?$/.exec(url.pathname);
  if (request.method === 'GET' && match && !match[2]) { const {mission,repository} = await findMission(env, match[1], principal.workspaceId); await access.authorize(principal, 'read', 'repository', repository.id, mission.id); return Response.json(mission); }
  if (request.method === 'GET' && match?.[2] === 'attempts') {
    const { repository, mission } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'read', 'repository', repository.id, mission.id);
    return Response.json({ attempts: await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).listAttempts(mission.id) });
  }
  if (request.method === 'GET' && match?.[2] === 'preview') {
    const { repository, mission } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'read', 'repository', repository.id, mission.id);
    return Response.json(await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).previewStatus(mission.id));
  }
  if (request.method !== 'POST') throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, repositoryMatch?.[2] === 'import' ? IMPORT_REQUEST_MAX_BYTES : repositoryMatch?.[2] === 'skills' ? SKILL_REQUEST_MAX_BYTES : url.pathname === '/api/missions' ? MISSION_REQUEST_MAX_BYTES : undefined);
  if (repositoryMatch?.[2] === 'import') {
    const repository = await catalog.getRepository(repositoryMatch[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'manage', 'repository', repository.id);
    if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository before importing code.');
    const input = validateImportInput(body), fingerprint = importFingerprint(input);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const reconcile = async (receipt: import('./repository-import').ImportReceipt) => {
      if (receipt.rejection) throw new ApiError(receipt.rejection.status, receipt.rejection.code, receipt.rejection.message);
      if (receipt.result) { await catalog.saveRepository(receipt.result.repository); return receipt.result; }
      const actual = await repositoryHead(env.ARTIFACTS!, repository.name, repository.defaultBranch);
      if (!receipt.candidateSha || actual !== receipt.candidateSha) throw new ApiError(409, 'IMPORT_PENDING', 'This import is pending or has an uncertain outcome. Its canonical write will not be repeated. Retry the original request after the commit becomes visible.');
      const updated = { ...repository, headSha: actual, updatedAt: new Date().toISOString() };
      const result = await coordinator.completeRepositoryImport(key, fingerprint, updated);
      await catalog.saveRepository(updated);
      return result;
    };
    const previous = await coordinator.getImportRequest(key, fingerprint);
    if (previous) return Response.json(await reconcile(previous));
    const archive = parseImportArchive(input.archiveBase64);
    const state = await inspectRepositoryImport(env.ARTIFACTS, repository, await coordinatorRead('repositoryBootstrapSha', () => coordinator.repositoryBootstrapSha()));
    if (state.headSha !== input.expectedHeadSha) throw new ApiError(409, 'STALE_IMPORT_HEAD', 'The repository commit changed. Refresh before importing.');
    if (!state.allowed) throw new ApiError(409, 'IMPORT_NOT_ALLOWED', state.reason);
    const files = [...archive.files, ...state.bootstrap.filter(file => !archive.files.some(imported => imported.path === file.path))];
    buildImportPack(files, input.expectedHeadSha, Math.floor(Date.now() / 1000), input.message);
    const claim = await coordinator.claimRepositoryImport(key, fingerprint);
    if (!claim.claimed) return Response.json(await reconcile(claim.receipt));
    const built = buildImportPack(files, input.expectedHeadSha, claim.receipt.timestamp, input.message);
    await coordinator.prepareRepositoryImport(key, fingerprint, built.commitSha, files.map(file => file.path), archive.skipped);
    try { await pushRepositoryImport(env.ARTIFACTS, repository, input.expectedHeadSha, built, () => access.check(principal, 'manage', 'repository', repository.id)); }
    catch (error) {
      const actual = await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch).catch(() => null);
      if (actual !== built.commitSha) {
        if (error instanceof RepositoryImportFailure && error.outcome === 'not_pushed') await coordinator.rejectRepositoryImport(key, fingerprint, { status: error.status, code: error.code, message: error.message });
        throw error;
      }
    }
    return Response.json(await reconcile({ ...claim.receipt, candidateSha: built.commitSha }));
  }
  if (repositoryMatch?.[2] === 'skills') {
    const repository = await catalog.getRepository(repositoryMatch[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.check(principal, 'contribute', 'repository', repository.id);
    await access.check(principal, 'execute', 'repository', repository.id);
    const change = validateRepositorySkillChange(body);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const replay = await coordinator.getSkillEditRequest(key, repository.id, change);
    if (replay) return Response.json(replay, { status: 202 });
    const readiness = executionReadiness(env, 'skill-edit');
    if (!readiness.ready || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', `Connect the required services before editing skills: ${[...readiness.missing, ...(!env.MISSION_WORKFLOW ? ['Mission Workflow'] : [])].join(', ')}.`);
    await verifyRepositorySkillChange(env.ARTIFACTS, repository, change);
    await currentRepository(env, repository);
    const mission = await coordinator.createSkillMissionWithDispatch(key, repository.id, change, { principal, workspaceId: principal.workspaceId, creatorId: principal.userId });
    return Response.json(mission, { status: 202 });
  }
  if (url.pathname === '/api/repositories/connect') {
    await access.authorize(principal, 'manage');
    if (principal.workspaceId !== 'legacy') throw new ApiError(403, 'REPOSITORY_OWNERSHIP_REQUIRED', 'Connecting pre-existing shared namespace repositories requires verified ownership; create an isolated repository instead.');
    if (!env.ARTIFACTS) throw new ApiError(503, 'REPOSITORY_SETUP_REQUIRED', 'Connect the Artifacts binding before adding an existing repository.');
    const name = repositoryName(body.name);
    if (/^w-[a-f0-9]{32}-/.test(name)) throw new ApiError(403, 'RESERVED_NAMESPACE', 'Isolated workspace repositories cannot be attached to the legacy workspace.');
    const description = body.description === undefined || body.description === '' ? '' : requireString(body.description, 'Description', 500);
    let verified: { remote: string; defaultBranch: string; headSha: string | null };
    try {
      using source = await env.ARTIFACTS.get(name);
      const info = await source.info();
      verified = { remote: info.remote, defaultBranch: info.defaultBranch || 'main', headSha: (await source.log({ ref: info.defaultBranch || 'main', limit: 1 }))[0]?.hash ?? null };
    } catch {
      throw new ApiError(404, 'ARTIFACTS_REPOSITORY_NOT_FOUND', 'This repository was not found in the configured Artifacts namespace. Check its name and binding.');
    }
    if (body.remote !== undefined && body.remote !== '' && requireString(body.remote, 'Remote', 2000) !== verified.remote) throw new ApiError(400, 'REMOTE_MISMATCH', 'The supplied remote does not match the verified Artifacts repository.');
    const now = new Date().toISOString();
    const repository = await catalog.connectRepository(key, { id: crypto.randomUUID(), workspaceId: principal.workspaceId, name, description, provider: 'artifacts', ...verified, createdAt: now, updatedAt: now });
    await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).saveRepository(repository);
    return Response.json(repository, { status: 201 });
  }
  if (url.pathname === '/api/repositories') {
    const initialization = validateRepositoryInitialization(body);
    await access.authorize(principal, 'manage');
    const requestedName = repositoryName(body.name);
    if (principal.workspaceId === 'legacy' && /^w-[a-f0-9]{32}-/.test(requestedName)) throw new ApiError(403, 'RESERVED_NAMESPACE', 'This repository prefix is reserved for isolated workspaces.');
    const name = principal.workspaceId === 'legacy' ? requestedName : repositoryName(`w-${principal.workspaceId.replace(/-/g, '')}-${requestedName.slice(0, 29)}`);
    const description = body.description === undefined || body.description === '' ? '' : requireString(body.description, 'Description', 500);
    if (!local && !env.ARTIFACTS) throw new ApiError(503, 'REPOSITORY_SETUP_REQUIRED', 'Connect Artifacts before creating a repository.');
    const now = new Date().toISOString();
    let repository = await catalog.createRepository(key, { id: crypto.randomUUID(), workspaceId: principal.workspaceId, name, description, defaultBranch: 'main', headSha: null, provider: env.ARTIFACTS ? 'artifacts' : 'local', createdAt: now, updatedAt: now });
    if (repository.provider === 'artifacts') {
      repository = await catalog.getRepository(repository.id) ?? repository;
      if (!repository.remote) {
        if (!await catalog.claimProvision(repository.id)) throw new ApiError(409, 'PROVISIONING_PENDING', 'This repository is being provisioned or needs reconciliation after an interrupted request. Its creation will not be repeated.');
        try {
          const provisioned = await createArtifactsRepository(env, { name, description });
          repository = { ...repository, ...provisioned, updatedAt: new Date().toISOString() };
          await catalog.saveRepository(repository);
        } catch {
          throw new ApiError(503, 'PROVISIONING_INTERRUPTED', 'Repository provisioning did not finish. Inspect its Artifacts state before retrying to avoid creating duplicate resources.');
        }
      }
    }
    if (env.ARTIFACTS && repository.provider === 'artifacts' && !repository.headSha) {
      const initialized = await initializeArtifactsRepository(env.ARTIFACTS, repository.name, { name: requestedName, description, options: initialization });
      if (initialized.headSha) { await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).saveRepositoryBootstrapSha(initialized.headSha); repository = { ...repository, headSha: initialized.headSha, updatedAt: new Date().toISOString() }; await catalog.saveRepository(repository); }
    }
    await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).saveRepository(repository);
    return Response.json(repository, { status: 201 });
  }
  if (url.pathname === '/api/missions/draft') {
    await requireAi(env, catalog);
    const draft = draftRequest(body);
    const repositoryId = requireString(body.repositoryId, 'Repository', 100);
    const repository = await catalog.getRepository(repositoryId);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'contribute', 'repository', repositoryId);
    await security(env).rateLimit(`mission-draft:${principal.userId}`, 30, 3_600_000);
    const model = resolveModelConnection(await coordinatorRead('getModelConnections', () => catalog.getModelConnections()), typeof body.model === 'string' ? body.model : undefined);
    const credentials = await aiCredentials(catalog);
    assertModelAccess(env, principal.workspaceId, credentials, [model]);
    await reserveOperatorUsage(env, principal.workspaceId, credentials, [model], 'draft', key, catalog);
    const snapshot = await repositorySnapshot(env.ARTIFACTS, repository);
    try { return Response.json({ ...await draftMission({ ...env, modelAccess: createModelAccess(env, principal.workspaceId, { getAiCredentials: () => aiCredentials(catalog) }) }, model, draft, snapshot), baseSha: snapshot.commitSha, model: model.id }); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'DRAFT_FAILED', 'The model could not draft this mission right now. Try again, or fill the fields yourself.');
    }
  }
  if (url.pathname === '/api/missions') {
    const input = missionInput(body);
    if (!input.skillChange && !input.revertChange) { await requireAi(env, catalog); assertWorkspaceAi(env, principal.workspaceId, await aiCredentials(catalog)); }
    const repository = await catalog.getRepository(input.repositoryId);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'contribute', 'repository', input.repositoryId);
    await currentRepository(env, repository);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${input.repositoryId}`);
    const mission = await coordinator.createMission(key, input, { principal, workspaceId: principal.workspaceId, creatorId: principal.userId }, await coordinatorRead('getModelConnections', () => catalog.getModelConnections()));
    return Response.json(mission, { status: 201 });
  }
  if (match?.[2] === 'retry-checks') {
    const { mission, repository } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'land', 'repository', repository.id, mission.id);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const adjusted = retryCheckSettings(mission, await coordinator.getCheckSettings(), body.adjustment);
    await coordinator.setCheckSettings(`${key.slice(0, 100)}-check-settings`, adjusted, principal.userId);
    await access.auditRepositoryChange(principal, `repository.check-settings.retry-${String(body.adjustment)}`, repository.id);
    match[2] = mission.branchChange ? 'pull' : 'start';
    if (mission.branchChange) body.action = 'update';
  }
  if (match?.[2] && match[2] !== 'attempts') {
    const { mission, repository } = await findMission(env, match[1], principal.workspaceId);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const reviewInput = match[2] === 'review' ? reviewMissionInput(body) : undefined;
    const pullAction = match[2] === 'pull' ? body.action : undefined;
    if (match[2] === 'pull' && !['update', 'close', 'reopen'].includes(String(pullAction))) throw new ApiError(400, 'INVALID_PULL_ACTION', 'Choose update, close or reopen.');
    const action: Action = reviewInput ? (reviewInput.action === 'comment' ? 'contribute' : 'review') : match[2] === 'start' || match[2] === 'revert' || (pullAction && pullAction !== 'close') ? 'execute' : ['approve', 'revoke', 'select'].includes(match[2]) ? 'review' : match[2] === 'integrate' ? 'land' : match[2] === 'preview' ? 'read' : 'contribute';
    try { await access.authorize(principal, action, 'repository', repository.id, mission.id); }
    catch (error) {
      if (reviewInput?.action !== 'comment' || publicError(error).code !== 'FORBIDDEN') throw error;
      await access.authorize(principal, 'review', 'repository', repository.id, mission.id);
    }
    if (reviewInput) {
      const reviewed = await coordinator.reviewMission(key, mission.id, reviewInput, principal.userId, principal);
      await coordinator.settleApprovalClears(mission.id, principal);
      return Response.json(reviewed);
    }
    if (match[2] === 'cancel') { const cancelled = await coordinator.cancelMission(key, mission.id); await retireWorkerPreview(env, repository.id, mission.id, principal.workspaceId); return Response.json(cancelled); }
    if (match[2] === 'pull') {
      if (!mission.branchChange) throw new ApiError(409, 'NOT_A_PULL_REQUEST', 'This mission is not a pull request.');
      if (pullAction === 'close') { const closed = await coordinator.pullRequestAction(key, mission.id, 'close', principal.userId, undefined, principal); await coordinator.settleApprovalClears(mission.id, principal); await retireWorkerPreview(env, repository.id, mission.id, principal.workspaceId); return Response.json(closed); }
      await access.authorize(principal, 'contribute', 'repository', repository.id, mission.id);
      if (!env.MISSION_WORKFLOW || !executionReadiness(env, 'skill-edit').ready || !env.ARTIFACTS) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect the required services before running pull request checks.');
      await currentRepository(env, repository);
      const headSha = await repositoryHead(env.ARTIFACTS, repository.name, mission.branchChange.branch).catch(() => null);
      if (!headSha) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${mission.branchChange.branch} no longer exists.`);
      await coordinator.pullRequestAction(key, mission.id, pullAction as 'update' | 'reopen', principal.userId, headSha, principal);
      await coordinator.settleApprovalClears(mission.id, principal);
      const authorization = { principal, workspaceId: principal.workspaceId, creatorId: mission.authorization?.creatorId ?? principal.userId };
      return Response.json(await startWithDurableDispatch(coordinator, `${key.slice(0, 120)}-start`, mission.id, authorization, await coordinatorRead('getModelConnections', () => catalog.getModelConnections())), { status: 202 });
    }
    if (match[2] === 'select') {
      if (!Number.isInteger(body.epoch)) throw new ApiError(400, 'INVALID_INPUT', 'Include the attempt number this selection applies to.');
      const selected = await coordinator.selectCandidate(key, mission.id, requireString(body.runId, 'Agent run', 100), body.epoch as number, principal.userId, principal);
      await coordinator.settleApprovalClears(mission.id, principal);
      return Response.json(selected);
    }
    if (match[2] === 'preview') {
      if (!env.PREVIEW_ORIGIN || !env.SANDBOX || !env.ARTIFACTS) throw new ApiError(503, 'PREVIEW_NOT_CONFIGURED', 'Configure the isolated preview service before creating a preview.');
      const target = previewTarget(env.PREVIEW_ORIGIN, url.origin);
      if (!mission.candidateSha || !mission.checks.some((check) => check.candidateSha === mission.candidateSha && check.status === 'passed') || mission.checks.some((check) => check.status !== 'passed')) throw new ApiError(409, 'CHECKS_REQUIRED', 'The current integration candidate must pass verification before preview.');
      if (!env.MISSION_WORKFLOW) throw new ApiError(503, 'PREVIEW_NOT_CONFIGURED', 'Configure the Mission Workflow before creating a preview.');
      const reserved = await catalog.reservePreviewSlot(mission.id, Date.now() + PREVIEW_STEP_MS);
      let claim: Awaited<ReturnType<typeof coordinator.claimPreview>>;
      try { claim = await coordinator.claimPreview(key, mission.id, mission.epoch, mission.candidateSha); }
      catch (error) { if (reserved) await catalog.releasePreviewSlot(mission.id); throw error; }
      if (claim.previous) await env.SANDBOX.getByName(claim.previous).destroy().catch(() => {});
      if (claim.worker) return Response.json({ status: 'ready', kind: 'worker', candidateSha: mission.candidateSha, expiresAt: new Date(claim.expiresAt ?? Date.now()).toISOString(), previewUrl: claim.worker.previewUrl ?? claim.worker.deploymentUrl, deploymentUrl: claim.worker.deploymentUrl, previewName: claim.worker.previewName, notes: claim.worker.notes, access: 'public' });
      const sandboxName = claim.sandboxName;
      if (!sandboxName) {
        if (claim.claimed && await dispatchBackground(env.MISSION_WORKFLOW, previewWorkflowId(claim.claimId), { kind: 'preview', repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha: mission.candidateSha, claimId: claim.claimId, principal }) === 'missing') {
          if (await coordinator.previewFailed(mission.id, claim.claimId)) await catalog.releasePreviewSlot(mission.id);
          throw new ApiError(503, 'PREVIEW_NOT_STARTED', 'The preview could not be scheduled. Try again.');
        }
        return Response.json({ status: 'starting', candidateSha: mission.candidateSha, message: PREVIEW_STARTING_MESSAGE }, { status: 202 });
      }
      const current = await coordinator.getMission(mission.id);
      if (!current || current.epoch !== mission.epoch || current.candidateSha !== mission.candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(current.status)) throw new ApiError(409, 'STALE_PREVIEW', 'The candidate changed while the preview was starting.');
      const token = mintPreviewToken(principal.workspaceId);
      const expiresAt = Math.min(Date.now() + PREVIEW_CAPABILITY_MS, claim.expiresAt ?? Infinity);
      await access.check(principal, 'read', 'repository', repository.id, mission.id);
      await env.GITFLARE_COORDINATOR.getByName(previewCapabilityStore(principal.workspaceId)).savePreviewCapability(await capabilityHash(token), { workspaceId: principal.workspaceId, principal, repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha: mission.candidateSha, sandboxName, expiresAt, host: target.host, isolated: target.isolated });
      return Response.json({ status: 'ready', previewUrl: `${target.origin}/open/${token}`, candidateSha: mission.candidateSha, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (match[2] === 'revert') {
      await access.authorize(principal, 'contribute', 'repository', repository.id);
      if (mission.status !== 'integrated' || !mission.candidateSha || !mission.baseSha) throw new ApiError(409, 'NOT_LANDED', 'Only a landed mission can be reverted.');
      if (!env.MISSION_WORKFLOW || !executionReadiness(env, 'skill-edit').ready) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect the required services before reverting.');
      const current = await currentRepository(env, repository);
      const models = await coordinatorRead('getModelConnections', () => catalog.getModelConnections());
      const authorization = { principal, workspaceId: principal.workspaceId, creatorId: principal.userId };
      const draft = await coordinator.createMission(key, { repositoryId: repository.id, expectedBaseSha: current.headSha ?? undefined, title: `Revert: ${mission.title}`.slice(0, 120), prompt: `Undo the change that mission "${mission.title}" landed as commit ${mission.candidateSha}, restoring the files it changed to commit ${mission.baseSha}. Later commits stay in place.`, revertChange: { missionId: mission.id, title: mission.title.slice(0, 120), landedSha: mission.candidateSha, previousSha: mission.baseSha } }, authorization, models);
      const started = await startWithDurableDispatch(coordinator, `${key.slice(0, 120)}-start`, draft.id, authorization, models);
      return Response.json(started, { status: 202 });
    }
    if (match[2] === 'start') {
      if (!mission.skillChange && !mission.revertChange && !mission.branchChange) {
        await requireAi(env, catalog);
        const credentials = await aiCredentials(catalog);
        assertWorkspaceAi(env, principal.workspaceId, credentials);
        const models = mission.runs.flatMap(run => run.modelConfig ? [run.modelConfig] : []);
        assertModelAccess(env, principal.workspaceId, credentials, models);
        await reserveOperatorUsage(env, principal.workspaceId, credentials, models, 'mission', `${mission.id}:${mission.epoch}`, catalog);
      }
      const readiness = executionReadiness(env, mission.skillChange || mission.revertChange || mission.branchChange ? 'skill-edit' : 'agent');
      if (!readiness.ready || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', `Connect the required services before running agents: ${[...readiness.missing, ...(!env.MISSION_WORKFLOW ? ['Mission Workflow'] : [])].join(', ')}.`);
      const current = await currentRepository(env, repository);
      if (!current.headSha) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before starting a mission.');
      const started = await startWithDurableDispatch(coordinator, key, mission.id, { principal, workspaceId: principal.workspaceId, creatorId: mission.authorization?.creatorId ?? principal.userId }, await coordinatorRead('getModelConnections', () => catalog.getModelConnections()));
      return Response.json(started, { status: 202 });
    }
    const candidateSha = requireString(body.candidateSha, 'Candidate commit', 40, 40);
    const baseSha = requireString(body.baseSha, 'Base commit', 40, 40);
    if (!/^[a-f0-9]{40}$/.test(candidateSha) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
    if (match[2] === 'revoke') { const result = await coordinator.revokeApproval(key, mission.id, candidateSha, baseSha, principal); await coordinator.settleApprovalClears(mission.id, principal); return Response.json(result); }
    const current = await currentRepository(env, repository);
    if (match[2] === 'integrate') {
      if (!env.SANDBOX || !env.ARTIFACTS || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect Artifacts, Sandbox and the Mission Workflow before integrating.');
      const rule = await landingReviewRule(env, repository);
      await access.assertLand(principal, mission.id, candidateSha, baseSha, mission.epoch, repository.id, rule);
      const claim = await coordinator.beginIntegration(key, mission.id, candidateSha, baseSha);
      if (claim.mission.status === 'integrated') return Response.json(claim.mission);
      if (!claim.claimId) throw new ApiError(500, 'INTEGRATION_CLAIM_MISSING', 'The integration claim could not be established.');
      if (!claim.claimed) {
        if (current.headSha === candidateSha) return Response.json(await coordinator.completeIntegration(mission.id, claim.mission.epoch, candidateSha, claim.claimId));
        if (await backgroundState(env.MISSION_WORKFLOW, landingWorkflowId(claim.claimId)) === 'running') return Response.json(claim.mission, { status: 202 });
        if (await coordinator.releaseStaleIntegration(mission.id, claim.claimId)) throw new ApiError(409, 'INTEGRATION_RELEASED', 'An earlier landing attempt ended without updating the canonical branch. Its claim was released; retry landing.');
        throw new ApiError(409, 'INTEGRATION_PENDING', integrationPendingMessage(candidateSha));
      }
      if (await dispatchBackground(env.MISSION_WORKFLOW, landingWorkflowId(claim.claimId), { kind: 'land', repositoryId: repository.id, missionId: mission.id, epoch: claim.mission.epoch, candidateSha, baseSha, claimId: claim.claimId, principal }) === 'missing') {
        await coordinator.integrationFailed(mission.id, claim.mission.epoch, claim.claimId, 'not_pushed');
        throw new ApiError(503, 'INTEGRATION_NOT_STARTED', 'Landing could not be scheduled and nothing was pushed. Retry landing.');
      }
      return Response.json(claim.mission, { status: 202 });
    }
    assertReviewClear(mission);
    await coordinator.settleApprovalClears(mission.id, principal);
    const approval = await access.recordApproval(principal, mission.id, candidateSha, baseSha, mission.epoch, mission.checks, mission.authorization?.creatorId, await landingReviewRule(env, repository));
    if (!approval.ready) return Response.json({ ...mission, approval });
    return Response.json(await coordinator.approveMission(key, mission.id, candidateSha, baseSha, principal.userId));
  }
  throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
}

async function aiSettings(env: AppEnv, catalog: { getAiEnabled(): Promise<boolean> }): Promise<AiSettings> {
  const locked = env.AI_FEATURES === 'disabled';
  if (locked) return { enabled: false, locked };
  try { return { enabled: await catalog.getAiEnabled(), locked }; }
  catch { return { enabled: true, locked }; }
}

async function requireAi(env: AppEnv, catalog: { getAiEnabled(): Promise<boolean> }): Promise<void> {
  if (!(await aiSettings(env, catalog)).enabled) throw new ApiError(403, 'AI_DISABLED', 'AI features are turned off for this workspace. An Owner can turn them on in Settings.');
}

const ENTRY_PATHS = new Set(['/', '/signin', '/signup']);

async function entryRedirect(request: Request, env: AppEnv, path: string): Promise<Response | null> {
  if (request.method !== 'GET' || !ENTRY_PATHS.has(path)) return null;
  const session = cookieValue(request);
  const signedIn = session ? await security(env).authenticate(session).then(() => true, () => false) : false;
  const location = signedIn ? (path === '/' && env.EDITION !== 'self-hosted' ? null : '/overview') : env.EDITION === 'self-hosted' && path === '/' ? '/signin' : null;
  return location ? new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } }) : null;
}

const application = {
  async fetch(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/git/')) {
      try { return (await handleGitRequest(request, gitDependencies(env)))!; }
      catch (error) { console.error(JSON.stringify({ event: 'git_request_failed', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 200), stack: error instanceof Error ? error.stack?.split('\n').slice(1, 6).join(' | ') : undefined })); return new Response('Gitflare could not complete this Git request. Try again shortly.\n', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
    }
    const publicGit = await publicGitResponse(request, env);
    if (publicGit) return publicGit;
    if (path === '/oauth/authorize') return oauthConsent(request, env, authorize);
    if (path === '/llms.txt') return new Response('# Gitflare\n\n' + listPublicDocs().map(doc => `- [${doc.title}](${new URL(request.url).origin}/api/public/docs/${doc.id}.md): ${doc.description}`).join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const publicPage = publicPageResponse(request, env);
    if (publicPage) return publicPage;
    const entry = await entryRedirect(request, env, path);
    if (entry) return entry;
    if (!path.startsWith('/api/') && path !== '/mcp') return env.ASSETS.fetch(request);
    let response: Response;
    try {
      if (path === '/mcp') {
        const subject = rateSubject(await authorize(request, env, true));
        response = await handleMcp(request, async (internal) => {
          const headers = new Headers(internal.headers);
          headers.set('Authorization', request.headers.get('Authorization') ?? '');
          const workspace = request.headers.get('X-Gitflare-Workspace'); if (workspace) headers.set('X-Gitflare-Workspace', workspace);
          return api(new Request(internal, { headers }), env);
        }, kind => consume(env, kind === 'read' ? 'MCP_READ_RATE_LIMIT' : 'MCP_WRITE_RATE_LIMIT', subject));
      } else {
        const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
        const limited = bearer ? await consume(env, 'API_RATE_LIMIT', `token:${await hashToken(bearer)}`) : null;
        response = limited ? rateLimitedResponse(limited, 'API requests') : await api(request, env, ctx);
      }
    } catch (error) {
      const failure = publicError(error);
      if (failure.code === 'INTERNAL_ERROR') console.error(JSON.stringify({ event: 'api_unexpected_error', method: request.method, route: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id'), name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 200), stack: error instanceof Error ? error.stack?.split('\n').slice(1, 6).join(' | ') : undefined }));
      response = Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (path === '/mcp' && response.status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="gitflare"');
    return response;
  },
} satisfies ExportedHandler<AppEnv>;

export default {
  async fetch(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (env.OAUTH_KV && (path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/'))) {
        if (path.startsWith('/oauth/') && request.method === 'POST') await security(env).rateLimit(`oauth:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 60, 60000);
        return await oauthProvider(new URL(request.url).origin, application, authorize).fetch(request, env, ctx!);
      }
      return await application.fetch(request, env, ctx);
    } catch (error) { const failure = publicError(error); return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } }); }
  },
} satisfies ExportedHandler<AppEnv>;
