import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { ArrowsOutIcon, BookOpenIcon, CheckIcon, CopyIcon, ArrowSquareOutIcon, XIcon } from "@phosphor-icons/react";
import { request } from "./api";
import { ErrorNotice } from "./components";
import { diagrams, type DocumentationDiagram } from "./doc-diagrams";
import "./documentation.css";
import { navigate as goTo } from "./router";
import { RouteProgress } from "./WorkspaceLoader";

type DocumentItem = {
  id: string;
  title: string;
  description: string;
  audience: string;
  filename: string;
};
type DocumentContent = DocumentItem & { content: string };

function headingId(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
}

function plainText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(plainText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return plainText((children.props as { children?: ReactNode }).children);
  }
  return "";
}

export default function Documentation({ id, publicMode = false }: { id: string; publicMode?: boolean }) {
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [document, setDocument] = useState<DocumentContent | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyGeneration = useRef(0);
  const [expandedDiagram, setExpandedDiagram] = useState<(DocumentationDiagram & { alt: string }) | null>(null);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 760px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const article = useRef<HTMLElement>(null);
  const diagramTrigger = useRef("");
  const pendingAnchor = useRef("");

  useEffect(() => {
    let active = true;
    setItems([]);
    setError("");
    void request<{ items: DocumentItem[] }>(publicMode ? "/api/public/docs" : "/api/docs").then((data) => {
      if (active) setItems(data.items);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "Documentation could not be loaded.");
    });
    return () => { active = false; };
  }, [retry, publicMode]);

  useEffect(() => {
    let active = true;
    setDocument(null);
    setCopyState("idle");
    copyGeneration.current += 1;
    setExpandedDiagram(null);
    setLoading(true);
    setError("");
    void request<DocumentContent>(`${publicMode ? "/api/public/docs" : "/api/docs"}/${encodeURIComponent(id)}`).then((data) => {
      if (active) setDocument(data);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "This document could not be loaded.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [id, retry, publicMode]);

  async function copyMarkdown() {
    if (!document) return;
    const generation = copyGeneration.current;
    try {
      const response = await fetch(`${publicMode ? "/api/public/docs" : "/api/docs"}/${encodeURIComponent(document.id)}.md`, { credentials: "same-origin" });
      if (response.status === 401 && !publicMode) window.dispatchEvent(new Event("gitflare:session-required"));
      if (!response.ok) throw new Error("Markdown could not be loaded.");
      const markdown = await response.text();
      if (generation !== copyGeneration.current) return;
      await navigator.clipboard.writeText(markdown);
      if (generation === copyGeneration.current) setCopyState("copied");
    } catch {
      if (generation === copyGeneration.current) setCopyState("failed");
    }
  }

  function scrollToHeading(anchor: string) {
    const target = Array.from(article.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find((element) => element.id === anchor);
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (document && pendingAnchor.current) {
      scrollToHeading(pendingAnchor.current);
      pendingAnchor.current = "";
    }
  }, [document]);

  const content = document?.content.replace(/^\s*# [^\n]+\n/, "") ?? "";
  const readingMinutes = Math.max(1, Math.ceil(content.split(/\s+/).length / 220));
  const category = document?.audience === "human" ? "Workspace guide" : document?.audience === "agent" ? "AI client guide" : document?.audience === "planning" ? "Platform planning" : "Engineering";
  const headings: { title: string; anchor: string; level: number }[] = [];
  let fence = "";
  for (const line of content.split("\n")) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = "";
      continue;
    }
    const match = !fence && line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (match) {
      const title = match[2].replace(/[`*_]/g, "");
      headings.push({ title, anchor: headingId(title), level: match[1].length });
    }
  }

  return (
    <div className="documentation-page wiki-page">
      {!publicMode && <div className="documentation-library-heading"><BookOpenIcon size={20} /><span>Gitflare documentation</span></div>}
      {error && <ErrorNotice message={error} onRetry={() => setRetry((value) => value + 1)} />}
      <div className="documentation-layout">
        <div className="documentation-mobile-selector"><label htmlFor="documentation-guide">Guide</label><select id="documentation-guide" value={id} disabled={!items.length} onChange={(event) => { goTo(`docs/${event.target.value}`); }}>{!items.length && <option value={id}>Loading library…</option>}{items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <aside className="documentation-navigation" aria-label="Documentation library">
          {[{ label: "For people", audience: "human" }, { label: "For AI clients", audience: "agent" }, { label: "Reference", audience: "reference" }].map((group) => {
            const documents = items.filter((item) => item.audience === group.audience || (group.audience === "reference" && !["human", "agent"].includes(item.audience)));
            return documents.length > 0 && <section key={group.audience}><h2>{group.label}</h2>{documents.map((item) => <a key={item.id} href={`/docs/${item.id}`} aria-current={id === item.id ? "page" : undefined} className={id === item.id ? "selected" : ""}><BookOpenIcon size={16} /><span>{item.title}</span></a>)}</section>;
          })}
          {!items.length && !error && <RouteProgress />}
        </aside>
        <article className="documentation-article" ref={article} aria-busy={loading}>
          {loading ? <p role="status">Opening document…</p> : document ? <>
            <header className="documentation-title"><div className="documentation-meta"><span>{category}</span><span>{readingMinutes} min read</span></div><h1>{document.title}</h1><p>{document.description}</p><div className="documentation-format-actions"><a href={`${publicMode ? "/api/public/docs" : "/api/docs"}/${encodeURIComponent(document.id)}.md`} target="_blank" rel="noopener noreferrer"><ArrowSquareOutIcon size={15} />View Markdown</a><button type="button" onClick={() => void copyMarkdown()}><span aria-hidden="true">{copyState === "copied" ? <CheckIcon size={15} /> : <CopyIcon size={15} />}</span>{copyState === "copied" ? "Copied" : "Copy Markdown"}</button><span className="documentation-copy-status" role="status">{copyState === "copied" ? "Markdown copied to clipboard." : copyState === "failed" ? "Copy unavailable. Open View Markdown to copy the text." : ""}</span></div></header>
            <div className="documentation-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => Object.hasOwn(diagrams, url) ? url : defaultUrlTransform(url)} components={{
              h1: ({ children }) => <h2 className="documentation-article-heading" id={headingId(plainText(children))} tabIndex={-1}>{children}</h2>,
              h2: ({ children }) => <h2 id={headingId(plainText(children))} tabIndex={-1}>{children}</h2>,
              h3: ({ children }) => <h3 id={headingId(plainText(children))} tabIndex={-1}>{children}</h3>,
              img: ({ src, alt }) => {
                if (src === "https://deploy.workers.cloudflare.com/button") return <img src={src} width={200} height={32} alt={alt || "Deploy to Cloudflare"} loading="lazy" />;
                const diagram = src && Object.hasOwn(diagrams, src) ? diagrams[src] : undefined;
                return diagram ? <span className="documentation-diagram" role="figure" aria-label={diagram.title}><span className="documentation-diagram-scroll" tabIndex={0} role="region" aria-label={`${diagram.title}, scroll to see the full diagram`}><img src={diagram.src} alt={alt || diagram.caption} loading="lazy" /></span><span className="documentation-diagram-caption">{diagram.caption}</span><span className="documentation-diagram-tools"><span className="documentation-diagram-hint">Scroll horizontally to see the full diagram.</span><button type="button" data-diagram-key={`${id}:${src}`} onClick={() => { diagramTrigger.current = `${id}:${src}`; setExpandedDiagram({ ...diagram, alt: alt || diagram.caption }); }} aria-label={`Expand diagram: ${diagram.title}`}><ArrowsOutIcon size={15} />Expand diagram</button></span></span> : <span className="documentation-image-label">{alt ? `Image: ${alt}` : "Image reference"}</span>;
              },
              a: ({ href, children }) => {
                if (href?.startsWith("#")) return <button className="documentation-inline-link" onClick={() => scrollToHeading(href.slice(1))}>{children}</button>;
                if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
                const [path, anchor] = (href ?? "").split("#");
                let decodedPath = path;
                try { decodedPath = decodeURIComponent(path); } catch { decodedPath = ""; }
                const filename = decodedPath.replace(/^\.\//, "").split("/").pop();
                const linked = items.find((item) => item.filename === decodedPath || item.filename.split("/").pop() === filename);
                if (linked) return <a href={`/docs/${linked.id}`} onClick={(event) => { if (linked.id === id && anchor) { event.preventDefault(); scrollToHeading(anchor); } else { pendingAnchor.current = anchor ?? ""; } }}>{children}</a>;
                return <span title="This reference is not available in the documentation library">{children}<span className="documentation-unavailable"> (reference unavailable)</span></span>;
              },
              table: ({ children }) => <div className="documentation-table"><table>{children}</table></div>,
            }}>{content}</Markdown></div>
            <footer className="documentation-article-footer"><BookOpenIcon size={16} /><span>Gitflare workspace documentation</span><button onClick={() => article.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}>Back to top</button></footer>
          </> : !error && <p>This document is unavailable.</p>}
          {!loading && error && <Button variant="secondary" size="base" onClick={() => setRetry((value) => value + 1)}>Try again</Button>}
        </article>
        {headings.length > 0 && <aside className="documentation-toc" aria-label="On this page"><details className="documentation-toc-details" open={!compact}><summary>On this page</summary><div>{headings.map((heading, index) => <button key={`${heading.anchor}-${index}`} className={`level-${heading.level}`} onClick={() => scrollToHeading(heading.anchor)}>{heading.title}</button>)}</div></details></aside>}
      </div>
      <Dialog.Root open={expandedDiagram !== null} onOpenChange={(open) => { if (!open) setExpandedDiagram(null); }} onOpenChangeComplete={(open) => { if (!open) Array.from(article.current?.querySelectorAll<HTMLButtonElement>("[data-diagram-key]") ?? []).find((button) => button.dataset.diagramKey === diagramTrigger.current)?.focus({ preventScroll: true }); }}>
        <Dialog size="xl" className="documentation-diagram-dialog">
          <div className="documentation-diagram-dialog-heading"><Dialog.Title>{expandedDiagram?.title ?? "Diagram"}</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close diagram" onClick={() => setExpandedDiagram(null)} /></div>
          <Dialog.Description className="documentation-diagram-dialog-description">{expandedDiagram?.caption}</Dialog.Description>
          <div className="documentation-diagram-expanded" tabIndex={0} role="region" aria-label="Expanded diagram, scroll horizontally if needed">{expandedDiagram && <img src={expandedDiagram.src} alt={expandedDiagram.alt} />}</div>
          <p className="documentation-diagram-dialog-hint">Scroll to explore the diagram. Press Escape to close.</p>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
