import type { AppEnv } from './env';
import { ACCESS_LABELS, ACCESS_LEVELS, accessScope } from './client-access';
import { mcpClientGuides } from '../shared/mcp-clients';

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const UPDATED = 'October 15, 2026';

export const ROBOTS_TXT = 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mcp\nDisallow: /oauth/\n';

function supportContact(env: AppEnv, host: string): string {
  if (env.SUPPORT_EMAIL) return `<a href="mailto:${escape(env.SUPPORT_EMAIL)}">${escape(env.SUPPORT_EMAIL)}</a>`;
  return `<span class="placeholder">support@${escape(host)} [placeholder: the operator has not set SUPPORT_EMAIL yet]</span>`;
}

function operator(env: AppEnv): string {
  return env.OPERATOR_NAME ? escape(env.OPERATOR_NAME) : '<span class="placeholder">[operator legal name: set OPERATOR_NAME]</span>';
}

function document(title: string, description: string, body: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Gitflare</title><meta name="description" content="${escape(description)}"><link rel="icon" href="/favicon.svg"><style>:root{color-scheme:light dark;--bg:#f7f8fa;--fg:#1d2025;--muted:#555b65;--line:#e3e5e8;--card:#fff;--code:#f0f1f3;--accent:#c4621a}@media(prefers-color-scheme:dark){:root{--bg:#141518;--fg:#e8e9eb;--muted:#a3a8b0;--line:#2c2f35;--card:#1b1d21;--code:#24272c;--accent:#f0a05a}}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,sans-serif}header,main,footer{max-width:760px;margin:0 auto;padding:0 20px}header{display:flex;gap:16px;align-items:center;justify-content:space-between;padding-top:24px;flex-wrap:wrap}header a{color:inherit;text-decoration:none}header nav{display:flex;gap:16px;font-size:15px}header nav a{color:var(--muted)}.brand{display:flex;gap:10px;align-items:center;font-weight:650}.brand img{width:28px;height:28px}main{padding-bottom:40px}h1{font-size:32px;line-height:1.2;margin:36px 0 8px}h2{font-size:21px;margin:32px 0 8px}a{color:var(--accent)}p,li{color:var(--fg)}.lede{color:var(--muted)}pre,code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}code{padding:1px 5px}pre{padding:12px 14px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:15px}th,td{border-top:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}.placeholder{background:#fff3c4;color:#5c4400;border-radius:4px;padding:0 4px}footer{border-top:1px solid var(--line);padding-top:16px;padding-bottom:32px;color:var(--muted);font-size:14px}footer a{color:var(--muted);margin-right:14px}.clients{line-height:2}.label{font-size:13px;color:var(--muted);margin-top:6px}a.install{display:inline-block;padding:6px 14px;border-radius:6px;background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600}</style></head><body><header><a class="brand" href="/"><img src="/logo.svg" alt="">Gitflare</a><nav><a href="/connectors">Connect AI clients</a><a href="/docs/overview">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header><main>${body}</main><footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/connectors">Connectors</a><span>Last updated ${UPDATED}</span></footer></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function privacy(env: AppEnv, host: string): Response {
  return document('Privacy policy', 'What the hosted Gitflare service stores, where it runs, and how to have data deleted.', `<h1>Privacy policy</h1><p class="lede">This policy covers the hosted Gitflare service at <strong>${escape(host)}</strong>, operated by ${operator(env)}. Self-hosted installations are run by whoever deployed them and are not covered here.</p>
<h2>What Gitflare stores</h2><ul>
<li><strong>Account:</strong> your name, email address, a salted PBKDF2 password hash, authenticator (MFA) enrollment and recovery-code hashes, email verification state.</li>
<li><strong>Workspace:</strong> memberships, roles, teams, invitations, resource grants, task credentials (stored as hashes), sessions (stored as hashes) and an audit log of access actions.</li>
<li><strong>Code and work:</strong> Git repositories you create or import, proposals (missions) with their prompts, agent assignments, patches, check output and review comments, issues, releases and branch protection rules.</li>
<li><strong>Connections:</strong> OAuth client registrations and grants for AI clients such as Claude or ChatGPT, with the access level you chose. If you connect a Cloudflare account, its tokens are stored encrypted.</li>
<li><strong>Operational logs:</strong> request metadata (route, status, timing, error type) in Cloudflare Workers observability. Gitflare does not log request bodies, passwords or tokens.</li></ul>
<h2>Where it runs</h2><p>Gitflare runs entirely on Cloudflare: Workers and Durable Objects for the application and account data, Workers KV for OAuth records, Cloudflare Artifacts for Git storage, Containers for isolated agent runs and previews, and Cloudflare Email for verification, invitation and password-reset messages.</p>
<h2>AI model calls</h2><p>When you run an agent, draft a proposal or verify a model, Gitflare sends the relevant prompt, repository files and tool output to the model your workspace selected. Every model call goes through Cloudflare AI Gateway; the provider behind it (for example OpenAI, Anthropic or Workers AI) processes that content under its own terms. AI Gateway may keep request logs according to the gateway's logging settings. Workspace owners can turn AI features off; repositories, reviews and landing keep working without them.</p>
<h2>AI clients you connect</h2><p>When you connect Claude, ChatGPT, Codex or another MCP client, that client receives the results of the tools it calls, within the access level you approved and your workspace role. What the client does with that data is governed by its provider's policy. You can revoke a client at any time under Settings → Access → Account → Sessions; revoking ends its grant.</p>
<h2>What Gitflare does not do</h2><ul><li>No advertising, tracking pixels or third-party analytics.</li><li>No sale or sharing of your data for marketing.</li><li>No training of models on your code by Gitflare.</li></ul>
<h2>Cookies</h2><p>One HttpOnly session cookie keeps you signed in. Short-lived cookies bind an OAuth consent form to your browser. There are no advertising or analytics cookies.</p>
<h2>Retention and deletion</h2><p>Data stays until you delete it or ask for deletion. Expired sessions, invitations and tokens are pruned automatically. To export or delete your account, a workspace or its repositories, contact ${supportContact(env, host)}.</p>
<h2>Changes</h2><p>Material changes are announced on this page with a new date.</p>`);
}

function terms(env: AppEnv, host: string): Response {
  return document('Terms of service', 'Terms for using the hosted Gitflare service.', `<h1>Terms of service</h1><p class="lede">These terms apply to the hosted Gitflare service at <strong>${escape(host)}</strong>, operated by ${operator(env)}. The open-source edition is licensed separately under Apache-2.0.</p>
<h2>The service</h2><p>Gitflare hosts Git repositories and coordinates AI coding agents that propose changes in isolated sandboxes. Changes reach your default branch only after an authorized member approves the exact checked revision and lands it. Gitflare does not deploy your production systems.</p>
<h2>Your account</h2><p>Keep your password, authenticator and tokens private. You are responsible for actions taken with your credentials, including actions by AI clients you connect and the access level you grant them.</p>
<h2>Your content</h2><p>You keep all rights to the code and content you put in Gitflare. You grant the operator only the permissions needed to store, process and display it to run the service, including sending it to the AI model your workspace selected.</p>
<h2>Acceptable use</h2><ul><li>No malware, abuse of other systems, or attempts to break out of agent sandboxes.</li><li>No content you do not have the right to use.</li><li>No use that would make the operator break the law or a provider's terms.</li></ul>
<h2>AI output</h2><p>Agents can be wrong. Review diffs and check results before you approve and land a change. Passing checks are evidence, not a guarantee.</p>
<h2>Availability</h2><p>The service is provided as is, without warranties, and may change or be interrupted. Usage limits may apply to model calls and sandbox time.</p>
<h2>Ending use</h2><p>You can stop using Gitflare at any time and ask for deletion. The operator may suspend accounts that break these terms.</p>
<h2>Contact</h2><p>${supportContact(env, host)}</p>`);
}

function connectors(origin: string): Response {
  const endpoint = `${origin}/mcp`;
  const rows = ACCESS_LEVELS.map(level => `<tr><td><code>${accessScope(level)}</code></td><td><strong>${ACCESS_LABELS[level].title}</strong></td><td>${ACCESS_LABELS[level].detail}</td></tr>`).join('');
  const guides = mcpClientGuides(endpoint);
  const index = guides.map(guide => `<a href="#${guide.id}">${escape(guide.name)}</a>`).join(' · ');
  const sections = guides.map(guide => `<h2 id="${guide.id}">${escape(guide.name)}</h2><p>${escape(guide.summary)}</p>${guide.link ? `<p><a class="install" href="${escape(guide.link.href)}">${escape(guide.link.label)}</a></p>` : ''}<ol>${guide.steps.map(step => `<li>${escape(step.text)}${step.code ? `${step.label ? `<div class="label">${escape(step.label)}</div>` : ''}<pre>${escape(step.code)}</pre>` : ''}</li>`).join('')}</ol>${guide.note ? `<p class="lede">${escape(guide.note)}</p>` : ''}<p class="lede">Reference: <a href="${escape(guide.source)}" rel="noopener noreferrer">${escape(new URL(guide.source).host)}</a></p>`).join('\n');
  return document('Connect AI clients', 'Add Gitflare to Claude, Claude Code, Codex, ChatGPT, Cursor, VS Code, OpenCode, Windsurf, Zed or any MCP client through its remote MCP server.', `<h1>Connect AI clients</h1><p class="lede">Gitflare is a remote MCP server. Clients sign in with OAuth: you approve each connection in your browser and choose how much it may do.</p><p>Server URL:</p><pre>${escape(endpoint)}</pre><p class="clients">${index}</p>
${sections}
<h2>Access levels</h2><p>The consent screen offers these levels. Each includes the ones above it, and your workspace role still limits every action.</p><table><thead><tr><th>Scope</th><th>Level</th><th>Allows</th></tr></thead><tbody>${rows}</tbody></table>
<h2>How long a connection lasts</h2><p>Access tokens last one hour and refresh automatically. A connection lasts up to 30 days, then asks you to approve again. Revoke it any time under <strong>Settings → Access → Account → Sessions</strong>; revoking ends the client's grant immediately.</p>
<h2>Clients with fixed headers</h2><p>Clients that cannot use OAuth can send <code>Authorization: Bearer &lt;token&gt;</code> with a personal MCP token from Settings. Those tokens expire after eight hours. See the <a href="/docs/mcp">MCP guide</a>.</p>`);
}

export function publicPageResponse(request: Request, env: AppEnv): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.pathname === '/robots.txt') return new Response(ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  if (url.pathname === '/connectors') return connectors(url.origin);
  if (env.EDITION === 'self-hosted') return null;
  if (url.pathname === '/privacy') return privacy(env, url.host);
  if (url.pathname === '/terms') return terms(env, url.host);
  return null;
}
