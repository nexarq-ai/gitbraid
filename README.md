# Gitbraid

Single-workspace Git collaboration on Cloudflare Workers, sharing the Gitflare core.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nexarq-ai/gitbraid)

The native button clones this public repository into your GitHub account and deploys to the Cloudflare account you select. Supply two DIFFERENT random 64-character hexadecimal secrets: SETUP_TOKEN and AUTH_ENCRYPTION_KEY. Save the setup token privately; use it to create the administrator and enroll MFA. Empty or invalid secrets cannot complete setup.

Wrangler provisions the OAuth KV binding, Durable Objects and Workflow. Workers Builds builds the runner Dockerfile in your selected account. Artifacts access and Container entitlement are required; the Artifacts namespace is created with your first repository. Configure AI Gateway gitflare with your own OpenAI BYOK before execution. Email requires your own verified sender and binding. The separate preview Worker needs a post-install deployment; this button does not deploy both Workers.

The native button flow is prepared but a fresh-account deployment has not been verified. See the install guide for prerequisites and verification limits.

Read `docs/public/install.md`, run `npm ci`, then `node scripts/install-self-hosted.mjs`. Account resources, secrets and sender belong to the installer. Complete protected administrator setup and MFA before creating users. Hosted homepage, platform administration and hosted agent enrollment are excluded.

Current live limits are recorded in `docs/public/overview.md` and `docs/public/agents.md`. This self-hosted edition is distributed under the MIT License; see LICENSE. Hosted extensions are outside this package.
