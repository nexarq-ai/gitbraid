import type { AgentRun, Mission } from "../shared/types";

export default function AgentAssignment({
  run,
  mission,
}: {
  run: AgentRun;
  mission: Pick<Mission, "prompt" | "acceptanceCriteria">;
}) {
  const prefix = `${mission.prompt}\nYou are ${run.name} (${run.role}). Your assigned task: `;
  const suffix = `\nPreserve existing tests and run them.${mission.acceptanceCriteria?.length ? `\nAcceptance criteria:\n${mission.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}` : ""}`;
  const assignment =
    run.assignment ??
    (run.task.startsWith(prefix) && run.task.endsWith(suffix)
      ? run.task.slice(prefix.length, -suffix.length)
      : run.task);
  const preview =
    assignment.length > 420
      ? `${assignment.slice(0, 420).trimEnd()}…`
      : assignment;
  return (
    <div className="agent-assignment">
      <p>{preview}</p>
      {(assignment !== run.task || assignment.length > 420) && (
        <details>
          <summary>Full agent instructions</summary>
          <pre>{run.task}</pre>
        </details>
      )}
    </div>
  );
}
