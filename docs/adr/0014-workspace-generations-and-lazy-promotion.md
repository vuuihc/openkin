# ADR 0014: Workspace generations, lazy write promotion, and durable review

**Status:** Accepted
**Date:** 2026-07-26
**Supersedes in part:** [ADR 0005](./0005-isolated-task-workspaces.md) workspace ownership and retention lifecycle
**Related:** [Implementation plan](../plans/2026-07-26-workspace-generations-and-lazy-promotion.md) · [PRINCIPLE.md](../../PRINCIPLE.md) §5.5, §5.9–§5.11

## Context

ADR 0005 correctly introduced isolated Git worktrees and private checkpoints,
but it made one physical worktree part of the durable task row. In practice a
Kin task is also a long-lived conversation:

- a user may continue a task after its code was merged;
- repository instructions may require an agent to merge and delete its feature
  worktree before the conversation ends;
- the file browser needs to review completed changes after the physical
  worktree is gone; and
- a later turn may need a new isolated change set without losing the existing
  agent session and transcript.

The single-worktree model cannot represent those states. `tasks.cwd` is the
user-selected project path, while `tasks.execution_cwd` may point at a Kin-owned
worktree. Some UI paths are made relative to `cwd` even though file APIs and
adapters use `execution_cwd`. When the worktree is removed, the database keeps
the stale path. A later `exec.Cmd` then reports a misleading
`fork/exec <agent binary>: no such file or directory`, and the workspace file
API also fails.

Creating a worktree for every conversational turn is wasteful. Letting an agent
answer from the primary checkout without an enforced read-only boundary is
unsafe. Guessing write intent from user wording or shell text is unreliable.
Kin needs a durable contract that separates conversation lifetime, execution
isolation, and historical review.

## Decision

### Task conversation and workspace lifetime are independent

A `Task` remains the long-lived conversation aggregate. A task may own zero or
more ordered workspace generations and at most one open generation.

```text
Task
  ├── no open workspace: source checkout, enforced read-only
  ├── workspace generation 1: ready → active → finalizing → integrated → released
  ├── no open workspace: source checkout, enforced read-only
  └── workspace generation 2: ready → active → …
```

The task keeps `cwd` as provenance. A workspace generation records its own
source repository, selected scope, target branch, creation base, final review
base, task branch, physical root, execution cwd, final tree, integrated commit,
timestamps, and failure state.

The existing workspace columns on `tasks` remain temporary compatibility
projections for one release. New lifecycle logic treats `task_workspaces` and
`tasks.current_workspace_id` as the source of truth.

### `auto` starts read-only and promotes on explicit agent write intent

For adapter installations that pass Kin's lazy-workspace compatibility probe,
`workspace_mode=auto` starts without a worktree:

- the adapter runs in the source checkout with an enforced read-only sandbox;
- Kin exposes a `request_workspace` MCP tool;
- runtime instructions require the agent to call it before modifying source;
- Kin creates the next workspace generation without user confirmation;
- the read-only execution ends normally; and
- Kin resumes the same agent session in the new writable execution cwd.

The read-only sandbox is the safety boundary. The MCP call is the transition
signal, not the sole enforcement mechanism. Kin does not infer mutation from
natural-language verbs or shell command strings.

Codex non-interactive runs cannot wait for a new interactive approval and
change cwd in place. Claude and Codex therefore use the same turn-boundary
transition: request, finish the read-only attempt, then resume in the worktree.

The capability probe is version- and flag-based and fails closed. Codex must
support a read-only sandbox, explicit MCP configuration, and ignoring ambient
user configuration. Claude must support plan mode, strict MCP configuration,
an exact allowlist for `request_workspace`, removal of mutating tools, and
disabling ambient hooks. Checked-in argv/config contract tests and a release
conformance test must prove both “source write is denied” and “workspace
request is delivered” for every supported CLI version line before Kin ships it
as lazy-capable.

Adapters or installed CLI versions that do not pass the probe retain the
conservative eager path: `auto` prepares a worktree before execution when Git
isolation is available. If auto isolation is unavailable, Kin fails closed and
offers explicit `shared`; it never silently turns `auto` into writable primary
checkout access. Explicit `worktree` still prepares immediately. Explicit
`shared` retains direct shared execution and remains an advanced opt-in.

The rule applies to every process in an orchestrated worker wave, not only its
host. If any concrete worker lacks certified read-only support, Kin starts none
of the wave on source: it promotes the task first and runs the whole wave in the
generation, or fails closed if isolation is unavailable.

Workspace access is separate from user permission mode. `default`,
`accept_edits`, and `yolo` control approvals inside the selected execution
root; they may not override a task run marked source-read-only.

### Kin owns integration and physical release

Agents must not remove their current Kin-owned worktree. Kin exposes a
`complete_workspace` MCP tool. Calling it marks the generation `finalizing` and
asks the agent to end the turn.

After the adapter process exits, Kin:

1. verifies the workspace exists, is clean, and has committed changes;
2. captures the final head/tree used to derive the immutable changed-file
   manifest;
3. verifies the primary checkout is clean and still on the recorded target
   branch;
4. fast-forwards the target branch to the workspace head;
5. records the integrated commit;
6. removes the physical worktree;
7. deletes the fully merged task branch; and
8. clears the task's current workspace pointer.

Kin only performs a fast-forward. If the target advanced, the workspace remains
open and the agent is instructed to merge the target into the workspace,
resolve conflicts there, rerun checks, and request completion again. Kin never
creates a conflict in the user's primary checkout.

Every transition is an append-only task event:

```text
workspace_provisioning
workspace_created
workspace_finalizing
workspace_merged
workspace_released
workspace_blocked
workspace_recovered
```

