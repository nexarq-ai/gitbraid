import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { GitBranchIcon, LockSimpleIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from "@phosphor-icons/react";
import type { BranchList, BranchProtection as Protection, BranchRuleInput, LanderRole, Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { RouteProgress } from "./WorkspaceLoader";
import "./pull-requests.css";

type DraftRule = BranchRuleInput & { id: string; checks: string };
const landerRoles: LanderRole[] = ["Maintainer", "Owner"];
const toDraft = (rule: BranchRuleInput): DraftRule => ({ ...rule, id: crypto.randomUUID(), checks: rule.requiredCheckNames.join("\n") });
const toInput = ({ pattern, requirePullRequest, requiredApprovals, preventSelfApproval, restrictLanders, checks }: DraftRule): BranchRuleInput => ({ pattern: pattern.trim(), requirePullRequest, requiredApprovals, preventSelfApproval, restrictLanders, requiredCheckNames: checks.split(/[\n,]/).map(name => name.trim()).filter(Boolean) });

export default function BranchProtection({ repository, canManage, onNotify }: { repository: Repository; canManage: boolean; onNotify: (message: string) => void }) {
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [protection, setProtection] = useState<Protection | null>(null);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const base = `/api/repositories/${encodeURIComponent(repository.id)}`;

  useEffect(() => {
    let active = true;
    setLoadError("");
    Promise.all([request<BranchList>(`${base}/branches`), request<Protection>(`${base}/branch-protection`)])
      .then(([list, current]) => { if (!active) return; setBranches(list); setProtection(current); setRules(current.rules.map(toDraft)); })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Branch settings could not be loaded."); });
    return () => { active = false; };
  }, [base, attempt]);

  const update = (id: string, patch: Partial<DraftRule>) => setRules(current => current.map(rule => rule.id === id ? { ...rule, ...patch } : rule));

  async function save() {
    if (busy) return;
    const body = { rules: rules.map(toInput) };
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await request<Protection>(`${base}/branch-protection`, body, mutation.current.key);
      mutation.current = null;
      setProtection(saved);
      setRules(saved.rules.map(toDraft));
      onNotify("Branch protection saved.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Branch protection could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt(value => value + 1)} />;
  if (!branches || !protection) return <RouteProgress />;
  const readOnly = !canManage || busy;
  const patterns = rules.map(rule => rule.pattern.trim());
  const invalid = rules.some((rule, index) => !rule.pattern.trim() || patterns.indexOf(rule.pattern.trim()) !== index);
  return (
    <div className="branch-settings">
      <div className="repository-work-heading"><div><h2>Branches &amp; protection</h2><p>Protected branches only change through pull requests or missions that pass checks and get approval on the exact revision.</p></div></div>
      <section className="panel">
        <div className="panel-header"><h2>Branches</h2><span className="number-tag">{branches.branches.length}</span></div>
        <div className="table-scroll">
          <table className="resource-table">
            <thead><tr><th>Branch</th><th>Head</th><th>Status</th></tr></thead>
            <tbody>
              {branches.branches.map(branch => (
                <tr key={branch.name}>
                  <td><div className="resource-name"><GitBranchIcon size={18} /><div><code>{branch.name}</code>{(branch.ahead !== undefined || branch.behind !== undefined) && <small>{branch.ahead ?? 0} ahead · {branch.behind ?? 0} behind</small>}</div></div></td>
                  <td><code>{branch.headSha.slice(0, 12)}</code></td>
                  <td className="branch-flags">{branch.default && <span className="pill">Default</span>}{branch.protected && <span className="pill approved"><LockSimpleIcon size={11} />Protected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel branch-rules">
        <div className="panel-header">
          <h2>Protection rules</h2>
          {canManage && <Button variant="secondary" size="base" icon={PlusIcon} disabled={busy || rules.length >= 20} onClick={() => setRules(current => [...current, toDraft({ pattern: "", requirePullRequest: true, requiredApprovals: 1, requiredCheckNames: [], preventSelfApproval: true, restrictLanders: [] })])}>Add rule</Button>}
        </div>
        <div className="panel-body">
          {!protection.configured && <p className="branch-rule-note">No rules have been saved. The default rule below protects <code>{protection.defaultBranch}</code>.</p>}
          {!canManage && <p className="branch-rule-note">Only workspace owners can change protection rules.</p>}
          {!rules.length && <p className="branch-rule-note">No branches are protected.</p>}
          {rules.map((rule, index) => (
            <fieldset className="branch-rule" key={rule.id} disabled={readOnly} aria-label={`Rule ${index + 1}`}>
              <div className="branch-rule-row">
                <div className="form-field"><label htmlFor={`rule-pattern-${rule.id}`}>Branch name or pattern</label><Input id={`rule-pattern-${rule.id}`} maxLength={200} value={rule.pattern} placeholder="release/*" aria-invalid={!rule.pattern.trim() || patterns.indexOf(rule.pattern.trim()) !== index} onChange={event => update(rule.id, { pattern: event.target.value })} /></div>
                <div className="form-field branch-rule-approvals"><label htmlFor={`rule-approvals-${rule.id}`}>Required approvals</label><select id={`rule-approvals-${rule.id}`} value={rule.requiredApprovals} onChange={event => update(rule.id, { requiredApprovals: Number(event.target.value) })}>{[0, 1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count}</option>)}</select></div>
                {canManage && <Button variant="ghost" size="base" icon={TrashIcon} aria-label={`Remove rule ${rule.pattern || index + 1}`} onClick={() => setRules(current => current.filter(item => item.id !== rule.id))}>Remove</Button>}
              </div>
              <div className="branch-rule-options">
                <label><input type="checkbox" checked={rule.requirePullRequest} onChange={event => update(rule.id, { requirePullRequest: event.target.checked })} />Require a pull request before landing</label>
                <label><input type="checkbox" checked={rule.preventSelfApproval} onChange={event => update(rule.id, { preventSelfApproval: event.target.checked })} />Authors cannot approve their own changes</label>
                <span>Who can land:</span>
                {landerRoles.map(role => <label key={role}><input type="checkbox" checked={rule.restrictLanders.includes(role)} onChange={event => update(rule.id, { restrictLanders: event.target.checked ? [...rule.restrictLanders, role] : rule.restrictLanders.filter(item => item !== role) })} />{role}</label>)}
                {!rule.restrictLanders.length && <small>Anyone with land permission</small>}
              </div>
              <div className="form-field"><label htmlFor={`rule-checks-${rule.id}`}>Required check names <span className="proposal-optional">(optional, one per line)</span></label><textarea id={`rule-checks-${rule.id}`} rows={2} value={rule.checks} placeholder="test" onChange={event => update(rule.id, { checks: event.target.value })} /></div>
              <p className="branch-rule-fixed"><ShieldCheckIcon size={14} />All checks must pass. New commits dismiss approvals because approval is pinned to the exact revision. Force pushes are blocked.</p>
            </fieldset>
          ))}
          {error && <div className="error-notice" role="alert">{error}</div>}
          {canManage && <div className="branch-rule-footer">{protection.updatedAt && <small>Last saved {relativeTime(protection.updatedAt)}{protection.updatedBy ? ` by ${protection.updatedBy}` : ""}</small>}<Button variant="primary" size="base" loading={busy} disabled={busy || invalid} onClick={() => void save()}>Save rules</Button></div>}
        </div>
      </section>
    </div>
  );
}
