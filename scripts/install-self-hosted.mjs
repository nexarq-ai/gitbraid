import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const dryRun = process.argv.includes('--configure-only');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const command = (args, input, env = {}) => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], env: { ...process.env, ...env } });
  if (input !== undefined) child.stdin.end(input);
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? accept() : reject(new Error(`Wrangler exited with status ${code}`)));
});
const ask = async (label, fallback = '') => (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
const requireValue = (value, pattern, label) => { if (!pattern.test(value)) throw new Error(`Invalid ${label}`); return value; };

try {
  await access(wrangler);
  try { await access(resolve(root, '.gitflare-self-hosted-setup')); throw new Error('An installation setup file already exists. Use the existing installation; this installer will not rotate its authentication secrets.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Gitflare self-hosted installer. Configure a fresh directory and review your account before deployment.');
  if (!dryRun) {
    await command(['login']);
    await command(['whoami']);
  }
  const accountId = requireValue(await ask('Cloudflare account ID selected from the account list'), /^[a-f0-9]{32}$/, 'Cloudflare account ID');
  const name = requireValue(await ask('Unused dedicated new Worker name', 'gitbraid'), /^[a-z][a-z0-9-]{2,48}$/, 'Worker name');
  const namespace = requireValue(await ask('Your Artifacts namespace name', name), /^[a-z0-9][a-z0-9-]{1,62}$/, 'Artifacts namespace');
  const subdomain = requireValue(await ask('Your workers.dev subdomain'), /^[a-z0-9][a-z0-9-]{0,62}$/, 'workers.dev subdomain');
  const workspaceName = await ask('Workspace name', 'Gitbraid workspace');
  const config = JSON.parse(await readFile(resolve(root, 'distribution/wrangler.self-hosted.json'), 'utf8'));
  config.name = name;
  config.account_id = accountId;
  config.artifacts = [{ binding: 'ARTIFACTS', namespace }];
  config.vars.WORKSPACE_NAME = workspaceName;
  config.vars.PREVIEW_ORIGIN = `https://${name}-preview.${subdomain}.workers.dev`;
  config.workflows[0].name = `${name}-missions`;
  const image = await ask('Runner image URI in your account (leave blank to build with Docker)');
  if (image && (!image.startsWith(`registry.cloudflare.com/${accountId}/`) || !/@sha256:[a-f0-9]{64}$/.test(image))) throw new Error('Runner image must be digest-pinned in the selected account registry');
  config.containers = [{ name: `${name}-runner`, class_name: 'AgentSandbox', scheduling_policy: 'durable_object', images: { tools: image ? { image } : { dockerfile: './runner/Dockerfile' } } }];
  const kvId = await ask('Existing OAuth KV namespace ID (leave blank to create during deployment)');
  if (kvId) config.kv_namespaces = [{ binding: 'OAUTH_KV', id: requireValue(kvId, /^[a-f0-9]{32}$/, 'OAuth KV namespace ID') }];
  const sender = await ask('Your verified Email Sending sender (optional)');
  if (sender) {
    requireValue(sender, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email sender');
    config.vars.EMAIL_FROM = sender;
    config.send_email = [{ name: 'EMAIL', allowed_sender_addresses: [sender] }];
  }
  const preview = { '$schema': 'node_modules/wrangler/config-schema.json', name: `${name}-preview`, account_id: accountId, main: 'src/preview/index.ts', compatibility_date: '2026-10-12', workers_dev: true, services: [{ binding: 'GITFLARE', service: name, entrypoint: 'PreviewRelay' }], observability: { enabled: false } };
  await writeFile(resolve(root, 'wrangler.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(resolve(root, 'wrangler.preview.jsonc'), `${JSON.stringify(preview, null, 2)}\n`);
  console.log(`Configuration saved for account ${accountId}, Worker ${name}, namespace ${namespace}. Review wrangler.jsonc and wrangler.preview.jsonc.`);
  if (dryRun) { console.log('Configuration only: no resources or secrets were changed.'); }
  else if ((await ask('Create this NEW installation and deploy these resources? Type deploy')) === 'deploy') {
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [wrangler, 'secret', 'list', '--name', name, '--config', 'wrangler.jsonc'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let output = '';
      child.stdout.on('data', value => { output += value; });
      child.stderr.on('data', value => { output += value; });
      child.on('error', reject);
      child.on('exit', code => {
        if (code === 0) reject(new Error('That Worker already exists. Choose an unused dedicated name; existing installation secrets will not be overwritten.'));
        else if (/\b10007\b/.test(output)) accept();
        else reject(new Error('Could not verify that the Worker name is unused. Check Cloudflare account access and retry.'));
      });
    });
    if (!kvId) await command(['kv', 'namespace', 'create', `${name}-oauth`, '--binding', 'OAUTH_KV', '--update-config', '--config', 'wrangler.jsonc']);

    await command(['types', '--config', 'wrangler.jsonc']);
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? accept() : reject(new Error('Build failed')));
    });
    await command(['deploy']);
    await command(['deploy', '--config', 'wrangler.preview.jsonc']);
    const setupToken = randomBytes(32).toString('hex');
    await command(['secret', 'put', 'SETUP_TOKEN', '--name', name], setupToken);
    await command(['secret', 'put', 'AUTH_ENCRYPTION_KEY', '--name', name], randomBytes(32).toString('hex'));
    const secretFile = resolve(root, '.gitflare-self-hosted-setup');
    await writeFile(secretFile, `${setupToken}\n`, { mode: 0o600 });
    console.log(`Deployed https://${name}.${subdomain}.workers.dev. Complete administrator setup using the protected .gitflare-self-hosted-setup file. Store it securely; do not commit or share it. Verify login, MFA, email, preview and MCP in your own installation.`);
  } else console.log('Configuration retained; deployment was not run.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Installation failed');
  process.exitCode = 1;
} finally { terminal.close(); }
