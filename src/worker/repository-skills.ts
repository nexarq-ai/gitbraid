import type { ArtifactRepo, ArtifactsBinding } from './artifacts';
import { ApiError, repositoryRef } from './domain';

export const skillRoots = ['.agents/skills', '.claude/skills', 'skills', 'docs/skills'] as const;
export interface RepositorySkill { name: string; description: string; path: string; }
export interface RepositorySkills { ref: string; commitSha: string; skills: RepositorySkill[]; roots: readonly string[]; truncated: boolean; skipped: number; }

export function skillMetadata(content: string, path: string): RepositorySkill {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  function field(key: string): string {
    const value = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter ?? '')?.[1]?.trim() ?? '';
    if (['>', '|', '>-', '|-'].includes(value)) {
      const lines = new RegExp(`^${key}:.*\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$))+)`, 'm').exec(frontmatter ?? '')?.[1];
      return (lines ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' ');
    }
    return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { name: (field('name') || path.split('/').at(-2) || 'Repository skill').slice(0, 200), description: field('description').slice(0, 2000), path };
}

export async function discoverRepositorySkills(source: ArtifactRepo, ref: string): Promise<RepositorySkills> {
  const selected = repositoryRef(ref);
  const commit = (await source.log({ ref: selected, limit: 1 }))[0];
  if (!commit) throw new ApiError(404, 'REF_NOT_FOUND', 'This reference has no commit yet. Push an initial revision to discover repository skills.');
  const result: RepositorySkills = { ref: selected, commitSha: commit.hash, skills: [], roots: skillRoots, truncated: false, skipped: 0 };
  const cache = new Map<string, ArtifactsTreeEntry[] | null>();
  let trees = 0; let entries = 0; let bytes = 0; let files = 0;
  async function tree(hash: string) {
    if (cache.has(hash)) return cache.get(hash)!;
    if (++trees > 128) { result.truncated = true; return null; }
    const value = await source.readTree(hash);
    if ((entries += value?.length ?? 0) > 5000) { result.truncated = true; return null; }
    cache.set(hash, value); return value;
  }
  async function scan(hash: string, path: string, depth: number): Promise<void> {
    const children = await tree(hash);
    for (const entry of [...(children ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name || entry.name.includes('/') || ['.', '..'].includes(entry.name)) continue;
      const location = `${path}/${entry.name}`;
      if (entry.type === 'tree') {
        if (depth >= 6) { result.truncated = true; continue; }
        await scan(entry.hash, location, depth + 1);
      } else if (entry.name === 'SKILL.md' && ['blob', 'exec'].includes(entry.type)) {
        if (++files > 50) { result.truncated = true; continue; }
        const blob = await source.readFile({ ref: commit.hash, path: location });
        if (!blob || blob.size > 65536) { result.skipped++; continue; }
        if ((bytes += blob.size) > 524288) { result.truncated = true; continue; }
        try {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
          if (content.includes('\0')) { result.skipped++; continue; }
          result.skills.push(skillMetadata(content, location));
        } catch { result.skipped++; }
      }
    }
  }
  for (const root of skillRoots) {
    let hash: string | undefined = commit.treeHash;
    for (const segment of root.split('/')) {
      hash = (await tree(hash))?.find(entry => entry.type === 'tree' && entry.name === segment)?.hash;
      if (!hash) break;
    }
    if (hash) await scan(hash, root, 0);
  }
  result.skills.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export async function listRepositorySkills(artifacts: ArtifactsBinding | undefined, repository: { name: string; provider: string; defaultBranch: string }, ref?: string): Promise<RepositorySkills> {
  if (!artifacts || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to discover its skills.');
  using source = await artifacts.get(repository.name);
  return await discoverRepositorySkills(source, ref || repository.defaultBranch);
}
