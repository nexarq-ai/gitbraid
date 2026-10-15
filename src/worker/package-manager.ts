export type PackageManager = 'npm' | 'pnpm' | 'yarn';
export type Installer = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry';

export interface InstallPlan {
  installer: Installer;
  lockfile: string | null;
  pinned: string | null;
  fallbackRange: string | null;
}

export interface DetectionInput {
  files: string[];
  packageJson: string | null;
  lockHead?: string | null;
  prefer?: PackageManager;
}

export const NPM_REGISTRY = 'registry.npmjs.org';
export const YARN_REGISTRY = 'registry.yarnpkg.com';
export const INSTALL_TIMEOUT_MS = 300_000;
export const PNPM_STORE = '/tmp/gitflare-pnpm-store';
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;
export const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc\.yml|\.yarnrc|\.npmrc|\.pnpmfile\.cjs)$/;
export const INSTALL_EXCLUDES = ['node_modules/', '.pnpm-store/', '.pnp.cjs', '.pnp.loader.mjs', '.pnp.data.json', '.yarn/cache/', '.yarn/unplugged/', '.yarn/install-state.gz', '.yarn/build-state.yml', ...LOCKFILES];

export const COREPACK_ENV: Record<string, string> = {
  COREPACK_HOME: '/tmp/gitflare-corepack',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  COREPACK_ENABLE_STRICT: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  COREPACK_DEFAULT_TO_LATEST: '0',
  // Routes yarn berry through @yarnpkg/cli-dist on the npm registry instead of repo.yarnpkg.com
  COREPACK_NPM_REGISTRY: `https://${NPM_REGISTRY}`,
  YARN_ENABLE_TELEMETRY: '0',
  YARN_GLOBAL_FOLDER: '/tmp/gitflare-yarn-berry',
  YARN_CACHE_FOLDER: '/tmp/gitflare-yarn-cache',
};

const PACKAGE_MANAGER_FIELD = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+(?:sha1|sha224|sha256|sha512)\.[0-9a-f]+)?$/;
const RANGE = /^\d+(?:\.\d+){0,2}$/;

interface Manifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
}

