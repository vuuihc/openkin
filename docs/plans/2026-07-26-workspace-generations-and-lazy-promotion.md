# Workspace Generations and Lazy Promotion Implementation Plan

> **For Claude / gpt-5.6-luna-medium:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Do not combine tasks or skip the red/green checks.

**Goal:** Decouple long-lived task conversations from physical Git worktrees, promote read-only Codex/Claude turns into new writable workspace generations on demand, make Kin own merge/release, and preserve generation-aware file browsing and diffs after worktree deletion.

**Architecture:** `Task` remains the conversation aggregate. A new `task_workspaces` table stores ordered workspace generations, `tasks.current_workspace_id` points to the one open generation, and `task_turn_workspaces` binds each user turn to the generation/access mode that executed it. Lazy-capable adapters run the source checkout under an enforced read-only access contract and request a workspace through the existing Kin MCP bridge; unsupported adapters retain eager worktree preparation. Kin finalizes only clean committed workspaces, persists the final tree, fast-forwards the recorded target branch, and releases the physical worktree. File APIs address `{workspace_id, repo-relative path}` and use live files before release or recorded Git trees afterward.

**Tech Stack:** Go 1.x daemon and CLI, modernc SQLite, Git worktrees/private object directories, React 18 + TypeScript + Zustand, Vitest, Vite, Electron sidecar.

---

## Executor contract

Read [ADR 0014](../adr/0014-workspace-generations-and-lazy-promotion.md),
[ADR 0005](../adr/0005-isolated-task-workspaces.md), `PRINCIPLE.md`, and
`SYSTEM_DESIGN.md` before editing.

Hard invariants:

1. A task conversation may have zero or many workspace generations, but no more
   than one open generation.
2. Source-read-only access overrides `default`, `accept_edits`, and `yolo`.
3. No error path may silently run writable against the primary checkout.
4. Agents never remove their current Kin worktree. Only the workspace runtime
   releases it after the final snapshot and integration record are durable.
5. Kin finalization is fast-forward only. If the target advanced, resolve in
   the task worktree and retry; never leave conflicts in the primary checkout.
6. UI and API file identities are `workspace_id + repo-relative path`; do not
   derive worktree paths from `task.cwd`.
7. Keep the legacy task workspace columns as compatibility projections in this
   change. Do not drop them in migration 013.
8. Do not implement shell-text mutation classification.
9. Do not implement lazy promotion for generic CLI, Grok, raw PTY, or Kin host
   in this slice. Those agents retain eager `auto` isolation. Claude Code and
   Codex advertise lazy capability only after their installed CLI passes the
   compatibility probe added in Task 5; otherwise they also remain eager.
10. A read-only orchestration wave is permitted only when every selected worker
    registration passes the runtime probe; never mix source-read-only and
    writable workers in one wave.
11. Add no dependency.

Implement one task, run its focused checks, self-review its diff, and commit
before starting the next task. If an interface differs from this plan, update
the plan in the same commit instead of silently improvising.

## State and policy vocabulary

Use these exact persisted values:

```go
type WorkspacePolicy string

const (
	WorkspacePolicyAuto     WorkspacePolicy = "auto"
	WorkspacePolicyShared   WorkspacePolicy = "shared"
	WorkspacePolicyWorktree WorkspacePolicy = "worktree"
)

type WorkspaceState string

const (
	WorkspaceProvisioning WorkspaceState = "provisioning"
	WorkspaceReady        WorkspaceState = "ready"
	WorkspaceActive       WorkspaceState = "active"
	WorkspaceFinalizing   WorkspaceState = "finalizing"
	WorkspaceIntegrated   WorkspaceState = "integrated"
	WorkspaceReleased     WorkspaceState = "released"
	WorkspaceMergeBlocked WorkspaceState = "merge_blocked"
	WorkspaceFinalizeBlocked WorkspaceState = "finalize_blocked"
	WorkspaceOrphaned     WorkspaceState = "orphaned"
	WorkspaceLegacyPending WorkspaceState = "legacy_pending"
)
```

An “open” generation is one of `provisioning`, `ready`, `active`,
`finalizing`, `integrated`, `merge_blocked`, `finalize_blocked`, or
`legacy_pending`. `finalize_blocked` retains the physical worktree and accepts
a later completion request after the external condition is fixed.

---

### Task 1: Add migration 013 and workspace-generation storage

**Files:**

- Create: `internal/store/workspaces.go`
- Create: `internal/store/workspaces_test.go`
- Modify: `internal/store/migrate.go`
- Modify: `internal/store/checkpoints.go`
- Modify: `internal/store/checkpoints_test.go`
- Modify: `internal/store/store.go`

**Step 1: Write failing migration and store tests**

Add tests with these exact behaviors:

```go
func TestMigration013BackfillsLegacyWorktree(t *testing.T)
func TestWorkspaceGenerationLifecycle(t *testing.T)
func TestOnlyOneOpenWorkspacePerTask(t *testing.T)
func TestCheckpointCarriesWorkspaceID(t *testing.T)
func TestTurnWorkspaceMappingFollowsPromotion(t *testing.T)
func TestTurnWorkspaceRejectsCrossTaskWorkspace(t *testing.T)
func TestTurnWorkspaceRejectsInvalidAccessCombinations(t *testing.T)
func TestUserEventAndTurnWorkspaceAreAtomic(t *testing.T)
func TestWorkspaceTransitionEventIsAtomic(t *testing.T)
```

The migration test must create a populated version-12 database containing:

- one task with `workspace_mode='worktree'` and legacy workspace metadata;
- one shared task; and
- one checkpoint for the worktree task.

After reopening:

- `PRAGMA user_version` is `13`;
- the worktree task has conservative `workspace_policy='worktree'` because the
  legacy resolved row cannot prove whether the user originally chose `auto`;
- it has deterministic generation-1 ID `<task-id>:g1`;
- generation 1 is `legacy_pending`;
- `tasks.current_workspace_id` points to it;
- its checkpoint has the same `workspace_id`;
- the shared task has `workspace_policy='shared'` and no generation.

The lifecycle test must cover insert, list, get current, compare-and-set state,
clear current, and list non-terminal generations. The uniqueness test must show
that a second open generation for the same task fails while released history
does not block generation 2.

Run:

```bash
go test ./internal/store -run 'Test(Migration013|WorkspaceGeneration|WorkspaceTransition|OnlyOneOpen|CheckpointCarries|TurnWorkspace|UserEventAndTurn)' -count=1
```

Expected: FAIL because schema version 13 and workspace store methods do not
exist.

**Step 2: Add migration 013**

Raise `schemaVersion` from 12 to 13. Add this schema to fresh `migration001` and
as the `v == 12` incremental migration:

```sql
CREATE TABLE task_workspaces (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation            INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  source_root           TEXT NOT NULL,
  scope                 TEXT NOT NULL DEFAULT '.',
  target_branch         TEXT NOT NULL DEFAULT '',
  workspace_branch      TEXT NOT NULL DEFAULT '',
  physical_root         TEXT NOT NULL DEFAULT '',
  execution_cwd         TEXT NOT NULL DEFAULT '',
  base_oid              TEXT NOT NULL DEFAULT '',
  review_base_oid       TEXT NOT NULL DEFAULT '',
  final_head_oid        TEXT NOT NULL DEFAULT '',
  final_tree_oid        TEXT NOT NULL DEFAULT '',
  integrated_oid        TEXT NOT NULL DEFAULT '',
  requested_execution_id TEXT NOT NULL DEFAULT '',
  requested_user_event_seq INTEGER NOT NULL DEFAULT 0,
  completed_execution_id TEXT NOT NULL DEFAULT '',
  failure_reason        TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  integrated_at         INTEGER,
  released_at           INTEGER,
  UNIQUE(task_id, generation),
  UNIQUE(id, task_id)
);

CREATE UNIQUE INDEX task_workspaces_one_open
ON task_workspaces(task_id)
WHERE state IN (
  'provisioning', 'ready', 'active',
  'finalizing', 'integrated', 'merge_blocked', 'finalize_blocked',
  'legacy_pending'
);

CREATE INDEX task_workspaces_task_generation
ON task_workspaces(task_id, generation);

CREATE TABLE task_turn_workspaces (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_event_seq INTEGER NOT NULL,
  workspace_id   TEXT,
  access         TEXT NOT NULL CHECK (
    access IN ('pending_isolation', 'source_read_only', 'writable', 'shared')
  ),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (
    (access IN ('pending_isolation', 'source_read_only', 'shared') AND workspace_id IS NULL)
    OR (access = 'writable' AND workspace_id IS NOT NULL)
  ),
  PRIMARY KEY(task_id, user_event_seq),
  FOREIGN KEY(task_id, user_event_seq) REFERENCES events(task_id, seq) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, task_id) REFERENCES task_workspaces(id, task_id)
);
```

Add nullable `tasks.current_workspace_id`, non-null
`tasks.workspace_policy DEFAULT 'auto'`, and non-null
`task_checkpoints.workspace_id DEFAULT ''`. Do not add a circular foreign key
from `tasks.current_workspace_id`; validate it in store transactions instead.

Backfill with deterministic IDs:

```sql
INSERT INTO task_workspaces (
  id, task_id, generation, state, source_root, scope,
  workspace_branch, physical_root, execution_cwd, base_oid,
  created_at, updated_at
)
SELECT
  id || ':g1', id, 1, 'legacy_pending',
  workspace_source_root, workspace_scope,
  workspace_branch, workspace_root, execution_cwd, workspace_base_oid,
  created_at, created_at
FROM tasks
WHERE workspace_mode = 'worktree' AND workspace_root <> '';

UPDATE tasks
SET current_workspace_id = id || ':g1', workspace_policy = 'worktree'
WHERE workspace_mode = 'worktree' AND workspace_root <> '';

UPDATE tasks
SET workspace_policy = 'shared'
WHERE workspace_mode <> 'worktree';

UPDATE task_checkpoints
SET workspace_id = task_id || ':g1'
WHERE workspace_id = ''
  AND EXISTS (
    SELECT 1 FROM tasks
    WHERE tasks.id = task_checkpoints.task_id
      AND tasks.current_workspace_id = task_checkpoints.task_id || ':g1'
  );
```

Follow the transaction/error style of migrations 009–012. Keep upgrade coverage
for both empty and populated databases.

**Step 3: Add store types and transactional methods**

In `internal/store/workspaces.go`, add `WorkspaceGeneration` and:

