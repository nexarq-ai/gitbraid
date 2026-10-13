# Repositories and reviewed changes

Create a repository in the configured Cloudflare Artifacts namespace, or connect an existing repository in that namespace. Gitflare confirms its Artifacts remote and current branch head. This does not import arbitrary GitHub or GitLab URLs, and matching a namespace name alone is not proof of external ownership.

Browse a branch, tag, or commit before creating a Proposal. Gitflare resolves refs to a commit SHA; use that immutable revision as the task base. A Proposal is a mission-backed change record containing the intended outcome, acceptance criteria, two complementary task assignments, discussion, revisions, and execution evidence. Creating a Proposal saves a draft; starting it is a separate action that consumes Cloudflare and model resources. The workspace-wide Missions view remains available; the repository's Proposals view keeps changes grouped with their codebase.

![From a pinned repository revision, two isolated task changes are reviewed together before exact-candidate approval and landing](gitflare-diagram:user-journey)

The repository has focused **Code**, **Proposals**, **Agents**, and **Checks** views. Agents shows the two task records, their assignments, run state, fork/branch, commits, changed files, and errors. Checks shows individual results and the combined candidate result with the SHA each one covers. Each task is designed to work in a separate fork and sandbox. Two tasks can pass individually while their combined candidate fails. File overlap is a signal for review, not proof of a semantic conflict.

The repository's **Skills** view discovers `SKILL.md` files beneath `.agents/skills/`, `.claude/skills/`, `skills/`, and `docs/skills/`. It resolves the selected branch, tag, or commit to an immutable SHA and previews instructions from that revision. Discovery is read-only: it does not install or execute a skill. The bounded scan reports truncation and skipped files so an incomplete result is visible.

The **Cloudflare** project view lets an Owner search and filter the connected account catalog, select multiple Workers, D1 databases, Durable Object namespaces, Container applications, and Workflows, and label each with its environment. The current development project map contains seven resources: two Workers, three Durable Object namespaces, one Workflow, and one Container, all labeled `development`. The UI save, API read (HTTP 200), and MCP `get` returned identical records. Only the dedicated Gitflare runner was associated from the three Container applications in the catalog. Container usage counters are unavailable. D1 migration has not been exercised live.

The Proposal's discussion is attached to the exact candidate SHA, base SHA, and execution epoch. Reviewers can comment or request changes; unresolved requests block approval and landing. Only the reviewer who raised a request can resolve it. Discussion is not an approval action and does not change source files.

Approve only the exact candidate and base SHAs shown in current evidence. Landing is separate and rechecks the approved candidate, passing checks, and canonical branch head before writing the tested commit. Landing does not deploy production. Cancelled or retried attempts retain distinct evidence; do not treat a queued state or agent summary as a passing result.

Preview uses a separate origin and an expiring capability tied to the candidate. A live preview opened successfully for a passing combined candidate and displayed that candidate's batch, concurrency, in-flight, and capacity values. This verifies one preview path; it does not establish compatibility for arbitrary applications or make the URL a public deployment.

The current execution policy is deliberately narrow: candidate edits are limited to `src/`, `docs/`, and `README.md`, while tests, test configuration, and dependency files remain protected. This is not a general Git host or arbitrary-language build service. One supported fixture candidate completed two concurrent model-backed runs, passed both individual checks and the combined check, opened in a separate-origin preview, received exact-candidate approval, and landed. The canonical branch was verified at the approved commit. A separate proposal passed its individual checks but failed its combined check, so it was not eligible to land. This does not establish arbitrary-repository readiness or deploy production.

See the [AI client and agent guide](agents.md), [MCP connection guide](mcp.md), and [Cloudflare installation guide](install.md) for access and setup boundaries.
