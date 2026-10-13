import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { BookOpenIcon, ArrowClockwiseIcon, CheckIcon, CopyIcon, GitBranchIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import type { Mission, Repository, RepositoryFile } from '../shared/types';
import type { RepositorySkills as SkillsResponse } from '../worker/repository-skills';
import { request, RequestError } from './api';
import './repository-skills.css';

const sample = '---\nname: repository-guide\ndescription: Follow this repository’s conventions when proposing changes.\n---\n\n# Repository guide\n\nRead README.md before making changes. Run the relevant checks and propose changes for review.\n';
const editablePath = /^docs\/skills\/[a-z0-9-]{1,64}\/SKILL\.md$/;
const validSlug = /^[a-z0-9-]{1,64}$/;

function metadata(content: string, key: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? '';
  const value = new RegExp(`^${key}:[ \t]*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim() ?? '';
  if (['>', '|', '>-', '|-'].includes(value)) {
    const lines = new RegExp(`^${key}:.*\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$))+)`, 'm').exec(frontmatter)?.[1] ?? '';
    return lines.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' ');
  }
  if (value.startsWith('"')) { try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); } }
  return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

function updateMetadata(content: string, key: string, value: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const line = `${key}: ${JSON.stringify(value)}`;
  if (!match) return `---\n${line}\n---\n\n${content}`;
  const expression = new RegExp(`^${key}:[^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*`, 'm');
  const frontmatter = expression.test(match[1]) ? match[1].replace(expression, () => line) : `${match[1]}\n${line}`;
  return `---\n${frontmatter}\n---\n${content.slice(match[0].length)}`;
}

function SkillMarkdown({ content }: { content: string }) {
  const instructions = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return <div className="documentation-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || 'Image'}</span>, a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{instructions}</Markdown></div>;
}

interface SkillDraft { action: 'create' | 'update'; slug: string; path: string; content: string; originalContent: string; baseSha: string; }
interface LatestRevision { commitSha: string; content: string | null; exists: boolean; }

export default function RepositorySkills({ repository, canContribute, canExecute, onOpenMission }: { repository: Repository; canContribute: boolean; canExecute: boolean; onOpenMission: (id: string) => void }) {
  const [reference, setReference] = useState(repository.defaultBranch);
  const [selectedRef, setSelectedRef] = useState(repository.defaultBranch);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [file, setFile] = useState<RepositoryFile | null>(null);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [latest, setLatest] = useState<LatestRevision | null>(null);
  const [refreshingBase, setRefreshingBase] = useState(false);
  const editor = useRef<HTMLElement>(null);
  const submission = useRef<{ signature: string; key: string } | null>(null);
  const loadedFile = file?.path === selectedPath && file?.commitSha === data?.commitSha ? file : null;
  const canEdit = canContribute && canExecute;
  const permissionReason = !canContribute ? 'Contribute permission is required to propose skill changes.' : !canExecute ? 'Execute permission is required to run checks for a skill proposal.' : '';
  const name = draft ? metadata(draft.content, 'name') : '';
  const description = draft ? metadata(draft.content, 'description') : '';
  const path = draft?.action === 'create' ? `docs/skills/${draft.slug}/SKILL.md` : draft?.path ?? '';
  const byteCount = draft ? new TextEncoder().encode(draft.content).length : 0;
  const slugValid = !!draft && validSlug.test(draft.slug) && draft.slug.length <= 64;
  const duplicate = draft?.action === 'create' && !!data?.skills.some(skill => skill.path === path);
  const valid = canEdit && !!draft && slugValid && name.trim().length > 0 && name.length <= 200 && description.trim().length > 0 && description.length <= 2000 && byteCount <= 65536 && !duplicate && !stale && (draft.action === 'create' || draft.content !== draft.originalContent);

  useEffect(() => {
    let active = true;
    setData(null); setFile(null); setError(''); setSelectedPath('');
    const query = new URLSearchParams({ ref: selectedRef });
    void request<SkillsResponse>(`/api/repositories/${repository.id}/skills?${query}`).then(result => {
      if (!active) return;
      setData(result); setSelectedPath(result.skills[0]?.path ?? '');
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Skills could not be loaded.'); });
    return () => { active = false; };
  }, [repository.id, selectedRef, refresh]);
  useEffect(() => {
    let active = true;
    setFile(null); setFileError('');
    if (!data || !selectedPath) return;
    const query = new URLSearchParams({ ref: data.commitSha, path: selectedPath });
    void request<RepositoryFile>(`/api/repositories/${repository.id}/file?${query}`).then(result => {
      if (active && result.commitSha === data.commitSha) setFile(result);
    }).catch(reason => { if (active) setFileError(reason instanceof Error ? reason.message : 'The skill could not be read.'); });
    return () => { active = false; };
  }, [repository.id, data, selectedPath]);
  useEffect(() => { if (draft) { editor.current?.focus(); editor.current?.scrollIntoView({ behavior: 'instant', block: 'nearest' }); } }, [!!draft]);

  function openEditor(action: 'create' | 'update') {
    if (!canEdit || !data || (action === 'update' && (!loadedFile || !editablePath.test(selectedPath)))) return;
    const content = action === 'update' ? loadedFile!.content : sample;
    setDraft({ action, slug: action === 'update' ? selectedPath.split('/')[2] : 'repository-guide', path: action === 'update' ? selectedPath : '', content, originalContent: action === 'update' ? content : '', baseSha: data.commitSha });
    setPreview(false); setSaveError(''); setStale(false); setLatest(null); submission.current = null;
  }
  async function saveDraft() {
    if (!draft || !valid || busy) return;
    const body = { action: draft.action, path, content: draft.content, baseSha: draft.baseSha };
    const signature = JSON.stringify(body);
    if (submission.current?.signature !== signature) submission.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setSaveError('');
    try {
      const mission = await request<Mission>(`/api/repositories/${repository.id}/skills`, body, submission.current.key);
      setDraft(null); submission.current = null;
      onOpenMission(mission.id);
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 409 && ['STALE_SKILL_BASE', 'SKILL_EXISTS'].includes(reason.code ?? '')) { setStale(true); setLatest(null); }
      setSaveError(reason instanceof Error ? reason.message : 'The proposal could not be created. Your edits are preserved.');
    } finally { setBusy(false); }
  }
  async function refreshBase() {
    if (!draft || refreshingBase) return;
    setRefreshingBase(true); setSaveError('');
    try {
      const result = await request<SkillsResponse>(`/api/repositories/${repository.id}/skills?${new URLSearchParams({ ref: repository.defaultBranch })}`);
      const exists = result.skills.some(skill => skill.path === path);
      const current = draft.action === 'update' && exists ? await request<RepositoryFile>(`/api/repositories/${repository.id}/file?${new URLSearchParams({ ref: result.commitSha, path })}`) : null;
      setLatest({ commitSha: result.commitSha, content: current?.content ?? null, exists });
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : 'The latest revision could not be loaded.'); }
    finally { setRefreshingBase(false); }
  }

  return <section className="repository-skills">
    <div className="skills-toolbar">
      <div><h2>Repository skills</h2><p>Reusable instructions stored with your source code.</p></div>
      <div className="skills-toolbar-actions"><form className="skills-ref-picker" onSubmit={event => { event.preventDefault(); setSelectedRef(reference.trim() || repository.defaultBranch); setRefresh(value => value + 1); }}><GitBranchIcon size={16} aria-hidden="true" /><input aria-label="Skills branch, tag or commit" value={reference} onChange={event => setReference(event.target.value)} maxLength={200} /><button type="submit" aria-label="Refresh repository skills" title="Refresh skills"><ArrowClockwiseIcon size={16} /></button></form><Button variant="primary" size="base" icon={PlusIcon} disabled={!canEdit || !data || !!draft} title={permissionReason || undefined} onClick={() => openEditor('create')}>Create skill</Button></div>
    </div>
    {!canEdit && <p className="skills-permission">{permissionReason}</p>}
    {draft && <section ref={editor} tabIndex={-1} className="panel skills-editor" aria-labelledby="skill-editor-title">
      <div className="skills-editor-heading"><div><h3 id="skill-editor-title">{draft.action === 'create' ? 'Create a repository skill' : 'Edit repository skill'}</h3><p>Checks run before owner review. The skill becomes active after the proposal lands.</p></div><span className="skills-draft-badge">Unsaved proposal</span></div>
      <form onSubmit={event => { event.preventDefault(); void saveDraft(); }}>
        <div className="skills-editor-fields"><label htmlFor="skill-name">Name<Input id="skill-name" required maxLength={200} disabled={busy || refreshingBase} value={name} onChange={event => setDraft({ ...draft, content: updateMetadata(draft.content, 'name', event.target.value) })} placeholder="Repository guide" /></label><label htmlFor="skill-slug">Folder name<Input id="skill-slug" required maxLength={64} pattern="[a-z0-9-]{1,64}" disabled={busy || refreshingBase || draft.action === 'update'} value={draft.slug} aria-invalid={!slugValid} aria-describedby="skill-path-hint" onChange={event => { setDraft({ ...draft, slug: event.target.value }); setLatest(null); }} /><span className="skills-field-hint">Lowercase letters, numbers and hyphens.</span></label><label className="skills-description-field" htmlFor="skill-description">Description<textarea id="skill-description" required maxLength={2000} rows={2} disabled={busy || refreshingBase} value={description} onChange={event => setDraft({ ...draft, content: updateMetadata(draft.content, 'description', event.target.value) })} placeholder="When should an agent use this skill?" /></label></div>
        <div id="skill-path-hint" className="skills-editor-path"><BookOpenIcon size={16} aria-hidden="true" /><code>{path}</code><span>Base <code>{draft.baseSha.slice(0, 10)}</code></span></div>
        {duplicate && <p className="skills-inline-error" role="alert">This folder already has a skill. Choose another folder name or edit the existing skill.</p>}
        <div className="skills-editor-toolbar"><label htmlFor="skill-markdown">SKILL.md</label><div className="skills-view-toggle" aria-label="Editor view"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div></div>
        {preview ? <div className="skills-draft-preview"><SkillMarkdown content={draft.content} /></div> : <textarea id="skill-markdown" className="skills-markdown-input" aria-label="Full SKILL.md Markdown" aria-describedby="skill-markdown-hint" spellCheck={false} disabled={busy || refreshingBase} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} />}
        <div id="skill-markdown-hint" className="skills-markdown-hint"><span>Include a name, description, and the instructions an agent should follow.</span><span className={byteCount > 65536 ? 'skills-inline-error' : ''}>{(byteCount / 1024).toFixed(1)} / 64 KB</span></div>
        {(!name.trim() || !description.trim()) && <p className="skills-inline-error">Name and description are required in the Markdown frontmatter.</p>}
        {saveError && <div className="error-notice" role="alert">{saveError}</div>}
        {stale && <div className="skills-stale" role="status"><h4>The repository revision changed</h4><p>Your edits are preserved. Load the latest default stream and review it before using it as the proposal’s base.</p><Button type="button" variant="secondary" size="base" loading={refreshingBase} disabled={busy || refreshingBase} icon={ArrowClockwiseIcon} onClick={() => void refreshBase()}>Load latest revision</Button>{latest && <div className="skills-latest"><p>Latest revision: <code>{latest.commitSha.slice(0, 10)}</code></p>{draft.action === 'update' && !latest.exists ? <p>This skill was removed. Cancel this edit and create a new skill if needed.</p> : draft.action === 'create' && latest.exists ? <p>A skill now exists at this path. Choose another folder name or cancel and edit the existing skill.</p> : <>{latest.content !== null && <details><summary>Review current SKILL.md</summary><pre>{latest.content}</pre></details>}<Button type="button" variant="secondary" size="base" onClick={() => { setDraft({ ...draft, baseSha: latest.commitSha, originalContent: latest.content ?? '' }); setStale(false); setLatest(null); setSaveError(''); }}>Use this base revision</Button><span className="skills-field-hint">Keeps your Markdown exactly as written.</span></>}</div>}</div>}
        <div className="skills-editor-footer"><p>The exact Markdown above will be proposed for <strong>{repository.defaultBranch}</strong>.</p><div><Button type="button" variant="secondary" size="base" disabled={busy || refreshingBase} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" variant="primary" size="base" loading={busy} disabled={!valid || busy || refreshingBase}>{draft.action === 'create' ? 'Create proposal' : 'Save as proposal'}</Button></div></div>
      </form>
    </section>}
    {error ? <div className="error-notice" role="alert">{error}</div> : !data ? <div className="panel skills-loading" role="status">Discovering skills…</div> : <>
      <p className="skills-runtime-note">Agents read repository skills from their pinned base revision. New and updated skills apply to future runs after landing.</p><div className="skills-revision"><span>{data.skills.length} {data.skills.length === 1 ? 'skill' : 'skills'} at <code>{data.commitSha.slice(0, 10)}</code></span><span>Preview pinned to this revision</span></div>
      {(data.truncated || data.skipped > 0) && <p className="skills-limit" role="status">{data.truncated ? 'Discovery reached its traversal limit; this list may be incomplete. ' : ''}{data.skipped > 0 ? `${data.skipped} files were skipped because they were unavailable, binary, or larger than 64 KB.` : ''}</p>}
      {data.skills.length ? <div className="skills-layout">
        <div className="panel skills-list" aria-label="Repository skills">{data.skills.map(skill => <button key={skill.path} className={selectedPath === skill.path ? 'selected' : ''} aria-pressed={selectedPath === skill.path} onClick={() => setSelectedPath(skill.path)}><BookOpenIcon size={18} /><span><strong>{skill.name}</strong><p>{skill.description || 'No description in frontmatter.'}</p><code>{skill.path}</code></span></button>)}</div>
        <section className="panel skills-preview"><div className="panel-header"><h3>Instructions</h3>{editablePath.test(selectedPath) ? <Button variant="secondary" size="base" icon={PencilSimpleIcon} disabled={!canEdit || !loadedFile || !!draft} title={permissionReason || undefined} onClick={() => openEditor('update')}>Edit skill</Button> : <span className="skills-readonly-badge">Read only</span>}</div><div className="skills-file-path"><code>{selectedPath}</code></div>{!editablePath.test(selectedPath) && <p className="skills-readonly-note">Editing currently supports <code>docs/skills/&lt;folder&gt;/SKILL.md</code>. Skills in other discovery directories can be read here.</p>}{fileError ? <div className="panel-body" role="alert">{fileError}</div> : loadedFile ? <div className="panel-body"><SkillMarkdown content={loadedFile.content} /></div> : <div className="panel-body" role="status">Loading instructions…</div>}</section>
      </div> : <section className="panel skills-empty"><BookOpenIcon size={30} /><h3>No repository skills found</h3><p>Create your first skill to give agents reusable guidance for this repository. Skill changes run checks and require owner review before landing.</p><Button variant="primary" size="base" icon={PlusIcon} disabled={!canEdit || !!draft} title={permissionReason || undefined} onClick={() => openEditor('create')}>Create skill</Button><details><summary>Other supported skill directories</summary><div className="skills-roots">{data.roots.map(root => <code key={root}>{root}/</code>)}</div><p>Existing <code>SKILL.md</code> files in these directories appear here. New skills are created under <code>docs/skills/</code>.</p></details><details><summary>Example SKILL.md</summary><pre>{sample}</pre><Button variant="secondary" size="base" icon={copied ? CheckIcon : CopyIcon} onClick={() => { setCopyError(''); void navigator.clipboard.writeText(sample).then(() => setCopied(true)).catch(() => setCopyError('Copy failed. Select the example text to copy it.')); }}>{copied ? 'Copied' : 'Copy example'}</Button>{copyError && <p role="alert">{copyError}</p>}</details></section>}
    </>}
  </section>;
}
