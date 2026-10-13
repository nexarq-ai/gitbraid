import architecture from "./assets/docs/architecture.svg";
import flow from "./assets/docs/flow.svg";
import trust from "./assets/docs/trust.svg";
import userJourney from "./assets/docs/user-journey.svg";
import agentLoop from "./assets/docs/agent-loop.svg";
import mcpConnection from "./assets/docs/mcp-connection.svg";
import executionLifecycle from "./assets/docs/execution-lifecycle.svg";
import roadmap from "./assets/docs/roadmap.svg";
import accessControl from "./assets/docs/access-control.svg";
import workersBuilds from "./assets/docs/workers-builds.svg";

export type DocumentationDiagram = { src: string; title: string; caption: string };

export const diagrams: Record<string, DocumentationDiagram> = {
  "gitflare-diagram:architecture": { src: architecture, title: "Gitflare architecture", caption: "One control plane connects the workspace, isolated execution, and repository storage." },
  "gitflare-diagram:flow": { src: flow, title: "From changes to a candidate", caption: "Separate task changes become one tested candidate before approval and trusted landing." },
  "gitflare-diagram:trust": { src: trust, title: "Execution and landing boundaries", caption: "Task execution and trusted landing have different credentials and authority." },
  "gitflare-diagram:user-journey": { src: userJourney, title: "The workspace review journey", caption: "Start with intent and a pinned repository, then review evidence before exact-candidate approval and separate landing." },
  "gitflare-diagram:agent-loop": { src: agentLoop, title: "AI clients and task agents", caption: "External clients act with their user's current authority; runtime task agents receive independently scoped fork access." },
  "gitflare-diagram:mcp-connection": { src: mcpConnection, title: "An authenticated MCP request", caption: "The official Workers MCP handler uses the same authorization, validation and state checks as the workspace UI." },
  "gitflare-diagram:execution-lifecycle": { src: executionLifecycle, title: "The execution lifecycle", caption: "Two isolated changes need individual and combined checks. Failures and cancellation retain evidence rather than becoming success." },
  "gitflare-diagram:roadmap": { src: roadmap, title: "Implementation and evidence", caption: "Implemented source, pending live proof and deferred capabilities are distinct states." },
  "gitflare-diagram:access-control": { src: accessControl, title: "How access is checked", caption: "Permission combines current identity, role, resource scope, credential limits and operation state." },
  "gitflare-diagram:workers-builds": { src: workersBuilds, title: "The planned Workers Builds path", caption: "Artifacts supports a native Cloudflare Builds path. Gitflare configuration and build-result ingestion remain planned." },
};
