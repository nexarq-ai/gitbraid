import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, requireString } from './domain';
import type { AppEnv } from './env';
import type { CloudflareConnection, CloudflareIdentity, CloudflareOAuthState } from './cloudflare';
import { normalizeProjectMapping, type ProjectMapping, type MigrationPlan } from './cloudflare-projects';
import { authenticatorUri, decryptAuth, encryptAuth, mfaSecret, randomCapability, verifyTotp } from './mfa';

export const ROLES = ['Viewer', 'Contributor', 'Reviewer', 'Maintainer', 'Deployer', 'Owner'] as const;
export type Role = typeof ROLES[number];
export type Action = 'read' | 'contribute' | 'execute' | 'review' | 'land' | 'deploy' | 'migrate' | 'manage';
export const ROLE_ACTIONS: Record<Role, Action[]> = {
  Viewer: ['read'], Contributor: ['read', 'contribute', 'execute'], Reviewer: ['read', 'review'],
  Maintainer: ['read', 'contribute', 'execute', 'review', 'land'], Deployer: ['read', 'deploy'], Owner: ['read', 'contribute', 'execute', 'review', 'land', 'deploy', 'migrate', 'manage'],
};
interface User { id: string; name: string; email: string; salt: string; hash: string; machine?: boolean; emailVerified?: boolean; cloudflareId?: string; revision?: number; reviewer?: { workspaceId: string }; disabled?: boolean }
interface Member { userId: string; workspaceId: string; role: Role; repositoryIds?: string[] }
interface Session { id: string; userId: string; workspaceId: string; hash: string; expiresAt: number; authenticatedAt?: number; revoked?: boolean; client?: string }
type PublicSession = Omit<Session, 'hash'>;
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
interface AuthChallenge { id: string; userId: string; kind: 'setup' | 'enroll' | 'login'; workspaceId?: string; expiresAt: number; used?: boolean; linkId?: string }
export interface CloudflareSigninState { id: string; browserHash: string; expiresAt: number; encrypted: string }
interface CloudflareLink { id: string; cloudflareId: string; email: string; expiresAt: number }
export interface CloudflareSigninInput { identity: CloudflareIdentity; userId: string; workspaceId: string; workspaceName: string; connection?: CloudflareConnection; sessionHash?: string; linkHash: string; invitation?: string; mintToken?: boolean }
export type CloudflareSigninResult = { status: 'signed-in'; user: ReturnType<typeof safeUser>; workspaceId: string; created: boolean; connectionStored: boolean; token?: string } | { status: 'link-required'; created: false; connectionStored: false }
interface Installation { workspaceName?: string; workspaceId?: string; pendingUser?: User; challengeId?: string; pendingWorkspaceId?: string }
interface EmailToken { id: string; userId: string; email: string; kind: 'verify' | 'reset'; expiresAt: number }
interface LoginFailures { count: number; lockedUntil: number; updatedAt: number }
interface MachineRegistration { id: string; requestHash: string; response: string; workspaceId: string; userId: string; claimHash: string; expiresAt: number; claimedBy?: string }
export type ReviewerOperation = 'create' | 'rotate' | 'disable';
export interface ReviewerAccountResult { email: string; userId: string; workspaceId: string; created: boolean; disabled: boolean; password?: string }
export interface MfaChallengeResult { mfaRequired: true; challengeId: string; expiresAt: number; enrollmentRequired: boolean; secret?: string; otpauthUri?: string }
interface State { cloudflareConnections: Record<string, CloudflareConnection>; cloudflareStates: Record<string, CloudflareOAuthState>; cloudflareSignins: Record<string, CloudflareSigninState>; cloudflareLinks: Record<string, CloudflareLink>; cloudflareProjects: Record<string, ProjectRecord>; mfa: MfaRecord[]; challenges: AuthChallenge[]; emailTokens: EmailToken[]; loginFailures: Record<string, LoginFailures>; installations: Record<string, Installation>; machines: MachineRegistration[]; users: User[]; members: Member[]; sessions: Session[]; workspaces: WorkspaceRecord[]; invitations: Invitation[]; teams: Team[]; grants: Grant[]; credentials: Credential[]; audit: Audit[]; protections: Record<string, Protection>; approvals: Record<string, string[]>; limits: Record<string, { count: number; until: number }> }
interface ProjectRecord { mapping: ProjectMapping | null; plans: MigrationPlan[] }
export interface Principal { userId: string; workspaceId: string; role: Role; sessionId?: string; credentialId?: string; bootstrap?: boolean }
export interface LegacyWorkspaceSlice { workspace: WorkspaceRecord | null; members: Member[]; sessions: Session[]; teams: Team[]; invitations: Invitation[]; grants: Grant[]; credentials: Credential[]; protection: Protection | null; approvals: Record<string, string[]>; connection: CloudflareConnection | null; cloudflareStates: CloudflareOAuthState[]; projects: Record<string, ProjectRecord>; audit: Audit[] }
interface IndexEntry { workspaceId: string; expiresAt: number }
interface Outbox { id: string; userId: string; revision: number; workspaces: string[]; at: number }
type AuditInput = { actorId: string; action: string; resourceId?: string };

const initial = (): State => ({ cloudflareConnections: {}, cloudflareStates: {}, cloudflareSignins: {}, cloudflareLinks: {}, cloudflareProjects: {}, mfa: [], challenges: [], emailTokens: [], loginFailures: {}, installations: {}, machines: [], users: [], members: [], sessions: [], workspaces: [{ id: 'legacy', name: 'Gitflare workspace' }], invitations: [], teams: [], grants: [], credentials: [], audit: [], protections: {}, approvals: {}, limits: {} });
const encode = new TextEncoder();
export async function hashToken(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', encode.encode(value))); }
function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join(''); }
function token(): string { return hex(crypto.getRandomValues(new Uint8Array(32)).buffer); }
export async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encode.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encode.encode(salt), iterations: 100000 }, key, 256));
}
function role(value: unknown): Role { if (!ROLES.includes(value as Role)) throw new ApiError(400, 'INVALID_ROLE', 'Select a valid workspace role.'); return value as Role; }
function safeUser(user: User) { return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified === true, cloudflareLinked: !!user.cloudflareId }; }
function fail(code = 'FORBIDDEN', message = 'Your workspace permissions do not allow this action.'): never { throw new ApiError(403, code, message); }
function publicValue<T extends { hash: string }>(value: T): Omit<T, 'hash'> { const { hash: _hash, ...rest } = value; return rest; }
const AUDIT_LIMIT_PER_WORKSPACE = 1000;
const MAX_DERIVED_SESSION_AGE_MS = 86_400_000;
const SESSION_MS = 28_800_000;
function activeSession(session: Pick<Session, 'revoked' | 'expiresAt' | 'authenticatedAt'>, now: number): boolean {
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
const CLOUDFLARE_STATE_MS = 600_000;
const CLOUDFLARE_PENDING_LIMIT = 10_000;
const SWEEP_INTERVAL_MS = 300_000;
const SWEEP_BATCH = 500;
const OUTBOX_GRACE_MS = 30_000;
const MIGRATION_VERSION = 1;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function sameHash(left: string, right: string): boolean { const a = encode.encode(left); const b = encode.encode(right); return a.length === b.length && timingSafeEqual(a, b); }
function liveFailure(failures: LoginFailures | undefined, now: number): failures is LoginFailures { return !!failures && (failures.lockedUntil ? failures.lockedUntil > now : failures.updatedAt + LOGIN_FAILURE_WINDOW_MS > now); }

type StoredRecord = { group: string; value: unknown };
function buildState(records: Iterable<[string, StoredRecord]>): State {
  const state = initial(); let stored = false;
  for (const [key, record] of records) {
    if (!stored) { stored = true; for (const [group, value] of Object.entries(state)) (state as unknown as Record<string, unknown>)[group] = Array.isArray(value) ? [] : {}; }
    const target = (state as unknown as Record<string, unknown>)[record.group];
    if (Array.isArray(target)) target.push(record.value);
    else if (target) (target as Record<string, unknown>)[decodeURIComponent(key.split(':').slice(2).join(':'))] = record.value;
  }
  state.audit = boundedAudit(state.audit);
  return state;
}
function legacySlice(state: State, workspaceId: string): LegacyWorkspaceSlice {
  const owned = <T extends { workspaceId: string }>(items: T[]) => items.filter(item => item.workspaceId === workspaceId);
  const prefixed = <T,>(values: Record<string, T>, separator: string) => Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(`${workspaceId}${separator}`)));
  return {
    workspace: state.workspaces.find(w => w.id === workspaceId) ?? null, members: owned(state.members), sessions: owned(state.sessions), teams: owned(state.teams), invitations: owned(state.invitations), grants: owned(state.grants), credentials: owned(state.credentials),
    protection: state.protections[workspaceId] ?? null, approvals: prefixed(state.approvals, ':'), connection: state.cloudflareConnections[workspaceId] ?? null,
    cloudflareStates: Object.values(state.cloudflareStates).filter(value => value.principal.workspaceId === workspaceId),
    projects: Object.fromEntries(Object.entries(prefixed(state.cloudflareProjects, '/')).map(([key, value]) => [key.slice(workspaceId.length + 1), value])),
    audit: owned(state.audit),
  };
}

const TOKEN_PATTERN = /^gf1\.([A-Za-z0-9-]{1,64})\.[a-f0-9]{64}$/;
const SESSION_ID_PATTERN = /^([A-Za-z0-9-]{1,64})\.[0-9a-f-]{36}$/;
export function shardName(workspaceId: string): string { return `security:ws:${workspaceId}`; }
function mintToken(workspaceId: string): string { return `gf1.${workspaceId}.${token()}`; }
function tokenHome(value: string): string | undefined { return TOKEN_PATTERN.exec(value)?.[1]; }
export function wellFormedToken(value: string): boolean { return TOKEN_PATTERN.test(value) || /^[a-f0-9]{64}$/.test(value); }
function sessionIdHome(id: string): string | undefined { return SESSION_ID_PATTERN.exec(id)?.[1]; }
function missingRpcMethod(error: unknown): boolean {
  return error instanceof Error && !error.message.startsWith('GITFLARE:') && /not a function|does not exist|not implemented|does not implement|unknown method|no such method|not supported/i.test(error.message);
}

type Storage = Pick<DurableObjectStorage, 'transaction'>;
type ListOptions = { prefix: string; start?: string; reverse?: boolean; limit?: number };
const GONE = Symbol('gone');
type Writes = Map<string, unknown>;
const enc = encodeURIComponent;
const key = {
  user: (id: string) => `id:user:${enc(id)}`, email: (email: string) => `id:email:${enc(email)}`, cloudflare: (id: string) => `id:cf:${enc(id)}`, hints: (userId: string) => `id:hint:${enc(userId)}`,
  mfa: (userId: string) => `id:mfa:${enc(userId)}`, challenge: (id: string) => `id:chal:${enc(id)}`, userChallenges: (userId: string) => `id:uchal:${enc(userId)}`, emailToken: (id: string) => `id:etok:${enc(id)}`, userEmailTokens: (userId: string) => `id:uetok:${enc(userId)}`,
  failures: (id: string) => `id:fail:${enc(id)}`, limit: (id: string) => `id:limit:${enc(id)}`, installation: (id: string) => `id:install:${enc(id)}`, machine: (id: string) => `id:machine:${enc(id)}`, machineClaim: (hash: string) => `id:mclaim:${enc(hash)}`,
  signin: (id: string) => `id:cfsignin:${enc(id)}`, link: (id: string) => `id:cflink:${enc(id)}`, linkEmail: (email: string) => `id:cflinkemail:${enc(email)}`,
  route: (hash: string) => `id:route:${enc(hash)}`, sessionHome: (id: string) => `id:sesshome:${enc(id)}`, invite: (hash: string) => `id:invite:${enc(hash)}`, oauthState: (id: string) => `id:cfstate:${enc(id)}`,
  outbox: (id: string) => `id:outbox:${enc(id)}`, legacyWorkspace: (id: string) => `id:legacy-ws:${enc(id)}`, migration: 'id:migration',
};

class Records {
  private cache = new Map<string, unknown>();
  constructor(private storage: Storage, private limit = 20_000) {}
  async get<T>(id: string): Promise<T | undefined> {
    if (this.cache.has(id)) { const value = this.cache.get(id); return value === GONE ? undefined : structuredClone(value) as T; }
    const value = await this.storage.transaction(txn => txn.get<T>(id));
    this.remember(id, value === undefined ? GONE : value);
    return value === undefined ? undefined : structuredClone(value);
  }
  list<T>(options: ListOptions): Promise<Map<string, T>> { return this.storage.transaction(txn => txn.list<T>(options)); }
  async commit(writes: Writes): Promise<void> {
    if (!writes.size) return;
    await this.storage.transaction(async txn => { for (const [id, value] of writes) { if (value === GONE) await txn.delete(id); else await txn.put(id, value); } });
    for (const [id, value] of writes) this.remember(id, value);
  }
  private remember(id: string, value: unknown) {
    this.cache.delete(id); this.cache.set(id, value);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
  }
}
class Unit {
  readonly writes: Writes = new Map();
  constructor(private records: Records) {}
  async get<T>(id: string): Promise<T | undefined> {
    if (this.writes.has(id)) { const value = this.writes.get(id); return value === GONE ? undefined : structuredClone(value) as T; }
    return this.records.get<T>(id);
  }
  put(id: string, value: unknown) { this.writes.set(id, structuredClone(value)); }
  delete(id: string) { this.writes.set(id, GONE); }
  list<T>(options: ListOptions) { return this.records.list<T>(options); }
}
function exclusiveQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  // Operations await crypto and storage between reads and writes of shared state, so they must never interleave
  return function run<T>(task: () => Promise<T>): Promise<T> { const next = queue.then(task); queue = next.catch(() => {}); return next; };
}

