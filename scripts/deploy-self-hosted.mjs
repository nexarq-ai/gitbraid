import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const INSTALLATION = { marker: 'GITFLARE_INSTALLATION', value: 'gitflare', primary: 'GITFLARE_PRIMARY_WORKER' };
const DEPRECATED_INSTALLATION = { marker: 'GITBRAID_INSTALLATION', value: 'gitbraid', primary: 'GITBRAID_PRIMARY_WORKER' };
const permissionHelp = 'In Cloudflare dashboard, select the deployment API token under Workers → Settings → Builds and grant AI Gateway Read/Write and Artifacts Read/Edit for the selected account, alongside the Workers, Containers, Workflows and KV permissions. Never paste this build credential into the application.';

export class ProvisioningError extends Error {
  constructor(status, operation) { super(`${operation} failed (HTTP ${status}). ${status === 401 || status === 403 ? permissionHelp : 'Check account access and resource availability; no provider credential is substituted.'}`); this.status = status; }
}

export function deploymentConfiguration(input, accountId, subdomain, overrideName) {
  const config = structuredClone(input);
  const name = overrideName || config.name;
  if (typeof accountId !== 'string' || typeof name !== 'string' || typeof subdomain !== 'string' || !/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z][a-z0-9-]{2,48}$/.test(name) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)) throw new Error('Select a valid Cloudflare account, dedicated Worker name and workers.dev subdomain.');
  if (config.vars?.EDITION !== 'self-hosted') throw new Error('This deploy helper accepts only the self-hosted edition.');
  config.account_id = accountId;
  config.name = name;
  config.vars.PREVIEW_ORIGIN = `https://${name}-preview.${subdomain}.workers.dev`;
  delete config.vars[DEPRECATED_INSTALLATION.marker];
  delete config.vars[DEPRECATED_INSTALLATION.primary];
  config.vars[INSTALLATION.marker] = INSTALLATION.value;
  config.vars[INSTALLATION.primary] = name;
  config.vars.PREVIEWS_ACCOUNT_ID = accountId;
  config.vars.PREVIEWS_WORKER_NAME = previewsWorkerName(name);
  for (const workflow of config.workflows ?? []) workflow.name = `${name}-missions`;
  for (const container of config.containers ?? []) container.name = `${name}-runner`;
  for (const binding of config.artifacts ?? []) if ([INSTALLATION.value, DEPRECATED_INSTALLATION.value].includes(binding.namespace)) binding.namespace = name;
  const preview = { '$schema': 'node_modules/wrangler/config-schema.json', name: `${name}-preview`, account_id: accountId, main: 'src/preview/index.ts', compatibility_date: config.compatibility_date, workers_dev: true, services: [{ binding: 'GITFLARE', service: name, entrypoint: 'PreviewRelay' }], vars: { [INSTALLATION.marker]: INSTALLATION.value, [INSTALLATION.primary]: name }, observability: { enabled: false } };
  return { config, preview };
}

export function previewsWorkerName(name) {
  return `${name}-previews`.length <= 40 ? `${name}-previews` : `${name.slice(0, 37)}-pv`;
}

export async function ensurePreviewsWorker(api, workerName) {
  if (await api('GET', `/workers/workers/${workerName}`, undefined, true)) return false;
  await api('POST', '/workers/workers', { name: workerName, subdomain: { enabled: true, previews_enabled: true } });
  return true;
}

export function installerPreviewsToken(env = process.env) {
  return (env.GITFLARE_CLOUDFLARE_TOKEN || env.GITBRAID_CLOUDFLARE_TOKEN || env.GITBRAID_PREVIEWS_API_TOKEN || '').trim() || undefined;
}

export async function checkInstallerToken(token, accountId, workerName, fetcher = fetch) {
  const get = async (path) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const envelope = await response.json().catch(() => null);
    return response.ok && envelope?.success !== false;
  };
  if (!await get(`/workers/workers/${workerName}/previews`)) throw new Error(`GITFLARE_CLOUDFLARE_TOKEN cannot manage Worker Previews on ${workerName}. Create it with Workers Scripts: Edit and D1: Edit on this account, or leave it unset and paste a token in Settings → Cloudflare after signing in.`);
  return { d1: await get('/d1/database?per_page=1') };
}

export async function ensurePreviewsToken(api, worker, token) {
  if (!token) return false;
  await api('PUT', `/workers/scripts/${worker}/secrets`, { name: 'PREVIEWS_API_TOKEN', type: 'secret_text', text: token });
  return true;
}

export async function preflightDeployment(api, name, gatewayId, namespace) {
  if ((gatewayId !== null && (typeof gatewayId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(gatewayId))) || typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(namespace)) throw new Error('Invalid gateway or Artifacts namespace name.');
  const gateway = gatewayId === null ? true : await api('GET', `/ai-gateway/gateways/${gatewayId}`, undefined, true);
  const artifact = await api('GET', `/artifacts/namespaces/${namespace}`, undefined, true);
  const settings = await api('GET', `/workers/scripts/${name}/settings`, undefined, true);
  const preview = await api('GET', `/workers/scripts/${name}-preview/settings`, undefined, true);
  for (const existing of [settings, preview]) {
    if (!existing) continue;
    const vars = Object.fromEntries((existing.bindings ?? []).filter(binding => binding.type === 'plain_text').map(binding => [binding.name, binding.text]));
    if (![INSTALLATION, DEPRECATED_INSTALLATION].some(owner => vars[owner.marker] === owner.value && vars[owner.primary] === name)) throw new Error('A selected Worker name already belongs to another application. Choose an unused dedicated name; it will not be overwritten.');
  }
  return { gatewayExists: !!gateway, namespaceExists: !!artifact, encryptionKeyExists: (settings?.bindings ?? []).some(binding => binding.type === 'secret_text' && binding.name === 'AUTH_ENCRYPTION_KEY') };
}

