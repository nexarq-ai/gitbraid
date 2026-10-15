import { repositoryLabel } from "../shared/repository-names";
import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
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
  ArrowCounterClockwiseIcon,
  GitMergeIcon,
  InfoIcon,
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
import { CheckEscalationNote, CheckTimeoutPanel } from "./CheckSettings";
import DiffView, {
  lineAnchor,
  type LineAnchor,
  type LineCommentKind,
} from "./DiffView";
import { PullRequestPanel } from "./PullRequests";
import { navigate as goTo } from "./router";
import { RouteProgress } from "./WorkspaceLoader";

type PreviewResult = { status?: "starting" | "ready"; message?: string; kind?: "worker"; previewUrl?: string; deploymentUrl?: string | null; notes?: string[]; candidateSha: string; expiresAt?: string };

type Props = {
  id: string;
  initialTab: string;
  selectedRunId?: string;
  currentUserId: string;
  onTabChange: (tab: string) => void;
  permissions: string[];
  workspace: Workspace;
  onBack: () => void;
  onUpdate: () => void;
};

export default function MissionDetail({
  id,
  initialTab,
  selectedRunId,
  currentUserId,
  onTabChange,
  permissions,
  workspace,
  onBack,
  onUpdate,
}: Props) {
  const [mission, setMission] = useState<Mission>();
  const isActive = !!mission && ["queued", "running", "checking", "integrating"].includes(mission.status);
  const missionActive = useRef(false);
  missionActive.current = isActive;
  const reschedule = useRef(() => {});
  const tab = [
    "overview",
    "changes",
    "checks",
    "agents",
    "discussion",
    "activity",
    "attempts",
  ].includes(initialTab)
    ? initialTab
    : "overview";
  const [reviewBody, setReviewBody] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<{
    previewUrl: string;
    candidateSha: string;
    expiresAt: string;
    worker?: { deploymentUrl: string | null; notes: string[] };
  } | null>(null);
  const [previewStarting, setPreviewStarting] = useState(false);
  const [previewNote, setPreviewNote] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const revision = useRef(0);
  const [confirming, setConfirming] = useState<"approve" | "integrate" | null>(null);
  const pollSequence = useRef(0);
  const repository = workspace.repositories.find(
    (item) => item.id === mission?.repositoryId,
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      const startedAt = revision.current;
      const sequence = ++pollSequence.current;
      try {
        const result = await request<Mission>(
          `/api/missions/${encodeURIComponent(id)}`,
        );
        if (active && startedAt === revision.current && sequence === pollSequence.current) {
          revision.current++;
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
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (active && document.visibilityState === "visible") timer = window.setTimeout(() => void load().finally(schedule), missionActive.current ? 5000 : 30000);
    };
    const resume = () => { if (document.visibilityState === "visible") void load().finally(schedule); else window.clearTimeout(timer); };
    reschedule.current = schedule;
    void load().finally(schedule);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [id]);

  useEffect(() => { if (isActive) reschedule.current(); }, [isActive]);

  async function act(
    action: "start" | "retry-agents" | "drop-failed-agents" | "cancel" | "approve" | "integrate" | "revoke",
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
      revision.current++;
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

  async function retryChecks(adjustment: "timeout" | "runner") {
    if (!mission || busy) return;
    setBusy("retry-checks");
    setError("");
    const signature = JSON.stringify({ id, epoch: mission.epoch, action: "retry-checks", adjustment });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/retry-checks`,
        { adjustment },
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The checks could not be retried.",
      );
    } finally {
      setBusy("");
    }
  }

  async function revert() {
    if (!mission || busy) return;
    setBusy("revert");
    setError("");
    try {
      const started = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/revert`,
        {},
        crypto.randomUUID(),
      );
      onUpdate();
      goTo(`mission/${started.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The restore could not be started.",
      );
    } finally {
      setBusy("");
    }
  }

  async function select(runId: string) {
    if (!mission || busy) return;
    setBusy("select");
    setError("");
    const body = { runId, epoch: mission.epoch };
    const signature = JSON.stringify({ id, action: "select", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/select`,
        body,
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The candidate could not be selected.",
      );
    } finally {
      setBusy("");
    }
  }

  async function review(
    action: "comment" | "request_changes" | "resolve",
    reviewId?: string,
  ) {
    if (!mission || busy) return;
    const body = {
      action,
      body: action === "resolve" ? undefined : reviewBody,
      reviewId,
      epoch: mission.epoch,
      candidateSha: mission.candidateSha,
      baseSha: mission.baseSha,
    };
    const signature = JSON.stringify({ id, action: "review", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(action);
    setError("");
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/review`,
        body,
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      setReviewBody("");
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not save review.",
      );
    } finally {
      setBusy("");
    }
  }

  async function commentOnLine(
    anchor: LineAnchor,
    text: string,
    kind: LineCommentKind,
  ) {
    if (!mission) return;
    const body = {
      action: kind,
      body: text,
      epoch: mission.epoch,
      candidateSha: mission.candidateSha,
      baseSha: mission.baseSha,
      ...anchor,
    };
    const signature = JSON.stringify({ id, action: "review", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    const result = await request<Mission>(
      `/api/missions/${encodeURIComponent(id)}/review`,
      body,
      mutation.current.key,
    );
    revision.current++;
    setMission(result);
    mutation.current = null;
    onUpdate();
  }

  useEffect(() => {
    const candidateSha = mission?.candidateSha;
    if (!previewStarting || !candidateSha) return;
    let active = true;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await request<{ status: string; error?: string }>(
          `/api/missions/${encodeURIComponent(id)}/preview`,
        );
        if (!active) return;
        if (status.status === "ready") {
          acceptPreview(candidateSha, await request<PreviewResult>(
            `/api/missions/${encodeURIComponent(id)}/preview`,
            {},
          ));
          setPreviewStarting(false);
          return;
        }
        if (status.status !== "starting") {
          setPreviewStarting(false);
          setError(status.error ?? "The preview stopped before it was ready. Prepare it again.");
          return;
        }
      } catch (failure) {
        if (!active) return;
        if (failure instanceof TypeError || (failure instanceof DOMException && failure.name === "TimeoutError")) {
          timer = window.setTimeout(poll, 3000);
          return;
        }
        setPreviewStarting(false);
        setError(failure instanceof Error ? failure.message : "The preview could not be prepared.");
        return;
      }
      timer = window.setTimeout(poll, 3000);
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [previewStarting, id, mission?.candidateSha]);

  function acceptPreview(candidateSha: string, result: PreviewResult) {
    if (
      result.status === "starting" ||
      result.candidateSha !== candidateSha ||
      !result.previewUrl ||
      new URL(result.previewUrl).protocol !== "https:" ||
      !(Date.parse(result.expiresAt ?? "") > Date.now())
    ) {
      throw new Error(
        "The preview does not match this candidate or has expired. Create a new preview.",
      );
    }
    setPreview({ previewUrl: result.previewUrl, candidateSha: result.candidateSha, expiresAt: result.expiresAt!, ...(result.kind === "worker" ? { worker: { deploymentUrl: result.deploymentUrl ?? null, notes: result.notes ?? [] } } : {}) });
  }

  async function preparePreview() {
    if (!mission?.candidateSha || busy || previewStarting) return;
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
      const result = await request<PreviewResult>(
        `/api/missions/${encodeURIComponent(id)}/preview`,
        {},
        mutation.current.key,
      );
      mutation.current = null;
      if (result.status === "starting") { setPreviewNote(result.message ?? ""); setPreviewStarting(true); }
      else acceptPreview(mission.candidateSha, result);
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
          Proposals
        </button>
        {loadError ? (
          <ErrorNotice message={loadError} />
        ) : (
          <RouteProgress />
        )}
      </>
    );
  const active = ["queued", "running", "checking"].includes(mission.status);
  const verifiedChecks = mission.raceChecks ?? mission.checks;
  const verifiedRuns = mission.runs.filter((run) => run.status === "completed" && !!run.commitSha && !!run.forkName && verifiedChecks.some((check) => check.runId === run.id && check.status === "passed" && check.candidateSha === run.commitSha));
  const unfinishedRuns = mission.runs.filter((run) => !verifiedRuns.includes(run));
  const canRetryAgents = mission.epoch > 0 && ["failed", "cancelled"].includes(mission.status) && !mission.skillChange && !mission.revertChange && !mission.branchChange && unfinishedRuns.length > 0;
  const landing = mission.status === "integrating" && !mission.error;
  const overlap = mission.changes.filter((change) => change.runIds.length > 1);
  const unresolvedRequests = (mission.reviews ?? []).filter(
    (review) =>
      review.kind === "request_changes" &&
      !review.resolvedAt &&
      review.epoch === mission.epoch &&
      review.candidateSha === mission.candidateSha &&
      review.baseSha === mission.baseSha,
  );
  const currentLineComments = (mission.reviews ?? []).filter(
    (review) =>
      review.path &&
      review.epoch === mission.epoch &&
      review.candidateSha === mission.candidateSha &&
      review.baseSha === mission.baseSha,
  );
  const canDiscuss =
    ["needs_review", "approved"].includes(mission.status) &&
    !!mission.candidateSha &&
    !!mission.baseSha;
  const isRace = mission.mode === "race";
  const fileOwners = new Map<string, string[]>();
  if (!isRace)
    for (const run of mission.runs)
      for (const path of run.touchedFiles ?? run.changedFiles)
        fileOwners.set(path, [...(fileOwners.get(path) ?? []), run.name]);
  const overlaps = [...fileOwners]
    .filter(([, agents]) => agents.length > 1)
    .map(([path, agents]) => ({ path, agents }));
  const overlapPaths = new Set(overlaps.map((entry) => entry.path));
  const raceChecks = mission.raceChecks ?? mission.checks;
  const raceChanges = mission.raceChanges ?? mission.changes;
  const raceCandidates = isRace
    ? mission.runs
        .filter((run) => run.commitSha || run.status === "failed")
        .map((run) => {
          const check = raceChecks.find((entry) => entry.runId === run.id);
          const changes = raceChanges.filter((change) => change.runIds.includes(run.id));
          return {
            run,
            check,
            files: changes.length,
            additions: changes.reduce((total, change) => total + change.additions, 0),
            deletions: changes.reduce((total, change) => total + change.deletions, 0),
            eligible: run.status === "completed" && check?.status === "passed",
          };
        })
    : [];
  const readyForReview =
    unresolvedRequests.length === 0 &&
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
        Proposals
      </button>
      <div className="page-heading detail-heading">
        <div>
          <h1>{mission.title}</h1>
          <div className="detail-meta">
            <Status status={mission.status} />
            <span>{mission.branchChange ? "Proposal" : mission.mode === "race" ? "AI race" : "AI mission"}</span>
            <span>
              <GitBranchIcon size={13} />
              {repository ? repositoryLabel(repository) : "Repository"}
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
              loading={busy === "preview" || previewStarting}
              disabled={!!busy || previewStarting}
              onClick={() => void preparePreview()}
            >
              {previewStarting ? "Preparing preview…" : currentPreview ? "Refresh preview" : "Prepare preview"}
            </Button>
          )}
          {!mission.branchChange && ["draft", "failed", "cancelled", "needs_review"].includes(
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
                ? "Start agents"
                : mission.status === "needs_review"
                  ? "Rerun on latest base"
                  : "Retry mission"}
            </Button>
          )}
          {canRetryAgents && (
            <Button
              variant="primary"
              size="base"
              icon={ArrowCounterClockwiseIcon}
              loading={busy === "retry-agents"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("retry-agents")}
            >
              Retry failed agents ({unfinishedRuns.length})
            </Button>
          )}
          {canRetryAgents && verifiedRuns.length > 0 && (
            <Button
              variant="secondary"
              size="base"
              loading={busy === "drop-failed-agents"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("drop-failed-agents")}
            >
              Continue without failed agents
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
          {mission.status === "integrated" && (
            <Button
              variant="secondary"
              size="base"
              icon={ArrowCounterClockwiseIcon}
              loading={busy === "revert"}
              disabled={!!busy || !permissions.includes("contribute") || !permissions.includes("execute")}
              onClick={() => void revert()}
            >
              Restore
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
              loading={busy === "integrate" || landing}
              disabled={
                !!busy ||
                landing ||
                !permissions.includes("land") ||
                unresolvedRequests.length > 0
              }
              onClick={() => mission.status === "integrating" ? void act("integrate") : setConfirming("integrate")}
            >
              {landing
                ? "Landing…"
                : mission.status === "integrating"
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
              onClick={() => setConfirming("approve")}
            >
              Approve candidate
            </Button>
          )}
        </div>
      </div>
      {mission.branchChange && <PullRequestPanel mission={mission} permissions={permissions} onChange={(result) => { revision.current++; setMission(result); onUpdate(); }} />}
      {currentPreview && (
        <div className="alert info">
          <ArrowSquareOutIcon size={17} />
          <div className="alert-text">
            <strong>
              Cloudflare preview ready for{" "}
              <code>{currentPreview.candidateSha.slice(0, 12)}</code>.
            </strong>{" "}
            Available until{" "}
            {new Date(currentPreview.expiresAt).toLocaleTimeString()}.
            <small className="candidate-preview-provider">{currentPreview.worker ? "Cloudflare Worker Preview" : "Isolated Container"} · {new URL(currentPreview.previewUrl).hostname}</small>
            {currentPreview.worker && <small className="candidate-preview-provider">Public link: anyone with the link can open it. Search engines are asked not to index it.{currentPreview.worker.deploymentUrl && <> <a href={currentPreview.worker.deploymentUrl} target="_blank" rel="noreferrer" className="text-link">This exact deployment</a></>}</small>}
            {currentPreview.worker?.notes.map((note) => <small key={note} className="candidate-preview-provider">{note}</small>)}
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
      {previewStarting && previewNote && (
        <div className="alert info" role="status">
          <InfoIcon size={17} />
          <div className="alert-text">{previewNote}</div>
        </div>
      )}
      {error && <ErrorNotice message={error} />}
      {loadError && <ErrorNotice message={loadError} />}
      {mission.error && mission.error !== error && (
        <ErrorNotice message={mission.error} />
      )}
      {unresolvedRequests.length > 0 && (
        <div className="alert">
          <WarningCircleIcon size={17} />
          <div className="alert-text">
            {unresolvedRequests.length} unresolved review requests block
            approval and landing for this revision.{" "}
            <button
              className="text-link"
              onClick={() => onTabChange("discussion")}
            >
              View discussion
            </button>
          </div>
        </div>
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
            Candidate <code>{mission.candidateSha}</code> is
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
            The approved candidate has landed in the repository. Restore creates a
            new revision that undoes it, checked and approved like any change.
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
      {overlaps.length > 0 && (
        <div className="alert info" role="status">
          <InfoIcon size={17} />
          <div className="alert-text">
            {overlaps.length === 1 ? "One file is" : `${overlaps.length} files are`} being changed by more than one agent. The combined check decides whether the changes fit together.
            <ul className="overlap-list">
              {overlaps.slice(0, 8).map((entry) => (
                <li key={entry.path}>
                  <code>{entry.path}</code> — {entry.agents.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {isRace && raceCandidates.length > 0 && (
        <section aria-label="Race candidates">
          {mission.status === "needs_review" && !mission.selectedRunId && (
            <div className="alert info">
              <InfoIcon size={17} />
              <div className="alert-text">
                The race is finished. Compare the candidates and select one; only the selected revision can be approved and landed.
              </div>
            </div>
          )}
          <div className="race-grid">
            {raceCandidates.map((candidate) => (
              <article
                className={`race-card${candidate.run.id === mission.selectedRunId ? " selected" : ""}`}
                key={candidate.run.id}
              >
                <h3>
                  {candidate.run.name}
                  <Status status={candidate.check?.status ?? candidate.run.status} />
                </h3>
                <p>{candidate.run.assignment ?? candidate.run.role}</p>
                <div className="race-stats">
                  <span>
                    <code>{candidate.run.commitSha?.slice(0, 12) ?? "No revision"}</code>
                  </span>
                  <span>{candidate.files} files</span>
                  <span>
                    +{candidate.additions} −{candidate.deletions}
                  </span>
                  {candidate.check?.durationMs !== undefined && (
                    <span>tests {Math.round(candidate.check.durationMs / 100) / 10}s</span>
                  )}
                </div>
                {candidate.run.summary && <p>{candidate.run.summary.slice(0, 280)}</p>}
                {candidate.run.error && <p style={{ color: "#b55c45" }}>{candidate.run.error}</p>}
                {candidate.eligible && mission.status === "needs_review" && (
                  <Button
                    variant={candidate.run.id === mission.selectedRunId ? "secondary" : "primary"}
                    size="sm"
                    loading={busy === "select"}
                    disabled={!!busy || !permissions.includes("review") || candidate.run.id === mission.selectedRunId}
                    onClick={() => void select(candidate.run.id)}
                  >
                    {candidate.run.id === mission.selectedRunId ? "Selected for review" : "Select this candidate"}
                  </Button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="repository-work-meta">
        <span>
          Base{" "}
          <code title={mission.baseSha ?? undefined}>
            {mission.baseSha?.slice(0, 12) || "Assigned at start"}
          </code>
        </span>
        <span>
          Candidate{" "}
          <code title={mission.candidateSha ?? undefined}>
            {mission.candidateSha || "No candidate yet"}
          </code>
        </span>
        <span>Attempt {mission.epoch}</span>
        <span>
          {mission.runs.length}{" "}
          {mission.skillChange ? "trusted skill edit" : `${mission.epoch === 0 ? "planned" : "isolated"} agent ${mission.runs.length === 1 ? "task" : "tasks"}`}
        </span>
      </div>
      <div className="page-tabs">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={onTabChange}
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
            { value: "agents", label: `Agents (${mission.runs.length})` },
            {
              value: "discussion",
              label: `Discussion (${(mission.reviews ?? []).length})`,
            },
            { value: "activity", label: "Activity" },
            { value: "attempts", label: "Attempt history" },
          ]}
        />
      </div>
      {(tab === "overview" || tab === "agents") && (
        <>
          {tab === "overview" && (
          <>
            {((mission as { attachments?: { name: string; content: string }[] }).attachments ?? []).length > 0 && (
              <section className="panel mission-attachments"><div className="panel-header"><h2>Context files</h2></div><div className="panel-body">{((mission as { attachments?: { name: string; content: string }[] }).attachments ?? []).map(item => <details key={item.name}><summary><code>{item.name}</code></summary><pre>{item.content.slice(0, 2000)}{item.content.length > 2000 ? "\n…" : ""}</pre></details>)}</div></section>
            )}
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
                          {mission.candidateSha ??
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
                    Each agent works in its own fork. Review applies to the
                    exact candidate and base revisions.
                  </p>
                  <p className="security-note">
                    <GitCommitIcon size={14} />A changed candidate needs a new
                    review.
                  </p>
                </div>
              </aside>
            </div>
          </>
          )}
          {tab === "agents" && selectedRunId && (
            <p className="mission-prompt">
              <button
                className="text-link"
                onClick={() => onTabChange("agents")}
              >
                ← All agent runs
              </button>
            </p>
          )}
          {tab === "agents" &&
            selectedRunId &&
            !mission.runs.some((run) => run.id === selectedRunId) && (
              <ErrorNotice message="This run was not found in the current attempt. Check Attempt history for earlier runs." />
            )}
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
              {mission.runs
                .filter(
                  (run) =>
                    tab !== "agents" ||
                    !selectedRunId ||
                    run.id === selectedRunId,
                )
                .map((run) => (
                  <article
                    className={tab === "agents" ? "agent-card agent-card-with-footer" : "agent-card"}
                    id={`run-${run.id}`}
                    key={run.id}
                  >
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
                      <Status
                        status={mission.epoch === 0 ? "draft" : run.status}
                      />
                    </div>
                    <div className="agent-body">
                      <AgentAssignment run={run} mission={mission} />
                      {run.note && (
                        <p className="agent-note">Shared with the team: {run.note}</p>
                      )}
                      {run.reusedFromEpoch !== undefined && run.status === "completed" && (
                        <p className="agent-note">Verified candidate carried over from attempt {run.reusedFromEpoch}; this agent did not run again.</p>
                      )}
                      {run.skipReason && run.status === "skipped" && (
                        <p className="agent-note">Skipped: {run.skipReason}</p>
                      )}
                      {run.usage && run.usage.calls > 0 && (
                        <p className="agent-usage">Usage: {run.usage.calls} {run.usage.calls === 1 ? "call" : "calls"} · input {run.usage.inputTokens.toLocaleString()} · output {run.usage.outputTokens.toLocaleString()} · cache read {run.usage.cacheReadTokens.toLocaleString()} · cache write {run.usage.cacheWriteTokens.toLocaleString()}{run.usage.unreportedCalls > 0 ? ` · ${run.usage.unreportedCalls} without provider counts (unknown)` : ""}</p>
                      )}
                      {run.summary && (
                        <p style={{ marginTop: 12 }}>{run.summary}</p>
                      )}
                      {(run.touchedFiles ?? run.changedFiles).length > 0 && (
                        <div className="touched-files" aria-label={`Files touched by ${run.name}`}>
                          {(run.touchedFiles ?? run.changedFiles).slice(0, 24).map((path) => (
                            <code key={path} className={overlapPaths.has(path) ? "shared" : undefined}>{path}</code>
                          ))}
                        </div>
                      )}
                      {run.error && (
                        <p style={{ marginTop: 12, color: "#b55c45" }}>
                          {run.error}
                        </p>
                      )}
                      {run.skills !== undefined && (
                        <details className="agent-skill-evidence">
                          <summary>{run.skills.length} repository {run.skills.length === 1 ? "skill" : "skills"} loaded</summary>
                          {run.skills.length ? <ul>{run.skills.map(skill => <li key={skill.path}><strong>{skill.name}</strong><code>{skill.path}</code><small>Source {skill.commitSha.slice(0, 12)} · SHA-256 {skill.sha256.slice(0, 12)}</small></li>)}</ul> : <p>No skills were available at the starting revision.</p>}
                          {run.skillWarnings?.map((warning, index) => <p className="agent-skill-warning" key={index}>{warning}</p>)}
                        </details>
                      )}
                      <dl>
                        <dt>Stream</dt>
                        <dd>
                          <code>{run.branch ?? "Not allocated"}</code>
                        </dd>
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
                      {tab === "agents" && (
                        <>
                          <h3>Recorded run activity</h3>
                          <ol className="timeline">
                            {mission.events
                              .filter((event) => event.runId === run.id)
                              .map((event) => (
                                <li key={event.id}>
                                  <span className="timeline-marker" />
                                  <p>{event.message}</p>
                                  <small>
                                    {new Date(event.timestamp).toLocaleString()}
                                  </small>
                                </li>
                              ))}
                          </ol>
                          {!mission.events.some(
                            (event) => event.runId === run.id,
                          ) && <p>No run events recorded.</p>}
                        </>
                      )}
                      {run.changedFiles.length > 0 && (
                        <div className="file-tags">
                          {run.changedFiles.map((file) => (
                            <code key={file}>{file}</code>
                          ))}
                        </div>
                      )}
                    </div>
                    {tab === "agents" && <footer className="agent-card-footer"><Button variant="secondary" size="base" icon={FileCodeIcon} onClick={() => onTabChange("changes")}>Inspect saved changes</Button></footer>}
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
          {tab === "overview" && (
            <section className="panel" style={{ marginTop: 24 }}>
              <div className="panel-header">
                <h2>Latest activity</h2>
                <button
                  className="text-link"
                  onClick={() => onTabChange("activity")}
                >
                  View all activity <ArrowSquareOutIcon size={12} />
                </button>
              </div>
              <div className="panel-body">
                <EventTimeline mission={mission} limit={4} />
              </div>
            </section>
          )}
        </>
      )}
      {tab === "changes" && (
        <>
          <p className="mission-prompt">
            {mission.changes.length} changed files · +
            {mission.changes.reduce(
              (count, change) => count + change.additions,
              0,
            )}{" "}
            / −
            {mission.changes.reduce(
              (count, change) => count + change.deletions,
              0,
            )}{" "}
            · {overlap.length} overlapping paths
          </p>
          {mission.changes.length ? (
            <DiffView
              changes={mission.changes}
              candidateSha={mission.candidateSha}
              comments={currentLineComments}
              canComment={
                canDiscuss &&
                (permissions.includes("contribute") ||
                  permissions.includes("review"))
              }
              canRequestChanges={canDiscuss && permissions.includes("review")}
              onComment={commentOnLine}
              fileMeta={(change) => (
                <div className="repository-work-meta">
                  {change.runIds.map((runId) => (
                    <button
                      key={runId}
                      className="text-link"
                      onClick={() => {
                        goTo(`mission/${mission.id}/agents/${runId}`);
                      }}
                    >
                      {mission.runs.find((run) => run.id === runId)?.name ??
                        runId.slice(0, 8)}
                    </button>
                  ))}
                  {change.runIds.length > 1 && (
                    <strong>Overlapping agent changes</strong>
                  )}
                </div>
              )}
            />
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
          <p className="mission-prompt">
            Individual agent checks verify each isolated revision. Combined
            checks verify the candidate that will land. Passing individual
            checks alone does not establish a passing combined candidate.
          </p>
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
                    <p>
                      {check.candidateSha === mission.candidateSha &&
                      mission.candidateSha
                        ? "Combined candidate"
                        : check.candidateSha &&
                            mission.runs.some(
                              (run) => run.commitSha === check.candidateSha,
                            )
                          ? "Individual agent revision"
                          : "Combination check"}
                    </p>
                    {check.candidateSha && (
                      <p>
                        Revision <code>{check.candidateSha.slice(0, 12)}</code>
                        {check.durationMs !== undefined &&
                          ` • ${(check.durationMs / 1000).toFixed(1)}s`}
                      </p>
                    )}
                    <CheckEscalationNote check={check} />
                    {check.timeout && check.status === "failed" && (
                      <CheckTimeoutPanel
                        mission={mission}
                        check={{ ...check, timeout: check.timeout }}
                        canRetry={permissions.includes("land")}
                        busy={busy === "retry-checks"}
                        onRetry={(adjustment) => void retryChecks(adjustment)}
                      />
                    )}
                    {check.output && (
                      <details open={check.status === "failed"}>
                        <summary>View check output</summary>
                        <pre
                          className="code-output"
                          style={{ marginTop: 10, padding: 12, fontSize: 13 }}
                        >
                          {check.output}
                        </pre>
                      </details>
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
      {tab === "discussion" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Review discussion</h2>
            <span className="number-tag">
              {unresolvedRequests.length} unresolved requests on this revision
            </span>
          </div>
          {(mission.reviews ?? []).length ? (
            (mission.reviews ?? []).map((item) => {
              const current =
                item.epoch === mission.epoch &&
                item.candidateSha === mission.candidateSha &&
                item.baseSha === mission.baseSha;
              return (
                <article className="repository-work-item" key={item.id}>
                  <div className="repository-work-title">
                    <strong>
                      {item.kind === "request_changes"
                        ? "Changes requested"
                        : "Comment"}
                      {item.resolvedAt ? " · Resolved" : ""}
                    </strong>
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                  </div>
                  <p className="proposal-review-revision">
                    Reviewer {item.authorId} · Attempt {item.epoch} · Candidate{" "}
                    {item.candidateSha.slice(0, 12)} · Base{" "}
                    {item.baseSha.slice(0, 12)}
                    {!current && !item.path ? " · Previous revision" : ""}
                  </p>
                  {item.path && item.line && item.side && (
                    <p className="proposal-review-anchor">
                      {current ? (
                        <a
                          href={`/mission/${encodeURIComponent(mission.id)}/changes#${encodeURI(lineAnchor({ path: item.path, line: item.line, side: item.side }))}`}
                        >
                          <code>
                            {item.path}:{item.line}
                          </code>
                        </a>
                      ) : (
                        <code>
                          {item.path}:{item.line}
                        </code>
                      )}{" "}
                      {item.side === "old" ? "original" : "changed"} line
                      {!current && (
                        <span className="proposal-review-outdated">
                          Outdated
                        </span>
                      )}
                    </p>
                  )}
                  <p style={{ whiteSpace: "pre-wrap" }}>{item.body}</p>
                  {item.kind === "request_changes" &&
                    !item.resolvedAt &&
                    current &&
                    canDiscuss &&
                    item.authorId === currentUserId &&
                    permissions.includes("review") && (
                      <Button
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() => void review("resolve", item.id)}
                      >
                        Resolve request
                      </Button>
                    )}
                  {item.resolvedAt && (
                    <small>
                      Resolved by {item.resolvedBy} ·{" "}
                      {new Date(item.resolvedAt).toLocaleString()}
                    </small>
                  )}
                </article>
              );
            })
          ) : (
            <EmptyState
              icon={<ShieldCheckIcon size={25} />}
              title="No review discussion yet"
              description="Comments and requests for changes are recorded against an exact candidate and base revision."
            />
          )}
          {canDiscuss &&
          (permissions.includes("contribute") ||
            permissions.includes("review")) ? (
            <form
              className="proposal-review-form"
              onSubmit={(event) => {
                event.preventDefault();
                void review("comment");
              }}
            >
              <label htmlFor="proposal-review-body">Review this revision</label>
              <textarea
                id="proposal-review-body"
                required
                maxLength={8000}
                value={reviewBody}
                onChange={(event) => setReviewBody(event.target.value)}
                placeholder="Discuss the changes or describe what needs to be addressed…"
              />
              <p className="proposal-review-revision">
                Candidate {mission.candidateSha} · Base{" "}
                {mission.baseSha?.slice(0, 12)} · Attempt {mission.epoch}
              </p>
              <div className="proposal-review-actions">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    !!busy ||
                    !reviewBody.trim() ||
                    !(
                      permissions.includes("contribute") ||
                      permissions.includes("review")
                    )
                  }
                >
                  Add comment
                </Button>
                {permissions.includes("review") && (
                  <Button
                    variant="secondary"
                    disabled={!!busy || !reviewBody.trim()}
                    onClick={() => void review("request_changes")}
                  >
                    Request changes
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <div className="panel-body">
              <p className="mission-prompt">
                Review discussion opens when a candidate is ready for review.
                Earlier revision comments remain in the record.
              </p>
            </div>
          )}
        </section>
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
      <Dialog.Root open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <Dialog size="sm" className="dialog-content confirm-dialog">
          <Dialog.Title className="dialog-title">
            {confirming === "approve" ? "Approve this candidate?" : "Land these changes?"}
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            {confirming === "approve"
              ? <>Approve revision <code>{mission.candidateSha?.slice(0, 12)}</code> after {mission.checks.length} passing check{mission.checks.length === 1 ? "" : "s"}. Approval does not change the repository; landing is a separate step.</>
              : <>Land revision <code>{mission.candidateSha?.slice(0, 12)}</code> on <strong>{repository?.defaultBranch ?? "the main stream"}</strong> of <strong>{repository ? repositoryLabel(repository) : "this repository"}</strong>. You can undo it later with Restore.</>}
          </Dialog.Description>
          <div className="dialog-actions">
            <Button variant="secondary" size="base" type="button" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="primary" size="base" type="button" icon={confirming === "approve" ? ShieldCheckIcon : GitMergeIcon} onClick={() => { const action = confirming; setConfirming(null); if (action) void act(action); }}>
              {confirming === "approve" ? "Approve" : "Land changes"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
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
