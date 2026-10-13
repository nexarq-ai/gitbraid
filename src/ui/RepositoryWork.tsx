import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import {
  GitBranchIcon,
  RobotIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import type { Mission } from "../shared/types";
import { EmptyState, Status, relativeTime } from "./components";
import AgentAssignment from "./AgentAssignment";
import "./repository-work.css";

export default function RepositoryWork({
  tab,
  missions,
  canContribute,
  onCreate,
  onOpen,
}: {
  tab: string;
  missions: Mission[];
  canContribute: boolean;
  onCreate: () => void;
  onOpen: (id: string, tab?: string, runId?: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const runs = missions
    .filter((mission) => mission.epoch > 0)
    .flatMap((mission) => mission.runs.map((run) => ({ mission, run })));
  const checks = missions.flatMap((mission) =>
    mission.checks.map((check) => ({ mission, check })),
  );
  const individualPassed = checks.filter(
    ({ mission, check }) =>
      check.status === "passed" &&
      !!check.candidateSha &&
      mission.runs.some(
        (run) =>
          run.commitSha === check.candidateSha &&
          check.name.startsWith(`${run.name}:`),
      ),
  ).length;
  const combinedVerified = missions.filter((mission) => {
    const combinedChecks = mission.checks.filter(
      (check) =>
        !!mission.candidateSha &&
        check.candidateSha === mission.candidateSha &&
        !mission.runs.some((run) => check.name.startsWith(`${run.name}:`)),
    );
    return (
      combinedChecks.length > 0 &&
      mission.checks.every((check) => check.status === "passed")
    );
  }).length;
  const match = (text: string, status: string) =>
    text.toLowerCase().includes(search.toLowerCase()) &&
    (filter === "all" ||
      (filter === "open"
        ? !["integrated", "cancelled"].includes(status)
        : filter === "active"
          ? ["queued", "running", "checking"].includes(status)
          : status === filter));
  const filteredMissions = missions.filter((mission) =>
    match(`${mission.title} ${mission.prompt}`, mission.status),
  );
  const filteredRuns = runs.filter(({ mission, run }) =>
    match(
      `${mission.title} ${run.name} ${run.task} ${run.model ?? ""} ${run.branch ?? ""}`,
      run.status,
    ),
  );
  const filteredChecks = checks.filter(({ mission, check }) =>
    match(
      `${mission.title} ${check.name} ${check.candidateSha ?? ""}`,
      check.status,
    ),
  );
  const total =
    tab === "agents"
      ? runs.length
      : tab === "checks"
        ? checks.length
        : missions.length;
  const shown =
    tab === "agents"
      ? filteredRuns.length
      : tab === "checks"
        ? filteredChecks.length
        : filteredMissions.length;
  const filters =
    tab === "agents"
      ? ["all", "active", "completed", "failed", "cancelled"]
      : tab === "checks"
        ? ["all", "pending", "running", "passed", "failed", "skipped"]
        : [
            "all",
            "open",
            "draft",
            "active",
            "needs_review",
            "approved",
            "integrated",
            "failed",
            "cancelled",
          ];
  return (
    <>
      <div className="repository-work-heading">
        <div>
          <h2>
            {tab === "agents"
              ? "Agent runs"
              : tab === "checks"
                ? "Checks"
                : "Proposals"}
          </h2>
          <p>
            {tab === "agents"
              ? "Each task has its own isolated fork. Inspect actual execution and saved changes."
              : tab === "checks"
                ? "Recorded agent and combined checks, pinned to the revision they verified."
                : "Review changes produced by a mission, discuss the exact revision, and land approved work."}
          </p>
        </div>
      </div>
      {tab === "proposals" && (
        <p className="repository-work-safety">
          <ShieldCheckIcon size={16} />
          <span>
            <strong>
              {individualPassed} individual checks passed · {combinedVerified}{" "}
              combined candidates verified
            </strong>
            <br />
            Individual success does not establish combined safety. Review and
            approval apply to the exact candidate.
          </span>
        </p>
      )}
      <div className="repository-work-toolbar">
        <input
          aria-label={`Search ${tab}`}
          placeholder={`Search ${tab}…`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label={`Filter ${tab} by status`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          {filters.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All statuses" : value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <span>
          {shown} of {total}
        </span>
      </div>
      <section className="panel">
        {!shown ? (
          <EmptyState
            icon={
              tab === "agents" ? (
                <RobotIcon size={25} />
              ) : tab === "checks" ? (
                <ShieldCheckIcon size={25} />
              ) : (
                <GitBranchIcon size={25} />
              )
            }
            title={
              total
                ? "No matching results"
                : tab === "agents"
                  ? "No agent runs yet"
                  : tab === "checks"
                    ? "No checks recorded"
                    : "No proposals yet"
            }
            description={
              total
                ? "Try another search or status filter."
                : "Create a proposal draft with an outcome and agent tasks. Agents and checks run only after you choose Start."
            }
            action={
              total ? (
                <Button
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button disabled={!canContribute} onClick={onCreate}>
                  Create proposal
                </Button>
              )
            }
          />
        ) : tab === "agents" ? (
          <div className="repository-work-list">
            {filteredRuns.map(({ mission, run }) => (
              <article
                className="repository-work-item"
                key={`${mission.id}-${run.id}`}
              >
                <div className="repository-work-title">
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id, "agents", run.id)}
                  >
                    {run.name}
                  </button>
                  <Status status={run.status} />
                </div>
                <p>
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id)}
                  >
                    {mission.title}
                  </button>{" "}
                  · {run.role} · {run.model || "Model not recorded"}
                </p>
                <AgentAssignment run={run} mission={mission} />
                <div className="repository-work-meta">
                  <span>
                    Branch <code>{run.branch || "Not allocated"}</code>
                  </span>
                  <span>
                    Fork <code>{run.forkName || "Not allocated"}</code>
                  </span>
                  <span>
                    Revision{" "}
                    <code>
                      {run.commitSha?.slice(0, 12) || "No saved revision"}
                    </code>
                  </span>
                  <span>{run.changedFiles.length} changed files</span>
                </div>
                {run.error && (
                  <p className="repository-work-error">{run.error}</p>
                )}
                <button
                  className="text-link"
                  onClick={() => onOpen(mission.id, "agents", run.id)}
                >
                  View run details and logs →
                </button>
              </article>
            ))}
          </div>
        ) : tab === "checks" ? (
          <div className="repository-work-list">
            {filteredChecks.map(({ mission, check }) => (
              <article
                className="repository-work-item"
                key={`${mission.id}-${check.id}`}
              >
                <div className="repository-work-title">
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id, "checks")}
                  >
                    {check.name}
                  </button>
                  <Status status={check.status} />
                </div>
                <p>
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id, "checks")}
                  >
                    {mission.title}
                  </button>{" "}
                  ·{" "}
                  {check.candidateSha === mission.candidateSha &&
                  mission.candidateSha
                    ? "Combined candidate"
                    : check.candidateSha &&
                        mission.runs.some(
                          (run) => run.commitSha === check.candidateSha,
                        )
                      ? "Agent revision"
                      : "Combination check"}
                </p>
                <div className="repository-work-meta">
                  <span>
                    Revision{" "}
                    <code>
                      {check.candidateSha?.slice(0, 12) ||
                        "No revision recorded"}
                    </code>
                  </span>
                  {check.durationMs !== undefined && (
                    <span>{(check.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
                {check.output ? (
                  <details>
                    <summary>View check output</summary>
                    <pre className="code-output">{check.output}</pre>
                  </details>
                ) : (
                  <p>No output recorded.</p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="resource-table">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Status</th>
                  <th>Agents</th>
                  <th>Checks</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredMissions.map((mission) => (
                  <tr key={mission.id}>
                    <td>
                      <div className="resource-name">
                        <GitBranchIcon size={18} />
                        <div>
                          <button onClick={() => onOpen(mission.id)}>
                            {mission.title}
                          </button>
                          <small>
                            {mission.candidateSha
                              ? `Candidate ${mission.candidateSha.slice(0, 12)}`
                              : "No combined candidate"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Status status={mission.status} />
                    </td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => onOpen(mission.id, "agents")}
                      >
                        {mission.runs.length}{" "}
                        {mission.epoch > 0 ? "runs" : "planned tasks"}
                      </button>
                    </td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => onOpen(mission.id, "checks")}
                      >
                        {mission.checks.length
                          ? `${mission.checks.filter((check) => check.status === "passed").length}/${mission.checks.length} passed`
                          : "Not run"}
                      </button>
                    </td>
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
