import { listRepositorySkills } from './repository-skills';
import { assertReviewClear, currentReviewRequests, reviewMissionInput } from './proposal-review';
import { timingSafeEqual } from 'node:crypto';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { IntegrationStatus, Mission, Repository, Workspace } from '../shared/types';
import { createArtifactsRepository, repositoryHead } from './artifacts';
import { ApiError, assertMutationOrigin, isLocalRequest, missionInput, publicError, readJson, repositoryName, repositoryPath, repositoryRef, requireIdempotencyKey, requireString } from './domain';
import type { AppEnv } from './env';
import { executionReadiness, integrateCandidate, IntegrationFailure, prepareCandidatePreview } from './execution';
import { handleMcp, mcpToolNames } from './mcp';
import { PREVIEW_HEARTBEAT_MS, startWithDurableDispatch } from './coordinator';
import type { Principal, Action } from './security';
import { listDocs, readDoc } from './docs';
import { documentationImage, documentationMarkdown } from './docs-markdown';
import { handleOnboarding } from './onboarding';
import { listPublicDocs, readPublicDoc, publicSourceResponse } from './distribution';
import { oauthConsent, oauthProvider } from './oauth';
import { publicGitResponse } from './hosted-source';
import { deliverInvitation } from './email';
import { handleCloudflare, cloudflareAccount, cloudflareApiRequest, cloudflareAnalyticsRequest } from './cloudflare';
import { dispatchCloudflareProject, projectDependencies, type ProjectOperation } from './cloudflare-projects';
import { validateRepositoryInitialization, initializeArtifactsRepository } from './repository-initialization';

export { GitflareSecurity } from './security';
export { GitflareCoordinator } from './coordinator';
export { MissionWorkflow } from './workflow';
export { AgentSandbox, BootstrapOutbound, GitOutbound } from '../../runner/sandbox';

const encoder = new TextEncoder();

async function capabilityHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class PreviewRelay extends WorkerEntrypoint<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    const token = request.headers.get('X-Gitflare-Preview');
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return new Response('Preview access is required.', { status: 401 });
    const capability = await this.env.GITFLARE_COORDINATOR.getByName('catalog:owner').getPreviewCapability(await capabilityHash(token));
    if (!capability || !this.env.SANDBOX) return new Response('This preview has expired.', { status: 410 });
    if (!capability.principal) return new Response('This preview requires renewal.', { status: 410 });
    try { await security(this.env).check(capability.principal, 'read', 'repository', capability.repositoryId, capability.missionId); } catch { return new Response('Preview authority has been revoked.', { status: 410 }); }
    const mission = await this.env.GITFLARE_COORDINATOR.getByName(`repository:${capability.repositoryId}`).getMission(capability.missionId);
    if (!mission || mission.epoch !== capability.epoch || mission.candidateSha !== capability.candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(mission.status)) return new Response('This candidate preview is no longer current.', { status: 410 });
    if (request.headers.get('X-Gitflare-Preview-Validate') === '1') return new Response(null, { status: 204 });
    const headers = new Headers(request.headers);
    headers.delete('Authorization');
    headers.delete('Cookie');
    headers.delete('X-Gitflare-Preview');
    headers.delete('X-Gitflare-Preview-Validate');
    const response = await this.env.SANDBOX.getByName(capability.sandboxName).preview(new Request(request, { headers }));
    const safe = new Response(response.body, response);
    safe.headers.delete('Set-Cookie');
    safe.headers.set('Cache-Control', 'no-store');
    safe.headers.set('Referrer-Policy', 'no-referrer');
    return safe;
  }
}

