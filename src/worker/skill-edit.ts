import type { CreateMissionInput, RepositorySkillChange } from '../shared/types';
import type { ArtifactRepo, ArtifactsBinding } from './artifacts';
import { ApiError } from './domain';
import { skillFrontmatter } from './repository-skills';

export const SKILL_REQUEST_MAX_BYTES = 400_000;
export const SKILL_CONTENT_MAX_BYTES = 65_536;
export const mutableSkillPath = /^docs\/skills\/[a-z0-9-]{1,64}\/SKILL\.md$/;

export function validateRepositorySkillChange(value: unknown): RepositorySkillChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_SKILL_CHANGE', 'Provide a skill action, path, content and baseSha.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['action', 'path', 'content', 'baseSha'].includes(key))) throw new ApiError(400, 'INVALID_SKILL_CHANGE', 'Only action, path, content and baseSha are supported.');
  if (input.action !== 'create' && input.action !== 'update') throw new ApiError(400, 'INVALID_SKILL_ACTION', 'Choose create or update.');
  if (typeof input.path !== 'string' || !mutableSkillPath.test(input.path)) throw new ApiError(400, 'INVALID_SKILL_PATH', 'Editable skills use docs/skills/<lowercase slug>/SKILL.md with a 1–64 character slug.');
  if (typeof input.baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.baseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Provide the exact 40 character lowercase base commit SHA.');
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.content)) throw new ApiError(400, 'INVALID_SKILL_CONTENT', 'Skill content must be nonempty UTF-8 Markdown without NUL characters.');
  if (new TextEncoder().encode(input.content).byteLength > SKILL_CONTENT_MAX_BYTES) throw new ApiError(413, 'SKILL_TOO_LARGE', 'Skill content must not exceed 64 KiB.');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input.content)?.[1];
  const metadata = skillFrontmatter(input.content);
  if (!frontmatter || !metadata.name.trim() || !metadata.description.trim()) throw new ApiError(400, 'INVALID_SKILL_METADATA', 'Start the skill with YAML frontmatter containing a nonempty name and description.');
  return { action: input.action, path: input.path, content: input.content, baseSha: input.baseSha };
}

export function skillMissionInput(repositoryId: string, change: RepositorySkillChange): CreateMissionInput {
  const verb = change.action === 'create' ? 'Create' : 'Update';
  return { repositoryId, title: `${verb} skill: ${change.path.split('/')[2]}`,
    prompt: `${verb} the repository skill at ${change.path} with the exact submitted Markdown. Run the existing repository checks before review.`,
    acceptanceCriteria: ['Apply only the submitted skill file with its exact content.', 'Pass the existing repository checks and review the exact candidate before landing.'],
    skillChange: change };
}

export async function verifySkillChangeAtHead(source: ArtifactRepo, defaultBranch: string, change: RepositorySkillChange): Promise<void> {
  const commit = (await source.log({ ref: defaultBranch, limit: 1 }))[0];
  if (!commit || commit.hash !== change.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill and review your edit against its current revision.');
  const segments = change.path.split('/');
  let treeHash = commit.treeHash;
  let target: ArtifactsTreeEntry | undefined;
  for (let index = 0; index < segments.length; index++) {
    const tree = await source.readTree(treeHash);
    if (!tree) throw new ApiError(409, 'SKILL_TREE_UNAVAILABLE', 'The pinned repository tree could not be verified.');
    const entry = tree.find(item => item.name === segments[index]);
    if (!entry) break;
    if (index === segments.length - 1) { target = entry; break; }
    if (entry.type !== 'tree') throw new ApiError(409, 'UNSAFE_SKILL_PATH', 'Every parent of an editable skill must be a regular repository directory.');
    treeHash = entry.hash;
  }
  if (change.action === 'create' && target) throw new ApiError(409, 'SKILL_EXISTS', 'A file already exists at this path. Refresh and use Update.');
  if (change.action === 'update' && !target) throw new ApiError(404, 'SKILL_NOT_FOUND', 'This skill does not exist at the selected base commit.');
  if (target && !['blob', 'exec'].includes(target.type)) throw new ApiError(409, 'UNSAFE_SKILL_PATH', 'Only regular skill files can be updated.');
}

export async function verifyRepositorySkillChange(artifacts: ArtifactsBinding | undefined, repository: { name: string; provider: string; defaultBranch: string }, change: RepositorySkillChange): Promise<void> {
  if (!artifacts || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository before proposing a skill edit.');
  using source = await artifacts.get(repository.name);
  await verifySkillChangeAtHead(source, repository.defaultBranch, change);
}
