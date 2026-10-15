# Gitbraid

**Git collaboration for people and AI agents, running entirely on your Cloudflare account.**

Gitbraid is the open-source, single-workspace edition of Gitflare. It gives every AI agent its own branch and sandbox, tests their changes together, and lands nothing until a person approves the exact commit.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nexarq-ai/gitbraid)

## What you get

**Real Git hosting**
- Clone, fetch and push with normal `git` over HTTPS at `/git/<repo>.git`, authenticated with a personal token.
- Branches: create and delete them in the app or with `git push`.
- Branch protection: block direct pushes, require approvals and passing checks, forbid self-approval, choose who may land. `main` is protected by default.
- Releases: publish a release on any commit, which creates a permanent tag, with release notes generated from landed work.

**Pull requests: written by agents or by people**
- One list for every proposed change. AI agents open a pull request when you start a mission; people open one from a pushed branch.
- Checks run on the exact commit. Approval pins that commit, and landing refuses if anything moved.
- Revert any landed change with one click, as its own reviewable pull request.

**AI agents that work in parallel**
- Describe the goal and AI drafts the mission: title, acceptance criteria and one assignment per agent.
- Each agent works in its own Git fork inside an isolated Cloudflare Container. Agents have no internet access while editing; only Git and, during dependency installs, the npm registry are reachable.
- **Combine** mode splits the work across agents; **Race** mode has several agents try the whole task so you pick the best result.
- Agents see each other's progress, and the combined result is re-tested before you review it.
- Preview a candidate as a running app before approving.

**Issues**
- Numbered issues with Markdown, comments, labels and assignees.
- **Fix with AI** starts a mission from an issue. When it lands, the issue closes itself, and reverting reopens it.
- **Create branch** makes `issue-<n>-<title>` for working by hand.

**Works with your AI tools (MCP)**
- A built-in MCP server exposes every action in the UI (58 tools) with the same permissions, so Claude, Codex and other MCP clients can create missions, review, approve and land.

**Run without AI if you want**
- Set `AI_FEATURES=disabled`, or turn AI off per workspace. AI tabs disappear and Gitbraid works as a plain Git host with pull requests, issues, releases and branch protection.

**Security**
- Administrator setup with MFA, roles (Owner, Deployer, Maintainer, Reviewer, Contributor, Viewer), repository scopes, invitations, session revocation and an audit log.
- Model calls go only through your own AI Gateway; provider keys never enter agent sandboxes.

**Cloudflare resources**
- Connect your Cloudflare account to link the Workers, D1 databases, Durable Objects, Containers and Workflows each repository deploys to, see their usage, and apply reviewed D1 migrations.

## Built on Cloudflare

Workers, Durable Objects, Workflows, Containers, Artifacts (Git storage), AI Gateway and Workers AI. There are no servers to run; everything deploys into your account.

## Install

Click **Deploy to Cloudflare** above, or from a terminal:

```sh
npm ci
node scripts/install-self-hosted.mjs
```

Supply `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD` of at least 12 characters, sign in with them and enroll MFA. Deployment creates or reuses the AI Gateway and Artifacts namespace, derives the preview origin from your account, and deploys the application and preview Workers. The build credential needs AI Gateway Read/Write and Artifacts Read/Edit in addition to Workers, Containers, Workflows and KV permissions (Worker Settings → Builds).

To use AI, configure provider keys (BYOK) or Unified Billing in AI Gateway, then enable models under **AI models** in the workspace. Email requires your own verified sender.

Read [`docs/public/install.md`](docs/public/install.md) for prerequisites. A fresh-account deployment through the button has not yet been verified end to end; current live limits are in [`docs/public/overview.md`](docs/public/overview.md) and [`docs/public/agents.md`](docs/public/agents.md).

## What is not in this edition

The hosted Gitflare homepage, public signup and platform administration. Everything else shares the same core.

## Contributing and license

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md). Licensed under the [Apache License, Version 2.0](LICENSE); see [`NOTICE`](NOTICE). Code published before October 14, 2026 was released under the MIT License.
