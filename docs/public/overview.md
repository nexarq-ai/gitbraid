# How Gitflare works

Gitflare is a workspace for organizing code changes from people and AI agents. A Stream begins with an outcome, acceptance criteria, and two distinct assignments against a pinned repository revision. Each task is designed to work in an isolated fork; Gitflare records the resulting commits, diffs, and checks, then verifies a combined candidate before a reviewer can approve that exact revision.

![Two task revisions flow into combined candidate checks, exact-revision approval, and a separate landing action](gitflare-diagram:flow)

Approval and landing are different actions. Approval names both the candidate commit and its base commit. Landing rechecks that evidence and the canonical branch before integrating the already-tested commit. A merge does not deploy an application. Candidate preview uses a separate origin and an expiring capability.

## Two editions

The self-hosted core is distributed under the MIT License. It is intended to run in one Cloudflare account as one workspace, with the installation owner creating and managing users. The provisioning helper creates or reuses account-owned gateway and Artifacts resources, deploys the main and separate preview Workers, and generates `AUTH_ENCRYPTION_KEY` if absent without replacing an existing key. In the native deployment flow, provide `ADMIN_EMAIL` and `ADMIN_PASSWORD`; at first visit, use those same credentials with a display name and workspace name, then enroll an authenticator. This flow is implemented in source, but a fresh self-hosted installation has not yet been verified live.

Hosted Gitflare is a separately operated service. Its bounded, read-only agent-registration path and human claim flow have passed live checks, including read access, denied mutation, and credential revocation. Hosted platform administration and hosted agent enrollment are not included in the self-hosted archive.

![Workers serve the workspace and MCP boundary while Durable Objects, Workflows, Artifacts, Containers, and a separate preview Worker have distinct responsibilities](gitflare-diagram:architecture)

## Evidence and limits

Gitflare uses Cloudflare Workers for the interface, API, and MCP entry point; Durable Objects for coordination and access state; Workflows for durable mission steps; Artifacts for repository storage; and Containers for isolated code execution. Product model calls are routed through the `gitflare` AI Gateway; the configured default is `openai/gpt-6-luna`, and `openai/gpt-6.1-sol` is the only other permitted runtime model when explicitly needed.

Owners can also connect a Cloudflare account and associate existing Workers, D1 databases, or Durable Object namespaces with repositories. Source implements project-scoped usage views and an exact-revision D1 migration plan with checksum review and explicit execution; these integration actions remain unverified live and require a configured Cloudflare OAuth client. Cloudflare account connection is separate from Gitflare sign-in. Workers Builds trigger automation and Durable Object migration execution are not implemented; Cloudflare product SSO is also unavailable.

Some workspace, repository, access, and documentation paths have deployment and live-check evidence. The full sequence of real concurrent model calls, passing combined candidate, exact approval and landing, and working candidate preview remains unverified end to end. A source feature, test double, or successful deployment alone does not establish that workflow.

![Workspace identity, scoped task access, owner review, and isolated preview are separate trust boundaries](gitflare-diagram:trust)

Continue with the [installation guide](install.md), [workspace administration](admin.md), [repository workflow](repositories.md), [MCP guide](mcp.md), or [AI client guide](agents.md). These cross-links open the corresponding public `#docs` page.
