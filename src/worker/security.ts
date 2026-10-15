import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, requireString } from './domain';
import type { AppEnv } from './env';
import type { CloudflareConnection, CloudflareOAuthState } from './cloudflare';
import { normalizeProjectMapping, type ProjectMapping, type MigrationPlan } from './cloudflare-projects';
import { authenticatorUri, decryptAuth, encryptAuth, mfaSecret, randomCapability, verifyTotp } from './mfa';

export const ROLES = ['Viewer', 'Contributor', 'Reviewer', 'Maintainer', 'Deployer', 'Owner'] as const;
export type Role = typeof ROLES[number];
export type Action = 'read' | 'contribute' | 'execute' | 'review' | 'land' | 'deploy' | 'migrate' | 'manage';
export const ROLE_ACTIONS: Record<Role, Action[]> = {
  Viewer: ['read'], Contributor: ['read', 'contribute', 'execute'], Reviewer: ['read', 'review'],
  Maintainer: ['read', 'contribute', 'execute', 'review', 'land'], Deployer: ['read', 'deploy'], Owner: ['read', 'contribute', 'execute', 'review', 'land', 'deploy', 'migrate', 'manage'],
};
interface User { id: string; name: string; email: string; salt: string; hash: string; machine?: boolean; emailVerified?: boolean }
interface Member { userId: string; workspaceId: string; role: Role; repositoryIds?: string[] }
interface Session { id: string; userId: string; workspaceId: string; hash: string; expiresAt: number; authenticatedAt?: number; revoked?: boolean }
interface WorkspaceRecord { id: string; name: string; bootstrapDisabled?: boolean; agentPending?: boolean }
interface Invitation { id: string; workspaceId: string; email: string; role: Role; hash: string; expiresAt: number; accepted?: boolean }
interface Team { id: string; workspaceId: string; name: string; userIds: string[] }
interface Grant { id: string; workspaceId: string; subjectType: 'user' | 'team'; subjectId: string; resourceType: string; resourceId: string; actions: Action[] }
interface Credential { id: string; workspaceId: string; userId: string; name: string; hash: string; repositoryId: string; missionId?: string; actions: Action[]; expiresAt: number; maxRequests: number; maxExecutions: number; requests: number; executions: number; revoked?: boolean; scope?: 'workspace-read' }
interface Protection { requiredApprovals: number; requiredChecks: string[]; preventSelfApproval: boolean }
export interface ReviewRule { requiredApprovals: number; requiredCheckNames: string[]; preventSelfApproval: boolean; restrictLanders: Role[] }
interface Audit { id: string; workspaceId: string; actorId: string; action: string; timestamp: string; resourceId?: string; sequence?: number }
export interface SecurityOptions { EDITION?: 'hosted' | 'self-hosted'; SETUP_TOKEN?: string; ADMIN_EMAIL?: string; ADMIN_PASSWORD?: string; AUTH_ENCRYPTION_KEY?: string }
interface MfaRecord { id: string; encryptedSecret: string; enabled: boolean; lastStep: number; recoveryHashes: string[] }
interface AuthChallenge { id: string; userId: string; kind: 'setup' | 'enroll' | 'login'; workspaceId?: string; expiresAt: number; used?: boolean }
interface Installation { workspaceName?: string; workspaceId?: string; pendingUser?: User; challengeId?: string }
interface EmailToken { id: string; userId: string; email: string; kind: 'verify' | 'reset'; expiresAt: number }
interface LoginFailures { count: number; lockedUntil: number; updatedAt: number }
interface MachineRegistration { id: string; requestHash: string; response: string; workspaceId: string; userId: string; claimHash: string; expiresAt: number; claimedBy?: string }
export interface MfaChallengeResult { mfaRequired: true; challengeId: string; expiresAt: number; enrollmentRequired: boolean; secret?: string; otpauthUri?: string }
interface State { cloudflareConnections: Record<string, CloudflareConnection>; cloudflareStates: Record<string, CloudflareOAuthState>; cloudflareProjects: Record<string, {mapping: ProjectMapping | null; plans: MigrationPlan[]}>; mfa: MfaRecord[]; challenges: AuthChallenge[]; emailTokens: EmailToken[]; loginFailures: Record<string, LoginFailures>; installations: Record<string, Installation>; machines: MachineRegistration[]; users: User[]; members: Member[]; sessions: Session[]; workspaces: WorkspaceRecord[]; invitations: Invitation[]; teams: Team[]; grants: Grant[]; credentials: Credential[]; audit: Audit[]; protections: Record<string, Protection>; approvals: Record<string, string[]>; limits: Record<string, { count: number; until: number }> }
export interface Principal { userId: string; workspaceId: string; role: Role; sessionId?: string; credentialId?: string; bootstrap?: boolean }
const initial = (): State => ({ cloudflareConnections: {}, cloudflareStates: {}, cloudflareProjects: {}, mfa: [], challenges: [], emailTokens: [], loginFailures: {}, installations: {}, machines: [], users: [], members: [], sessions: [], workspaces: [{ id: 'legacy', name: 'Gitflare workspace' }], invitations: [], teams: [], grants: [], credentials: [], audit: [], protections: {}, approvals: {}, limits: {} });
const encode = new TextEncoder();
export async function hashToken(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', encode.encode(value))); }
function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join(''); }
function token(): string { return hex(crypto.getRandomValues(new Uint8Array(32)).buffer); }
export async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encode.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encode.encode(salt), iterations: 100000 }, key, 256));
}
function role(value: unknown): Role { if (!ROLES.includes(value as Role)) throw new ApiError(400, 'INVALID_ROLE', 'Select a valid workspace role.'); return value as Role; }
function safeUser(user: User) { return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified === true }; }
function fail(code = 'FORBIDDEN', message = 'Your workspace permissions do not allow this action.'): never { throw new ApiError(403, code, message); }
function publicValue<T extends { hash: string }>(value: T): Omit<T, 'hash'> { const { hash: _hash, ...rest } = value; return rest; }
const AUDIT_LIMIT_PER_WORKSPACE = 1000;
const MAX_DERIVED_SESSION_AGE_MS = 86_400_000;
function activeSession(session: Session, now: number): boolean {
  return !session.revoked && session.expiresAt > now && (session.authenticatedAt === undefined || session.authenticatedAt <= now && now - session.authenticatedAt < MAX_DERIVED_SESSION_AGE_MS);
}
function boundedAudit(audit: Audit[]): Audit[] {
  const kept = new Map<string, number>();
  const newestFirst = [...audit].sort((a, b) => a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : (b.sequence ?? 0) - (a.sequence ?? 0) || b.id.localeCompare(a.id));
  return newestFirst.filter(entry => { const count = (kept.get(entry.workspaceId) ?? 0) + 1; kept.set(entry.workspaceId, count); return count <= AUDIT_LIMIT_PER_WORKSPACE; }).reverse();
}
const RETENTION_MS = 7 * 86_400_000;
const LOGIN_FAILURE_LIMIT = 10;
// Account-wide ceiling across all clients, so one client cannot lock everyone else out cheaply
const ACCOUNT_FAILURE_LIMIT = 100;
const LOGIN_LOCK_MS = 900_000;
const LOGIN_FAILURE_WINDOW_MS = 86_400_000;
const VERIFY_TOKEN_MS = 86_400_000;
const RESET_TOKEN_MS = 3_600_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type StoredRecord = { group: string; value: unknown };
function sameHash(left: string, right: string): boolean { const a = encode.encode(left); const b = encode.encode(right); return a.length === b.length && timingSafeEqual(a, b); }
function recordKey(group: string, id: string): string { return `sec:${group}:${encodeURIComponent(id)}`; }
function buildState(records: Iterable<[string, string]>): State {
  const state = initial(); let stored = false;
  for (const [key, serialized] of records) {
    if (!stored) { stored = true; for (const [group, value] of Object.entries(state)) (state as unknown as Record<string, unknown>)[group] = Array.isArray(value) ? [] : {}; }
    const record = JSON.parse(serialized) as StoredRecord; const target = (state as unknown as Record<string, unknown>)[record.group];
    if (Array.isArray(target)) target.push(record.value);
    else if (target) (target as Record<string, unknown>)[decodeURIComponent(key.split(':').slice(2).join(':'))] = record.value;
  }
  state.audit = boundedAudit(state.audit);
  return state;
}
function serializeState(state: State, persisted: Map<string, string>): Map<string, string> {
  const next = new Map<string, string>();
  const add = (group: string, id: string, value: unknown) => { const key = recordKey(group, id); next.set(key, group === 'audit' && persisted.has(key) ? persisted.get(key)! : JSON.stringify({ group, value })); };
  for (const [group, values] of Object.entries(state)) {
    if (Array.isArray(values)) for (const value of values) add(group, 'id' in value ? value.id : `${value.workspaceId}/${value.userId}`, value);
    else for (const [id, value] of Object.entries(values)) add(group, id, value);
  }
  return next;
}
function prune(state: State, now: number): void {
  state.sessions = state.sessions.filter(session => session.expiresAt > now);
  state.challenges = state.challenges.filter(challenge => !challenge.used && challenge.expiresAt > now);
  state.emailTokens = state.emailTokens.filter(item => item.expiresAt > now);
  state.invitations = state.invitations.filter(invitation => invitation.expiresAt + RETENTION_MS > now);
  state.credentials = state.credentials.filter(credential => credential.expiresAt + RETENTION_MS > now);
  state.machines = state.machines.filter(machine => machine.expiresAt + RETENTION_MS > now);
  for (const [id, limit] of Object.entries(state.limits)) if (limit.until <= now) delete state.limits[id];
  for (const [id, value] of Object.entries(state.cloudflareStates)) if (value.expiresAt <= now) delete state.cloudflareStates[id];
  for (const [id, failures] of Object.entries(state.loginFailures)) if (failures.lockedUntil ? failures.lockedUntil <= now : failures.updatedAt + LOGIN_FAILURE_WINDOW_MS <= now) delete state.loginFailures[id];
}
function clearLoginFailures(state: State, userId: string): void {
  for (const key of Object.keys(state.loginFailures)) if (key === userId || key.startsWith(`${userId}|`)) delete state.loginFailures[key];
}
function consumeLimit(state: State, key: string, max: number, windowMs: number): boolean {
  const now = Date.now(); const entry = state.limits[key];
  state.limits[key] = !entry || entry.until <= now ? { count: 1, until: now + windowMs } : { ...entry, count: entry.count + 1 };
  return state.limits[key].count <= max;
}
export class SecurityService {
  private state?: State;
  private persisted = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private storage: Pick<DurableObjectStorage, 'transaction'>, private options: SecurityOptions = {}) {}
  // Operations await crypto between reads and writes of the shared state, so they must never interleave
  private exclusive<T>(task: () => Promise<T>): Promise<T> { const next = this.queue.then(task); this.queue = next.catch(() => {}); return next; }
  private async load(): Promise<State> {
    if (this.state) return this.state;
    const persisted = new Map<string, string>();
    await this.storage.transaction(async txn => {
      const existing = await txn.list<StoredRecord>({ prefix: 'sec:' });
      for (const [key, record] of existing) persisted.set(key, JSON.stringify(record));
      const legacy = await txn.get<State>('security');
      if (legacy === undefined) return;
      if (!existing.size) for (const [key, serialized] of serializeState({ ...initial(), ...legacy }, persisted)) { persisted.set(key, serialized); await txn.put(key, JSON.parse(serialized)); }
      await txn.delete('security');
    });
    this.persisted = persisted;
    return this.state = buildState(persisted);
  }
  private read<T>(operation: (state: State) => T): Promise<T> { return this.exclusive(async () => structuredClone(operation(await this.load()))); }
  private mutate<T>(operation: (state: State) => Promise<T> | T): Promise<T> {
    return this.exclusive(async () => {
      const state = await this.load();
      try {
        prune(state, Date.now());
        const audited = state.audit.length;
        let auditSequence = state.audit.reduce((latest, entry) => Math.max(latest, entry.sequence ?? 0), 0);
        const result = await operation(state);
        if (state.audit.length !== audited) {
          for (const entry of state.audit.slice(audited)) entry.sequence = ++auditSequence;
          state.audit = boundedAudit(state.audit);
        }
        const next = serializeState(state, this.persisted);
        const writes = [...next].filter(([key, serialized]) => this.persisted.get(key) !== serialized);
        const removals = [...this.persisted.keys()].filter(key => !next.has(key));
        if (writes.length || removals.length) await this.storage.transaction(async txn => {
          for (const [key, serialized] of writes) await txn.put(key, JSON.parse(serialized));
          for (const key of removals) await txn.delete(key);
        });
        this.persisted = next;
        return structuredClone(result);
      } catch (error) {
        this.state = buildState(this.persisted);
        throw error;
      }
    });
  }
  async connectionStore(p: Principal | null, operation: 'get' | 'put' | 'delete' | 'state-put' | 'state-consume', body: Record<string, unknown> = {}): Promise<unknown> {
    body = structuredClone(body);
    return this.mutate(state => {
      if (operation === 'state-consume') {
        const value = state.cloudflareStates[String(body.id)];
        if (!value || value.browserHash !== body.browserHash || value.expiresAt <= Date.now()) throw new ApiError(400, 'CLOUDFLARE_STATE_INVALID', 'The connection request has expired. Start again.');
        this.validate(state, value.principal);
        if (value.principal.role !== 'Owner' || !value.principal.sessionId || value.principal.credentialId) fail();
        delete state.cloudflareStates[value.id];
        return value;
      }
      if (!p) fail();
      this.validate(state, p);
      if (p.credentialId) fail();
      if (operation === 'get') {
        const authorization = body.authorization as {action: Action; resourceType: string; resourceId: string} | undefined;
        if (p.role !== 'Owner' && (!authorization || !this.authorityAllows(state, p, authorization.action, authorization.resourceType, authorization.resourceId))) fail();
        const connection = state.cloudflareConnections[p.workspaceId] ?? null;
        if (connection?.issuer) this.validate(state, { ...connection.issuer, sessionId: undefined });
        return connection;
      }
      if (p.role !== 'Owner') fail();
      if (operation === 'state-put') {
        const value = body.value as CloudflareOAuthState;
        if (!p.sessionId || value.principal.userId !== p.userId || value.principal.workspaceId !== p.workspaceId || value.principal.sessionId !== p.sessionId || value.principal.role !== 'Owner' || value.principal.credentialId || value.expiresAt > Date.now() + 600000 || value.expiresAt <= Date.now()) fail();
        state.cloudflareStates[value.id] = value;
        return { ok: true };
      }
      const existing = state.cloudflareConnections[p.workspaceId] ?? null;
      if (operation === 'put') {
        if ((existing?.version ?? null) !== body.expectedVersion) throw new ApiError(409, 'CLOUDFLARE_CONNECTION_CHANGED', 'The Cloudflare connection changed. Refresh and try again.');
        const value = body.value as CloudflareConnection;
        if (value.issuer?.workspaceId !== p.workspaceId || value.issuer.role !== 'Owner' || value.issuer.credentialId) fail();
        this.validate(state, { ...value.issuer, sessionId: undefined });
        state.cloudflareConnections[p.workspaceId] = value;
      } else if (operation === 'delete') {
        delete state.cloudflareConnections[p.workspaceId];
        for (const [id, value] of Object.entries(state.cloudflareStates)) if (value.principal.workspaceId === p.workspaceId) delete state.cloudflareStates[id];
      }
      state.audit.push({ id: crypto.randomUUID(), workspaceId: p.workspaceId, actorId: p.userId, action: `cloudflare:${operation}`, timestamp: new Date().toISOString() });
      return operation === 'delete' ? existing : { ok: true };
    });
  }
  async projectStore(p: Principal, repositoryId: string, operation: 'get' | 'set' | 'plan' | 'consume' | 'finish', body: Record<string, unknown> = {}): Promise<unknown> {
    body = structuredClone(body);
    return this.mutate(state => {
      this.validate(state, p);
      if (p.credentialId || !this.authorityAllows(state, p, 'read', 'repository', repositoryId)) fail();
      const key = `${p.workspaceId}/${repositoryId}`;
      const current = state.cloudflareProjects[key] ?? { mapping: null, plans: [] };
      if (current.mapping) current.mapping = normalizeProjectMapping(current.mapping);
      if (operation === 'get') return current;
      if (operation === 'set') {
        if (p.role !== 'Owner') fail();
        const mapping = body.mapping as ProjectMapping;
        if (mapping.workspaceId !== p.workspaceId || mapping.repositoryId !== repositoryId) fail();
        current.mapping = normalizeProjectMapping(mapping);
        current.plans = current.plans.map(plan => plan.status === 'pending' ? { ...plan, status: 'failed' as const, error: 'Project resources changed. Create a new plan.' } : plan);
      } else {
        const mapping = current.mapping;
        if (!mapping) fail();
        const databases = normalizeProjectMapping(mapping).resources.filter(resource => resource.type === 'd1');
        if (operation === 'plan') {
          const plan = body.plan as MigrationPlan;
          if (plan.workspaceId !== p.workspaceId || plan.repositoryId !== repositoryId || plan.mappingVersion !== mapping.version || plan.accountId !== mapping.accountId || !databases.some(resource => resource.id === plan.databaseId) || plan.status !== 'pending') fail();
          if (!this.authorityAllows(state, p, 'migrate', 'database', plan.databaseId)) fail();
          if (current.plans.some(item => item.id === plan.id || item.checksum === plan.checksum && item.databaseId === plan.databaseId && ['pending','executing','succeeded','unknown'].includes(item.status))) throw new ApiError(409, 'MIGRATION_EXISTS', 'This migration already has a plan or recorded execution.');
          if (current.plans.length >= 500) throw new ApiError(409, 'MIGRATION_HISTORY_LIMIT', 'This project has reached its migration history limit.');
          current.plans.push(plan);
        } else {
          const plan = current.plans.find(item => item.id === body.planId);
          if (!plan) throw new ApiError(404, 'MIGRATION_NOT_FOUND', 'This migration plan could not be found.');
          if (!this.authorityAllows(state, p, 'migrate', 'database', plan.databaseId)) fail();
          if (operation === 'consume') {
            if (plan.status !== 'pending' || plan.checksum !== body.checksum || plan.mappingVersion !== mapping.version || plan.accountId !== mapping.accountId || !databases.some(resource => resource.id === plan.databaseId)) throw new ApiError(409, 'MIGRATION_STALE', 'This migration has changed or already started. Create a new plan.');
            plan.status = 'executing';
          } else {
            if (plan.status !== 'executing' || !['succeeded','failed','unknown'].includes(String(body.status))) throw new ApiError(409, 'MIGRATION_STATE_INVALID', 'This migration cannot change state.');
            plan.status = body.status as MigrationPlan['status'];
            if (typeof body.error === 'string') plan.error = body.error.slice(0, 500);
          }
        }
      }
      state.cloudflareProjects[key] = current;
      state.audit.push({ id: crypto.randomUUID(), workspaceId: p.workspaceId, actorId: p.userId, action: `cloudflare:project:${operation}`, resourceId: repositoryId, timestamp: new Date().toISOString() });
      if (operation === 'consume') return current.plans.find(item => item.id === body.planId);
      return current;
    });
  }
  async rateLimit(key: string, max = 15, windowMs = 900000): Promise<void> {
    const accepted = await this.mutate(state => consumeLimit(state, key, max, windowMs));
    if (!accepted) throw new ApiError(429, 'RATE_LIMITED', 'Too many authentication attempts. Try again in 15 minutes.');
  }
  async signup(body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async login(body: Record<string, unknown>, client = 'unknown') {
    const email = requireString(body.email, 'Email', 254).toLowerCase(); const password = requireString(body.password, 'Password', 256);
    const found = await this.read(state => state.users.find(item => item.email === email));
    const hash = await passwordHash(password, found?.salt ?? 'invalid-account-salt');
    // A locked account must be indistinguishable from a wrong password
    const user = await this.mutate(state => {
      const current = found && state.users.find(item => item.id === found.id && item.email === email && item.salt === found.salt);
      if (!current || current.machine) return null;
      const clientKey = `${current.id}|${client.slice(0, 64)}`; const now = Date.now();
      if ([clientKey, current.id].some(key => (state.loginFailures[key]?.lockedUntil ?? 0) > now)) return null;
      if (sameHash(current.hash, hash)) { clearLoginFailures(state, current.id); return current; }
      for (const [key, limit] of [[clientKey, LOGIN_FAILURE_LIMIT], [current.id, ACCOUNT_FAILURE_LIMIT]] as const) {
        const count = (state.loginFailures[key]?.count ?? 0) + 1;
        state.loginFailures[key] = { count, lockedUntil: count >= limit ? now + LOGIN_LOCK_MS : 0, updatedAt: now };
        if (count === limit) this.auditAccount(state, current.id, 'account:login-locked');
      }
      return null;
    });
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'The email or password was not accepted.');
    const enrolled = await this.read(state => state.mfa.find(m => m.id === user.id)?.enabled);
    if (enrolled || this.options.EDITION === 'self-hosted') return this.beginMfa(user.id, undefined, { user });
    const value = token(); const sessionHash = await hashToken(value);
    return this.mutate(state => {
      const current = this.passwordUser(state, user);
      const membership = state.members.find(member => member.userId === current.id); if (!membership) fail();
      if (state.mfa.some(record => record.id === current.id && record.enabled)) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in again with your authenticator.');
      return this.session(state, current, membership.workspaceId, value, sessionHash);
    });
  }
  async legacySession() { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); const value = token(); const hash = await hashToken(value); return this.mutate(state => { if (state.workspaces.find(w => w.id === 'legacy')?.bootstrapDisabled) fail(); state.sessions.push({ id: crypto.randomUUID(), userId: 'bootstrap-owner', workspaceId: 'legacy', hash, expiresAt: Date.now() + 28800000, authenticatedAt: Date.now() }); return value; }); }
  async bootstrap(): Promise<Principal> { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); return this.read(state => { if (state.workspaces.find(workspace => workspace.id === 'legacy')?.bootstrapDisabled) fail('BOOTSTRAP_DISABLED', 'The legacy owner key was retired by ownership transfer.'); return { userId: 'bootstrap-owner', workspaceId: 'legacy', role: 'Owner', bootstrap: true }; }); }
  async authenticate(value: string, workspaceId?: string): Promise<Principal> {
    const hash = await hashToken(value);
    return this.read(state => {
      const session = state.sessions.find(item => item.hash === hash && activeSession(item, Date.now()));
      if (session?.userId === 'bootstrap-owner') { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); if (workspaceId && workspaceId !== 'legacy' || state.workspaces.find(w => w.id === 'legacy')?.bootstrapDisabled) fail(); return { userId: 'bootstrap-owner', workspaceId: 'legacy', role: 'Owner', bootstrap: true, sessionId: session.id }; }
      if (session && this.options.EDITION === 'self-hosted' && (!state.installations.self?.workspaceId || !state.mfa.some(m => m.id === session.userId && m.enabled))) fail('MFA_REQUIRED');
      if (session) { const member = state.members.find(item => item.userId === session.userId && item.workspaceId === (workspaceId ?? session.workspaceId)); if (!member) fail(); return { userId: member.userId, workspaceId: member.workspaceId, role: member.role, sessionId: session.id }; }
      const credential = state.credentials.find(item => item.hash === hash && !item.revoked && item.expiresAt > Date.now());
      if (credential && this.options.EDITION === 'self-hosted' && (credential.workspaceId !== state.installations.self?.workspaceId || !state.mfa.some(m => m.id === credential.userId && m.enabled))) fail('MFA_REQUIRED');
      if (credential && (!workspaceId || workspaceId === credential.workspaceId)) { const member = state.members.find(item => item.userId === credential.userId && item.workspaceId === credential.workspaceId); if (!member) fail(); return { userId: member.userId, workspaceId: member.workspaceId, role: member.role, credentialId: credential.id }; }
      throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Gitflare.');
    });
  }
  async authorize(principal: Principal, action: Action, resourceType = 'workspace', resourceId = principal.workspaceId, missionId?: string): Promise<void> {
    await this.mutate(state => {
      this.validate(state, principal);
      if (principal.credentialId) { const credential = state.credentials.find(item => item.id === principal.credentialId)!; if (!this.authorityAllows(state, principal, action, resourceType, resourceId, missionId) || !credential.actions.includes(action) || resourceType !== 'repository' || credential.scope !== 'workspace-read' && credential.repositoryId !== resourceId || (credential.missionId && (missionId ? credential.missionId !== missionId : action !== 'read'))) fail(); if (credential.requests >= credential.maxRequests || (action === 'execute' && credential.executions >= credential.maxExecutions)) fail('BUDGET_EXHAUSTED', 'This task credential has exhausted its execution budget.'); credential.requests++; if (action === 'execute') credential.executions++; }
      else if (!this.roleAllows(state, principal, action, resourceType, resourceId) && !state.grants.some(grant => grant.workspaceId === principal.workspaceId && (grant.resourceType === resourceType && grant.resourceId === resourceId || grant.resourceType === 'stream' && grant.resourceId === missionId) && grant.actions.includes(action) && (grant.subjectType === 'user' ? grant.subjectId === principal.userId : state.teams.some(team => team.id === grant.subjectId && team.workspaceId === principal.workspaceId && team.userIds.includes(principal.userId))))) fail();
      state.audit.push({ id: crypto.randomUUID(), workspaceId: principal.workspaceId, actorId: principal.userId, action, resourceId, timestamp: new Date().toISOString() });
    });
  }
  async authorizeMetadata(p: Principal): Promise<void> {
    await this.mutate(state => {
      this.validate(state, p);
      if (!p.credentialId) return;
      const credential = state.credentials.find(c => c.id === p.credentialId)!;
      if (!credential.actions.includes('read') || !this.authorityAllows(state, p, 'read', credential.scope === 'workspace-read' ? 'workspace' : 'repository', credential.scope === 'workspace-read' ? p.workspaceId : credential.repositoryId, credential.missionId)) fail();
      if (credential.requests >= credential.maxRequests) fail('BUDGET_EXHAUSTED', 'This task credential has exhausted its request budget.');
      credential.requests++;
    });
  }
  private roleAllows(state: State, p: Principal, action: Action, type: string, resourceId: string) { const member = state.members.find(m => m.userId === p.userId && m.workspaceId === p.workspaceId); const scoped = !member?.repositoryIds || type === 'repository' && member.repositoryIds.includes(resourceId) || !['repository','stream'].includes(type); return !(action === 'execute' && state.workspaces.find(w => w.id === p.workspaceId)?.agentPending) && scoped && ROLE_ACTIONS[p.role].includes(action) && (['workspace', 'repository', 'stream'].includes(type) || p.role === 'Owner' || p.role === 'Deployer' && type === 'environment' && action === 'deploy'); }
  private authorityAllows(state: State, p: Principal, action: Action, resourceType: string, resourceId: string, missionId?: string) {
    return this.roleAllows(state, p, action, resourceType, resourceId) || state.grants.some(grant => grant.workspaceId === p.workspaceId && (grant.resourceType === resourceType && grant.resourceId === resourceId || grant.resourceType === 'stream' && grant.resourceId === missionId) && grant.actions.includes(action) && (grant.subjectType === 'user' ? grant.subjectId === p.userId : state.teams.some(team => team.id === grant.subjectId && team.workspaceId === p.workspaceId && team.userIds.includes(p.userId))));
  }
  private validate(state: State, p: Principal) {
    if (p.bootstrap) { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); if (p.sessionId && !state.sessions.some(s => s.id === p.sessionId && s.userId === p.userId && activeSession(s, Date.now()))) fail(); if (p.workspaceId !== 'legacy' || state.workspaces.find(w => w.id === 'legacy')?.bootstrapDisabled) fail(); return; }
    if (this.options.EDITION === 'self-hosted' && (state.installations.self?.workspaceId !== p.workspaceId || !state.mfa.some(m => m.id === p.userId && m.enabled))) fail('MFA_REQUIRED');
    const member = state.members.find(m => m.workspaceId === p.workspaceId && m.userId === p.userId); if (!member || member.role !== p.role) fail();
    if (p.sessionId && !state.sessions.some(s => s.id === p.sessionId && s.userId === p.userId && activeSession(s, Date.now()))) fail();
    if (p.credentialId && !state.credentials.some(c => c.id === p.credentialId && c.userId === p.userId && c.workspaceId === p.workspaceId && !c.revoked && c.expiresAt > Date.now())) fail();
  }
  private checkAllows(state: State, p: Principal, action: Action, resourceType: string, resourceId: string, missionId?: string): boolean {
    if (p.credentialId) { const c = state.credentials.find(c => c.id === p.credentialId)!; return !(!this.authorityAllows(state, p, action, resourceType, resourceId, missionId) || !c.actions.includes(action) || resourceType !== 'repository' || c.scope !== 'workspace-read' && c.repositoryId !== resourceId || c.missionId && (missionId ? c.missionId !== missionId : action !== 'read')); }
    return this.roleAllows(state, p, action, resourceType, resourceId) || state.grants.some(g => g.workspaceId === p.workspaceId && (g.resourceType === resourceType && g.resourceId === resourceId || g.resourceType === 'stream' && g.resourceId === missionId) && g.actions.includes(action) && (g.subjectType === 'user' ? g.subjectId === p.userId : state.teams.some(t => t.id === g.subjectId && t.workspaceId === p.workspaceId && t.userIds.includes(p.userId))));
  }
  async check(p: Principal, action: Action, resourceType = 'workspace', resourceId = p.workspaceId, missionId?: string): Promise<void> {
    await this.read(state => { this.validate(state, p); if (!this.checkAllows(state, p, action, resourceType, resourceId, missionId)) fail(); });
  }
  async checkMany(p: Principal, action: Action, resources: { resourceType: string; resourceId: string; missionId?: string }[]): Promise<boolean[]> {
    return this.read(state => { this.validate(state, p); return resources.map(r => this.checkAllows(state, p, action, r.resourceType, r.resourceId, r.missionId)); });
  }
  async workspace(p: Principal) { return this.read(state => { this.validate(state,p); const workspace = state.workspaces.find(w => w.id === p.workspaceId); if (!workspace) fail(); return { id: workspace.id, name: workspace.name }; }); }
  async snapshot(p: Principal) { return this.read(state => { this.validate(state, p); if (p.credentialId) fail(); const owner = p.role === 'Owner'; return { user: state.users.find(u => u.id === p.userId) ? safeUser(state.users.find(u => u.id === p.userId)!) : { id: p.userId, name: 'Legacy owner', emailVerified: false }, workspace: state.workspaces.find(w => w.id === p.workspaceId), role: p.role, permissions: ROLE_ACTIONS[p.role], members: state.members.filter(m => m.workspaceId === p.workspaceId).map(m => ({ ...m, user: state.users.find(u => u.id === m.userId) ? safeUser(state.users.find(u => u.id === m.userId)!) : null })), teams: state.teams.filter(t => t.workspaceId === p.workspaceId), invitations: owner ? state.invitations.filter(i => i.workspaceId === p.workspaceId).map(publicValue) : [], grants: owner ? state.grants.filter(g => g.workspaceId === p.workspaceId) : [], credentials: state.credentials.filter(c => c.workspaceId === p.workspaceId && (owner || c.userId === p.userId)).map(publicValue), sessions: state.sessions.filter(s => s.userId === p.userId && s.expiresAt > Date.now()).map(publicValue), protection: state.protections[p.workspaceId] ?? { requiredApprovals: 1, requiredChecks: [], preventSelfApproval: false }, audit: owner ? state.audit.filter(a => a.workspaceId === p.workspaceId).slice(-100).reverse() : [], workspaces: state.workspaces.filter(w => state.members.some(m => m.workspaceId === w.id && m.userId === p.userId) || p.bootstrap && w.id === 'legacy') }; }); }
  async action(p: Principal, action: string, body: Record<string, unknown>) {
    if (action === 'user-create') return this.createInstallationUser(p, body);
    if (action === 'agent-claim') return this.claimMachine(p, body);
    if (action === 'mfa-enroll') return this.enrollMfa(p);
    const raw = token(); const hash = await hashToken(raw);
    return this.mutate(state => {
      this.validate(state, p); if (p.credentialId) fail(); const workspaceId = p.workspaceId; state.audit.push({ id: crypto.randomUUID(), workspaceId, actorId: p.userId, action: `access:${action}`, timestamp: new Date().toISOString() });
      if (action === 'session-create') {
        if (p.bootstrap) fail('ACCOUNT_REQUIRED');
        const authenticatedAt = state.sessions.find(s => s.id === p.sessionId)?.authenticatedAt;
        const now = Date.now();
        if (authenticatedAt === undefined || authenticatedAt > now || now - authenticatedAt >= MAX_DERIVED_SESSION_AGE_MS) fail('RECENT_AUTH_REQUIRED', 'Sign in again before creating another session.');
        const session = { id: crypto.randomUUID(), userId: p.userId, workspaceId, hash, expiresAt: Math.min(now + 28800000, authenticatedAt + MAX_DERIVED_SESSION_AGE_MS), authenticatedAt };
        state.sessions.push(session); return { token: raw, session: publicValue(session) };
      }
      if (action === 'session-revoke') { const session = state.sessions.find(s => s.id === body.id && s.userId === p.userId); if (!session) fail(); session.revoked = true; return { ok: true }; }
      if (p.role !== 'Owner') fail();
      const member = (userId: unknown) => { const found = state.members.find(m => m.workspaceId === workspaceId && m.userId === userId); if (!found) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Select an existing workspace member.'); return found; };
      if (action === 'invite-revoke') { const invitation = state.invitations.find(i => i.id === body.id && i.workspaceId === workspaceId); if (!invitation) fail(); invitation.accepted = true; return { ok: true }; }
      if (action === 'invite') { const invitation: Invitation = { id: crypto.randomUUID(), workspaceId, email: requireString(body.email, 'Email', 254).toLowerCase(), role: role(body.role), hash, expiresAt: Date.now() + 86400000 }; if (invitation.role === 'Owner') fail('TRANSFER_REQUIRED', 'Use ownership transfer to assign the Owner role.'); state.invitations.push(invitation); return { token: raw, invitation: publicValue(invitation) }; }
      if (action === 'membership') { const target = member(body.userId); if (target.role === 'Owner' || body.role === 'Owner') fail('TRANSFER_REQUIRED'); if (body.role === null) { const email = state.users.find(user => user.id === target.userId)?.email; for (const invitation of state.invitations) if (invitation.workspaceId === workspaceId && invitation.email === email) invitation.accepted = true; state.members = state.members.filter(m => m !== target); for (const c of state.credentials) if (c.workspaceId === workspaceId && c.userId === target.userId) c.revoked = true; for (const session of state.sessions) if (session.userId === target.userId) session.revoked = true; state.grants = state.grants.filter(g => !(g.workspaceId === workspaceId && g.subjectType === 'user' && g.subjectId === target.userId)); for (const team of state.teams) if (team.workspaceId === workspaceId) team.userIds = team.userIds.filter(id => id !== target.userId); } else { if (body.role !== undefined) target.role = role(body.role); if (body.repositoryIds === null) delete target.repositoryIds; else if (body.repositoryIds !== undefined) { if (!Array.isArray(body.repositoryIds) || body.repositoryIds.length > 100 || body.repositoryIds.some(id => typeof id !== 'string' || id.length > 200)) throw new ApiError(400, 'INVALID_SCOPE', 'Provide a bounded list of repository IDs.'); target.repositoryIds = [...new Set(body.repositoryIds)] as string[]; } } return { ok: true }; }
      if (action === 'transfer') { const authenticatedAt = state.sessions.find(s => s.id === p.sessionId)?.authenticatedAt; if ((!p.bootstrap || p.sessionId) && (authenticatedAt === undefined || Date.now() - authenticatedAt > 300000 || authenticatedAt > Date.now())) fail('RECENT_AUTH_REQUIRED', 'Sign in again before transferring workspace ownership.'); const target = member(body.userId); if (target.userId === p.userId) fail(); const previous = state.members.find(m => m.workspaceId === workspaceId && m.userId === p.userId); if (previous) previous.role = 'Maintainer'; target.role = 'Owner'; delete target.repositoryIds; state.workspaces.find(w => w.id === workspaceId)!.bootstrapDisabled = true; return { ok: true }; }
      if (action === 'team-create') { const team = { id: crypto.randomUUID(), workspaceId, name: requireString(body.name, 'Team name', 100), userIds: [] }; state.teams.push(team); return team; }
      if (action === 'team-member') { const team = state.teams.find(t => t.id === body.teamId && t.workspaceId === workspaceId); if (!team) fail(); const target = member(body.userId); team.userIds = body.remove ? team.userIds.filter(id => id !== target.userId) : [...new Set([...team.userIds, target.userId])]; return team; }
      if (action === 'grant-revoke' || action === 'credential-revoke') { const values = action === 'grant-revoke' ? state.grants : state.credentials; const value = values.find(v => v.id === body.id && v.workspaceId === workspaceId); if (!value) fail(); if ('revoked' in value || action === 'credential-revoke') (value as Credential).revoked = true; else state.grants = state.grants.filter(g => g !== value); return { ok: true }; }
      if (action === 'grant') { if (!['repository', 'stream', 'environment', 'secret', 'database'].includes(String(body.resourceType))) fail(); if (body.subjectType === 'user') member(body.subjectId); else if (body.subjectType !== 'team' || !state.teams.some(t => t.id === body.subjectId && t.workspaceId === workspaceId)) fail(); const actions = this.actions(body.actions); if (actions.includes('manage')) fail(); const grant: Grant = { id: crypto.randomUUID(), workspaceId, subjectType: body.subjectType as Grant['subjectType'], subjectId: String(body.subjectId), resourceType: String(body.resourceType), resourceId: requireString(body.resourceId, 'Resource', 200), actions }; state.grants.push(grant); return grant; }
      if (action === 'credential-create') { const actions = this.actions(body.actions); if (actions.some(a => !['read', 'contribute', 'execute'].includes(a))) fail(); const number = (key: string, max: number) => { const value = Number(body[key]); if (!Number.isInteger(value) || value < 1 || value > max) throw new ApiError(400, 'INVALID_BUDGET', 'Credential expiry and budgets must be positive bounded integers.'); return value; }; const credential: Credential = { id: crypto.randomUUID(), workspaceId, userId: p.userId, name: requireString(body.name, 'Credential name', 100), hash, repositoryId: requireString(body.repositoryId, 'Repository', 200), missionId: body.missionId === undefined ? undefined : requireString(body.missionId, 'Stream', 200), actions, expiresAt: Date.now() + number('expiresInSeconds', 86400) * 1000, maxRequests: number('maxRequests', 1000), maxExecutions: number('maxExecutions', 10), requests: 0, executions: 0 }; if (p.bootstrap) fail('ACCOUNT_REQUIRED', 'Create an account and join the legacy workspace before issuing task credentials.'); state.credentials.push(credential); return { token: raw, credential: publicValue(credential) }; }
      if (action === 'protection') { for (const key of Object.keys(state.approvals)) if (key.startsWith(`${workspaceId}:`)) delete state.approvals[key]; const count = Number(body.requiredApprovals); if (!Number.isInteger(count) || count < 1 || count > 10 || !Array.isArray(body.requiredChecks) || body.requiredChecks.length > 20 || typeof body.preventSelfApproval !== 'boolean') throw new ApiError(400, 'INVALID_PROTECTION', 'Provide valid protection requirements.'); const protection = { requiredApprovals: count, requiredChecks: body.requiredChecks.map(c => requireString(c, 'Check name', 100)), preventSelfApproval: body.preventSelfApproval }; state.protections[workspaceId] = protection; return protection; }
      throw new ApiError(404, 'NOT_FOUND', 'This access operation is unavailable.');
    });
  }
  async authConfig() {
    return this.read(state => ({ edition: this.options.EDITION ?? 'hosted', setupRequired: this.options.EDITION === 'self-hosted' && !state.installations.self?.workspaceId, publicSignup: this.options.EDITION !== 'self-hosted', mfaRequired: this.options.EDITION === 'self-hosted', ...(this.options.EDITION === 'self-hosted' ? { setupMode: this.setupMode() } : {}) }));
  }
  private setupMode(): 'admin-credentials' | 'setup-token' | 'unconfigured' {
    if (this.options.ADMIN_EMAIL !== undefined || this.options.ADMIN_PASSWORD !== undefined) {
      const email = this.options.ADMIN_EMAIL?.trim(); const password = this.options.ADMIN_PASSWORD?.trim();
      return email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && password && password.length >= 12 && password.length <= 256 ? 'admin-credentials' : 'unconfigured';
    }
    return this.options.SETUP_TOKEN && this.options.SETUP_TOKEN.length >= 32 ? 'setup-token' : 'unconfigured';
  }
  private async setupCredentialsMatch(email: string, password: string): Promise<boolean> {
    const [actualEmail, expectedEmail, actualPassword, expectedPassword] = await Promise.all([
      hashToken(email), hashToken(this.options.ADMIN_EMAIL!.trim().toLowerCase()), hashToken(password), hashToken(this.options.ADMIN_PASSWORD!.trim()),
    ]);
    const emailMatches = timingSafeEqual(encode.encode(actualEmail), encode.encode(expectedEmail));
    const passwordMatches = timingSafeEqual(encode.encode(actualPassword), encode.encode(expectedPassword));
    return emailMatches && passwordMatches;
  }
  private accountInput(body: Record<string, unknown>) {
    const name = requireString(body.name, 'Name', 100); const email = requireString(body.email, 'Email', 254).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    return { name, email, password: requireString(body.password, 'Password', 256, 12) };
  }
  private session(state: State, user: User, workspaceId: string, raw: string, hash: string) {
    state.sessions.push({ id: crypto.randomUUID(), userId: user.id, workspaceId, hash, expiresAt: Date.now() + 28800000, authenticatedAt: Date.now() });
    return { token: raw, user: safeUser(user), workspaceId };
  }
  async startSetup(body: Record<string, unknown>): Promise<MfaChallengeResult> {
    if (this.options.EDITION !== 'self-hosted') fail('SETUP_DISABLED');
    const mode = this.setupMode();
    if (mode === 'unconfigured') throw new ApiError(503, 'SETUP_NOT_CONFIGURED', 'Configure the administrator email and a password of at least 12 characters in the deployment settings.');
    if (mode === 'setup-token') {
      const supplied = requireString(body.setupToken, 'Setup token', 1024, 32);
      const [actual, expected] = await Promise.all([hashToken(supplied), hashToken(this.options.SETUP_TOKEN!)]);
      if (!timingSafeEqual(encode.encode(actual), encode.encode(expected))) fail('INVALID_SETUP_TOKEN', 'The installation setup token was not accepted.');
    }
    const input = this.accountInput(body); const workspaceName = requireString(body.workspaceName, 'Workspace name', 100);
    if (mode === 'admin-credentials' && !await this.setupCredentialsMatch(input.email, input.password)) fail('SETUP_CREDENTIALS_REJECTED', 'Use the administrator email and password supplied during deployment.');
    const userId = crypto.randomUUID(); const salt = token(); const hash = await passwordHash(input.password, salt);
    const secret = mfaSecret(); const encryptedSecret = await encryptAuth(secret, this.options.AUTH_ENCRYPTION_KEY, `mfa:${userId}`);
    const challengeId = token(); const challengeHash = await hashToken(challengeId); const expiresAt = Date.now() + 300000;
    await this.mutate(state => {
      if (state.installations.self?.workspaceId) throw new ApiError(409, 'SETUP_COMPLETE', 'This installation already has an administrator.');
      const pending = state.challenges.find(c => c.id === state.installations.self?.challengeId && !c.used && c.expiresAt > Date.now());
      if (pending) throw new ApiError(409, 'SETUP_IN_PROGRESS', 'An administrator enrollment is already in progress.');
      if (state.members.length || state.users.length) throw new ApiError(409, 'EXISTING_INSTALLATION', 'Use the existing installation administrator.');
      state.mfa = []; state.challenges = [];
      state.installations.self = { pendingUser: { id: userId, name: input.name, email: input.email, salt, hash }, challengeId: challengeHash, workspaceName } as Installation;
      state.mfa.push({ id: userId, encryptedSecret, enabled: false, lastStep: -1, recoveryHashes: [] });
      state.challenges.push({ id: challengeHash, userId, kind: 'setup', expiresAt });
    });
    return { mfaRequired: true, enrollmentRequired: true, challengeId, secret, otpauthUri: authenticatorUri(secret, input.email), expiresAt };
  }
  private passwordUser(state: State, authenticated: User): User {
    const current = state.users.find(user => user.id === authenticated.id && user.email === authenticated.email && user.salt === authenticated.salt && user.hash === authenticated.hash && !user.machine);
    if (!current) throw new ApiError(401, 'AUTH_REQUIRED', 'The email or password was not accepted.');
    return current;
  }
  private async beginMfa(userId: string, workspaceId?: string, authentication?: { user?: User; principal?: Principal }): Promise<MfaChallengeResult> {
    const challengeId = token(); const challengeHash = await hashToken(challengeId); const expiresAt = Date.now() + 300000;
    const secret = mfaSecret(); const encryptedSecret = await encryptAuth(secret, this.options.AUTH_ENCRYPTION_KEY, `mfa:${userId}`);
    const result = await this.mutate(state => {
      if (authentication?.user) this.passwordUser(state, authentication.user);
      if (authentication?.principal) this.validate(state, authentication.principal);
      if (this.options.EDITION === 'self-hosted' && !state.installations.self?.workspaceId) fail('SETUP_REQUIRED', 'Complete protected administrator setup first.');
      const user = state.users.find(u => u.id === userId); const member = state.members.find(m => m.userId === userId && (!workspaceId || m.workspaceId === workspaceId));
      if (!user || user.machine || !member) fail();
      let mfa = state.mfa.find(m => m.id === userId);
      if (!mfa?.enabled) { mfa = { id: userId, encryptedSecret, enabled: false, lastStep: -1, recoveryHashes: [] }; state.mfa = [...state.mfa.filter(m => m.id !== userId), mfa]; }
      state.challenges = state.challenges.filter(c => c.userId !== userId || c.used);
      state.challenges.push({ id: challengeHash, userId, kind: mfa.enabled ? 'login' : 'enroll', expiresAt, workspaceId: member.workspaceId } as AuthChallenge);
      return { email: user.email, enrollmentRequired: !mfa.enabled };
    });
    return { mfaRequired: true, enrollmentRequired: result.enrollmentRequired, challengeId, expiresAt, ...(result.enrollmentRequired ? { secret, otpauthUri: authenticatorUri(secret, result.email) } : {}) };
  }
  async enrollMfa(p: Principal): Promise<MfaChallengeResult> {
    await this.read(state => {
      this.validate(state, p); if (p.bootstrap || p.credentialId) fail();
      const session = state.sessions.find(s => s.id === p.sessionId);
      if (!session?.authenticatedAt || Date.now() - session.authenticatedAt > 300000) fail('RECENT_AUTH_REQUIRED', 'Sign in again before setting up an authenticator.');
      if (state.mfa.some(m => m.id === p.userId && m.enabled)) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'This account already has an authenticator.');
    });
    return this.beginMfa(p.userId, p.workspaceId, { principal: p });
  }
  async verifyMfa(body: Record<string, unknown>, setupOnly = false) {
    const challengeId = requireString(body.challengeId, 'Authentication challenge', 128); const id = await hashToken(challengeId);
    await this.rateLimit(`mfa:${id}`, 5, 300000);
    const userId = await this.read(state => state.challenges.find(c => c.id === id && !c.used && c.expiresAt > Date.now())?.userId);
    if (userId) await this.rateLimit(`mfa-user:${userId}`, 10, 300000);
    const code = body.code === undefined ? undefined : requireString(body.code, 'Authenticator code', 6, 6);
    const recoveryHash = body.recoveryCode === undefined ? undefined : await hashToken(requireString(body.recoveryCode, 'Recovery code', 64));
    const raw = token(); const sessionHash = await hashToken(raw); const recoveryCodes = Array.from({ length: 10 }, () => randomCapability(8)); const recoveryHashes = await Promise.all(recoveryCodes.map(hashToken));
    return this.mutate(async state => {
      const challenge = state.challenges.find(c => c.id === id && !c.used && c.expiresAt > Date.now());
      if (!challenge || setupOnly && challenge.kind !== 'setup') throw new ApiError(410, 'CHALLENGE_EXPIRED', 'This sign-in challenge is expired or already used.');
      const mfa = state.mfa.find(m => m.id === challenge.userId); if (!mfa) fail();
      if (recoveryHash && challenge.kind === 'login' && mfa.enabled && mfa.recoveryHashes.includes(recoveryHash)) mfa.recoveryHashes = mfa.recoveryHashes.filter(hash => hash !== recoveryHash);
      else {
        const secret = await decryptAuth(mfa.encryptedSecret, this.options.AUTH_ENCRYPTION_KEY, `mfa:${mfa.id}`);
        const step = code ? await verifyTotp(secret, code, Date.now(), mfa.lastStep) : undefined;
        if (step === undefined) throw new ApiError(401, 'INVALID_MFA_CODE', 'The authenticator or recovery code was not accepted.');
        mfa.lastStep = step;
      }
      challenge.used = true;
      const enrolling = !mfa.enabled; mfa.enabled = true; if (enrolling) mfa.recoveryHashes = recoveryHashes;
      let user = state.users.find(u => u.id === challenge.userId); let workspaceId: string | undefined;
      if (challenge.kind === 'setup') {
        const installation = state.installations.self;
        if (this.options.EDITION !== 'self-hosted' || installation?.workspaceId || installation?.challengeId !== id || !installation.pendingUser) fail();
        user = installation.pendingUser; workspaceId = crypto.randomUUID();
        state.users.push(user); state.members.push({ userId: user.id, workspaceId, role: 'Owner' });
        state.workspaces = [{ id: workspaceId, name: installation.workspaceName ?? 'Gitflare workspace', bootstrapDisabled: true }];
        state.installations.self = { workspaceId };
      } else workspaceId = challenge.workspaceId ?? state.members.find(m => m.userId === challenge.userId)?.workspaceId;
      if (!user || !workspaceId || !state.members.some(m => m.userId === user!.id && m.workspaceId === workspaceId)) fail();
      if (enrolling) for (const session of state.sessions) if (session.userId === user.id) session.revoked = true;
      return { ...this.session(state, user, workspaceId, raw, sessionHash), ...(enrolling ? { recoveryCodes } : {}) };
    });
  }
  async createInstallationUser(p: Principal, body: Record<string, unknown>) {
    if (this.options.EDITION !== 'self-hosted') fail('SELF_HOSTED_ONLY');
    const input = this.accountInput(body); const assignedRole = role(body.role); if (assignedRole === 'Owner') fail('TRANSFER_REQUIRED');
    const salt = token(); const hash = await passwordHash(input.password, salt);
    return this.mutate(state => {
      this.validate(state, p); if (p.credentialId || p.role !== 'Owner' || state.installations.self?.workspaceId !== p.workspaceId) fail();
      if (state.users.some(u => u.email === input.email)) throw new ApiError(409, 'ACCOUNT_EXISTS', 'This email is already registered.');
      const user: User = { id: crypto.randomUUID(), name: input.name, email: input.email, salt, hash };
      state.users.push(user); state.members.push({ userId: user.id, workspaceId: p.workspaceId, role: assignedRole });
      state.audit.push({ id: crypto.randomUUID(), workspaceId: p.workspaceId, actorId: p.userId, action: 'access:user-create', resourceId: user.id, timestamp: new Date().toISOString() });
      return { user: safeUser(user), workspaceId: p.workspaceId, role: assignedRole, enrollmentRequired: true };
    });
  }
  async registerInvitedUser(body: Record<string, unknown>) {
    const input = this.accountInput(body); const invitationHash = await hashToken(requireString(body.token, 'Invitation token', 128));
    const userId = crypto.randomUUID(); const salt = token(); const hash = await passwordHash(input.password, salt);
    const raw = token(); const sessionHash = await hashToken(raw); const verificationToken = token(); const verificationHash = await hashToken(verificationToken);
    const registered = await this.mutate(state => {
      const invite = state.invitations.find(i => i.hash === invitationHash && !i.accepted && i.expiresAt > Date.now());
      if (!invite || this.options.EDITION === 'self-hosted' && invite.workspaceId !== state.installations.self?.workspaceId) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.');
      if (invite.email !== input.email) fail('INVITATION_IDENTITY');
      if (state.users.some(u => u.email === input.email)) throw new ApiError(409, 'ACCOUNT_EXISTS', 'This email is already registered. Sign in instead.');
      const user = { id: userId, name: input.name, email: input.email, salt, hash };
      state.users.push(user); state.members.push({ userId, workspaceId: invite.workspaceId, role: invite.role }); invite.accepted = true;
      if (this.options.EDITION === 'self-hosted') return { workspaceId: invite.workspaceId };
      state.emailTokens.push({ id: verificationHash, userId, email: input.email, kind: 'verify', expiresAt: Date.now() + VERIFY_TOKEN_MS });
      return { ...this.session(state, user, invite.workspaceId, raw, sessionHash), verificationToken };
    });
    if ('token' in registered) return registered;
    return this.beginMfa(userId);
  }
  private auditAccount(state: State, userId: string, action: string) {
    for (const member of state.members) if (member.userId === userId) state.audit.push({ id: crypto.randomUUID(), workspaceId: member.workspaceId, actorId: userId, action, timestamp: new Date().toISOString() });
  }
  async verifyEmail(body: Record<string, unknown>) {
    if (this.options.EDITION === 'self-hosted') fail('HOSTED_ONLY');
    const id = await hashToken(requireString(body.token, 'Verification token', 128));
    return this.mutate(state => {
      const item = state.emailTokens.find(candidate => candidate.id === id && candidate.kind === 'verify' && candidate.expiresAt > Date.now());
      const user = item && state.users.find(candidate => candidate.id === item.userId && candidate.email === item.email && !candidate.machine);
      if (!user) throw new ApiError(410, 'VERIFICATION_EXPIRED', 'This verification link is invalid, expired, or already used.');
      user.emailVerified = true;
      state.emailTokens = state.emailTokens.filter(candidate => candidate.userId !== user.id || candidate.kind !== 'verify');
      this.auditAccount(state, user.id, 'account:email-verified');
      return { ok: true };
    });
  }
  async resendVerification(p: Principal) {
    if (this.options.EDITION === 'self-hosted') fail('HOSTED_ONLY');
    const raw = token(); const id = await hashToken(raw);
    const email = await this.mutate(state => {
      this.validate(state, p); if (p.bootstrap || p.credentialId) fail();
      const user = state.users.find(candidate => candidate.id === p.userId); if (!user || user.machine) fail();
      if (user.emailVerified) throw new ApiError(409, 'EMAIL_ALREADY_VERIFIED', 'This email address is already verified.');
      if (!consumeLimit(state, `verify-email:${user.id}`, 3, 3_600_000)) return null;
      state.emailTokens = state.emailTokens.filter(candidate => candidate.userId !== user.id || candidate.kind !== 'verify');
      state.emailTokens.push({ id, userId: user.id, email: user.email, kind: 'verify', expiresAt: Date.now() + VERIFY_TOKEN_MS });
      return user.email;
    });
    if (!email) throw new ApiError(429, 'RATE_LIMITED', 'Too many verification emails were requested. Try again in an hour.');
    return { email, token: raw };
  }
  async requestPasswordReset(body: Record<string, unknown>): Promise<{ email: string; token: string } | null> {
    const email = requireString(body.email, 'Email', 254).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    const raw = token(); const id = await hashToken(raw); const limitKey = `password-reset:${await hashToken(email)}`;
    return this.mutate(state => {
      if (!consumeLimit(state, limitKey, 3, 3_600_000)) return null;
      const user = state.users.find(candidate => candidate.email === email && !candidate.machine);
      if (!user) return null;
      state.emailTokens = state.emailTokens.filter(candidate => candidate.userId !== user.id || candidate.kind !== 'reset');
      state.emailTokens.push({ id, userId: user.id, email, kind: 'reset', expiresAt: Date.now() + RESET_TOKEN_MS });
      this.auditAccount(state, user.id, 'account:password-reset-requested');
      return { email, token: raw };
    });
  }
  async confirmPasswordReset(body: Record<string, unknown>) {
    const id = await hashToken(requireString(body.token, 'Reset token', 128)); const password = requireString(body.password, 'Password', 256, 12);
    const salt = token(); const hash = await passwordHash(password, salt);
    return this.mutate(state => {
      const item = state.emailTokens.find(candidate => candidate.id === id && candidate.kind === 'reset' && candidate.expiresAt > Date.now());
      const user = item && state.users.find(candidate => candidate.id === item.userId && candidate.email === item.email && !candidate.machine);
      if (!user) throw new ApiError(410, 'RESET_EXPIRED', 'This password reset link is invalid, expired, or already used.');
      user.salt = salt; user.hash = hash; user.emailVerified = true;
      for (const session of state.sessions) if (session.userId === user.id) session.revoked = true;
      state.challenges = state.challenges.filter(challenge => challenge.userId !== user.id);
      state.emailTokens = state.emailTokens.filter(candidate => candidate.userId !== user.id);
      clearLoginFailures(state, user.id);
      this.auditAccount(state, user.id, 'account:password-reset');
      return { ok: true };
    });
  }
  async registerMachine(body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async claimMachine(p: Principal, body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  private actions(value: unknown): Action[] { if (!Array.isArray(value) || !value.length || value.some(v => !ROLE_ACTIONS.Owner.includes(v))) throw new ApiError(400, 'INVALID_ACTIONS', 'Select valid resource actions.'); return [...new Set(value)] as Action[]; }
  async acceptInvite(p: Principal, value: string) { const hash = await hashToken(value); return this.mutate(state => { this.validate(state, p); if (p.bootstrap || p.credentialId) fail(); const invite = state.invitations.find(i => i.hash === hash && !i.accepted && i.expiresAt > Date.now()); if (!invite) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.'); const user = state.users.find(u => u.id === p.userId); if (!user || user.email !== invite.email) fail('INVITATION_IDENTITY', 'This invitation was issued for a different account email.'); if (state.members.some(m => m.workspaceId === invite.workspaceId && m.userId === p.userId)) throw new ApiError(409, 'ALREADY_MEMBER', 'You already belong to this workspace.'); state.members.push({ userId: p.userId, workspaceId: invite.workspaceId, role: invite.role }); invite.accepted = true; return { ok: true, workspaceId: invite.workspaceId }; }); }
  async clearApprovals(p: Principal, missionId: string) { await this.mutate(state => { this.validate(state,p); for (const key of Object.keys(state.approvals)) if (key.startsWith(`${p.workspaceId}:${missionId}:`)) delete state.approvals[key]; }); }
  async logout(p: Principal) { if (p.sessionId) await this.action(p, 'session-revoke', { id: p.sessionId }); }
  async recordApproval(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, checks: {name: string; status: string; candidateSha?: string}[], creatorId?: string, rule?: ReviewRule) { return this.mutate(state => { this.validate(state, p); if (p.credentialId) fail(); const protection = rule ? { requiredApprovals: rule.requiredApprovals, requiredChecks: rule.requiredCheckNames, preventSelfApproval: rule.preventSelfApproval } : state.protections[p.workspaceId] ?? { requiredApprovals: 1, requiredChecks: [], preventSelfApproval: false }; if (protection.preventSelfApproval && (!creatorId || creatorId === p.userId)) fail('SELF_APPROVAL', 'A different member must review this Stream.'); if (protection.requiredChecks.some(name => !checks.some(check => check.name === name && check.status === 'passed' && check.candidateSha === candidateSha))) throw new ApiError(409, 'CHECKS_REQUIRED', 'Required checks have not passed for this revision.'); const key = `${p.workspaceId}:${missionId}:${candidateSha}:${baseSha}:${epoch}`; const reviewers = [...new Set([...(state.approvals[key] ?? []), p.userId])]; state.approvals[key] = reviewers; return { approvals: reviewers.length, requiredApprovals: protection.requiredApprovals, ready: reviewers.length >= protection.requiredApprovals }; }); }
  async assertLand(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, repositoryId?: string, rule?: ReviewRule) {
    await this.read(state => {
      this.validate(state, p);
      if (rule?.restrictLanders.length && !rule.restrictLanders.includes(p.role)) fail('LANDER_RESTRICTED', `Branch protection allows only ${rule.restrictLanders.join(' or ')} members to land this change.`);
      const required = rule ? rule.requiredApprovals : state.protections[p.workspaceId]?.requiredApprovals ?? 1;
      const reviewers = state.approvals[`${p.workspaceId}:${missionId}:${candidateSha}:${baseSha}:${epoch}`] ?? [];
      const valid = reviewers.filter(id => {
        if (id === 'bootstrap-owner') return !state.workspaces.find(w => w.id === p.workspaceId)?.bootstrapDisabled;
        const member = state.members.find(m => m.userId === id && m.workspaceId === p.workspaceId);
        if (!member) return false;
        if (ROLE_ACTIONS[member.role].includes('review') && (!member.repositoryIds || !!repositoryId && member.repositoryIds.includes(repositoryId))) return true;
        return state.grants.some(g => g.workspaceId === p.workspaceId && g.actions.includes('review') && (g.resourceType === 'stream' && g.resourceId === missionId || g.resourceType === 'repository' && g.resourceId === repositoryId) && (g.subjectType === 'user' ? g.subjectId === id : state.teams.some(t => t.id === g.subjectId && t.workspaceId === p.workspaceId && t.userIds.includes(id))));
      });
      if (valid.length < required) fail('APPROVALS_REQUIRED', 'This revision needs additional current approvals.');
    });
  }
}
export class GitflareSecurity extends DurableObject<AppEnv> {
  private service: SecurityService;
  constructor(ctx: DurableObjectState, env: AppEnv) { super(ctx, env); this.service = new SecurityService(ctx.storage, env as AppEnv & SecurityOptions); }
  connectionStore(p: Principal | null, operation: 'get' | 'put' | 'delete' | 'state-put' | 'state-consume', body: Record<string, unknown> = {}) { return this.service.connectionStore(p, operation, body); }
  projectStore(p: Principal, repositoryId: string, operation: 'get' | 'set' | 'plan' | 'consume' | 'finish', body: Record<string, unknown> = {}) { return this.service.projectStore(p, repositoryId, operation, body); }
  authConfig() { return this.service.authConfig(); }
  startSetup(body: Record<string, unknown>) { return this.service.startSetup(body); }
  verifyMfa(body: Record<string, unknown>, setupOnly?: boolean) { return this.service.verifyMfa(body, setupOnly); }
  enrollMfa(p: Principal) { return this.service.enrollMfa(p); }
  createInstallationUser(p: Principal, body: Record<string, unknown>) { return this.service.createInstallationUser(p, body); }
  registerInvitedUser(body: Record<string, unknown>) { return this.service.registerInvitedUser(body); }
  registerMachine(body: Record<string, unknown>) : never { throw new Error('This feature belongs to the hosted edition'); }
  claimMachine(p: Principal, body: Record<string, unknown>) : never { throw new Error('This feature belongs to the hosted edition'); }
  rateLimit(key: string, max?: number, windowMs?: number) { return this.service.rateLimit(key, max, windowMs); }
  signup(body: Record<string, unknown>) : never { throw new Error('This feature belongs to the hosted edition'); }
  verifyEmail(body: Record<string, unknown>) { return this.service.verifyEmail(body); }
  resendVerification(p: Principal) { return this.service.resendVerification(p); }
  requestPasswordReset(body: Record<string, unknown>) { return this.service.requestPasswordReset(body); }
  confirmPasswordReset(body: Record<string, unknown>) { return this.service.confirmPasswordReset(body); }
  login(body: Record<string, unknown>, client?: string) { return this.service.login(body, client); }
  legacySession() { return this.service.legacySession(); }
  bootstrap() { return this.service.bootstrap(); }
  authenticate(value: string, workspaceId?: string) { return this.service.authenticate(value, workspaceId); }
  authorize(p: Principal, action: Action, type?: string, id?: string, missionId?: string) { return this.service.authorize(p, action, type, id, missionId); }
  authorizeMetadata(p: Principal) { return this.service.authorizeMetadata(p); }
  check(p: Principal, action: Action, type?: string, id?: string, missionId?: string) { return this.service.check(p, action, type, id, missionId); }
  checkMany(p: Principal, action: Action, resources: { resourceType: string; resourceId: string; missionId?: string }[]) { return this.service.checkMany(p, action, resources); }
  workspace(p: Principal) { return this.service.workspace(p); }
  snapshot(p: Principal) { return this.service.snapshot(p); }
  action(p: Principal, action: string, body: Record<string, unknown>) { return this.service.action(p, action, body); }
  acceptInvite(p: Principal, value: string) { return this.service.acceptInvite(p, value); }
  clearApprovals(p: Principal, missionId: string) { return this.service.clearApprovals(p, missionId); }
  logout(p: Principal) { return this.service.logout(p); }
  recordApproval(p: Principal, missionId: string, sha: string, baseSha: string, epoch: number, checks: {name: string; status: string; candidateSha?: string}[], creatorId?: string, rule?: ReviewRule) { return this.service.recordApproval(p, missionId, sha, baseSha, epoch, checks, creatorId, rule); }
  assertLand(p: Principal, missionId: string, sha: string, baseSha: string, epoch: number, repositoryId?: string, rule?: ReviewRule) { return this.service.assertLand(p, missionId, sha, baseSha, epoch, repositoryId, rule); }
}
