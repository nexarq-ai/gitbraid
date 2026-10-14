import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { Mission, MissionAttempt } from "../shared/types";
import { request } from "./api";
import { EmptyState, ErrorNotice, Status } from "./components";
import AgentAssignment from "./AgentAssignment";
import { RouteProgress } from "./WorkspaceLoader";

const reasonLabels: Record<MissionAttempt["reason"], string> = {
  completed: "Execution finished",
  retry: "Saved before retry",
  cancelled: "Cancelled",
  approved: "Owner approved",
  approval_revoked: "Approval revoked",
  integration_failed: "Landing failed",
  integration_uncertain: "Landing needs reconciliation",
  integrated: "Landed in repository",
};

export default function AttemptHistory({ mission }: { mission: Mission }) {
  const [attempts, setAttempts] = useState<MissionAttempt[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void request<{ attempts: MissionAttempt[] }>(
      `/api/missions/${encodeURIComponent(mission.id)}/attempts`,
    ).then(
      (result) => {
        if (!active) return;
        setAttempts(result.attempts);
        setError("");
      },
      (failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load attempt history.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [mission.id, mission.updatedAt, revision]);

  const checkpoint = attempts?.find((attempt) => attempt.id === selected);

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <h2>Attempt history</h2>
          <Button
            variant="secondary"
            size="base"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
        <div className="panel-body attempt-history-intro">
          <p>
            Saved checkpoints preserve each attempt, its checks, and owner
            decisions. Several checkpoints can belong to the same attempt.
          </p>
          <span>Current attempt: {mission.epoch || "Not started"}</span>
        </div>
        {error && (
          <ErrorNotice
            message={error}
            onRetry={() => setRevision((value) => value + 1)}
          />
        )}
        {!attempts && !error && (
          <RouteProgress />
        )}
        {attempts?.length === 0 && (
          <EmptyState
            icon={<ClockCounterClockwiseIcon size={25} />}
            title="No checkpoints saved yet"
            description="Checkpoints appear when execution finishes, a mission is retried, or an owner makes a review decision. Earlier runs may not have a saved checkpoint."
          />
        )}
        {!!attempts?.length && (
          <div className="table-scroll">
            <table className="resource-table">
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Checkpoint</th>
                  <th>Status</th>
                  <th>Saved</th>
                  <th aria-label="Inspect" />
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr
                    key={attempt.id}
                    className={
                      selected === attempt.id
                        ? "selected-checkpoint"
                        : undefined
                    }
                  >
                    <td>{attempt.epoch}</td>
                    <td>{reasonLabels[attempt.reason]}</td>
                    <td>
                      <Status status={attempt.snapshot.status} />
                    </td>
                    <td>{new Date(attempt.recordedAt).toLocaleString()}</td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => setSelected(attempt.id)}
                        aria-pressed={selected === attempt.id}
                      >
                        Inspect
                        <span className="sr-only">
                          {" "}
                          attempt {attempt.epoch},{" "}
                          {reasonLabels[attempt.reason]}
                        </span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {checkpoint && <Snapshot key={checkpoint.id} checkpoint={checkpoint} />}
    </>
  );
}

function Snapshot({ checkpoint }: { checkpoint: MissionAttempt }) {
  const snapshot = checkpoint.snapshot;
  return (
    <section className="panel attempt-snapshot">
      <div className="panel-header">
        <h2>
          Attempt {checkpoint.epoch} · {reasonLabels[checkpoint.reason]}
        </h2>
        <span className="number-tag">Read-only checkpoint</span>
      </div>
      <div className="panel-body">
        <p className="mission-prompt">{snapshot.prompt}</p>
        {!!snapshot.acceptanceCriteria?.length && (
          <ul className="acceptance-list">
            {snapshot.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
        )}
        <dl className="snapshot-metadata">
          <dt>Base revision</dt>
          <dd>
            <code>{snapshot.baseSha ?? "Not assigned"}</code>
          </dd>
          <dt>Candidate revision</dt>
          <dd>
            <code>{snapshot.candidateSha ?? "No candidate"}</code>
          </dd>
          <dt>Approval</dt>
          <dd>
            {snapshot.approvedAt
              ? `${snapshot.approvedBy ?? "Owner"} · ${new Date(snapshot.approvedAt).toLocaleString()}`
              : "No active approval at this checkpoint"}
          </dd>
        </dl>
        {snapshot.error && <ErrorNotice message={snapshot.error} />}
        <details className="snapshot-section" open>
          <summary>Agents ({snapshot.runs.length})</summary>
          {snapshot.runs.map((run) => (
            <article className="snapshot-agent" key={run.id}>
              <div className="snapshot-item-heading">
                <h3>
                  {run.name} <small>{run.role}</small>
                </h3>
                <Status status={run.status} />
              </div>
              <AgentAssignment run={run} mission={snapshot} />
              {run.summary && <p>{run.summary}</p>}
              {run.error && <p className="snapshot-error">{run.error}</p>}
              <dl className="snapshot-metadata">
                <dt>Fork</dt>
                <dd>
                  <code>{run.forkName ?? "Not allocated"}</code>
                </dd>
                <dt>Revision</dt>
                <dd>
                  <code>{run.commitSha ?? "No revision yet"}</code>
                </dd>
                <dt>Model</dt>
                <dd>{run.model ?? "Not recorded"}</dd>
              </dl>
            </article>
          ))}
        </details>
        <details className="snapshot-section">
          <summary>Checks ({snapshot.checks.length})</summary>
          {snapshot.checks.map((check) => (
            <article className="snapshot-agent" key={check.id}>
              <div className="snapshot-item-heading">
                <h3>{check.name}</h3>
                <Status status={check.status} />
              </div>
              {check.candidateSha && (
                <p>
                  <code>{check.candidateSha}</code>
                </p>
              )}
              {check.output && (
                <pre className="code-output">{check.output}</pre>
              )}
            </article>
          ))}
        </details>
        <details className="snapshot-section">
          <summary>Changes ({snapshot.changes.length})</summary>
          {snapshot.changes.map((change) => (
            <article className="snapshot-agent" key={change.path}>
              <h3>
                <code>{change.path}</code>{" "}
                <small>
                  +{change.additions} / −{change.deletions}
                </small>
              </h3>
              <pre className="code-output">
                {change.patch || "No patch was recorded."}
              </pre>
            </article>
          ))}
        </details>
        <details className="snapshot-section">
          <summary>Activity ({snapshot.events.length})</summary>
          <ol className="timeline">
            {[...snapshot.events].reverse().map((event) => (
              <li key={event.id}>
                <span className="timeline-marker" />
                <p>{event.message}</p>
                <small>{new Date(event.timestamp).toLocaleString()}</small>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </section>
  );
}
