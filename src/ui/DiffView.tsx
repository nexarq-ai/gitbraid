import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import {
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  FileCodeIcon,
  LinkSimpleIcon,
  ListIcon,
} from "@phosphor-icons/react";
import {
  parseFilePatch,
  splitRows,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type DiffSide,
} from "../shared/diff";
import type { FileChange, ProposalReview } from "../shared/types";
import { grammarFor, tokenize } from "./diff-highlight";
import "./diff-view.css";

export type LineAnchor = { path: string; line: number; side: DiffSide };
export type LineCommentKind = "comment" | "request_changes";
type Mode = "unified" | "split";

type Props = {
  changes: FileChange[];
  candidateSha: string | null;
  comments: ProposalReview[];
  canComment: boolean;
  canRequestChanges: boolean;
  onComment: (anchor: LineAnchor, body: string, kind: LineCommentKind) => Promise<void>;
  fileMeta?: (change: FileChange) => ReactNode;
};

const MODE_KEY = "gitflare:diff-mode";
const STORED_PATCH_LIMIT = 12_000;
const STATUS_LABELS = { added: "Added", deleted: "Deleted", renamed: "Renamed", binary: "Binary", modified: "Modified" } as const;

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

export function fileAnchor(path: string): string {
  return `diff-${path}`;
}

export function lineAnchor({ path, line, side }: LineAnchor): string {
  return `diff-${path}-${side === "old" ? "L" : "R"}${line}`;
}

function anchorKey(anchor: LineAnchor): string {
  return `${anchor.path}\u0000${anchor.side}\u0000${anchor.line}`;
}

function parseHash(hash: string, paths: string[]): { path: string; anchor?: LineAnchor } | undefined {
  let fragment: string;
  try {
    fragment = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return undefined;
  }
  if (!fragment.startsWith("diff-")) return undefined;
  const rest = fragment.slice(5);
  const line = /^(.*)-([LR])(\d+)$/.exec(rest);
  if (line && paths.includes(line[1]))
    return { path: line[1], anchor: { path: line[1], side: line[2] === "L" ? "old" : "new", line: Number(line[3]) } };
  return paths.includes(rest) ? { path: rest } : undefined;
}

