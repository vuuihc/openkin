# Desktop Core Workflows Design

**Status:** Proposed for implementation
**Date:** 2026-07-18
**Scope:** Finish the integrated terminal UI, isolate Git tasks, add trustworthy diff review, and make Retry/Fork restore files.

## 1. Outcome

After this work, a user can start several Kin coding tasks without clean Git projects colliding, remain inside the desktop app to run terminal commands, inspect the complete task diff, attach line-specific review feedback, retry from an earlier user turn with matching files, fork both transcript and filesystem state, and discard all changes made by an isolated task.

This is the smallest set that closes the daily coding loop. Browser/app preview, editable source files, PR/CI monitoring, SSH/cloud execution, routines, computer use, plugin marketplaces, and per-worker worktrees are explicitly deferred.

## 2. Current baseline

- The terminal runtime, profiles, loopback REST routes, WebSocket stream, and daemon lifecycle are complete. Tasks 7–12 of `2026-07-17-integrated-terminal.md` remain.
- `task.Engine` passes `tasks.cwd` to every adapter. Separate tasks and parallel workers may therefore share a checkout.
- Workspace list/read APIs safely contain paths but always resolve from `tasks.cwd`.
- Changed files are inferred from tool events. `CodeViewer` is a read-only Monaco editor, not a diff view.
- Retry truncates events and clears agent session state. Fork copies an event prefix. Neither operation restores or clones filesystem state.
- SQLite schema version is 4. Existing tasks must keep working without manual migration.

## 3. Approaches considered

### A. Git-native worktrees plus private Git snapshot objects — selected

Git already models repository identity, branches, renames, committed changes, and efficient object reuse. One worktree per Kin task prevents cross-task edits from colliding. A private object directory plus a temporary index provides compact turn snapshots without placing checkpoint-only objects in the user's repository. This approach is more involved than task-level worktrees alone, but it solves isolation, diff, discard, Retry, and Fork with one consistent model.

### B. Worktrees plus task-level discard only

This would close most parallel-safety issues quickly, but Retry and Fork would remain conversation-only. It is acceptable as an intermediate commit, not as the final acceptance state.

### C. Filesystem copies or containers

Copies appear simple but become incorrect around ignored secrets, symlinks, file modes, large repositories, and external edits. Containers offer a stronger execution boundary but do not match the user's real local environment and add substantial packaging complexity. Neither is justified for the current product.

## 4. High-level architecture

```text
New task request
  workspace_mode: auto | shared | worktree
        |
        v
internal/workspace.Manager
  Probe source cwd
  Prepare task worktree
  Capture / restore private checkpoint trees
  List changes / read old+new file versions
        |
        +--> ~/.kin/worktrees/<task-id>
        +--> ~/.kin/checkpoints/<task-id>/objects
        |
        v
task.Engine
  tasks.cwd             original grouping/provenance path
  task.execution_cwd    adapter + terminal + file API path
  task checkpoints      user event seq -> HEAD + private tree
        |
        v
HTTP API
  probe · changes · diff · restore
        |
        v
React desktop
  isolation choice · workspace/diff tabs · review draft · terminal
```

The workspace service is injected into the task engine. Adapters do not import Git code. The API uses the same service for diff data and effective workspace resolution. Terminal routes remain loopback-only and use `task.execution_cwd` only as a client-provided starting path; they do not become task history.

## 5. Task workspace semantics

`tasks.cwd` never changes meaning: it is the directory the user selected and the value used to group sessions. New persisted fields describe where execution actually occurs.

| Field | Meaning |
|---|---|
| `workspace_mode` | Resolved `shared` or `worktree` mode |
| `workspace_source_root` | Original Git top-level directory, or selected cwd for non-Git |
| `workspace_root` | Active checkout root; worktree root when isolated |
| `execution_cwd` | Directory passed to adapters and terminal; preserves a selected repository subdirectory |
| `workspace_scope` | Slash-separated path from checkout root to selected cwd; `.` at root |
| `workspace_base_oid` | Commit used as the diff baseline |
| `workspace_branch` | Kin-created branch for isolated tasks |

`auto` selects worktree only for a clean, non-bare repository with a resolvable `HEAD` and usable Git binary. Dirty Git repositories use shared mode because silently omitting source changes is worse than losing isolation. The new-chat UI shows the probe result and offers an explicit override.

Existing rows migrate as shared tasks with `execution_cwd=cwd`; their other workspace fields may remain empty. Code must always use a single `EffectiveCwd()` helper so historical rows do not require data rewriting.

