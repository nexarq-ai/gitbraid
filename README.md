# Gitbraid

Single-workspace Git collaboration on Cloudflare Workers, sharing the Gitflare core.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nexarq-ai/gitbraid)

The native button clones this public repository into your GitHub account and deploys to the Cloudflare account you select. Supply your initial ADMIN_EMAIL and a strong ADMIN_PASSWORD of at least 12 characters. Sign in with them and enroll MFA. Deployment generates the MFA encryption key once and preserves it on subsequent deployments; no setup token is required.

The deployment helper creates or reuses the AI Gateway and Artifacts namespace, derives the preview origin from your account, and deploys both application and preview Workers. Wrangler provisions OAuth KV, Durable Objects, Containers and Workflow; Workers Builds builds the runner Dockerfile in your selected account. The build credential needs AI Gateway Read/Write and Artifacts Read/Edit in addition to Workers, Containers, Workflows and KV permissions. Configure those permissions in Cloudflare dashboard under the Worker’s Settings → Builds before deployment. The default build credential may lack them; deployment fails clearly without bypassing permissions. Configure provider BYOK credentials or Unified Billing in AI Gateway, then enable compatible Gateway models or supported Workers AI in workspace AI models settings before execution. Email requires your own verified sender and binding.

The native button flow is prepared but a fresh-account deployment has not been verified. See the install guide for prerequisites and verification limits.

Read `docs/public/install.md`, run `npm ci`, then `node scripts/install-self-hosted.mjs`. Account resources, secrets and sender belong to the installer. Complete protected administrator setup and MFA before creating users. Hosted homepage, platform administration and hosted agent enrollment are excluded.

Current live limits are recorded in `docs/public/overview.md` and `docs/public/agents.md`. This self-hosted edition is distributed under the MIT License; see LICENSE. Hosted extensions are outside this package.
