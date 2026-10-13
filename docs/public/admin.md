# Administer a workspace

The self-hosted edition is designed for one workspace in the Cloudflare account that runs it. The first administrator becomes Owner of that workspace; this role does not grant global administration of the separately operated hosted service. Public workspace signup is disabled in self-hosted mode; the Owner creates or invites each additional user.

![Account identity, role and repository scope flow through shared access checks before UI or MCP operations are allowed](gitflare-diagram:access-control)

## First administrator and MFA

For a new native Cloudflare deployment, provide `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the deployment settings. At the new Worker URL, use those same credentials with the administrator's display name and workspace name. Passwords must have at least 12 characters. The setup flow then requires TOTP authenticator enrollment and verification before opening the workspace, and displays ten single-use recovery codes. Store those codes privately. A new self-hosted installation does not ask for a setup token. Hosted signup, MFA enrollment, password login with an MFA challenge, and recovery-code login have passed live checks; the new self-hosted first-admin flow has not yet been verified in a fresh installation.

Self-hosted login is configured to require an authenticator challenge. An enrolled user can use a single-use recovery code if the authenticator is unavailable. Provisioning is implemented to generate `AUTH_ENCRYPTION_KEY` when absent and preserve it on later deployments; this has not yet been verified in a fresh installation. Back up the key securely and do not rotate it casually. There is no automated account recovery, email-address verification, MFA reset, Cloudflare product SSO, or platform-level super-administrator interface. The hosted MFA checks do not establish a fresh self-hosted install.

## Users and permissions

In **Settings → People**, Owners can create users or send a single-use invitation. If a verified Email Sending sender is configured, the application can deliver invitation links. Without that sender, deliver the invitation capability securely yourself. Invitations expire after 24 hours and must match the invitee's account email. Email delivery and invitation acceptance must be verified in your own deployment.

The current role presets are Viewer, Contributor, Reviewer, Maintainer, Deployer, and Owner. Membership can be limited to selected repositories. Teams and exact-resource grants can refine access, but grant records do not provision secrets, databases, deployment credentials, or migration executors. Keep at least one active Owner and review the audit trail after access changes.

Revoke browser sessions, personal MCP sessions, task credentials, and invitations during offboarding. Task credentials have bounded repository scope, expiry, request budget, and execution budget. A coding agent must never receive owner credentials, personal MCP credentials, or deployment credentials.

An authenticated MCP client acts with the signed-in user's current authority; it can approve or land only if the user's role and the exact candidate state allow it. See [MCP authorization](mcp.md) and [repository review](repositories.md). The hosted service's global administration and hosted-agent claim process are separate from this self-hosted workspace and are excluded from the source package.

## Cloudflare account and repository resources

After signing in to Gitflare as an Owner, **Settings → Cloudflare** can start a separate Cloudflare account authorization. This connection is not Cloudflare product SSO and does not sign a user in to Gitflare. The OAuth account connection and resource listing have been verified live; each project mapping and operation has separate verification status.

With an account connected, an Owner can associate one repository with multiple Workers, D1 databases, Durable Object namespaces, Container applications, and Workflows. The account catalog supports search and type filtering, and each selected resource receives an environment label. Source validates the resources against the connected account before saving. Usage results are scoped to the account and each mapped resource; Worker and D1 counters are supported, while other resource types report unavailable rather than estimated metrics.

The latest selected development project map contains six resources: two Workers, three Durable Object namespaces, and one Workflow, all labeled `development`. The earlier live check verified UI/MCP parity for the initial four resources. Worker usage returned records; Durable Object and Workflow counters were unavailable. D1 usage and migration execution were not tested. Container catalog access awaits renewed OAuth consent; the permission state does not show that the account has no Container resources.

A D1 migration plan identifies one selected mapped database, the current repository commit, and a SQL file under `migrations/` or `db/migrations/`. The plan stores a SHA-256 checksum for exact review before explicit execution. If more than one D1 database is linked, choose its `databaseId` explicitly. Applying SQL can alter or delete data; an uncertain execution outcome must be inspected before planning another migration. The plan and execution path are implemented, but a live D1 migration has not been performed.

Workers Builds trigger integration and Durable Object migration execution are not available in this release. Cloudflare resource associations do not deploy a Worker or migrate a Durable Object. See the [overview](overview.md) for current implementation and verification limits.