## 6. Checkpoint lifecycle

For isolated tasks only, a checkpoint represents the files immediately before a user message is executed. It stores `task_id`, the user event `seq`, current task-branch `head_oid`, private `tree_oid`, size, and creation time.

Capture uses a temporary index and task-private Git objects:

1. Resolve the repository's normal object directory.
2. Create `~/.kin/checkpoints/<task-id>/objects` with mode `0700`.
3. Set `GIT_INDEX_FILE` to a new temporary path, `GIT_OBJECT_DIRECTORY` to the private object directory, and `GIT_ALTERNATE_OBJECT_DIRECTORIES` to the normal object directory.
4. Run `git read-tree HEAD`, `git add -A -- <scope>`, and `git write-tree`.
5. Delete the temporary index and persist the returned tree OID with the real `HEAD` OID.

Before capture, enumerate changed/untracked non-ignored files and enforce 16 MiB per file and 256 MiB aggregate limits. Exceeding a limit emits `checkpoint_skipped`; it does not stop the task.

Restore first resets the isolated task branch to the saved `head_oid`, removes later untracked files, materializes the private tree with `git read-tree --reset -u`, then resets the real index to `head_oid` while retaining restored working-tree content. Retry restores before truncating events. Fork creates a new worktree at the saved `head_oid`, materializes the tree, and captures a new initial checkpoint owned by the fork.

## 7. Diff and review flow

The change list compares the current workspace against `workspace_base_oid`, so it includes changes even when an agent committed them. Tracked paths come from NUL-delimited `git diff --name-status -z -M <base> -- <scope>`. Untracked paths come from `git ls-files --others --exclude-standard -z -- <scope>`. Paths are normalized to the selected task scope before returning them.

For one selected path, the service returns:

```json
{
  "path": "internal/foo.go",
  "old_path": null,
  "status": "modified",
  "old_content": "...",
  "new_content": "...",
  "old_truncated": false,
  "new_truncated": false,
  "binary": false
}
```

Old tracked content comes from `git show <base>:<repo-relative-path>`. New content comes from the effective workspace. Added/untracked files have an empty old side; deleted files have an empty new side. Binary or oversized content is listed but not loaded into Monaco.

The workspace panel gains Files and Changes tabs. Changes renders a change list and Monaco `DiffEditor`. A user can select a side and line, enter a comment, review a client-side list, and submit all comments as one deterministic follow-up prompt. Draft comments are deliberately not persisted in P0.

## 8. Error handling and safety

- All Git commands use `exec.CommandContext`, argument arrays, `GIT_TERMINAL_PROMPT=0`, bounded deadlines, and bounded stderr.
- Explicit worktree creation is all-or-nothing. If database insertion fails after `git worktree add`, cleanup removes only the validated Kin-owned path and branch.
- Automatic mode may fall back to shared only for an unsupported/dirty probe result, never after a partially created worktree.
- Restore/discard require a terminal task and isolated workspace. They are never available for shared tasks.
- Restore completes before event truncation. A Git or filesystem error leaves task history untouched.
- Workspace reads retain existing traversal, symlink, binary, UTF-8, and size protections.
- No cleanup command accepts a path derived directly from the request. It resolves the task, uses stored metadata, and verifies containment below the configured state directory.
- Worktree/checkpoint retention is visible and manual in this release. Silent timed deletion is deferred because task branches may contain unmerged work.

## 9. Verification

The implementation uses TDD at package boundaries:

- Git repository fixtures cover clean/dirty/non-Git/unborn/nested cwd probes, worktree containment, branch creation, committed/staged/unstaged/untracked/rename/delete diffs, private checkpoint capture, exact restore, and fork state.
- Migration tests cover fresh and populated version-4 databases.
- Engine tests verify adapters receive `execution_cwd`, checkpoints align with user event sequences, restore precedes Retry truncation, and failures do not mutate events.
- API tests cover auth, status codes, traversal, binary/large files, shared-mode rejection, and response shapes.
- Vitest covers workspace-mode resolution, review-prompt serialization, and change sorting.
- Electron verification covers terminal persistence, worktree task creation, diff review, review submission, Retry with file restore, Fork independence, and discard at desktop and narrow widths.

Full completion requires `go test ./...`, `go vet ./...`, race tests for workspace/task packages, UI tests/typecheck/build, Electron smoke verification, regenerated `web/dist`, and a clean working tree.