Creation, merge, and release are separately visible in the conversation. A
physical worktree is never deleted before the final snapshot and integration
record are durable.

### Review uses canonical workspace-relative file identities

A task file reference is:

```text
workspace_id + repository-relative path
```

Adapter events are stamped with workspace generation metadata. Absolute paths
reported by an agent are normalized against that generation's physical
repository root. Inputs relative to its execution cwd are prefixed with the
stored repository scope, so a task opened at `ui/` maps `src/App.tsx` to the
canonical repository-relative `ui/src/App.tsx`. The normalized value is stored
separately from the provider's raw path; the UI never derives a worktree path
from `tasks.cwd`.

Each accepted user turn also has a durable mapping to the workspace generation
that executed it, or to source-read-only access when none was created. If a
turn promotes, the mapping changes atomically with `workspace_created`. Retry
and fork consult this mapping rather than inferring a generation from adjacent
events.

While a generation is active, tree and diff APIs read the live worktree. After
integration or release, they read the recorded review-base and final Git trees.
The review base is the target-branch head immediately before the successful
fast-forward, so target changes merged into a blocked workspace are not
misattributed to the task. Deleting a worktree therefore does not delete its
review surface.

The released-workspace file browser defaults to immutable final changes and
offers current project files as a separate, clearly labelled view. Multiple
generations are shown independently. The conversation-level “All changes” view
aggregates per-generation manifests derived from recorded review-base/final
trees; it does not compare the first base with current `main`, which would
incorrectly attribute unrelated commits.

### Recovery is idempotent and fail-closed

Workspace lifecycle state is persisted before filesystem mutation. Daemon
startup reconciles non-terminal generations:

- `provisioning`: complete creation or mark `orphaned`;
- `ready`: resume the pending turn in the prepared workspace;
- `active`: verify path and branch registration;
- `finalizing`: retry snapshot and integration;
- `integrated`: retry physical release;
- `merge_blocked` or `finalize_blocked`: retain the worktree and permit a later
  writable follow-up to resolve the condition and request completion again;
- `released`: remove any safely contained residue;
- missing active workspace: restore from branch/checkpoint when possible,
  otherwise mark `orphaned`, clear the active pointer, and leave the
  conversation usable in source-read-only mode.

Recovery may reduce a task to read-only or a visible blocked state. It must
never silently fall back to writable execution in the primary checkout.

## Consequences

### Positive

- A conversation survives merge, worktree release, daemon restart, and later
  code changes.
- Read-only questions do not allocate worktrees.
- Each later change set receives a fresh isolated generation.
- Creation, merge, failure, and deletion become auditable product events.
- File navigation and diffs remain correct for active and released worktrees.
- Main-checkout safety no longer depends on model compliance.

### Negative

- Task execution gains a durable workspace state machine and adapter capability
  negotiation.
- Lazy promotion requires a two-attempt turn for Codex and Claude.
- Historical review depends on the source Git repository and retained Git
  objects; repository deletion remains a hard failure.
- The compatibility period temporarily duplicates current workspace metadata
  between `tasks` and `task_workspaces`.

### Neutral

- Existing private checkpoint object storage remains useful and gains
  workspace-generation attribution.
- Generic CLI adapters may continue creating worktrees eagerly until they gain
  a trustworthy write-intent protocol.
- `shared` mode remains supported but is not the default safety path.

## Security and failure boundaries

- Worktree paths and branches are derived only from validated task IDs and
  generation numbers.
- All removal paths must remain beneath `~/.kin/worktrees`.
- Source-read-only access overrides `yolo` and `accept_edits`; ambient provider
  hooks and MCP servers are disabled for that run.
- MCP lifecycle requests use short-lived, HMAC-authenticated execution
  capabilities scoped to one task, one execution, an expiry, and explicit
  lifecycle actions. The global daemon bearer is never exposed to an agent.
- Capability tokens are kept out of process arguments. The provider may be
  able to read its own temporary capability file, so authorization remains
  safe even if that execution-scoped token leaks.
- Finalization refuses dirty primary checkouts, missing repositories, wrong
  target branches, uncommitted workspace changes, failed snapshots, and
  non-fast-forward integration.
- Historical file reads retain existing traversal, symlink, UTF-8, binary, and
  size limits.

## Alternatives considered

### Retain every worktree until the task is deleted

Rejected because it couples conversation retention to disk use and still does
not solve stale paths when users or agents remove worktrees manually.

### Make a merged task read-only forever and fork a new task for later edits

Rejected because it breaks conversational continuity and forces the user to
manage implementation-level lifecycle concepts.

### Classify prompts such as “fix” versus “explain”

Rejected because language is ambiguous and the classifier would become a
safety boundary it cannot reliably guarantee.

### Detect writes by parsing shell commands

Rejected because shell composition, scripts, build tools, and subprocesses make
static command classification incomplete.

### Change cwd inside a running agent process

Rejected because child process cwd cannot be safely replaced, and Codex
non-interactive approvals cannot suspend and migrate a live run.

### Let the agent merge and delete its own worktree

Rejected because deleting the process cwd breaks follow-ups, file APIs, and
daemon restart recovery, and makes the lifecycle invisible to Kin.

## References

- [ADR 0005: Isolated Git task workspaces and private checkpoints](./0005-isolated-task-workspaces.md)
- [OpenKin Product Principles](../../PRINCIPLE.md)
- [OpenKin System Design](../../SYSTEM_DESIGN.md)
- [Workspace generations implementation plan](../plans/2026-07-26-workspace-generations-and-lazy-promotion.md)
