import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { ArrowClockwiseIcon, ArrowLeftIcon, GitBranchIcon, PlusIcon, RobotIcon, ShieldCheckIcon, TrashIcon } from '@phosphor-icons/react';
import type { AgentTask, Mission, Repository, ModelConnectionsSnapshot } from '../shared/types';
import { request, RequestError } from './api';
import './proposal-create.css';

interface DraftAgent extends AgentTask { id: string; }
interface ProposalBase { branch: string; commitSha: string; commitMessage?: string; author?: string; date?: string; }
const startingAgents = (): DraftAgent[] => [
  { id: crypto.randomUUID(), name: 'Implementation', role: 'Core implementation', task: '' },
  { id: crypto.randomUUID(), name: 'Integration', role: 'Complementary implementation', task: '' },
];

export default function ProposalCreate({ repositories, repositoryId, canContribute, canManage = false, onImportRepository, onBack, onCreateRepository, onCreated }: { repositories: Repository[]; repositoryId?: string; canContribute: boolean; canManage?: boolean; onImportRepository?: (id: string) => void; onBack: () => void; onCreateRepository: () => void; onCreated: (proposal: Mission) => Promise<void> }) {
  const [repoId, setRepoId] = useState(repositoryId ?? repositories[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [criteria, setCriteria] = useState('');
  const [mode, setMode] = useState<'combine' | 'race'>('combine');
  const [agents, setAgents] = useState<DraftAgent[]>(startingAgents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [base, setBase] = useState<(ProposalBase & { repositoryId: string }) | null>(null);
  const [baseLoading, setBaseLoading] = useState(false);
  const [baseError, setBaseError] = useState('');
  const [baseRefresh, setBaseRefresh] = useState(0);
  const [baseStale, setBaseStale] = useState(false);
  const [emptyRepository, setEmptyRepository] = useState(false);
  const [models, setModels] = useState<ModelConnectionsSnapshot | null>(null);
  const [modelError, setModelError] = useState('');
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const names = agents.map(agent => agent.name.trim().toLowerCase());
  const duplicateNames = names.filter((name, index) => name && names.indexOf(name) !== index);
  const repository = repositories.find(item => item.id === repoId);
  const loadedBase = base?.repositoryId === repoId ? base : null;

  useEffect(() => {
    let active = true;
    setModels(null); setModelError('');
    void request<ModelConnectionsSnapshot>('/api/models').then(result => { if (active) setModels(result); }).catch(failure => { if (active) setModelError(failure instanceof Error ? failure.message : 'Models could not be loaded.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setBase(null); setBaseError(''); setEmptyRepository(false);
    if (!repoId) { setBaseLoading(false); return; }
    setBaseLoading(true);
    void request<ProposalBase>(`/api/repositories/${repoId}/proposal-base`).then(result => {
      if (!active) return;
      if (!/^[a-f0-9]{40}$/.test(result.commitSha)) throw new Error('The repository returned an invalid base revision. Refresh to try again.');
      setBase({ ...result, repositoryId: repoId }); setBaseStale(false);
    }).catch(failure => { if (active) { setEmptyRepository(failure instanceof RequestError && failure.code === 'EMPTY_REPOSITORY'); setBaseError(failure instanceof Error ? failure.message : 'The current repository revision could not be loaded.'); } }).finally(() => { if (active) setBaseLoading(false); });
    return () => { active = false; };
  }, [repoId, baseRefresh]);

  function updateAgent(id: string, patch: Partial<AgentTask>) { setAgents(current => current.map(agent => agent.id === id ? { ...agent, ...patch } : agent)); }
  function addAgent() {
    if (agents.length >= 8) return;
    let number = agents.length + 1;
    while (names.includes(`agent ${number}`)) number++;
    setAgents(current => [...current, { id: crypto.randomUUID(), name: `Agent ${number}`, role: 'Implementation', task: '' }]);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !canContribute) return;
    const acceptanceCriteria = criteria.split('\n').map(line => line.trim()).filter(Boolean);
    if (!loadedBase || baseLoading || baseStale) { setError("Load and review the current repository base before creating the mission."); return; }
    if (!repository) { setError('Choose an available repository.'); return; }
    if (!models || agents.some(agent => !models.models.some(model => model.id === (agent.model ?? 'openai/gpt-6-luna')))) { setError('Choose an enabled model for every agent. A workspace owner can manage AI models in Settings.'); return; }
    if (mode === 'race' && agents.length < 2) { setError('Race mode needs at least two independent candidates.'); return; }
    if (duplicateNames.length) { setError('Give each agent a distinct name.'); return; }
    if (acceptanceCriteria.length > 12 || acceptanceCriteria.some(line => line.length > 500)) { setError('Use up to 12 acceptance criteria, with at most 500 characters per line.'); return; }
    if (!title.trim() || prompt.trim().length < 10 || agents.some(agent => !agent.name.trim() || !agent.role.trim() || agent.task.trim().length < 10)) { setError("Add a mission title, an outcome, and a name, role and assignment for every agent. Outcomes and assignments need at least 10 characters."); return; }
    const body = { mode, repositoryId: repoId, expectedBaseSha: loadedBase.commitSha, title: title.trim(), prompt: prompt.trim(), acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : undefined, tasks: agents.map(({ name, role, task, model }) => ({ name: name.trim(), role: role.trim(), task: task.trim(), model: model ?? 'openai/gpt-6-luna' })) };
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await request<Mission>('/api/missions', body, mutation.current.key);
      await onCreated(result);
      mutation.current = null;
    } catch (failure) { if (failure instanceof RequestError && failure.code === 'STALE_PROPOSAL_BASE') setBaseStale(true); setError(failure instanceof Error ? failure.message : "The mission could not be created. Your draft is preserved."); }
    finally { setBusy(false); }
  }

  return <section className="proposal-create">
    <button className="header-back" disabled={busy} onClick={onBack}><ArrowLeftIcon size={13} />{repositoryId ? 'Back to repository missions' : 'Back to missions'}</button>
    <div className="page-heading"><div><h1>Create a mission</h1><p>Define the outcome and give each agent a clear part of the work.</p></div></div>
    {!canContribute ? <div className="error-notice" role="alert">Contribute permission is required to create a mission.</div> : !repositories.length ? <section className="panel proposal-no-repository"><GitBranchIcon size={28} /><h2>Create a repository first</h2><p>A mission needs a repository for its source, agent branches and checks.</p><Button variant="primary" size="base" icon={PlusIcon} onClick={onCreateRepository}>Create repository</Button></section> : <form onSubmit={event => void submit(event)}>
      <div className="proposal-create-layout"><div className="proposal-main-fields">
        <section className="panel proposal-section"><div className="panel-header"><h2>Mission details</h2></div><div className="panel-body"><div className="form-field"><label htmlFor="proposal-repository">Repository</label><select id="proposal-repository" required disabled={busy} value={repoId} onChange={event => { setRepoId(event.target.value); setBaseStale(false); }}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}{repo.provider === 'local' ? ' (local)' : ''}</option>)}</select></div><div className="form-field"><label htmlFor="proposal-title">Mission title</label><Input id="proposal-title" required maxLength={120} disabled={busy} value={title} placeholder="Make checkout resilient to retries" onChange={event => setTitle(event.target.value)} /></div><div className="form-field"><label htmlFor="proposal-outcome">What should change?</label><textarea id="proposal-outcome" required minLength={10} maxLength={8000} disabled={busy} rows={5} value={prompt} placeholder="Describe the outcome, relevant context, and constraints…" onChange={event => setPrompt(event.target.value)} /></div><div className="form-field"><label htmlFor="proposal-criteria">Acceptance criteria <span className="proposal-optional">(optional)</span></label><textarea id="proposal-criteria" rows={3} maxLength={6011} disabled={busy} value={criteria} placeholder="One criterion per line…" aria-describedby="proposal-criteria-hint" onChange={event => setCriteria(event.target.value)} /><small id="proposal-criteria-hint">Up to 12 criteria. Each criterion can contain up to 500 characters.</small></div></div></section>
        <fieldset className="mission-mode"><legend>How agents work</legend><label className={mode === "combine" ? "selected" : ""}><input type="radio" name="mission-mode" checked={mode === "combine"} disabled={busy} onChange={() => setMode("combine")} /><span><strong>Combine</strong>Assign separate parts, then test their merged changes.</span></label><label className={mode === "race" ? "selected" : ""}><input type="radio" name="mission-mode" checked={mode === "race"} disabled={busy} onChange={() => setMode("race")} /><span><strong>Race</strong>Each agent attempts the whole mission. Compare passing candidates and choose one.</span></label></fieldset>
        <section className="proposal-agents" aria-labelledby="proposal-agents-title"><div className="proposal-agents-heading"><div><h2 id="proposal-agents-title">Agents <span>{agents.length} / 8</span></h2><p>{mode === "race" ? "Give each agent an independent approach to the complete outcome. Each candidate stays separate." : "Assign separate parts. Each agent gets its own isolated branch."}</p></div><Button type="button" variant="secondary" size="base" icon={PlusIcon} disabled={busy || agents.length >= 8} onClick={addAgent}>Add agent</Button></div>{duplicateNames.length > 0 && <p className="proposal-name-error" role="alert">Agent names must be unique.</p>}<div className="proposal-agent-grid">{agents.map((agent, index) => <section className="panel proposal-agent-card" key={agent.id} aria-label={`Agent ${index + 1} assignment`}><div className="proposal-agent-heading"><span><RobotIcon size={18} aria-hidden="true" />Agent {index + 1}</span><Button type="button" variant="ghost" size="base" icon={TrashIcon} disabled={busy || agents.length <= (mode === "race" ? 2 : 1)} aria-label={`Remove ${agent.name || `agent ${index + 1}`}`} onClick={() => setAgents(current => current.filter(item => item.id !== agent.id))}>Remove</Button></div><div className="proposal-agent-fields"><div className="form-field"><label htmlFor={`agent-name-${agent.id}`}>Name</label><Input id={`agent-name-${agent.id}`} required maxLength={60} disabled={busy} value={agent.name} aria-invalid={!!agent.name.trim() && names.filter(name => name === agent.name.trim().toLowerCase()).length > 1} onChange={event => updateAgent(agent.id, { name: event.target.value })} /></div><div className="form-field"><label htmlFor={`agent-role-${agent.id}`}>Role</label><Input id={`agent-role-${agent.id}`} required maxLength={80} disabled={busy} value={agent.role} placeholder="API implementation" onChange={event => updateAgent(agent.id, { role: event.target.value })} /></div><div className="form-field"><label htmlFor={`agent-model-${agent.id}`}>AI model</label><select id={`agent-model-${agent.id}`} required disabled={busy || !models} value={agent.model ?? "openai/gpt-6-luna"} onChange={event => updateAgent(agent.id, { model: event.target.value })}>{!models ? <option value="openai/gpt-6-luna">Loading models…</option> : <>{!models.models.some(model => model.id === (agent.model ?? "openai/gpt-6-luna")) && <option value={agent.model ?? "openai/gpt-6-luna"} disabled>Selected model is unavailable</option>}{models.models.map(model => <option key={model.id} value={model.id}>{model.label}{model.source === "workers-ai" ? " · Workers AI" : ""}{model.verification?.status === "verified" ? " · Verified" : " · Configured"}</option>)}</>}</select><small>The model is pinned to this assignment when the draft is saved.</small></div><div className="form-field"><label htmlFor={`agent-task-${agent.id}`}>Assignment</label><textarea id={`agent-task-${agent.id}`} required minLength={10} maxLength={2500} disabled={busy} rows={4} value={agent.task} placeholder={index === 0 ? 'Implement the core change. Describe the files or behavior this agent owns…' : 'Describe a complementary change and how it fits with the other assignments…'} onChange={event => updateAgent(agent.id, { task: event.target.value })} /></div></div></section>)}</div></section>
      </div><aside className="panel proposal-process"><div className="panel-header"><h2>From draft to landed changes</h2></div><ol><li><strong>Create the draft</strong><p>Save the outcome and agent assignments. Creating a draft does not start any agents.</p></li><li><strong>Start the agents</strong><p>Choose Start on the mission page when you are ready. Up to three agents work at once; additional assignments wait for a slot.</p></li><li><strong>Review and land</strong><p>Inspect the combined changes and checks, then approve the exact revision before landing.</p></li></ol><div className="proposal-baseline"><div className="proposal-baseline-heading"><h3>Git base</h3><Button type="button" variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={busy || baseLoading || !repoId} loading={baseLoading} onClick={() => setBaseRefresh(value => value + 1)}>{baseError ? "Retry" : "Refresh base"}</Button></div><div className="proposal-target-branch"><GitBranchIcon size={16} aria-hidden="true" /><span>Target branch</span><strong>{loadedBase?.branch ?? repository?.defaultBranch ?? "Choose a repository"}</strong></div>{baseLoading ? <p role="status">Loading current HEAD…</p> : baseError ? <div><p className="proposal-base-error" role="alert">{baseError}</p>{emptyRepository && <><p>This repository needs its first commit before agents can work.</p>{canManage && onImportRepository ? <Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => onImportRepository(repoId)}>Import repository code</Button> : <p>Ask a workspace owner to import repository code, or push an initial commit.</p>}</>}</div> : loadedBase ? <><dl><dt>Current HEAD</dt><dd><code>{loadedBase.commitSha}</code></dd>{loadedBase.commitMessage && <><dt>Latest commit</dt><dd className="proposal-commit-message">{loadedBase.commitMessage}</dd></>}{loadedBase.author && <><dt>Author</dt><dd>{loadedBase.author}</dd></>}{loadedBase.date && !Number.isNaN(Date.parse(loadedBase.date)) && <><dt>Committed</dt><dd>{new Date(loadedBase.date).toLocaleString()}</dd></>}</dl>{baseStale && <p className="proposal-base-error" role="alert">The branch changed. Refresh the base and review the new HEAD. Your draft is preserved.</p>}<p>Start rechecks the branch HEAD. Agents are pinned to the revision present when execution starts.</p></> : <p>Choose a repository to load its Git base.</p>}</div></aside></div>
      {modelError && <div className="error-notice" role="alert">{modelError} <a href="#settings/models">AI model settings</a></div>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      <div className="proposal-create-footer"><p><ShieldCheckIcon size={17} aria-hidden="true" />Agents start only after you choose Start.</p><div><Button type="button" variant="secondary" size="base" disabled={busy} onClick={onBack}>Cancel</Button><Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || !repository || !loadedBase || baseLoading || baseStale || !models || agents.some(agent => !models.models.some(model => model.id === (agent.model ?? "openai/gpt-6-luna")))}>Create mission draft</Button></div></div>
    </form>}
  </section>;
}
