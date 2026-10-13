# Install from GitHub in your Cloudflare account

Gitflare's self-hosted core is MIT-licensed and published in a public GitHub repository. The native Cloudflare Deploy button starts installation from that repository into your own Cloudflare account. It does not connect the hosted Gitflare service or use Nexarq account resources.

[![Deploy Gitflare to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fnexarq-ai%2Fgitbraid)

The button provides the GitHub-based Worker deployment path; it does not deploy Gitflare's separate preview Worker. Configure and deploy that Worker separately after the main workspace is available. The first-admin, secret, and preview steps below are required for a usable installation. A fresh-account install through the button has not yet been verified end to end.

![Cloudflare deploys the GitHub source into your account; account-owned services and secrets are configured there, with preview deployed separately](gitflare-diagram:architecture)

## Before you start

- A Cloudflare account with access to Workers, Artifacts, Durable Objects, Workflows, and Containers, subject to your plan and account entitlements, plus a GitHub account that can access the public repository.
- Access to Cloudflare Artifacts and Containers. The published config names the Artifacts namespace `gitbraid`; Artifacts creates it when the first repository is created. The named runner is built from the included Dockerfile by Workers Builds in the Cloudflare account selected for deployment.
- An AI Gateway named `gitflare` in your account, with your own OpenAI provider credentials (BYOK), before running model-backed tasks. Gitflare routes runtime calls through that gateway; the default model is `openai/gpt-6-luna`, and `openai/gpt-6.1-sol` is the only other permitted runtime model when explicitly needed. A verified Cloudflare Email Sending sender is optional; configure your own `EMAIL_FROM` only if you want invitation emails.

## Deploy the main Worker

1. Select **Deploy to Cloudflare** above and authorize Cloudflare to access the public GitHub repository. Review the repository and deployment settings before confirming.
2. Choose your Cloudflare account and Worker name. The config declares Durable Objects for coordination and access state, a mission Workflow, and the `gitbraid` Artifacts namespace (created on first repository use). Cloudflare provisions OAuth KV storage automatically. Workers Builds uses the repository's Dockerfile to build the named Container in your account.
3. When prompted for `.dev.vars.example` values, generate two different random 64-character hexadecimal secrets: `SETUP_TOKEN` and `AUTH_ENCRYPTION_KEY`. The setup token authorizes the one-time initial administrator setup; the encryption key protects authentication state and must be backed up securely. Never use the same value for both.
4. Set up your own AI Gateway named `gitflare` with OpenAI provider credentials before running model-backed tasks. Configure `EMAIL_FROM` only if you have a verified sender and want invitation delivery.
5. Deploy the main Worker and retain its URL. The button deploys one Worker. Then deploy the preview Worker separately from `wrangler.preview.jsonc`, updating its service name if you changed the main Worker name. Set the main Worker's `PREVIEW_ORIGIN` to the new preview URL, then rebuild and redeploy the main Worker. Confirm that preview and main use distinct origins.

The repository also includes `.dev.vars.example` to show the local secret names. Keep real values in Cloudflare's secret manager or a protected local environment file. Never commit them, put them in an issue, or paste them into an AI prompt.

## Alternate local installer

If you prefer to configure the account from your terminal, download and verify the MIT source archive and manifest from Gitflare's Source view, extract it, then run the included Node.js 24 installer:

```sh
npm ci
node scripts/install-self-hosted.mjs
```

The installer uses your local Wrangler login, writes account-specific main and preview configurations, and lets you review them before deployment. It can create OAuth KV storage and build the runner image with Docker or use an image URI you provide. Do not use this path against an existing Worker: the installer rejects existing installations instead of rotating their keys. The installer and native button flows are both implemented, but fresh-account installation remains unverified.

![Your account owns the Worker, Artifacts namespace, AI Gateway, runner image, OAuth storage, email sender, and separate preview origin](gitflare-diagram:trust)

## Complete first sign-in

Open the main Worker URL and complete the protected administrator setup using the setup token, a name, email, workspace name, and a password of at least 12 characters. Enroll a TOTP authenticator, verify a current code, and save the one-time recovery codes securely. The bootstrap setup token cannot be reused after the first administrator is created. Then test sign-in, user creation or invitation, repository browsing, and MCP discovery. See [workspace administration](admin.md), [repository workflow](repositories.md), and [MCP setup](mcp.md).

This deployment path and its account-owned resource configuration are implemented, but a fresh installation through the native button remains unverified. A successful Worker deployment alone does not verify model inference, live repository execution, invitation email delivery, preview compatibility, or OAuth client behavior. Review billing, logging, backups, and account entitlements in your own Cloudflare account.
