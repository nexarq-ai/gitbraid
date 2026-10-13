# Repositories and reviewed changes

Create a repository in the configured Cloudflare Artifacts namespace, or connect an existing repository in that namespace. Gitflare confirms its Artifacts remote and current branch head. This does not import arbitrary GitHub or GitLab URLs, and matching a namespace name alone is not proof of external ownership.

Browse a branch, tag, or commit before drafting a Stream. Gitflare resolves refs to a commit SHA; use that immutable revision as the task base. A Stream records its intended outcome, acceptance criteria, two complementary task assignments, and execution evidence. Creating a Stream saves a draft; start is a separate action that consumes Cloudflare and model resources.

![From a pinned repository revision, two isolated task changes are reviewed together before exact-candidate approval and landing](gitflare-diagram:user-journey)

Each task is designed to work in a separate fork and sandbox. Review changed files, overlap, individual checks, and the combined candidate check. Two tasks can pass individually while their combined candidate fails. File overlap is a signal for review, not proof of a semantic conflict.

Approve only the exact candidate and base SHAs shown in current evidence. Landing is separate and rechecks the approved candidate, passing checks, and canonical branch head before writing the tested commit. Landing does not deploy production. Cancelled or retried attempts retain distinct evidence; do not treat a queued state or agent summary as a passing result.

Preview uses a separate origin and an expiring capability tied to the candidate. The preview runtime and current workflow require live verification; a URL by itself is not proof that an application is ready or compatible with opaque-origin isolation.

The current execution policy is deliberately narrow: candidate edits are limited to `src/`, `docs/`, and `README.md`, while tests, test configuration, and dependency files remain protected. This is not a general Git host or arbitrary-language build service. Model-backed concurrent execution, successful combined landing, and preview compatibility are still end-to-end verification requirements.

See the [AI client and agent guide](agents.md), [MCP connection guide](mcp.md), and [Cloudflare installation guide](install.md) for access and setup boundaries.