export class IdentityStore {
  private records: Records;
  private exclusive = exclusiveQueue();
  private migrated?: Promise<void>;
  private legacy?: Promise<State | null>;
  private lastSweep = 0;
  constructor(private storage: Storage, private options: SecurityOptions, private shard: (workspaceId: string) => Remote<WorkspaceStore>, private schedule?: () => Promise<void>) { this.records = new Records(storage); }
  private ensureMigrated(): Promise<void> { return this.migrated ??= this.migrate().catch(error => { this.migrated = undefined; throw error; }); }
  private async migrate(): Promise<void> {
    const marker = await this.records.get<{ version: number; pending?: number }>(key.migration);
    if (marker) { if (marker.pending) await this.schedule?.(); return; }
    const legacy = await this.loadLegacy();
    const unit = new Unit(this.records); const now = Date.now();
    const workspaces = legacy ? splitIdentity(legacy, unit, now) : [];
    unit.put(key.migration, { version: MIGRATION_VERSION, at: new Date(now).toISOString(), workspaces: workspaces.length, pending: workspaces.length });
    await this.records.commit(unit.writes);
    if (workspaces.length) await this.schedule?.();
  }
  private loadLegacy(): Promise<State | null> {
    return this.legacy ??= this.storage.transaction(async txn => {
      const records = await txn.list<StoredRecord>({ prefix: 'sec:' });
      if (records.size) return buildState(records);
      const blob = await txn.get<State>('security');
      return blob === undefined ? null : buildState(Object.entries({ ...initial(), ...blob }).flatMap(([group, values]) => (Array.isArray(values) ? values.map((value, index) => [`sec:${group}:${index}`, value]) : Object.entries(values as Record<string, unknown>).map(([id, value]) => [`sec:${group}:${enc(id)}`, value])).map(([id, value]) => [id as string, { group, value }] as [string, StoredRecord])));
    }).catch(error => { this.legacy = undefined; throw error; });
  }
  private read<T>(task: (unit: Unit) => Promise<T> | T): Promise<T> {
    return this.exclusive(async () => { await this.ensureMigrated(); return structuredClone(await task(new Unit(this.records))); });
  }
  private write<T>(task: (unit: Unit) => Promise<T> | T): Promise<T> {
    return this.exclusive(async () => {
      await this.ensureMigrated();
      const unit = new Unit(this.records); const now = Date.now(); const sweeping = now - this.lastSweep >= SWEEP_INTERVAL_MS;
      if (sweeping) await this.sweep(unit, now);
      const result = await task(unit);
      await this.records.commit(unit.writes);
      if (sweeping) this.lastSweep = now;
      return structuredClone(result);
    });
  }
  private async sweep(unit: Unit, now: number) {
    const expired: [string, (value: never) => boolean][] = [
      ['id:limit:', (v: { until: number }) => v.until <= now], ['id:chal:', (v: AuthChallenge) => !!v.used || v.expiresAt <= now], ['id:etok:', (v: EmailToken) => v.expiresAt <= now],
      ['id:fail:', (v: LoginFailures) => !liveFailure(v, now)], ['id:cfsignin:', (v: CloudflareSigninState) => v.expiresAt <= now], ['id:cflink:', (v: CloudflareLink) => v.expiresAt <= now],
      ['id:route:', (v: IndexEntry) => v.expiresAt <= now], ['id:sesshome:', (v: IndexEntry) => v.expiresAt <= now], ['id:invite:', (v: IndexEntry) => v.expiresAt + RETENTION_MS <= now], ['id:cfstate:', (v: IndexEntry) => v.expiresAt <= now],
      ['id:machine:', (v: MachineRegistration) => v.expiresAt + RETENTION_MS <= now],
    ];
    for (const [prefix, isExpired] of expired) for (const [id, value] of await unit.list<never>({ prefix, limit: SWEEP_BATCH })) if (isExpired(value)) {
      unit.delete(id);
      if (prefix === 'id:machine:') unit.delete(key.machineClaim((value as MachineRegistration).claimHash));
    }
  }
  private async user(unit: Unit, id: string) { return unit.get<User>(key.user(id)); }
  private async userByEmail(unit: Unit, email: string) { const id = await unit.get<string>(key.email(email)); const user = id ? await this.user(unit, id) : undefined; return user?.email === email ? user : undefined; }
  private async hintList(unit: Unit, userId: string) { return await unit.get<string[]>(key.hints(userId)) ?? []; }
  private async addHintTo(unit: Unit, userId: string, workspaceId: string) { const hints = await this.hintList(unit, userId); if (!hints.includes(workspaceId)) unit.put(key.hints(userId), [...hints, workspaceId]); }
  private async putUser(unit: Unit, user: User) {
    unit.put(key.user(user.id), user); unit.put(key.email(user.email), user.id);
    if (user.cloudflareId) unit.put(key.cloudflare(user.cloudflareId), user.id);
  }
  private async limitAllows(unit: Unit, id: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now(); const entry = await unit.get<{ count: number; until: number }>(key.limit(id));
    const next = !entry || entry.until <= now ? { count: 1, until: now + windowMs } : { ...entry, count: entry.count + 1 };
    unit.put(key.limit(id), next);
    return next.count <= max;
  }
  private async clearFailures(unit: Unit, userId: string) { for (const id of (await unit.list({ prefix: key.failures(userId) })).keys()) unit.delete(id); }
  private async replaceChallenges(unit: Unit, userId: string, next?: AuthChallenge) {
    for (const id of await unit.get<string[]>(key.userChallenges(userId)) ?? []) unit.delete(key.challenge(id));
    if (next) { unit.put(key.challenge(next.id), next); unit.put(key.userChallenges(userId), [next.id]); } else unit.delete(key.userChallenges(userId));
  }
  private async replaceEmailTokens(unit: Unit, userId: string, keep: (item: EmailToken) => boolean, next?: EmailToken) {
    const ids: string[] = [];
    for (const id of await unit.get<string[]>(key.userEmailTokens(userId)) ?? []) { const item = await unit.get<EmailToken>(key.emailToken(id)); if (item && keep(item)) ids.push(id); else unit.delete(key.emailToken(id)); }
    if (next) { unit.put(key.emailToken(next.id), next); ids.push(next.id); }
    if (ids.length) unit.put(key.userEmailTokens(userId), ids); else unit.delete(key.userEmailTokens(userId));
  }
  private async outbox(unit: Unit, user: User, extra: string[] = []): Promise<Outbox> {
    user.revision = (user.revision ?? 0) + 1; unit.put(key.user(user.id), user);
    const entry: Outbox = { id: crypto.randomUUID(), userId: user.id, revision: user.revision, workspaces: [...new Set([...await this.hintList(unit, user.id), ...extra])], at: Date.now() };
    unit.put(key.outbox(entry.id), entry);
    await this.schedule?.();
    return entry;
  }
  private passwordUser(current: User | undefined, authenticated: User): User {
    if (!current || current.email !== authenticated.email || current.salt !== authenticated.salt || current.hash !== authenticated.hash || current.machine || current.disabled) throw new ApiError(401, 'AUTH_REQUIRED', 'The email or password was not accepted.');
    return current;
  }

