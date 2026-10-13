import { DurableObject } from 'cloudflare:workers';
import { ApiError, requireString } from './domain';
import type { AppEnv } from './env';
import { authenticatorUri, decryptAuth, encryptAuth, mfaSecret, randomCapability, verifyTotp } from './mfa';

export const ROLES = ['Viewer', 'Contributor', 'Reviewer', 'Maintainer', 'Deployer', 'Owner'] as const;
export type Role = typeof ROLES[number];
export type Action = 'read' | 'contribute' | 'execute' | 'review' | 'land' | 'deploy' | 'migrate' | 'manage';
export const ROLE_ACTIONS: Record<Role, Action[]> = {
  Viewer: ['read'], Contributor: ['read', 'contribute', 'execute'], Reviewer: ['read', 'review'],
  Maintainer: ['read', 'contribute', 'execute', 'review', 'land'], Deployer: ['read', 'deploy'], Owner: ['read', 'contribute', 'execute', 'review', 'land', 'deploy', 'migrate', 'manage'],
};
interface User { id: string; name: string; email: string; salt: string; hash: string; machine?: boolean }
interface Member { userId: string; workspaceId: string; role: Role; repositoryIds?: string[] }
interface Session { id: string; userId: string; workspaceId: string; hash: string; expiresAt: number; authenticatedAt?: number; revoked?: boolean }
interface WorkspaceRecord { id: string; name: string; bootstrapDisabled?: boolean; agentPending?: boolean }
interface Invitation { id: string; workspaceId: string; email: string; role: Role; hash: string; expiresAt: number; accepted?: boolean }
interface Team { id: string; workspaceId: string; name: string; userIds: string[] }
interface Grant { id: string; workspaceId: string; subjectType: 'user' | 'team'; subjectId: string; resourceType: string; resourceId: string; actions: Action[] }
interface Credential { id: string; workspaceId: string; userId: string; name: string; hash: string; repositoryId: string; missionId?: string; actions: Action[]; expiresAt: number; maxRequests: number; maxExecutions: number; requests: number; executions: number; revoked?: boolean; scope?: 'workspace-read' }
interface Protection { requiredApprovals: number; requiredChecks: string[]; preventSelfApproval: boolean }
interface Audit { id: string; workspaceId: string; actorId: string; action: string; timestamp: string; resourceId?: string }
export interface SecurityOptions { EDITION?: 'hosted' | 'self-hosted'; SETUP_TOKEN?: string; AUTH_ENCRYPTION_KEY?: string }
interface MfaRecord { id: string; encryptedSecret: string; enabled: boolean; lastStep: number; recoveryHashes: string[] }
interface AuthChallenge { id: string; userId: string; kind: 'setup' | 'enroll' | 'login'; workspaceId?: string; expiresAt: number; used?: boolean }
interface Installation { workspaceName?: string; workspaceId?: string; pendingUser?: User; challengeId?: string }
interface MachineRegistration { id: string; requestHash: string; response: string; workspaceId: string; userId: string; claimHash: string; expiresAt: number; claimedBy?: string }
export interface MfaChallengeResult { mfaRequired: true; challengeId: string; expiresAt: number; enrollmentRequired: boolean; secret?: string; otpauthUri?: string }
interface State { mfa: MfaRecord[]; challenges: AuthChallenge[]; installations: Record<string, Installation>; machines: MachineRegistration[]; users: User[]; members: Member[]; sessions: Session[]; workspaces: WorkspaceRecord[]; invitations: Invitation[]; teams: Team[]; grants: Grant[]; credentials: Credential[]; audit: Audit[]; protections: Record<string, Protection>; approvals: Record<string, string[]>; limits: Record<string, { count: number; until: number }> }
export interface Principal { userId: string; workspaceId: string; role: Role; sessionId?: string; credentialId?: string; bootstrap?: boolean }
const initial = (): State => ({ mfa: [], challenges: [], installations: {}, machines: [], users: [], members: [], sessions: [], workspaces: [{ id: 'legacy', name: 'Gitflare workspace' }], invitations: [], teams: [], grants: [], credentials: [], audit: [], protections: {}, approvals: {}, limits: {} });
const encode = new TextEncoder();
export async function hashToken(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', encode.encode(value))); }
function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join(''); }
function token(): string { return hex(crypto.getRandomValues(new Uint8Array(32)).buffer); }
export async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encode.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encode.encode(salt), iterations: 100000 }, key, 256));
}
function role(value: unknown): Role { if (!ROLES.includes(value as Role)) throw new ApiError(400, 'INVALID_ROLE', 'Select a valid workspace role.'); return value as Role; }
function safeUser(user: User) { return { id: user.id, name: user.name, email: user.email, emailVerified: false }; }
function fail(code = 'FORBIDDEN', message = 'Your workspace permissions do not allow this action.'): never { throw new ApiError(403, code, message); }
function publicValue<T extends { hash: string }>(value: T): Omit<T, 'hash'> { const { hash: _hash, ...rest } = value; return rest; }
export class SecurityService {
  constructor(private storage: Pick<DurableObjectStorage, 'transaction'>, private options: SecurityOptions = {}) {}
  private async mutate<T>(operation: (state: State) => Promise<T> | T): Promise<T> {
    return this.storage.transaction(async txn => {
      const existing = await txn.list<{ group: string; value: unknown }>({ prefix: 'sec:' });
      const state = { ...initial(), ...await txn.get<State>('security') };
      if (existing.size) {
        for (const [group, value] of Object.entries(initial())) (state as unknown as Record<string, unknown>)[group] = Array.isArray(value) ? [] : {};
        for (const [key, record] of existing) {
          const group = record.group as keyof State;
          if (Array.isArray(state[group])) (state[group] as unknown[]).push(structuredClone(record.value));
          else (state[group] as Record<string, unknown>)[decodeURIComponent(key.split(':').slice(2).join(':'))] = structuredClone(record.value);
        }
      }
      state.sessions = state.sessions.filter(session => session.expiresAt > Date.now());
      if (state.audit.length > 1000) state.audit.splice(0, state.audit.length - 1000);
      const result = await operation(state);
      const next = new Map<string, { group: string; value: unknown }>();
      for (const [group, values] of Object.entries(state)) {
        if (Array.isArray(values)) for (const value of values) { const key = 'id' in value ? value.id : `${value.workspaceId}/${value.userId}`; next.set(`sec:${group}:${encodeURIComponent(key)}`, { group, value }); }
        else for (const [key, value] of Object.entries(values)) next.set(`sec:${group}:${encodeURIComponent(key)}`, { group, value });
      }
      for (const [key, value] of next) if (JSON.stringify(existing.get(key)) !== JSON.stringify(value)) await txn.put(key, value);
      for (const key of existing.keys()) if (!next.has(key)) await txn.delete(key);
      await txn.delete('security');
      return result;
    });
  }
  async rateLimit(key: string, max = 15, windowMs = 900000): Promise<void> {
    const accepted = await this.mutate(state => { const now = Date.now(); for (const [id, limit] of Object.entries(state.limits)) if (limit.until <= now) delete state.limits[id]; const entry = state.limits[key]; state.limits[key] = !entry || entry.until <= now ? { count: 1, until: now + windowMs } : { ...entry, count: entry.count + 1 }; return state.limits[key].count <= max; });
    if (!accepted) throw new ApiError(429, 'RATE_LIMITED', 'Too many authentication attempts. Try again in 15 minutes.');
  }
  async signup(body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async login(body: Record<string, unknown>) {
    const email = requireString(body.email, 'Email', 254).toLowerCase(); const password = requireString(body.password, 'Password', 256);
    const user = await this.mutate(state => state.users.find(item => item.email === email));
    const hash = await passwordHash(password, user?.salt ?? 'invalid-account-salt');
    if (!user || user.machine || user.hash !== hash) throw new ApiError(401, 'AUTH_REQUIRED', 'The email or password was not accepted.');
    const enrolled = await this.mutate(state => state.mfa.find(m => m.id === user.id)?.enabled);
    if (enrolled || this.options.EDITION === 'self-hosted') return this.beginMfa(user.id);
    const value = token(); const sessionHash = await hashToken(value);
    return this.mutate(state => { const membership = state.members.find(member => member.userId === user.id); if (!membership) fail(); state.sessions.push({ id: crypto.randomUUID(), userId: user.id, workspaceId: membership.workspaceId, hash: sessionHash, expiresAt: Date.now() + 28800000, authenticatedAt: Date.now() }); return { token: value, user: safeUser(user), workspaceId: membership.workspaceId }; });
  }
  async legacySession() { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); const value = token(); const hash = await hashToken(value); return this.mutate(state => { if (state.workspaces.find(w => w.id === 'legacy')?.bootstrapDisabled) fail(); state.sessions.push({ id: crypto.randomUUID(), userId: 'bootstrap-owner', workspaceId: 'legacy', hash, expiresAt: Date.now() + 28800000, authenticatedAt: Date.now() }); return value; }); }
  async bootstrap(): Promise<Principal> { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); return this.mutate(state => { if (state.workspaces.find(workspace => workspace.id === 'legacy')?.bootstrapDisabled) fail('BOOTSTRAP_DISABLED', 'The legacy owner key was retired by ownership transfer.'); return { userId: 'bootstrap-owner', workspaceId: 'legacy', role: 'Owner', bootstrap: true }; }); }
  async authenticate(value: string, workspaceId?: string): Promise<Principal> {
    const hash = await hashToken(value);
    return this.mutate(state => {
      const session = state.sessions.find(item => item.hash === hash && !item.revoked && item.expiresAt > Date.now());
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
      if (state.audit.length > 10000) state.audit.splice(0, state.audit.length - 10000);
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
    if (p.bootstrap) { if (this.options.EDITION === 'self-hosted') fail('BOOTSTRAP_DISABLED'); if (p.sessionId && !state.sessions.some(s => s.id === p.sessionId && s.userId === p.userId && !s.revoked && s.expiresAt > Date.now())) fail(); if (p.workspaceId !== 'legacy' || state.workspaces.find(w => w.id === 'legacy')?.bootstrapDisabled) fail(); return; }
    if (this.options.EDITION === 'self-hosted' && (state.installations.self?.workspaceId !== p.workspaceId || !state.mfa.some(m => m.id === p.userId && m.enabled))) fail('MFA_REQUIRED');
    const member = state.members.find(m => m.workspaceId === p.workspaceId && m.userId === p.userId); if (!member || member.role !== p.role) fail();
    if (p.sessionId && !state.sessions.some(s => s.id === p.sessionId && s.userId === p.userId && !s.revoked && s.expiresAt > Date.now())) fail();
    if (p.credentialId && !state.credentials.some(c => c.id === p.credentialId && c.userId === p.userId && c.workspaceId === p.workspaceId && !c.revoked && c.expiresAt > Date.now())) fail();
  }
  async check(p: Principal, action: Action, resourceType = 'workspace', resourceId = p.workspaceId, missionId?: string): Promise<void> {
    await this.mutate(state => { this.validate(state, p); if (p.credentialId) { const c = state.credentials.find(c => c.id === p.credentialId)!; if (!this.authorityAllows(state, p, action, resourceType, resourceId, missionId) || !c.actions.includes(action) || resourceType !== 'repository' || c.scope !== 'workspace-read' && c.repositoryId !== resourceId || c.missionId && (missionId ? c.missionId !== missionId : action !== 'read')) fail(); } else if (!this.roleAllows(state, p, action, resourceType, resourceId) && !state.grants.some(g => g.workspaceId === p.workspaceId && (g.resourceType === resourceType && g.resourceId === resourceId || g.resourceType === 'stream' && g.resourceId === missionId) && g.actions.includes(action) && (g.subjectType === 'user' ? g.subjectId === p.userId : state.teams.some(t => t.id === g.subjectId && t.workspaceId === p.workspaceId && t.userIds.includes(p.userId))))) fail(); });
  }
  async workspace(p: Principal) { return this.mutate(state => { this.validate(state,p); const workspace = state.workspaces.find(w => w.id === p.workspaceId); if (!workspace) fail(); return { id: workspace.id, name: workspace.name }; }); }
  async snapshot(p: Principal) { return this.mutate(state => { this.validate(state, p); if (p.credentialId) fail(); const owner = p.role === 'Owner'; return { user: state.users.find(u => u.id === p.userId) ? safeUser(state.users.find(u => u.id === p.userId)!) : { id: p.userId, name: 'Legacy owner', emailVerified: false }, workspace: state.workspaces.find(w => w.id === p.workspaceId), role: p.role, permissions: ROLE_ACTIONS[p.role], members: state.members.filter(m => m.workspaceId === p.workspaceId).map(m => ({ ...m, user: state.users.find(u => u.id === m.userId) ? safeUser(state.users.find(u => u.id === m.userId)!) : null })), teams: state.teams.filter(t => t.workspaceId === p.workspaceId), invitations: owner ? state.invitations.filter(i => i.workspaceId === p.workspaceId).map(publicValue) : [], grants: owner ? state.grants.filter(g => g.workspaceId === p.workspaceId) : [], credentials: state.credentials.filter(c => c.workspaceId === p.workspaceId && (owner || c.userId === p.userId)).map(publicValue), sessions: state.sessions.filter(s => s.userId === p.userId).map(publicValue), protection: state.protections[p.workspaceId] ?? { requiredApprovals: 1, requiredChecks: [], preventSelfApproval: false }, audit: owner ? state.audit.filter(a => a.workspaceId === p.workspaceId).slice(-100).reverse() : [], workspaces: state.workspaces.filter(w => state.members.some(m => m.workspaceId === w.id && m.userId === p.userId) || p.bootstrap && w.id === 'legacy') }; }); }
  async action(p: Principal, action: string, body: Record<string, unknown>) {
    if (action === 'user-create') return this.createInstallationUser(p, body);
    if (action === 'agent-claim') return this.claimMachine(p, body);
    if (action === 'mfa-enroll') return this.enrollMfa(p);
    const raw = token(); const hash = await hashToken(raw);
    return this.mutate(state => {
      this.validate(state, p); if (p.credentialId) fail(); const workspaceId = p.workspaceId; state.audit.push({ id: crypto.randomUUID(), workspaceId, actorId: p.userId, action: `access:${action}`, timestamp: new Date().toISOString() });
      if (action === 'session-create') { if (p.bootstrap) fail('ACCOUNT_REQUIRED'); const session = { id: crypto.randomUUID(), userId: p.userId, workspaceId, hash, expiresAt: Date.now() + 28800000, authenticatedAt: state.sessions.find(s => s.id === p.sessionId)?.authenticatedAt ?? 0 }; state.sessions.push(session); return { token: raw, session: publicValue(session) }; }
      if (action === 'session-revoke') { const session = state.sessions.find(s => s.id === body.id && s.userId === p.userId); if (!session) fail(); session.revoked = true; return { ok: true }; }
      if (p.role !== 'Owner') fail();
      const member = (userId: unknown) => { const found = state.members.find(m => m.workspaceId === workspaceId && m.userId === userId); if (!found) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Select an existing workspace member.'); return found; };
      if (action === 'invite-revoke') { const invitation = state.invitations.find(i => i.id === body.id && i.workspaceId === workspaceId); if (!invitation) fail(); invitation.accepted = true; return { ok: true }; }
      if (action === 'invite') { const invitation: Invitation = { id: crypto.randomUUID(), workspaceId, email: requireString(body.email, 'Email', 254).toLowerCase(), role: role(body.role), hash, expiresAt: Date.now() + 86400000 }; if (invitation.role === 'Owner') fail('TRANSFER_REQUIRED', 'Use ownership transfer to assign the Owner role.'); state.invitations.push(invitation); return { token: raw, invitation: publicValue(invitation) }; }
      if (action === 'membership') { const target = member(body.userId); if (target.role === 'Owner' || body.role === 'Owner') fail('TRANSFER_REQUIRED'); if (body.role === null) { const email = state.users.find(user => user.id === target.userId)?.email; for (const invitation of state.invitations) if (invitation.workspaceId === workspaceId && invitation.email === email) invitation.accepted = true; state.members = state.members.filter(m => m !== target); for (const c of state.credentials) if (c.workspaceId === workspaceId && c.userId === target.userId) c.revoked = true; for (const session of state.sessions) if (session.userId === target.userId) session.revoked = true; state.grants = state.grants.filter(g => !(g.workspaceId === workspaceId && g.subjectType === 'user' && g.subjectId === target.userId)); for (const team of state.teams) if (team.workspaceId === workspaceId) team.userIds = team.userIds.filter(id => id !== target.userId); } else { if (body.role !== undefined) target.role = role(body.role); if (body.repositoryIds !== undefined) { if (!Array.isArray(body.repositoryIds) || body.repositoryIds.length > 100 || body.repositoryIds.some(id => typeof id !== 'string' || id.length > 200)) throw new ApiError(400, 'INVALID_SCOPE', 'Provide a bounded list of repository IDs.'); target.repositoryIds = [...new Set(body.repositoryIds)] as string[]; } else delete target.repositoryIds; } return { ok: true }; }
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
    return this.mutate(state => ({ edition: this.options.EDITION ?? 'hosted', setupRequired: this.options.EDITION === 'self-hosted' && !state.installations.self?.workspaceId, publicSignup: this.options.EDITION !== 'self-hosted', mfaRequired: this.options.EDITION === 'self-hosted' }));
  }
  private accountInput(body: Record<string, unknown>) {
    const name = requireString(body.name, 'Name', 100); const email = requireString(body.email, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    return { name, email, password: requireString(body.password, 'Password', 256, 12) };
  }
  private session(state: State, user: User, workspaceId: string, raw: string, hash: string) {
    state.sessions.push({ id: crypto.randomUUID(), userId: user.id, workspaceId, hash, expiresAt: Date.now() + 28800000, authenticatedAt: Date.now() });
    return { token: raw, user: safeUser(user), workspaceId };
  }
  async startSetup(body: Record<string, unknown>): Promise<MfaChallengeResult> {
    if (this.options.EDITION !== 'self-hosted') fail('SETUP_DISABLED');
    const supplied = requireString(body.setupToken, 'Setup token', 1024, 32);
    if (!this.options.SETUP_TOKEN || this.options.SETUP_TOKEN.length < 32 || await hashToken(supplied) !== await hashToken(this.options.SETUP_TOKEN)) fail('INVALID_SETUP_TOKEN', 'The installation setup token was not accepted.');
    const input = this.accountInput(body); const workspaceName = requireString(body.workspaceName, 'Workspace name', 100);
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
  private async beginMfa(userId: string, workspaceId?: string): Promise<MfaChallengeResult> {
    const challengeId = token(); const challengeHash = await hashToken(challengeId); const expiresAt = Date.now() + 300000;
    const secret = mfaSecret(); const encryptedSecret = await encryptAuth(secret, this.options.AUTH_ENCRYPTION_KEY, `mfa:${userId}`);
    const result = await this.mutate(state => {
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
    await this.mutate(state => {
      this.validate(state, p); if (p.bootstrap || p.credentialId) fail();
      const session = state.sessions.find(s => s.id === p.sessionId);
      if (!session?.authenticatedAt || Date.now() - session.authenticatedAt > 300000) fail('RECENT_AUTH_REQUIRED', 'Sign in again before setting up an authenticator.');
      if (state.mfa.some(m => m.id === p.userId && m.enabled)) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'This account already has an authenticator.');
    });
    return this.beginMfa(p.userId, p.workspaceId);
  }
  async verifyMfa(body: Record<string, unknown>, setupOnly = false) {
    const challengeId = requireString(body.challengeId, 'Authentication challenge', 128); const id = await hashToken(challengeId);
    await this.rateLimit(`mfa:${id}`, 5, 300000);
    const userId = await this.mutate(state => state.challenges.find(c => c.id === id && !c.used && c.expiresAt > Date.now())?.userId);
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
    const raw = token(); const sessionHash = await hashToken(raw);
    const registered = await this.mutate(state => {
      const invite = state.invitations.find(i => i.hash === invitationHash && !i.accepted && i.expiresAt > Date.now());
      if (!invite || this.options.EDITION === 'self-hosted' && invite.workspaceId !== state.installations.self?.workspaceId) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.');
      if (invite.email !== input.email) fail('INVITATION_IDENTITY');
      if (state.users.some(u => u.email === input.email)) throw new ApiError(409, 'ACCOUNT_EXISTS', 'This email is already registered. Sign in instead.');
      const user = { id: userId, name: input.name, email: input.email, salt, hash };
      state.users.push(user); state.members.push({ userId, workspaceId: invite.workspaceId, role: invite.role }); invite.accepted = true;
      return this.options.EDITION === 'self-hosted' ? { workspaceId: invite.workspaceId } : this.session(state, user, invite.workspaceId, raw, sessionHash);
    });
    if ('token' in registered) return registered;
    return this.beginMfa(userId);
  }
  async registerMachine(body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  async claimMachine(p: Principal, body: Record<string, unknown>) : Promise<never> { throw new Error('This feature belongs to the hosted edition'); }
  private actions(value: unknown): Action[] { if (!Array.isArray(value) || !value.length || value.some(v => !ROLE_ACTIONS.Owner.includes(v))) throw new ApiError(400, 'INVALID_ACTIONS', 'Select valid resource actions.'); return [...new Set(value)] as Action[]; }
  async acceptInvite(p: Principal, value: string) { const hash = await hashToken(value); return this.mutate(state => { this.validate(state, p); if (p.bootstrap || p.credentialId) fail(); const invite = state.invitations.find(i => i.hash === hash && !i.accepted && i.expiresAt > Date.now()); if (!invite) throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation is invalid, expired, or already used.'); const user = state.users.find(u => u.id === p.userId); if (!user || user.email !== invite.email) fail('INVITATION_IDENTITY', 'This invitation was issued for a different account email.'); if (state.members.some(m => m.workspaceId === invite.workspaceId && m.userId === p.userId)) throw new ApiError(409, 'ALREADY_MEMBER', 'You already belong to this workspace.'); state.members.push({ userId: p.userId, workspaceId: invite.workspaceId, role: invite.role }); invite.accepted = true; return { ok: true, workspaceId: invite.workspaceId }; }); }
  async clearApprovals(p: Principal, missionId: string) { await this.mutate(state => { this.validate(state,p); for (const key of Object.keys(state.approvals)) if (key.startsWith(`${p.workspaceId}:${missionId}:`)) delete state.approvals[key]; }); }
  async logout(p: Principal) { if (p.sessionId) await this.action(p, 'session-revoke', { id: p.sessionId }); }
  async recordApproval(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, checks: {name: string; status: string; candidateSha?: string}[], creatorId?: string) { return this.mutate(state => { this.validate(state, p); if (p.credentialId) fail(); const protection = state.protections[p.workspaceId] ?? { requiredApprovals: 1, requiredChecks: [], preventSelfApproval: false }; if (protection.preventSelfApproval && (!creatorId || creatorId === p.userId)) fail('SELF_APPROVAL', 'A different member must review this Stream.'); if (protection.requiredChecks.some(name => !checks.some(check => check.name === name && check.status === 'passed' && check.candidateSha === candidateSha))) throw new ApiError(409, 'CHECKS_REQUIRED', 'Required checks have not passed for this revision.'); const key = `${p.workspaceId}:${missionId}:${candidateSha}:${baseSha}:${epoch}`; const reviewers = [...new Set([...(state.approvals[key] ?? []), p.userId])]; state.approvals[key] = reviewers; return { approvals: reviewers.length, requiredApprovals: protection.requiredApprovals, ready: reviewers.length >= protection.requiredApprovals }; }); }
  async assertLand(p: Principal, missionId: string, candidateSha: string, baseSha: string, epoch: number, repositoryId?: string) {
    await this.mutate(state => {
      this.validate(state, p);
      const required = state.protections[p.workspaceId]?.requiredApprovals ?? 1;
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
  login(body: Record<string, unknown>) { return this.service.login(body); }
  legacySession() { return this.service.legacySession(); }
  bootstrap() { return this.service.bootstrap(); }
  authenticate(value: string, workspaceId?: string) { return this.service.authenticate(value, workspaceId); }
  authorize(p: Principal, action: Action, type?: string, id?: string, missionId?: string) { return this.service.authorize(p, action, type, id, missionId); }
  authorizeMetadata(p: Principal) { return this.service.authorizeMetadata(p); }
  check(p: Principal, action: Action, type?: string, id?: string, missionId?: string) { return this.service.check(p, action, type, id, missionId); }
  workspace(p: Principal) { return this.service.workspace(p); }
  snapshot(p: Principal) { return this.service.snapshot(p); }
  action(p: Principal, action: string, body: Record<string, unknown>) { return this.service.action(p, action, body); }
  acceptInvite(p: Principal, value: string) { return this.service.acceptInvite(p, value); }
  clearApprovals(p: Principal, missionId: string) { return this.service.clearApprovals(p, missionId); }
  logout(p: Principal) { return this.service.logout(p); }
  recordApproval(p: Principal, missionId: string, sha: string, baseSha: string, epoch: number, checks: {name: string; status: string; candidateSha?: string}[], creatorId?: string) { return this.service.recordApproval(p, missionId, sha, baseSha, epoch, checks, creatorId); }
  assertLand(p: Principal, missionId: string, sha: string, baseSha: string, epoch: number, repositoryId?: string) { return this.service.assertLand(p, missionId, sha, baseSha, epoch, repositoryId); }
}
