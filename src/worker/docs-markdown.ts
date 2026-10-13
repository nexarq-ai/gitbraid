import type { DocMetadata, ProductDoc } from './docs';

const images = import.meta.glob<string>('../ui/assets/docs/*.svg', { query: '?raw', import: 'default', eager: true });

export function documentationImage(filename: string): Response {
  const content = /^[a-z-]+\.svg$/.test(filename) ? images[`../ui/assets/docs/${filename}`] : undefined;
  return content
    ? new Response(content, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })
    : Response.json({ error: 'Diagram not found' }, { status: 404 });
}

export function documentationMarkdown(document: ProductDoc, catalog: DocMetadata[], requestUrl: string, publicOnly: boolean): Response {
  const origin = new URL(requestUrl).origin;
  const prefix = publicOnly ? '/api/public/docs/' : '/api/docs/';
  const content = document.content
    .replace(/\(gitflare-diagram:([a-z-]+)\)/g, `(${origin}/api/public/docs/diagrams/$1.svg)`)
    .replace(/\]\(([^\s)]+\.md)(#[^\s)]*)?\)/g, (match, filename: string, fragment: string = '') => {
      const target = catalog.find((item) => item.filename === filename);
      return target ? `](${origin}${prefix}${target.id}.md${fragment})` : match;
    });
  return new Response(content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `inline; filename="${document.filename}"`, 'X-Content-Type-Options': 'nosniff' } });
}