async function tokenMatches(token: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

function security(env: AppEnv) { if (!env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.'); return env.GITFLARE_SECURITY.getByName('security'); }
function catalogName(workspaceId: string) { return workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${workspaceId}`; }
function cookieValue(request: Request) { return request.headers.get('Cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith('gitflare_session='))?.slice(17); }
function sessionResponse(result: { token?: string; user?: unknown; workspaceId?: string; mfaRequired?: boolean }) { if (!result.token) return Response.json(result); const { token, ...body } = result; return Response.json({ ok: true, ...body }, { headers: { 'Set-Cookie': `gitflare_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` } }); }
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

async function findMission(env: AppEnv, missionId: string, workspaceId: string): Promise<{ mission: Mission; repository: Repository }> {
  const repositories = await env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)).listRepositories();
  for (const repository of repositories) {
    const mission = await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).getMission(missionId);
    if (mission) return { mission, repository };
  }
  throw new ApiError(404, 'MISSION_NOT_FOUND', 'This mission could not be found.');
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

async function api(request: Request, env: AppEnv): Promise<Response> {
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
  const onboarding = await handleOnboarding(request, env, authorize);
  if (onboarding) return onboarding;
  if (request.method === 'POST' && ['/api/login', '/api/session'].includes(url.pathname)) {
    assertMutationOrigin(request);
    await security(env).rateLimit(`auth:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
    const body = await readJson(request);
    if (url.pathname === '/api/login') return sessionResponse(await security(env).login(body));
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
    const repositories = (await catalog.listRepositories());
    const visible: Repository[] = [];
    for (const repository of repositories) { try { await access.check(principal, 'read', 'repository', repository.id); visible.push(repository); } catch {} }
    const groups = await Promise.all(visible.map((repository) => env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).listMissions()));
    const missions: Mission[] = [];
    for (const mission of groups.flat()) { try { await access.check(principal, 'read', 'repository', mission.repositoryId, mission.id); missions.push(mission); } catch {} }
    const workspace: Workspace = { name: principal.workspaceId === 'legacy' ? env.WORKSPACE_NAME : (await access.workspace(principal)).name, mode: local ? 'local' : 'connected', repositories: visible, missions: missions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), integrations: integrations(env, local) };
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
  const repositoryMatch = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/(tree|file|skills)$/.exec(url.pathname);
  if (request.method === 'GET' && repositoryMatch) {
    const repository = await catalog.getRepository(repositoryMatch[1]);
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'read', 'repository', repository.id);
    if (repositoryMatch[2] === 'skills') return Response.json(await listRepositorySkills(env.ARTIFACTS, repository, url.searchParams.get('ref') ?? undefined));
    return browseRepository(env, repository, repositoryMatch[2], url);
  }
  const match = /^\/api\/missions\/([a-zA-Z0-9-]+)(?:\/(start|cancel|approve|revoke|integrate|preview|attempts|review))?$/.exec(url.pathname);
  if (request.method === 'GET' && match && !match[2]) { const {mission,repository} = await findMission(env, match[1], principal.workspaceId); await access.authorize(principal, 'read', 'repository', repository.id, mission.id); return Response.json(mission); }
  if (request.method === 'GET' && match?.[2] === 'attempts') {
    const { repository, mission } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'read', 'repository', repository.id, mission.id);
    return Response.json({ attempts: await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).listAttempts(mission.id) });
  }
  if (request.method !== 'POST') throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request);
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
      if (initialized.headSha) { repository = { ...repository, headSha: initialized.headSha, updatedAt: new Date().toISOString() }; await catalog.saveRepository(repository); }
    }
    await env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`).saveRepository(repository);
    return Response.json(repository, { status: 201 });
  }
  if (url.pathname === '/api/missions') {
    const input = missionInput(body);
    if (!await catalog.getRepository(input.repositoryId)) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(principal, 'contribute', 'repository', input.repositoryId);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${input.repositoryId}`);
    const mission = await coordinator.createMission(key, input, { principal, workspaceId: principal.workspaceId, creatorId: principal.userId });
    return Response.json(mission, { status: 201 });
  }
  if (match?.[2] && match[2] !== 'attempts') {
    const { mission, repository } = await findMission(env, match[1], principal.workspaceId);
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const reviewInput = match[2] === 'review' ? reviewMissionInput(body) : undefined;
    const action: Action = reviewInput ? (reviewInput.action === 'comment' ? 'contribute' : 'review') : match[2] === 'start' ? 'execute' : ['approve', 'revoke'].includes(match[2]) ? 'review' : match[2] === 'integrate' ? 'land' : match[2] === 'preview' ? 'read' : 'contribute';
    try { await access.authorize(principal, action, 'repository', repository.id, mission.id); }
    catch (error) {
      if (reviewInput?.action !== 'comment' || publicError(error).code !== 'FORBIDDEN') throw error;
      await access.authorize(principal, 'review', 'repository', repository.id, mission.id);
    }
    if (reviewInput) {
      const reviewed = await coordinator.reviewMission(key, mission.id, reviewInput, principal.userId);
      if (reviewInput.action === 'request_changes' && currentReviewRequests(reviewed).length) await access.clearApprovals(principal, mission.id);
      return Response.json(reviewed);
    }
    if (match[2] === 'cancel') return Response.json(await coordinator.cancelMission(key, mission.id));
    if (match[2] === 'preview') {
      if (!env.PREVIEW_ORIGIN || !env.SANDBOX || !env.ARTIFACTS) throw new ApiError(503, 'PREVIEW_NOT_CONFIGURED', 'Configure the isolated preview service before creating a preview.');
      const previewOrigin = new URL(env.PREVIEW_ORIGIN);
      if (previewOrigin.protocol !== 'https:' || previewOrigin.origin === url.origin) throw new ApiError(503, 'PREVIEW_ORIGIN_INVALID', 'Previews require a separate HTTPS origin.');
      if (!mission.candidateSha || !mission.checks.some((check) => check.candidateSha === mission.candidateSha && check.status === 'passed') || mission.checks.some((check) => check.status !== 'passed')) throw new ApiError(409, 'CHECKS_REQUIRED', 'The current integration candidate must pass verification before preview.');
      const claim = await coordinator.claimPreview(key, mission.id, mission.epoch, mission.candidateSha);
      let sandboxName = claim.sandboxName;
      if (!sandboxName && !claim.claimed) throw new ApiError(409, 'PREVIEW_STARTING', 'This preview is starting. Try again shortly.');
      if (claim.claimed) {
        let finished = false;
        let timer: ReturnType<typeof setTimeout>;
        const renew = async () => {
          try { await coordinator.renewPreview(mission.id, mission.epoch, mission.candidateSha!, claim.claimId); }
          catch {}
          if (!finished) timer = setTimeout(renew, PREVIEW_HEARTBEAT_MS);
        };
        timer = setTimeout(renew, PREVIEW_HEARTBEAT_MS);
        try {
          const prepared = await prepareCandidatePreview(env, { repository, mission, previewAttemptId: claim.claimId, assertAuthority: () => access.check(principal, 'read', 'repository', repository.id, mission.id) });
          sandboxName = prepared.sandboxName;
          await coordinator.previewReady(mission.id, mission.epoch, mission.candidateSha, claim.claimId, sandboxName);
        } catch (error) {
          try { await coordinator.previewFailed(mission.id, claim.claimId); } catch {}
          if (sandboxName) await env.SANDBOX.getByName(sandboxName).destroy().catch(() => {});
          throw error;
        } finally {
          finished = true;
          clearTimeout(timer);
        }
      }
      if (!sandboxName) throw new ApiError(503, 'PREVIEW_UNAVAILABLE', 'The preview could not be started.');
      const current = await coordinator.getMission(mission.id);
      if (!current || current.epoch !== mission.epoch || current.candidateSha !== mission.candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(current.status)) throw new ApiError(409, 'STALE_PREVIEW', 'The candidate changed while the preview was starting.');
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const expiresAt = Date.now() + 900_000;
      await access.check(principal, 'read', 'repository', repository.id, mission.id);
      await env.GITFLARE_COORDINATOR.getByName('catalog:owner').savePreviewCapability(await capabilityHash(token), { workspaceId: principal.workspaceId, principal, repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha: mission.candidateSha, sandboxName, expiresAt });
      return Response.json({ previewUrl: `${previewOrigin.origin}/open/${token}`, candidateSha: mission.candidateSha, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (match[2] === 'start') {
      const readiness = executionReadiness(env);
      if (!readiness.ready || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', `Connect the required services before running agents: ${[...readiness.missing, ...(!env.MISSION_WORKFLOW ? ['Mission Workflow'] : [])].join(', ')}.`);
      const current = await currentRepository(env, repository);
      if (!current.headSha) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before starting a mission.');
      const started = await startWithDurableDispatch(coordinator, key, mission.id, { principal, workspaceId: principal.workspaceId, creatorId: mission.authorization?.creatorId ?? principal.userId });
      return Response.json(started, { status: 202 });
    }
    const candidateSha = requireString(body.candidateSha, 'Candidate commit', 40, 40);
    const baseSha = requireString(body.baseSha, 'Base commit', 40, 40);
    if (!/^[a-f0-9]{40}$/.test(candidateSha) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
    if (match[2] === 'revoke') { const result = await coordinator.revokeApproval(key, mission.id, candidateSha, baseSha); await access.clearApprovals(principal, mission.id); return Response.json(result); }
    const current = await currentRepository(env, repository);
    if (match[2] === 'integrate') {
      if (!env.SANDBOX || !env.ARTIFACTS) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect Artifacts and Sandbox before integrating.');
      await access.assertLand(principal, mission.id, candidateSha, baseSha, mission.epoch, repository.id);
      const claim = await coordinator.beginIntegration(key, mission.id, candidateSha, baseSha);
      if (claim.mission.status === 'integrated') return Response.json(claim.mission);
      if (!claim.claimId) throw new ApiError(500, 'INTEGRATION_CLAIM_MISSING', 'The integration claim could not be established.');
      if (!claim.claimed) {
        if (current.headSha === candidateSha) return Response.json(await coordinator.completeIntegration(mission.id, claim.mission.epoch, candidateSha, claim.claimId));
        throw new ApiError(409, 'INTEGRATION_PENDING', 'An integration is in progress or needs reconciliation. The canonical branch has not confirmed the approved commit.');
      }
      try {
        const result = await integrateCandidate(env, { repository: current, mission: claim.mission, assertAuthority: async () => { await access.check(principal, 'land', 'repository', repository.id, mission.id); await access.assertLand(principal, mission.id, candidateSha, baseSha, mission.epoch, repository.id); } });
        const integrated = await coordinator.completeIntegration(mission.id, claim.mission.epoch, result.sha, claim.claimId);
        await catalog.saveRepository({ ...current, headSha: result.sha, updatedAt: result.integratedAt });
        return Response.json(integrated);
      } catch (error) {
        const actual = await repositoryHead(env.ARTIFACTS, current.name, current.defaultBranch).catch(() => null);
        if (actual === candidateSha) {
          const integrated = await coordinator.completeIntegration(mission.id, claim.mission.epoch, candidateSha, claim.claimId);
          await catalog.saveRepository({ ...current, headSha: candidateSha, updatedAt: new Date().toISOString() });
          return Response.json(integrated);
        }
        const outcome = error instanceof IntegrationFailure ? error.outcome : 'unknown';
        await coordinator.integrationFailed(mission.id, claim.mission.epoch, claim.claimId, outcome);
        if (outcome === 'not_pushed') throw new ApiError(503, 'INTEGRATION_NOT_PUSHED', 'Integration stopped before attempting a canonical push. Retry integration, or revoke approval to rerun the mission.');
        throw new ApiError(503, 'INTEGRATION_UNCONFIRMED', 'The canonical branch could not be confirmed at the approved commit. The repository remains locked for reconciliation.');
      }
    }
    assertReviewClear(mission);
    const approval = await access.recordApproval(principal, mission.id, candidateSha, baseSha, mission.epoch, mission.checks, mission.authorization?.creatorId);
    if (!approval.ready) return Response.json({ ...mission, approval });
    return Response.json(await coordinator.approveMission(key, mission.id, candidateSha, baseSha, principal.userId));
  }
  throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
}

const application = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const publicGit = await publicGitResponse(request, env);
    if (publicGit) return publicGit;
    if (path === '/oauth/authorize') return oauthConsent(request, env, authorize);
    if (path === '/llms.txt') return new Response('# Gitflare\n\n' + listPublicDocs().map(doc => `- [${doc.title}](${new URL(request.url).origin}/api/public/docs/${doc.id}.md): ${doc.description}`).join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!path.startsWith('/api/') && path !== '/mcp') return env.ASSETS.fetch(request);
    let response: Response;
    try {
      if (path === '/mcp') {
        await authorize(request, env, true);
        response = await handleMcp(request, async (internal) => {
          const headers = new Headers(internal.headers);
          headers.set('Authorization', request.headers.get('Authorization') ?? '');
          const workspace = request.headers.get('X-Gitflare-Workspace'); if (workspace) headers.set('X-Gitflare-Workspace', workspace);
          return api(new Request(internal, { headers }), env);
        });
      } else response = await api(request, env);
    } catch (error) {
      const failure = publicError(error);
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
      return await application.fetch(request, env);
    } catch (error) { const failure = publicError(error); return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } }); }
  },
} satisfies ExportedHandler<AppEnv>;
