import { detectPackageManager, hasInstallableDependencies, runnerFor, runScript, type InstallPlan } from './package-manager';

export const LEGACY_PREVIEW = 'node src/preview.mjs';

export interface PreviewPlan {
  argv: string[];
  install: InstallPlan | null;
  readinessMs: number;
  description: string;
}

// Runs inside the preview container; serves files under one root and lists directories without an index page
export const STATIC_SERVER = `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[1]||'.');const port=Number(process.env.PORT||8080);
const types={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.woff2':'font/woff2','.wasm':'application/wasm'};
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
http.createServer((req,res)=>{let rel;try{rel=decodeURIComponent(new URL(req.url,'http://preview').pathname)}catch{res.writeHead(400).end();return}
const file=path.join(root,rel);if(!(file===root||file.startsWith(root+path.sep))||file.split(path.sep).includes('.git')){res.writeHead(404).end('Not found');return}
fs.stat(file,(error,stat)=>{if(error){res.writeHead(404,{'content-type':'text/plain'}).end('Not found');return}
if(stat.isDirectory()){const index=path.join(file,'index.html');if(fs.existsSync(index)){res.writeHead(200,{'content-type':types['.html']});fs.createReadStream(index).pipe(res);return}
const names=fs.readdirSync(file,{withFileTypes:true}).filter(e=>e.name!=='.git'&&e.name!=='node_modules').map(e=>e.name+(e.isDirectory()?'/':'')).sort();const base=rel.endsWith('/')?rel:rel+'/';
res.writeHead(200,{'content-type':types['.html']}).end('<!doctype html><meta charset="utf-8"><title>'+esc(base)+'</title><body style="font:14px system-ui;margin:32px"><h1 style="font-size:18px">'+esc(base)+'</h1><ul>'+names.map(n=>'<li><a href="'+esc(base+n)+'">'+esc(n)+'</a></li>').join('')+'</ul>');return}
res.writeHead(200,{'content-type':types[path.extname(file).toLowerCase()]||'application/octet-stream'});fs.createReadStream(file).pipe(res)})}).listen(port,'0.0.0.0');`;

function scripts(packageJson: string | null): Record<string, string> {
  if (packageJson === null) return {};
  try {
    const value = (JSON.parse(packageJson) as { scripts?: unknown }).scripts;
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1].trim()));
  } catch { return {}; }
}

function shell(command: string): string[] {
  return ['/bin/bash', '-lc', command];
}

const LISTEN = ['--host', '0.0.0.0', '--port', '8080'];

export function previewPlan(files: string[], packageJson: string | null, configured: { command?: string; install?: InstallPlan | null } = {}, lockHead: string | null = null): PreviewPlan {
  if (configured.command && configured.command !== LEGACY_PREVIEW) return { argv: shell(`exec ${configured.command}`), install: configured.install ?? null, readinessMs: 90_000, description: `the configured preview command (${configured.command})` };
  if (files.includes('src/preview.mjs')) return { argv: ['node', 'src/preview.mjs'], install: configured.install ?? null, readinessMs: 15_000, description: 'src/preview.mjs' };
  const available = scripts(packageJson);
  const detected = detectPackageManager({ files, packageJson, lockHead });
  const install = hasInstallableDependencies(files, packageJson) ? detected : null;
  const pm = runnerFor(detected);
  if (available.start) return { argv: shell(`exec ${pm} start`), install, readinessMs: 90_000, description: `${pm} start` };
  if (available.build && available.preview) return { argv: shell(`${runScript(pm, 'build')} && exec ${runScript(pm, 'preview', LISTEN)}`), install, readinessMs: 180_000, description: `${pm} run build, then ${pm} run preview` };
  if (available.dev) return { argv: shell(`exec ${runScript(pm, 'dev', LISTEN)}`), install, readinessMs: 120_000, description: `${pm} run dev` };
  const root = ['dist', 'build', 'public', 'site', 'docs'].find((dir) => files.includes(`${dir}/index.html`)) ?? '.';
  return { argv: ['node', '-e', STATIC_SERVER, root], install: null, readinessMs: 15_000, description: root === '.' ? 'the repository files as a static site' : `${root}/ as a static site` };
}

export type PreviewKind = 'worker' | 'container';
export interface WorkerProjectShape { main?: string }

export function hasWorkerConfig(files: string[]): boolean {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((name) => files.includes(name));
}

export function classifyPreview(files: string[], config: WorkerProjectShape | null, options: { workerPreviews: boolean; configuredCommand?: string }): PreviewKind {
  if (!options.workerPreviews || (options.configuredCommand && options.configuredCommand !== LEGACY_PREVIEW)) return 'container';
  return hasWorkerConfig(files) && !!config?.main ? 'worker' : 'container';
}

function dependsOn(packageJson: string | null, name: string): boolean {
  if (packageJson === null) return false;
  try {
    const manifest = JSON.parse(packageJson) as Record<string, unknown>;
    return ['dependencies', 'devDependencies'].some((field) => { const value = manifest[field]; return !!value && typeof value === 'object' && name in value; });
  } catch { return false; }
}

export function workerPreviewBuildCommand(files: string[], packageJson: string | null, assetsDirectory: string | null | undefined, install: InstallPlan | null): string | null {
  if (!scripts(packageJson).build) return null;
  const directory = assetsDirectory?.replace(/\/+$/, '');
  const untrackedAssets = !!directory && directory !== '.' && !files.some((file) => file.startsWith(`${directory}/`));
  return dependsOn(packageJson, '@cloudflare/vite-plugin') || untrackedAssets ? runScript(runnerFor(install), 'build') : null;
}
