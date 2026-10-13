export const POLICY_FILE = 'gitflare.json';
export const DEFAULT_EDITABLE = ['src/', 'docs/', 'README.md'];

export interface RepositoryPolicy {
  testCommand: string;
  evidence: 'tap' | 'exit-code';
  editable: string[];
  install: boolean;
  previewCommand: string;
}

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

export function parseRepositoryPolicy(raw: string | null, defaultTestCommand: string): RepositoryPolicy {
  const fallback: RepositoryPolicy = { testCommand: defaultTestCommand, evidence: 'tap', editable: DEFAULT_EDITABLE, install: false, previewCommand: DEFAULT_PREVIEW };
  if (raw === null) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${POLICY_FILE} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${POLICY_FILE} must contain a JSON object`);
  const fields = parsed as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !['test', 'evidence', 'editable', 'install', 'preview'].includes(key));
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
