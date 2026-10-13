import type { ArtifactRepo, ArtifactsBinding } from './artifacts';
import { ApiError, repositoryRef } from './domain';
import { validGitSha } from './artifacts';

export const skillRoots = ['.agents/skills', '.claude/skills', 'skills', 'docs/skills'] as const;
export interface RepositorySkill { name: string; description: string; path: string; }
export interface RepositorySkills { ref: string; commitSha: string; skills: RepositorySkill[]; roots: readonly string[]; truncated: boolean; skipped: number; }

export function skillFrontmatter(content: string): { name: string; description: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  function field(key: string): string {
    const value = new RegExp(`^${key}:[ \t]*(.*)$`, 'm').exec(frontmatter ?? '')?.[1]?.trim() ?? '';
    if (['>', '|', '>-', '|-'].includes(value)) {
      const lines = new RegExp(`^${key}:.*\\r?\\n((?:[ \t]+.*(?:\\r?\\n|$))+)`, 'm').exec(frontmatter ?? '')?.[1];
      return (lines ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' ');
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : ''; } catch { return value.slice(1, -1); }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
  }
  return { name: field('name'), description: field('description') };
}

export function skillMetadata(content: string, path: string): RepositorySkill {
  const fields = skillFrontmatter(content);
  return { name: (fields.name || path.split('/').at(-2) || 'Repository skill').slice(0, 200), description: fields.description.slice(0, 2000), path };
}

export interface RepositorySkillContext extends RepositorySkill { content: string; commitSha: string; sha256: string; }
export interface RepositorySkillRuntime { commitSha: string; skills: RepositorySkillContext[]; warnings: string[]; }

async function collectRepositorySkills(source: ArtifactRepo, ref: string, byteLimit: number, requireExactCommit: boolean): Promise<RepositorySkills & { contents: RepositorySkillContext[]; warnings: string[] }> {
  const selected = repositoryRef(ref);
  const commit = (await source.log({ ref: selected, limit: 1 }))[0];
  if (!commit) throw new ApiError(404, 'REF_NOT_FOUND', 'This reference has no commit yet. Push an initial revision to discover repository skills.');
  if (requireExactCommit && commit.hash !== ref) throw new Error('Repository skill source did not resolve to the pinned base commit');
  const result: RepositorySkills & { contents: RepositorySkillContext[]; warnings: string[] } = { ref: selected, commitSha: commit.hash, skills: [], roots: skillRoots, truncated: false, skipped: 0, contents: [], warnings: [] };
  const cache = new Map<string, ArtifactsTreeEntry[] | null>();
  let trees = 0; let entries = 0; let bytes = 0; let files = 0; let omittedWarnings = 0;
  function warning(reason: string) {
    if (result.warnings.includes(reason)) return;
    if (result.warnings.length < 49) result.warnings.push(reason);
    else omittedWarnings++;
  }
  async function tree(hash: string) {
    if (cache.has(hash)) return cache.get(hash)!;
    if (++trees > 128) { result.truncated = true; warning('Skill discovery stopped at the 128-tree traversal limit.'); return null; }
    const value = await source.readTree(hash);
    if (!value) { warning('A repository tree was unavailable; some skills could not be discovered.'); return null; }
    if ((entries += value.length) > 5000) { result.truncated = true; warning('Skill discovery stopped at the 5000-entry traversal limit.'); return null; }
    cache.set(hash, value); return value;
  }
  async function scan(hash: string, path: string, depth: number): Promise<void> {
    const children = await tree(hash);
    for (const entry of [...(children ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name || /[\\/\0\r\n]/.test(entry.name) || ['.', '..'].includes(entry.name)) { warning('Skipped an invalid skill tree entry.'); continue; }
      const location = `${path}/${entry.name}`;
      if (entry.type === 'tree' && entry.mode !== '120000') {
        if (depth >= 6) { result.truncated = true; warning(`Skipped ${location}: skill discovery depth limit reached.`); continue; }
        await scan(entry.hash, location, depth + 1);
      } else if (entry.type === 'symlink' && entry.name !== 'SKILL.md') {
        warning(`Skipped ${location}: symlink directories and instructions are not followed.`);
      } else if (entry.name === 'SKILL.md') {
        if (!['blob', 'exec'].includes(entry.type) || entry.mode === '120000') { result.skipped++; warning(`Skipped ${location}: skill files must be regular files.`); continue; }
        if (++files > 50) { result.truncated = true; warning('Additional skill files were omitted after the 50-file limit.'); continue; }
        const blob = await source.readFile({ ref: commit.hash, path: location });
        if (!blob || blob.size > 65536) { result.skipped++; warning(`Skipped ${location}: file unavailable or larger than 64 KiB.`); continue; }
        if (bytes + blob.size > byteLimit) { result.truncated = true; warning(`Omitted ${location}: complete file exceeds the ${byteLimit}-byte skill context budget.`); continue; }
        try {
          const buffer = await blob.arrayBuffer();
          const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          if (content.includes('\0')) throw new Error('Binary file');
          const metadata = skillMetadata(content, location);
          const digest = await crypto.subtle.digest('SHA-256', buffer);
          const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
          bytes += blob.size;
          result.skills.push(metadata);
          result.contents.push({ ...metadata, content, commitSha: commit.hash, sha256 });
        } catch { result.skipped++; warning(`Skipped ${location}: invalid UTF-8 or binary skill content.`); }
      }
    }
  }
  for (const root of skillRoots) {
    let hash: string | undefined = commit.treeHash;
    for (const segment of root.split('/')) {
      const entry: ArtifactsTreeEntry | undefined = (await tree(hash))?.find(entry => entry.name === segment);
      if (entry && entry.type !== 'tree') warning(`Skipped ${root}: skill root is not a directory.`);
      hash = entry?.type === 'tree' ? entry.hash : undefined;
      if (!hash) break;
    }
    if (hash) await scan(hash, root, 0);
  }
  if (omittedWarnings) result.warnings.push(`${omittedWarnings} additional skill discovery warnings were omitted from the bounded warning list.`);
  result.skills.sort((a, b) => a.path.localeCompare(b.path));
  result.contents.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export async function discoverRepositorySkills(source: ArtifactRepo, ref: string): Promise<RepositorySkills> {
  const { contents: _contents, warnings: _warnings, ...result } = await collectRepositorySkills(source, ref, 524288, false);
  return result;
}

export async function loadRepositorySkillContext(source: ArtifactRepo, commitSha: string): Promise<RepositorySkillRuntime> {
  if (!validGitSha(commitSha)) throw new Error('Repository skills require an immutable base commit');
  const result = await collectRepositorySkills(source, commitSha, 32768, true);
  return { commitSha, skills: result.contents, warnings: result.warnings };
}

export async function listRepositorySkills(artifacts: ArtifactsBinding | undefined, repository: { name: string; provider: string; defaultBranch: string }, ref?: string): Promise<RepositorySkills> {
  if (!artifacts || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to discover its skills.');
  using source = await artifacts.get(repository.name);
  return await discoverRepositorySkills(source, ref || repository.defaultBranch);
}