  rateLimit(id: string, max: number, windowMs: number) { return this.write(unit => this.limitAllows(unit, id, max, windowMs)); }
  users(ids: string[]) { return this.read(async unit => Object.fromEntries((await Promise.all([...new Set(ids)].map(id => this.user(unit, id)))).filter((user): user is User => !!user).map(user => [user.id, safeUser(user)]))); }
  account(id: string) { return this.read(unit => this.user(unit, id)); }
  accountByEmail(email: string) { return this.read(unit => this.userByEmail(unit, email)); }
  hints(userId: string) { return this.read(unit => this.hintList(unit, userId)); }
  addHint(userId: string, workspaceId: string) { return this.write(unit => this.addHintTo(unit, userId, workspaceId)); }
  removeHint(userId: string, workspaceId: string) { return this.write(async unit => { const hints = await this.hintList(unit, userId); if (hints.includes(workspaceId)) unit.put(key.hints(userId), hints.filter(id => id !== workspaceId)); }); }
  mfaEnabled(userId: string) { return this.read(async unit => !!(await unit.get<MfaRecord>(key.mfa(userId)))?.enabled); }
  installationWorkspace() { return this.read(async unit => (await unit.get<Installation>(key.installation('self')))?.workspaceId ?? null); }
  selfHostedAllowed(userId: string, workspaceId: string) { return this.read(async unit => (await unit.get<Installation>(key.installation('self')))?.workspaceId === workspaceId && !!(await unit.get<MfaRecord>(key.mfa(userId)))?.enabled); }
  lookup(kind: 'route' | 'sessionHome' | 'invite' | 'oauthState', id: string) { return this.read(async unit => { const entry = await unit.get<IndexEntry>(key[kind](id)); return entry && (kind === 'invite' || entry.expiresAt > Date.now()) ? entry.workspaceId : null; }); }
  index(kind: 'route' | 'invite' | 'oauthState', id: string, entry: IndexEntry | null) { return this.write(unit => { if (entry) unit.put(key[kind](id), entry); else unit.delete(key[kind](id)); }); }
  loginAttempt(input: { userId?: string; email: string; salt?: string; hash: string; client: string }) {
    return this.write(async unit => {
      const current = input.userId ? await this.user(unit, input.userId) : undefined;
      if (!current || current.email !== input.email || current.salt !== input.salt || current.machine || current.disabled) return { user: null, locked: false, mfaEnabled: false };
      const clientKey = `${current.id}|${input.client.slice(0, 64)}`; const now = Date.now();
      const failures = await Promise.all([clientKey, current.id].map(async id => [id, await unit.get<LoginFailures>(key.failures(id))] as const));
      if (failures.some(([, value]) => liveFailure(value, now) && value.lockedUntil > now)) return { user: null, locked: false, mfaEnabled: false };
      if (sameHash(current.hash, input.hash)) { await this.clearFailures(unit, current.id); return { user: current, locked: false, mfaEnabled: !!(await unit.get<MfaRecord>(key.mfa(current.id)))?.enabled }; }
      let locked = false;
      for (const [[id, value], limit] of [[failures[0], LOGIN_FAILURE_LIMIT], [failures[1], ACCOUNT_FAILURE_LIMIT]] as const) {
        const count = (liveFailure(value, now) ? value.count : 0) + 1;
        unit.put(key.failures(id), { count, lockedUntil: count >= limit ? now + LOGIN_LOCK_MS : 0, updatedAt: now });
        if (count === limit) locked = true;
      }
      return { user: null, locked, mfaEnabled: false };
    });
  }
  loginFinish(authenticated: User) {
    return this.read(async unit => {
      const current = this.passwordUser(await this.user(unit, authenticated.id), authenticated);
      if ((await unit.get<MfaRecord>(key.mfa(current.id)))?.enabled) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in again with your authenticator.');
      return current;
    });
  }
  applyLink(userId: string, linkId?: string) {
    return this.write(async unit => {
      const link = linkId ? await unit.get<CloudflareLink>(key.link(linkId)) : undefined; const user = await this.user(unit, userId);
      if (!user || !link || link.expiresAt <= Date.now() || link.email !== user.email || user.cloudflareId || user.reviewer || await unit.get<string>(key.cloudflare(link.cloudflareId))) return null;
      unit.delete(key.link(link.id)); unit.delete(key.linkEmail(link.email));
      user.cloudflareId = link.cloudflareId; user.emailVerified = true; await this.putUser(unit, user);
      return user;
    });
  }
  beginMfa(input: { userId: string; memberWorkspaceId?: string; authUser?: User; expectedRevision?: number; challengeHash: string; encryptedSecret: string; expiresAt: number; linkId?: string }) {
    return this.write(async unit => {
      const user = await this.user(unit, input.userId);
      if (input.authUser) this.passwordUser(user, input.authUser);
      if (input.expectedRevision !== undefined && (user?.revision ?? 0) !== input.expectedRevision) fail();
      if (this.options.EDITION === 'self-hosted' && !(await unit.get<Installation>(key.installation('self')))?.workspaceId) fail('SETUP_REQUIRED', 'Complete protected administrator setup first.');
      if (!user || user.machine || !input.memberWorkspaceId) fail();
      let mfa = await unit.get<MfaRecord>(key.mfa(user.id));
      if (!mfa?.enabled) { mfa = { id: user.id, encryptedSecret: input.encryptedSecret, enabled: false, lastStep: -1, recoveryHashes: [] }; unit.put(key.mfa(user.id), mfa); }
      await this.replaceChallenges(unit, user.id, { id: input.challengeHash, userId: user.id, kind: mfa.enabled ? 'login' : 'enroll', expiresAt: input.expiresAt, workspaceId: input.memberWorkspaceId, ...(input.linkId ? { linkId: input.linkId } : {}) });
      return { email: user.email, enrollmentRequired: !mfa.enabled };
    });
  }
  challenge(id: string) {
    return this.read(async unit => {
      const challenge = await unit.get<AuthChallenge>(key.challenge(id));
      if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) return null;
      const installation = challenge.kind === 'setup' ? await unit.get<Installation>(key.installation('self')) : undefined;
      return { userId: challenge.userId, kind: challenge.kind, setup: installation?.challengeId === id && installation.pendingUser && installation.pendingWorkspaceId ? { workspaceId: installation.pendingWorkspaceId, workspaceName: installation.workspaceName ?? 'Gitflare workspace', userId: installation.pendingUser.id } : undefined };
    });
  }
  verifyChallenge(input: { id: string; setupOnly: boolean; code?: string; recoveryHash?: string; recoveryHashes: string[] }) {
    return this.write(async unit => {
      const challenge = await unit.get<AuthChallenge>(key.challenge(input.id));
      if (!challenge || challenge.used || challenge.expiresAt <= Date.now() || input.setupOnly && challenge.kind !== 'setup') throw new ApiError(410, 'CHALLENGE_EXPIRED', 'This sign-in challenge is expired or already used.');
      const mfa = await unit.get<MfaRecord>(key.mfa(challenge.userId)); if (!mfa) fail();
      if (input.recoveryHash && challenge.kind === 'login' && mfa.enabled && mfa.recoveryHashes.includes(input.recoveryHash)) mfa.recoveryHashes = mfa.recoveryHashes.filter(hash => hash !== input.recoveryHash);
      else {
        const secret = await decryptAuth(mfa.encryptedSecret, this.options.AUTH_ENCRYPTION_KEY, `mfa:${mfa.id}`);
        const step = input.code ? await verifyTotp(secret, input.code, Date.now(), mfa.lastStep) : undefined;
        if (step === undefined) throw new ApiError(401, 'INVALID_MFA_CODE', 'The authenticator or recovery code was not accepted.');
        mfa.lastStep = step;
      }
      challenge.used = true; unit.put(key.challenge(challenge.id), challenge);
      const enrolling = !mfa.enabled; mfa.enabled = true; if (enrolling) mfa.recoveryHashes = input.recoveryHashes;
      unit.put(key.mfa(mfa.id), mfa);
      let user = await this.user(unit, challenge.userId); let workspaceId = challenge.workspaceId;
      if (challenge.kind === 'setup') {
        const installation = await unit.get<Installation>(key.installation('self'));
        if (this.options.EDITION !== 'self-hosted' || installation?.workspaceId || installation?.challengeId !== input.id || !installation.pendingUser) fail();
        user = installation.pendingUser; workspaceId = installation.pendingWorkspaceId ?? crypto.randomUUID();
        await this.putUser(unit, user); await this.addHintTo(unit, user.id, workspaceId);
        unit.put(key.installation('self'), { workspaceId });
      }
      if (!user) fail();
      const outbox = enrolling ? await this.outbox(unit, user, workspaceId ? [workspaceId] : []) : undefined;
      return { user, workspaceId, enrolling, kind: challenge.kind, linkId: challenge.linkId, revision: outbox?.revision ?? user.revision ?? 0, outbox };
    });
  }
  finishOutbox(id: string) { return this.write(unit => unit.delete(key.outbox(id))); }
  revokeAccount(userId: string, extra: string[]) { return this.write(async unit => { const user = await this.user(unit, userId); return user ? this.outbox(unit, user, extra) : null; }); }
  startSetup(input: { pendingUser: User; challengeHash: string; workspaceName: string; encryptedSecret: string; expiresAt: number; pendingWorkspaceId: string }) {
    return this.write(async unit => {
      const installation = await unit.get<Installation>(key.installation('self'));
      if (installation?.workspaceId) throw new ApiError(409, 'SETUP_COMPLETE', 'This installation already has an administrator.');
      const pending = installation?.challengeId ? await unit.get<AuthChallenge>(key.challenge(installation.challengeId)) : undefined;
      if (pending && !pending.used && pending.expiresAt > Date.now()) throw new ApiError(409, 'SETUP_IN_PROGRESS', 'An administrator enrollment is already in progress.');
      if ((await unit.list({ prefix: 'id:user:', limit: 1 })).size) throw new ApiError(409, 'EXISTING_INSTALLATION', 'Use the existing installation administrator.');
      for (const prefix of ['id:mfa:', 'id:chal:', 'id:uchal:']) for (const id of (await unit.list({ prefix })).keys()) unit.delete(id);
      const userId = input.pendingUser.id;
      unit.put(key.installation('self'), { pendingUser: input.pendingUser, challengeId: input.challengeHash, workspaceName: input.workspaceName, pendingWorkspaceId: input.pendingWorkspaceId } satisfies Installation);
      unit.put(key.mfa(userId), { id: userId, encryptedSecret: input.encryptedSecret, enabled: false, lastStep: -1, recoveryHashes: [] } satisfies MfaRecord);
      unit.put(key.challenge(input.challengeHash), { id: input.challengeHash, userId, kind: 'setup', expiresAt: input.expiresAt } satisfies AuthChallenge);
      unit.put(key.userChallenges(userId), [input.challengeHash]);
    });
  }
  createUser(input: { user: User; workspaceId?: string; emailToken?: EmailToken }) {
    return this.write(async unit => {
      if (await this.user(unit, input.user.id)) fail();
      if (await this.userByEmail(unit, input.user.email) || input.user.cloudflareId && await unit.get<string>(key.cloudflare(input.user.cloudflareId))) return false;
      await this.putUser(unit, input.user);
      if (input.workspaceId) await this.addHintTo(unit, input.user.id, input.workspaceId);
      if (input.emailToken) await this.replaceEmailTokens(unit, input.user.id, () => true, input.emailToken);
      return true;
    });
  }
  deleteUser(userId: string) {
    return this.write(async unit => {
      const user = await this.user(unit, userId); if (!user) return;
      unit.delete(key.user(userId)); unit.delete(key.hints(userId));
      if (await unit.get<string>(key.email(user.email)) === userId) unit.delete(key.email(user.email));
      if (user.cloudflareId && await unit.get<string>(key.cloudflare(user.cloudflareId)) === userId) unit.delete(key.cloudflare(user.cloudflareId));
      await this.replaceEmailTokens(unit, userId, () => false);
    });
  }
  verifyEmail(id: string) {
    return this.write(async unit => {
      const item = await unit.get<EmailToken>(key.emailToken(id));
      const user = item && item.kind === 'verify' && item.expiresAt > Date.now() ? await this.user(unit, item.userId) : undefined;
      if (!user || user.email !== item!.email || user.machine) throw new ApiError(410, 'VERIFICATION_EXPIRED', 'This verification link is invalid, expired, or already used.');
      user.emailVerified = true; unit.put(key.user(user.id), user);
      await this.replaceEmailTokens(unit, user.id, candidate => candidate.kind !== 'verify');
      return user.id;
    });
  }
  resendVerification(userId: string, id: string) {
    return this.write(async unit => {
      const user = await this.user(unit, userId); if (!user || user.machine) fail();
      if (user.emailVerified) throw new ApiError(409, 'EMAIL_ALREADY_VERIFIED', 'This email address is already verified.');
      if (!await this.limitAllows(unit, `verify-email:${user.id}`, 3, 3_600_000)) return null;
      await this.replaceEmailTokens(unit, user.id, candidate => candidate.kind !== 'verify', { id, userId: user.id, email: user.email, kind: 'verify', expiresAt: Date.now() + VERIFY_TOKEN_MS });
      return user.email;
    });
  }
  requestReset(email: string, id: string, limitKey: string) {
    return this.write(async unit => {
      if (!await this.limitAllows(unit, limitKey, 3, 3_600_000)) return null;
      const user = await this.userByEmail(unit, email);
      if (!user || user.machine || user.reviewer || !user.hash) return null;
      await this.replaceEmailTokens(unit, user.id, candidate => candidate.kind !== 'reset', { id, userId: user.id, email, kind: 'reset', expiresAt: Date.now() + RESET_TOKEN_MS });
      return user.id;
    });
  }
  confirmReset(id: string, salt: string, hash: string) {
    return this.write(async unit => {
      const item = await unit.get<EmailToken>(key.emailToken(id));
      const user = item && item.kind === 'reset' && item.expiresAt > Date.now() ? await this.user(unit, item.userId) : undefined;
      if (!user || user.email !== item!.email || user.machine) throw new ApiError(410, 'RESET_EXPIRED', 'This password reset link is invalid, expired, or already used.');
      user.salt = salt; user.hash = hash; user.emailVerified = true;
      await this.replaceChallenges(unit, user.id); await this.replaceEmailTokens(unit, user.id, () => false); await this.clearFailures(unit, user.id);
      return this.outbox(unit, user);
    });
  }
  cloudflareSigninState(operation: 'put' | 'consume', body: Record<string, unknown>) : never { throw new Error('This feature belongs to the hosted edition'); }
  cloudflareLookup(cloudflareId: string, email: string) {
    return this.read(async unit => {
      const linkedId = await unit.get<string>(key.cloudflare(cloudflareId)); const linked = linkedId ? await this.user(unit, linkedId) : undefined;
      const existing = await this.userByEmail(unit, email);
      return { linked: linked?.cloudflareId === cloudflareId && !linked.machine ? linked : undefined, existing: existing && !existing.machine ? existing : undefined };
    });
  }
  cloudflareLinkRequest(userId: string, link: CloudflareLink) {
    return this.write(async unit => {
      const user = await this.user(unit, userId);
      if (!user || user.cloudflareId || user.reviewer || !user.hash) throw new ApiError(409, 'CLOUDFLARE_IDENTITY_CONFLICT', 'This email belongs to a Gitflare account linked to a different Cloudflare login.');
      const previous = await unit.get<string>(key.linkEmail(user.email)); if (previous) unit.delete(key.link(previous));
      unit.put(key.link(link.id), { ...link, email: user.email }); unit.put(key.linkEmail(user.email), link.id);
    });
  }
  reviewerCreate(user: User) : never { throw new Error('This feature belongs to the hosted edition'); }
  reviewerUpdate(email: string, change: { salt: string; hash: string } | { disabled: true }) : never { throw new Error('This feature belongs to the hosted edition'); }
  machine(id: string) { return this.read(unit => unit.get<MachineRegistration>(key.machine(id))); }
  createMachine(user: User, registration: MachineRegistration) {
    return this.write(async unit => {
      const existing = await unit.get<MachineRegistration>(key.machine(registration.id));
      if (existing) return existing;
      await this.putUser(unit, user); await this.addHintTo(unit, user.id, registration.workspaceId);
      unit.put(key.machine(registration.id), registration); unit.put(key.machineClaim(registration.claimHash), registration.id);
      return null;
    });
  }
  claimMachine(claimHash: string, userId: string) : never { throw new Error('This feature belongs to the hosted edition'); }
  legacyWorkspace(workspaceId: string) {
    return this.read(async unit => {
      if (!await unit.get(key.legacyWorkspace(workspaceId))) return null;
      const legacy = await this.loadLegacy();
      return legacy ? legacySlice(legacy, workspaceId) : null;
    });
  }
  legacyImported(workspaceId: string) {
    return this.write(async unit => {
      const marker = await unit.get<{ done?: string }>(key.legacyWorkspace(workspaceId)); if (!marker || marker.done) return;
      unit.put(key.legacyWorkspace(workspaceId), { done: new Date().toISOString() });
      const migration = await unit.get<{ pending: number }>(key.migration);
      if (migration) unit.put(key.migration, { ...migration, pending: Math.max(0, migration.pending - 1) });
    });
  }
  migrationStatus() { return this.read(async unit => ({ marker: await unit.get<{ version: number; pending: number; workspaces: number }>(key.migration), workspaces: Object.fromEntries([...await unit.list<{ done?: string }>({ prefix: 'id:legacy-ws:' })].map(([id, value]) => [decodeURIComponent(id.slice('id:legacy-ws:'.length)), value.done ?? null])) })); }

  async pushLegacy(): Promise<void> {
    const status = await this.migrationStatus();
    const failures: unknown[] = [];
    for (const [workspaceId, done] of Object.entries(status.workspaces)) {
      if (done) continue;
      try { await this.shard(workspaceId).ensureImported(); await this.legacyImported(workspaceId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) { await this.schedule?.(); throw failures[0]; }
    this.legacy = undefined;
  }
  async processOutbox(fanOut: (entry: Outbox) => Promise<void>, minimumAge = OUTBOX_GRACE_MS): Promise<void> {
    const entries = await this.exclusive(() => this.records.list<Outbox>({ prefix: 'id:outbox:' }));
    let retry = false;
    for (const entry of entries.values()) {
      if (Date.now() - entry.at < minimumAge) { retry = true; continue; }
      await fanOut(entry); await this.finishOutbox(entry.id);
    }
    if (retry) await this.schedule?.();
  }
}

function splitIdentity(legacy: State, unit: Unit, now: number): string[] {
  const workspaces = new Set<string>(legacy.workspaces.map(workspace => workspace.id));
  for (const user of [...legacy.users].sort((a, b) => Number(!!b.machine) - Number(!!a.machine))) { unit.put(key.user(user.id), user); unit.put(key.email(user.email), user.id); if (user.cloudflareId) unit.put(key.cloudflare(user.cloudflareId), user.id); }
  const hints = new Map<string, string[]>();
  for (const member of legacy.members) { const list = hints.get(member.userId) ?? []; if (!list.includes(member.workspaceId)) list.push(member.workspaceId); hints.set(member.userId, list); workspaces.add(member.workspaceId); }
  for (const [userId, list] of hints) unit.put(key.hints(userId), list);
  for (const mfa of legacy.mfa) unit.put(key.mfa(mfa.id), mfa);
  const userChallenges = new Map<string, string[]>();
  for (const challenge of legacy.challenges) { unit.put(key.challenge(challenge.id), challenge); userChallenges.set(challenge.userId, [...userChallenges.get(challenge.userId) ?? [], challenge.id]); }
  for (const [userId, ids] of userChallenges) unit.put(key.userChallenges(userId), ids);
  const userTokens = new Map<string, string[]>();
  for (const item of legacy.emailTokens) { unit.put(key.emailToken(item.id), item); userTokens.set(item.userId, [...userTokens.get(item.userId) ?? [], item.id]); }
  for (const [userId, ids] of userTokens) unit.put(key.userEmailTokens(userId), ids);
  for (const [id, value] of Object.entries(legacy.loginFailures)) unit.put(key.failures(id), value);
  for (const [id, value] of Object.entries(legacy.limits)) unit.put(key.limit(id), value);
  for (const [id, value] of Object.entries(legacy.installations)) unit.put(key.installation(id), value);
  for (const machine of legacy.machines) { unit.put(key.machine(machine.id), machine); unit.put(key.machineClaim(machine.claimHash), machine.id); }
  for (const value of Object.values(legacy.cloudflareSignins)) unit.put(key.signin(value.id), value);
  for (const value of Object.values(legacy.cloudflareLinks)) { unit.put(key.link(value.id), value); unit.put(key.linkEmail(value.email), value.id); }
  for (const session of legacy.sessions) {
    workspaces.add(session.workspaceId);
    if (session.expiresAt <= now) continue;
    unit.put(key.route(session.hash), { workspaceId: session.workspaceId, expiresAt: session.expiresAt } satisfies IndexEntry);
    unit.put(key.sessionHome(session.id), { workspaceId: session.workspaceId, expiresAt: session.expiresAt } satisfies IndexEntry);
  }
  for (const credential of legacy.credentials) { workspaces.add(credential.workspaceId); if (credential.expiresAt > now) unit.put(key.route(credential.hash), { workspaceId: credential.workspaceId, expiresAt: credential.expiresAt } satisfies IndexEntry); }
  for (const invitation of legacy.invitations) { workspaces.add(invitation.workspaceId); unit.put(key.invite(invitation.hash), { workspaceId: invitation.workspaceId, expiresAt: invitation.expiresAt } satisfies IndexEntry); }
  for (const value of Object.values(legacy.cloudflareStates)) { workspaces.add(value.principal.workspaceId); unit.put(key.oauthState(value.id), { workspaceId: value.principal.workspaceId, expiresAt: value.expiresAt } satisfies IndexEntry); }
  for (const item of [...legacy.teams, ...legacy.grants, ...legacy.audit]) workspaces.add(item.workspaceId);
  for (const id of [...Object.keys(legacy.protections), ...Object.keys(legacy.cloudflareConnections)]) workspaces.add(id);
  for (const id of workspaces) unit.put(key.legacyWorkspace(id), {});
  return [...workspaces];
}

type ShardGroup = 'meta' | 'workspace' | 'member' | 'session' | 'team' | 'invitation' | 'grant' | 'credential' | 'protection' | 'approval' | 'connection' | 'cfstate' | 'project' | 'revision';
const SHARD_GROUPS: ShardGroup[] = ['meta', 'workspace', 'member', 'session', 'team', 'invitation', 'grant', 'credential', 'protection', 'approval', 'connection', 'cfstate', 'project', 'revision'];
interface ShardData { meta: Map<string, { workspaceId: string; source: string; version: number; at: string }>; workspace: Map<string, WorkspaceRecord>; member: Map<string, Member>; session: Map<string, Session>; team: Map<string, Team>; invitation: Map<string, Invitation>; grant: Map<string, Grant>; credential: Map<string, Credential>; protection: Map<string, Protection>; approval: Map<string, string[]>; connection: Map<string, CloudflareConnection>; cfstate: Map<string, CloudflareOAuthState>; project: Map<string, ProjectRecord>; revision: Map<string, number> }
function emptyShard(): ShardData { return Object.fromEntries(SHARD_GROUPS.map(group => [group, new Map()])) as unknown as ShardData; }
function connectionRepository(value: unknown): string | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) fail(); return value; }
function shardKey(group: ShardGroup, id: string): string { return `ws:${group}:${enc(id)}`; }
function auditKey(sequence: number): string { return `wa:${String(sequence).padStart(12, '0')}`; }
interface Context { session?: PublicSession | null; trusted?: Set<string> }
type Change = { audit: AuditInput[]; keys?: [ShardGroup, string][] };

