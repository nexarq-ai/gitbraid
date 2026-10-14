import { GitBranchIcon } from "@phosphor-icons/react";
import "./auth-loading.css";

export default function WorkspaceLoader() {
  return (
    <main className="workspace-loading-screen">
      <div className="workspace-loading-content">
        <div className="workspace-loading-status" role="status">
          <div className="workspace-loading-brand" aria-hidden="true">
            <GitBranchIcon size={30} weight="bold" />
            <span>gitflare</span>
          </div>
          <svg className="workspace-loading-trace" viewBox="0 0 160 40" fill="none" aria-hidden="true">
            <path d="M8 8H49C65 8 65 20 81 20H152M8 32H49C65 32 65 20 81 20" />
            <path className="workspace-loading-flow" pathLength="100" d="M8 8H49C65 8 65 20 81 20H152" />
            <path className="workspace-loading-flow workspace-loading-flow-secondary" pathLength="100" d="M8 32H49C65 32 65 20 81 20H152" />
            <circle cx="8" cy="8" r="2.5" />
            <circle cx="8" cy="32" r="2.5" />
            <circle cx="152" cy="20" r="2.5" />
          </svg>
          <p>Loading workspace</p>
        </div>
        <a className="workspace-loading-back" href="/">Back to Gitflare</a>
      </div>
    </main>
  );
}

export function RouteProgress() {
  return <div className="route-progress" role="progressbar" aria-label="Loading page" aria-busy="true"><span /></div>;
}
