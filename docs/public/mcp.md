# Connect an AI client through MCP

Gitflare's MCP endpoint is `https://<your-worker-host>/mcp`. The Worker uses Cloudflare's official Agents SDK handler and routes tool operations through the same access checks as the UI. An MCP client receives the authority of the person who authorizes it; it does not receive a new Owner role.

![A remote MCP client completes OAuth authorization with the user, then calls bounded tools through the shared Gitflare authorization and API boundary](gitflare-diagram:mcp-connection)

## OAuth connection

The deployed OAuth Provider supports dynamic client registration, authorization-code PKCE with S256, a browser consent page, short-lived access tokens, refresh tokens, and account-role checks on each request. A live protocol check completed client registration, consent, PKCE exchange, MCP initialization, and session revocation; the revoked session then returned 401. The consent page shows the client's claimed name/domain, redirect host, workspace, and role. No actual Claude or Codex application connection has been verified, so client-specific setup may differ.

To connect an OAuth-enabled deployment:

1. Add a remote MCP server in your AI client using your Gitflare endpoint ending in `/mcp`.
2. Start the client's OAuth connection flow and review the browser consent page. Confirm the client identity and redirect destination carefully; a displayed client name may be self-reported.
3. Sign in to the intended Gitflare workspace and approve only the workspace access you expect.
4. In the client, discover Gitflare tools, list repositories, and read a file at a returned commit SHA. Confirm the response belongs to the intended workspace before authorizing writes.

For installations configured without OAuth storage, the server can also accept an account's personal bearer token. Use the client’s secure token store or environment-variable configuration; never paste the token into a prompt, repository file, or task assignment. The self-host installer is designed to create OAuth storage unless an existing namespace is supplied.

## Shared authority and limits

The 26-tool set includes repository browsing, file reads, read-only repository skill discovery, Proposals, task history, documentation, access administration, review, cancellation, preview, and landing. Exact candidate/base SHA checks and idempotency rules apply through MCP just as they do in the UI. Starting a mission consumes cloud and model resources. An authenticated client can approve or land only when the user authorized the action and the current role and state checks allow it.

`gitflare_cloudflare_project` manages per-repository Cloudflare resources. Its `map` action accepts up to 100 `{type, id, name, environment}` records. Resource types are `worker`, `d1`, `durable_object`, `container`, and `workflow`. Use IDs from the connected account catalog; only an Owner can change the map. `usage` returns per-resource Worker and D1 metrics; unsupported resource counters are returned as unavailable, not estimated. D1 migration planning requires a current commit and SQL migration path, and requires an explicit `databaseId` when multiple D1 resources are mapped. Review the SQL and checksum before the destructive execute action. An unknown outcome must be inspected, not automatically retried. Worker Builds triggers and Durable Object migrations are unavailable.

The current development project map contains seven resources: two Workers, three Durable Object namespaces, one Workflow, and one Container, all labeled `development`. The UI save, resource API read (HTTP 200), and MCP `get` returned identical records. Only the dedicated Gitflare runner was associated from the three Container applications in the catalog. Container usage counters are unavailable. D1 migration was not exercised.

External MCP clients and runtime task agents have different credentials. A remote Claude or Codex client acts as the human principal; a product coding task receives independently scoped access to its own fork. Never pass an Owner token, OAuth client token, personal MCP bearer, deployment secret, or setup token into a task sandbox.

No actual Claude/Codex application OAuth session has been verified. One compatible fixture proposal has completed two concurrent model-backed runs, individual and combined checks, exact approval, and canonical landing; a separate-origin preview was also verified. This does not establish client-specific compatibility or arbitrary repository readiness. See the [AI client guide](agents.md), [workspace administration](admin.md), and [repository workflow](repositories.md).
