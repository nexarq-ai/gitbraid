import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { ArrowClockwiseIcon, ArrowRightIcon, GitPullRequestIcon, PlusIcon, RobotIcon, ShieldCheckIcon, XCircleIcon } from "@phosphor-icons/react";
import type { Mission, MissionSummary, PullRequestState } from "../shared/types";
import { pullRequestState } from "../shared/pull-requests";
import { request } from "./api";
import { EmptyState, Status, relativeTime } from "./components";
import { navigate as goTo } from "./router";
import "./pull-requests.css";

const stateLabels: Record<PullRequestState, [string, string]> = {
  open: ["Open", "running"],
  needs_review: ["Needs review", "review"],
  approved: ["Approved", "approved"],
  landed: ["Landed", "integrated"],
  closed: ["Closed", "cancelled"],
};

export function PullRequestBadge({ mission }: { mission: Pick<Mission, "status" | "branchChange"> }) {
  const [label, tone] = stateLabels[pullRequestState(mission)];
  return <span className={`pill ${tone}`}><span className="pill-dot" />{label}</span>;
}

type Source = "all" | "agents" | "branches";

const isOpen = (mission: MissionSummary) => mission.branchChange ? !["landed", "closed"].includes(pullRequestState(mission)) : !["integrated", "cancelled"].includes(mission.status);

export default function PullRequests({ repositoryId, missions, canContribute }: { repositoryId: string; missions: MissionSummary[]; canContribute: boolean }) {
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const [source, setSource] = useState<Source>("all");
  const pulls = missions.filter(mission => source === "all" || (source === "branches") === !!mission.branchChange).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = pulls.filter(mission => filter === "all" || (filter === "open") === isOpen(mission));
  const agentCount = missions.filter(mission => !mission.branchChange).length;
  const newPull = <Button variant="primary" size="base" icon={PlusIcon} disabled={!canContribute} onClick={() => goTo(`repository/${repositoryId}/pulls/new`)}>New proposal</Button>;
  return (
    <>
      <div className="repository-work-heading">
        <div><h2>Proposals<span className="git-term">· pull requests</span></h2><p>Every proposed change to this repository. AI agents open one when you start a mission; people open one from a pushed stream. Both run checks, need approval of the exact revision, and land the same way.</p></div>
        {newPull}
      </div>
      <div className="repository-work-toolbar">
        <div className="pull-filter" role="group" aria-label="Filter by state">
          {(["open", "closed", "all"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "open" ? `Open (${pulls.filter(isOpen).length})` : value === "closed" ? `Closed (${pulls.filter(mission => !isOpen(mission)).length})` : "All"}</button>)}
        </div>
        <div className="pull-filter ai-only" role="group" aria-label="Filter by author">
          {([["all", "Everyone"], ["agents", `AI agents (${agentCount})`], ["branches", `Streams (${missions.length - agentCount})`]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>)}
        </div>
        <a className="text-link" href={`/repository/${repositoryId}/settings/branches`}><ShieldCheckIcon size={13} />Streams &amp; protection</a>
      </div>
      <section className="panel">
        {!shown.length ? (
          <EmptyState icon={<GitPullRequestIcon size={25} />} title={pulls.length ? "No matching proposals" : "No proposals yet"} description={pulls.length ? "Choose another filter." : "Ask AI agents to make a change, or push a stream and open a proposal from it."} action={pulls.length ? <Button onClick={() => { setFilter("all"); setSource("all"); }}>Show all</Button> : newPull} />
        ) : (
          <div className="table-scroll">
            <table className="resource-table">
              <thead><tr><th>Proposal</th><th>State</th><th>Checks</th><th>Updated</th></tr></thead>
              <tbody>
                {shown.map(mission => (
                  <tr key={mission.id}>
                    <td><div className="resource-name">{mission.branchChange ? <GitPullRequestIcon size={18} /> : <RobotIcon size={18} />}<div><a href={`/mission/${mission.id}`}>{mission.title}</a>{mission.branchChange
                      ? <small className="pull-branches"><code>{mission.branchChange.branch}</code><ArrowRightIcon size={11} /><code>{mission.branchChange.targetBranch}</code><span>head <code>{mission.branchChange.headSha.slice(0, 12)}</code></span></small>
                      : <small className="pull-branches"><span>{mission.skillChange ? "Skill change" : mission.revertChange ? "Restore" : `AI mission${mission.runs.length ? ` · ${mission.runs.length} agent${mission.runs.length === 1 ? "" : "s"}` : ""}`}</span>{mission.candidateSha && <span>candidate <code>{mission.candidateSha.slice(0, 12)}</code></span>}</small>}</div></div></td>
                    <td>{mission.branchChange ? <PullRequestBadge mission={mission} /> : <Status status={mission.status} />}</td>
                    <td><a className="text-link" href={`/mission/${mission.id}/checks`}>{mission.checks.length ? `${mission.checks.filter(check => check.status === "passed").length}/${mission.checks.length} passed` : "Not run"}</a></td>
                    <td>{relativeTime(mission.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export function PullRequestPanel({ mission, permissions, onChange }: { mission: Mission; permissions: string[]; onChange: (mission: Mission) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const change = mission.branchChange!;
  const state = pullRequestState(mission);
  const canContribute = permissions.includes("contribute");
  async function act(action: "update" | "close" | "reopen") {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      onChange(await request<Mission>(`/api/missions/${encodeURIComponent(mission.id)}/pull`, { action }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The proposal could not be updated.");
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="panel pull-panel">
      <div className="pull-panel-header">
        <div>
          <span className="pull-panel-label"><GitPullRequestIcon size={15} />Proposal</span>
          <code>{change.branch}</code><ArrowRightIcon size={12} /><code>{change.targetBranch}</code>
          <span>head <code>{change.headSha.slice(0, 12)}</code></span>
          <PullRequestBadge mission={mission} />
        </div>
        <div className="pull-panel-actions">
          {state !== "closed" && state !== "landed" && <Button variant="secondary" size="base" icon={ArrowClockwiseIcon} loading={busy === "update"} disabled={!!busy || !canContribute || !permissions.includes("execute")} onClick={() => void act("update")}>Update from stream</Button>}
          {state !== "closed" && state !== "landed" && <Button variant="secondary" size="base" icon={XCircleIcon} loading={busy === "close"} disabled={!!busy || !canContribute} onClick={() => setConfirmClose(true)}>Close</Button>}
          {state === "closed" && <Button variant="secondary" size="base" icon={ArrowClockwiseIcon} loading={busy === "reopen"} disabled={!!busy || !canContribute} onClick={() => void act("reopen")}>Reopen</Button>}
        </div>
      </div>
      {change.description && <p className="pull-panel-description">{change.description}</p>}
      {state === "closed" && <p className="pull-panel-note">Closed{change.closedAt ? ` ${relativeTime(change.closedAt)}` : ""}. Reopening restarts checks against the stream's current head.</p>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      <Dialog.Root open={confirmClose} onOpenChange={setConfirmClose}>
        <Dialog size="sm" className="dialog-content confirm-dialog">
          <Dialog.Title className="dialog-title">Close this proposal?</Dialog.Title>
          <Dialog.Description className="dialog-description">The stream <code>{change.branch}</code> is kept. Any approval stops applying, and you can reopen the proposal later.</Dialog.Description>
          <div className="dialog-actions">
            <Button variant="secondary" size="base" type="button" onClick={() => setConfirmClose(false)}>Cancel</Button>
            <Button variant="primary" size="base" type="button" icon={XCircleIcon} onClick={() => { setConfirmClose(false); void act("close"); }}>Close proposal</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </section>
  );
}