export async function ensureResources(api, plan, gatewayId, namespace) {
  if (!plan.gatewayExists) await api('POST', '/ai-gateway/gateways', { id: gatewayId, cache_invalidate_on_update: false, cache_ttl: 0, collect_logs: false, rate_limiting_interval: 60, rate_limiting_limit: 60, authentication: true, byok_only: true });
  if (!plan.namespaceExists) await api('POST', '/artifacts/namespaces', { namespace });
}

export async function ensureEncryptionKey(api, worker, existing, generate = () => randomBytes(32).toString('hex')) {
  if (existing) return false;
  const current = await api('GET', `/workers/scripts/${worker}/secrets`);
  if ((current ?? []).some(secret => secret.name === 'AUTH_ENCRYPTION_KEY')) return false;
  await api('PUT', `/workers/scripts/${worker}/secrets`, { name: 'AUTH_ENCRYPTION_KEY', type: 'secret_text', text: generate() });
  return true;
}

function run(args, { capture = false, env = {}, input } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let output = '';
    if (capture) child.stdout.on('data', value => { output += value; });
    if (capture) child.stderr.on('data', () => {});
    if (input !== undefined) child.stdin.end(input);
    child.on('error', () => reject(new Error('Deployment command could not start.')));
    child.on('exit', code => code === 0 ? accept(output) : reject(new Error(`Deployment command failed (${code}). Inspect Cloudflare build diagnostics; secret values are not printed by this helper.`)));
  });
}

export async function deploySelfHosted() {
  const source = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || source.account_id;
  if (!accountId) {
    const identity = JSON.parse(await run([wrangler, 'whoami', '--json'], { capture: true }));
    const accounts = identity.accounts ?? [];
    if (accounts.length !== 1) throw new Error('Select your Cloudflare account in the deployment configuration or set CLOUDFLARE_ACCOUNT_ID locally.');
    accountId = accounts[0].id;
  }
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const credentials = JSON.parse(await run([wrangler, 'auth', 'token', '--json'], { capture: true }));
    if (credentials.type !== 'oauth' && credentials.type !== 'api_token') throw new Error('Cloudflare Bearer authentication is required; authenticate Wrangler or use the account-scoped build credential.');
    token = credentials.token;
  }
  if (!token) throw new Error('Cloudflare authentication is unavailable.');
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Invalid selected account ID.');
  const api = async (method, path, body, allowMissing = false) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (allowMissing && response.status === 404) return null;
    const envelope = await response.json().catch(() => null);
    if (!response.ok || !envelope?.success) throw new ProvisioningError(response.status, `${method} ${path}`);
    return envelope.result;
  };
  const subdomain = await api('GET', '/workers/subdomain');
  const { config, preview } = deploymentConfiguration(source, accountId, subdomain?.subdomain, process.env.WRANGLER_CI_OVERRIDE_NAME);
  const gateway = config.vars.AI_FEATURES === 'disabled' ? null : config.vars.AI_GATEWAY_ID;
  const namespace = config.artifacts?.find(binding => binding.binding === 'ARTIFACTS')?.namespace;
  const plan = await preflightDeployment(api, config.name, gateway, namespace);
  await ensureResources(api, plan, gateway, namespace);
  await writeFile(resolve(root, 'wrangler.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(resolve(root, 'wrangler.preview.jsonc'), `${JSON.stringify(preview, null, 2)}\n`);
  const authEnv = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token };
  await run([resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], { env: authEnv });
  await run([wrangler, 'deploy'], { env: authEnv });
  await ensureEncryptionKey(api, config.name, plan.encryptionKeyExists);
  await ensurePreviewsWorker(api, config.vars.PREVIEWS_WORKER_NAME);
  const installerToken = installerPreviewsToken();
  const installerAccess = installerToken ? await checkInstallerToken(installerToken, accountId, config.vars.PREVIEWS_WORKER_NAME).catch(error => { console.error(error.message); return null; }) : null;
  const previewsToken = await ensurePreviewsToken(api, config.name, installerAccess ? installerToken : undefined);
  for (const secret of ['ADMIN_EMAIL', 'ADMIN_PASSWORD']) if (process.env[secret]) await api('PUT', `/workers/scripts/${config.name}/secrets`, { name: secret, type: 'secret_text', text: process.env[secret] });
  const previewEnv = { ...authEnv, WRANGLER_CI_OVERRIDE_NAME: preview.name };
  await run([wrangler, 'deploy', '--config', 'wrangler.preview.jsonc', '--name', preview.name], { env: previewEnv });
  if (!previewsToken) console.log('Worker Previews are off until an Owner opens Settings → Cloudflare after signing in and pastes an API token; the card opens Cloudflare with Workers Scripts: Edit and D1: Edit prefilled. No terminal step is needed.');
  else if (!installerAccess?.d1) console.log('Worker Previews are on. The token cannot manage D1, so previews of apps that bind D1 fail until an Owner replaces it in Settings → Cloudflare.');
  console.log(`Deployed ${config.name} and ${preview.name} in the selected account. Sign in with the administrator credentials configured during deployment, then enroll MFA. Configure your provider BYOK inside Cloudflare AI Gateway before executing agents.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) deploySelfHosted().catch(error => { console.error(error instanceof Error ? error.message : 'Deployment failed'); process.exitCode = 1; });
