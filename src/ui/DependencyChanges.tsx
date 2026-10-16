import { PackageIcon } from "@phosphor-icons/react";
import type { Mission } from "../shared/types";

export function DependencyChangesPanel({ mission }: { mission: Mission }) {
  const manifests = mission.dependencyChanges ?? [];
  if (!manifests.length) return null;
  const approval = mission.dependencyApproval;
  const current = approval && approval.candidateSha === mission.candidateSha && approval.baseSha === mission.baseSha && approval.epoch === mission.epoch;
  return (
    <section className="panel dependency-changes" aria-labelledby="dependency-changes-title">
      <div className="panel-header">
        <h2 id="dependency-changes-title">Dependency changes</h2>
        <PackageIcon size={16} color="#8b99ab" />
      </div>
      <div className="panel-body">
        <p className="dependency-note">
          {current
            ? <>Approved by Owner <strong>{approval.approvedBy}</strong> for revision <code>{approval.candidateSha.slice(0, 12)}</code>.</>
            : <>These package changes need a workspace Owner's explicit approval before this revision can land.</>}
        </p>
        {manifests.map((manifest) => (
          <div key={manifest.path} className="dependency-manifest">
            <h3><code>{manifest.path}</code></h3>
            <table>
              <thead>
                <tr><th>Package</th><th>Section</th><th>Change</th><th>Version</th></tr>
              </thead>
              <tbody>
                {manifest.changes.map((change) => (
                  <tr key={`${change.section}:${change.name}`}>
                    <td><code>{change.name}</code></td>
                    <td>{change.section}</td>
                    <td>{change.change}</td>
                    <td><code>{change.change === "added" ? change.to : change.change === "removed" ? change.from : `${change.from} → ${change.to}`}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DependencyApprovalControl({ isOwner, checked, onChange }: { isOwner: boolean; checked: boolean; onChange: (value: boolean) => void }) {
  if (!isOwner) return <span className="dependency-ack muted">Dependency changes need an Owner's approval</span>;
  return (
    <label className="dependency-ack">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      I approve these dependency changes
    </label>
  );
}
