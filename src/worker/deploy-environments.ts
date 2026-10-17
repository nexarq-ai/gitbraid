export type DeployEnvironment = string;

export const PRODUCTION = 'production';
export const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const DEPLOY_ENVIRONMENTS_MAX = 10;

export function validEnvironmentName(value: unknown): value is DeployEnvironment {
  return typeof value === 'string' && ENVIRONMENT_NAME.test(value);
}

export function orderedEnvironments(names: Iterable<string>): DeployEnvironment[] {
  const all = [...new Set(names)];
  const others = all.filter((name) => validEnvironmentName(name) && name !== PRODUCTION && name !== 'staging').sort();
  return [PRODUCTION, ...(all.includes('staging') ? ['staging'] : []), ...others];
}