```go
func (s *Store) InsertWorkspace(ctx context.Context, ws WorkspaceGeneration) error
func (s *Store) CreateWorkspaceProvisioning(
	ctx context.Context, ws WorkspaceGeneration, event WorkspaceEvent,
) (WorkspaceGeneration, Event, error)
func (s *Store) ActivatePreparedWorkspace(
	ctx context.Context, transition WorkspaceReadyTransition,
) (WorkspaceGeneration, TaskCheckpoint, Event, error)
func (s *Store) GetWorkspace(ctx context.Context, id string) (WorkspaceGeneration, error)
func (s *Store) GetCurrentWorkspace(ctx context.Context, taskID string) (WorkspaceGeneration, error)
func (s *Store) GetOpenWorkspace(ctx context.Context, taskID string) (WorkspaceGeneration, error)
func (s *Store) GetWorkspaceByCompletionExecution(ctx context.Context, taskID, executionID string) (WorkspaceGeneration, error)
func (s *Store) ListTaskWorkspaces(ctx context.Context, taskID string) ([]WorkspaceGeneration, error)
func (s *Store) ListOpenWorkspaces(ctx context.Context) ([]WorkspaceGeneration, error)
func (s *Store) AppendUserEventWithTurnWorkspace(
	ctx context.Context, taskID string, payload json.RawMessage, turn TaskTurnWorkspace,
) (Event, TaskTurnWorkspace, error)
func (s *Store) PutLegacyTurnWorkspace(ctx context.Context, turn TaskTurnWorkspace) error
func (s *Store) GetTurnWorkspace(ctx context.Context, taskID string, userEventSeq int) (TaskTurnWorkspace, error)
func (s *Store) TransitionWorkspace(
	ctx context.Context, id string, from []WorkspaceState, patch WorkspacePatch,
) (WorkspaceGeneration, error)
func (s *Store) ApplyWorkspaceTransition(
	ctx context.Context, transition WorkspaceTransition,
) (WorkspaceGeneration, Event, error)
func (s *Store) SetCurrentWorkspace(ctx context.Context, taskID, workspaceID string) error
func (s *Store) ClearCurrentWorkspace(ctx context.Context, taskID, workspaceID string) error
```

`TransitionWorkspace` must execute one `UPDATE ... WHERE id=? AND state IN (...)`
and return `task.ErrConflict`-equivalent store error when `RowsAffected != 1`.
Do not read then update outside a transaction.

`ApplyWorkspaceTransition` is the product-lifecycle path. In one SQLite
transaction it must:

1. compare-and-set the workspace state;
2. apply an optional task pointer/legacy-projection patch;
3. append exactly one lifecycle event using `nextEventSeq`; and
4. return the committed workspace and event for WebSocket publication.

Add `TestWorkspaceTransitionEventIsAtomic`: inject a failure after the
workspace update but before event insert and prove neither state nor task
pointer changed. Creation, finalizing, merged, released, blocked, and recovered
events must use this method rather than separate store calls.

`CreateWorkspaceProvisioning` requires the caller to populate
`requested_execution_id` and `requested_user_event_seq` before the transaction
starts and atomically inserts that row and its `workspace_provisioning` event.
The first transaction therefore contains the idempotency and turn-binding keys;
no later patch may add them.
`ActivatePreparedWorkspace` atomically
compare-and-sets `provisioning → ready`, writes physical metadata, sets the
task current pointer and legacy projections, updates the current turn mapping
from `workspace_id=NULL` with access equal to either `source_read_only` or
`pending_isolation` to `(workspace_id=<new-id>, access=writable)`, allocates and appends
`workspace_created`, and inserts the initial checkpoint with
`event_seq=requested_user_event_seq`. The lifecycle event has its independently
allocated later sequence; retry keys checkpoints by the selected user turn, not
by the lifecycle event. The prepared tree passed into the transaction has no
event sequence; checkpoint/event sequence assignment happens only inside this
transaction. Add failure injection after each statement and prove full
rollback. A workspace may never become `ready` without its initial checkpoint
and turn mapping. Add a promoted-turn restore test proving an exact
`GetCheckpointForWorkspace(taskID, requested_user_event_seq, workspaceID)`
lookup succeeds.

The turn update is a compare-and-set on `(task_id,
requested_user_event_seq, workspace_id IS NULL, expected access)` and must
affect exactly one row. A missing or already rebound turn rolls back the whole
ready transition.

Extend `Task`, `scanTask`, `taskColumns`, `InsertTask`, and `TaskPatch` with:

```go
WorkspacePolicy    string `json:"workspace_policy"`
CurrentWorkspaceID string `json:"current_workspace_id,omitempty"`
```

Extend `TaskCheckpoint` and all checkpoint queries with `WorkspaceID`.
`TaskTurnWorkspace.access` accepts `pending_isolation`, `source_read_only`,
`writable`, and `shared`. `pending_isolation` is an engine-only queued state
that must never cross the adapter boundary.
`AppendUserEventWithTurnWorkspace` allocates the user event sequence
and inserts its turn row in one transaction: point it at the current open
generation, or leave `workspace_id` null for a source-read-only turn. Use it for
task creation, follow-up, retry-created prompts, and fork creation; no
production path may append a user message separately. Promotion updates that
same row in the ready transaction. `PutLegacyTurnWorkspace` exists only for the
bounded migration-compatibility resolution in Task 10. This is the durable
boundary used by retry/fork; do not infer it from whichever lifecycle event
happened to follow the user event.
Add:

```go
func (s *Store) GetCheckpointForWorkspace(
	ctx context.Context, taskID string, eventSeq int, workspaceID string,
) (TaskCheckpoint, error)
```

The workspace ID must be part of the SQL predicate.

**Step 4: Run focused and package tests**

```bash
gofmt -w internal/store/workspaces.go internal/store/workspaces_test.go \
  internal/store/migrate.go internal/store/checkpoints.go \
  internal/store/checkpoints_test.go internal/store/store.go
go test ./internal/store -count=1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/store/workspaces.go internal/store/workspaces_test.go \
  internal/store/migrate.go internal/store/checkpoints.go \
  internal/store/checkpoints_test.go internal/store/store.go
git commit -m "feat(store): persist task workspace generations"
```

---

### Task 2: Make workspace preparation generation-aware

**Files:**

- Modify: `internal/workspace/types.go`
- Modify: `internal/workspace/git.go`
- Modify: `internal/workspace/git_test.go`
- Modify: `internal/workspace/prepare.go`
- Modify: `internal/workspace/prepare_test.go`
- Modify: `internal/workspace/probe.go`
- Modify: `internal/workspace/probe_test.go`
- Modify: `internal/workspace/checkpoint.go`
- Modify: `internal/workspace/checkpoint_test.go`

**Step 1: Write failing runtime tests**

Add:

```go
func TestPrepareGenerationUsesStablePathAndBranch(t *testing.T)
func TestPrepareGenerationTwoAfterRelease(t *testing.T)
func TestPrepareGenerationRejectsDirtySource(t *testing.T)
func TestCaptureGenerationUsesTaskCheckpointObjectStore(t *testing.T)
func TestManagerGitDisablesHooksForPrepareCaptureRestoreAndFork(t *testing.T)
```

Expected generation-2 identifiers:

```text
path:   <state>/worktrees/<TASK-ID>-g2
branch: kin/task/<lowercase-task-id>/g2
```

Generation 1 for newly created tasks follows the same `-g1` and `/g1` format.
Legacy generation metadata is never rewritten.

Run:

```bash
go test ./internal/workspace -run 'Test(PrepareGeneration|CaptureGeneration|ManagerGitDisablesHooks)' -count=1
```

Expected: FAIL because the generation-aware methods do not exist.

**Step 2: Extend runtime metadata**

Add:

```go
type SourceMetadata struct {
	Cwd          string
	SourceRoot   string
	Scope        string
	TargetBranch string
	HeadOID      string
	Dirty        bool
}

type Metadata struct {
	WorkspaceID string
	TaskID      string
	Generation  int
	// existing fields remain
}
```

Extend `ProbeResult` with the checked-out local branch from:

```bash
git symbolic-ref --quiet --short HEAD
```

Detached HEAD is valid for read-only use but cannot lazily promote; return a
specific `ErrDetachedHead`.

**Step 3: Implement generation preparation**

Add:

```go
func (m *Manager) ResolveSource(ctx context.Context, cwd string) (SourceMetadata, error)
func (m *Manager) PrepareGeneration(
	ctx context.Context,
	taskID string,
	generation int,
	source SourceMetadata,
) (Metadata, error)
func (m *Manager) InspectGeneration(ctx context.Context, meta Metadata) (Inspection, error)
```

`PrepareGeneration` must:

- validate task ID and `generation > 0`;
- re-probe the source immediately before creation;
- require the recorded target branch to still be checked out;
- reject a dirty source;
- base the new branch on the source branch's current `HEAD`, not the task's
  original base;
- use argument-array Git calls with
  `-c core.hooksPath=<Kin-state>/empty-hooks` for every command; and
- remove only the path it created if `git worktree add` fails.

Create `<Kin-state>/empty-hooks` as a Kin-owned `0700` empty directory and
validate its containment before use. Centralize argument construction in the
workspace Manager's Git runner so every manager-owned Git invocation—probe,
prepare, capture, restore, fork, finalize, release, and recovery—receives the
override; individual call sites may not opt out. In particular, `git worktree
add`, index/tree operations, restore, and fork must not run repository
`post-checkout` or `post-index-change` hooks. Add fixtures whose hooks write
markers outside the repository and prove prepare, `Capture`,
`CapturePrepared`, restore, and fork leave every marker absent.

Update containment checks to accept the new flat generation path. Keep legacy
`<state>/worktrees/<task-id>` valid only when supplied by migrated metadata.

`Capture` keeps private objects under `checkpoints/<task-id>/objects`, but the
returned checkpoint includes `WorkspaceID`. Add `CapturePrepared`, which writes
the same private Git objects but returns checkpoint tree data without an
`event_seq`. In the ready transaction, `ActivatePreparedWorkspace` assigns the
prepared checkpoint `requested_user_event_seq` for exact retry lookup and
independently allocates `workspace_created` with `nextEventSeq`.

**Step 4: Run tests**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/workspace -count=1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/workspace/types.go internal/workspace/git.go \
  internal/workspace/git_test.go internal/workspace/prepare.go \
  internal/workspace/prepare_test.go internal/workspace/probe.go \
  internal/workspace/probe_test.go internal/workspace/checkpoint.go \
  internal/workspace/checkpoint_test.go
