export const POLICY_FILE = 'gitflare.json';
export const DEFAULT_EDITABLE = ['src/', 'docs/', 'README.md'];

export interface RepositoryPolicy {
  testCommand: string;
  evidence: 'tap' | 'exit-code';
  editable: string[];
  install: boolean;
  previewCommand: string;
  testTimeoutMs: number;
  starter: boolean;
  untested: boolean;
}

export interface PathChange { path: string; status: string }
export interface StarterCheck { testCommand: string; evidence: RepositoryPolicy['evidence']; install: 'ci' | 'install' | null }

const DEFAULT_PREVIEW = 'node src/preview.mjs';
const ALWAYS_PROTECTED = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|gitflare\.json|\.npmrc)$|^\.(git|github)(\/|$)/;
const TEST_PATHS = /(^|\/)(__tests__|tests?|node_modules)(\/|$)|\.(test|spec)\.[^.\/]+$|_test\.[^.\/]+$|(^|\/)(test_[^\/]+|conftest)\.py$/;

function command(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${POLICY_FILE}: "${field}" must be a single-line command of at most 500 characters`);
  return value.trim();
}

function editablePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').some((part, index, parts) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) throw new Error(`${POLICY_FILE}: "editable" entries must be repository-relative files or directories ending in "/"`);
  return value;
}

export function parseRepositoryPolicy(raw: string | null, defaultTestCommand: string, baseFiles?: string[], basePackageJson?: string | null): RepositoryPolicy {
  const fallback: RepositoryPolicy = { testCommand: defaultTestCommand, evidence: 'tap', editable: DEFAULT_EDITABLE, install: false, previewCommand: DEFAULT_PREVIEW, testTimeoutMs: 120_000, starter: false, untested: false };
  if (raw === null) {
    if (baseFiles === undefined) return fallback;
    const untested = !baseFiles.some((path) => TEST_PATHS.test(path) && !path.includes('node_modules/'));
    const npm = basePackageJson !== undefined && basePackageJson !== null ? starterCheck(['package.json'], basePackageJson, baseFiles.includes('package-lock.json')) : null;
    return { ...fallback, starter: isStarterRepository(baseFiles), untested, ...(npm ? { testCommand: npm.testCommand, evidence: npm.evidence, install: true } : {}) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${POLICY_FILE} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${POLICY_FILE} must contain a JSON object`);
  const fields = parsed as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !['test', 'evidence', 'editable', 'install', 'preview', 'timeoutSeconds'].includes(key));
  if (unknown.length) throw new Error(`${POLICY_FILE}: unsupported field "${unknown[0]}"`);
  const policy = { ...fallback };
  if (fields.test !== undefined) policy.testCommand = command(fields.test, 'test');
  if (fields.preview !== undefined) policy.previewCommand = command(fields.preview, 'preview');
  if (fields.evidence !== undefined) {
    if (fields.evidence !== 'tap' && fields.evidence !== 'exit-code') throw new Error(`${POLICY_FILE}: "evidence" must be "tap" or "exit-code"`);
    policy.evidence = fields.evidence;
  }
  if (fields.install !== undefined) {
    if (fields.install !== 'npm' && fields.install !== false) throw new Error(`${POLICY_FILE}: "install" must be "npm" or false`);
    policy.install = fields.install === 'npm';
  }
  if (fields.timeoutSeconds !== undefined) {
    if (!Number.isInteger(fields.timeoutSeconds) || (fields.timeoutSeconds as number) < 10 || (fields.timeoutSeconds as number) > 300) throw new Error(`${POLICY_FILE}: "timeoutSeconds" must be a whole number between 10 and 300`);
    policy.testTimeoutMs = (fields.timeoutSeconds as number) * 1000;
  }
  if (fields.editable !== undefined) {
    if (!Array.isArray(fields.editable) || !fields.editable.length || fields.editable.length > 20) throw new Error(`${POLICY_FILE}: "editable" must list between 1 and 20 paths`);
    policy.editable = fields.editable.map(editablePath);
  }
  return policy;
}

export function isProtectedPath(path: string, editable: string[] = DEFAULT_EDITABLE): boolean {
  const allowed = editable.some((entry) => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
  return !allowed || ALWAYS_PROTECTED.test(path) || TEST_PATHS.test(path);
}

// Only these stay off-limits when a repository has nothing yet to protect
const STARTER_PROTECTED = /(^|\/)(gitflare\.json|\.npmrc)$|^\.(git|github)(\/|$)/;
const MANIFESTS = /(^|\/)package\.json$/;
const NPM_PLACEHOLDER_TEST = /no test specified/;

export function isStarterRepository(baseFiles: string[]): boolean {
  return !baseFiles.some((path) => path === POLICY_FILE || MANIFESTS.test(path) || TEST_PATHS.test(path));
}

export function protectedChanges(changes: PathChange[], policy: Pick<RepositoryPolicy, 'editable' | 'starter'>): string[] {
  return changes.filter(({ path, status }) => status !== 'A' ? isProtectedPath(path, policy.editable) : policy.starter ? STARTER_PROTECTED.test(path) : ALWAYS_PROTECTED.test(path)).map(({ path }) => path);
}

export function parseNameStatus(output: string): PathChange[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status.charAt(0), path: rest.join('\t') };
  });
}

export function starterCheck(files: string[], packageJson: string | null, hasLockfile: boolean): StarterCheck | null {
  if (packageJson !== null) {
    let script: unknown;
    try { script = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts?.test; } catch { return null; }
    if (typeof script === 'string' && script.trim() && !NPM_PLACEHOLDER_TEST.test(script)) return { testCommand: 'npm test', evidence: 'exit-code', install: hasLockfile ? 'ci' : 'install' };
  }
  if (files.some((path) => /\.test\.(mjs|cjs|js)$/.test(path) && !path.includes('node_modules/'))) return { testCommand: 'node --test --test-reporter=tap', evidence: 'tap', install: null };
  return null;
}
