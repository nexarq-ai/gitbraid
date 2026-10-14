import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { ArtifactsBinding } from '../src/worker/artifacts';

export interface GitPermission { name: string; remote: string; write: boolean }
export interface CommandResult { exitCode: number; stdout: string; stderr: string }
interface RunnerEnv { ARTIFACTS: ArtifactsBinding; RUNNER_IMAGE?: string }
interface OutboundProps { repositories: GitPermission[] }

const ca = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

export class GitOutbound extends WorkerEntrypoint<RunnerEnv, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const permission = this.ctx.props.repositories.find((repository) => {
      const remote = new URL(repository.remote);
      return url.protocol === 'https:' && url.origin === remote.origin && url.pathname.startsWith(`${remote.pathname}/`);
    });
    if (!permission) return new Response('Network destination is not allowed', { status: 403 });
    const suffix = url.pathname.slice(new URL(permission.remote).pathname.length);
    const service = url.searchParams.get('service');
    const isRead = (suffix === '/info/refs' && service === 'git-upload-pack') || suffix === '/git-upload-pack';
    const isWrite = (suffix === '/info/refs' && service === 'git-receive-pack') || suffix === '/git-receive-pack';
    if ((!isRead && !isWrite) || (isWrite && !permission.write)) return new Response('Git operation is not allowed', { status: 403 });
    using repository = await this.env.ARTIFACTS.get(permission.name);
    const token = await repository.createToken(isWrite ? 'write' : 'read', 60);
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.set('authorization', `Bearer ${token.plaintext}`);
    return fetch(new Request(request, { headers, redirect: 'manual' }));
  }
}

export class BootstrapOutbound extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const allowed = request.method === 'GET' && (
      (url.hostname === 'deb.debian.org' && /^\/debian\/(dists\/trixie(?:-updates)?\/|pool\/)/.test(url.pathname)) ||
      (['deb.debian.org', 'security.debian.org'].includes(url.hostname) && /^\/debian-security\/(dists\/trixie-security\/|pool\/)/.test(url.pathname))
    );
    if (!allowed) return new Response('Bootstrap destination is not allowed', { status: 403 });
    url.protocol = 'https:';
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return new Response('Bootstrap upstream redirects are not allowed', { status: 502 });
      }
      console.info('runner.bootstrap.fetch', url.hostname, url.pathname, response.status);
      return response;
    } catch (error) {
      console.error('runner.bootstrap.fetch.failed', url.hostname, url.pathname, error instanceof Error ? error.message : 'Unknown fetch error');
      return new Response('Bootstrap upstream fetch failed', { status: 502 });
    }
  }
}

export function isRegistryRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (request.method === 'GET' || request.method === 'HEAD') && url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.username && !url.password;
}

export class RegistryOutbound extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    if (!isRegistryRequest(request)) return new Response('Install destination is not allowed', { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    const response = await fetch(new Request(request, { headers, redirect: 'manual' }));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response('Install upstream redirects are not allowed', { status: 502 });
    }
    return response;
  }
}

