import type { BranchProtection, BranchRule, LanderRole } from '../shared/types';
import { ApiError } from './domain';
import type { Role } from './security';

export const MAX_BRANCH_RULES = 20;
export const MAX_REQUIRED_APPROVALS = 6;
export const ZERO_SHA = '0'.repeat(40);
const LANDER_ROLES: readonly LanderRole[] = ['Maintainer', 'Owner'];
export interface StoredBranchProtection { rules: BranchRule[]; updatedAt: string; updatedBy: string }
export interface RefUpdate { oldSha: string; newSha: string; ref: string }
export type PushDecision = { ref: string; ok: true } | { ref: string; ok: false; reason: string };
export interface PushContext { rules: BranchRule[]; defaultBranch: string; role: Role; canLand: boolean }

function validRefName(value: string, allowGlob: boolean): boolean {
  const characters = allowGlob ? /^[A-Za-z0-9*][A-Za-z0-9._/*-]{0,199}$/ : /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
  return characters.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'));
}

export function branchName(value: unknown, field = 'Branch'): string {
  if (typeof value !== 'string' || !validRefName(value, false)) throw new ApiError(400, 'INVALID_BRANCH', `${field} must be a valid Git branch name of up to 200 characters.`);
  return value;
}

export function branchPattern(value: unknown): string {
  if (typeof value !== 'string' || !validRefName(value, true)) throw new ApiError(400, 'INVALID_BRANCH_PATTERN', 'A rule pattern is a branch name, optionally with * wildcards such as release/*.');
  return value;
}

export function matchesBranch(pattern: string, branch: string): boolean {
  if (!pattern.includes('*')) return pattern === branch;
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&')).join('.*')}$`).test(branch);
}

export function defaultBranchRule(defaultBranch: string): BranchRule {
  return { pattern: defaultBranch, requirePullRequest: true, requiredApprovals: 1, requirePassingChecks: true, requiredCheckNames: [], preventSelfApproval: false, dismissApprovalsOnNewCommits: true, restrictLanders: [], allowForcePush: false };
}

export function normalizeBranchRule(value: unknown): BranchRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_BRANCH_RULE', 'Each branch rule must be an object.');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['pattern', 'requirePullRequest', 'requiredApprovals', 'requiredCheckNames', 'preventSelfApproval', 'restrictLanders', 'requirePassingChecks', 'dismissApprovalsOnNewCommits', 'allowForcePush']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new ApiError(400, 'INVALID_BRANCH_RULE', 'A branch rule contains an unsupported field.');
  if (input.requirePassingChecks === false || input.dismissApprovalsOnNewCommits === false || input.allowForcePush === true) throw new ApiError(400, 'UNSUPPORTED_BRANCH_RULE', 'Checks always gate landing, approvals are always pinned to the exact commit, and force pushes to protected branches are never allowed.');
  const approvals = input.requiredApprovals ?? 1;
  if (!Number.isInteger(approvals) || (approvals as number) < 0 || (approvals as number) > MAX_REQUIRED_APPROVALS) throw new ApiError(400, 'INVALID_BRANCH_RULE', `Required approvals must be a whole number from 0 to ${MAX_REQUIRED_APPROVALS}.`);
  const checks = input.requiredCheckNames ?? [];
  if (!Array.isArray(checks) || checks.length > 20 || checks.some(name => typeof name !== 'string' || !name.trim() || name.length > 200)) throw new ApiError(400, 'INVALID_BRANCH_RULE', 'Provide up to 20 required check names of at most 200 characters.');
  const landers = input.restrictLanders ?? [];
  if (!Array.isArray(landers) || landers.some(role => !LANDER_ROLES.includes(role as LanderRole))) throw new ApiError(400, 'INVALID_BRANCH_RULE', 'Landers can be restricted to Maintainer and Owner roles.');
  for (const key of ['requirePullRequest', 'preventSelfApproval'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError(400, 'INVALID_BRANCH_RULE', `${key} must be true or false.`);
  return { pattern: branchPattern(input.pattern), requirePullRequest: input.requirePullRequest !== false, requiredApprovals: approvals as number, requirePassingChecks: true, requiredCheckNames: [...new Set((checks as string[]).map(name => name.trim()))], preventSelfApproval: input.preventSelfApproval === true, dismissApprovalsOnNewCommits: true, restrictLanders: LANDER_ROLES.filter(role => (landers as string[]).includes(role)), allowForcePush: false };
}

export function normalizeBranchRules(value: unknown): BranchRule[] {
  if (!Array.isArray(value) || value.length > MAX_BRANCH_RULES) throw new ApiError(400, 'INVALID_BRANCH_RULES', `Provide up to ${MAX_BRANCH_RULES} branch rules.`);
  const rules = value.map(normalizeBranchRule);
  if (new Set(rules.map(rule => rule.pattern)).size !== rules.length) throw new ApiError(400, 'INVALID_BRANCH_RULES', 'Each branch pattern can have only one rule.');
  return rules;
}

export function effectiveRules(stored: StoredBranchProtection | undefined, defaultBranch: string): BranchRule[] {
  return stored ? stored.rules : [defaultBranchRule(defaultBranch)];
}

export function ruleFor(rules: BranchRule[], branch: string, defaultBranch: string): BranchRule | undefined {
  return rules.find(rule => rule.pattern === branch) ?? rules.find(rule => matchesBranch(rule.pattern, branch)) ?? (branch === defaultBranch ? defaultBranchRule(defaultBranch) : undefined);
}

export function protectionSnapshot(repositoryId: string, defaultBranch: string, stored?: StoredBranchProtection): BranchProtection {
  return { repositoryId, defaultBranch, rules: effectiveRules(stored, defaultBranch), configured: !!stored, ...(stored ? { updatedAt: stored.updatedAt, updatedBy: stored.updatedBy } : {}) };
}

export function landingRule(stored: StoredBranchProtection | undefined, defaultBranch: string): BranchRule | undefined {
  return stored ? ruleFor(stored.rules, defaultBranch, defaultBranch) : undefined;
}

export function landerAllowed(rule: Pick<BranchRule, 'restrictLanders'> | undefined, role: Role): boolean {
  return !rule?.restrictLanders.length || rule.restrictLanders.includes(role as LanderRole);
}

export function evaluatePush(updates: RefUpdate[], context: PushContext): PushDecision[] {
  return updates.map(({ ref, newSha }): PushDecision => {
    if (ref.startsWith('refs/tags/')) return { ref, ok: false, reason: 'tags are managed by Gitflare Releases' };
    if (!ref.startsWith('refs/heads/')) return { ref, ok: false, reason: 'only branch updates are accepted' };
    const branch = ref.slice('refs/heads/'.length);
    if (!validRefName(branch, false)) return { ref, ok: false, reason: 'invalid branch name' };
    const rule = ruleFor(context.rules, branch, context.defaultBranch);
    if (newSha === ZERO_SHA) {
      if (branch === context.defaultBranch) return { ref, ok: false, reason: 'the default branch cannot be deleted' };
      if (rule) return { ref, ok: false, reason: 'protected branches cannot be deleted' };
      return { ref, ok: true };
    }
    if (!rule) return { ref, ok: true };
    if (rule.requirePullRequest) return { ref, ok: false, reason: 'protected branch; push another branch and open a pull request' };
    if (!context.canLand || !landerAllowed(rule, context.role)) return { ref, ok: false, reason: rule.restrictLanders.length ? `protected branch; only ${rule.restrictLanders.join(' or ')} landers may push` : 'protected branch; pushing requires land permission' };
    return { ref, ok: true };
  });
}
