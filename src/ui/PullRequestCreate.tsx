import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { GitBranchIcon, GitPullRequestIcon, LockSimpleIcon, RobotIcon } from "@phosphor-icons/react";
import type { BranchList, CreatePullRequestInput, Mission, Repository } from "../shared/types";
import { request } from "./api";
import { EmptyState, ErrorNotice } from "./components";
import { quoteGitArgument } from "./RepositoryImport";
import { navigate as goTo } from "./router";
import { RouteProgress } from "./WorkspaceLoader";
import "./pull-requests.css";

function PullChoice({ repository, onAskAgents }: { repository: Repository; onAskAgents: () => void }) {
  return (
    <div className="pull-choice" role="group" aria-label="How to make this change">
      <button type="button" className="ai-only" aria-pressed="false" onClick={onAskAgents}><RobotIcon size={20} /><div><strong>Ask AI agents</strong><span>Describe the change. Agents write it in isolated forks of {repository.name}, and their result becomes this pull request.</span></div></button>
      <button type="button" aria-pressed="true"><GitBranchIcon size={20} /><div><strong>From a branch</strong><span>Propose a branch you pushed with Git or created on the Branches page.</span></div></button>
    </div>
  );
}

export default function PullRequestCreate({ repository, canContribute, canExecute, onCreated, onAskAgents }: { repository: Repository; canContribute: boolean; canExecute: boolean; onCreated: () => void; onAskAgents: () => void }) {
  const [list, setList] = useState<BranchList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<BranchList>(`/api/repositories/${encodeURIComponent(repository.id)}/branches`)
      .then(result => { if (!active) return; setList(result); const requested = new URLSearchParams(window.location.search).get("branch"); setBranch(current => current || (requested && result.branches.some(item => item.name === requested && !item.default) ? requested : "") || result.branches.find(item => !item.default)?.name || ""); })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Branches could not be loaded."); });
    return () => { active = false; };
  }, [repository.id, attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !branch) return;
    const body: CreatePullRequestInput = { title: title.trim() || branch, branch, ...(description.trim() ? { description: description.trim() } : {}) };
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const created = await request<Mission>(`/api/repositories/${encodeURIComponent(repository.id)}/pulls`, body, mutation.current.key);
      mutation.current = null;
      onCreated();
      goTo(`mission/${created.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The pull request could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError || !list) return <div className="pull-create"><PullChoice repository={repository} onAskAgents={onAskAgents} />{loadError ? <ErrorNotice message={loadError} onRetry={() => setAttempt(value => value + 1)} /> : <RouteProgress />}</div>;
  const candidates = list.branches.filter(item => !item.default);
  const selected = candidates.find(item => item.name === branch);
  const gitUrl = list.gitUrl || `${location.origin}/git/${repository.name}.git`;
  if (!candidates.length)
    return (
      <div className="pull-create">
      <PullChoice repository={repository} onAskAgents={onAskAgents} />
      <section className="panel">
        <EmptyState icon={<GitBranchIcon size={25} />} title="Push a branch first" description={`A pull request proposes a branch other than ${list.defaultBranch}. Push your work to a new branch, then come back.`} />
        <div className="pull-git-steps"><pre className="code-output">{`git push ${quoteGitArgument(gitUrl)} HEAD:refs/heads/my-branch`}</pre><p>Use any username. The password is a personal session token from <a href="/settings">Settings → Account</a>. You can also create a branch on the <a href={`/repository/${repository.id}/settings/branches`}>Branches</a> page.</p></div>
      </section>
      </div>
    );
  return (
    <form className="pull-create" onSubmit={event => void submit(event)}>
      <PullChoice repository={repository} onAskAgents={onAskAgents} />
      <section className="panel">
        <div className="panel-header"><h2>Open a pull request</h2></div>
        <div className="panel-body">
          <div className="pull-create-branches">
            <div className="form-field"><label htmlFor="pull-branch">Branch</label><select id="pull-branch" required disabled={busy} value={branch} onChange={event => setBranch(event.target.value)}>{candidates.map(item => <option key={item.name} value={item.name}>{item.name}{item.protected ? " (protected)" : ""}</option>)}</select></div>
            <div className="form-field"><label htmlFor="pull-target">Into</label><Input id="pull-target" readOnly value={list.defaultBranch} /></div>
          </div>
          {selected && <p className="pull-create-meta"><code>{selected.headSha.slice(0, 12)}</code>{selected.protected && <span><LockSimpleIcon size={12} />Protected</span>}{selected.ahead !== undefined && <span>{selected.ahead} ahead</span>}{selected.behind !== undefined && <span>{selected.behind} behind {list.defaultBranch}</span>}</p>}
          <div className="form-field"><label htmlFor="pull-title">Title <span className="proposal-optional">(optional)</span></label><Input id="pull-title" maxLength={120} disabled={busy} value={title} placeholder={branch} onChange={event => setTitle(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="pull-description">Description <span className="proposal-optional">(optional)</span></label><textarea id="pull-description" rows={6} maxLength={8000} disabled={busy} value={description} placeholder="What changed and how to review it…" onChange={event => setDescription(event.target.value)} /></div>
          {error && <div className="error-notice" role="alert">{error}</div>}
        </div>
      </section>
      <div className="proposal-create-footer"><p><GitPullRequestIcon size={17} aria-hidden="true" />Checks start on the branch head when you open the pull request.</p><div><Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => goTo(`repository/${repository.id}/pulls`)}>Cancel</Button><Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || !branch || !canContribute || !canExecute}>Open pull request</Button></div></div>
    </form>
  );
}
