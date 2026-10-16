import type { DependencyChange, DependencySection, ManifestDependencyChanges, Mission } from '../shared/types';
import { ApiError } from './domain';

export const DEPENDENCY_SECTIONS: readonly DependencySection[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
const RANGE = /^[0-9A-Za-z.+\-^~<>=|*\s]*$/;
const WORKSPACE = /^workspace:(?:[*^~]|[0-9A-Za-z.+\-^~<>=|*\s]+)$/;
const ALIAS = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)@(.+)$/;

export type ManifestReview = { ok: true; changes: DependencyChange[] } | { ok: false; reason: string };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function section(manifest: Record<string, unknown>, name: DependencySection): Record<string, string> | null {
  const value = manifest[name];
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((spec) => typeof spec !== 'string')) return null;
  return value as Record<string, string>;
}

export function registrySpecProblem(name: string, spec: string): string | null {
  if (!PACKAGE_NAME.test(name) || name.length > 214) return `"${name.slice(0, 80)}" is not a valid package name`;
  const value = spec.trim();
  if (value.length > 200) return `${name} has a version specification longer than 200 characters`;
  const alias = ALIAS.exec(value);
  if (alias) return alias[1] === name && RANGE.test(alias[2]!) ? null : `${name} uses an npm: alias to another package`;
  if (value.startsWith('workspace:')) return WORKSPACE.test(value) ? null : `${name} uses a workspace: path outside the workspace`;
  if (RANGE.test(value)) return null;
  return `${name} uses "${value.slice(0, 80)}", which is not a registry version, range or dist-tag`;
}

export function reviewManifest(base: string | null, head: string): ManifestReview {
  const before = base === null ? {} : parse(base);
  const after = parse(head);
  if (!before || !after) return { ok: false, reason: 'is not a valid JSON object' };
  if (base !== null) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => !DEPENDENCY_SECTIONS.includes(key as DependencySection)));
    const changed = [...keys].filter((key) => stable(before[key]) !== stable(after[key])).sort();
    if (changed.length) return { ok: false, reason: `changes ${changed.slice(0, 5).map((key) => `"${key.slice(0, 60)}"`).join(', ')}, which only an Owner may change` };
  }
  const changes: DependencyChange[] = [];
  for (const name of DEPENDENCY_SECTIONS) {
    const old = section(before, name);
    const next = section(after, name);
    if (!old || !next) return { ok: false, reason: `has a "${name}" field that is not an object of version strings` };
    for (const pkg of [...new Set([...Object.keys(old), ...Object.keys(next)])].sort()) {
      if (old[pkg] === next[pkg]) continue;
      if (next[pkg] !== undefined) {
        const problem = registrySpecProblem(pkg, next[pkg]!);
        if (problem) return { ok: false, reason: problem };
      }
      changes.push(old[pkg] === undefined ? { section: name, name: pkg, change: 'added', to: next[pkg] } : next[pkg] === undefined ? { section: name, name: pkg, change: 'removed', from: old[pkg] } : { section: name, name: pkg, change: 'changed', from: old[pkg], to: next[pkg] });
    }
  }
  return { ok: true, changes };
}

export function dependencyPackages(manifests: readonly ManifestDependencyChanges[] | undefined): string[] {
  return [...new Set((manifests ?? []).flatMap((manifest) => manifest.changes.map((change) => `${change.name}${change.to ? `@${change.to}` : ' (removed)'}`)))];
}

type DependencyGate = Pick<Mission, 'dependencyChanges' | 'dependencyApproval' | 'epoch'>;

export function dependencySummary(manifests: readonly ManifestDependencyChanges[] | undefined): string {
  const packages = dependencyPackages(manifests);
  return `${packages.slice(0, 10).join(', ')}${packages.length > 10 ? ` and ${packages.length - 10} more` : ''}`;
}

export function assertDependencyApproval(mission: DependencyGate, role: string, acknowledged: boolean): void {
  if (!mission.dependencyChanges?.length) return;
  if (role !== 'Owner') throw new ApiError(403, 'DEPENDENCY_APPROVAL_REQUIRED', `This candidate changes package.json dependencies (${dependencySummary(mission.dependencyChanges)}). Only a workspace Owner can approve dependency changes.`);
  if (!acknowledged) throw new ApiError(409, 'DEPENDENCY_APPROVAL_REQUIRED', `This candidate changes package.json dependencies (${dependencySummary(mission.dependencyChanges)}). Approve again with approveDependencies set to true to accept them.`);
}

export function assertDependencyApprover(mission: DependencyGate, approver: boolean): void {
  if (mission.dependencyChanges?.length && !approver) throw new ApiError(409, 'DEPENDENCY_APPROVAL_REQUIRED', `This candidate changes package.json dependencies (${dependencySummary(mission.dependencyChanges)}). A workspace Owner must approve them with approveDependencies set to true.`);
}

export function assertDependenciesAcknowledged(mission: DependencyGate, candidateSha: string, baseSha: string): void {
  if (!mission.dependencyChanges?.length) return;
  const approval = mission.dependencyApproval;
  if (!approval || approval.candidateSha !== candidateSha || approval.baseSha !== baseSha || approval.epoch !== mission.epoch) throw new ApiError(409, 'DEPENDENCY_APPROVAL_REQUIRED', `This candidate changes package.json dependencies (${dependencySummary(mission.dependencyChanges)}), and no Owner approved them for this exact candidate. Revoke and approve again as an Owner with approveDependencies set to true.`);
}