export class WorkspaceStore {
  private data = emptyShard();
  private persisted = new Map<string, string>();
  private loaded?: Promise<void>;
  private exclusive = exclusiveQueue();
  private auditFirst = 1; private auditNext = 1; private lastPrune = 0;
  private hashes?: Map<string, ['session' | 'credential', string]>;
  private trusted = new Set<string>();
  constructor(private storage: Storage, readonly workspaceId: string, private options: SecurityOptions, private identity: () => Remote<IdentityStore>, private shard: (workspaceId: string) => Remote<WorkspaceStore>) {}

  private load(pull = true): Promise<void> { return this.loaded ??= this.initialize(pull).catch(error => { this.loaded = undefined; throw error; }); }
  private async initialize(pull: boolean) {
    const [records, first, last] = await this.storage.transaction(async txn => [await txn.list({ prefix: 'ws:' }), await txn.list({ prefix: 'wa:', limit: 1 }), await txn.list({ prefix: 'wa:', reverse: true, limit: 1 })] as const);
    this.data = emptyShard(); this.persisted = new Map(); this.hashes = undefined;
    for (const [id, value] of records) { const [, group, ...rest] = id.split(':'); (this.data[group as ShardGroup] as Map<string, unknown> | undefined)?.set(decodeURIComponent(rest.join(':')), value); this.persisted.set(id, JSON.stringify(value)); }
    const sequence = (map: Map<string, unknown>) => map.size ? Number([...map.keys()][0].slice(3)) : undefined;
    this.auditFirst = sequence(first) ?? 1; this.auditNext = (sequence(last) ?? 0) + 1;
    if (this.initialized || !pull) return;
    const slice = await this.identity().legacyWorkspace(this.workspaceId);
    if (slice) { await this.importSlice(slice, 'legacy'); await this.identity().legacyImported(this.workspaceId).catch(() => {}); }
    else if (this.workspaceId === 'legacy') await this.importSlice({ workspace: { id: 'legacy', name: 'Gitflare workspace' }, members: [], sessions: [], teams: [], invitations: [], grants: [], credentials: [], protection: null, approvals: {}, connection: null, cloudflareStates: [], projects: {}, audit: [] }, 'default');
  }
  private get initialized(): boolean { return this.data.meta.has('init'); }
  private record(): WorkspaceRecord | undefined { return this.data.workspace.get('record'); }
  private async importSlice(slice: LegacyWorkspaceSlice, source: string) {
    const data = emptyShard();
    data.meta.set('init', { workspaceId: this.workspaceId, source, version: MIGRATION_VERSION, at: new Date().toISOString() });
    if (slice.workspace) data.workspace.set('record', slice.workspace);
    for (const member of slice.members) data.member.set(member.userId, member);
    for (const [group, items] of [['session', slice.sessions], ['team', slice.teams], ['invitation', slice.invitations], ['grant', slice.grants], ['credential', slice.credentials], ['cfstate', slice.cloudflareStates]] as const) for (const item of items) (data[group] as Map<string, unknown>).set(item.id, item);
    if (slice.protection) data.protection.set('rule', slice.protection);
    if (slice.connection) data.connection.set('current', slice.connection);
    for (const [id, value] of Object.entries(slice.approvals)) data.approval.set(id, value);
    for (const [id, value] of Object.entries(slice.projects)) data.project.set(id, value);
    const audit = slice.audit.slice(-AUDIT_LIMIT_PER_WORKSPACE);
    const writes: Writes = new Map();
    for (const group of SHARD_GROUPS) for (const [id, value] of data[group] as Map<string, unknown>) writes.set(shardKey(group, id), value);
    audit.forEach((entry, index) => writes.set(auditKey(index + 1), { ...entry, sequence: index + 1 }));
    await this.storage.transaction(async txn => { for (const [id, value] of writes) await txn.put(id, value); });
    this.data = data; this.hashes = undefined;
    this.persisted = new Map([...writes].filter(([id]) => id.startsWith('ws:')).map(([id, value]) => [id, JSON.stringify(value)]));
    this.auditFirst = 1; this.auditNext = audit.length + 1;
  }
  private lookupHash(hash: string) {
    if (!this.hashes) { this.hashes = new Map(); for (const session of this.data.session.values()) this.hashes.set(session.hash, ['session', session.id]); for (const credential of this.data.credential.values()) this.hashes.set(credential.hash, ['credential', credential.id]); }
    return this.hashes.get(hash);
  }
  private async trustedUser(userId: string): Promise<boolean> {
    if (this.options.EDITION !== 'self-hosted' || this.trusted.has(userId)) return true;
    if (await this.identity().selfHostedAllowed(userId, this.workspaceId)) { this.trusted.add(userId); return true; }
    return false;
  }
  private async sessionHome(id: string): Promise<string | null> { return sessionIdHome(id) ?? (this.data.session.has(id) ? this.workspaceId : await this.identity().lookup('sessionHome', id)); }
  private async prepare(p: Principal | null | undefined): Promise<Context> {
    await this.load();
    const context: Context = {};
    if (!p) return context;
    if (p.sessionId && !this.data.session.has(p.sessionId)) { const home = await this.sessionHome(p.sessionId); context.session = home && home !== this.workspaceId ? await this.shard(home).sessionState(p.sessionId) : null; }
    if (!p.bootstrap) await this.trustedUser(p.userId);
    return context;
  }
  private session(id: string | undefined, context: Context): PublicSession | undefined { return id ? this.data.session.get(id) ?? context.session ?? undefined : undefined; }
  private validate(p: Principal, context: Context) {
    const now = Date.now();
    if (p.workspaceId !== this.workspaceId) fail();
    if (p.bootstrap) {
      if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED');
      if (p.sessionId) { const session = this.session(p.sessionId, context); if (!session || session.userId !== p.userId || !activeSession(session, now)) fail(); }
      if (p.workspaceId !== 'legacy' || this.record()?.bootstrapDisabled) fail();
      return;
    }
    if (this.options.EDITION === 'self-hosted' && !this.trusted.has(p.userId)) fail('MFA_REQUIRED');
    const member = this.data.member.get(p.userId); if (!member || member.role !== p.role) fail();
    if (p.sessionId) { const session = this.session(p.sessionId, context); if (!session || session.userId !== p.userId || !activeSession(session, now)) fail(); }
    if (p.credentialId) { const credential = this.data.credential.get(p.credentialId); if (!credential || credential.userId !== p.userId || credential.workspaceId !== p.workspaceId || credential.revoked || credential.expiresAt <= now) fail(); }
  }
  private teamIncludes(teamId: string, userId: string) { const team = this.data.team.get(teamId); return !!team && team.workspaceId === this.workspaceId && team.userIds.includes(userId); }
  private grantAllows(p: Principal, action: Action, resourceType: string, resourceId: string, missionId?: string) {
    for (const grant of this.data.grant.values()) if (grant.workspaceId === p.workspaceId && (grant.resourceType === resourceType && grant.resourceId === resourceId || grant.resourceType === 'stream' && grant.resourceId === missionId) && grant.actions.includes(action) && (grant.subjectType === 'user' ? grant.subjectId === p.userId : this.teamIncludes(grant.subjectId, p.userId))) return true;
    return false;
  }
  private roleAllows(p: Principal, action: Action, type: string, resourceId: string) { const member = this.data.member.get(p.userId); const scoped = !member?.repositoryIds || type === 'repository' && member.repositoryIds.includes(resourceId) || !['repository', 'stream'].includes(type); return !(action === 'execute' && this.record()?.agentPending) && scoped && ROLE_ACTIONS[p.role].includes(action) && (['workspace', 'repository', 'stream'].includes(type) || p.role === 'Owner' || p.role === 'Deployer' && type === 'environment' && action === 'deploy'); }
  private authorityAllows(p: Principal, action: Action, resourceType: string, resourceId: string, missionId?: string) { return this.roleAllows(p, action, resourceType, resourceId) || this.grantAllows(p, action, resourceType, resourceId, missionId); }
  private checkAllows(p: Principal, action: Action, resourceType: string, resourceId: string, missionId?: string): boolean {
    if (p.credentialId) { const c = this.data.credential.get(p.credentialId)!; return !(!this.authorityAllows(p, action, resourceType, resourceId, missionId) || !c.actions.includes(action) || resourceType !== 'repository' || c.scope !== 'workspace-read' && c.repositoryId !== resourceId || c.missionId && (missionId ? c.missionId !== missionId : action !== 'read')); }
    return this.authorityAllows(p, action, resourceType, resourceId, missionId);
  }
  private restore() {
    this.data = emptyShard(); this.hashes = undefined;
    for (const [id, serialized] of this.persisted) { const [, group, ...rest] = id.split(':'); (this.data[group as ShardGroup] as Map<string, unknown> | undefined)?.set(decodeURIComponent(rest.join(':')), JSON.parse(serialized)); }
  }
  private prune(now: number) {
    if (now - this.lastPrune < SWEEP_INTERVAL_MS) return;
    for (const [id, session] of this.data.session) if (session.expiresAt <= now) this.data.session.delete(id);
    for (const [id, invitation] of this.data.invitation) if (invitation.expiresAt + RETENTION_MS <= now) this.data.invitation.delete(id);
    for (const [id, credential] of this.data.credential) if (credential.expiresAt + RETENTION_MS <= now) this.data.credential.delete(id);
    for (const [id, value] of this.data.cfstate) if (value.expiresAt <= now) this.data.cfstate.delete(id);
  }
  private change<T>(task: (change: Change) => Promise<T> | T, options: { full?: boolean; requireInitialized?: boolean } = {}): Promise<T> {
    const full = options.full ?? true;
    return this.exclusive(async () => {
      await this.load();
      const change: Change = { audit: [], keys: full ? undefined : [] };
      const auditFirst = this.auditFirst; const auditNext = this.auditNext; const now = Date.now();
      try {
        if (full) this.prune(now);
        const result = await task(change);
        const writes: Writes = new Map();
        const serialize = (group: ShardGroup, id: string) => { const value = (this.data[group] as Map<string, unknown>).get(id); const name = shardKey(group, id); if (value === undefined) { if (this.persisted.has(name)) writes.set(name, GONE); return; } if (this.persisted.get(name) !== JSON.stringify(value)) writes.set(name, structuredClone(value)); };
        if (change.keys) for (const [group, id] of change.keys) serialize(group, id);
        else {
          const present = new Set<string>();
          for (const group of SHARD_GROUPS) for (const id of (this.data[group] as Map<string, unknown>).keys()) { present.add(shardKey(group, id)); serialize(group, id); }
          for (const name of this.persisted.keys()) if (!present.has(name)) writes.set(name, GONE);
        }
        if (change.audit.length && (this.initialized || options.requireInitialized === false)) {
          const timestamp = new Date().toISOString();
          for (const entry of change.audit) { const sequence = this.auditNext++; writes.set(auditKey(sequence), { id: crypto.randomUUID(), workspaceId: this.workspaceId, actorId: entry.actorId, action: entry.action, timestamp, ...(entry.resourceId !== undefined ? { resourceId: entry.resourceId } : {}), sequence } satisfies Audit); }
          while (this.auditNext - this.auditFirst > AUDIT_LIMIT_PER_WORKSPACE) writes.set(auditKey(this.auditFirst++), GONE);
        }
        if (writes.size) await this.storage.transaction(async txn => { for (const [id, value] of writes) { if (value === GONE) await txn.delete(id); else await txn.put(id, value); } });
        for (const [id, value] of writes) if (id.startsWith('ws:')) { if (value === GONE) this.persisted.delete(id); else this.persisted.set(id, JSON.stringify(value)); }
        if (full) { this.hashes = undefined; if (now - this.lastPrune >= SWEEP_INTERVAL_MS) this.lastPrune = now; }
        return structuredClone(result);
      } catch (error) {
        this.restore(); this.auditFirst = auditFirst; this.auditNext = auditNext;
        throw error;
      }
    });
  }

