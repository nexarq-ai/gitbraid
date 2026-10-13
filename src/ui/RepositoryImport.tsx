import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { ArrowClockwiseIcon, ArrowLeftIcon, CheckCircleIcon, FileZipIcon, GitBranchIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import type { Repository } from '../shared/types';
import { request, RequestError } from './api';
import './repository-import.css';

type ImportStatus = { allowed: boolean; headSha: string | null; reason: string; branch: string; remote?: string | null };
type ImportResult = { repository: Repository; headSha: string; files: string[]; skipped: string[] };
type SelectedArchive = { file: File; base64: string };
type ImportAttempt = { body: { archiveBase64: string; expectedHeadSha: string | null; message: string }; signature: string; key: string; target: ImportStatus; archive: SelectedArchive };
const pendingImports = new Map<string, ImportAttempt>();
const maximumArchiveBytes = 5 * 1024 * 1024;
export const quoteGitArgument = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const importPath = (id: string) => `/api/repositories/${encodeURIComponent(id)}/import`;

function useImportStatus(repository: Repository, canManage: boolean) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus(null); setError('');
    if (!canManage || repository.provider !== 'artifacts') { setLoading(false); return; }
    setLoading(true);
    void request<ImportStatus>(importPath(repository.id)).then(value => { if (active) setStatus(value); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Import availability could not be checked.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repository.id, repository.provider, repository.headSha, canManage, refresh]);
  return { status, error, loading, retry: () => setRefresh(value => value + 1) };
}

export function RepositoryImportOnboarding({ repository, canManage, onImport }: { repository: Repository; canManage: boolean; onImport: () => void }) {
  const { status, error, loading, retry } = useImportStatus(repository, canManage);
  if (!canManage || repository.provider !== 'artifacts') return null;
  if (error) return <div className="repository-import-banner"><div><strong>Add your existing code</strong><p>{error}</p></div><Button variant="secondary" size="base" onClick={retry}>Retry</Button></div>;
  if (loading || !status?.allowed) return null;
  return <section className="repository-import-banner" aria-label="Add your existing code"><UploadSimpleIcon size={24} aria-hidden="true" /><div><h2>{status.headSha ? 'Start with your existing code' : 'Add your first source code'}</h2><p>{status.headSha ? "This repository has only its initial setup files. Import a ZIP to add your project, then create a mission." : "Import a ZIP as your first commit, then create a mission for the changes you want."}</p></div><Button variant="primary" size="base" icon={UploadSimpleIcon} onClick={onImport}>Import code</Button></section>;
}