function Code({ text, grammar }: { text: string; grammar: ReturnType<typeof grammarFor> }) {
  return (
    <>
      {tokenize(text, grammar).map((token, index) =>
        token.kind ? (
          <span key={index} className={`tok-${token.kind}`}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </>
  );
}

function Thread({ comments }: { comments: ProposalReview[] }) {
  return (
    <>
      {comments.map((comment) => (
        <article className="diff-comment" key={comment.id}>
          <header>
            <strong>{comment.authorId}</strong>
            {comment.kind === "request_changes" && (
              <span className={comment.resolvedAt ? "diff-comment-tag resolved" : "diff-comment-tag"}>
                {comment.resolvedAt ? "Request resolved" : "Changes requested"}
              </span>
            )}
            <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
          </header>
          <p>{comment.body}</p>
        </article>
      ))}
    </>
  );
}

export default function DiffView({ changes, candidateSha, comments, canComment, canRequestChanges, onComment, fileMeta }: Props) {
  const [mode, setMode] = useState<Mode>(() => (readStorage<string>(MODE_KEY, "unified") === "split" ? "split" : "unified"));
  const viewedKey = `gitflare:diff-viewed:${candidateSha ?? "none"}`;
  const [viewed, setViewed] = useState<Set<string>>(() => new Set(readStorage<string[]>(viewedKey, [])));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readStorage<string[]>(viewedKey, [])));
  const [selected, setSelected] = useState<string>("");
  const [composer, setComposer] = useState<LineAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<LineCommentKind | "">("");
  const [failure, setFailure] = useState("");
  const [treeOpen, setTreeOpen] = useState(false);

  const files = useMemo(
    () => changes.map((change) => ({ change, diff: parseFilePatch(change.patch, change.path) })),
    [changes],
  );
  const threads = useMemo(() => {
    const map = new Map<string, ProposalReview[]>();
    for (const comment of comments) {
      if (!comment.path || !comment.line || !comment.side) continue;
      const key = anchorKey({ path: comment.path, line: comment.line, side: comment.side });
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [comments]);
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments) if (comment.path) counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
    return counts;
  }, [comments]);

  useEffect(() => {
    const stored = new Set(readStorage<string[]>(viewedKey, []));
    setViewed(stored);
    setCollapsed(stored);
  }, [viewedKey]);

  const pathKey = useMemo(() => changes.map((change) => change.path).join("\n"), [changes]);

  useEffect(() => {
    const paths = pathKey.split("\n");
    const follow = () => {
      const target = parseHash(window.location.hash, paths);
      if (!target) return;
      setCollapsed((current) => {
        if (!current.has(target.path)) return current;
        const next = new Set(current);
        next.delete(target.path);
        return next;
      });
      const id = target.anchor ? lineAnchor(target.anchor) : fileAnchor(target.path);
      setSelected(target.anchor ? id : "");
      window.requestAnimationFrame(() => {
        const element = document.getElementById(id);
        element?.scrollIntoView({ block: target.anchor ? "center" : "start" });
        element?.closest(".diff-scroll")?.scrollTo({ left: 0 });
      });
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [pathKey]);

  function chooseMode(next: Mode) {
    setMode(next);
    writeStorage(MODE_KEY, next);
  }

  function toggleViewed(path: string) {
    const next = new Set(viewed);
    const nowViewed = !next.has(path);
    if (nowViewed) next.add(path);
    else next.delete(path);
    setViewed(next);
    writeStorage(viewedKey, [...next]);
    setCollapsed((current) => {
      const updated = new Set(current);
      if (nowViewed) updated.add(path);
      else updated.delete(path);
      return updated;
    });
  }

  function toggleCollapsed(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function select(anchor: LineAnchor) {
    const id = lineAnchor(anchor);
    setSelected(id);
    try {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${encodeURI(id)}`);
    } catch {
      return;
    }
  }

  function openComposer(anchor: LineAnchor) {
    if (!composer || anchorKey(composer) !== anchorKey(anchor)) setDraft("");
    setFailure("");
    setComposer(anchor);
    select(anchor);
  }

  async function submit(kind: LineCommentKind) {
    if (!composer || !draft.trim() || sending) return;
    setSending(kind);
    setFailure("");
    try {
      await onComment(composer, draft.trim(), kind);
      setComposer(null);
      setDraft("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The comment could not be saved.");
    } finally {
      setSending("");
    }
  }

  function threadRow(anchors: LineAnchor[], span: number) {
    const found = anchors.flatMap((anchor) => threads.get(anchorKey(anchor)) ?? []);
    const composing = composer && anchors.some((anchor) => anchorKey(anchor) === anchorKey(composer));
    if (!found.length && !composing) return null;
    const replyTo = anchors.find((anchor) => threads.has(anchorKey(anchor)));
    return (
      <tr className="diff-thread-row">
        <td colSpan={span}>
          <div className="diff-thread">
            <Thread comments={found} />
            {composing ? (
              <form
                className="diff-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit("comment");
                }}
              >
                <label htmlFor="diff-composer-body">
                  Comment on {composer.side === "old" ? "original" : "changed"} line {composer.line}
                </label>
                <textarea
                  id="diff-composer-body"
                  autoFocus
                  required
                  maxLength={8000}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Leave a comment on this line…"
                />
                {failure && <p className="diff-composer-error" role="alert">{failure}</p>}
                <div className="diff-composer-actions">
                  <Button type="submit" variant="primary" size="sm" loading={sending === "comment"} disabled={!!sending || !draft.trim()}>
                    Comment
                  </Button>
                  {canRequestChanges && (
                    <Button variant="secondary" size="sm" loading={sending === "request_changes"} disabled={!!sending || !draft.trim()} onClick={() => void submit("request_changes")}>
                      Request changes
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={!!sending} onClick={() => setComposer(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              canComment &&
              replyTo && (
                <button type="button" className="diff-reply" onClick={() => openComposer(replyTo)}>
                  Reply…
                </button>
              )
            )}
          </div>
        </td>
      </tr>
    );
  }

  function lineNumber(path: string, side: DiffSide, line: DiffLine | undefined, cellId?: string) {
    const value = side === "old" ? line?.oldLine : line?.newLine;
    if (value === undefined) return <td className="diff-num" />;
    const id = lineAnchor({ path, side, line: value });
    return (
      <td className="diff-num" id={cellId}>
        <a href={`#${encodeURI(id)}`} aria-label={`${side === "old" ? "Original" : "Changed"} line ${value}`} onClick={(event) => { event.preventDefault(); select({ path, side, line: value }); }}>
          {value}
        </a>
      </td>
    );
  }

  function codeCell(path: string, line: DiffLine | undefined, side: DiffSide, grammar: ReturnType<typeof grammarFor>, id?: string) {
    if (!line) return <td className="diff-code empty" />;
    const number = side === "old" ? line.oldLine : line.newLine;
    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    return (
      <td className={`diff-code ${line.type}`} id={id}>
        {canComment && number !== undefined && (
          <button type="button" className="diff-add-comment" aria-label={`Comment on line ${number}`} onClick={() => openComposer({ path, side, line: number })}>
            <ChatCircleIcon size={13} weight="bold" />
          </button>
        )}
        <span className="diff-marker" aria-hidden="true">{marker}</span>
        <Code text={line.text} grammar={grammar} />
        {line.noNewline && <span className="diff-eof" title="No newline at end of file">⏎̸</span>}
      </td>
    );
  }

  function unifiedHunk(path: string, hunk: DiffHunk, grammar: ReturnType<typeof grammarFor>) {
    return hunk.lines.map((line, index) => {
      const side: DiffSide = line.type === "remove" ? "old" : "new";
      const number = side === "old" ? line.oldLine : line.newLine;
      const anchor = number === undefined ? undefined : { path, side, line: number };
      const anchors: LineAnchor[] = [];
      if (line.oldLine !== undefined) anchors.push({ path, side: "old", line: line.oldLine });
      if (line.newLine !== undefined) anchors.push({ path, side: "new", line: line.newLine });
      const id = anchor ? lineAnchor(anchor) : undefined;
      const contextOldId = line.type === "context" && line.oldLine !== undefined ? lineAnchor({ path, side: "old", line: line.oldLine }) : undefined;
      return (
        <Fragment key={index}>
          <tr className={`diff-row ${line.type}${selected && (selected === id || selected === contextOldId) ? " selected" : ""}`}>
            {lineNumber(path, "old", line, contextOldId)}
            {lineNumber(path, "new", line)}
            {codeCell(path, line, side, grammar, id)}
          </tr>
          {threadRow(anchors, 3)}
        </Fragment>
      );
    });
  }

  function splitHunk(path: string, hunk: DiffHunk, grammar: ReturnType<typeof grammarFor>) {
    return splitRows(hunk).map((row, index) => {
      const anchors: LineAnchor[] = [];
      if (row.left?.oldLine !== undefined) anchors.push({ path, side: "old", line: row.left.oldLine });
      if (row.right?.newLine !== undefined) anchors.push({ path, side: "new", line: row.right.newLine });
      const leftId = row.left?.oldLine !== undefined ? lineAnchor({ path, side: "old", line: row.left.oldLine }) : undefined;
      const rightId = row.right?.newLine !== undefined ? lineAnchor({ path, side: "new", line: row.right.newLine }) : undefined;
      return (
        <Fragment key={index}>
          <tr className={`diff-row split${selected && (selected === leftId || selected === rightId) ? " selected" : ""}`}>
            {lineNumber(path, "old", row.left)}
            {codeCell(path, row.left, "old", grammar, leftId)}
            {lineNumber(path, "new", row.right)}
            {codeCell(path, row.right, "new", grammar, rightId)}
          </tr>
          {threadRow(anchors, 4)}
        </Fragment>
      );
    });
  }

  function body(change: FileChange, diff: DiffFile) {
    const truncated = diff.truncated || change.patch.length >= STORED_PATCH_LIMIT;
    const notes: string[] = [];
    if (diff.modeChange) notes.push(`File mode changed from ${diff.modeChange.from || "unknown"} to ${diff.modeChange.to || "unknown"}.`);
    if (diff.binary) notes.push("Binary file changed. Its contents are not shown.");
    else if (!change.patch.trim()) notes.push("No patch was returned for this file.");
    else if (!diff.hunks.length && diff.status === "renamed") notes.push("File renamed without content changes.");
    else if (!diff.hunks.length) notes.push(diff.status === "added" ? "Empty file added." : diff.status === "deleted" ? "Empty file deleted." : "No line changes.");
    const grammar = grammarFor(change.path);
    const span = mode === "split" ? 4 : 3;
    return (
      <>
        {notes.map((note) => (
          <p className="diff-note" key={note}>{note}</p>
        ))}
        {diff.hunks.length > 0 && (
          <div className="diff-scroll">
            <table className={`diff-table ${mode}`}>
              {mode === "split" ? (
                <colgroup>
                  <col className="diff-col-num" />
                  <col />
                  <col className="diff-col-num" />
                  <col />
                </colgroup>
              ) : (
                <colgroup>
                  <col className="diff-col-num" />
                  <col className="diff-col-num" />
                  <col />
                </colgroup>
              )}
              <tbody>
                {diff.hunks.map((hunk, index) => (
                  <Fragment key={index}>
                    {hunk.numbered && (
                      <tr className="diff-hunk">
                        <td colSpan={span}>
                          <span>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</span>
                          {hunk.section && <span className="diff-hunk-section"> {hunk.section}</span>}
                        </td>
                      </tr>
                    )}
                    {mode === "split" ? splitHunk(change.path, hunk, grammar) : unifiedHunk(change.path, hunk, grammar)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {truncated && (
          <p className="diff-note warning">
            This diff was cut off at {Math.round(STORED_PATCH_LIMIT / 1000)} KB when the candidate was recorded. Later lines are not stored with this mission; inspect the candidate revision for the full file.
          </p>
        )}
      </>
    );
  }

  const viewedCount = changes.filter((change) => viewed.has(change.path)).length;

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <button type="button" className="diff-tree-toggle" aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>
          <ListIcon size={14} /> {changes.length} {changes.length === 1 ? "file" : "files"}
        </button>
        <span className="diff-totals">
          {viewedCount} of {changes.length} viewed
        </span>
        <div className="diff-mode" role="group" aria-label="Diff layout">
          <button type="button" aria-pressed={mode === "unified"} onClick={() => chooseMode("unified")}>Unified</button>
          <button type="button" aria-pressed={mode === "split"} onClick={() => chooseMode("split")}>Split</button>
        </div>
      </div>
      <div className={`diff-layout${treeOpen ? " tree-open" : ""}`}>
        <nav className="diff-tree" aria-label="Changed files">
          <ul>
            {files.map(({ change, diff }) => (
              <li key={change.path}>
                <a href={`#${encodeURI(fileAnchor(change.path))}`} className={viewed.has(change.path) ? "viewed" : undefined} onClick={() => setTreeOpen(false)}>
                  <span className={`diff-status ${diff.status}`} title={STATUS_LABELS[diff.status]}>{STATUS_LABELS[diff.status][0]}</span>
                  <span className="diff-tree-path" title={change.path}>{change.path}</span>
                  <span className="diff-tree-counts">
                    {(commentCounts.get(change.path) ?? 0) > 0 && <span className="diff-tree-comments"><ChatCircleIcon size={11} />{commentCounts.get(change.path)}</span>}
                    <span className="diff-plus">+{change.additions}</span>
                    <span className="diff-minus">−{change.deletions}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="diff-files">
          {files.map(({ change, diff }) => {
            const isCollapsed = collapsed.has(change.path);
            const renamed = diff.status === "renamed" && diff.oldPath && diff.newPath && diff.oldPath !== diff.newPath;
            return (
              <section className="diff-file" key={change.path} id={fileAnchor(change.path)}>
                <header className="diff-file-header">
                  <button type="button" className="diff-collapse" aria-expanded={!isCollapsed} aria-label={isCollapsed ? `Expand ${change.path}` : `Collapse ${change.path}`} onClick={() => toggleCollapsed(change.path)}>
                    {isCollapsed ? <CaretRightIcon size={14} /> : <CaretDownIcon size={14} />}
                  </button>
                  <FileCodeIcon size={15} className="diff-file-icon" />
                  <code className="diff-file-path" title={change.path}>
                    {renamed ? `${diff.oldPath} → ${diff.newPath}` : change.path}
                  </code>
                  {diff.status !== "modified" && <span className={`diff-status-label ${diff.status}`}>{STATUS_LABELS[diff.status]}</span>}
                  <span className="diff-file-counts">
                    <span className="diff-plus">+{change.additions}</span> <span className="diff-minus">−{change.deletions}</span>
                  </span>
                  <a className="diff-file-link" href={`#${encodeURI(fileAnchor(change.path))}`} aria-label={`Link to ${change.path}`}>
                    <LinkSimpleIcon size={14} />
                  </a>
                  <label className="diff-viewed">
                    <input type="checkbox" checked={viewed.has(change.path)} onChange={() => toggleViewed(change.path)} />
                    Viewed
                  </label>
                </header>
                {fileMeta && !isCollapsed && <div className="diff-file-meta">{fileMeta(change)}</div>}
                {!isCollapsed && body(change, diff)}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
