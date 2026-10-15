import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { ArrowClockwiseIcon, ArrowLeftIcon, CircleIcon, GitBranchIcon, PaperclipIcon, PlusIcon, RobotIcon, ShieldCheckIcon, SparkleIcon, TrashIcon } from '@phosphor-icons/react';
import type { AgentTask, IssueDetail, Mission, Repository, ModelConnectionsSnapshot, AiKeysSnapshot } from '../shared/types';
import { request, RequestError } from './api';
import { DRAFT_GOAL_MAX, MISSION_PROMPT_MAX, draftGoalProblem, draftIsStale, fillBlank, mergeDraftAgents, modelOptionLabel, modelVerificationNote, type MissionDraftResult } from '../shared/mission-draft';
import RepositoryImport from './RepositoryImport';
import './proposal-create.css';
import './branches.css';

type Attachment = { name: string; content: string };
const maxFiles = 5, maxFileBytes = 16 * 1024, maxTotalBytes = 48 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;

interface DraftAgent extends AgentTask { id: string; }
interface ProposalBase { branch: string; commitSha: string; commitMessage?: string; author?: string; date?: string; }
const startingAgents = (): DraftAgent[] => [
  { id: crypto.randomUUID(), name: '', role: '', task: '' },
  { id: crypto.randomUUID(), name: '', role: '', task: '' },
];

const WHOLE_MISSION = 'Complete the whole mission described in the outcome and acceptance criteria.';

