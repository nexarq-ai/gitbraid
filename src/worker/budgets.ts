import type { Mission } from '../shared/types';

export const AGENT_CONCURRENCY = 3;
export const AGENT_BUDGET_MS = 600_000;
export const RUNNER_PREPARE_MS = 600_000;
export const INSTALL_ATTEMPT_MS = 300_000;
export const INSTALL_BUDGET_MS = 2 * INSTALL_ATTEMPT_MS + 5_000;
export const TEST_BUDGET_MS = 300_000;
export const GIT_ALLOWANCE_MS = 300_000;
export const PREVIEW_READINESS_MAX_MS = 180_000;
const REPORTING_MARGIN_MS = 600_000;

const VERIFY_MS = RUNNER_PREPARE_MS + GIT_ALLOWANCE_MS + 2 * INSTALL_BUDGET_MS + 2 * TEST_BUDGET_MS;
export const AGENT_RUN_MS = RUNNER_PREPARE_MS + 2 * GIT_ALLOWANCE_MS + INSTALL_BUDGET_MS + AGENT_BUDGET_MS + VERIFY_MS;
export const COMBINE_MS = RUNNER_PREPARE_MS + 2 * GIT_ALLOWANCE_MS + VERIFY_MS;
export const LANDING_STEP_MS = RUNNER_PREPARE_MS + 2 * GIT_ALLOWANCE_MS + REPORTING_MARGIN_MS;
export const PREVIEW_STEP_MS = RUNNER_PREPARE_MS + GIT_ALLOWANCE_MS + INSTALL_BUDGET_MS + PREVIEW_READINESS_MAX_MS + REPORTING_MARGIN_MS;

type MissionShape = Pick<Mission, 'runs' | 'mode' | 'skillChange' | 'revertChange' | 'branchChange'>;

export function agentWaves(mission: MissionShape): number {
  const trusted = !!(mission.skillChange || mission.revertChange || mission.branchChange);
  return trusted ? 1 : Math.ceil(Math.max(1, mission.runs.length) / AGENT_CONCURRENCY);
}

export function missionStepTimeoutMs(mission: MissionShape): number {
  const trusted = !!(mission.skillChange || mission.revertChange || mission.branchChange);
  const combined = !trusted && mission.mode !== 'race' && mission.runs.length > 1;
  return agentWaves(mission) * AGENT_RUN_MS + (combined ? COMBINE_MS : 0) + REPORTING_MARGIN_MS;
}
