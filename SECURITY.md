# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub's **Report a vulnerability** button on this repository (Security tab), including:

- what an attacker can do and the affected version or commit;
- steps to reproduce or a proof of concept;
- any suggested fix.

You will receive an acknowledgement, and we will agree a disclosure date once a fix is available.

## Scope

In scope: authentication and sessions, workspace and repository authorization, task-agent credential isolation, the Git and preview proxies, approval and landing integrity, and MCP authorization.

Out of scope: vulnerabilities in Cloudflare services themselves (report those to Cloudflare), denial of service through your own account's quotas, and findings that require a compromised administrator account.