  private guarded<T>(task: () => T | Promise<T>): Promise<T> { return this.exclusive(async () => structuredClone(await task())); }
  async ensureImported(): Promise<boolean> { await this.load(); return this.initialized; }
  async authenticateToken(hash: string, target?: string): Promise<{ principal: Principal } | { session: { id: string; userId: string } }> {
    await this.load();
    return this.guarded(() => this.resolveToken(hash, target));
  }
  private async resolveToken(hash: string, target?: string): Promise<{ principal: Principal } | { session: { id: string; userId: string } }> {
    const now = Date.now(); const found = this.lookupHash(hash);
    const session = found?.[0] === 'session' ? this.data.session.get(found[1]) : undefined;
    if (session && activeSession(session, now)) {
      if (session.userId === 'bootstrap-owner') {
        if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED');
        if (target && target !== 'legacy' || this.workspaceId !== 'legacy' || this.record()?.bootstrapDisabled) fail();
        return { principal: { userId: 'bootstrap-owner', workspaceId: 'legacy', role: 'Owner', bootstrap: true, sessionId: session.id } };
      }
      if (!await this.trustedUser(session.userId)) fail('MFA_REQUIRED');
      if (target && target !== this.workspaceId) return { session: { id: session.id, userId: session.userId } };
      const member = this.data.member.get(session.userId); if (!member) fail();
      return { principal: { userId: member.userId, workspaceId: this.workspaceId, role: member.role, sessionId: session.id } };
    }
    const credential = found?.[0] === 'credential' ? this.data.credential.get(found[1]) : undefined;
    if (credential && !credential.revoked && credential.expiresAt > now) {
      if (!await this.trustedUser(credential.userId)) fail('MFA_REQUIRED');
      if (!target || target === credential.workspaceId) { const member = this.data.member.get(credential.userId); if (!member) fail(); return { principal: { userId: member.userId, workspaceId: this.workspaceId, role: member.role, credentialId: credential.id } }; }
    }
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Gitflare.');
  }
  async sessionPrincipal(userId: string, sessionId: string): Promise<Principal> {
    await this.load();
    if (!await this.trustedUser(userId)) fail('MFA_REQUIRED');
    return this.guarded(() => { const member = this.data.member.get(userId); if (!member) fail(); return { userId, workspaceId: this.workspaceId, role: member.role, sessionId }; });
  }
  async sessionState(id: string): Promise<PublicSession | null> { await this.load(); return this.guarded(() => { const session = this.data.session.get(id); return session ? publicValue(session) : null; }); }
  async isMember(userId: string): Promise<boolean> { await this.load(); return this.guarded(() => this.data.member.has(userId)); }
  async validatePrincipal(p: Principal, rules: { account?: boolean; owner?: boolean } = {}): Promise<void> {
    const context = await this.prepare(p);
    await this.guarded(() => {
      this.validate(p, context);
      if (rules.account && (p.bootstrap || p.credentialId)) fail();
      if (rules.owner && (p.credentialId || p.role !== 'Owner')) fail();
    });
  }
  async enrollmentAllowed(p: Principal): Promise<void> {
    const context = await this.prepare(p);
    await this.guarded(() => {
      this.validate(p, context); if (p.bootstrap || p.credentialId) fail();
      const session = this.session(p.sessionId, context);
      if (!session?.authenticatedAt || Date.now() - session.authenticatedAt > 300000) fail('RECENT_AUTH_REQUIRED', 'Sign in again before setting up an authenticator.');
    });
  }
  async authorize(p: Principal, action: Action, resourceType = 'workspace', resourceId = p.workspaceId, missionId?: string): Promise<void> {
    const context = await this.prepare(p);
    await this.change(change => {
      this.validate(p, context);
      if (p.credentialId) {
        const credential = this.data.credential.get(p.credentialId)!;
        if (!this.authorityAllows(p, action, resourceType, resourceId, missionId) || !credential.actions.includes(action) || resourceType !== 'repository' || credential.scope !== 'workspace-read' && credential.repositoryId !== resourceId || (credential.missionId && (missionId ? credential.missionId !== missionId : action !== 'read'))) fail();
        if (credential.requests >= credential.maxRequests || (action === 'execute' && credential.executions >= credential.maxExecutions)) fail('BUDGET_EXHAUSTED', 'This task credential has exhausted its execution budget.');
        credential.requests++; if (action === 'execute') credential.executions++;
        change.keys!.push(['credential', credential.id]);
      } else if (!this.authorityAllows(p, action, resourceType, resourceId, missionId)) fail();
      change.audit.push({ actorId: p.userId, action, resourceId });
    }, { full: false });
  }
  async authorizeMetadata(p: Principal): Promise<void> {
    const context = await this.prepare(p);
    await this.change(change => {
      this.validate(p, context);
      if (!p.credentialId) return;
      const credential = this.data.credential.get(p.credentialId)!;
      if (!credential.actions.includes('read') || !this.authorityAllows(p, 'read', credential.scope === 'workspace-read' ? 'workspace' : 'repository', credential.scope === 'workspace-read' ? p.workspaceId : credential.repositoryId, credential.missionId)) fail();
      if (credential.requests >= credential.maxRequests) fail('BUDGET_EXHAUSTED', 'This task credential has exhausted its request budget.');
      credential.requests++;
      change.keys!.push(['credential', credential.id]);
    }, { full: false });
  }
  async check(p: Principal, action: Action, resourceType = 'workspace', resourceId = p.workspaceId, missionId?: string): Promise<void> {
    const context = await this.prepare(p);
    await this.guarded(() => { this.validate(p, context); if (!this.checkAllows(p, action, resourceType, resourceId, missionId)) fail(); });
  }
  async checkMany(p: Principal, action: Action, resources: { resourceType: string; resourceId: string; missionId?: string }[]): Promise<boolean[]> {
    const context = await this.prepare(p);
    return this.guarded(() => { this.validate(p, context); return resources.map(r => this.checkAllows(p, action, r.resourceType, r.resourceId, r.missionId)); });
  }
  async workspace(p: Principal) { const context = await this.prepare(p); return this.guarded(() => { this.validate(p, context); const workspace = this.record(); if (!workspace) fail(); return { id: workspace.id, name: workspace.name }; }); }
  async snapshotPart(p: Principal) {
    const context = await this.prepare(p);
    return this.guarded(async () => {
      this.validate(p, context); if (p.credentialId) fail();
      const owner = p.role === 'Owner';
      const audit = owner ? [...(await this.storage.transaction(txn => txn.list<Audit>({ prefix: 'wa:', reverse: true, limit: 100 }))).values()] : [];
      return {
        workspace: this.record(), members: [...this.data.member.values()], teams: [...this.data.team.values()], invitations: owner ? [...this.data.invitation.values()].map(publicValue) : [], grants: owner ? [...this.data.grant.values()] : [],
        credentials: [...this.data.credential.values()].filter(c => owner || c.userId === p.userId).map(publicValue), protection: this.data.protection.get('rule') ?? { requiredApprovals: 1, requiredChecks: [], preventSelfApproval: false }, audit,
      };
    });
  }
  async membership(userId: string, bootstrap = false) {
    await this.load(); if (!this.initialized) return null;
    const now = Date.now();
    return this.guarded(() => ({ workspace: this.data.member.has(userId) || bootstrap && this.workspaceId === 'legacy' ? this.record() ?? null : null, sessions: [...this.data.session.values()].filter(s => s.userId === userId && s.expiresAt > now).map(publicValue) }));
  }
  async bootstrapAllowed(): Promise<Principal> { await this.load(); if (this.record()?.bootstrapDisabled) fail('BOOTSTRAP_DISABLED', 'The legacy owner key was retired by ownership transfer.'); return { userId: 'bootstrap-owner', workspaceId: 'legacy', role: 'Owner', bootstrap: true }; }
  async createSession(input: { userId: string; hash: string; expiresAt?: number; authenticatedAt?: number; revision?: number; bootstrap?: boolean }): Promise<PublicSession> {
    return this.change(() => {
      if (input.bootstrap) { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); if (this.workspaceId !== 'legacy' || this.record()?.bootstrapDisabled) fail(); }
      else {
        if (!this.data.member.has(input.userId)) fail();
        if (input.revision !== undefined && input.revision < (this.data.revision.get(input.userId) ?? 0)) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Gitflare.');
      }
      const now = Date.now();
      const session: Session = { id: `${this.workspaceId}.${crypto.randomUUID()}`, userId: input.userId, workspaceId: this.workspaceId, hash: input.hash, expiresAt: input.expiresAt ?? now + SESSION_MS, authenticatedAt: input.authenticatedAt ?? now };
      this.data.session.set(session.id, session);
      return publicValue(session);
    });
  }
  async clientSession(p: Principal, client: string, lifetimeMs: number, hash: string) {
    const context = await this.prepare(p);
    return this.change(change => {
      this.validate(p, context); if (p.credentialId || p.bootstrap) fail('ACCOUNT_REQUIRED');
      const authenticatedAt = this.session(p.sessionId, context)?.authenticatedAt; const now = Date.now();
      if (authenticatedAt === undefined || authenticatedAt > now || now - authenticatedAt >= MAX_DERIVED_SESSION_AGE_MS) fail('RECENT_AUTH_REQUIRED', 'Sign in again before connecting an AI client.');
      change.audit.push({ actorId: p.userId, action: 'access:client-connect' });
      const session: Session = { id: `${this.workspaceId}.${crypto.randomUUID()}`, userId: p.userId, workspaceId: this.workspaceId, hash, expiresAt: now + lifetimeMs, client: client.slice(0, 100) || 'AI client' };
      this.data.session.set(session.id, session);
      return publicValue(session);
    });
  }
  async revokeSession(id: string, userId: string): Promise<boolean> {
    await this.load(); const session = this.data.session.get(id); if (!session || session.userId !== userId) return false;
    return this.change(() => { const current = this.data.session.get(id); if (!current || current.userId !== userId) return false; current.revoked = true; return true; });
  }
  async revokeUserSessions(userId: string, revision: number): Promise<void> {
    await this.load(); if (!this.initialized) return;
    await this.change(() => { this.data.revision.set(userId, Math.max(revision, this.data.revision.get(userId) ?? 0)); for (const session of this.data.session.values()) if (session.userId === userId) session.revoked = true; });
  }
  async revokeUserCredentials(userId: string): Promise<void> {
    await this.load(); if (!this.initialized) return;
    await this.change(() => { for (const credential of this.data.credential.values()) if (credential.userId === userId) credential.revoked = true; });
  }
  async audit(entries: AuditInput[]): Promise<void> { await this.load(); if (this.initialized) await this.change(change => { change.audit.push(...entries); }, { full: false }); }
  async auditMember(userId: string, action: string): Promise<void> { await this.load(); if (this.initialized && this.data.member.has(userId)) await this.change(change => { change.audit.push({ actorId: userId, action }); }, { full: false }); }
  async initWorkspace(input: { record: WorkspaceRecord; members: Member[]; credentials?: Credential[]; connection?: CloudflareConnection; audit?: AuditInput[] }, idempotent = false): Promise<boolean> {
    await this.load(false);
    return this.change(change => {
      if (this.initialized) { if (idempotent && this.record()?.id === input.record.id && input.members.every(member => this.data.member.get(member.userId)?.role === member.role)) return false; fail(); }
      if (input.record.id !== this.workspaceId) fail();
      this.data.meta.set('init', { workspaceId: this.workspaceId, source: 'created', version: MIGRATION_VERSION, at: new Date().toISOString() });
      this.data.workspace.set('record', input.record);
      for (const member of input.members) this.data.member.set(member.userId, member);
      for (const credential of input.credentials ?? []) this.data.credential.set(credential.id, credential);
      if (input.connection) this.data.connection.set('current', input.connection);
      change.audit.push(...input.audit ?? []);
      return true;
    }, { requireInitialized: false });
  }
  async peekInvite(hash: string) {
    await this.load();
    return this.guarded(() => this.findInvite(hash));
  }
  private findInvite(hash: string) {
    const invite = [...this.data.invitation.values()].find(i => i.hash === hash && !i.accepted && i.expiresAt > Date.now());
    if (!invite) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.');
    return { email: invite.email, role: invite.role, workspaceId: invite.workspaceId };
  }
  async acceptInvite(hash: string, userId: string, email: string, mode: 'member' | 'new' | 'cloudflare'): Promise<boolean> {
    return this.change(change => {
      const invite = [...this.data.invitation.values()].find(i => i.hash === hash && !i.accepted && i.expiresAt > Date.now());
      if (!invite) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.');
      if (invite.email !== email) fail('INVITATION_IDENTITY', 'This invitation was issued for a different account email.');
      if (this.data.member.has(userId)) { if (mode === 'cloudflare') return false; throw new ApiError(409, 'ALREADY_MEMBER', 'You already belong to this workspace.'); }
      this.data.member.set(userId, { userId, workspaceId: this.workspaceId, role: invite.role }); invite.accepted = true;
      if (mode === 'cloudflare') change.audit.push({ actorId: userId, action: 'access:accept-invite' });
      return true;
    });
  }
  async addMember(p: Principal, userId: string, assignedRole: Role): Promise<void> {
    const context = await this.prepare(p);
    await this.change(change => {
      this.validate(p, context); if (p.credentialId || p.role !== 'Owner') fail();
      this.data.member.set(userId, { userId, workspaceId: this.workspaceId, role: assignedRole });
      change.audit.push({ actorId: p.userId, action: 'access:user-create', resourceId: userId });
    });
  }
  async claimAgent(userId: string): Promise<void> {
    await this.change(change => {
      const record = this.record(); if (!record) fail();
      if (this.data.member.has(userId)) return;
      this.data.member.set(userId, { userId, workspaceId: this.workspaceId, role: 'Owner' }); record.agentPending = false;
      change.audit.push({ actorId: userId, action: 'agent:claim' });
    });
  }
  async action(p: Principal, action: string, body: Record<string, unknown>, capability: { raw: string; hash: string }, context: { targetEmail?: string } = {}) {
    const prepared = await this.prepare(p);
    return this.change(change => {
      this.validate(p, prepared); if (p.credentialId) fail(); const workspaceId = p.workspaceId; const data = this.data; const { raw, hash } = capability;
      change.audit.push({ actorId: p.userId, action: `access:${action}` });
      if (action === 'session-create') {
        if (p.bootstrap) fail('ACCOUNT_REQUIRED');
        const authenticatedAt = this.session(p.sessionId, prepared)?.authenticatedAt;
        const now = Date.now();
        if (authenticatedAt === undefined || authenticatedAt > now || now - authenticatedAt >= MAX_DERIVED_SESSION_AGE_MS) fail('RECENT_AUTH_REQUIRED', 'Sign in again before creating another session.');
        const session: Session = { id: `${workspaceId}.${crypto.randomUUID()}`, userId: p.userId, workspaceId, hash, expiresAt: Math.min(now + SESSION_MS, authenticatedAt + MAX_DERIVED_SESSION_AGE_MS), authenticatedAt };
        data.session.set(session.id, session); return { token: raw, session: publicValue(session) };
      }
      if (action === 'session-revoke') { const session = data.session.get(String(body.id)); if (!session || session.userId !== p.userId) fail(); session.revoked = true; return { ok: true }; }
      if (p.role !== 'Owner') fail();
      const member = (userId: unknown) => { const found = typeof userId === 'string' ? data.member.get(userId) : undefined; if (!found) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Select an existing workspace member.'); return found; };
      if (action === 'invite-revoke') { const invitation = data.invitation.get(String(body.id)); if (!invitation || invitation.workspaceId !== workspaceId) fail(); invitation.accepted = true; return { ok: true }; }
      if (action === 'invite') { const invitation: Invitation = { id: crypto.randomUUID(), workspaceId, email: requireString(body.email, 'Email', 254).toLowerCase(), role: role(body.role), hash, expiresAt: Date.now() + 86400000 }; if (invitation.role === 'Owner') fail('TRANSFER_REQUIRED', 'Use ownership transfer to assign the Owner role.'); data.invitation.set(invitation.id, invitation); return { token: raw, invitation: publicValue(invitation) }; }
      if (action === 'membership') {
        const target = member(body.userId); if (target.role === 'Owner' || body.role === 'Owner') fail('TRANSFER_REQUIRED');
        if (body.role === null) {
          for (const invitation of data.invitation.values()) if (invitation.email === context.targetEmail) invitation.accepted = true;
          data.member.delete(target.userId);
          for (const c of data.credential.values()) if (c.userId === target.userId) c.revoked = true;
          for (const session of data.session.values()) if (session.userId === target.userId) session.revoked = true;
          for (const [id, g] of data.grant) if (g.subjectType === 'user' && g.subjectId === target.userId) data.grant.delete(id);
          for (const team of data.team.values()) team.userIds = team.userIds.filter(id => id !== target.userId);
        } else {
          if (body.role !== undefined) target.role = role(body.role);
          if (body.repositoryIds === null) delete target.repositoryIds;
          else if (body.repositoryIds !== undefined) { if (!Array.isArray(body.repositoryIds) || body.repositoryIds.length > 100 || body.repositoryIds.some(id => typeof id !== 'string' || id.length > 200)) throw new ApiError(400, 'INVALID_SCOPE', 'Provide a bounded list of repository IDs.'); target.repositoryIds = [...new Set(body.repositoryIds)] as string[]; }
        }
        return { ok: true };
      }
      if (action === 'transfer') { const authenticatedAt = this.session(p.sessionId, prepared)?.authenticatedAt; if ((!p.bootstrap || p.sessionId) && (authenticatedAt === undefined || Date.now() - authenticatedAt > 300000 || authenticatedAt > Date.now())) fail('RECENT_AUTH_REQUIRED', 'Sign in again before transferring workspace ownership.'); const target = member(body.userId); if (target.userId === p.userId) fail(); const previous = data.member.get(p.userId); if (previous) previous.role = 'Maintainer'; target.role = 'Owner'; delete target.repositoryIds; this.record()!.bootstrapDisabled = true; return { ok: true }; }
      if (action === 'team-create') { const team: Team = { id: crypto.randomUUID(), workspaceId, name: requireString(body.name, 'Team name', 100), userIds: [] }; data.team.set(team.id, team); return team; }
      if (action === 'team-member') { const team = data.team.get(String(body.teamId)); if (!team || team.workspaceId !== workspaceId) fail(); const target = member(body.userId); team.userIds = body.remove ? team.userIds.filter(id => id !== target.userId) : [...new Set([...team.userIds, target.userId])]; return team; }
      if (action === 'grant-revoke') { const grant = data.grant.get(String(body.id)); if (!grant || grant.workspaceId !== workspaceId) fail(); data.grant.delete(grant.id); return { ok: true }; }
      if (action === 'credential-revoke') { const credential = data.credential.get(String(body.id)); if (!credential || credential.workspaceId !== workspaceId) fail(); credential.revoked = true; return { ok: true }; }
      if (action === 'grant') { if (!['repository', 'stream', 'environment', 'secret', 'database'].includes(String(body.resourceType))) fail(); if (body.subjectType === 'user') member(body.subjectId); else if (body.subjectType !== 'team' || !this.data.team.has(String(body.subjectId))) fail(); const actions = validActions(body.actions); if (actions.includes('manage')) fail(); const grant: Grant = { id: crypto.randomUUID(), workspaceId, subjectType: body.subjectType as Grant['subjectType'], subjectId: String(body.subjectId), resourceType: String(body.resourceType), resourceId: requireString(body.resourceId, 'Resource', 200), actions }; data.grant.set(grant.id, grant); return grant; }
      if (action === 'credential-create') { const actions = validActions(body.actions); if (actions.some(a => !['read', 'contribute', 'execute'].includes(a))) fail(); const number = (name: string, max: number) => { const value = Number(body[name]); if (!Number.isInteger(value) || value < 1 || value > max) throw new ApiError(400, 'INVALID_BUDGET', 'Credential expiry and budgets must be positive bounded integers.'); return value; }; const credential: Credential = { id: crypto.randomUUID(), workspaceId, userId: p.userId, name: requireString(body.name, 'Credential name', 100), hash, repositoryId: requireString(body.repositoryId, 'Repository', 200), missionId: body.missionId === undefined ? undefined : requireString(body.missionId, 'Stream', 200), actions, expiresAt: Date.now() + number('expiresInSeconds', 86400) * 1000, maxRequests: number('maxRequests', 1000), maxExecutions: number('maxExecutions', 10), requests: 0, executions: 0 }; if (p.bootstrap) fail('ACCOUNT_REQUIRED', 'Create an account and join the legacy workspace before issuing task credentials.'); data.credential.set(credential.id, credential); return { token: raw, credential: publicValue(credential) }; }
      if (action === 'protection') { for (const id of [...data.approval.keys()]) if (id.startsWith(`${workspaceId}:`)) data.approval.delete(id); const count = Number(body.requiredApprovals); if (!Number.isInteger(count) || count < 1 || count > 10 || !Array.isArray(body.requiredChecks) || body.requiredChecks.length > 20 || typeof body.preventSelfApproval !== 'boolean') throw new ApiError(400, 'INVALID_PROTECTION', 'Provide valid protection requirements.'); const protection = { requiredApprovals: count, requiredChecks: body.requiredChecks.map(c => requireString(c, 'Check name', 100)), preventSelfApproval: body.preventSelfApproval }; data.protection.set('rule', protection); return protection; }
      throw new ApiError(404, 'NOT_FOUND', 'This access operation is unavailable.');
    });
  }
  async connectionStore(p: Principal | null, operation: 'get' | 'put' | 'delete' | 'state-put' | 'state-consume', body: Record<string, unknown> = {}): Promise<unknown> {
    await this.load();
    const repositoryId = connectionRepository(body.repositoryId);
    const slot = repositoryId ? `repository:${repositoryId}` : 'current';
    const pending = operation === 'state-consume' ? this.data.cfstate.get(String(body.id)) : undefined;
    const context = await this.prepare(pending?.principal ?? p);
    for (const issuer of [this.data.connection.get(slot)?.issuer, (body.value as Partial<CloudflareConnection> | undefined)?.issuer]) if (issuer && !issuer.bootstrap) await this.trustedUser(issuer.userId);
    const issuerContext: Context = {};
    return this.change(change => {
      if (operation === 'state-consume') {
        const value = this.data.cfstate.get(String(body.id));
        if (!value || value.browserHash !== body.browserHash || value.expiresAt <= Date.now()) throw new ApiError(400, 'CLOUDFLARE_STATE_INVALID', 'The connection request has expired. Start again.');
        this.validate(value.principal, context);
        if (value.principal.role !== 'Owner' || !value.principal.sessionId || value.principal.credentialId) fail();
        if (value.repositoryId !== undefined && (connectionRepository(value.repositoryId) !== value.repositoryId || !this.authorityAllows(value.principal, 'read', 'repository', value.repositoryId))) fail();
        this.data.cfstate.delete(value.id);
        return value;
      }
      if (!p) fail();
      this.validate(p, context);
      if (p.credentialId) fail();
      if (repositoryId && !this.authorityAllows(p, 'read', 'repository', repositoryId)) fail();
      if (operation === 'get') {
        const authorization = body.authorization as { action: Action; resourceType: string; resourceId: string } | undefined;
        if (p.role !== 'Owner' && (!authorization || !this.authorityAllows(p, authorization.action, authorization.resourceType, authorization.resourceId))) fail();
        const connection = this.data.connection.get(slot) ?? null;
        if (connection?.issuer) this.validate({ ...connection.issuer, sessionId: undefined }, issuerContext);
        return connection;
      }
      if (p.role !== 'Owner') fail();
      if (operation === 'state-put') {
        const value = body.value as CloudflareOAuthState;
        if (!p.sessionId || value.principal.userId !== p.userId || value.principal.workspaceId !== p.workspaceId || value.principal.sessionId !== p.sessionId || value.principal.role !== 'Owner' || value.principal.credentialId || value.expiresAt > Date.now() + 600000 || value.expiresAt <= Date.now() || (value.repositoryId ?? undefined) !== repositoryId) fail();
        this.data.cfstate.set(value.id, value);
        return { ok: true };
      }
      const existing = this.data.connection.get(slot) ?? null;
      if (operation === 'put') {
        if ((existing?.version ?? null) !== body.expectedVersion) throw new ApiError(409, 'CLOUDFLARE_CONNECTION_CHANGED', 'The Cloudflare connection changed. Refresh and try again.');
        const value = body.value as CloudflareConnection;
        if (value.issuer?.workspaceId !== p.workspaceId || value.issuer.role !== 'Owner' || value.issuer.credentialId) fail();
        this.validate({ ...value.issuer, sessionId: undefined }, issuerContext);
        this.data.connection.set(slot, value);
      } else if (operation === 'delete') {
        this.data.connection.delete(slot);
        for (const [id, value] of this.data.cfstate) if (value.principal.workspaceId === p.workspaceId && value.repositoryId === repositoryId) this.data.cfstate.delete(id);
      }
      change.audit.push({ actorId: p.userId, action: `cloudflare:${operation}`, ...(repositoryId ? { resourceId: repositoryId } : {}) });
      return operation === 'delete' ? existing : { ok: true };
    });
  }
  async projectStore(p: Principal, repositoryId: string, operation: 'get' | 'set' | 'plan' | 'consume' | 'finish', body: Record<string, unknown> = {}): Promise<unknown> {
    const context = await this.prepare(p);
    return this.change(change => {
      this.validate(p, context);
      if (p.credentialId || !this.authorityAllows(p, 'read', 'repository', repositoryId)) fail();
      const current = this.data.project.get(repositoryId) ?? { mapping: null, plans: [] };
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
          if (!this.authorityAllows(p, 'migrate', 'database', plan.databaseId)) fail();
          if (current.plans.some(item => item.id === plan.id || item.checksum === plan.checksum && item.databaseId === plan.databaseId && ['pending', 'executing', 'succeeded', 'unknown'].includes(item.status))) throw new ApiError(409, 'MIGRATION_EXISTS', 'This migration already has a plan or recorded execution.');
          if (current.plans.length >= 500) throw new ApiError(409, 'MIGRATION_HISTORY_LIMIT', 'This project has reached its migration history limit.');
          current.plans.push(plan);
        } else {
          const plan = current.plans.find(item => item.id === body.planId);
          if (!plan) throw new ApiError(404, 'MIGRATION_NOT_FOUND', 'This migration plan could not be found.');
          if (!this.authorityAllows(p, 'migrate', 'database', plan.databaseId)) fail();
          if (operation === 'consume') {
            if (plan.status !== 'pending' || plan.checksum !== body.checksum || plan.mappingVersion !== mapping.version || plan.accountId !== mapping.accountId || !databases.some(resource => resource.id === plan.databaseId)) throw new ApiError(409, 'MIGRATION_STALE', 'This migration has changed or already started. Create a new plan.');
            plan.status = 'executing';
          } else {
            if (plan.status !== 'executing' || !['succeeded', 'failed', 'unknown'].includes(String(body.status))) throw new ApiError(409, 'MIGRATION_STATE_INVALID', 'This migration cannot change state.');
            plan.status = body.status as MigrationPlan['status'];
            if (typeof body.error === 'string') plan.error = body.error.slice(0, 500);
          }
        }
      }
      this.data.project.set(repositoryId, current);
      change.audit.push({ actorId: p.userId, action: `cloudflare:project:${operation}`, resourceId: repositoryId });
      if (operation === 'consume') return current.plans.find(item => item.id === body.planId);
      return current;
    });
  }
  async clearApprovals(p: Principal, missionId: string) {
    const context = await this.prepare(p);
    await this.change(() => { this.validate(p, context); for (const id of [...this.data.approval.keys()]) if (id.startsWith(`${p.workspaceId}:${missionId}:`)) this.data.approval.delete(id); });
  }
  async recordApproval(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, checks: { name: string; status: string; candidateSha?: string }[], creatorId?: string, rule?: ReviewRule) {
    const context = await this.prepare(p);
    return this.change(change => {
      this.validate(p, context); if (p.credentialId) fail();
      const protection = rule ? { requiredApprovals: rule.requiredApprovals, requiredChecks: rule.requiredCheckNames, preventSelfApproval: rule.preventSelfApproval } : this.data.protection.get('rule') ?? { requiredApprovals: 1, requiredChecks: [], preventSelfApproval: false };
      if (protection.preventSelfApproval && (!creatorId || creatorId === p.userId)) fail('SELF_APPROVAL', 'A different member must review this Stream.');
      if (protection.requiredChecks.some(name => !checks.some(check => check.name === name && check.status === 'passed' && check.candidateSha === candidateSha))) throw new ApiError(409, 'CHECKS_REQUIRED', 'Required checks have not passed for this revision.');
      const id = `${p.workspaceId}:${missionId}:${candidateSha}:${baseSha}:${epoch}`; const reviewers = [...new Set([...(this.data.approval.get(id) ?? []), p.userId])];
      this.data.approval.set(id, reviewers); change.keys = [['approval', id]];
      return { approvals: reviewers.length, requiredApprovals: protection.requiredApprovals, ready: reviewers.length >= protection.requiredApprovals };
    }, { full: false });
  }
  async assertLand(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, repositoryId?: string, rule?: ReviewRule) {
    const context = await this.prepare(p);
    await this.guarded(() => this.landable(p, context, missionId, candidateSha, baseSha, epoch, repositoryId, rule));
  }
  private landable(p: Principal, context: Context, missionId: string, candidateSha: string, baseSha: string, epoch: number, repositoryId?: string, rule?: ReviewRule) {
    this.validate(p, context);
    if (rule?.restrictLanders.length && !rule.restrictLanders.includes(p.role)) fail('LANDER_RESTRICTED', `Branch protection allows only ${rule.restrictLanders.join(' or ')} members to land this change.`);
    const required = rule ? rule.requiredApprovals : this.data.protection.get('rule')?.requiredApprovals ?? 1;
    const reviewers = this.data.approval.get(`${p.workspaceId}:${missionId}:${candidateSha}:${baseSha}:${epoch}`) ?? [];
    const valid = reviewers.filter(id => {
      if (id === 'bootstrap-owner') return !this.record()?.bootstrapDisabled;
      const member = this.data.member.get(id);
      if (!member) return false;
      if (ROLE_ACTIONS[member.role].includes('review') && (!member.repositoryIds || !!repositoryId && member.repositoryIds.includes(repositoryId))) return true;
      return [...this.data.grant.values()].some(g => g.workspaceId === p.workspaceId && g.actions.includes('review') && (g.resourceType === 'stream' && g.resourceId === missionId || g.resourceType === 'repository' && g.resourceId === repositoryId) && (g.subjectType === 'user' ? g.subjectId === id : this.teamIncludes(g.subjectId, id)));
    });
    if (valid.length < required) fail('APPROVALS_REQUIRED', 'This revision needs additional current approvals.');
  }
}
function validActions(value: unknown): Action[] { if (!Array.isArray(value) || !value.length || value.some(v => !ROLE_ACTIONS.Owner.includes(v))) throw new ApiError(400, 'INVALID_ACTIONS', 'Select valid resource actions.'); return [...new Set(value)] as Action[]; }

