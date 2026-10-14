import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { ArrowClockwiseIcon, ArrowRightIcon, GitPullRequestIcon, PlusIcon, ShieldCheckIcon, XCircleIcon } from "@phosphor-icons/react";
import type { Mission, PullRequestState } from "../shared/types";
import { pullRequestState } from "../shared/pull-requests";
import { request } from "./api";
import { EmptyState, relativeTime } from "./components";
import { navigate as goTo } from "./router";
import "./pull-requests.css";

const stateLabels: Record<PullRequestState, [string, string]> = {
  open: ["Open", "running"],
  needs_review: ["Needs review", "review"],
  approved: ["Approved", "approved"],
  landed: ["Landed", "integrated"],
  closed: ["Closed", "cancelled"],
};

export function PullRequestBadge({ mission }: { mission: Mission }) {
  const [label, tone] = stateLabels[pullRequestState(mission)];
  return <span className={`pill ${tone}`}><span className="pill-dot" />{label}</span>;
}

export default function PullRequests({ repositoryId, missions, canContribute }: { repositoryId: string; missions: Mission[]; canContribute: boolean }) {
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const pulls = missions.filter(mission => mission.branchChange).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const isOpen = (mission: Mission) => !["landed", "closed"].includes(pullRequestState(mission));
  const shown = pulls.filter(mission => filter === "all" || (filter === "open") === isOpen(mission));
  return (
    <>
      <div className="repository-work-heading">
        <div><h2>Pull requests</h2><p>Propose a pushed branch for review. Checks run on the exact head, and approval pins that revision before it lands.</p></div>
        <Button variant="primary" size="base" icon={PlusIcon} disabled={!canContribute} onClick={() => goTo(`repository/${repositoryId}/pulls/new`)}>New pull request</Button>
      </div>
      <div className="repository-work-toolbar">
        <div className="pull-filter" role="group" aria-label="Filter pull requests">
          {(["open", "closed", "all"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "open" ? `Open (${pulls.filter(isOpen).length})` : value === "closed" ? `Closed (${pulls.filter(mission => !isOpen(mission)).length})` : "All"}</button>)}
        </div>
        <a className="text-link" href={`/repository/${repositoryId}/settings/branches`}><ShieldCheckIcon size={13} />Branches &amp; protection</a>
      </div>
      <section className="panel">
        {!shown.length ? (
          <EmptyState icon={<GitPullRequestIcon size={25} />} title={pulls.length ? "No matching pull requests" : "No pull requests yet"} description={pulls.length ? "Choose another filter." : "Push a branch, then open a pull request to run checks and request review."} action={pulls.length ? <Button onClick={() => setFilter("all")}>Show all</Button> : <Button disabled={!canContribute} onClick={() => goTo(`repository/${repositoryId}/pulls/new`)}>New pull request</Button>} />
        ) : (
          <div className="table-scroll">
            <table className="resource-table">
              <thead><tr><th>Pull request</th><th>State</th><th>Head</th><th>Checks</th><th>Updated</th></tr></thead>
              <tbody>
                {shown.map(mission => (
                  <tr key={mission.id}>
                    <td><div className="resource-name"><GitPullRequestIcon size={18} /><div><a href={`/mission/${mission.id}`}>{mission.title}</a><small className="pull-branches"><code>{mission.branchChange!.branch}</code><ArrowRightIcon size={11} /><code>{mission.branchChange!.targetBranch}</code></small></div></div></td>
                    <td><PullRequestBadge mission={mission} /></td>
                    <td><code>{mission.branchChange!.headSha.slice(0, 12)}</code></td>
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
      setError(failure instanceof Error ? failure.message : "The pull request could not be updated.");
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="panel pull-panel">
      <div className="pull-panel-header">
        <div>
          <span className="pull-panel-label"><GitPullRequestIcon size={15} />Pull request</span>
          <code>{change.branch}</code><ArrowRightIcon size={12} /><code>{change.targetBranch}</code>
          <span>head <code>{change.headSha.slice(0, 12)}</code></span>
          <PullRequestBadge mission={mission} />
        </div>
        <div className="pull-panel-actions">
          {state !== "closed" && state !== "landed" && <Button variant="secondary" size="base" icon={ArrowClockwiseIcon} loading={busy === "update"} disabled={!!busy || !canContribute || !permissions.includes("execute")} onClick={() => void act("update")}>Update from branch</Button>}
          {state !== "closed" && state !== "landed" && <Button variant="secondary" size="base" icon={XCircleIcon} loading={busy === "close"} disabled={!!busy || !canContribute} onClick={() => setConfirmClose(true)}>Close</Button>}
          {state === "closed" && <Button variant="secondary" size="base" icon={ArrowClockwiseIcon} loading={busy === "reopen"} disabled={!!busy || !canContribute} onClick={() => void act("reopen")}>Reopen</Button>}
        </div>
      </div>
      {change.description && <p className="pull-panel-description">{change.description}</p>}
      {state === "closed" && <p className="pull-panel-note">Closed{change.closedAt ? ` ${relativeTime(change.closedAt)}` : ""}. Reopening restarts checks against the branch's current head.</p>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      <Dialog.Root open={confirmClose} onOpenChange={setConfirmClose}>
        <Dialog size="sm" className="dialog-content confirm-dialog">
          <Dialog.Title className="dialog-title">Close this pull request?</Dialog.Title>
          <Dialog.Description className="dialog-description">The branch <code>{change.branch}</code> is kept. Any approval stops applying, and you can reopen the pull request later.</Dialog.Description>
          <div className="dialog-actions">
            <Button variant="secondary" size="base" type="button" onClick={() => setConfirmClose(false)}>Cancel</Button>
            <Button variant="primary" size="base" type="button" icon={XCircleIcon} onClick={() => { setConfirmClose(false); void act("close"); }}>Close pull request</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </section>
  );
}