export class AgentSandbox extends DurableObject<RunnerEnv> {
  #repositories: GitPermission[] | undefined;

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(600_000));
  }

  async prepare(repositories: GitPermission[]): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error('Container binding is not configured');
    if (container.running) await container.destroy();
    const image = container.images?.tools ?? this.env.RUNNER_IMAGE ?? 'cloudflare/debian-trixie';
    container.start({ image, instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    let stage = 'container startup';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = container.monitor().then(() => { throw new Error('Container stopped before runner preparation completed'); });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Runner preparation exceeded its execution deadline')), image === 'cloudflare/debian-trixie' ? 600_000 : 120_000);
    });
    try {
      await Promise.race([(async () => {
        await container.setInactivityTimeout(600_000);
        if (image === 'cloudflare/debian-trixie') {
          stage = 'package bootstrap';
          const bootstrap = this.ctx.exports.BootstrapOutbound;
          await container.interceptAllOutboundHttp(bootstrap);
          await container.interceptOutboundHttps('*', bootstrap);
          const aptOptions = '-o Dir::Etc::sourcelist=/tmp/gitflare-sources.list -o Dir::Etc::sourceparts=- -o Acquire::Retries=0 -o Acquire::https::Timeout=15 -o Acquire::https::CaInfo=/etc/cloudflare/certs/cloudflare-containers-ca.crt';
          await this.#bootstrapCommand('package index', `printf '%s\n' 'deb https://deb.debian.org/debian trixie main' 'deb https://deb.debian.org/debian trixie-updates main' 'deb https://deb.debian.org/debian-security trixie-security main' > /tmp/gitflare-sources.list; apt-get ${aptOptions} -o APT::Update::Error-Mode=any update`);
          await this.#bootstrapCommand('package installation', `DEBIAN_FRONTEND=noninteractive apt-get ${aptOptions} install -y --no-install-recommends git ca-certificates ripgrep coreutils && mkdir -p /workspace`, 300_000);
        }
        stage = 'Git network isolation';
        await this.#restrictToGit(repositories);
        this.#repositories = repositories;
        stage = 'tool and certificate readiness';
        const readiness = await this.#executeCommand(['/bin/sh', '-c', 'mkdir -p /workspace && command -v node && command -v git && command -v bash && command -v timeout && test -r /etc/cloudflare/certs/cloudflare-containers-ca.crt'], '/', 15_000, 15_000);
        if (readiness.exitCode !== 0) throw new Error(`Runner tools or interception certificate are unavailable (exit ${readiness.exitCode})`);
      })(), stopped, deadline]);
    } catch (error) {
      try { await container.destroy(); } catch { console.error('runner.preparation.cleanup.failed'); }
      const exitCode = error && typeof error === 'object' && 'exitCode' in error ? ` (exit ${error.exitCode})` : '';
      throw new Error(`Runner preparation failed during ${stage}${exitCode}: ${error instanceof Error ? error.message : 'Unknown container error'}`);
    } finally { clearTimeout(timer); }
  }

  async #restrictToGit(repositories: GitPermission[]): Promise<void> {
    const container = this.ctx.container!;
    const outbound = this.ctx.exports.GitOutbound({ props: { repositories } });
    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps('*', outbound);
  }

  async install(mode: 'ci' | 'install' = 'ci'): Promise<CommandResult> {
    const container = this.ctx.container;
    const repositories = this.#repositories;
    if (!container?.running || !repositories) throw new Error('Sandbox is not prepared');
    const excluded = await this.#executeCommand(['/bin/sh', '-c', "printf '\\nnode_modules/\\n' >> .git/info/exclude"], '/workspace/repo', 15_000, 15_000);
    if (excluded.exitCode !== 0) throw new Error('Installed dependencies could not be excluded from candidate commits');
    const registry = this.ctx.exports.RegistryOutbound;
    await container.interceptAllOutboundHttp(registry);
    await container.interceptOutboundHttps('*', registry);
    try {
      // --ignore-scripts: package lifecycle scripts must not run while the registry is reachable
      return await this.#executeCommand(['npm', mode, '--ignore-scripts', '--no-audit', '--no-fund'], '/workspace/repo', 300_000, 300_000);
    } finally { await this.#restrictToGit(repositories); }
  }

  async #bootstrapCommand(stage: string, script: string, timeoutMs = 120_000): Promise<void> {
    console.info('runner.bootstrap.stage', stage, 'started');
    const result = await this.#executeCommand(['/bin/sh', '-c', script], '/', timeoutMs, 300_000);
    console.info('runner.bootstrap.stage', stage, 'completed', result.exitCode);
    if (result.exitCode !== 0) throw new Error(`Runner bootstrap ${stage} failed (exit ${result.exitCode}): ${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  }

  async command(argv: string[], cwd = '/workspace', timeoutMs = 60_000): Promise<CommandResult> {
    return this.#executeCommand(argv, cwd, timeoutMs, 120_000);
  }

  async check(script: string, timeoutMs: number): Promise<CommandResult> {
    return this.#executeCommand(['/bin/bash', '-lc', script], '/workspace/repo', timeoutMs, 300_000);
  }

  async #executeCommand(argv: string[], cwd: string, timeoutMs: number, maximumMs: number): Promise<CommandResult> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error('Sandbox is not running');
    const seconds = Math.max(1, Math.min(maximumMs, Math.floor(timeoutMs))) / 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Sandbox command exceeded its execution deadline'));
        void Promise.resolve().then(() => container.destroy()).catch(() => { console.error('runner.command.timeout.cleanup.failed'); });
      }, seconds * 1000 + 2500);
    });
    const cap = 65_536;
    const collect = async (stream: ReadableStream | null): Promise<string> => {
      if (!stream) return '';
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (bytes < cap) chunks.push(next.value.slice(0, cap - bytes));
        bytes += next.value.byteLength;
      }
      const merged = new Uint8Array(Math.min(bytes, cap));
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(merged) + (bytes > cap ? '\n[output truncated]' : '');
    };
    const execution = (async () => {
      const process = await container.exec(['timeout', '--kill-after=2s', `${seconds}s`, ...argv], {
        cwd,
        env: { GIT_SSL_CAINFO: ca, NODE_EXTRA_CA_CERTS: ca, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      const [stdout, stderr, exitCode] = await Promise.all([collect(process.stdout), collect(process.stderr), process.exitCode]);
      return { stdout, stderr, exitCode };
    })();
    try { return await Promise.race([execution, timeout]); }
    finally { clearTimeout(timer); }
  }

  async startPreview(command = 'node src/preview.mjs'): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error('Preview container is not running');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Preview did not become HTTP-ready within 15 seconds'));
      }, 15_000);
    });
    try {
      const process = await Promise.race([
        container.exec(['/bin/bash', '-lc', `exec ${command}`], { cwd: '/workspace/repo', env: { PORT: '8080', HOST: '0.0.0.0' }, stdout: 'ignore', stderr: 'ignore' }),
        timeout,
      ]);
      const exited = process.exitCode.then((code) => { throw new Error(`Preview process exited before readiness (exit ${code})`); });
      const port = container.getTcpPort(8080);
      for (;;) {
        const response = await Promise.race([
          port.fetch(new Request('http://preview.internal/', { signal: controller.signal, redirect: 'manual' })).catch(() => null),
          exited,
          timeout,
        ]);
        if (response) {
          await Promise.race([response.body?.cancel(), exited, timeout]);
          if (response.ok) return;
        }
        await Promise.race([new Promise((resolve) => { retryTimer = setTimeout(resolve, 250); }), exited, timeout]);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      controller.abort();
    }
  }

  async preview(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container?.running) return new Response('Preview has expired', { status: 410 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    return container.getTcpPort(8080).fetch(new Request(`http://preview.internal${url.pathname}${url.search}`, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  }

  async destroy(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}