type Remote<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
export interface SecurityPeer { identityCall(op: string, args: unknown[]): Promise<unknown>; shardCall(workspaceId: string, op: string, args: unknown[]): Promise<unknown> }
const IDENTITY_OPS = new Set(['rateLimit', 'users', 'account', 'accountByEmail', 'hints', 'addHint', 'removeHint', 'mfaEnabled', 'installationWorkspace', 'selfHostedAllowed', 'lookup', 'index', 'loginAttempt', 'loginFinish', 'applyLink', 'beginMfa', 'challenge', 'verifyChallenge', 'finishOutbox', 'revokeAccount', 'startSetup', 'createUser', 'deleteUser', 'verifyEmail', 'resendVerification', 'requestReset', 'confirmReset', 'cloudflareSigninState', 'cloudflareLookup', 'cloudflareLinkRequest', 'reviewerCreate', 'reviewerUpdate', 'machine', 'createMachine', 'claimMachine', 'legacyWorkspace', 'legacyImported', 'migrationStatus']);
const SHARD_OPS = new Set(['ensureImported', 'authenticateToken', 'sessionPrincipal', 'sessionState', 'isMember', 'validatePrincipal', 'enrollmentAllowed', 'authorize', 'authorizeMetadata', 'check', 'checkMany', 'workspace', 'snapshotPart', 'membership', 'bootstrapAllowed', 'createSession', 'clientSession', 'revokeSession', 'revokeUserSessions', 'revokeUserCredentials', 'audit', 'auditMember', 'initWorkspace', 'peekInvite', 'acceptInvite', 'addMember', 'claimAgent', 'action', 'connectionStore', 'projectStore', 'clearApprovals', 'recordApproval', 'assertLand']);
function remote<T>(call: (op: string, args: unknown[]) => Promise<unknown>, inDurableObject: boolean): Remote<T> {
  return new Proxy({}, {
    get: (_target, op) => typeof op !== 'string' || op === 'then' ? undefined : async (...args: unknown[]) => {
      try { return await call(op, args); }
      catch (error) { if (inDurableObject && missingRpcMethod(error)) throw new ApiError(503, 'SECURITY_DEPLOYMENT_PENDING', 'Access services are updating. Wait briefly and try again.'); throw error; }
    },
  }) as Remote<T>;
}

