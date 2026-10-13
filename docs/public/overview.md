# How Gitflare works

Gitflare is a workspace for organizing code changes from people and AI agents. A Stream begins with an outcome, acceptance criteria, and one to eight distinct assignments (two by default) against a pinned repository revision. Up to three tasks run concurrently. Each task is designed to work in an isolated fork; Gitflare records the resulting commits, diffs, and checks, then verifies a combined candidate before a reviewer can approve that exact revision.

![Isolated task revisions flow into combined candidate checks, exact-revision approval, and a separate landing action](gitflare-diagram:flow)

Approval and landing are different actions. Approval names both the candidate commit and its base commit. Landing rechecks that evidence and the canonical branch before integrating the already-tested commit. A merge does not deploy an application. Candidate preview uses a separate origin and an expiring capability.

## Two editions

The self-hosted core is distributed under the MIT License. It is intended to run in one Cloudflare account as one workspace, with the installation owner creating and managing users. The provisioning helper creates or reuses account-owned gateway and Artifacts resources, deploys the main and separate preview Workers, and generates `AUTH_ENCRYPTION_KEY` if absent without replacing an existing key. In the native deployment flow, provide `ADMIN_EMAIL` and `ADMIN_PASSWORD`; at first visit, use those same credentials with a display name and workspace name, then enroll an authenticator. This flow is implemented in source, but a fresh self-hosted installation has not yet been verified live.

Hosted Gitflare is a separately operated service. Its bounded, read-only agent-registration path and human claim flow have passed live checks, including read access, denied mutation, and credential revocation. Hosted platform administration and hosted agent enrollment are not included in the self-hosted archive.

![Workers serve the workspace and MCP boundary while Durable Objects, Workflows, Artifacts, Containers, and a separate preview Worker have distinct responsibilities](gitflare-diagram:architecture)

## Evidence and limits

Gitflare uses Cloudflare Workers for the interface, API, and MCP entry point; Durable Objects for coordination and access state; Workflows for durable mission steps; Artifacts for repository storage; and Containers for isolated code execution. Product inference runs through the `gitflare` AI Gateway. Workspace Owners can configure compatible Gateway models and enable supported Workers AI models; the default is `openai/gpt-6-luna`. Selected model connections are pinned per task, with no direct-provider path or silent substitution. Native Anthropic and Gemini transports are not implemented. Bounded text inference passed for Gateway Luna, Gateway `openai/gpt-4.1-mini` using compatible chat, and Workers AI Llama. A custom Gateway model completed a live coding proposal with passing individual and combined checks and exact-candidate landing; approval and landing were owner-authorized agent actions, not independent human approval. A Workers AI Llama run completed a real tool loop and produced a candidate that passed both check levels, but its requested guide was too incomplete for approval, so it was not landed. This demonstrates tool use and candidate checks for that run, not successful delivery or general coding compatibility.

Owners can connect a Cloudflare account and associate multiple Workers, D1 databases, Durable Object namespaces, Container applications, and Workflows with a repository, each labeled with an environment. The current development project map contains seven resources: two Workers, three Durable Object namespaces, one Workflow, and one Container, all labeled `development`. The UI save, API read, and MCP `get` returned the same map. Only the dedicated Gitflare runner was associated from the three applications shown in the Container catalog. Container usage counters are unavailable. D1 migration planning and execution remain unverified live. Cloudflare account connection is separate from Gitflare sign-in. Workers Builds trigger automation and Durable Object migration execution are not implemented; Cloudflare product SSO is also unavailable.

One compatible fixture candidate completed two concurrent model-backed runs, passed both individual checks and the combined candidate check, opened in a separate-origin preview, received exact-candidate approval, and landed. The canonical branch was verified at the approved commit. A separate proposal demonstrated the combined-check gate: both individual checks passed while the combined check failed, and it was not landed. These are specific observed attempts, not proof that every run or application will work; arbitrary repository compatibility and production deployment are not established.

![Workspace identity, scoped task access, owner review, and isolated preview are separate trust boundaries](gitflare-diagram:trust)

Continue with the [installation guide](install.md), [workspace administration](admin.md), [repository workflow](repositories.md), [MCP guide](mcp.md), or [AI client guide](agents.md). These cross-links open the corresponding public `#docs` page.
