const ISOLATED_PREFIX = /^w-[a-f0-9]{32}-/;

export function repositoryLabel(repository: { name: string; displayName?: string }): string {
  return repository.displayName ?? repository.name.replace(ISOLATED_PREFIX, '');
}
