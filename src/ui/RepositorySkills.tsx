import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpenIcon, ArrowClockwiseIcon } from '@phosphor-icons/react';
import type { Repository, RepositoryFile } from '../shared/types';
import type { RepositorySkills as SkillsResponse } from '../worker/repository-skills';
import { request } from './api';
import './repository-skills.css';

const sample = '---\nname: repository-guide\ndescription: Follow this repository’s conventions when proposing changes.\n---\n\n# Repository guide\n\nRead README.md before making changes. Run the relevant checks and propose changes for review.\n';

export default function RepositorySkills({ repository }: { repository: Repository }) {
  const [reference, setReference] = useState(repository.defaultBranch);
  const [selectedRef, setSelectedRef] = useState(repository.defaultBranch);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [file, setFile] = useState<RepositoryFile | null>(null);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [copied, setCopied] = useState(false);
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
  return <section className="repository-skills">
    <div className="skills-toolbar">
      <div><h2>Repository skills</h2><p>Reusable instructions stored with your source code.</p></div>
      <form className="ref-picker" onSubmit={event => { event.preventDefault(); setSelectedRef(reference.trim() || repository.defaultBranch); setRefresh(value => value + 1); }}>
        <input aria-label="Skills branch, tag or commit" value={reference} onChange={event => setReference(event.target.value)} maxLength={200} />
        <button type="submit" aria-label="Refresh repository skills"><ArrowClockwiseIcon size={16} /></button>
      </form>
    </div>
    {error ? <div className="error-notice" role="alert">{error}</div> : !data ? <div className="panel skills-loading" role="status">Discovering skills…</div> : <>
      <div className="skills-revision">{data.skills.length} {data.skills.length === 1 ? 'skill' : 'skills'} · <code>{data.commitSha.slice(0, 10)}</code><span>Discovery only · instructions are not automatically installed or executed</span></div>
      {(data.truncated || data.skipped > 0) && <p className="skills-limit" role="status">{data.truncated ? 'Discovery reached its traversal limit; this list may be incomplete. ' : ''}{data.skipped > 0 ? `${data.skipped} files were skipped because they were unavailable, binary, or larger than 64 KB.` : ''}</p>}
      {data.skills.length ? <div className="skills-layout">
        <div className="panel skills-list" aria-label="Repository skills">{data.skills.map(skill => <button key={skill.path} className={selectedPath === skill.path ? 'selected' : ''} aria-pressed={selectedPath === skill.path} onClick={() => setSelectedPath(skill.path)}><BookOpenIcon size={18} /><span><strong>{skill.name}</strong><p>{skill.description || 'No description in frontmatter.'}</p><code>{skill.path}</code></span></button>)}</div>
        <section className="panel skills-preview"><div className="panel-header"><h3>Instructions</h3><code>{data.commitSha.slice(0, 10)}</code></div><div className="skills-file-path"><code>{selectedPath}</code></div>{fileError ? <div className="panel-body" role="alert">{fileError}</div> : file ? <div className="panel-body documentation-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || 'Image'}</span>, a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{file.content}</Markdown></div> : <div className="panel-body" role="status">Loading instructions…</div>}</section>
      </div> : <section className="panel skills-empty"><BookOpenIcon size={30} /><h3>No repository skills found</h3><p>Add a <code>SKILL.md</code> file under one of these directories, then return here to refresh.</p><div className="skills-roots">{data.roots.map(root => <code key={root}>{root}/</code>)}</div><p>For a reviewed change, create a proposal to add <code>docs/skills/repository-guide/SKILL.md</code>. A skill file describes instructions; discovering it here does not install it in an AI client.</p><details><summary>Example SKILL.md</summary><pre>{sample}</pre><button className="secondary-button" onClick={() => { void navigator.clipboard.writeText(sample).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? 'Copied' : 'Copy example'}</button></details></section>}
    </>}
  </section>;
}
