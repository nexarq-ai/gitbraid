import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { ArrowLeftIcon, MagicWandIcon, PencilSimpleIcon, PlusIcon, RocketLaunchIcon, TagIcon, TrashIcon } from "@phosphor-icons/react";
import type { Release, ReleaseList, ReleaseNotes, Repository } from "../shared/types";
import { request, RequestError } from "./api";
import { navigate as goTo } from "./router";
import { RouteProgress } from "./WorkspaceLoader";

const NOTES_MAX = 20_000;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/;
const uncertain = ["RELEASE_UNCONFIRMED", "RELEASE_PENDING"];

function validTag(tag: string) {
  return tagPattern.test(tag) && !tag.includes("..") && !tag.includes("//") && !tag.endsWith("/") && !tag.endsWith(".") && !tag.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
}

function ReleaseMarkdown({ content }: { content: string }) {
  return <div className="documentation-markdown release-notes"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || "Image"}</span>, a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{content}</Markdown></div>;
}

function latestId(releases: Release[]) {
  return releases.filter((release) => !release.draft && !release.prerelease).sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0]?.id;
}

function ReleaseBadges({ release, latest }: { release: Release; latest: boolean }) {
  return <span className="release-badges">
    {release.draft && <Badge variant="secondary">Draft</Badge>}
    {release.prerelease && <Badge variant="warning">Pre-release</Badge>}
    {latest && <Badge variant="success">Latest</Badge>}
  </span>;
}

function useKeyedAction() {
  const [key, setKey] = useState<string | null>(null);
  const run = useCallback(async <T,>(operation: (key: string) => Promise<T>) => {
    const current = key ?? crypto.randomUUID();
    setKey(current);
    try { const result = await operation(current); setKey(null); return result; }
    catch (error) { if (!(error instanceof RequestError && error.code && uncertain.includes(error.code))) setKey(null); throw error; }
  }, [key]);
  return { run, retrying: key !== null, reset: () => setKey(null) };
}

