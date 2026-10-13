export interface ArtifactInfo {
  name: string;
  remote: string;
  defaultBranch: string;
}

export interface ArtifactCommit {
  hash: string;
  message: string;
  treeHash: string;
}

export interface ArtifactRepo extends Disposable {
  info(): Promise<ArtifactInfo>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  fork(name: string, options?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<ArtifactInfo & { token: string }>;
  createToken(scope: 'read' | 'write', ttl: number): Promise<{ plaintext: string; expiresAt: string }>;
  revokeToken(token: string): Promise<boolean>;
  log(options?: { ref?: string; limit?: number }): Promise<ArtifactCommit[]>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
}

export interface ArtifactsBinding {
  get(name: string): Promise<ArtifactRepo>;
  create(name: string, options?: { description?: string; setDefaultBranch?: string }): Promise<ArtifactInfo & { token: string }>;
}

export async function forkRepository(artifacts: ArtifactsBinding, source: string, name: string): Promise<ArtifactInfo> {
  using repository = await artifacts.get(source);
  const fork = await repository.fork(name, { defaultBranchOnly: true, readOnly: false, description: 'Gitflare isolated mission workspace' });
  using forkHandle = await waitForFork(artifacts, fork.name);
  await forkHandle.revokeToken(fork.token);
  return { name: fork.name, remote: fork.remote, defaultBranch: fork.defaultBranch };
}

export async function repositoryHead(artifacts: ArtifactsBinding, name: string, branch: string): Promise<string | null> {
  using repository = await artifacts.get(name);
  const commits = await repository.log({ ref: branch, limit: 1 });
  return commits[0]?.hash ?? null;
}

export function validGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export async function getArtifactsHead(env: { ARTIFACTS?: ArtifactsBinding }, repository: { name: string; defaultBranch: string }): Promise<string | null> {
  if (!env.ARTIFACTS) throw new Error('Artifacts is not configured');
  return repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch);
}

export async function createArtifactsRepository(env: { ARTIFACTS?: ArtifactsBinding }, input: { name: string; description?: string }): Promise<{ remote: string; headSha: null }> {
  if (!env.ARTIFACTS) throw new Error('Artifacts is not configured');
  const created = await env.ARTIFACTS.create(input.name, { description: input.description, setDefaultBranch: 'main' });
  using repository = await env.ARTIFACTS.get(created.name);
  await repository.revokeToken(created.token);
  return { remote: created.remote, headSha: null };
}

export async function waitForFork(artifacts: ArtifactsBinding, name: string): Promise<ArtifactRepo> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await artifacts.get(name); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'FORK_IN_PROGRESS' || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)));
    }
  }
  throw new Error('Artifact fork did not become ready');
}
