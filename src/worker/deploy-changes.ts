import type { ArtifactRepo } from './artifacts';

export const WATCH_PATHS_MAX = 20;
export const CHANGED_PATHS_LIMIT = 20_000;
const globCharacters = /[*?]/;

function globExpression(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

function matcher(glob: string): (path: string) => boolean {
  const clean = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!globCharacters.test(clean)) return (path) => path === clean || path.startsWith(`${clean}/`);
  const expression = globExpression(clean);
  return (path) => expression.test(path);
}

export function validWatchPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const glob = value.startsWith('!') ? value.slice(1) : value;
  return !!glob && glob.length <= 200 && !glob.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(glob) && !/[\u0000-\u001f\u007f\\]/.test(glob);
}

export function watchPathsMatch(watchPaths: string[] | undefined, paths: string[]): boolean {
  if (!watchPaths?.length) return true;
  const includes = watchPaths.filter((glob) => !glob.startsWith('!')).map(matcher);
  const excludes = watchPaths.filter((glob) => glob.startsWith('!')).map((glob) => matcher(glob.slice(1)));
  return paths.some((path) => (!includes.length || includes.some((match) => match(path))) && !excludes.some((match) => match(path)));
}

type TreeSource = Pick<ArtifactRepo, 'readTree' | 'log'>;

async function treeHash(source: TreeSource, commit: string): Promise<string | null> {
  const [entry] = await source.log({ ref: commit, limit: 1 });
  return entry?.hash === commit ? entry.treeHash : null;
}

export async function changedPaths(source: TreeSource, base: string, head: string, limit = CHANGED_PATHS_LIMIT): Promise<string[] | null> {
  const [baseTree, headTree] = await Promise.all([treeHash(source, base), treeHash(source, head)]);
  if (!baseTree || !headTree) return null;
  const changed: string[] = [];
  const walk = async (before: string | null, after: string | null, prefix: string): Promise<boolean> => {
    if (before === after) return true;
    const [left, right] = await Promise.all([before ? source.readTree(before) : [], after ? source.readTree(after) : []]);
    if (!left || !right) return false;
    const names = new Set([...left.map((entry) => entry.name), ...right.map((entry) => entry.name)]);
    for (const name of names) {
      const a = left.find((entry) => entry.name === name);
      const b = right.find((entry) => entry.name === name);
      if (a && b && a.hash === b.hash && a.mode === b.mode) continue;
      const path = `${prefix}${name}`;
      const aTree = a?.type === 'tree' ? a.hash : null;
      const bTree = b?.type === 'tree' ? b.hash : null;
      if (aTree || bTree) { if (!await walk(aTree, bTree, `${path}/`)) return false; }
      if ((a && a.type !== 'tree') || (b && b.type !== 'tree')) changed.push(path);
      if (changed.length > limit) return false;
    }
    return true;
  };
  return await walk(baseTree, headTree, '') ? changed : null;
}