function ReleaseForm({ repository, list, release, onDone, onCancel }: { repository: Repository; list: ReleaseList; release?: Release; onDone: (release: Release) => void; onCancel: () => void }) {
  const editing = !!release;
  const [tag, setTag] = useState(release?.tag ?? "");
  const [target, setTarget] = useState(release?.targetSha ?? list.headSha ?? "");
  const [name, setName] = useState(release?.name ?? "");
  const [notes, setNotes] = useState(release?.notes ?? "");
  const [draft, setDraft] = useState(release?.draft ?? false);
  const [prerelease, setPrerelease] = useState(release?.prerelease ?? false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const action = useKeyedAction();
  const options = list.commits.some((commit) => commit.sha === target) || !target ? list.commits : [{ sha: target, message: "Selected revision" }, ...list.commits];
  const tagError = tag && !validTag(tag) ? "Use letters, numbers, “.”, “_”, “+”, “/” or “-”, starting with a letter or number." : list.releases.some((item) => item.tag === tag && item.id !== release?.id) ? "A checkpoint already uses this tag." : "";
  const valid = !!tag && !tagError && !!name.trim() && name.trim().length <= 120 && notes.length <= NOTES_MAX && !!target;
  const change = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); action.reset(); };

  async function generate() {
    setGenerating(true); setError("");
    try { const result = await request<ReleaseNotes>(`/api/repositories/${repository.id}/releases/notes`, { targetSha: target }); setNotes(result.markdown); action.reset(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Notes could not be generated."); }
    finally { setGenerating(false); }
  }

  async function submit() {
    setBusy(true); setError("");
    try {
      const saved = await action.run((key) => editing
        ? request<Release>(`/api/repositories/${repository.id}/releases/${release.id}/update`, { name: name.trim(), notes, prerelease, ...(release.draft ? { tag, targetSha: target } : {}) }, key)
        : request<Release>(`/api/repositories/${repository.id}/releases`, { tag, name: name.trim(), notes, targetSha: target, draft, prerelease }, key));
      onDone(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The checkpoint could not be saved."); }
    finally { setBusy(false); }
  }

  return <section className="panel release-form" aria-labelledby="release-form-title">
    <div className="panel-header"><h2 id="release-form-title">{editing ? `Edit ${release.tag}` : "Draft a new checkpoint"}</h2></div>
    <form className="panel-body" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="release-form-grid">
        <label htmlFor="release-tag">Tag<Input id="release-tag" required maxLength={100} disabled={busy || (editing && !release.draft)} value={tag} placeholder="v1.0.0" onChange={(event) => change(setTag)(event.target.value.trim())} aria-describedby="release-tag-hint" /></label>
        <div className="release-target">
          <Select label="Target revision" value={target} disabled={busy || (editing && !release.draft) || !options.length} onValueChange={(value) => change(setTarget)(String(value ?? ""))} items={Object.fromEntries(options.map((commit) => [commit.sha, `${commit.sha.slice(0, 7)} ${commit.message}`]))}>
            {options.map((commit, index) => <Select.Option key={commit.sha} value={commit.sha}><code>{commit.sha.slice(0, 7)}</code> {commit.message}{index === 0 && commit.sha === list.headSha ? ` (${list.defaultBranch} head)` : ""}</Select.Option>)}
          </Select>
        </div>
      </div>
      <p id="release-tag-hint" className={tagError ? "release-inline-error" : "release-hint"}>{tagError || (editing && !release.draft ? "A published tag and its target never change." : `Publishing creates the Git tag at this revision on ${list.defaultBranch}. Existing tags are refused, never moved.`)}</p>
      <label htmlFor="release-name">Checkpoint name<Input id="release-name" required maxLength={120} disabled={busy} value={name} placeholder={tag || "Checkpoint name"} onChange={(event) => change(setName)(event.target.value)} /></label>
      <div className="release-notes-toolbar">
        <label htmlFor="release-notes">Notes</label>
        <div>
          <div className="skills-view-toggle" aria-label="Notes view"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div>
          <Button type="button" variant="secondary" size="sm" icon={MagicWandIcon} loading={generating} disabled={busy || generating || !target} onClick={() => void generate()}>Generate notes</Button>
        </div>
      </div>
      {preview ? <div className="release-notes-preview">{notes.trim() ? <ReleaseMarkdown content={notes} /> : <p className="release-hint">Nothing to preview.</p>}</div> : <Textarea id="release-notes" className="release-notes-input" disabled={busy} value={notes} onChange={(event) => change(setNotes)(event.target.value)} placeholder="Describe what changed. Markdown is supported." />}
      <p className={notes.length > NOTES_MAX ? "release-inline-error" : "release-hint"}>{notes.length.toLocaleString()} / {NOTES_MAX.toLocaleString()} characters. Generated notes list landed missions and revisions since the previous checkpoint; no model is used.</p>
      <div className="release-options">
        {!editing && <Checkbox label="Save as draft (no tag is created yet)" checked={draft} disabled={busy} onCheckedChange={(checked) => change(setDraft)(checked === true)} />}
        <Checkbox label="Mark as pre-release" checked={prerelease} disabled={busy} onCheckedChange={(checked) => change(setPrerelease)(checked === true)} />
      </div>
      {error && <div className="error-notice" role="alert">{error}{action.retrying && " Retrying uses the same request, so the tag is never written twice."}</div>}
      <div className="release-form-footer">
        <Button type="button" variant="secondary" size="base" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" size="base" icon={editing || draft ? undefined : RocketLaunchIcon} loading={busy} disabled={!valid || busy}>{action.retrying ? "Retry" : editing ? "Save changes" : draft ? "Save draft" : "Publish checkpoint"}</Button>
      </div>
    </form>
  </section>;
}

function ReleaseDetail({ repository, list, release, canLand, onChanged, onNotify }: { repository: Repository; list: ReleaseList; release: Release; canLand: boolean; onChanged: (release: Release | null) => void; onNotify: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"publish" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = useKeyedAction();
  const base = `/repository/${repository.id}/releases`;

  async function act(kind: "publish" | "delete") {
    setBusy(true); setError("");
    try {
      const result = await action.run((key) => request<Release | { release: Release; message: string }>(`/api/repositories/${repository.id}/releases/${release.id}/${kind}`, {}, key));
      if (kind === "delete") { onNotify("message" in result ? result.message : "Checkpoint deleted."); onChanged(null); }
      else { onNotify(`Published ${release.tag}.`); onChanged(result as Release); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The checkpoint could not be changed."); }
    finally { setBusy(false); }
  }

  if (editing) return <ReleaseForm repository={repository} list={list} release={release} onCancel={() => setEditing(false)} onDone={(saved) => { setEditing(false); onChanged(saved); onNotify("Checkpoint saved."); }} />;
  return <>
    <a className="header-back release-back" href={base}><ArrowLeftIcon size={13} />All checkpoints</a>
    <section className="panel release-detail">
      <div className="panel-header release-detail-header">
        <div>
          <h2>{release.name}</h2>
          <div className="release-meta"><ReleaseBadges release={release} latest={latestId(list.releases) === release.id} /><span><TagIcon size={14} aria-hidden="true" /><code>{release.tag}</code></span><span>Target <code title={release.targetSha}>{release.targetSha.slice(0, 7)}</code></span><span>{release.publishedAt ? `Published ${new Date(release.publishedAt).toLocaleString()}` : `Drafted ${new Date(release.createdAt).toLocaleString()}`}</span></div>
        </div>
        {canLand && <div className="release-actions">
          {release.draft && <Button variant="primary" size="base" icon={RocketLaunchIcon} loading={busy && confirming === null} disabled={busy} onClick={() => setConfirming("publish")}>{action.retrying ? "Retry publish" : "Publish"}</Button>}
          <Button variant="secondary" size="base" icon={PencilSimpleIcon} disabled={busy} onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="secondary" size="base" icon={TrashIcon} disabled={busy} onClick={() => setConfirming("delete")}>Delete</Button>
        </div>}
      </div>
      {error && <div className="panel-body"><div className="error-notice" role="alert">{error}</div></div>}
      <div className="panel-body">{release.notes.trim() ? <ReleaseMarkdown content={release.notes} /> : <p className="release-hint">No checkpoint notes.</p>}</div>
      {!release.draft && <div className="release-fetch"><code>git fetch origin tag {release.tag}</code></div>}
    </section>
    <Dialog.Root open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
      <Dialog size="sm" className="dialog-content confirm-dialog">
        <Dialog.Title className="dialog-title">{confirming === "publish" ? `Publish ${release.tag}?` : "Delete this checkpoint?"}</Dialog.Title>
        <Dialog.Description className="dialog-description">
          {confirming === "publish"
            ? <>This creates the tag <code>{release.tag}</code> at revision <code>{release.targetSha.slice(0, 12)}</code> in <strong>{repository.name}</strong>. Tags are permanent and are never moved.</>
            : release.draft ? <>The draft <strong>{release.name}</strong> will be removed. No tag exists for it.</> : <>Only the checkpoint record is removed. The tag <code>{release.tag}</code> is immutable and stays in the repository.</>}
        </Dialog.Description>
        <div className="dialog-actions">
          <Button variant="secondary" size="base" type="button" onClick={() => setConfirming(null)}>Cancel</Button>
          <Button variant={confirming === "delete" ? "destructive" : "primary"} size="base" type="button" onClick={() => { const kind = confirming; setConfirming(null); if (kind) void act(kind); }}>{confirming === "publish" ? "Publish checkpoint" : "Delete checkpoint"}</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  </>;
}

export default function Releases({ repository, releaseId, canLand, onNotify }: { repository: Repository; releaseId?: string; canLand: boolean; onNotify: (message: string) => void }) {
  const [list, setList] = useState<ReleaseList | null>(null);
  const [error, setError] = useState("");
  const base = `repository/${repository.id}/releases`;

  const load = useCallback(async () => {
    try { setList(await request<ReleaseList>(`/api/repositories/${repository.id}/releases`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Checkpoints could not be loaded."); }
  }, [repository.id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="error-notice" role="alert">{error}</div>;
  if (!list) return <RouteProgress />;
  const permission = canLand ? "" : "Publishing checkpoints requires permission to land changes on the main stream.";
  if (releaseId === "new") return canLand ? <ReleaseForm repository={repository} list={list} onCancel={() => goTo(base)} onDone={(release) => { onNotify(release.draft ? "Draft saved." : `Published ${release.tag}.`); void load(); goTo(`${base}/${release.id}`); }} /> : <div className="error-notice" role="alert">{permission}</div>;
  if (releaseId) {
    const release = list.releases.find((item) => item.id === releaseId);
    if (!release) return <><a className="header-back release-back" href={`/${base}`}><ArrowLeftIcon size={13} />All checkpoints</a><div className="error-notice" role="alert">This checkpoint could not be found.</div></>;
    return <ReleaseDetail key={release.id} repository={repository} list={list} release={release} canLand={canLand} onNotify={onNotify} onChanged={(changed) => { void load(); if (!changed) goTo(base); }} />;
  }
  const latest = latestId(list.releases);
  return <section className="releases">
    <div className="releases-toolbar">
      <div><h2>Checkpoints<span className="git-term">· releases &amp; tags</span></h2><p>Named versions backed by permanent Git tags on {list.defaultBranch}.</p></div>
      <Button variant="primary" size="base" icon={PlusIcon} disabled={!canLand || !list.headSha} title={permission || (!list.headSha ? "Push an initial revision first." : undefined)} onClick={() => goTo(`${base}/new`)}>Draft a new checkpoint</Button>
    </div>
    {permission && <p className="release-hint">{permission}</p>}
    {list.releases.length ? <ul className="panel release-list" aria-label="Checkpoints">
      {list.releases.map((release) => <li key={release.id}>
        <div><a href={`/${base}/${release.id}`}>{release.name}</a><ReleaseBadges release={release} latest={release.id === latest} /></div>
        <div className="release-row-meta"><span><TagIcon size={14} aria-hidden="true" /><code>{release.tag}</code></span><code title={release.targetSha}>{release.targetSha.slice(0, 7)}</code><span>{new Date(release.publishedAt ?? release.createdAt).toLocaleDateString()}</span></div>
      </li>)}
    </ul> : <section className="panel release-empty"><TagIcon size={30} aria-hidden="true" /><h3>No checkpoints yet</h3><p>Checkpoints mark a revision with a permanent Git tag and notes, so people can find and fetch a known version.</p></section>}
  </section>;
}
