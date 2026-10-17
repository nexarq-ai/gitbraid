import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { deploySelfHosted } from './deploy-self-hosted.mjs';

const root = resolve(import.meta.dirname, '..');
let hide = false;
const output = new Writable({ write(chunk, _encoding, callback) { if (!hide) process.stdout.write(chunk); callback(); } });
const terminal = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
const configureOnly = process.argv.includes('--configure-only');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const command = args => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? accept() : reject(new Error('Cloudflare authentication failed.')));
});
const ask = async (label, fallback = '') => (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
const requireValue = (value, pattern, label) => { if (!pattern.test(value)) throw new Error(`Invalid ${label}`); return value; };
try {
  await access(wrangler);
  console.log('Gitflare (self-hosted) installer. Select your own Cloudflare account and dedicated Worker name. Provisioning requires AI Gateway and Artifacts permissions; provider BYOK stays in Cloudflare dashboard.');
  if (!configureOnly) { await command(['login']); await command(['whoami']); }
  const accountId = requireValue(await ask('Your selected Cloudflare account ID'), /^[a-f0-9]{32}$/, 'account ID');
  const name = requireValue(await ask('Dedicated Worker name', 'gitflare'), /^[a-z][a-z0-9-]{2,48}$/, 'Worker name');
  const config = JSON.parse(await readFile(resolve(root, 'distribution/wrangler.self-hosted.json'), 'utf8'));
  config.account_id = accountId;
  config.name = name;
  config.vars.WORKSPACE_NAME = await ask('Workspace name', 'Gitflare workspace');
  config.artifacts = [{ binding: 'ARTIFACTS', namespace: requireValue(await ask('Your Artifacts namespace name', name), /^[a-z0-9][a-z0-9._-]{0,63}$/, 'namespace') }];
  const sender = await ask('Your verified Email Sending sender (optional)');
  if (sender) { requireValue(sender, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'sender'); config.vars.EMAIL_FROM = sender; config.send_email = [{ name: 'EMAIL', allowed_sender_addresses: [sender] }]; }
  await writeFile(resolve(root, 'wrangler.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
  if (configureOnly) console.log('Configuration saved. No account resources or secrets were changed.');
  else {
    const email = requireValue(await ask('Initial administrator email'), /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'administrator email');
    process.stdout.write('Initial administrator password (at least 12 characters): ');
    hide = true;
    let password;
    try { password = await terminal.question(''); } finally { hide = false; process.stdout.write('\n'); }
    if (password.trim().length < 12) throw new Error('Administrator password must contain at least 12 characters.');
    if ((await ask('Provision and deploy this selected account? Type deploy')) === 'deploy') {
      process.env.ADMIN_EMAIL = email;
      process.env.ADMIN_PASSWORD = password;
      process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
      await deploySelfHosted();
      delete process.env.ADMIN_PASSWORD;
    } else console.log('Configuration retained; no deployment ran.');
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Installation failed'); process.exitCode = 1; }
finally { hide = false; terminal.close(); }
