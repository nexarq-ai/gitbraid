# Connect an AI client through MCP

Gitflare's MCP endpoint is `https://<your-worker-host>/mcp`. The Worker uses Cloudflare's official Agents SDK handler and routes tool operations through the same access checks as the UI. An MCP client receives the authority of the person who authorizes it; it does not receive a new Owner role.

![A remote MCP client completes OAuth authorization with the user, then calls bounded tools through the shared Gitflare authorization and API boundary](gitflare-diagram:mcp-connection)

## OAuth connection

The deployed OAuth Provider supports dynamic client registration, authorization-code PKCE with S256, a browser consent page, short-lived access tokens, refresh tokens, and account-role checks on each request. A live protocol check completed client registration, consent, PKCE exchange, MCP initialization, and session revocation; the revoked session then returned 401. The consent page shows the client's claimed name/domain, redirect host, workspace, and role. No actual Claude or Codex application connection has been verified, so client-specific setup may differ.

When the OAuth-enabled deployment is available:

1. Add a remote MCP server in your AI client using your Gitflare endpoint ending in `/mcp`.
2. Start the client's OAuth connection flow and review the browser consent page. Confirm the client identity and redirect destination carefully; a displayed client name may be self-reported.
3. Sign in to the intended Gitflare workspace and approve only the workspace access you expect.
4. In the client, discover Gitflare tools, list repositories, and read a file at a returned commit SHA. Confirm the response belongs to the intended workspace before authorizing writes.

For installations configured without OAuth storage, the server can also accept an account's personal bearer token. Use the client’s secure token store or environment-variable configuration; never paste the token into a prompt, repository file, or task assignment. The self-host installer is designed to create OAuth storage unless an existing namespace is supplied.

## Shared authority and limits

The tool set includes repository browsing, file reads, Streams, task history, documentation, access administration, review, cancellation, preview, and landing. Exact candidate/base SHA checks and idempotency rules apply through MCP just as they do in the UI. Starting a mission consumes cloud and model resources. An authenticated client can approve or land only when the user authorized the action and the current role and state checks allow it.

External MCP clients and runtime task agents have different credentials. A remote Claude or Codex client acts as the human principal; a product coding task receives independently scoped access to its own fork. Never pass an Owner token, OAuth client token, personal MCP bearer, deployment secret, or setup token into a task sandbox.

No actual Claude/Codex application OAuth session or complete model-backed mission has been verified. Protocol-level OAuth and MCP checks do not establish client-specific compatibility. See the [AI client guide](agents.md), [workspace administration](admin.md), and [repository workflow](repositories.md).