function GitSetup({ repository, remote, branch }: { repository: Repository; remote?: string | null; branch: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  if (!remote) return null;
  const commands = `git clone ${quoteGitArgument(remote)} ${quoteGitArgument(repository.name)}\ncd ${quoteGitArgument(repository.name)}\ngit switch ${quoteGitArgument(branch)}\ngit add .\ngit commit -m 'Import existing code'\ngit push origin ${quoteGitArgument(branch)}`;
  return <details className="panel repository-import-git"><summary><GitBranchIcon size={18} aria-hidden="true" />Set up with Git</summary><div><p>Use your Cloudflare Artifacts Git credential when Git asks you to authenticate. A Gitflare owner key or task credential cannot authenticate this Git remote.</p><p>Clone this repository, switch to the target branch, then copy your project into the cloned folder before running the add, commit and push commands. Keep the cloned <code>.git</code> directory. If the repository is empty, use <code>git switch -c {quoteGitArgument(branch)}</code> instead.</p><pre><code>{commands}</code></pre><Button variant="secondary" size="base" onClick={() => { void navigator.clipboard.writeText(commands).then(() => { setCopied(true); setCopyError(''); }).catch(() => setCopyError('Copy is unavailable. Select and copy the commands above.')); }}>{copied ? 'Copied' : 'Copy Git commands'}</Button>{copyError && <p role="alert">{copyError}</p>}<p className="repository-import-muted">The target branch must contain your code before a mission can use it.</p></div></details>;
}

export default function RepositoryImport({ repository, canManage, canContribute, onBack, onImported, onCreateProposal }: { repository: Repository; canManage: boolean; canContribute: boolean; onBack: () => void; onImported: (repository: Repository) => void; onCreateProposal: () => void }) {
  const { status: latestStatus, error: statusError, loading, retry } = useImportStatus(repository, canManage);
  const [stage, setStage] = useState<'select' | 'review' | 'saving' | 'done'>(() => pendingImports.has(repository.id) ? 'review' : 'select');
  const [archive, setArchive] = useState<SelectedArchive | null>(() => pendingImports.get(repository.id)?.archive ?? null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState(() => pendingImports.get(repository.id)?.body.message ?? 'Import existing code');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(() => pendingImports.has(repository.id));
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const reader = useRef<FileReader | null>(null);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const submitting = useRef(false);
  const mutation = useRef<ImportAttempt | null>(pendingImports.get(repository.id) ?? null);
  const locked = stage === 'saving' || pending;
  const status = locked ? mutation.current?.target ?? latestStatus : latestStatus;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readGeneration.current++; reader.current?.abort(); }; }, []);
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [locked]);

  function selectFile(file?: File) {
    if (locked || !file) return;
    const generation = ++readGeneration.current;
    reader.current?.abort(); setReading(false); setError('');
    if (!/\.zip$/i.test(file.name)) { setError('Choose a ZIP archive.'); return; }
    if (!file.size || file.size > maximumArchiveBytes) { setError('Choose a non-empty ZIP archive of up to 5 MiB.'); return; }
    setArchive(null); setReading(true);
    const fileReader = new FileReader(); reader.current = fileReader;
    fileReader.onload = () => {
      if (!mounted.current || generation !== readGeneration.current) return;
      const value = typeof fileReader.result === 'string' ? fileReader.result.split(',')[1] : '';
      setReading(false);
      if (!value) { setError('The ZIP could not be read. Choose the file again.'); return; }
      setArchive({ file, base64: value }); setStage('review'); mutation.current = null;
    };
    fileReader.onerror = () => { if (mounted.current && generation === readGeneration.current) { setReading(false); setError('The ZIP could not be read. Choose the file again.'); } };
    fileReader.readAsDataURL(file);
  }
  function dropped(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    if (locked) return;
    if (event.dataTransfer.files.length !== 1) { setError('Choose one ZIP archive.'); return; }
    selectFile(event.dataTransfer.files[0]);
  }
  function fileChanged(event: ChangeEvent<HTMLInputElement>) { selectFile(event.target.files?.[0]); event.target.value = ''; }
  async function save() {
    if (submitting.current || !archive || (!pending && !status?.allowed) || !status || !canManage) return;
    if (!message.trim()) { setError('Add a commit message.'); return; }
    const body = { archiveBase64: archive.base64, expectedHeadSha: status.headSha, message: message.trim() };
    const signature = JSON.stringify(body);
    if (!mutation.current || (!pending && mutation.current.signature !== signature)) mutation.current = { body, signature, key: crypto.randomUUID(), target: status, archive };
    pendingImports.set(repository.id, mutation.current);
    submitting.current = true; setStage('saving'); setError('');
    try {
      const value = await request<ImportResult>(importPath(repository.id), mutation.current.body, mutation.current.key);
      pendingImports.delete(repository.id);
      if (!mounted.current) return;
      setPending(false); setResult(value); setStage('done'); mutation.current = null; onImported(value.repository);
    } catch (failure) {
      const knownRejected = failure instanceof RequestError && failure.status >= 400 && failure.status < 500 && !['IMPORT_UNCONFIRMED', 'IMPORT_PENDING'].includes(failure.code ?? '');
      if (knownRejected) pendingImports.delete(repository.id);
      if (!mounted.current) return;
      setPending(!knownRejected); setStage('review');
      setError(failure instanceof Error ? failure.message : 'The import response could not be confirmed.');
      if (knownRejected && failure instanceof RequestError && failure.status === 409) retry();
    } finally { submitting.current = false; if (mounted.current) setReading(false); }
  }

  return <section className="repository-import-page"><button className="header-back" disabled={locked} onClick={onBack}><ArrowLeftIcon size={13} />Back to repository code</button><div className="page-heading"><div><h1>Import code</h1><p>Add an existing project to {repository.name}, then ask agents to work on it.</p></div></div><ol className="repository-import-steps" aria-label="Import progress">{['Select ZIP', 'Review import', 'Commit code'].map((label, index) => <li key={label} aria-current={(stage === 'select' ? 0 : stage === 'review' ? 1 : 2) === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {stage === 'done' && result ? <section className="panel repository-import-success"><CheckCircleIcon size={34} aria-hidden="true" /><h2>Your code is ready</h2><p>{result.files.length} files committed to <strong>{status?.branch ?? repository.defaultBranch}</strong>.</p><code>{result.headSha}</code>{result.skipped.length > 0 && <details><summary>{result.skipped.length} entries skipped</summary><ul>{result.skipped.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>}<div><Button variant="secondary" size="base" onClick={onBack}>View code</Button><Button variant="primary" size="base" disabled={!canContribute} onClick={onCreateProposal}>Create mission</Button></div></section> : !canManage ? <div className="error-notice" role="alert">An owner with Manage permission can import the initial source code.</div> : repository.provider !== 'artifacts' ? <div className="error-notice" role="alert">Connect Cloudflare Artifacts Git storage before importing code.</div> : <>
      {loading && !locked ? <div className="panel repository-import-loading" role="status">Checking the current repository…</div> : statusError && !locked ? <div className="error-notice" role="alert">{statusError}<Button variant="secondary" size="base" icon={ArrowClockwiseIcon} onClick={retry}>Retry</Button></div> : status && !status.allowed ? <section className="panel repository-import-unavailable"><h2>This repository already has source code</h2><p>{status.reason || 'ZIP import is available only for an empty repository or untouched Gitflare setup files.'}</p><p>Use Git to add changes to this repository.</p></section> : status ? <section className="panel repository-import-form"><div className="repository-import-target"><GitBranchIcon size={18} aria-hidden="true" /><strong>{status.branch}</strong><span>{status.headSha ? 'Initial setup revision' : 'First commit'}</span></div><p className="repository-import-policy">{status.headSha ? 'Your project will be committed after the initial setup revision. Only untouched platform setup files can be replaced.' : 'Your project will become the first commit on this branch.'} Established repositories cannot be overwritten by ZIP import.</p>
        {stage === 'select' ? <div className={`repository-import-dropzone${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={dropped}><FileZipIcon size={36} aria-hidden="true" /><h2>Drop your project ZIP here</h2><p>Choose one archive up to 5 MiB.</p><Button variant="primary" size="base" icon={UploadSimpleIcon} disabled={reading} onClick={() => input.current?.click()}>{reading ? 'Reading ZIP…' : 'Choose ZIP'}</Button><input ref={input} className="repository-import-file-input" type="file" accept=".zip,application/zip" aria-label="Project ZIP archive" onChange={fileChanged} tabIndex={-1} /><p className="repository-import-muted">Exclude credentials, environment files, dependencies and build output. The server validates archive paths and content before committing.</p></div> : archive && <div className="repository-import-review"><div className="repository-import-archive"><FileZipIcon size={26} aria-hidden="true" /><div><strong>{archive.file.name}</strong><span>{(archive.file.size / 1024 / 1024).toFixed(2)} MiB</span></div><Button type="button" variant="secondary" size="base" disabled={locked} onClick={() => { setStage('select'); setArchive(null); setError(''); mutation.current = null; }}>Change ZIP</Button></div><div className="form-field"><label htmlFor="repository-import-message">Commit message</label><Input id="repository-import-message" maxLength={200} disabled={locked} value={message} onChange={event => setMessage(event.target.value)} required /></div><dl><dt>Repository</dt><dd>{repository.name}</dd><dt>Target branch</dt><dd><code>{status.branch}</code></dd><dt>Expected HEAD</dt><dd><code>{status.headSha ?? 'Empty branch'}</code></dd></dl><p>Up to 500 files, 10 MiB expanded, and 1 MiB per file. Git history is not imported from the ZIP.</p>{pending && <p className="repository-import-pending" role="status">The server outcome is unconfirmed. Retry this exact import to recover its result before changing the ZIP or commit message.</p>}<Button variant="primary" size="base" icon={UploadSimpleIcon} loading={stage === 'saving'} disabled={stage === 'saving' || !message.trim()} onClick={() => void save()}>{stage === 'saving' ? 'Committing code…' : pending ? 'Retry import' : 'Import and commit code'}</Button></div>}
        {error && <div className="error-notice" role="alert">{error}</div>}
      </section> : null}
      <GitSetup repository={repository} remote={status?.remote ?? repository.remote} branch={status?.branch ?? repository.defaultBranch} />
    </>}
  </section>;
}
