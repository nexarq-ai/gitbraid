# Administer a workspace

The self-hosted edition is designed for one workspace in the Cloudflare account that runs it. The first administrator is created through the protected installation setup. Public workspace signup is disabled in self-hosted mode; the Owner creates or invites each additional user.

![Account identity, role and repository scope flow through shared access checks before UI or MCP operations are allowed](gitflare-diagram:access-control)

## First administrator and MFA

The installer creates a one-time setup capability and stores it in a protected local file. At the deployed sign-in page, enter it with the administrator's name, email, password, and workspace name. Passwords must have at least 12 characters. The setup flow requires TOTP authenticator enrollment and verification before opening the workspace, then displays ten single-use recovery codes. Store those codes privately. Hosted signup, MFA enrollment, password login with an MFA challenge, and recovery-code login have passed live checks. A fresh self-hosted installation and its initial setup flow have not been verified.

Self-hosted login is configured to require an authenticator challenge. An enrolled user can use a single-use recovery code if the authenticator is unavailable. There is no automated account recovery, email-address verification, MFA reset, SSO, or platform-level super-administrator interface. The hosted MFA checks do not establish a fresh self-hosted install.

## Users and permissions

In **Settings → People**, Owners can create users or send a single-use invitation. If a verified Email Sending sender is configured, the application can deliver invitation links. Without that sender, deliver the invitation capability securely yourself. Invitations expire after 24 hours and must match the invitee's account email. Email delivery and invitation acceptance must be verified in your own deployment.

The current role presets are Viewer, Contributor, Reviewer, Maintainer, Deployer, and Owner. Membership can be limited to selected repositories. Teams and exact-resource grants can refine access, but grant records do not provision secrets, databases, deployment credentials, or migration executors. Keep at least one active Owner and review the audit trail after access changes.

Revoke browser sessions, personal MCP sessions, task credentials, and invitations during offboarding. Task credentials have bounded repository scope, expiry, request budget, and execution budget. A coding agent must never receive an Owner token, MCP token, installation setup token, or deployment credential.

An authenticated MCP client acts with the signed-in user's current authority; it can approve or land only if the user's role and the exact candidate state allow it. See [MCP authorization](mcp.md) and [repository review](repositories.md). The hosted service's global administration and hosted-agent claim process are separate from this self-hosted workspace and are excluded from the source package.
