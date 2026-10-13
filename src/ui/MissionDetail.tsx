import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ClockIcon,
  CodeIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  PlayIcon,
  RobotIcon,
  ShieldCheckIcon,
  StopIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { Mission, Workspace } from "../shared/types";
import { request } from "./api";
import { EmptyState, ErrorNotice, relativeTime, Status } from "./components";
import AgentAssignment from "./AgentAssignment";
import AttemptHistory from "./AttemptHistory";

type Props = {
  id: string;
  permissions: string[];
  workspace: Workspace;
  onBack: () => void;
  onUpdate: () => void;
};

export default function MissionDetail({
  id,
  permissions,
  workspace,
  onBack,
  onUpdate,
}: Props) {
  const [mission, setMission] = useState<Mission | undefined>(() =>
    workspace.missions.find((item) => item.id === id),
  );
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<{
    previewUrl: string;
    candidateSha: string;
    expiresAt: string;
  } | null>(null);
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const repository = workspace.repositories.find(
    (item) => item.id === mission?.repositoryId,
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await request<Mission>(
          `/api/missions/${encodeURIComponent(id)}`,
        );
        if (active) {
          setMission(result);
          setLoadError("");
        }
      } catch (failure) {
        if (active)
          setLoadError(
            failure instanceof Error
              ? failure.message
              : "Could not load this mission.",
          );
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [id]);

  async function act(
    action: "start" | "cancel" | "approve" | "integrate" | "revoke",
  ) {
    if (!mission || busy) return;
    setBusy(action);
    setError("");
    const body =
      action === "approve" || action === "integrate" || action === "revoke"
        ? { candidateSha: mission.candidateSha, baseSha: mission.baseSha }
        : {};
    const signature = JSON.stringify({
      id,
      epoch: mission.epoch,
      action,
      body,
    });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/${action}`,
        body,
        mutation.current.key,
      );
      setMission(result);
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The mission could not be updated.",
      );
    } finally {
      setBusy("");
    }
  }

  async function preparePreview() {
    if (!mission?.candidateSha || busy) return;
    setBusy("preview");
    setError("");
    const signature = JSON.stringify({
      id,
      action: "preview",
      candidateSha: mission.candidateSha,
    });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<{
        previewUrl: string;
        candidateSha: string;
        expiresAt: string;
      }>(
        `/api/missions/${encodeURIComponent(id)}/preview`,
        {},
        mutation.current.key,
      );
      if (
        result.candidateSha !== mission.candidateSha ||
        new URL(result.previewUrl).protocol !== "https:" ||
        !(Date.parse(result.expiresAt) > Date.now())
      ) {
        throw new Error(
          "The preview does not match this candidate or has expired. Create a new preview.",
        );
      }
      setPreview(result);
      mutation.current = null;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The preview could not be prepared.",
      );
    } finally {
      setBusy("");
    }
  }

  if (!mission)
    return (
      <>
        <button className="header-back" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          All missions
        </button>
        {loadError ? (
          <ErrorNotice message={loadError} />
        ) : (
          <div className="loading-state">Loading mission…</div>
        )}
      </>
    );
  const active = ["queued", "running", "checking"].includes(mission.status);
  const overlap = mission.changes.filter((change) => change.runIds.length > 1);
  const readyForReview =
    mission.status === "needs_review" &&
    !!mission.candidateSha &&
    !!mission.baseSha &&
    mission.checks.length > 0 &&
    mission.checks.every((check) => check.status === "passed");
  const canPreview =
    ["needs_review", "approved", "integrating", "integrated"].includes(
      mission.status,
    ) &&
    !!mission.candidateSha &&
    mission.checks.length > 0 &&
    mission.checks.every((check) => check.status === "passed");
  const currentPreview =
    preview &&
    preview.candidateSha === mission.candidateSha &&
    Date.parse(preview.expiresAt) > Date.now()
      ? preview
      : null;
  const passed = mission.checks.filter(
    (check) => check.status === "passed",
  ).length;

  return (
    <>
      <button className="header-back" onClick={onBack}>
        <ArrowLeftIcon size={13} />
        All missions
      </button>
      <div className="page-heading detail-heading">
        <div>
          <h1>{mission.title}</h1>
          <div className="detail-meta">
            <Status status={mission.status} />
            <span>
              <GitBranchIcon size={13} />
              {repository?.name ?? "Repository"}
            </span>
            <span>
              <ClockIcon size={13} />
              Created {relativeTime(mission.createdAt)}
            </span>
          </div>
        </div>
        <div className="heading-actions detail-actions">
          {canPreview && (
            <Button
              variant="secondary"
              size="base"
              icon={ArrowSquareOutIcon}
              loading={busy === "preview"}
              disabled={!!busy}
              onClick={() => void preparePreview()}
            >
              {currentPreview ? "Refresh preview" : "Prepare preview"}
            </Button>
          )}
          {["draft", "failed", "cancelled", "needs_review"].includes(
            mission.status,
          ) && (
            <Button
              variant={
                mission.status === "needs_review" ? "secondary" : "primary"
              }
              size="base"
              icon={PlayIcon}
              loading={busy === "start"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("start")}
            >
              {mission.status === "draft"
                ? "Start mission"
                : mission.status === "needs_review"
                  ? "Rerun on latest base"
                  : "Retry mission"}
            </Button>
          )}
          {active && (
            <Button
              variant="secondary"
              size="base"
              icon={StopIcon}
              loading={busy === "cancel"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("cancel")}
            >
              Cancel mission
            </Button>
          )}
          {mission.status === "approved" && (
            <Button
              variant="secondary"
              size="base"
              disabled={!!busy || !permissions.includes("review")}
              loading={busy === "revoke"}
              onClick={() => void act("revoke")}
            >
              Revoke approval
            </Button>
          )}
          {["approved", "integrating"].includes(mission.status) && (
            <Button
              variant="primary"
              size="base"
              icon={GitMergeIcon}
              loading={busy === "integrate"}
              disabled={!!busy || !permissions.includes("land")}
              onClick={() => void act("integrate")}
            >
              {mission.status === "integrating"
                ? "Recheck landing"
                : "Land approved changes"}
            </Button>
          )}
          {readyForReview && (
            <Button
              variant="primary"
              size="base"
              icon={ShieldCheckIcon}
              loading={busy === "approve"}
              disabled={!!busy || !permissions.includes("review")}
              onClick={() => void act("approve")}
            >
              Approve candidate
            </Button>
          )}
        </div>
      </div>
      {currentPreview && (
        <div className="alert info">
          <ArrowSquareOutIcon size={17} />
          <div className="alert-text">
            <strong>
              Preview ready for{" "}
              <code>{currentPreview.candidateSha.slice(0, 12)}</code>.
            </strong>{" "}
            Available until{" "}
            {new Date(currentPreview.expiresAt).toLocaleTimeString()}.
          </div>
          <a
            href={currentPreview.previewUrl}
            target="_blank"
            rel="noreferrer"
            className="text-link"
          >
            Open preview <ArrowSquareOutIcon size={12} />
          </a>
        </div>
      )}
      {error && <ErrorNotice message={error} />}
      {loadError && <ErrorNotice message={loadError} />}
      {mission.error && mission.error !== error && (
        <ErrorNotice message={mission.error} />
      )}
      {overlap.length > 0 && (
        <div className="alert">
          <WarningCircleIcon size={17} />
          <div className="alert-text">
            <strong>
              {overlap.length} shared {overlap.length === 1 ? "file" : "files"}{" "}
              changed by multiple agents.
            </strong>{" "}
            File overlap needs attention; combined checks determine whether the
            changes work together.
          </div>
        </div>
      )}
      {mission.status === "approved" && (
        <div className="alert info">
          <ShieldCheckIcon size={17} />
          <div className="alert-text">
            Candidate <code>{mission.candidateSha?.slice(0, 12)}</code> is
            approved. Land it to update the repository after the server verifies
            that the base is unchanged. To run the mission again, revoke this
            approval first. The decision stays in attempt history.
          </div>
        </div>
      )}
      {mission.status === "integrated" && (
        <div className="alert info">
          <GitMergeIcon size={17} />
          <div className="alert-text">
            The approved candidate has landed in the repository.
          </div>
        </div>
      )}
      {mission.status === "draft" && (
        <div className="alert info">
          <RobotIcon size={17} />
          <div className="alert-text">
            This mission is a draft. Starting it checks your connections before
            dispatching agent work.
          </div>
        </div>
      )}
      <div className="page-tabs">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "overview", label: "Overview" },
            {
              value: "changes",
              label: `Changes${mission.changes.length ? ` (${mission.changes.length})` : ""}`,
            },
            {
              value: "checks",
              label: `Checks${mission.checks.length ? ` (${passed}/${mission.checks.length})` : ""}`,
            },
            { value: "activity", label: "Activity" },
            { value: "attempts", label: "Attempt history" },
          ]}
        />
      </div>
      {tab === "overview" && (
        <>
          <div className="detail-summary">
            <section className="panel">
              <div className="panel-header">
                <h2>Mission brief</h2>
                <CodeIcon size={16} color="#8b99ab" />
              </div>
              <div className="panel-body">
                <p className="mission-prompt">{mission.prompt}</p>
                {!!mission.acceptanceCriteria?.length && (
                  <div style={{ marginTop: 19 }}>
                    <h3 style={{ fontSize: 13 }}>Acceptance criteria</h3>
                    <ul className="acceptance-list">
                      {mission.acceptanceCriteria.map((criterion, index) => (
                        <li key={index}>{criterion}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="summary-grid">
                  <div>
                    <span>Base revision</span>
                    <strong>
                      <code>
                        {mission.baseSha?.slice(0, 12) ??
                          "Assigned when work starts"}
                      </code>
                    </strong>
                  </div>
                  <div>
                    <span>Candidate revision</span>
                    <strong>
                      <code>
                        {mission.candidateSha?.slice(0, 12) ??
                          "Waiting for agent work"}
                      </code>
                    </strong>
                  </div>
                </div>
              </div>
            </section>
            <aside className="panel summary-aside">
              <div className="panel-header">
                <h2>Review policy</h2>
                <ShieldCheckIcon size={16} color="#8b99ab" />
              </div>
              <div className="panel-body">
                <p className="mission-prompt" style={{ fontSize: 13 }}>
                  Each agent works in its own fork. Review applies to the exact
                  candidate and base revisions.
                </p>
                <p className="security-note">
                  <GitCommitIcon size={14} />A changed candidate needs a new
                  review.
                </p>
              </div>
            </aside>
          </div>
          <div className="section-heading">
            <h2>
              Agent work{" "}
              <span className="number-tag">{mission.runs.length}</span>
            </h2>
            <span className="status-strip">
              <span className={`status-dot ${active ? "warn" : ""}`} />
              {active ? "Updates every 5 seconds" : "Recorded execution state"}
            </span>
          </div>
          {mission.runs.length ? (
            <div className="agent-grid">
              {mission.runs.map((run) => (
                <article className="agent-card" key={run.id}>
                  <div className="agent-top">
                    <div className="agent-icon">
                      <RobotIcon size={22} />
                    </div>
                    <div>
                      <h3>{run.name}</h3>
                      <small>
                        {run.role}
                        {run.model ? ` / ${run.model}` : ""}
                      </small>
                    </div>
                    <Status status={run.status} />
                  </div>
                  <div className="agent-body">
                    <AgentAssignment run={run} mission={mission} />
                    {run.summary && (
                      <p style={{ marginTop: 12 }}>{run.summary}</p>
                    )}
                    {run.error && (
                      <p style={{ marginTop: 12, color: "#b55c45" }}>
                        {run.error}
                      </p>
                    )}
                    <dl>
                      <dt>Fork</dt>
                      <dd>
                        <code>{run.forkName ?? "Not allocated"}</code>
                      </dd>
                      <dt>Revision</dt>
                      <dd>
                        <code>
                          {run.commitSha?.slice(0, 12) ?? "No revision yet"}
                        </code>
                      </dd>
                      <dt>Started</dt>
                      <dd>
                        {run.startedAt
                          ? new Date(run.startedAt).toLocaleTimeString()
                          : "Waiting"}
                      </dd>
                    </dl>
                    {run.changedFiles.length > 0 && (
                      <div className="file-tags">
                        {run.changedFiles.map((file) => (
                          <code key={file}>{file}</code>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="panel">
              <EmptyState
                icon={<RobotIcon size={25} />}
                title="Your agents will appear here"
                description="Start this mission to allocate independent work. Execution results will appear as they are recorded."
              />
            </div>
          )}
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-header">
              <h2>Latest activity</h2>
              <button className="text-link" onClick={() => setTab("activity")}>
                View all activity <ArrowSquareOutIcon size={12} />
              </button>
            </div>
            <div className="panel-body">
              <EventTimeline mission={mission} limit={4} />
            </div>
          </section>
        </>
      )}
      {tab === "changes" && (
        <>
          {mission.changes.length ? (
            mission.changes.map((change) => (
              <section className="panel" key={change.path}>
                <div className="panel-header">
                  <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <FileCodeIcon size={16} />
                    <code style={{ fontSize: 13 }}>{change.path}</code>
                  </h2>
                  <span style={{ fontSize: 13 }}>
                    <span style={{ color: "#258255" }}>
                      +{change.additions}
                    </span>{" "}
                    <span style={{ color: "#bd6049" }}>
                      −{change.deletions}
                    </span>
                  </span>
                </div>
                <pre className="code-output diff-output">
                  {change.patch
                    ? change.patch.split("\n").map((line, index) => (
                        <span
                          key={index}
                          className={`diff-line ${line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "chunk" : ""}`}
                        >
                          {line}
                        </span>
                      ))
                    : "No patch was returned for this file."}
                </pre>
              </section>
            ))
          ) : (
            <div className="panel">
              <EmptyState
                icon={<FileCodeIcon size={25} />}
                title="No changes to review yet"
                description="Actual file changes appear here after agents save their revisions. Every diff stays attached to its mission."
              />
            </div>
          )}
        </>
      )}
      {tab === "checks" && (
        <>
          <div className="panel">
            {mission.checks.length ? (
              mission.checks.map((check) => (
                <div key={check.id} className={`check-row ${check.status}`}>
                  {check.status === "passed" ? (
                    <CheckCircleIcon size={20} />
                  ) : check.status === "failed" ? (
                    <XCircleIcon size={20} />
                  ) : (
                    <ClockIcon size={20} />
                  )}
                  <div>
                    <h3>{check.name}</h3>
                    {check.candidateSha && (
                      <p>
                        Revision <code>{check.candidateSha.slice(0, 12)}</code>
                        {check.durationMs !== undefined &&
                          ` • ${(check.durationMs / 1000).toFixed(1)}s`}
                      </p>
                    )}
                    {check.output && (
                      <pre
                        className="code-output"
                        style={{ marginTop: 10, padding: 12, fontSize: 13 }}
                      >
                        {check.output}
                      </pre>
                    )}
                  </div>
                  <Status status={check.status} />
                </div>
              ))
            ) : (
              <EmptyState
                icon={<ShieldCheckIcon size={25} />}
                title="Checks have not run"
                description="Individual agent checks and combined verification will appear here. Passing streams alone do not prove their combined result is safe."
              />
            )}
          </div>
          {mission.candidateSha && (
            <div className="security-note">
              <GitMergeIcon size={15} />
              Approval is tied to candidate {mission.candidateSha.slice(
                0,
                12,
              )}{" "}
              and base {mission.baseSha?.slice(0, 12)}. A change to either
              invalidates that approval.
            </div>
          )}
        </>
      )}
      {tab === "activity" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Mission history</h2>
            <span className="number-tag">{mission.events.length} events</span>
          </div>
          <div className="panel-body">
            <EventTimeline mission={mission} />
          </div>
        </section>
      )}
      {tab === "attempts" && (
        <AttemptHistory key={mission.id} mission={mission} />
      )}
    </>
  );
}

function EventTimeline({
  mission,
  limit,
}: {
  mission: Mission;
  limit?: number;
}) {
  const events = [...mission.events].reverse().slice(0, limit);
  if (!events.length)
    return (
      <p className="mission-prompt" style={{ fontSize: 13 }}>
        No execution events have been recorded.
      </p>
    );
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span
            className="timeline-marker"
            style={
              event.type === "error"
                ? { background: "#df9d8b" }
                : event.type === "success"
                  ? { background: "#8dbca0" }
                  : undefined
            }
          />
          <p>{event.message}</p>
          <small>
            {new Date(event.timestamp).toLocaleString()}
            {event.runId ? ` · Agent ${event.runId.slice(0, 8)}` : ""}
          </small>
        </li>
      ))}
    </ol>
  );
}
