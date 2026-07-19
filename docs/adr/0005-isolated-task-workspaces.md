# ADR 0005: Isolated Git task workspaces and private checkpoints

**Status:** Accepted
**Date:** 2026-07-18
**Related:** [Desktop core workflows design](../plans/2026-07-18-desktop-core-workflows-design.md) · [Implementation plan](../plans/2026-07-18-desktop-core-workflows.md) · [PRINCIPLE.md](../../PRINCIPLE.md) §5.9–§5.11

## Context

Kin can run several coding tasks concurrently, retry a conversation turn, and fork a task. Today every adapter receives the user-selected `tasks.cwd` directly. Separate tasks can therefore modify the same checkout at the same time, while Retry and Fork alter conversation history without restoring the corresponding filesystem state.

The workspace UI currently infers changed files from tool events and opens current file contents. That is useful for navigation but is not a trustworthy review boundary: agents can edit through shells or external tools, can commit changes, and can produce paths that do not appear in normalized tool events.

Kin needs one coherent mechanism for parallel isolation, source-of-truth diffs, task-level discard, and turn-level file recovery without introducing containers, copying whole repositories, or writing hidden checkpoint commits into the user's repository.

## Decision

### Workspace ownership

- A task retains `cwd` as the user-selected project directory and gains explicit workspace metadata: mode, source repository root, execution root/cwd, scope relative to the repository, base commit, and task branch.
- New task requests accept `workspace_mode=auto|shared|worktree`. Existing clients that omit it behave as `auto`.
- `auto` creates an isolated worktree only when the selected directory is inside a clean, non-bare Git worktree with a valid `HEAD`. Dirty, non-Git, unborn, or unavailable-Git directories remain shared and return an explanatory reason.
- Explicit `worktree` rejects unsupported repositories instead of silently falling back. Explicit `shared` preserves today's behavior.
- Kin creates isolated worktrees below `~/.kin/worktrees/<task-id>` and branches named `kin/task/<lowercase-task-id>`. It invokes `git` with argument arrays, never through a shell.
- `tasks.cwd` remains the grouping and provenance path. Adapters, task workspace file APIs, and the desktop terminal use the effective execution cwd.
- All agents inside one Kin task share that task's workspace. Per-worker worktrees and automatic merge orchestration are not part of this decision.

### Diff source of truth

- For Git tasks, changed files come from Git relative to the task's recorded base commit, scoped to the selected cwd. Tool-event inference remains only as a fallback for non-Git and historical tasks.
- The API returns structured change metadata and bounded old/new UTF-8 content for one selected file. Binary files are listed but not rendered as text.
- A task diff includes committed, staged, unstaged, renamed, deleted, and untracked files. Paths are parsed from NUL-delimited Git output and are revalidated under the effective workspace before filesystem reads.
- Review comments are client-side draft data in the first release. Submitting them produces one structured follow-up prompt through the existing task prompt API.

### Recoverability

- Before each user turn runs in an isolated workspace, Kin records the worktree `HEAD` and a snapshot tree keyed by the user-message event sequence.
- Snapshot objects are written to `~/.kin/checkpoints/<task-id>/objects`, not the repository's object database. A temporary Git index starts from `HEAD`, applies `git add -A`, and writes the tree into that private object directory while reading unchanged objects through Git alternates.
- Ignored files are excluded. Snapshot creation has per-file and aggregate size limits. A skipped checkpoint is visible in task events and never prevents the task itself from running.
- Retry with file restore first restores the selected checkpoint, then truncates conversation events. If restore fails, neither conversation history nor task state is mutated.
- Restore resets the task branch to the recorded `HEAD`, removes later untracked files, materializes the private tree, and resets the real index back to that `HEAD`. The result is the exact checkpoint content represented as ordinary working-tree changes, without a hidden checkpoint commit in task history.
- Fork creates a new worktree from the nearest source checkpoint when one exists. Historical/shared tasks keep transcript-only fork behavior and disclose that files were not cloned from the turn.
- “Discard task changes” restores the initial checkpoint and is available only for a terminal isolated task after explicit confirmation.

## Consequences

- Concurrent tasks no longer edit the same clean Git checkout by default.
- The original checkout's uncommitted changes are never silently copied into a new worktree. `auto` therefore chooses shared mode for dirty repositories; an explicit isolated choice warns that source changes are excluded.
- Git becomes an optional runtime dependency for isolation and structured review, not a requirement for Kin task execution.
- Worktrees and private checkpoint objects consume local disk. They are retained with task history in this first release; UI and settings show their paths and approximate size. Automatic expiry and task archival remain follow-up work.
- Existing tasks migrate to shared mode with `execution_cwd=cwd`, preserving behavior.
- A failure to create an explicitly requested worktree fails task creation. A failure to capture an individual checkpoint degrades recoverability but does not fail agent execution.
- The task engine needs an injected workspace service, but adapters remain unaware of Git and continue receiving a resolved cwd through `adapter.TaskSpec`.

## Security and failure boundaries

- Task IDs, not repository names or user input, determine Kin-owned worktree and checkpoint paths.
- Every removal or restore operation verifies the target is beneath the configured Kin state directory and that task metadata identifies an isolated workspace.
- Git is invoked with `GIT_TERMINAL_PROMPT=0`; commands have bounded contexts and capture bounded stderr. No environment values or file contents are logged.
- Diff and checkpoint file enumeration uses NUL delimiters. Symlink and traversal checks from the existing workspace API remain in force.
- Restore and discard are rejected while a task is queued, running, or waiting for approval.
- No automatic `git clean`, reset, branch deletion, or worktree removal is ever run against a shared workspace.

## Rejected alternatives

1. **Copy the entire project per task** — duplicates ignored files and secrets, mishandles hardlinks/symlinks/permissions, consumes substantially more disk, and still needs a diff model.
2. **Store checkpoints as commits in the user's repository** — simple, but can place untracked secrets and generated blobs in the user's object database and pollute branch/history semantics.
3. **Containers or virtual machines per task** — stronger process isolation but changes the local development environment, adds distribution and networking complexity, and exceeds Kin's current single-machine scope.
4. **Conversation-only Retry/Fork** — preserves the present mismatch between transcript state and disk state and is not sufficient for a trustworthy coding workflow.
5. **One worktree per worker agent** — requires merge/conflict orchestration inside a task. The first release isolates user-visible tasks; workers in one task intentionally collaborate in one workspace.