export class SecurityService {
  private identityStore?: IdentityStore;
  private shardStore?: WorkspaceStore;
  private role?: 'identity' | 'shard';
  constructor(private storage: Storage | undefined, private options: SecurityOptions = {}, private resolve: (name: string) => SecurityPeer = () => { throw new Error('Security peers are not configured'); }, private schedule?: () => Promise<void>) {}
  private identity(): Remote<IdentityStore> {
    if (this.storage && this.role !== 'shard') return (this.identityStore ??= new IdentityStore(this.storage, this.options, workspaceId => this.shard(workspaceId), this.schedule)) as unknown as Remote<IdentityStore>;
    return remote<IdentityStore>((op, args) => this.resolve('security').identityCall(op, args), false);
  }
  private shard(workspaceId: string): Remote<WorkspaceStore> { return remote<WorkspaceStore>((op, args) => this.resolve(shardName(workspaceId)).shardCall(workspaceId, op, args), !!this.storage); }
  identityCall(op: string, args: unknown[]): Promise<unknown> {
    if (!this.storage || this.role === 'shard' || !IDENTITY_OPS.has(op)) throw new ApiError(404, 'NOT_FOUND', 'This access operation is unavailable.');
    this.role = 'identity';
    const store = this.identity() as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
    return store[op](...structuredClone(args));
  }
  shardCall(workspaceId: string, op: string, args: unknown[]): Promise<unknown> {
    if (!this.storage || this.role === 'identity' || this.identityStore || !SHARD_OPS.has(op)) throw new ApiError(404, 'NOT_FOUND', 'This access operation is unavailable.');
    this.role = 'shard';
    this.shardStore ??= new WorkspaceStore(this.storage, workspaceId, this.options, () => this.identity(), id => this.shard(id));
    if (this.shardStore.workspaceId !== workspaceId) fail();
    return (this.shardStore as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[op](...structuredClone(args));
  }
  async alarm(): Promise<void> {
    if (!this.storage || this.role === 'shard') return;
    const identity = this.identity() as unknown as IdentityStore;
    const results = await Promise.allSettled([identity.pushLegacy(), identity.processOutbox(entry => this.fanOut(entry))]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  migrationStatus() { return this.identity().migrationStatus(); }
  private async fanOut(entry: Outbox) { await Promise.all(entry.workspaces.map(workspaceId => this.shard(workspaceId).revokeUserSessions(entry.userId, entry.revision))); }
  private async revokeEverywhere(entry: Outbox | null | undefined) { if (!entry) return; await this.fanOut(entry); await this.identity().finishOutbox(entry.id); }
  private async auditAccount(userId: string, action: string, workspaces?: string[]) { await Promise.allSettled((workspaces ?? await this.identity().hints(userId)).map(workspaceId => this.shard(workspaceId).auditMember(userId, action))); }
  private async firstMembership(userId: string): Promise<string | undefined> {
    for (const workspaceId of await this.identity().hints(userId)) if (await this.shard(workspaceId).isMember(userId)) return workspaceId;
    return undefined;
  }
  private async sessionHome(id: string): Promise<string | null> { return sessionIdHome(id) ?? await this.identity().lookup('sessionHome', id); }
  private async issueSession(user: User, workspaceId: string, revision?: number, extra: Partial<{ expiresAt: number; authenticatedAt: number }> = {}) {
    const value = mintToken(workspaceId);
    await this.shard(workspaceId).createSession({ userId: user.id, hash: await hashToken(value), revision, ...extra });
    return { token: value, user: safeUser(user), workspaceId };
  }

  async connectionStore(p: Principal | null, operation: 'get' | 'put' | 'delete' | 'state-put' | 'state-consume', body: Record<string, unknown> = {}): Promise<unknown> {
    if (operation === 'state-consume') {
      const workspaceId = await this.identity().lookup('oauthState', String(body.id));
      if (!workspaceId) throw new ApiError(400, 'CLOUDFLARE_STATE_INVALID', 'The connection request has expired. Start again.');
      const value = await this.shard(workspaceId).connectionStore(null, operation, body);
      await this.identity().index('oauthState', String(body.id), null).catch(() => {});
      return value;
    }
    if (!p) fail();
    if (operation === 'state-put') {
      const value = body.value as CloudflareOAuthState;
      const result = await this.shard(p.workspaceId).connectionStore(p, operation, body);
      await this.identity().index('oauthState', value.id, { workspaceId: p.workspaceId, expiresAt: value.expiresAt });
      return result;
    }
    return this.shard(p.workspaceId).connectionStore(p, operation, body);
  }
  projectStore(p: Principal, repositoryId: string, operation: 'get' | 'set' | 'plan' | 'consume' | 'finish', body: Record<string, unknown> = {}): Promise<unknown> { return this.shard(p.workspaceId).projectStore(p, repositoryId, operation, body); }
  async rateLimit(key: string, max = 15, windowMs = 900000): Promise<void> {
    if (!await this.identity().rateLimit(key, max, windowMs)) throw new ApiError(429, 'RATE_LIMITED', 'Too many authentication attempts. Try again in 15 minutes.');
  }
  async signup(body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async login(body: Record<string, unknown>, client = 'unknown', linkToken?: string) {
    const email = requireString(body.email, 'Email', 254).toLowerCase(); const password = requireString(body.password, 'Password', 256);
    const linkId = linkToken && /^[a-f0-9]{64}$/.test(linkToken) ? await hashToken(linkToken) : undefined;
    const found = await this.identity().accountByEmail(email);
    const hash = await passwordHash(password, found?.salt ?? 'invalid-account-salt');
    // A locked account must be indistinguishable from a wrong password
    const attempt = await this.identity().loginAttempt({ userId: found?.id, email, salt: found?.salt, hash, client });
    if (attempt.locked && found) await this.auditAccount(found.id, 'account:login-locked');
    const user = attempt.user;
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'The email or password was not accepted.');
    if (attempt.mfaEnabled || this.options.EDITION === 'self-hosted') return this.beginMfa(user.id, undefined, { user }, linkId);
    const workspaceId = await this.firstMembership(user.id);
    if (!workspaceId) fail();
    const value = mintToken(workspaceId); const sessionHash = await hashToken(value);
    const current = await this.identity().loginFinish(user);
    await this.shard(workspaceId).createSession({ userId: current.id, hash: sessionHash, revision: current.revision ?? 0 });
    const linked = linkId ? await this.identity().applyLink(current.id, linkId) : null;
    if (linked) await this.auditAccount(current.id, 'account:cloudflare-linked');
    return { token: value, user: safeUser(linked ?? current), workspaceId, ...(linked ? { cloudflareLinked: true } : {}) };
  }
  async reviewerAccount(operation: ReviewerOperation, body: Record<string, unknown>): Promise<ReviewerAccountResult> { throw new Error('This feature belongs to the hosted edition'); }
  async legacySession() {
    if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED');
    const value = mintToken('legacy');
    await this.shard('legacy').createSession({ userId: 'bootstrap-owner', hash: await hashToken(value), bootstrap: true });
    return value;
  }
  async bootstrap(): Promise<Principal> { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); return this.shard('legacy').bootstrapAllowed(); }
  async authenticate(value: string, workspaceId?: string): Promise<Principal> {
    const hash = await hashToken(value);
    const home = tokenHome(value) ?? await this.identity().lookup('route', hash);
    if (!home) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Gitflare.');
    const result = await this.shard(home).authenticateToken(hash, workspaceId);
    if ('principal' in result) return result.principal;
    return this.shard(workspaceId!).sessionPrincipal(result.session.userId, result.session.id);
  }
  authorize(principal: Principal, action: Action, resourceType = 'workspace', resourceId = principal.workspaceId, missionId?: string): Promise<void> { return this.shard(principal.workspaceId).authorize(principal, action, resourceType, resourceId, missionId); }
  authorizeMetadata(p: Principal): Promise<void> { return this.shard(p.workspaceId).authorizeMetadata(p); }
  check(p: Principal, action: Action, resourceType = 'workspace', resourceId = p.workspaceId, missionId?: string): Promise<void> { return this.shard(p.workspaceId).check(p, action, resourceType, resourceId, missionId); }
  checkMany(p: Principal, action: Action, resources: { resourceType: string; resourceId: string; missionId?: string }[]): Promise<boolean[]> { return this.shard(p.workspaceId).checkMany(p, action, resources); }
  workspace(p: Principal) { return this.shard(p.workspaceId).workspace(p); }
  async snapshot(p: Principal) {
    const part = await this.shard(p.workspaceId).snapshotPart(p);
    const ids = [...new Set([p.userId, ...part.members.map(m => m.userId)])];
    const [users, hints] = await Promise.all([this.identity().users(ids), p.bootstrap ? Promise.resolve([] as string[]) : this.identity().hints(p.userId)]);
    const workspaceIds = p.bootstrap ? ['legacy'] : [...new Set([...hints, p.workspaceId])];
    const memberships = (await Promise.all(workspaceIds.map(id => this.shard(id).membership(p.userId, !!p.bootstrap).catch(() => null)))).filter((item): item is NonNullable<typeof item> => !!item);
    return {
      user: users[p.userId] ?? { id: p.userId, name: 'Legacy owner', emailVerified: false }, workspace: part.workspace, role: p.role, permissions: ROLE_ACTIONS[p.role],
      members: part.members.map(m => ({ ...m, user: users[m.userId] ?? null })), teams: part.teams, invitations: part.invitations, grants: part.grants, credentials: part.credentials,
      sessions: memberships.flatMap(item => item.sessions), protection: part.protection, audit: part.audit,
      workspaces: memberships.flatMap(item => item.workspace ? [item.workspace] : []),
    };
  }
  async action(p: Principal, action: string, body: Record<string, unknown>) {
    if (action === 'user-create') return this.createInstallationUser(p, body);
    if (action === 'agent-claim') return this.claimMachine(p, body);
    if (action === 'mfa-enroll') return this.enrollMfa(p);
    const raw = action === 'session-create' || action === 'credential-create' ? mintToken(p.workspaceId) : token(); const hash = await hashToken(raw);
    if (action === 'session-revoke') {
      const id = String(body.id); const home = await this.sessionHome(id);
      if (!home || home === p.workspaceId) return this.shard(p.workspaceId).action(p, action, body, { raw, hash });
      await this.shard(p.workspaceId).validatePrincipal(p);
      if (p.credentialId || !await this.shard(home).revokeSession(id, p.userId)) fail();
      await this.shard(p.workspaceId).audit([{ actorId: p.userId, action: `access:${action}` }]);
      return { ok: true };
    }
    if (action === 'membership' && body.role === null) {
      const targetId = typeof body.userId === 'string' ? body.userId : '';
      const target = targetId ? await this.identity().account(targetId) : undefined;
      const result = await this.shard(p.workspaceId).action(p, action, body, { raw, hash }, { targetEmail: target?.email });
      await this.revokeEverywhere(await this.identity().revokeAccount(targetId, [p.workspaceId]));
      await this.identity().removeHint(targetId, p.workspaceId);
      return result;
    }
    const result = await this.shard(p.workspaceId).action(p, action, body, { raw, hash });
    if (action === 'invite') { const invitation = (result as { invitation: Omit<Invitation, 'hash'> }).invitation; await this.identity().index('invite', hash, { workspaceId: p.workspaceId, expiresAt: invitation.expiresAt }); }
    return result;
  }
  async authConfig() {
    const installed = this.options.EDITION === 'self-hosted' ? !!await this.identity().installationWorkspace() : true;
    return { edition: this.options.EDITION ?? 'hosted', setupRequired: this.options.EDITION === 'self-hosted' && !installed, publicSignup: this.options.EDITION !== 'self-hosted', mfaRequired: this.options.EDITION === 'self-hosted', ...(this.options.EDITION === 'self-hosted' ? { setupMode: this.setupMode() } : {}) };
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
    await this.identity().startSetup({ pendingUser: { id: userId, name: input.name, email: input.email, salt, hash }, challengeHash, workspaceName, encryptedSecret, expiresAt, pendingWorkspaceId: crypto.randomUUID() });
    return { mfaRequired: true, enrollmentRequired: true, challengeId, secret, otpauthUri: authenticatorUri(secret, input.email), expiresAt };
  }
  private async beginMfa(userId: string, workspaceId?: string, authentication?: { user?: User; principal?: Principal }, linkId?: string): Promise<MfaChallengeResult> {
    const challengeId = token(); const challengeHash = await hashToken(challengeId); const expiresAt = Date.now() + 300000;
    const secret = mfaSecret(); const encryptedSecret = await encryptAuth(secret, this.options.AUTH_ENCRYPTION_KEY, `mfa:${userId}`);
    let expectedRevision: number | undefined;
    if (authentication?.principal) { expectedRevision = (await this.identity().account(userId))?.revision ?? 0; await this.shard(authentication.principal.workspaceId).validatePrincipal(authentication.principal); }
    const memberWorkspaceId = workspaceId ? (await this.shard(workspaceId).isMember(userId) ? workspaceId : undefined) : await this.firstMembership(userId);
    const result = await this.identity().beginMfa({ userId, memberWorkspaceId, authUser: authentication?.user, expectedRevision, challengeHash, encryptedSecret, expiresAt, linkId });
    return { mfaRequired: true, enrollmentRequired: result.enrollmentRequired, challengeId, expiresAt, ...(result.enrollmentRequired ? { secret, otpauthUri: authenticatorUri(secret, result.email) } : {}) };
  }
  async enrollMfa(p: Principal): Promise<MfaChallengeResult> {
    await this.shard(p.workspaceId).enrollmentAllowed(p);
    if ((await this.identity().account(p.userId))?.reviewer) fail('REVIEWER_ACCOUNT', 'This shared reviewer account cannot enroll an authenticator.');
    if (await this.identity().mfaEnabled(p.userId)) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'This account already has an authenticator.');
    return this.beginMfa(p.userId, p.workspaceId, { principal: p });
  }
  async verifyMfa(body: Record<string, unknown>, setupOnly = false) {
    const challengeId = requireString(body.challengeId, 'Authentication challenge', 128); const id = await hashToken(challengeId);
    await this.rateLimit(`mfa:${id}`, 5, 300000);
    const pending = await this.identity().challenge(id);
    if (pending) await this.rateLimit(`mfa-user:${pending.userId}`, 10, 300000);
    const code = body.code === undefined ? undefined : requireString(body.code, 'Authenticator code', 6, 6);
    const recoveryHash = body.recoveryCode === undefined ? undefined : await hashToken(requireString(body.recoveryCode, 'Recovery code', 64));
    const recoveryCodes = Array.from({ length: 10 }, () => randomCapability(8)); const recoveryHashes = await Promise.all(recoveryCodes.map(hashToken));
    if (pending?.setup) await this.shard(pending.setup.workspaceId).initWorkspace({ record: { id: pending.setup.workspaceId, name: pending.setup.workspaceName, bootstrapDisabled: true }, members: [{ userId: pending.setup.userId, workspaceId: pending.setup.workspaceId, role: 'Owner' }] }, true);
    const verified = await this.identity().verifyChallenge({ id, setupOnly, code, recoveryHash, recoveryHashes });
    if (verified.kind === 'setup' && !pending?.setup) await this.shard(verified.workspaceId!).initWorkspace({ record: { id: verified.workspaceId!, name: 'Gitflare workspace', bootstrapDisabled: true }, members: [{ userId: verified.user.id, workspaceId: verified.workspaceId!, role: 'Owner' }] }, true);
    const user = verified.user;
    const workspaceId = verified.workspaceId ?? await this.firstMembership(user.id);
    if (!workspaceId || !await this.shard(workspaceId).isMember(user.id)) fail();
    await this.revokeEverywhere(verified.outbox);
    const linked = verified.kind !== 'setup' && verified.linkId ? await this.identity().applyLink(user.id, verified.linkId) : null;
    const session = await this.issueSession(linked ?? user, workspaceId, verified.revision);
    if (linked) await this.auditAccount(user.id, 'account:cloudflare-linked');
    return { ...session, ...(verified.enrolling ? { recoveryCodes } : {}), ...(linked ? { cloudflareLinked: true } : {}) };
  }
  async createInstallationUser(p: Principal, body: Record<string, unknown>) {
    if (this.options.EDITION !== 'self-hosted') fail('SELF_HOSTED_ONLY');
    const input = this.accountInput(body); const assignedRole = role(body.role); if (assignedRole === 'Owner') fail('TRANSFER_REQUIRED');
    const salt = token(); const hash = await passwordHash(input.password, salt);
    await this.shard(p.workspaceId).validatePrincipal(p, { owner: true });
    if (await this.identity().installationWorkspace() !== p.workspaceId) fail();
    const user: User = { id: crypto.randomUUID(), name: input.name, email: input.email, salt, hash };
    if (!await this.identity().createUser({ user, workspaceId: p.workspaceId })) throw new ApiError(409, 'ACCOUNT_EXISTS', 'This email is already registered.');
    try { await this.shard(p.workspaceId).addMember(p, user.id, assignedRole); }
    catch (error) { await this.identity().deleteUser(user.id); throw error; }
    return { user: safeUser(user), workspaceId: p.workspaceId, role: assignedRole, enrollmentRequired: true };
  }
  async registerInvitedUser(body: Record<string, unknown>) {
    const input = this.accountInput(body); const invitationHash = await hashToken(requireString(body.token, 'Invitation token', 128));
    const userId = crypto.randomUUID(); const salt = token(); const hash = await passwordHash(input.password, salt);
    const verificationToken = token(); const verificationHash = await hashToken(verificationToken);
    const expired = () => new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.');
    const workspaceId = await this.identity().lookup('invite', invitationHash);
    if (!workspaceId) throw expired();
    const invite = await this.shard(workspaceId).peekInvite(invitationHash);
    if (this.options.EDITION === 'self-hosted' && invite.workspaceId !== await this.identity().installationWorkspace()) throw expired();
    if (invite.email !== input.email) fail('INVITATION_IDENTITY');
    const user: User = { id: userId, name: input.name, email: input.email, salt, hash };
    const hosted = this.options.EDITION !== 'self-hosted';
    if (!await this.identity().createUser({ user, workspaceId, ...(hosted ? { emailToken: { id: verificationHash, userId, email: input.email, kind: 'verify' as const, expiresAt: Date.now() + VERIFY_TOKEN_MS } } : {}) })) throw new ApiError(409, 'ACCOUNT_EXISTS', 'This email is already registered. Sign in instead.');
    try { await this.shard(workspaceId).acceptInvite(invitationHash, userId, input.email, 'new'); }
    catch (error) { await this.identity().deleteUser(userId); throw error; }
    if (!hosted) return this.beginMfa(userId);
    return { ...await this.issueSession(user, workspaceId), verificationToken };
  }
  async verifyEmail(body: Record<string, unknown>) {
    if (this.options.EDITION === 'self-hosted') fail('HOSTED_ONLY');
    const userId = await this.identity().verifyEmail(await hashToken(requireString(body.token, 'Verification token', 128)));
    await this.auditAccount(userId, 'account:email-verified');
    return { ok: true };
  }
  async resendVerification(p: Principal) {
    if (this.options.EDITION === 'self-hosted') fail('HOSTED_ONLY');
    const raw = token(); const id = await hashToken(raw);
    await this.shard(p.workspaceId).validatePrincipal(p, { account: true });
    const email = await this.identity().resendVerification(p.userId, id);
    if (!email) throw new ApiError(429, 'RATE_LIMITED', 'Too many verification emails were requested. Try again in an hour.');
    return { email, token: raw };
  }
  async requestPasswordReset(body: Record<string, unknown>): Promise<{ email: string; token: string } | null> {
    const email = requireString(body.email, 'Email', 254).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    const raw = token(); const id = await hashToken(raw); const limitKey = `password-reset:${await hashToken(email)}`;
    const userId = await this.identity().requestReset(email, id, limitKey);
    if (!userId) return null;
    await this.auditAccount(userId, 'account:password-reset-requested');
    return { email, token: raw };
  }
  async confirmPasswordReset(body: Record<string, unknown>) {
    const id = await hashToken(requireString(body.token, 'Reset token', 128)); const password = requireString(body.password, 'Password', 256, 12);
    const salt = token(); const hash = await passwordHash(password, salt);
    const outbox = await this.identity().confirmReset(id, salt, hash);
    await this.revokeEverywhere(outbox);
    await this.auditAccount(outbox.userId, 'account:password-reset', outbox.workspaces);
    return { ok: true };
  }
  async cloudflareSigninState(operation: 'put' | 'consume', body: Record<string, unknown>): Promise<CloudflareSigninState | { ok: true }> { throw new Error('This feature belongs to the hosted edition'); }
  async cloudflareSignin(input: CloudflareSigninInput): Promise<CloudflareSigninResult> { throw new Error('This feature belongs to the hosted edition'); }
  async registerMachine(body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async claimMachine(p: Principal, body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async acceptInvite(p: Principal, value: string) {
    const hash = await hashToken(value);
    await this.shard(p.workspaceId).validatePrincipal(p, { account: true });
    const workspaceId = await this.identity().lookup('invite', hash);
    if (!workspaceId) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.');
    const invite = await this.shard(workspaceId).peekInvite(hash);
    const user = await this.identity().account(p.userId);
    if (!user || user.email !== invite.email) fail('INVITATION_IDENTITY', 'This invitation was issued for a different account email.');
    await this.identity().addHint(p.userId, workspaceId);
    await this.shard(workspaceId).acceptInvite(hash, p.userId, user.email, 'member');
    return { ok: true, workspaceId };
  }
  clearApprovals(p: Principal, missionId: string) { return this.shard(p.workspaceId).clearApprovals(p, missionId); }
  auditRepositoryChange(p: Principal, action: string, repositoryId: string) { return this.shard(p.workspaceId).audit([{ actorId: p.userId, action, resourceId: repositoryId }]); }
  async clientSession(p: Principal, client: string, lifetimeMs: number) {
    const value = mintToken(p.workspaceId);
    const session = await this.shard(p.workspaceId).clientSession(p, client, lifetimeMs, await hashToken(value));
    return { token: value, session };
  }
  async logout(p: Principal) { if (p.sessionId) await this.action(p, 'session-revoke', { id: p.sessionId }); }
  recordApproval(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, checks: { name: string; status: string; candidateSha?: string }[], creatorId?: string, rule?: ReviewRule) { return this.shard(p.workspaceId).recordApproval(p, missionId, candidateSha, baseSha, epoch, checks, creatorId, rule); }
  assertLand(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, repositoryId?: string, rule?: ReviewRule) { return this.shard(p.workspaceId).assertLand(p, missionId, candidateSha, baseSha, epoch, repositoryId, rule); }
}

const PUBLIC_METHODS = new Set(['connectionStore', 'projectStore', 'rateLimit', 'signup', 'login', 'legacySession', 'bootstrap', 'authenticate', 'authorize', 'authorizeMetadata', 'check', 'checkMany', 'workspace', 'snapshot', 'action', 'authConfig', 'startSetup', 'enrollMfa', 'verifyMfa', 'createInstallationUser', 'registerInvitedUser', 'verifyEmail', 'resendVerification', 'requestPasswordReset', 'confirmPasswordReset', 'cloudflareSigninState', 'cloudflareSignin', 'registerMachine', 'claimMachine', 'acceptInvite', 'clearApprovals', 'auditRepositoryChange', 'clientSession', 'logout', 'recordApproval', 'assertLand']);
export type SecurityEnv = { GITFLARE_SECURITY: DurableObjectNamespace<GitflareSecurity> } & { [K in keyof SecurityOptions]?: unknown };
// While a deployment still runs a global instance without the shard protocol, its original methods serve the call
export function securityClient(env: SecurityEnv): SecurityService {
  const namespace = env.GITFLARE_SECURITY;
  if (!namespace) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.');
  const global = namespace.getByName('security') as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const service = new SecurityService(undefined, env as unknown as SecurityOptions, name => namespace.getByName(name) as unknown as SecurityPeer);
  return new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof property !== 'string' || typeof value !== 'function' || !PUBLIC_METHODS.has(property)) return value;
      return async (...args: unknown[]) => {
        try { return await (value as (...values: unknown[]) => Promise<unknown>).apply(target, args); }
        catch (error) { if (!missingRpcMethod(error) || typeof global[property] !== 'function') throw error; return global[property](...args); }
      };
    },
  });
}

