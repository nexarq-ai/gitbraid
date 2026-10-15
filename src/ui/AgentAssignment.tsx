import type { AgentRun, Mission } from "../shared/types";

export default function AgentAssignment({
  run,
  mission,
}: {
  run: Pick<AgentRun, "name" | "role" | "assignment"> & { task?: string };
  mission: Pick<Mission, "prompt" | "acceptanceCriteria">;
}) {
  const prefix = `${mission.prompt}\nYou are ${run.name} (${run.role}). Your assigned task: `;
  const suffix = `\nPreserve existing tests and run them.${mission.acceptanceCriteria?.length ? `\nAcceptance criteria:\n${mission.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}` : ""}`;
  const task = run.task;
  const assignment =
    run.assignment ??
    (task === undefined
      ? ""
      : task.startsWith(prefix) && task.endsWith(suffix)
        ? task.slice(prefix.length, -suffix.length)
        : task);
  const preview =
    assignment.length > 420
      ? `${assignment.slice(0, 420).trimEnd()}…`
      : assignment;
  return (
    <div className="agent-assignment">
      <p>{preview}</p>
      {task !== undefined && (assignment !== task || assignment.length > 420) && (
        <details>
          <summary>Full agent instructions</summary>
          <pre>{task}</pre>
        </details>
      )}
    </div>
  );
}
