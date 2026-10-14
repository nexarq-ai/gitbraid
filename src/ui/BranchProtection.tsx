import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { CopyIcon, GitBranchIcon, GitPullRequestIcon, LockSimpleIcon, PlusIcon, ShieldCheckIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import type { AccessSnapshot, BranchChangeResult, BranchInfo, BranchList, BranchProtection as Protection, BranchRuleInput, LanderRole, Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { navigate } from "./router";
import { RouteProgress } from "./WorkspaceLoader";
import "./pull-requests.css";
import "./branches.css";

type DraftRule = BranchRuleInput & { id: string; checks: string };
const landerRoles: LanderRole[] = ["Maintainer", "Owner"];
const toDraft = (rule: BranchRuleInput): DraftRule => ({ ...rule, id: crypto.randomUUID(), checks: rule.requiredCheckNames.join("\n") });
const toInput = ({ pattern, requirePullRequest, requiredApprovals, preventSelfApproval, restrictLanders, checks }: DraftRule): BranchRuleInput => ({ pattern: pattern.trim(), requirePullRequest, requiredApprovals, preventSelfApproval, restrictLanders, requiredCheckNames: checks.split(/[\n,]/).map(name => name.trim()).filter(Boolean) });

export const createBranch = (repositoryId: string, name: string, from: string | undefined, key: string) => request<BranchChangeResult>(`/api/repositories/${encodeURIComponent(repositoryId)}/branches`, { name, ...(from ? { from } : {}) }, key);

export function BranchCreated({ repositoryId, name, onDismiss, onNotify }: { repositoryId: string; name: string; onDismiss: () => void; onNotify?: (message: string) => void }) {
  const command = `git fetch && git switch ${name}`;
  const pull = `repository/${repositoryId}/pulls/new?branch=${encodeURIComponent(name)}`;
  return (
    <section className="panel branch-created" role="status">
      <div className="panel-header"><h2>Branch <code>{name}</code> is ready</h2><Button variant="ghost" size="base" shape="square" aria-label="Dismiss" icon={XIcon} onClick={onDismiss} /></div>
      <div className="panel-body">
        <p>Fetch it in your clone and switch to it:</p>
        <div className="clipboard-row"><code>{command}</code><Button variant="ghost" size="base" shape="square" aria-label={`Copy ${command}`} icon={CopyIcon} onClick={() => void navigator.clipboard.writeText(command).then(() => onNotify?.("Command copied.")).catch(() => onNotify?.("Copy is unavailable in this browser."))} /></div>
        <a className="text-link" href={`/${pull}`} onClick={event => { event.preventDefault(); navigate(pull); }}><GitPullRequestIcon size={14} />Open a pull request from {name}</a>
      </div>
    </section>
  );
}

export default function BranchProtection({ repository, canManage, onNotify }: { repository: Repository; canManage: boolean; onNotify: (message: string) => void }) {
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [protection, setProtection] = useState<Protection | null>(null);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const [canContribute, setCanContribute] = useState(false);
  const [draft, setDraft] = useState<{ name: string; source: "branch" | "commit"; branch: string; sha: string } | null>(null);
  const [deleting, setDeleting] = useState<BranchInfo | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState("");
  const [created, setCreated] = useState("");
  const branchKey = useRef<{ signature: string; key: string } | null>(null);
  const base = `/api/repositories/${encodeURIComponent(repository.id)}`;

  useEffect(() => {
    let active = true;
    request<AccessSnapshot>("/api/access").then(access => { if (active) setCanContribute(access.permissions.includes("contribute")); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError("");
    Promise.all([request<BranchList>(`${base}/branches`), request<Protection>(`${base}/branch-protection`)])
      .then(([list, current]) => { if (!active) return; setBranches(list); setProtection(current); setRules(current.rules.map(toDraft)); })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Branch settings could not be loaded."); });
    return () => { active = false; };
  }, [base, attempt]);

  const refreshBranches = () => request<BranchList>(`${base}/branches`).then(setBranches).catch(() => {});

  async function changeBranch(path: string, body: Record<string, unknown>, done: () => void) {
    if (branchBusy) return;
    const signature = JSON.stringify([path, body]);
    if (branchKey.current?.signature !== signature) branchKey.current = { signature, key: crypto.randomUUID() };
    setBranchBusy(true); setBranchError("");
    try {
      await request<BranchChangeResult>(`${base}/${path}`, body, branchKey.current.key);
      branchKey.current = null;
      done();
      await refreshBranches();
    } catch (failure) { setBranchError(failure instanceof Error ? failure.message : "The branch could not be changed."); }
    finally { setBranchBusy(false); }
  }

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
        <div className="panel-header"><h2>Branches</h2><div className="branch-header-actions"><span className="number-tag">{branches.branches.length}</span>{canContribute && <Button variant="secondary" size="base" icon={PlusIcon} onClick={() => { setBranchError(""); setDraft({ name: "", source: "branch", branch: branches.defaultBranch, sha: "" }); }}>New branch</Button>}</div></div>
        <div className="table-scroll">
          <table className="resource-table">
            <thead><tr><th>Branch</th><th>Head</th><th>Status</th>{canContribute && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {branches.branches.map(branch => (
                <tr key={branch.name}>
                  <td><div className="resource-name"><GitBranchIcon size={18} /><div><code>{branch.name}</code>{(branch.ahead !== undefined || branch.behind !== undefined) && <small>{branch.ahead ?? 0} ahead · {branch.behind ?? 0} behind</small>}</div></div></td>
                  <td><code>{branch.headSha.slice(0, 12)}</code></td>
                  <td className="branch-flags">{branch.default && <span className="pill">Default</span>}{branch.protected && <span className="pill approved"><LockSimpleIcon size={11} />Protected</span>}</td>
                  {canContribute && <td className="branch-actions">{!branch.default && !branch.protected && <Button variant="ghost" size="base" icon={TrashIcon} aria-label={`Delete ${branch.name}`} onClick={() => { setBranchError(""); setDeleting(branch); }}>Delete</Button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {created && <BranchCreated repositoryId={repository.id} name={created} onDismiss={() => setCreated("")} onNotify={onNotify} />}
      <Dialog.Root open={draft !== null} onOpenChange={open => { if (!open && !branchBusy) setDraft(null); }}>
        <Dialog size="sm" className="dialog-content confirm-dialog">
          <Dialog.Title className="dialog-title">New branch</Dialog.Title>
          <Dialog.Description className="dialog-description">The branch points at an existing commit. Nothing is committed.</Dialog.Description>
          {draft && <form onSubmit={event => { event.preventDefault(); const name = draft.name.trim(); void changeBranch("branches", { name, from: draft.source === "branch" ? draft.branch : draft.sha }, () => { setDraft(null); setCreated(name); onNotify(`Branch ${name} created.`); }); }}>
            <div className="form-field"><label htmlFor="branch-name">Branch name</label><Input id="branch-name" required maxLength={200} autoFocus disabled={branchBusy} value={draft.name} placeholder="feature/checkout-retries" onChange={event => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="form-field"><span>From</span><div className="branch-source" role="radiogroup" aria-label="Branch source"><label><input type="radio" name="branch-source" checked={draft.source === "branch"} disabled={branchBusy} onChange={() => setDraft({ ...draft, source: "branch" })} />Branch</label><label><input type="radio" name="branch-source" checked={draft.source === "commit"} disabled={branchBusy} onChange={() => setDraft({ ...draft, source: "commit" })} />Commit SHA</label></div>
              {draft.source === "branch" ? <select aria-label="Source branch" disabled={branchBusy} value={draft.branch} onChange={event => setDraft({ ...draft, branch: event.target.value })}>{branches.branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}{branch.default ? " (default)" : ""}</option>)}</select> : <Input aria-label="Commit SHA" required maxLength={40} disabled={branchBusy} value={draft.sha} placeholder="Full 40 character commit SHA" onChange={event => setDraft({ ...draft, sha: event.target.value.trim().toLowerCase() })} />}
            </div>
            {branchError && <div className="error-notice" role="alert">{branchError}</div>}
            <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={branchBusy} onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={branchBusy} disabled={branchBusy || !draft.name.trim() || (draft.source === "commit" && !/^[a-f0-9]{40}$/.test(draft.sha))}>Create branch</Button></div>
          </form>}
        </Dialog>
      </Dialog.Root>
      <Dialog.Root open={deleting !== null} onOpenChange={open => { if (!open && !branchBusy) setDeleting(null); }}>
        <Dialog size="sm" className="dialog-content confirm-dialog">
          <Dialog.Title className="dialog-title">Delete {deleting?.name}?</Dialog.Title>
          <Dialog.Description className="dialog-description">The branch ref is removed; commits it shares with other branches or tags stay in the repository. The delete is refused if the branch moved from <code>{deleting?.headSha.slice(0, 12)}</code>.</Dialog.Description>
          {branchError && <div className="error-notice" role="alert">{branchError}</div>}
          <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={branchBusy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" size="base" type="button" loading={branchBusy} disabled={branchBusy} onClick={() => { const target = deleting; if (target) void changeBranch("branches/delete", { name: target.name, expectedHeadSha: target.headSha }, () => { setDeleting(null); if (created === target.name) setCreated(""); onNotify(`Branch ${target.name} deleted.`); }); }}>Delete branch</Button></div>
        </Dialog>
      </Dialog.Root>
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
