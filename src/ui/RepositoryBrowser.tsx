import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CaretRightIcon,
  FileCodeIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  GitCommitIcon,
} from "@phosphor-icons/react";
import type {
  Repository,
  RepositoryFile,
  RepositoryTree,
} from "../shared/types";
import { request } from "./api";
import { EmptyState, ErrorNotice } from "./components";

type Selection = { path: string; kind: "directory" | "file" };

export default function RepositoryBrowser({
  repository,
}: {
  repository: Repository;
}) {
  const [selection, setSelection] = useState<Selection>({
    path: "",
    kind: "directory",
  });
  const [reference, setReference] = useState(repository.defaultBranch);
  const [inputRef, setInputRef] = useState(repository.defaultBranch);
  const [tree, setTree] = useState<RepositoryTree | null>(null);
  const [file, setFile] = useState<RepositoryFile | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [readme, setReadme] = useState<RepositoryFile | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (repository.provider !== "artifacts") {
      setBusy(false);
      return;
    }
    let active = true;
    setBusy(true);
    setError("");
    const query = new URLSearchParams({ ref: reference, path: selection.path });
    const path = `/api/repositories/${encodeURIComponent(repository.id)}/${selection.kind === "file" ? "file" : "tree"}?${query}`;
    const load = async () => {
      try {
        if (selection.kind === "file") {
          const result = await request<RepositoryFile>(path);
          if (active) {
            setFile(result);
            setTree(null);
          }
        } else {
          const result = await request<RepositoryTree>(path);
          if (active) {
            setTree(result);
            setFile(null);
          }
        }
      } catch (failure) {
        if (active) {
          setTree(null);
          setFile(null);
          setError(
            failure instanceof Error
              ? failure.message
              : "Source code could not be loaded.",
          );
        }
      } finally {
        if (active) setBusy(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [
    repository.id,
    repository.provider,
    reference,
    selection.path,
    selection.kind,
    attempt,
  ]);

  useEffect(() => {
    let active = true;
    setReadme(null);
    if (!tree || selection.path || selection.kind !== "directory") return;
    const entry = tree.entries.find(entry => entry.type === "file" && /^readme(?:\.md)?$/i.test(entry.name));
    if (!entry) return;
    const query = new URLSearchParams({ ref: tree.commitSha, path: entry.path });
    void request<RepositoryFile>(`/api/repositories/${encodeURIComponent(repository.id)}/file?${query}`).then(value => { if (active) setReadme(value); }).catch(() => {});
    return () => { active = false; };
  }, [tree, selection.path, selection.kind, repository.id]);

  if (repository.provider !== "artifacts")
    return (
      <section className="panel">
        <EmptyState
          icon={<FolderSimpleIcon size={25} />}
          title="Connect Git storage to browse source"
          description="This local workspace record does not contain a Git repository. Create or connect an Artifacts repository to browse its files."
        />
      </section>
    );

  const segments = selection.path.split("/").filter(Boolean);
  const parentPath = segments.slice(0, -1).join("/");
  return (
    <>
      <div className="source-toolbar">
        <form
          className="ref-picker"
          onSubmit={(event) => {
            event.preventDefault();
            setReference(inputRef.trim() || repository.defaultBranch);
            setSelection({ path: "", kind: "directory" });
          }}
        >
          <GitBranchIcon size={15} />
          <Input
            aria-label="Stream or revision"
            placeholder="Stream or revision"
            size="base"
            value={inputRef}
            onChange={(event) => setInputRef(event.target.value)}
          />
          <Button
            variant="secondary"
            size="base"
            shape="square"
            aria-label="Browse this reference"
            icon={ArrowRightIcon}
            type="submit"
          />
        </form>
        <div className="source-breadcrumbs">
          <button onClick={() => setSelection({ path: "", kind: "directory" })}>
            {repository.name}
          </button>
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`}>
              <CaretRightIcon size={11} />
              <button
                onClick={() =>
                  setSelection({
                    path: segments.slice(0, index + 1).join("/"),
                    kind:
                      index === segments.length - 1
                        ? selection.kind
                        : "directory",
                  })
                }
              >
                {segment}
              </button>
            </span>
          ))}
        </div>
      </div>
      {error && (
        <ErrorNotice
          message={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: "flex", gap: 7, alignItems: "center" }}>
            {selection.kind === "file" ? (
              <FileCodeIcon size={16} />
            ) : (
              <FolderSimpleIcon size={16} />
            )}{" "}
            {selection.kind === "file"
              ? segments[segments.length - 1]
              : "Files"}
          </h2>
          <span className="status-strip">
            <GitCommitIcon size={13} />
            <code>
              {(tree?.commitSha || file?.commitSha)?.slice(0, 10) ||
                "Unresolved"}
            </code>
          </span>
        </div>
        {busy ? (
          <div className="loading-state" role="status" style={{ padding: 45 }}>
            Loading source…
          </div>
        ) : file ? (
          <>
            <div className="source-file-actions">
              <button
                className="text-link"
                onClick={() =>
                  setSelection({ path: parentPath, kind: "directory" })
                }
              >
                <ArrowLeftIcon size={12} />
                Back to files
              </button>
              <span>{file.content.split("\n").length} lines</span>
            </div>
            {file.content.split("\n").length > 10000 && (
              <p className="notice-inline">
                Showing the first 10,000 lines. Clone the repository to inspect
                the full file.
              </p>
            )}
            <pre className="file-content">
              <code>
                {file.content
                  .split("\n")
                  .slice(0, 10000)
                  .map((line, index) => (
                    <span className="source-line" key={index}>
                      <span className="line-number" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span>{line || " "}</span>
                    </span>
                  ))}
              </code>
            </pre>
          </>
        ) : tree ? (
          <div className="table-scroll">
            <table className="resource-table source-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {selection.path && (
                  <tr>
                    <td colSpan={3}>
                      <button
                        className="text-link"
                        onClick={() =>
                          setSelection({ path: parentPath, kind: "directory" })
                        }
                      >
                        <ArrowLeftIcon size={13} />
                        ..
                      </button>
                    </td>
                  </tr>
                )}
                {[...tree.entries]
                  .sort(
                    (a, b) =>
                      Number(b.type === "directory") -
                        Number(a.type === "directory") ||
                      a.name.localeCompare(b.name),
                  )
                  .map((entry) => (
                    <tr key={entry.path}>
                      <td>
                        <div className="resource-name">
                          {entry.type === "directory" ? (
                            <FolderSimpleIcon size={17} />
                          ) : (
                            <FileCodeIcon size={17} />
                          )}
                          <button
                            onClick={() =>
                              setSelection({
                                path: entry.path,
                                kind: entry.type,
                              })
                            }
                          >
                            {entry.name}
                          </button>
                        </div>
                      </td>
                      <td>
                        {entry.type === "directory" ? "Directory" : "File"}
                      </td>
                      <td>
                        {entry.size === undefined
                          ? "—"
                          : entry.size < 1024
                            ? `${entry.size} B`
                            : `${(entry.size / 1024).toFixed(1)} KB`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!tree.entries.length && (
              <EmptyState
                icon={<FolderSimpleIcon size={25} />}
                title="This directory is empty"
                description="Push source code to this repository to see it here."
              />
            )}
          </div>
        ) : (
          !error && (
            <EmptyState
              icon={<FolderSimpleIcon size={25} />}
              title="No source code found"
              description="Push your first revision, then refresh this view."
            />
          )
        )}
      </section>
      {readme && <section className="panel"><div className="panel-header"><h2>README</h2><code>{readme.commitSha.slice(0, 10)}</code></div><div className="panel-body documentation-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || "Image"}</span>, a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{readme.content}</Markdown></div></section>}
    </>
  );
}