export class GitflareSecurity extends DurableObject<AppEnv> {
  private service: SecurityService;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    const schedule = async () => { const target = Date.now() + 1000; const current = await ctx.storage.getAlarm(); if (current === null || current > target) await ctx.storage.setAlarm(target); };
    this.service = new SecurityService(ctx.storage, env as AppEnv & SecurityOptions, name => env.GITFLARE_SECURITY.getByName(name) as unknown as SecurityPeer, schedule);
  }
  identityCall(op: string, args: unknown[]) { return this.service.identityCall(op, args); }
  shardCall(workspaceId: string, op: string, args: unknown[]) { return this.service.shardCall(workspaceId, op, args); }
  async alarm() { try { await this.service.alarm(); } catch (error) { await this.ctx.storage.setAlarm(Date.now() + 60_000); throw error; } }
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
  login(body: Record<string, unknown>, client?: string, linkToken?: string) { return this.service.login(body, client, linkToken); }
  cloudflareSigninState(operation: 'put' | 'consume', body: Record<string, unknown>) : never { throw new Error('This feature belongs to the hosted edition'); }
  cloudflareSignin(input: CloudflareSigninInput) : never { throw new Error('This feature belongs to the hosted edition'); }
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
  auditRepositoryChange(p: Principal, action: string, repositoryId: string) { return this.service.auditRepositoryChange(p, action, repositoryId); }
  clientSession(p: Principal, client: string, lifetimeMs: number) { return this.service.clientSession(p, client, lifetimeMs); }
  logout(p: Principal) { return this.service.logout(p); }
  recordApproval(p: Principal, missionId: string, sha: string, baseSha: string, epoch: number, checks: { name: string; status: string; candidateSha?: string }[], creatorId?: string, rule?: ReviewRule) { return this.service.recordApproval(p, missionId, sha, baseSha, epoch, checks, creatorId, rule); }
  assertLand(p: Principal, missionId: string, sha: string, baseSha: string, epoch: number, repositoryId?: string, rule?: ReviewRule) { return this.service.assertLand(p, missionId, sha, baseSha, epoch, repositoryId, rule); }
}