function defaultAgentName(index: number): string { return `Agent ${index + 1}`; }
function defaultAgentRole(): string { return 'Implementation'; }

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const [importing, setImporting] = useState(false);
  const [reading, setReading] = useState(0);
  const [importEligible, setImportEligible] = useState(false);
  const attachRef = useRef<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const readChain = useRef<Promise<void>>(Promise.resolve());
  const [models, setModels] = useState<ModelConnectionsSnapshot | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState('');
  const [modelError, setModelError] = useState('');
  const [aiReady, setAiReady] = useState(true);
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const latestDraftInput = useRef({ repositoryId: repoId, goal: prompt });
  latestDraftInput.current = { repositoryId: repoId, goal: prompt };
  const draftProblem = prompt.trim() ? draftGoalProblem(prompt) : null;
  const [issue, setIssue] = useState<{ repositoryId: string; number: number; title: string } | null>(null);
  const [issueError, setIssueError] = useState('');
  const names = agents.map(agent => agent.name.trim().toLowerCase());
  const duplicateNames = names.filter((name, index) => name && names.indexOf(name) !== index);
  const repository = repositories.find(item => item.id === repoId);
  const loadedBase = base?.repositoryId === repoId ? base : null;
  const linkedIssue = issue?.repositoryId === repoId ? issue : null;

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('issue');
    if (!repositoryId || !requested || !/^\d{1,4}$/.test(requested)) return;
    let active = true;
    void request<IssueDetail>(`/api/repositories/${encodeURIComponent(repositoryId)}/issues/${requested}`).then(detail => {
      if (!active) return;
      setIssue({ repositoryId, number: detail.number, title: detail.title });
      setTitle(current => current || detail.title.slice(0, 120));
      setPrompt(current => current || `${detail.title}\n\n${detail.body}`.trim().slice(0, 8000));
    }).catch(failure => { if (active) setIssueError(failure instanceof Error ? failure.message : 'The issue could not be loaded.'); });
    return () => { active = false; };
  }, [repositoryId]);

  useEffect(() => {
    let active = true;
    setModels(null); setModelError('');
    void request<ModelConnectionsSnapshot>('/api/models').then(result => { if (active) setModels(result); }).catch(failure => { if (active) setModelError(failure instanceof Error ? failure.message : 'Models could not be loaded.'); });
    void request<AiKeysSnapshot>('/api/ai-keys').then(result => { if (active) setAiReady(result.ready); }).catch(() => {});
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

  useEffect(() => {
    let active = true;
    setImportEligible(false);
    if (!repoId || !canManage) return;
    void request<{ allowed: boolean }>(`/api/repositories/${encodeURIComponent(repoId)}/import`).then(result => { if (active) setImportEligible(!!result.allowed); }).catch(() => { if (active) setImportEligible(false); });
    return () => { active = false; };
  }, [repoId, canManage, baseRefresh]);

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    setReading(value => value + 1);
    readChain.current = readChain.current.then(() => readFiles(list)).finally(() => setReading(value => value - 1));
  }
  async function readFiles(files: File[]) {
    const next = [...attachRef.current]; const problems: string[] = [];
    for (const file of files) {
      if (next.length >= maxFiles) { problems.push(`Only ${maxFiles} files can be attached.`); break; }
      if (next.some(item => item.name === file.name)) { problems.push(`${file.name} is already attached.`); continue; }
      if (file.size > maxFileBytes) { problems.push(`${file.name} is larger than 16 KiB.`); continue; }
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (content.includes('\u0000')) throw new Error('binary');
        if (bytes(content) > maxFileBytes) { problems.push(`${file.name} is larger than 16 KiB.`); continue; }
        if (next.reduce((sum, item) => sum + bytes(item.content), 0) + bytes(content) > maxTotalBytes) { problems.push(`${file.name} would exceed the 48 KiB total.`); continue; }
        next.push({ name: file.name, content });
      } catch { problems.push(`${file.name} is not UTF-8 text or code.`); }
    }
    attachRef.current = next; setAttachments(next); setAttachError(problems.join(' '));
  }
  async function draftWithAi() {
    if (drafting || busy || !repoId || draftGoalProblem(prompt)) return;
    setDrafting(true); setError(''); setDraftNote('');
    const requested = { repositoryId: repoId, goal: prompt };
    const requestedIds = agents.map(agent => agent.id);
    try {
      const draft = await request<MissionDraftResult>('/api/missions/draft', { repositoryId: repoId, goal: prompt.trim(), mode, agents: agents.length, title: title.trim() || undefined, model: agents[0]?.model }, crypto.randomUUID());
      if (draftIsStale(requested, latestDraftInput.current)) { setDraftNote('The repository or goal changed while drafting, so that draft was discarded. Draft again to use the current goal.'); return; }
      setTitle(current => fillBlank(current, draft.title));
      setCriteria(current => fillBlank(current, draft.acceptanceCriteria.join('\n')));
      setAgents(current => mergeDraftAgents(current, draft.tasks, requestedIds));
      setDraftNote('Draft filled in the blank fields. Review and edit it before creating the mission.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The draft could not be created. Fill the fields yourself or try again.'); }
    finally { setDrafting(false); }
  }

  function updateAgent(id: string, patch: Partial<AgentTask>) { setAgents(current => current.map(agent => agent.id === id ? { ...agent, ...patch } : agent)); }
  function addAgent() {
    if (agents.length >= 8) return;
    setAgents(current => [...current, { id: crypto.randomUUID(), name: '', role: '', task: '' }]);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || reading > 0 || !canContribute) return;
    const acceptanceCriteria = criteria.split('\n').map(line => line.trim()).filter(Boolean);
    if (!loadedBase || baseLoading || baseStale) { setError("Load and review the current repository base before creating the mission."); return; }
    if (!repository) { setError('Choose an available repository.'); return; }
    if (!models || agents.some(agent => !models.models.some(model => model.id === (agent.model ?? 'openai/gpt-6-luna')))) { setError('Choose an enabled model for every agent. A workspace owner can manage AI models in Settings.'); return; }
    if (mode === 'race' && agents.length < 2) { setError('Race mode needs at least two independent candidates.'); return; }
    if (duplicateNames.length) { setError('Give each agent a distinct name.'); return; }
    if (acceptanceCriteria.length > 12 || acceptanceCriteria.some(line => line.length > 500)) { setError('Use up to 12 acceptance criteria, with at most 500 characters per line.'); return; }
    if (prompt.trim().length < 10 || agents.some(agent => (agents.length > 1 || agent.task.trim()) && agent.task.trim().length < 10)) { setError("Describe what should change. With several agents, give each one an assignment. Outcomes and assignments need at least 10 characters."); return; }
    const body = { mode, repositoryId: repoId, expectedBaseSha: loadedBase.commitSha, title: title.trim() || prompt.trim().split('\n')[0].slice(0, 80), prompt: prompt.trim(), acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : undefined, attachments: attachments.length ? attachments : undefined, tasks: agents.map(({ name, role, task, model }, index) => ({ name: name.trim() || defaultAgentName(index), role: role.trim() || defaultAgentRole(), task: task.trim() || WHOLE_MISSION, model: model ?? 'openai/gpt-6-luna' })), ...(linkedIssue ? { issueNumber: linkedIssue.number } : {}) };
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
    {!canContribute ? <div className="error-notice" role="alert">Contribute permission is required to create a mission.</div> : !repositories.length ? <section className="panel proposal-no-repository"><GitBranchIcon size={28} /><h2>Create a repository first</h2><p>A mission needs a repository for its source, agent streams and checks.</p><Button variant="primary" size="base" icon={PlusIcon} onClick={onCreateRepository}>Create repository</Button></section> : <form noValidate={false} onSubmit={event => void submit(event)}>
      <div className="proposal-create-layout"><div className="proposal-main-fields">
        <section className="panel proposal-section"><div className="panel-header"><h2>Mission details</h2></div><div className="panel-body">{linkedIssue && <p className="proposal-issue-link"><CircleIcon size={14} weight="bold" aria-hidden="true" /><span>Fixes <a href={`/repository/${linkedIssue.repositoryId}/issues/${linkedIssue.number}`}>#{linkedIssue.number}</a> {linkedIssue.title}</span><small>The issue closes as completed when this mission lands.</small><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setIssue(null)}>Unlink</Button></p>}{issueError && <p className="proposal-name-error" role="alert">{issueError}</p>}<div className="form-field"><label htmlFor="proposal-repository">Repository</label><select id="proposal-repository" required disabled={busy} value={repoId} onChange={event => { setRepoId(event.target.value); setBaseStale(false); }}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}{repo.provider === 'local' ? ' (local)' : ''}</option>)}</select></div><div className="form-field"><label htmlFor="proposal-title">Mission title <span className="proposal-optional">(optional)</span></label><Input id="proposal-title" maxLength={120} disabled={busy} value={title} placeholder="Make checkout resilient to retries" onChange={event => setTitle(event.target.value)} /></div><div className="form-field"><label htmlFor="proposal-outcome">What should change?</label><textarea id="proposal-outcome" required minLength={10} maxLength={MISSION_PROMPT_MAX} disabled={busy} rows={5} value={prompt} placeholder="Describe the outcome, relevant context, and constraints…" onChange={event => setPrompt(event.target.value)} /><div className="proposal-draft"><Button type="button" variant="secondary" size="base" icon={SparkleIcon} loading={drafting} disabled={busy || drafting || !repoId || !!draftGoalProblem(prompt)} aria-describedby={draftProblem ? 'proposal-draft-limit' : undefined} onClick={() => void draftWithAi()}>Draft the rest with AI</Button><small>Fills the blank title, acceptance criteria, agent names, roles and assignments from your goal (up to {DRAFT_GOAL_MAX.toLocaleString('en-US')} characters) and this repository. Fields you already filled are kept, including edits made while drafting, and nothing is saved until you create the mission.</small></div>{draftProblem && prompt.trim().length > DRAFT_GOAL_MAX && <p id="proposal-draft-limit" className="proposal-name-error" role="status">{draftProblem}</p>}{draftNote && <p className="proposal-draft-note" role="status">{draftNote}</p>}</div><div className="form-field"><label htmlFor="proposal-criteria">Acceptance criteria <span className="proposal-optional">(optional)</span></label><textarea id="proposal-criteria" rows={3} maxLength={6011} disabled={busy} value={criteria} placeholder="One criterion per line…" aria-describedby="proposal-criteria-hint" onChange={event => setCriteria(event.target.value)} /><small id="proposal-criteria-hint">Up to 12 criteria. Each criterion can contain up to 500 characters.</small></div></div></section>
        <section className="panel proposal-section proposal-attachments"><div className="panel-header"><h2>Context files <span className="proposal-optional">(optional)</span></h2></div><div className="panel-body"><p>Attach up to 5 text or code files (16 KiB each, 48 KiB total) as read-only context for agents. They are not committed to the repository.</p><input ref={fileInput} className="proposal-file-input" type="file" multiple disabled={busy} aria-label="Attach context files" tabIndex={-1} onChange={event => { void addFiles(event.target.files); event.target.value = ''; }} /><div className="proposal-file-picker"><Button type="button" variant="secondary" size="base" icon={PaperclipIcon} disabled={busy || attachments.length >= 5} onClick={() => fileInput.current?.click()}>Choose files</Button><span>{attachments.length ? `${attachments.length} of 5 attached` : 'No files attached'}</span></div>{reading > 0 && <p role="status">Reading files…</p>}{attachError && <p className="proposal-name-error" role="alert">{attachError}</p>}{attachments.length > 0 && <ul className="proposal-attachment-list">{attachments.map(item => <li key={item.name}><code>{item.name}</code><small>{bytes(item.content)} bytes</small><Button type="button" variant="ghost" size="base" disabled={busy} aria-label={`Remove ${item.name}`} onClick={() => { attachRef.current = attachRef.current.filter(entry => entry.name !== item.name); setAttachments(attachRef.current); }}>Remove</Button></li>)}</ul>}</div></section>
        <section className="panel proposal-section"><div className="panel-header"><h2 id="proposal-mode-title">How agents work</h2></div><div className="panel-body"><div className="mission-mode" role="radiogroup" aria-labelledby="proposal-mode-title"><label className={mode === "combine" ? "selected" : ""}><input type="radio" name="mission-mode" checked={mode === "combine"} disabled={busy} onChange={() => setMode("combine")} /><span><strong>Combine</strong>Assign separate parts, then test their merged changes.</span></label><label className={mode === "race" ? "selected" : ""}><input type="radio" name="mission-mode" checked={mode === "race"} disabled={busy} onChange={() => setMode("race")} /><span><strong>Race</strong>Each agent attempts the whole mission. Compare passing candidates and choose one.</span></label></div></div></section>
        <section className="proposal-agents" aria-labelledby="proposal-agents-title"><div className="proposal-agents-heading"><div><h2 id="proposal-agents-title">Agents <span>{agents.length} / 8</span></h2><p>{mode === "race" ? "Give each agent an independent approach to the complete outcome. Each candidate stays separate." : "Assign separate parts. Each agent gets its own isolated stream."}</p></div><Button type="button" variant="secondary" size="base" icon={PlusIcon} disabled={busy || agents.length >= 8} onClick={addAgent}>Add agent</Button></div>{duplicateNames.length > 0 && <p className="proposal-name-error" role="alert">Agent names must be unique.</p>}<div className="proposal-agent-grid">{agents.map((agent, index) => <section className="panel proposal-agent-card" key={agent.id} aria-label={`Agent ${index + 1} assignment`}><div className="proposal-agent-heading"><span><RobotIcon size={18} aria-hidden="true" />Agent {index + 1}</span><Button type="button" variant="ghost" size="base" icon={TrashIcon} disabled={busy || agents.length <= (mode === "race" ? 2 : 1)} aria-label={`Remove ${agent.name || `agent ${index + 1}`}`} onClick={() => setAgents(current => current.filter(item => item.id !== agent.id))}>Remove</Button></div><div className="proposal-agent-fields"><div className="form-field"><label htmlFor={`agent-name-${agent.id}`}>Name <span className="proposal-optional">(optional)</span></label><Input id={`agent-name-${agent.id}`} maxLength={60} placeholder={defaultAgentName(index)} disabled={busy} value={agent.name} aria-invalid={!!agent.name.trim() && names.filter(name => name === agent.name.trim().toLowerCase()).length > 1} onChange={event => updateAgent(agent.id, { name: event.target.value })} /></div><div className="form-field"><label htmlFor={`agent-role-${agent.id}`}>Role <span className="proposal-optional">(optional)</span></label><Input id={`agent-role-${agent.id}`} maxLength={80} disabled={busy} value={agent.role} placeholder={defaultAgentRole()} onChange={event => updateAgent(agent.id, { role: event.target.value })} /></div><div className="form-field"><label htmlFor={`agent-model-${agent.id}`}>AI model</label><select id={`agent-model-${agent.id}`} aria-describedby={`agent-model-status-${agent.id}`} required disabled={busy || !models} value={agent.model ?? "openai/gpt-6-luna"} onChange={event => updateAgent(agent.id, { model: event.target.value })}>{!models ? <option value="openai/gpt-6-luna">Loading models…</option> : <>{!models.models.some(model => model.id === (agent.model ?? "openai/gpt-6-luna")) && <option value={agent.model ?? "openai/gpt-6-luna"} disabled>Selected model is unavailable</option>}{models.models.map(model => <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>)}</>}</select>{(() => { const selected = models?.models.find(model => model.id === (agent.model ?? "openai/gpt-6-luna")); return selected && <small className={selected.verification?.status === 'failed' ? 'proposal-name-error' : undefined} id={`agent-model-status-${agent.id}`}>{modelVerificationNote(selected)}</small>; })()}<small>The model is pinned to this assignment when the draft is saved.</small></div>{agents.length === 1 ? <details className="form-field proposal-optional-assignment" open={!!agent.task.trim()}><summary>Specific instructions <span className="proposal-optional">(optional, this agent works on the whole mission)</span></summary><textarea id={`agent-task-${agent.id}`} required={agents.length > 1} minLength={agents.length > 1 ? 10 : undefined} maxLength={2500} disabled={busy} rows={4} value={agent.task} placeholder={agents.length === 1 ? 'Optional with one agent. Leave blank to give it the whole mission, or add specifics such as files to change or approaches to avoid…' : index === 0 ? 'Implement the core change. Describe the files or behavior this agent owns…' : 'Describe a complementary change and how it fits with the other assignments…'} onChange={event => updateAgent(agent.id, { task: event.target.value })} /></details> : <div className="form-field"><label htmlFor={`agent-task-${agent.id}`}>Assignment</label><textarea id={`agent-task-${agent.id}`} required={agents.length > 1} minLength={agents.length > 1 ? 10 : undefined} maxLength={2500} disabled={busy} rows={4} value={agent.task} placeholder={agents.length === 1 ? 'Optional with one agent. Leave blank to give it the whole mission, or add specifics such as files to change or approaches to avoid…' : index === 0 ? 'Implement the core change. Describe the files or behavior this agent owns…' : 'Describe a complementary change and how it fits with the other assignments…'} onChange={event => updateAgent(agent.id, { task: event.target.value })} /></div>}</div></section>)}</div></section>
      </div><aside className="panel proposal-process"><div className="panel-header"><h2>From draft to landed changes</h2></div><ol><li><strong>Create the draft</strong><p>Save the outcome and agent assignments. Creating a draft does not start any agents.</p></li><li><strong>Start the agents</strong><p>Choose Start on the mission page when you are ready. Up to three agents work at once; additional assignments wait for a slot.</p></li><li><strong>Review and land</strong><p>Inspect the combined changes and checks, then approve the exact revision before landing.</p></li></ol><div className="proposal-baseline"><div className="proposal-baseline-heading"><h3>Git base</h3><Button type="button" variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={busy || baseLoading || !repoId} loading={baseLoading} onClick={() => setBaseRefresh(value => value + 1)}>{baseError ? "Retry" : "Refresh base"}</Button></div><div className="proposal-target-branch"><GitBranchIcon size={16} aria-hidden="true" /><span>Target stream</span><strong>{loadedBase?.branch ?? repository?.defaultBranch ?? "Choose a repository"}</strong></div>{baseLoading ? <p role="status">Loading current HEAD…</p> : baseError ? <div><p className="proposal-base-error" role="alert">{baseError}</p>{(emptyRepository || importEligible) && <><p>This repository needs its first revision before agents can work.</p>{canManage && repository ? <><Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => setImporting(value => !value)}>{importing ? 'Hide source import' : 'Import initial source ZIP'}</Button>{importing && <div className="proposal-inline-import"><p>This commits the ZIP as the repository's first source. It is separate from context files and cannot replace populated code. Your mission fields are kept.</p><RepositoryImport repository={repository} canManage={canManage} canContribute={canContribute} onBack={() => setImporting(false)} onImported={() => { setImporting(false); setBaseStale(false); setBaseRefresh(value => value + 1); }} onCreateProposal={() => setImporting(false)} /></div>}</> : <p>Ask a workspace owner to import repository code, or push an initial revision.</p>}</>}</div> : loadedBase ? <><dl><dt>Current HEAD</dt><dd><code>{loadedBase.commitSha}</code></dd>{loadedBase.commitMessage && <><dt>Latest revision</dt><dd className="proposal-commit-message">{loadedBase.commitMessage}</dd></>}{loadedBase.author && <><dt>Author</dt><dd>{loadedBase.author}</dd></>}{loadedBase.date && !Number.isNaN(Date.parse(loadedBase.date)) && <><dt>Committed</dt><dd>{new Date(loadedBase.date).toLocaleString()}</dd></>}</dl>{importEligible && <>{canManage && repository ? <><Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => setImporting(value => !value)}>{importing ? 'Hide source import' : 'Import initial source ZIP'}</Button>{importing && <div className="proposal-inline-import"><p>This commits the ZIP as the repository's first source. It is separate from context files and cannot replace populated code. Your mission fields are kept.</p><RepositoryImport repository={repository} canManage={canManage} canContribute={canContribute} onBack={() => setImporting(false)} onImported={() => { setImporting(false); setBaseStale(false); setBaseRefresh(value => value + 1); }} onCreateProposal={() => setImporting(false)} /></div>}</> : null}</>}{baseStale && <p className="proposal-base-error" role="alert">The stream changed. Refresh the base and review the new HEAD. Your draft is preserved.</p>}<p>Start rechecks the stream head. Agents are pinned to the revision present when execution starts.</p></> : <p>Choose a repository to load its Git base.</p>}</div></aside></div>
      {!aiReady && <div className="error-notice" role="alert">Add your AI key to start missions. <a href="/settings/models">AI model settings</a></div>}
      {modelError && <div className="error-notice" role="alert">{modelError} <a href="/settings/models">AI model settings</a></div>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      <div className="proposal-create-footer"><p><ShieldCheckIcon size={17} aria-hidden="true" />Agents start only after you choose Start.</p><div><Button type="button" variant="secondary" size="base" disabled={busy} onClick={onBack}>Cancel</Button><Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || !aiReady || reading > 0 || !repository || !loadedBase || baseLoading || baseStale || !models || agents.some(agent => !models.models.some(model => model.id === (agent.model ?? "openai/gpt-6-luna")))}>Create mission draft</Button></div></div>
    </form>}
  </section>;
}