git commit -m "feat(workspace): prepare isolated generations"
```

---

### Task 3: Add workspace access to adapter and event contracts

**Files:**

- Modify: `internal/adapter/adapter.go`
- Create: `internal/adapter/workspace_access.go`
- Create: `internal/adapter/workspace_access_test.go`
- Modify: `internal/agent/types.go`
- Modify: `internal/agent/registry.go`
- Modify: `internal/agent/registry_test.go`
- Modify: `internal/task/event_meta.go`
- Modify: `internal/task/event_meta_test.go`
- Modify: `internal/task/engine.go`
- Modify: `internal/task/engine_test.go`
- Modify: `internal/task/orchestrate.go`
- Modify: `internal/task/orchestrate_test.go`

**Step 1: Write failing contract tests**

Test:

```go
func TestNormalizeWorkspaceAccess(t *testing.T)
func TestApplyAttributionIncludesWorkspace(t *testing.T)
func TestSingleRunCarriesWorkspaceIdentity(t *testing.T)
func TestReadOnlyAccessOverridesPermissionAtSpecBoundary(t *testing.T)
```

Use:

```go
const (
	WorkspaceAccessSourceReadOnly = "source_read_only"
	WorkspaceAccessWritable       = "writable"
)
```

`pending_isolation` belongs only to `task_turn_workspaces`; constructing an
adapter `TaskSpec` from a pending turn is an error.

Extend `TaskSpec` and `ExecutionRef`:

```go
WorkspaceAccess     string
WorkspaceID         string
WorkspaceGeneration int
WorkspaceRoot       string // physical repository root; never serialized to events
WorkspaceScope      string // slash-separated path from repository root to Cwd
```

Add agent capability:

```go
agent.CapabilityLazyWorkspace
```

Only Claude Code and Codex may declare it in this slice, and only when the
adapter type implements the protocol. This static descriptor capability is
necessary but not sufficient: the installed CLI must also pass the Task 5
runtime compatibility probe.

Add runtime support to `agent.Registration` instead of mutating a shared
descriptor:

```go
type LazyWorkspaceSupport struct {
	Supported bool   `json:"supported"`
	Version   string `json:"version,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type Registration struct {
	// existing fields
	LazyWorkspace func(context.Context) LazyWorkspaceSupport
}
```

`agent.Registry.LazyWorkspaceSupport(ctx, agentID)` first checks the static
descriptor capability, then invokes the callback. It returns an unsupported
zero value when either is absent. The task engine consults this method; agent
ID or static capability alone must never select lazy execution.

Run:

```bash
go test ./internal/adapter ./internal/agent ./internal/task -run 'Test(NormalizeWorkspace|LazyWorkspaceSupport|ApplyAttributionIncludesWorkspace|SingleRunCarriesWorkspace|ReadOnlyAccess)' -count=1
```

Expected: FAIL.

**Step 2: Implement the contract**

`ApplyAttribution` must stamp:

```json
{
  "workspace_id": "...",
  "workspace_generation": 2,
  "workspace_path": "ui/src/App.tsx"
}
```

Define one canonicalization helper:

```go
func CanonicalRepoPath(root, executionCwd, scope, reportedPath string) (string, error)
```

- absolute inputs must be contained by `root` after symlink-aware validation,
  then become `filepath.Rel(root, input)`;
- relative inputs are interpreted relative to `executionCwd`, then prefixed by
  normalized `scope`;
- output is clean slash-separated repository-relative text, never `.` or
  traversal; and
- provider raw paths remain unchanged in their original field;
  `workspace_path` is the canonical field consumed by the UI.

Add nested-scope tests where `scope=ui`, `execution_cwd=<root>/ui`, and both
`src/App.tsx` and `<root>/ui/src/App.tsx` normalize to
`ui/src/App.tsx`. Also reject `<root>/../secret`, sibling paths, symlink
escapes, and empty paths. Already-canonical API diff paths bypass this helper;
do not feed them back through cwd-relative normalization.

Every host and orchestrated worker in one task turn receives the same workspace
identity. A read-only run has no workspace ID and
`workspace_access=source_read_only`.

Before every adapter `Start`, validate `spec.Cwd` with `os.Stat` and return:

```text
task execution directory is unavailable: <path>
```

Implement `adapter.WithCwdValidation(Adapter)` once and have
`agent.Build` wrap every non-nil registered runner. This covers Codex, Claude,
Grok, generic CLI, raw PTY, Kin, and future plugins without six divergent
checks. Add registry tests proving every runner is wrapped and the underlying
`Start` is not called for a missing/not-directory cwd. Do not keep
provider-specific misleading `fork/exec` errors.

**Step 3: Run tests**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/adapter/... ./internal/agent/... ./internal/task/... -count=1
```

Expected: PASS.

**Step 4: Commit**

```bash
git add internal/adapter/adapter.go internal/adapter/workspace_access.go \
  internal/adapter/workspace_access_test.go internal/agent/types.go \
  internal/agent/registry.go internal/agent/registry_test.go \
  internal/task/event_meta.go internal/task/event_meta_test.go \
  internal/task/engine.go internal/task/engine_test.go \
  internal/task/orchestrate.go internal/task/orchestrate_test.go
git commit -m "feat(adapter): carry workspace access and identity"
```

---

### Task 4: Extend the Kin MCP bridge for workspace lifecycle requests

**Files:**

- Modify: `internal/approvemcp/server.go`
- Modify: `internal/approvemcp/server_test.go`
- Modify: `internal/approvemcp/bridge_test.go`
- Create: `internal/execcap/capability.go`
- Create: `internal/execcap/capability_test.go`
- Create: `internal/adapter/capability_file.go`
- Create: `internal/adapter/capability_file_test.go`
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`
- Create: `internal/api/workspace_lifecycle.go`
- Create: `internal/api/workspace_lifecycle_test.go`
- Create: `internal/task/workspace_lifecycle.go`
- Create: `internal/task/workspace_lifecycle_test.go`
- Modify: `internal/task/engine.go`
- Modify: `internal/task/engine_test.go`
- Modify: `internal/adapter/codex/plugin.go`
- Modify: `internal/adapter/codex/adapter.go`
- Modify: `internal/adapter/codex/adapter_test.go`
- Modify: `internal/adapter/claudecode/plugin.go`
- Modify: `internal/adapter/claudecode/adapter.go`
- Modify: `internal/adapter/claudecode/adapter_test.go`
- Modify: `cmd/kin/main.go`
- Modify: `internal/server/agents.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_test.go`

**Step 1: Write failing bridge and API tests**

Add:

```go
func TestToolsListIncludesWorkspaceLifecycle(t *testing.T)
func TestRequestWorkspacePostsAttributedIntent(t *testing.T)
func TestCompleteWorkspacePostsAttributedIntent(t *testing.T)
func TestBridgeReadsExecutionCapabilityFile(t *testing.T)
func TestWorkspaceIntentRejectsWrongExecution(t *testing.T)
func TestExecutionCapabilityCannotAccessPublicAPI(t *testing.T)
func TestExecutionCapabilityCannotCrossTaskOrScope(t *testing.T)
func TestExecutionCapabilityExpiresAndDiesOnIssuerRestart(t *testing.T)
func TestExecutionCapabilityRevokedWhenExecutionEnds(t *testing.T)
func TestWritableExecutionUsesCapabilityFileForApprovalMCP(t *testing.T)
func TestServerSharesOneExecutionCapabilityIssuerWithAdaptersAndAPI(t *testing.T)
```

Expose these MCP tools:

```json
{
  "name": "request_workspace",
  "description": "Create a writable Kin workspace for the current task. Call once before any source modification while the current run is read-only, then end the turn so Kin can resume it in the workspace.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "reason": {"type": "string"}
    }
  }
}
```

```json
{
  "name": "complete_workspace",
  "description": "Mark the current clean, committed Kin workspace ready for snapshot, fast-forward integration, and release. Call only after review and tests, then end the turn.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "summary": {"type": "string"},
      "checks": {"type": "array", "items": {"type": "string"}}
    }
  }
}
```

Internal routes:

```text
POST /internal/capabilities/introspect
POST /internal/tasks/{id}/workspace/request
POST /internal/tasks/{id}/workspace/complete
```

Both bodies carry execution ID, agent, step, model, and optional tool fields.
They require the true loopback peer and a scoped execution capability. They do
not accept the execution capability on public `/api/*` routes.

Run:

```bash
go test ./internal/approvemcp ./internal/execcap ./internal/api ./internal/task \
  ./internal/server/... \
  ./internal/adapter/codex ./internal/adapter/claudecode \
  -run 'Test(ToolsListIncludesWorkspace|RequestWorkspace|CompleteWorkspace|BridgeReadsExecution|ExecutionCapability|WorkspaceIntent|WritableExecutionUsesCapability|ServerSharesOneExecution)' -count=1
```

Expected: FAIL.

**Step 2: Replace agent access to the global bearer with scoped capabilities**

The existing bridge receives the daemon-wide bearer and can therefore call
unrelated APIs if an agent reads it. Do not pass the global token or its file
path to any adapter.

In `internal/execcap`, implement a compact HMAC-SHA256 capability. Generate a
dedicated random 32-byte signing key at daemon start and never persist,
serialize, log, or derive it from the global bearer. A daemon restart therefore
invalidates every outstanding execution capability without coupling them to
user-facing token rotation. Claims are:

```go
type Claims struct {
	TaskID      string   `json:"task_id"`
	ExecutionID string   `json:"execution_id"`
	Agent       string   `json:"agent"`
	Step        int      `json:"step,omitempty"`
	Model       string   `json:"model,omitempty"`
	Scopes      []string `json:"scopes"`
	ExpiresAt   int64    `json:"expires_at"`
	Nonce       string   `json:"nonce"`
}
```

Use exact scopes:

```text
approval:create
approval:wait
question:create
question:wait
workspace:request
workspace:complete
```

`Issue` requires a non-empty task/execution ID, a 32-byte random nonce, and an
expiry no later than the execution context deadline or 10 minutes. `Verify`
uses constant-time MAC comparison, validates expiry, required scope, route task
ID, and request-body execution attribution. The issuer also keeps an in-memory
active-nonce set: atomic rotation activates the new nonce before retiring the
old one, and adapter exit revokes every nonce for that execution immediately.
`Verify` requires both a valid MAC and an active nonce.

Create exactly one issuer in `internal/server/server.go` during daemon
composition, before building the agent registry or API server. Inject that same
instance into `buildAgentRegistry` for adapter issue/rotate/revoke callbacks and
into `api.Server` for `/internal/*` verification. Do not construct an issuer in
`cmd/kin/main.go` or independently in either consumer. Add a composition test:
a capability issued through the registry-side callback passes the composed
internal route; rebuilding the server/issuer makes that old capability fail.

In `internal/api/api.go`, keep `s.Auth.Middleware` unchanged for public
`/api/*`. Replace it only on the true-loopback `/internal/*` MCP group with
execution-capability authentication. Scope and attribution checks remain in
the handler because wait routes must load the approval/question row before they
can compare its task and execution claims:

- create approval: `approval:create`;
- wait approval: `approval:wait` plus stored row attribution;
- create question: `question:create`;
- wait question: `question:wait` plus stored row attribution;
- request/complete: corresponding workspace scope plus route/body attribution.

The daemon-wide bearer must receive 401 on these agent-only internal routes
after migration, just as an execution capability receives 401 on public routes.
Approval/question wait handlers cap each long poll at the earlier of 30
seconds or capability expiry and return a retryable no-decision response. The
bridge then rereads the rotated capability file before polling again; an
expired/revoked token may not authorize an indefinitely open request.

Source-read-only host runs receive `workspace:request` plus
`question:create|wait`, preserving normal clarification without write access.
Writable host runs receive `workspace:complete` plus the approval/question
scopes their permission mode needs. Orchestrated workers receive
approval/question scopes only; they never receive workspace lifecycle scopes.

Write the issued token to a per-execution `0600` temporary file and expose only
its path as `KIN_CAPABILITY_FILE` in the MCP config. While the execution is
alive, rotate the file every five minutes by issuing a new token to a sibling
`0600` file, `fsync`/close, then atomic rename. This supports long-running
agents without a partially readable file.
Stop rotation and remove the file after the adapter and MCP child exit. The
provider may read this file, so security must come from its narrow claims, not
secrecy. Never put token contents or the global daemon token in argv, events,
logs, or snapshots. Test rotation with a fake clock and a long-lived fake
adapter.

Before answering `tools/list`, the bridge calls the true-loopback-only
introspection route with its current bearer. That route verifies the MAC and
returns only scopes/expiry; on failure the bridge exposes no tools.
`tools/list` filters by those verified scopes. A source-read-only host sees only
`request_workspace` and `ask_user_question`; a writable host sees
`complete_workspace` plus approval/question tools it is entitled to; a worker
never sees either workspace lifecycle tool.

Keep `approve-mcp` as the backward-compatible command name but update its help
text to “agent lifecycle and approval MCP server.” It reads the capability file
immediately before each HTTP request. Remove production wiring of `KIN_TOKEN`
from Claude; retain global-bearer support only in isolated legacy unit tests if
needed during the transition, with no server composition path that emits it.

Cut over Codex and Claude's existing approval/question MCP configuration in
this same task: every current writable execution must receive
`KIN_CAPABILITY_FILE`, and its capability scopes must preserve the approval and
question tools it had before this change. Add adapter tests proving ordinary
writable approval/question flows still work after the internal routes stop
accepting the daemon bearer. Task 5 tightens the provider argv/config for
source-read-only access; it must not be the first point where capability-file
authentication becomes usable.

**Step 3: Implement engine lifecycle intents and thin handlers**

Before adding `workspace_lifecycle.go`, extend `WorkspaceRuntime` in
`internal/task/engine.go` with `ResolveSource`, `PrepareGeneration`,
`CleanupPrepared`, `CapturePrepared`, `Capture`, `Restore`, and `PrepareFork`
using the Task 2 types. Update every engine/task fake in this task so the
repository compiles before implementing the lifecycle methods. Task 6 consumes
this interface; it does not introduce it.

The HTTP handlers only validate/authenticate/decode and call:

```go
Engine.RequestWorkspace(ctx, WorkspaceIntentRequest)
Engine.CompleteWorkspace(ctx, WorkspaceIntentRequest)
```

Map `store.ErrNotFound` to 404, task/execution/state conflict to 409, and
filesystem preparation failure to 422. Never mutate Git in the handler itself.

Implement the two engine methods in
`internal/task/workspace_lifecycle.go`. Both MCP `RequestWorkspace` and the
engine's eager pre-run path delegate to one unexported
`ensureWorkspace(ctx, WorkspaceProvisionRequest)` operation. The public method
requires a currently running source-read-only host; the eager caller supplies
the already allocated first host execution ID and a turn in
`pending_isolation`, and must complete before any adapter starts.
Use an internal-only exact cause enum:

```go
const (
	ProvisionFromHostRequest       WorkspaceProvisionCause = "host_request"
	ProvisionFromEagerPreRun       WorkspaceProvisionCause = "eager_pre_run"
	ProvisionFromOrchestrationPlan WorkspaceProvisionCause = "orchestration_plan"
)
```

`orchestration_plan` is accepted only from the engine scheduler for an intent
host execution whose adapter process has exited but whose logical execution is
still in the internal `intent_plan_check` phase, after an exact read-only
marker and a concrete plan containing an unsupported worker. It carries that
host execution ID and selected user event sequence, may update a
`source_read_only` turn, and is not representable through the HTTP/MCP body.
Revoke the adapter capability when its process exits as usual; keep only the
engine attribution until plan validation/provisioning completes.
In one per-task serialized operation, `ensureWorkspace`:

1. validates the cause-specific attribution: a running source-read-only host
   (MCP), the scheduler-owned pre-run execution plus `pending_isolation`
   (eager), or the engine-owned `intent_plan_check` state plus
   `source_read_only` turn (orchestration);
2. returns the open row for an idempotent retry from the same
   `requested_execution_id`, but rejects another open generation;
3. constructs the generation with `requested_execution_id` and
   `requested_user_event_seq` already present, then atomically inserts
   `provisioning` with its event;
4. prepares the deterministic generation;
5. captures its initial prepared tree without assigning an event sequence; and
6. atomically sets `ready`, physical metadata, task pointer/legacy projection,
   current turn mapping, initial checkpoint, and `workspace_created`; the
   checkpoint's `event_seq` is `requested_user_event_seq`, while
   `workspace_created` receives the next lifecycle sequence in the same
   transaction.

Preparation/checkpoint/ready failure cleans up safely and records an orphaned
blocked row as specified in Task 6.
`CompleteWorkspace` only validates host execution identity and atomically marks
the active generation `finalizing`; Task 7 consumes that durable state after
the process exits.

Add capability issuer callbacks to the Codex and Claude plugin configs and
consume them in the adapters in this task so `internal/server/agents.go`
compiles and existing MCP flows remain usable. Task 5 adds the stricter
workspace-access-specific argv/config.

MCP responses are immediate and instruct the agent to stop the current turn.
They do not long-poll.

**Step 4: Run tests and commit**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/approvemcp ./internal/execcap ./internal/api \
  ./internal/task ./internal/server/... ./internal/adapter/codex \
  ./internal/adapter/claudecode -count=1
git add internal/approvemcp/server.go internal/approvemcp/server_test.go \
  internal/approvemcp/bridge_test.go internal/execcap/capability.go \
  internal/execcap/capability_test.go \
  internal/adapter/capability_file.go \
  internal/adapter/capability_file_test.go \
  internal/api/workspace_lifecycle.go \
  internal/api/workspace_lifecycle_test.go internal/api/api.go \
  internal/api/api_test.go internal/task/workspace_lifecycle.go \
  internal/task/workspace_lifecycle_test.go \
  internal/task/engine.go internal/task/engine_test.go \
  internal/adapter/codex/plugin.go internal/adapter/codex/adapter.go \
  internal/adapter/codex/adapter_test.go \
  internal/adapter/claudecode/plugin.go \
  internal/adapter/claudecode/adapter.go \
  internal/adapter/claudecode/adapter_test.go \
  cmd/kin/main.go internal/server/agents.go internal/server/server.go \
  internal/server/server_test.go
git commit -m "feat(workspace): expose lifecycle requests to agents"
```

---

### Task 5: Enforce read-only adapter runs and attach the lifecycle MCP

**Files:**

- Modify: `internal/adapter/codex/plugin.go`
- Modify: `internal/adapter/codex/adapter.go`
- Modify: `internal/adapter/codex/permission_mode_test.go`
- Create: `internal/adapter/codex/workspace_access_test.go`
- Modify: `internal/adapter/claudecode/plugin.go`
- Modify: `internal/adapter/claudecode/adapter.go`
- Modify: `internal/adapter/claudecode/permission_mode_test.go`
- Create: `internal/adapter/claudecode/workspace_access_test.go`
- Create: `scripts/provider-workspace-conformance.sh`

**Step 1: Write failing argv tests**

Codex read-only expectations (Codex CLI 0.144.4 or a compatible newer build):

```text
--ignore-user-config
--ignore-rules
--strict-config
--sandbox read-only
-c features.hooks=false
-c projects."<canonical-source-root>".trust_level="untrusted"
-c mcp_servers.kin.command="..."
-c mcp_servers.kin.args=["approve-mcp"]
-c mcp_servers.kin.env={KIN_TASK_ID="...",KIN_CAPABILITY_FILE="...",...}
```

It must not contain `workspace-write` or
`--dangerously-bypass-approvals-and-sandbox`, even when task permission is
`accept_edits` or `yolo`.

Claude read-only expectations (Claude Code 2.1.220 or a compatible newer
build):

```text
--permission-mode plan
--mcp-config <temporary file>
--strict-mcp-config
--tools Read,Glob,Grep,mcp__kin__request_workspace,mcp__kin__ask_user_question
--allowedTools mcp__kin__request_workspace,mcp__kin__ask_user_question
--disallowedTools Bash,Edit,Write,NotebookEdit,Agent
--settings {"disableAllHooks":true,"disableArtifact":true,"disableClaudeAiConnectors":true}
```

It must not contain `acceptEdits`, `bypassPermissions`, or
`--dangerously-skip-permissions`. It must not pass
`--permission-prompt-tool`: a source-read-only run may invoke only the
explicitly allowed lifecycle request, never turn a denied mutation into a user
approval. `--tools` is the positive tool surface; the explicit deny list is
defense in depth and must name every known mutating built-in separately. Do not
assume that denying `Edit` implicitly removes `Write` or `NotebookEdit`.

Writable runs retain existing permission mappings. Lifecycle MCP remains
available in writable `yolo` runs, but Claude must not use it as the permission
prompt tool in bypass mode.

Run:

```bash
go test ./internal/adapter/codex ./internal/adapter/claudecode -run 'Test(WorkspaceAccess|PermissionMode)' -count=1
```

Expected: FAIL.

**Step 2: Add a fail-closed compatibility probe**

At registry construction, run `<binary> --version` and `<binary> --help` with a
five-second timeout. Normalize the version and required flags into:

```go
type LazyWorkspaceSupport = agent.LazyWorkspaceSupport
```

Codex requires `--sandbox`, `--ignore-user-config`, `--strict-config`, and
`--ignore-rules`, and `-c/--config`. Claude requires `plan`, `--strict-mcp-config`,
`--tools`, `--allowedTools`, `--disallowedTools`, and `--settings`. A timeout,
parse failure, missing flag, or uncertified version returns `Supported=false`
and a user-visible reason; it must not make the agent unavailable.

Use checked-in exact certified versions for the first slice:

```text
Codex:       0.144.4
Claude Code: 2.1.220
```

Unknown older or newer versions fail closed to eager isolation. A maintainer
may extend a version or range only in the same commit that records a passing
provider conformance run for that version line. Cache the result for the
lifetime of the registry.

For Codex, run one additional no-credential config audit with an empty temporary
`CODEX_HOME`, the source root as cwd, project trust forced to `untrusted`, and
hooks forced off:

```text
codex -c projects."<root>".trust_level="untrusted" \
  -c features.hooks=false mcp list --json
```

Lazy support requires an empty server list before Kin injects its own MCP.
`--ignore-user-config` removes the real user config at execution time, forced
untrusted project state suppresses `.codex/config.toml`, project hooks, and
project rules, `--ignore-rules` suppresses remaining user/project exec rules,
and `features.hooks=false` suppresses hooks. Any system/managed MCP found by the
audit disables lazy support.

Add table tests for current compatible help output, missing flags, malformed
versions, and command timeout. Include a Claude 2.1.220 fixture that exposes all
other required flags but omits `--tools`; it must be unsupported. The engine
uses this result, not agent ID alone, when choosing lazy versus eager `auto`.

**Step 3: Refactor argv construction into pure helpers**

Add package-private:

```go
func buildArgs(spec adapter.TaskSpec, cfg runtimeConfig) ([]string, error)
```

Do not test by executing a real provider. Use fake binaries as current
permission tests do.

For Codex, construct dotted `-c` overrides with TOML-safe quoted values. Pass
the capability-file path, never the token. Put all CLI options before the
prompt.
`--ignore-user-config` is mandatory for source-read-only runs so ambient hooks,
MCP servers, and permission settings cannot widen access. Force the canonical
source root to untrusted and disable hooks/rules as shown above.

Build new and resumed argv separately, with every exec-level safety and MCP
option before the `resume` subcommand:

```text
codex exec <safety-and-MCP-options> --json <prompt>
codex exec <safety-and-MCP-options> --json resume <session-id> <prompt>
```

Do not append `--sandbox`, `-c`, or other exec-level options after
`resume`; Codex 0.144.4 rejects that ordering. Add exact argv tests for both
forms.

For Claude, extend existing temporary MCP JSON. Set `KIN_CAPABILITY_FILE`.
Load only that MCP file with `--strict-mcp-config`; pass the inline settings
object shown above so ambient hooks/connectors cannot mutate or publish during
the read-only run.

Append this runtime instruction only for source-read-only runs:

```text
This turn is running against the project source checkout in enforced read-only
mode. You may inspect and answer normally. If source modification becomes
necessary, call mcp__kin__request_workspace exactly once with a short reason,
then end this turn. Do not ask the user to create it and do not attempt writes
before the tool returns.
```

Writable runs with an open workspace receive:

```text
You are running in Kin workspace generation <n>. Never remove this worktree or
its branch yourself. After changes are committed, reviewed, and verified, call
mcp__kin__complete_workspace, then end the turn.
```

**Step 4: Add contract and provider conformance tests**

Fake-binary CI tests capture the real argv and temporary config. For
`default`, `accept_edits`, and `yolo`, assert that:

1. source-read-only argv contains every required deny/sandbox flag;
2. only the Kin lifecycle MCP is loaded;
3. no token value appears in argv, config snapshots, or emitted events;
4. `request_workspace` is the only auto-approved lifecycle tool; and
5. an unsupported help/version fixture causes eager isolation.

A fake provider cannot prove the provider's own sandbox enforcement. Add
`scripts/provider-workspace-conformance.sh` as an opt-in release test gated by
`KIN_PROVIDER_CONFORMANCE=1`. It creates a disposable Git repository and fake
loopback daemon, invokes each installed real CLI with a deterministic prompt,
and verifies:

- reading succeeds;
- an attempted `<repo>/KIN_WRITE_PROBE` write is denied and the file is absent;
- `request_workspace` reaches the fake daemon exactly once; and
- the provider exits without an interactive approval hang.

The script must refuse to run outside its temporary repository, print the CLI
versions, redact auth material, and clean up with a trap. Do not run it in
ordinary CI because it requires provider credentials and consumes quota. Run it
in Task 11 before shipping support for a new provider version line.

**Step 5: Run adapter tests**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/adapter/codex ./internal/adapter/claudecode -count=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add internal/adapter/codex/plugin.go \
  internal/adapter/codex/adapter.go \
  internal/adapter/codex/permission_mode_test.go \
  internal/adapter/codex/workspace_access_test.go \
  internal/adapter/claudecode/plugin.go \
  internal/adapter/claudecode/adapter.go \
  internal/adapter/claudecode/permission_mode_test.go \
  internal/adapter/claudecode/workspace_access_test.go \
  scripts/provider-workspace-conformance.sh
git commit -m "feat(adapter): enforce lazy workspace boundaries"
```

---

### Task 6: Implement lazy promotion in the task engine

**Files:**

- Modify: `internal/task/engine.go`
- Modify: `internal/task/approvals.go`
- Modify: `internal/task/workspace_lifecycle.go`
- Modify: `internal/task/workspace_lifecycle_test.go`
- Modify: `internal/task/engine_test.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/task/orchestrate.go`
- Modify: `internal/task/orchestrate_test.go`
- Modify: `internal/server/server.go`

**Step 1: Reuse the compiled lifecycle boundary from Task 4**

Do not redefine or defer `WorkspaceRuntime`: Task 4 already added the Task 2
methods and updated all existing fakes so its commit compiles independently.
Any new fake introduced in this task must implement that existing interface.
Task 7 adds only its finalization/reconciliation methods.

**Step 2: Write failing lifecycle tests**

Add:

```go
func TestAutoLazyAgentStartsSourceReadOnlyWithoutWorktree(t *testing.T)
func TestRequestWorkspaceCreatesReadyGeneration(t *testing.T)
func TestReadyGenerationRequeuesSameTurnWithoutDuplicateUserEvent(t *testing.T)
func TestWritableResumeUsesSameSessionAndNewCwd(t *testing.T)
func TestReadOnlyAnswerCompletesWithoutWorkspace(t *testing.T)
func TestExplicitWorktreeStillPreparesBeforeFirstRun(t *testing.T)
func TestEagerProvisioningIsDurableBeforeGitAndAdapterStart(t *testing.T)
func TestUnsupportedAgentKeepsEagerAutoWorktree(t *testing.T)
func TestUnsupportedAgentAutoIsolationUnavailableFailsClosed(t *testing.T)
func TestReleasedTaskFollowUpReturnsToSourceReadOnly(t *testing.T)
func TestSecondWriteCreatesGenerationTwo(t *testing.T)
func TestDirtySourceBlocksPromotionWithoutWritableFallback(t *testing.T)
func TestOrchestratedReadOnlyIntentGateRunsBeforeWorkers(t *testing.T)
func TestOrchestratedIntentGateFailureStartsNoWorkers(t *testing.T)
func TestOrchestratedSuccessfulRequestWinsOverMarkerAndNonzeroExit(t *testing.T)
func TestReadOnlyOrchestrationRejectsUnsupportedWorkerBeforeStart(t *testing.T)
func TestReadOnlyOrchestrationPromotesBeforeMixedWorkerWave(t *testing.T)
func TestIntentMarkerThenGenericWorkerPromotesBeforeAnyWorkerStarts(t *testing.T)
func TestOrchestratedWritePromotesBeforeWorkerWave(t *testing.T)
func TestOrchestratedWorkersCannotRequestOrCompleteWorkspace(t *testing.T)
func TestOrchestratedCompletionHostStartsAfterAllWorkersExit(t *testing.T)
```

The fake adapter must capture every `TaskSpec`. Assert:

- first lazy spec: source cwd, read-only, no workspace ID;
- second spec: generation cwd, writable, same task session reference;
- eager turns persist user mapping and `provisioning` before the first Git
  mutation, and no adapter is observed before `ready`;
- only one user event exists for the turn;
- its `task_turn_workspaces` row starts with null workspace ID and is updated to
  the ready generation in the same transaction as `workspace_created`;
- generation numbers increase;
- dirty-source failure leaves the task/source non-writable.

Run:

```bash
go test ./internal/task -run 'Test(AutoLazy|RequestWorkspace|ReadyGeneration|WritableResume|ReadOnlyAnswer|ExplicitWorktree|EagerProvisioning|UnsupportedAgent|ReleasedTask|SecondWrite|DirtySource|Orchestrated|ReadOnlyOrchestration|IntentMarker)' -count=1
```

Expected: FAIL.

**Step 3: Change create policy**

For `workspace_mode=auto`:

- resolve and persist source metadata;
- only if the selected agent both declares `CapabilityLazyWorkspace` and
  `Registry.LazyWorkspaceSupport(ctx, agentID).Supported` is true, create no
  worktree and queue source-read-only;
- otherwise mark the initial turn `pending_isolation`; the scheduler allocates
  its first host execution ID, provisions generation 1 through
  `ensureWorkspace`, and starts no adapter until the generation is ready.

Change eager `auto` fallback semantics: if Git worktree isolation is
unavailable (dirty, non-Git, bare, unborn, detached, or Git missing), return a
typed error that tells the UI the user may explicitly choose `shared`. Do not
persist or run a writable shared task from `auto`. Existing tasks already
persisted as `shared` remain compatible; this rule applies to new auto
resolution and later promotion.

Explicit `worktree` follows the same pre-run eager path, so durable
`provisioning` exists before `git worktree add`. For explicit `shared`, preserve
shared execution and mark the turn `shared`.

Persist the requested policy separately from the legacy resolved projection.
When accepting each user message, use
`AppendUserEventWithTurnWorkspace` so the message and mapping commit atomically
before queueing execution. Initial eager turns use
`(workspace_id=NULL, access=pending_isolation)`, follow-ups in an active
generation point to that generation with `writable`, source-read-only turns use
a null workspace ID until promotion, and explicit shared turns use `shared`.
The scheduler must reject, rather than launch, any adapter spec built while the
turn remains `pending_isolation`.

**Step 4: Wire the durable request intent into the running turn**

Use the `RequestWorkspace` implementation introduced in Task 4. Do not
reimplement its transaction logic in `engine.go`. Ensure the MCP request does
not cancel the current process; its response tells the host to end. If
checkpoint capture or ready activation fails, no current pointer may be set,
the deterministic cleanup/error evidence remains recoverable, and the current
turn ends with the blocked reason rather than writable fallback.

**Step 5: Requeue after the read-only attempt**

Carry workspace identity on the execution. Before ordinary task finish:

- reload current workspace;
- if it is `ready` and differs from the finishing execution workspace ID,
  requeue without adding another user event;
- start the next run with a short continuation prompt rather than duplicating
  the full user prompt when `session_ref` is available;
- transition `ready → active` immediately before adapter start.

If start fails, keep the workspace active and surface the real start error.
If a writable run exits without `complete_workspace`, keep that generation
`active`, finish the conversational turn normally, and use the same generation
for the next modifying follow-up. Never auto-release uncommitted or
unfinalized work.

**Step 6: Add host-only lifecycle phases around orchestration**

The existing orchestrator has a read-only Controller plus `Step>0` worker
adapters; neither may own workspace lifecycle. Preserve orchestration with two
explicit host (`Step=0`) phases:

1. Before planning a source-read-only orchestrated turn, start the selected host
   adapter with only `workspace:request` and an intent-gate instruction. It must
   either call `request_workspace` and end, or return the exact structured
   marker `KIN_WORKSPACE_INTENT=read_only`. Do not show this internal probe as a
   second user message. Do not project the marker or probe assistant output into
   the normal transcript; only a failed gate projects its `workspace_blocked`
   item.
2. Treat the intent gate as a strict two-outcome protocol with durable request
   precedence. Once an attributed `request_workspace` returns success, wait for
   the host process to exit and promote/requeue regardless of a later marker or
   non-zero exit; record the extra output/exit as a diagnostic but do not emit a
   blocked transition or abandon the ready generation. Only when no workspace
   request succeeded may a clean zero exit plus exactly one marker select the
   read-only path. In that no-request case, provider error/non-zero exit, blank
   output, or a missing/malformed/duplicate marker fails the turn closed.
   Append one visible `workspace_blocked` event with `phase=intent_gate`; do not
   start the controller or any worker and do not mutate the source checkout.
   Test both `request → marker` and `request → nonzero`: each must resume in the
   single ready generation without a duplicate blocked event.
3. On the read-only marker, obtain the concrete controller/worker plan, then
   call `Registry.LazyWorkspaceSupport` for every selected worker registration.
   Only certified Codex/Claude workers may receive `source_read_only`. If any
   explicitly requested or planned worker is unsupported, start none of the
   worker wave: while the host's logical execution remains in
   `intent_plan_check`, call `ensureWorkspace` with
   `ProvisionFromOrchestrationPlan`, then re-plan/requeue the entire wave
   writable. If isolation is unavailable, fail closed with a visible blocked
   reason. Generic, Grok, raw PTY, Kin, and any uncertified adapter must never
   execute against the source checkout merely because the host passed the
   intent gate. Test the exact sequence `marker → generic worker in plan →
   durable provisioning/ready → first worker starts writable`, with zero source
   worker starts.
4. On a workspace request, wait for the host to exit, promote/requeue, then
   plan and run the writable worker wave in that generation.
5. After every writable worker handle has exited and synthesis is persisted,
   resume the host adapter in the workspace with the synthesis, checks, and
   completion instruction. Only this host receives `workspace:complete`.
6. `CompleteWorkspace` rejects while any other task handle is live.

Workers retain their existing approval/question scopes as needed but never see
`request_workspace` or `complete_workspace`. The controller remains tool-free.
Add explicit `@multi-agent`, mixed-worker, and parallel-wave tests proving no
unsupported worker starts on source, promotion precedes the first writable
worker, the wave is never split between source/workspace, and finalization
cannot begin until the last worker exits.

**Step 7: Run tests and commit**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/task/... ./internal/server/... -count=1
git add internal/task/engine.go internal/task/approvals.go \
  internal/task/workspace_lifecycle.go \
  internal/task/workspace_lifecycle_test.go internal/task/engine_test.go \
  internal/task/fork_retry_test.go internal/task/orchestrate.go \
  internal/task/orchestrate_test.go internal/server/server.go
git commit -m "feat(task): promote read-only turns into workspaces"
```

---

### Task 7: Implement Kin-owned finalization, release, and restart recovery

**Files:**

- Create: `internal/workspace/finalize.go`
- Create: `internal/workspace/finalize_test.go`
- Create: `internal/workspace/reconcile.go`
- Create: `internal/workspace/reconcile_test.go`
- Modify: `internal/workspace/types.go`
- Modify: `internal/task/workspace_lifecycle.go`
- Modify: `internal/task/workspace_lifecycle_test.go`
- Modify: `internal/task/engine.go`

**Step 1: Write failing workspace finalization tests**

Add:

```go
func TestFinalizeFastForwardsAndReleases(t *testing.T)
func TestFinalizeRejectsUncommittedWorkspace(t *testing.T)
func TestFinalizeRejectsDirtySource(t *testing.T)
func TestFinalizeBlocksNonFastForwardWithoutTouchingSource(t *testing.T)
func TestFinalizeDoesNotRunRepositoryHooks(t *testing.T)
func TestFinalizeRejectsWorkspaceHeadChangedAfterSnapshot(t *testing.T)
func TestReleaseNeverRunsBeforeSnapshot(t *testing.T)
func TestReleaseIsIdempotentAfterIntegration(t *testing.T)
func TestReconcileMissingActiveWorkspaceAsOrphaned(t *testing.T)
func TestReconcileFinalizingWorkspaceCompletes(t *testing.T)
func TestReconcileReadyWorkspaceRequestsResume(t *testing.T)
func TestConcurrentFinalizationSerializesPerSourceRepository(t *testing.T)
func TestReconcileAfterFastForwardBeforeIntegratedRecord(t *testing.T)
func TestCancelDuringProvisioningCannotLeaveUntrackedWorktree(t *testing.T)
func TestCancelDuringFinalizingRetainsRetryableGeneration(t *testing.T)
func TestDeleteCleansAllPhysicalGenerationsBeforeMetadata(t *testing.T)
func TestDeleteCleanupFailureRetainsTaskMetadata(t *testing.T)
func TestDeleteRemovesPrivateCheckpointObjects(t *testing.T)
```

For the non-fast-forward test, hash the primary checkout index and worktree
before/after and assert no source mutation occurred.

Run:

```bash
go test ./internal/workspace -run 'Test(Finalize|Release|Reconcile)' -count=1
```

Expected: FAIL.

**Step 2: Implement a fast-forward-only finalizer**

Add:

```go
type FinalizeInspection struct {
	HeadOID string
	TreeOID string
}

func (m *Manager) InspectFinalizable(ctx context.Context, meta Metadata) (FinalizeInspection, error)
func (m *Manager) InspectIntegrationTarget(ctx context.Context, meta Metadata, targetBranch string) (reviewBaseOID string, err error)
func (m *Manager) FastForward(ctx context.Context, meta Metadata, targetBranch, expectedSourceOID, finalHeadOID string) (integratedOID string, err error)
func (m *Manager) Release(ctx context.Context, meta Metadata) error
func (m *Manager) Reconcile(ctx context.Context, meta Metadata, state string) (ReconcileResult, error)
```

`InspectFinalizable` requires:

- worktree exists and is a registered worktree;
- `git status --porcelain=v1 -z` is empty;
- workspace branch matches metadata;
- workspace `HEAD` and `HEAD^{tree}` are valid object IDs.

`FastForward` requires:

- source checkout clean;
- source currently on `targetBranch`;
- immediately before integration, the workspace branch tip still equals the
  persisted `finalHeadOID`;
- `git merge-base --is-ancestor <source-head> <workspace-head>` succeeds;
- `git -c core.hooksPath=<Kin-state>/empty-hooks merge --ff-only
  <finalHeadOID>` succeeds.

Merge the exact persisted object ID, not the branch name. If the branch tip
moved after snapshot, fail closed before source mutation and retain the
workspace for re-inspection; otherwise an external branch move could make the
integrated commit disagree with `final_tree_oid` and historical diff.

Use the same validated Kin-owned `0700` empty hooks directory as preparation.
Never inherit hooks from the target repository for Kin-owned Git mutations.
Add malicious `post-merge` and `post-checkout` fixtures that write an external
marker; successful preparation/finalization must leave both markers absent.

Serialize `InspectFinalizable → final snapshot record → FastForward →
integrated record` with a keyed mutex on the canonical `source_root`. Different
repositories may finalize concurrently; two generations targeting the same
checkout may not run Git integration concurrently. Re-probe the source after
acquiring the lock. Never hold the task engine's global scheduling mutex across
Git or filesystem calls.

Under that lock, set `review_base_oid` to the target branch's current `HEAD`
immediately before the successful fast-forward. Historical and aggregate diffs
must compare `review_base_oid` to `final_tree_oid`, not the creation
`base_oid`. This prevents target-branch commits that the agent merged while
resolving `merge_blocked` from being attributed to the task. Preserve
`base_oid` separately for provenance and checkpoint semantics.

The crash-safe order under the same source lock is:

1. inspect the final workspace head/tree;
2. inspect target branch/clean source and obtain `review_base_oid`;
3. atomically persist final head, final tree, and review base while state remains
   `finalizing`;
4. call `FastForward` with that expected source OID; it rechecks source `HEAD`
   equals the expectation before mutation;
5. atomically record `integrated_oid`, state, and merged event.

Never learn the review base only after Git mutation. Recovery from a crash
between steps 4 and 5 compares the persisted final/review OIDs with source
`HEAD` and completes the database transition idempotently.

`FastForward` is idempotent across a daemon crash: if source `HEAD` already
equals the recorded final head, treat integration as successful after verifying
the target branch and clean checkout. If source `HEAD` is elsewhere, use the
ancestor check above and fail closed.

Do not use a normal merge, rebase, reset, checkout, or clean in the source
checkout.

`Release` runs `git worktree remove <root>`, then
`git branch -d <workspace-branch>`. It treats already-absent, already-merged
state as success only after containment and integrated-OID verification.

**Step 3: Implement engine finalization**

`CompleteWorkspace` validates active execution identity, persists
`completed_execution_id`, and transitions
`active|merge_blocked|finalize_blocked → finalizing`, then emits
`workspace_finalizing`. A retry
with the same execution ID returns the existing
`finalizing|integrated|released` result without appending a duplicate event;
another execution receives 409.

When that execution ends:

1. acquire the source-repository lock, inspect and capture the final snapshot,
   and inspect the target `review_base_oid`;
2. atomically write `final_head_oid`, `final_tree_oid`, and
   `review_base_oid` while retaining `finalizing`;
3. fast-forward with the persisted review base as expected source OID;
4. transition to `integrated`, emit `workspace_merged`;
5. release;
6. transition to `released`, clear current pointer and legacy execution fields,
   emit `workspace_released`;
7. finish the task successfully.

On target advancement, transition to `merge_blocked`, clear
`completed_execution_id`, retain the worktree, and
requeue a writable continuation telling the agent to merge the target into its
workspace and retry. On dirty source, snapshot failure, or another safe
retryable finalization failure, transition to `finalize_blocked`, clear
`completed_execution_id`, retain the worktree, and emit the actionable reason.
Do not auto-requeue when only the user can clean the source checkout. A later
follow-up runs writable in the same generation and may call completion again.
Unrecoverable identity/containment failures become `orphaned`, not a stuck
`finalizing` row.

**Step 4: Recover durable transitions**

After `FailOrphaned`, `Engine.Recover` reconciles open workspaces:

- `legacy_pending`: inspect path; set `active` or `orphaned`;
- `provisioning`: finish or mark orphaned;
- `ready`: queue the task in its workspace;
- `active`: verify; missing path becomes orphaned and clears current;
- `finalizing`: resume finalization;
- `integrated`: retry release;
- `merge_blocked|finalize_blocked`: verify and keep the conversation usable in
  the retained writable generation;
- released rows with residue: best-effort contained cleanup.

Publish every recovered task/event. Recovery must be safe to run twice.
Because path and branch names are deterministic from task ID plus generation,
`provisioning` recovery must inspect those derived names even when the crash
happened after `git worktree add` but before physical metadata was patched.
Adopt the exact matching registered worktree or clean it up safely before
marking `orphaned`; never create a second branch/path blindly.

**Step 5: Close cancel and delete semantics**

Use a per-task lifecycle mutex for `RequestWorkspace`,
`CompleteWorkspace`, finalization, `Cancel`, and `Delete`. This mutex is
separate from the per-source integration lock and the engine scheduling mutex.

`Cancel` stops adapter handles but normally retains `ready`, `active`,
`merge_blocked`, or `finalize_blocked` work for a later follow-up. During
`provisioning`, it cancels the preparation context, waits for that operation to
finish, safely removes any deterministic partial worktree/branch, and records
`orphaned` plus a cancellation reason. During `finalizing` before integration,
it transitions to `finalize_blocked`, clears `completed_execution_id`, and
retains the worktree. It may not race a fast-forward already holding the
per-source integration lock.

`Delete` is the explicit destructive operation. It must:

1. cancel and wait for every task handle to exit;
2. acquire the task lifecycle lock;
3. list all workspace-generation rows before any cascade;
4. idempotently release `integrated` generations and force-discard only
   unintegrated Kin-contained generations;
5. delete their fully contained task branches;
6. remove `checkpoints/<task-id>` only through a validated state-dir helper;
7. reset provider session state; and only then
8. delete the task row and cascade generation/checkpoint metadata.

If any physical cleanup cannot be proven or fails, return the error and keep
the task/generation metadata intact for retry. Never cascade the database first.
Released generations with no residue are a no-op.

**Step 6: Run tests and commit**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/workspace ./internal/task -count=1
git add internal/workspace/finalize.go \
  internal/workspace/finalize_test.go internal/workspace/reconcile.go \
  internal/workspace/reconcile_test.go internal/workspace/types.go \
  internal/task/workspace_lifecycle.go \
  internal/task/workspace_lifecycle_test.go internal/task/engine.go
git commit -m "feat(workspace): own integration and release lifecycle"
```

---

### Task 8: Add generation-aware live and historical file APIs

**Files:**

- Create: `internal/workspace/diff.go`
- Create: `internal/workspace/diff_test.go`
- Create: `internal/api/workspace_generations.go`
- Create: `internal/api/workspace_generations_test.go`
- Modify: `internal/api/api.go`
- Modify: `internal/api/workspace.go`
- Modify: `internal/api/workspace_test.go`

**Step 1: Write failing diff tests**

Add:

```go
func TestLiveGenerationDiffIncludesCommittedStagedUntrackedAndDeleted(t *testing.T)
func TestReleasedGenerationDiffWorksWithoutPhysicalWorktree(t *testing.T)
func TestReleasedGenerationReadsBaseAndFinalFile(t *testing.T)
func TestGenerationDiffHandlesRenameAndBinary(t *testing.T)
func TestGenerationFileRejectsTraversalAndEscapingSymlink(t *testing.T)
func TestMissingReleasedSnapshotIsExplicit(t *testing.T)
```

Use NUL-delimited Git output. Include filenames containing spaces and tabs.

**Step 2: Implement workspace diff primitives**

Add:

```go
type Change struct {
	Path       string `json:"path"`
	OldPath    string `json:"old_path,omitempty"`
	Status     string `json:"status"` // added|modified|deleted|renamed|binary
	Additions  int    `json:"additions,omitempty"`
	Deletions  int    `json:"deletions,omitempty"`
	Binary     bool   `json:"binary,omitempty"`
}

func (m *Manager) ListLiveChanges(ctx context.Context, meta Metadata) ([]Change, error)
func (m *Manager) ListSnapshotChanges(ctx context.Context, taskID string, meta Metadata, reviewBaseOID, finalTreeOID string) ([]Change, error)
func (m *Manager) ReadSnapshotFile(ctx context.Context, taskID string, meta Metadata, treeOID, relPath string) ([]byte, error)
func (m *Manager) ListSnapshotTree(ctx context.Context, taskID string, meta Metadata, treeOID, relDir string) ([]TreeEntry, error)
```

Use the checkpoint object directory as
`GIT_ALTERNATE_OBJECT_DIRECTORIES` when reading final trees. Preserve current
size, UTF-8, binary, and containment limits.

`ListSnapshotChanges` is also the immutable per-generation manifest source:
derive it on demand from the recorded `review_base_oid` and `final_tree_oid`.
Do not persist a second JSON manifest whose contents can drift from those Git
objects.

All live and snapshot diff commands use the stored repository-relative scope as
a Git pathspec and return repository-relative canonical paths. Tree endpoints
default `path` to that stored scope (or `.` when scope is root). File/tree
requests outside the task scope return 403; the separate current-project view
uses the same selected scope rather than silently exposing the whole
repository.

**Step 3: Add additive API routes**

```text
GET /api/tasks/{id}/workspaces
GET /api/tasks/{id}/workspaces/{workspace_id}/tree?path=.&side=final
GET /api/tasks/{id}/workspaces/{workspace_id}/file?path=...&side=base|final
GET /api/tasks/{id}/workspaces/{workspace_id}/diff
GET /api/tasks/{id}/source/tree?path=.
GET /api/tasks/{id}/source/file?path=...
```

Rules:

- active/ready/merge-blocked/finalize-blocked default to live view;
- integrated/released default to final snapshot;
- `side=base|final` is valid only with recorded trees;
- source endpoints are always read-only;
- the legacy `/workspace/list|file` routes delegate to the current generation
  when one exists, otherwise source, for one-release compatibility;
- legacy PUT requires an active writable generation and returns 409 otherwise.

Workspace-generation responses return non-null `workspace_id`, `generation`,
`view`, and canonical repo-relative `path`. Source responses return
`workspace_id: null`, `generation: null`, `view: "source"`, and the same
canonical repository-relative path contract.

**Step 4: Run tests and commit**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/workspace ./internal/api -count=1
git add internal/workspace/diff.go internal/workspace/diff_test.go \
  internal/api/workspace_generations.go \
  internal/api/workspace_generations_test.go internal/api/api.go \
  internal/api/workspace.go internal/api/workspace_test.go
git commit -m "feat(api): expose durable workspace diffs"
```

---

### Task 9: Fix UI path identity and build the generation-aware browser

**Files:**

- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/lib/paths.ts`
- Modify: `ui/src/lib/paths.test.ts`
- Modify: `ui/src/lib/changedFiles.ts`
- Modify: `ui/src/lib/changedFiles.test.ts`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/components/workspace/WorkspacePanel.tsx`
- Modify: `ui/src/components/workspace/FileTree.tsx`
- Modify: `ui/src/components/workspace/ChangedFilesBar.tsx`
- Modify: `ui/src/components/workspace/ChangedFilesList.tsx`
- Modify: `ui/src/components/workspace/CodeViewer.tsx`
- Create: `ui/src/components/workspace/WorkspaceGenerationPicker.tsx`
- Create: `ui/src/components/workspace/WorkspaceGenerationPicker.test.tsx`

**Step 1: Write failing path and component tests**

Add:

```ts
it("maps an absolute tool path against the generation root, not task.cwd")
it("maps a relative tool path against execution_cwd and stored scope")
it("keeps workspace id when extracting a tool file reference")
it("opens a released generation on final diff by default")
it("switches explicitly from final changes to current project")
it("groups all changes by generation without attributing current-main commits")
```

Update `ChangedFile`:

```ts
type ChangedFile = {
  workspaceId: string;
  generation: number;
  path: string; // canonical repo-relative path
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  oldPath?: string;
  additions?: number;
  deletions?: number;
};
```

The API diff is the source of truth. Keep event-derived extraction only as a
fallback for legacy tasks with no workspace generation.

Run:

```bash
cd ui
npm test -- --run src/lib/paths.test.ts src/lib/changedFiles.test.ts \
  src/components/workspace/WorkspaceGenerationPicker.test.tsx
```

Expected: FAIL.

**Step 2: Add typed API clients**

Add:

```ts
listTaskWorkspaces(taskId)
listWorkspaceTree(taskId, workspaceId, path?, side?)
readWorkspaceFile(taskId, workspaceId, path, side?)
getWorkspaceDiff(taskId, workspaceId)
listTaskSourceTree(taskId, path?)
readTaskSourceFile(taskId, path)
```

Do not construct nested URLs without `encodeURIComponent`.

**Step 3: Replace `task.cwd` path conversion**

Delete the current assumption in `TaskDetailPage.onOpenWorkspacePath`:

```ts
toWorkspaceRelativePath(task.cwd, filePath)
```

Resolve a clicked event path using its stamped `workspace_id` and that
generation's stored `execution_cwd`. If the event already has a canonical
relative path, use it directly. If neither is available, use the legacy task
fallback and show an explicit compatibility warning on failure.

**Step 4: Implement browser views**

The workspace panel header contains:

- generation picker (`Workspace 1`, `Workspace 2`, …);
- default `Final changes` for released/integrated generations;
- explicit `Current project` switch;
- lifecycle badge.

For active generations, show live files/diff. For released generations, disable
editing and render immutable base/final content. Deleted files show the base
side; binary and oversized files show specific empty states.

The “All changes” option lists the union of per-generation manifests. A file
changed in multiple generations expands to those individual diffs; do not
synthesize a first-base/current-main diff.

**Step 5: Run tests and build**

```bash
cd ui
npm test
npm run build
```

Expected: PASS and `web/dist/` regenerated.

**Step 6: Commit**

```bash
git add ui/src/api/client.ts ui/src/lib/paths.ts \
  ui/src/lib/paths.test.ts ui/src/lib/changedFiles.ts \
  ui/src/lib/changedFiles.test.ts ui/src/pages/TaskDetailPage.tsx \
  ui/src/components/workspace/WorkspacePanel.tsx \
  ui/src/components/workspace/FileTree.tsx \
  ui/src/components/workspace/ChangedFilesBar.tsx \
  ui/src/components/workspace/ChangedFilesList.tsx \
  ui/src/components/workspace/CodeViewer.tsx \
  ui/src/components/workspace/WorkspaceGenerationPicker.tsx \
  ui/src/components/workspace/WorkspaceGenerationPicker.test.tsx web/dist
git commit -m "feat(ui): browse workspace generations and final diffs"
```

---

### Task 10: Render explicit lifecycle events and finish compatibility coverage

**Files:**

- Modify: `ui/src/components/chat/transcriptProjection.ts`
- Modify: `ui/src/components/chat/transcriptProjection.test.ts`
- Modify: `ui/src/components/chat/ChatStream.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Modify: `internal/task/event_persist_test.go`
- Modify: `internal/task/approvals.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/task/workspace_lifecycle.go`
- Modify: `docs/IMPL_NOTES.md`
- Modify: `AGENTS.md`
- Modify: `SYSTEM_DESIGN.md`
- Modify: `SYSTEM_DESIGN.zh.md`

**Step 1: Write failing transcript tests**

Each lifecycle event must project to a visible standalone system item:

```text
Workspace 2 created · kin/task/<task>/g2 · base abc1234
Workspace 2 merged into main · result def5678
Workspace 2 released · historical diff retained
Workspace 2 blocked · <reason>
Workspace 2 recovered
```

Test all event types, missing optional payload fields, English/Chinese keys, and
that event ordering remains creation → merge → release.

Run:

```bash
cd ui
npm test -- --run src/components/chat/transcriptProjection.test.ts
```

Expected: FAIL.

**Step 2: Extend transcript projection**

Add a dedicated `kind: "workspace"` chat item rather than flattening lifecycle
events into generic errors. Render a compact neutral system row with generation,
state icon, branch/commit detail, and blocked reason. Keep it outside agent
progress cards so daemon recovery events remain legible.

All visible text must use both locale files.

**Step 3: Finish retry/fork semantics**

Tests must prove:

- retry within an active generation restores only checkpoints with the same
  `workspace_id`;
- a user turn that starts source-read-only and promotes later resolves to the
  promoted generation;
- a source-read-only turn that never promotes resolves to no generation;
- a later follow-up in an already-active generation resolves to that same
  generation even though its `workspace_created` event belongs to an earlier
  user turn;
- fork from a released generation uses its recorded checkpoint/final tree and
  creates generation 1 for the new task;
- retry cannot restore generation-1 files into generation 2;
- an orphaned historical task can still accept a read-only follow-up.

Implement, do not only test, these rules in `internal/task/approvals.go`:

- change checkpoint lookup used by `Retry` to
  `GetCheckpointForWorkspace(taskID, eventSeq, workspaceID)`;
- locate the selected user event sequence, then load its exact
  `task_turn_workspaces` row; never assume `workspace_created` is appended
  before the user event or derive the turn from adjacent lifecycle metadata;
- for tasks created before migration 013, use a compatibility lookup bounded by
  `[selected_user_seq, next_user_event_seq)` and persist the resolved mapping
  before continuing; ambiguous legacy history fails visibly instead of choosing
  a generation;
- file-restoring retry is allowed only when the mapped workspace ID equals the
  current open generation and the checkpoint row has the same ID;
- retrying an event from a released/older generation with
  `restore_files=true` returns 409 with “fork from this point” guidance;
- transcript-only retry remains available when explicitly requested and does
  not touch files;
- `Fork` from a released generation loads that generation's recorded
  checkpoint/final tree, creates generation 1 for the new task, and never
  restores into another existing generation; and
- missing/orphaned snapshot data fails visibly without truncating the source
  task's conversation.

Use store queries that include `workspace_id` in SQL, not a load-then-filter
check in Go. Add tests with generation 1 and generation 2 containing the same
repo-relative filename but different content, plus the concrete sequence
`user event → read-only execution → workspace_provisioning →
workspace_created → writable resume`.

**Step 4: Update implementation documentation**

Document:

- schema version 13;
- generation paths and branches;
- lazy-capable versus eager adapters;
- MCP transition protocol;
- state reconciliation;
- final-diff retention and limits;
- compatibility routes and planned removal of legacy task workspace columns.

Update `AGENTS.md` so its feature-completion gate distinguishes:

- a Kin-managed execution that exposes `mcp__kin__complete_workspace`: commit,
  review, verify, call the tool, and let Kin integrate/release; and
- a normal external worktree with no lifecycle tool: retain the existing manual
  merge/remove procedure.

This exception must be explicit so repository instructions cannot tell an
agent to delete the cwd that Kin still owns.

Keep `SYSTEM_DESIGN.md` and `SYSTEM_DESIGN.zh.md` aligned.

**Step 5: Run UI/backend checks and commit**

```bash
gofmt -w $(git diff --name-only -- '*.go')
go test ./internal/task/... -count=1
cd ui
npm test
npm run build
cd ..
git add ui/src/components/chat/transcriptProjection.ts \
  ui/src/components/chat/transcriptProjection.test.ts \
  ui/src/components/chat/ChatStream.tsx ui/src/i18n/locales/en.ts \
  ui/src/i18n/locales/zh.ts internal/task/event_persist_test.go \
  internal/task/approvals.go internal/task/fork_retry_test.go \
  internal/task/workspace_lifecycle.go docs/IMPL_NOTES.md AGENTS.md \
  SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md web/dist
git commit -m "feat(workspace): surface lifecycle and recovery"
```

---

### Task 11: End-to-end acceptance, security checks, and feature completion gate

**Files:**

- Create: `internal/task/workspace_e2e_test.go`
- Modify as findings require: files from Tasks 1–10 only

**Step 1: Add one real-repository acceptance test**

Use temporary bare/working repositories and fake adapters. Cover this exact
story:

```text
create lazy Codex task
→ first run source-read-only, no worktree
→ request workspace
→ generation 1 ready and visible
→ same turn resumes writable in generation 1
→ commit change and request completion
→ main fast-forwards
→ worktree and branch are released
→ generation-1 diff still reads
→ read-only follow-up uses current main with no worktree
→ second request creates generation 2
→ generation-1 and generation-2 diffs remain separate
```

Add failure subtests for daemon restart while `ready`, `finalizing`, and
`integrated`; dirty source; target advancement; missing active directory;
traversal/symlink paths; and duplicate lifecycle requests.
Also cover nested repository scope, scoped-capability cross-task/public-API
denial, capability rotation during a long execution, orchestrated read-only and
writable host phases, cancel during provisioning/finalizing, delete cleanup
failure, and retry/fork across two generations.

**Step 2: Run focused race and full checks**

```bash
go test -race ./internal/workspace/... ./internal/task/...
go test ./...
go vet ./...
cd ui
npm test
npm run build
cd ..
KIN_PROVIDER_CONFORMANCE=1 ./scripts/provider-workspace-conformance.sh
git diff --check
```

Expected: all PASS. If provider credentials are unavailable, record the
conformance script as a release blocker for lazy capability; do not silently
ship that provider version as lazy-capable.

**Step 3: Inspect the built UI**

Run the project-prescribed desktop flow:

```bash
./scripts/desktop-rebuild.sh
```

Verify at desktop and narrow widths:

- creation, merge, and release rows are visible;
- released task defaults to final diff;
- current-project switch is distinct;
- paths from Codex and Claude worktrees open the right diff;
- Workspace 1 and Workspace 2 remain independently selectable;
- blocked/orphaned states remain readable.

Record any environment limitation rather than silently skipping it.

**Step 4: Run the repository feature completion gate**

Request an advanced-model review of the full diff and nearby call sites with
severity `blocker / major / nit`. Require review of:

- state transition idempotency;
- SQLite migration on populated databases;
- source-checkout write safety;
- token exposure in process arguments/logs;
- Git path containment and symlinks;
- fast-forward-only integration;
- daemon restart recovery;
- API/UI path identity;
- historical diff correctness;
- missing tests.

Fix every blocker and major, rerun affected checks, and repeat review until none
remain.

**Step 5: Final commit if acceptance fixes were needed**

```bash
git add <explicit reviewed paths>
git commit -m "test(workspace): cover generation lifecycle end to end"
```

Do not create an empty commit.

**Step 6: Land and clean up**

If the current execution exposes `mcp__kin__complete_workspace`, call it after
the final reviewed commit and end the turn. Do not run merge/remove commands
from the Kin-owned worktree; the implementation being delivered must exercise
its own Kin integration/release path.

Only when no lifecycle tool is exposed, use the external-worktree fallback
from the primary checkout:

```bash
git status --short
git merge --ff-only <implementation-branch>
git worktree remove <implementation-worktree>
git branch -d <implementation-branch>
./scripts/desktop-rebuild.sh
```

Do not push unless explicitly requested. Report the final local `main` commit,
all verification commands, review result, rebuild result, and any intentional
uncommitted files.

---

## Stop conditions for the executor

Stop and report instead of improvising if:

- Codex or Claude cannot load the lifecycle MCP in a fake-binary argv/config
  test;
- source-read-only mode allows a real write;
- migration 013 cannot preserve populated version-12 tasks/checkpoints;
- finalization would require mutating a dirty source checkout;
- integration is not fast-forward;
- a final snapshot cannot be persisted;
- release containment cannot be proven;
- a UI path cannot be tied to a workspace generation;
- unrelated user changes overlap the required files; or
- any full-suite failure appears unrelated to this work.

Do not “solve” a stop condition with writable-main fallback, `git reset --hard`,
`git clean`, force removal, force push, or by weakening tests.

## Execution handoff

Plan execution should happen in a fresh dedicated worktree using
`executing-plans`, one numbered task and commit at a time. For
`gpt-5.6-luna-medium`, use a review checkpoint after Tasks 3, 7, and 10 in
addition to the final advanced-model review.