function manifest(packageJson: string | null): Manifest | null {
  if (packageJson === null) return null;
  try {
    const parsed = JSON.parse(packageJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Manifest : null;
  } catch { return null; }
}

export function packageManagerField(packageJson: string | null): { manager: PackageManager; major: number } | null {
  const field = manifest(packageJson)?.packageManager;
  const match = typeof field === 'string' ? PACKAGE_MANAGER_FIELD.exec(field.trim()) : null;
  return match ? { manager: match[1] as PackageManager, major: Number(match[2]) } : null;
}

function lockfileFor(manager: PackageManager, files: string[]): string | null {
  const candidates = manager === 'npm' ? ['package-lock.json', 'npm-shrinkwrap.json'] : manager === 'pnpm' ? ['pnpm-lock.yaml'] : ['yarn.lock'];
  return candidates.find((name) => files.includes(name)) ?? null;
}

function pnpmRange(lockHead: string | null | undefined): string {
  const major = Number(/lockfileVersion:\s*['"]?(\d+)/.exec(lockHead ?? '')?.[1]);
  if (major === 5) return '7';
  if (major === 6) return '8';
  return '10';
}

function berryRange(lockHead: string | null | undefined): string {
  const version = Number(/__metadata:\s*\n\s*version:\s*(\d+)/.exec(lockHead ?? '')?.[1]);
  return version && version < 8 ? '3' : '4';
}

export function detectPackageManager({ files, packageJson, lockHead, prefer }: DetectionInput): InstallPlan | null {
  if (packageJson === null) return null;
  const field = packageManagerField(packageJson);
  const manager: PackageManager = prefer
    ?? field?.manager
    ?? (files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm');
  const lockfile = lockfileFor(manager, files);
  const pinned = field && field.manager === manager && manager !== 'npm' ? (manifest(packageJson)!.packageManager as string).trim() : null;
  if (manager === 'npm') return { installer: 'npm', lockfile, pinned: null, fallbackRange: null };
  if (manager === 'pnpm') return { installer: 'pnpm', lockfile, pinned, fallbackRange: pnpmRange(lockHead) };
  const berry = pinned ? field!.major >= 2 : files.includes('.yarnrc.yml') || /^__metadata:/m.test(lockHead ?? '');
  return { installer: berry ? 'yarn-berry' : 'yarn-classic', lockfile, pinned, fallbackRange: berry ? berryRange(lockHead) : '1' };
}

export function hasInstallableDependencies(files: string[], packageJson: string | null): boolean {
  if (packageJson === null) return false;
  if (LOCKFILES.some((name) => files.includes(name)) || files.includes('pnpm-workspace.yaml')) return true;
  const parsed = manifest(packageJson);
  if (!parsed) return false;
  if (parsed.workspaces !== undefined) return true;
  return [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies].some((deps) => !!deps && typeof deps === 'object' && Object.keys(deps).length > 0);
}

export function testScript(packageJson: string | null): string | null {
  const script = manifest(packageJson)?.scripts?.test;
  return typeof script === 'string' && script.trim() ? script : null;
}

export function runnerFor(plan: Pick<InstallPlan, 'installer'> | null | undefined): PackageManager {
  if (!plan || plan.installer === 'npm') return 'npm';
  return plan.installer === 'pnpm' ? 'pnpm' : 'yarn';
}

export function runScript(manager: PackageManager, script: string, args: string[] = []): string {
  if (!args.length) return `${manager} run ${script}`;
  return manager === 'npm' ? `npm run ${script} -- ${args.join(' ')}` : `${manager} run ${script} ${args.join(' ')}`;
}

export function describeInstall(plan: InstallPlan): string {
  const name = plan.installer === 'yarn-classic' ? 'Yarn classic' : plan.installer === 'yarn-berry' ? 'Yarn' : plan.installer;
  return plan.lockfile ? `${name} from ${plan.lockfile}` : `${name} without a lockfile`;
}

export function registryHosts(plan: InstallPlan): string[] {
  return plan.installer === 'yarn-classic' || plan.installer === 'yarn-berry' ? [NPM_REGISTRY, YARN_REGISTRY] : [NPM_REGISTRY];
}

function managerCommand(plan: InstallPlan): string {
  const frozen = plan.lockfile !== null;
  if (plan.installer === 'pnpm') return `pnpm install ${frozen ? '--frozen-lockfile' : '--no-frozen-lockfile'} --ignore-scripts --store-dir ${PNPM_STORE}`;
  if (plan.installer === 'yarn-classic') return `yarn install ${frozen ? '--frozen-lockfile' : '--pure-lockfile'} --ignore-scripts --non-interactive`;
  return `yarn install ${frozen ? '--immutable' : '--no-immutable'} --mode=skip-build`;
}

export function installCommand(plan: InstallPlan): string[] {
  if (plan.installer === 'npm') return ['npm', plan.lockfile ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (!['pnpm', 'yarn-classic', 'yarn-berry'].includes(plan.installer)) throw new Error('Unsupported package manager');
  const bin = runnerFor(plan);
  if (plan.pinned !== null && !(PACKAGE_MANAGER_FIELD.test(plan.pinned) && plan.pinned.startsWith(`${bin}@`))) throw new Error('Invalid packageManager version');
  if (plan.pinned === null && !RANGE.test(plan.fallbackRange ?? '')) throw new Error('Invalid package manager version range');
  const activate = plan.pinned ? 'corepack install' : `corepack install -g ${bin}@${plan.fallbackRange}`;
  return ['/bin/sh', '-c', `corepack enable ${bin} && ${activate} && ${managerCommand(plan)}`];
}
