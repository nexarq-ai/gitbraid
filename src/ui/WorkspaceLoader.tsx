import { OperationTrack, useRouteMotion } from "./OperationMotion";
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
          <OperationTrack kind="load" />
          <p>Loading workspace</p>
        </div>
        <a className="workspace-loading-back" href="/">Back to Gitflare</a>
      </div>
    </main>
  );
}

export function RouteProgress() {
  const ref = useRouteMotion();
  return <div ref={ref} className="route-progress operation-route" role="progressbar" aria-label="Loading page" aria-busy="true"><span /></div>;
}
