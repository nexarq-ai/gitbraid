import { repositoryLabel } from "../shared/repository-names";
import type { ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import {
  GitBranchIcon,
  RobotIcon,
  ShieldCheckIcon,
  GitCommitIcon,
  ArrowUpRightIcon,
  CheckIcon,
  PlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { MissionSummary, Workspace } from "../shared/types";

export const statusLabels: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  checking: "Checking",
  needs_review: "Needs review",
  approved: "Approved",
  integrating: "Landing changes",
  integrated: "Landed",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Completed",
  pending: "Pending",
  passed: "Passed",
  skipped: "Skipped",
  ready: "Ready",
  blocked: "Not connected",
  local: "Local",
  connected: "Connected",
};

export function Status({ status }: { status: string }) {
  return (
    <span className={`pill ${status === "needs_review" ? "review" : status}`}>
      <span className="pill-dot" />
      {statusLabels[status] ?? status}
    </span>
  );
}

export function relativeTime(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function BranchIllustration() {
  return (
    <div
      className="branch-illustration"
      role="img"
      aria-label="A revision splits into two independent agents, then joins for review"
    >
      <svg
        className="branch-lines"
        viewBox="0 0 480 220"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M72 110H130Q145 110 145 95V90Q145 75 160 75H205M72 110H130Q145 110 145 125V130Q145 145 160 145H205M275 75H320Q335 75 335 90V95Q335 110 350 110H408M275 145H320Q335 145 335 130V125Q335 110 350 110H408"
          fill="none"
          stroke="#cdd7e6"
          strokeWidth="1.4"
        />
        <path d="M350 110H408" fill="none" stroke="#e8b287" strokeWidth="1.4" />
      </svg>
      <div className="flow-start">
        <div className="flow-node">
          <GitCommitIcon size={23} />
        </div>
        <span>Your intent</span>
      </div>
      <div className="flow-agents">
        <div className="flow-agent">
          <RobotIcon size={22} />
          <div>
            <strong>Agent 01</strong>
            <small>Independent fork</small>
          </div>
        </div>
        <div className="flow-agent">
          <RobotIcon size={22} />
          <div>
            <strong>Agent 02</strong>
            <small>Independent fork</small>
          </div>
        </div>
      </div>
      <div className="flow-end">
        <div className="flow-node">
          <ShieldCheckIcon size={23} />
        </div>
        <span>Your review</span>
      </div>
      <div className="flow-caption">
        One shared goal. Independent work. Verified together.
      </div>
    </div>
  );
}

export function Welcome({
  onCreate,
  onLearn,
}: {
  onCreate: () => void;
  onLearn: () => void;
}) {
  return (
    <section className="welcome-panel">
      <div className="welcome-copy">
        <div className="eyebrow">
          <GitBranchIcon size={14} /> Built for humans and agents
        </div>
        <h2>
          Many agents.
          <br />
          One clear path to land changes.
        </h2>
        <p>
          Give your agents room to build. Bring their work together with the
          context to review it.
        </p>
        <div className="welcome-actions">
          <Button
            variant="primary"
            size="base"
            icon={PlusIcon}
            onClick={onCreate}
          >
            Create a mission
          </Button>
          <button className="text-link" onClick={onLearn}>
            How it works <ArrowUpRightIcon size={13} />
          </button>
        </div>
      </div>
      <BranchIllustration />
    </section>
  );
}

export function MissionTable({
  missions,
  workspace,
  onOpen,
}: {
  missions: MissionSummary[];
  workspace: Workspace;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="resource-table">
        <thead>
          <tr>
            <th>Mission</th>
            <th>Status</th>
            <th>Agents</th>
            <th>Updated</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {missions.map((mission) => (
            <tr key={mission.id}>
              <td>
                <div className="resource-name">
                  <GitBranchIcon size={18} />
                  <div>
                    <button onClick={() => onOpen(mission.id)}>
                      {mission.title}
                    </button>
                    <small>
                      {repositoryLabel(workspace.repositories.find(
                        (repo) => repo.id === mission.repositoryId,
                      ) ?? { name: "Repository" })}
                    </small>
                  </div>
                </div>
              </td>
              <td>
                <Status status={mission.status} />
              </td>
              <td>
                {mission.runs.length ? (
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 5 }}
                  >
                    <RobotIcon size={13} />
                    {mission.runs.length}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>{relativeTime(mission.updatedAt)}</td>
              <td>
                <Button
                  variant="ghost"
                  size="base"
                  shape="square"
                  aria-label={`Open ${mission.title}`}
                  icon={ArrowUpRightIcon}
                  onClick={() => onOpen(mission.id)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SetupSteps({
  workspace,
  onRepository,
  onMission,
  onSettings,
}: {
  workspace: Workspace;
  onRepository: () => void;
  onMission: () => void;
  onSettings: () => void;
}) {
  const ready = workspace.integrations
    .filter((item) => item.id !== "auth")
    .every((item) => item.ready);
  const steps = [
    {
      title: "Create your first repository",
      description: "A home for your code and agent work.",
      done: workspace.repositories.length > 0,
      action: onRepository,
      label: "Create repository",
    },
    {
      title: "Connect your execution tools",
      description: "Link Git storage, a runner, and a model.",
      done: ready,
      action: onSettings,
      label: "View connections",
    },
    {
      title: "Give your agents a mission",
      description: "Describe an outcome worth building.",
      done: workspace.missions.length > 0,
      action: onMission,
      label: "Create mission",
    },
  ];
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Get started</h2>
        <span className="number-tag">
          {steps.filter((step) => step.done).length} of 3
        </span>
      </div>
      <ol className="setup-list">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className={`step-number ${step.done ? "complete" : ""}`}>
              {step.done ? <CheckIcon size={12} /> : index + 1}
            </span>
            <div className="setup-step">
              <h3>{step.title}</h3>
              <p>{step.description}</p>
              {!step.done && (
                <button className="text-link" onClick={step.action}>
                  {step.label}
                  <ArrowUpRightIcon size={11} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="alert error" role="alert">
      <WarningCircleIcon size={17} />
      <div className="alert-text">{message}</div>
      {onRetry && (
        <button className="text-link" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
