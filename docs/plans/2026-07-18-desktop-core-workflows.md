# Desktop Core Workflows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish Kin's desktop terminal and add safe Git task isolation, source-of-truth diff review, line-specific review feedback, and filesystem-aware Retry/Fork/discard.

**Architecture:** Complete the already-designed loopback terminal UI, then add an `internal/workspace` Git service injected into `task.Engine`. Keep `tasks.cwd` as the user-selected project path while persisting an effective execution workspace; use one Git worktree per task and Kin-private Git tree objects for turn checkpoints. Expose bounded diff/restore APIs and extend the existing workspace panel with Files/Changes tabs and Monaco diff review.

**Tech Stack:** Go 1.26, SQLite, Git CLI, React 18, TypeScript 5, Vite 6, Vitest, Monaco Editor, xterm.js, Electron 33.

---

## 0. Executor contract

This plan is intentionally explicit for an executor with little repository context. Follow these rules literally.

1. Start from commit `098432a` or a later commit containing both this plan and ADR 0005. Create a dedicated branch/worktree. Never develop this feature directly in another person's dirty checkout.
2. Read `AGENTS.md`, `PRINCIPLE.md`, `SYSTEM_DESIGN.md`, ADR 0004, ADR 0005, and both implementation plans completely before editing.
3. Preserve all unrelated changes. Before every task run `git status --short`. Stop if an unexpected file is modified.
4. Execute tasks in order. Do not combine tasks, skip red tests, or replace Git with shell pipelines.
5. Use `@tdd` for Tasks 7–17. Production code must not precede the named failing test.
6. Use `apply_patch` for hand-written edits. Package-manager commands and formatters may update lock/generated files.
7. Run `gofmt` on every changed `.go` file. Keep TypeScript strict; do not introduce `any`.
8. Add all user-visible text to both `ui/src/i18n/locales/en.ts` and `ui/src/i18n/locales/zh.ts` in the same task.
9. After a UI source change, run `cd ui && npm run build` and commit the regenerated `web/dist/` with that source change.
10. Stage only the paths listed by the current task. Commit after the task's checks pass. Never amend an earlier commit.
11. If a named command, file, API contract, or expected error differs from the repository, stop and record the mismatch. Do not invent a substitute contract.
12. Never run `git reset --hard`, `git clean`, `git worktree remove`, or recursive deletion against the repository being used to implement this plan. Tests may run destructive Git commands only inside `t.TempDir()` fixtures. Production restore code may run them only after Kin-owned path validation required by Task 10.

### Required execution branch

```bash
git worktree add ../kin-desktop-core -b feat/desktop-core-workflows
cd ../kin-desktop-core
git status --short --branch
```

Expected: branch `feat/desktop-core-workflows` and no changed files.

### Stable product decisions

- Request modes are `auto`, `shared`, and `worktree`.
- Resolved persisted modes are only `shared` and `worktree`.
- `auto` uses a worktree only for a clean Git worktree with a valid `HEAD`.
- Explicit `worktree` may start from committed `HEAD` in a dirty source repository, but the probe/UI must say source changes are excluded.
- Existing tasks and a nil workspace runtime remain shared and backward-compatible.
- One Kin task owns one worktree. Workers inside the same task share it.
- Retry restores files before truncating events. Restore failure leaves events untouched.
- Private checkpoint objects live under the Kin state directory, never in the user's repository object directory.
- No source editing, app preview, PR/CI integration, task archival, automatic worktree expiry, per-worker worktrees, containers, or cloud execution in this plan.

## Phase A — finish the integrated terminal

The backend part of `docs/plans/2026-07-17-integrated-terminal.md` is already complete in commits `70800ba` through `6dc24de`. Do not repeat Tasks 1–6 of that plan.

### Task 1: Add the typed terminal client foundation

**Source of truth:** `docs/plans/2026-07-17-integrated-terminal.md`, Task 7.

**Files:**

- Modify: `ui/package.json`
- Modify: `ui/package-lock.json`
- Modify: `ui/src/api/client.ts`
- Create: `ui/src/lib/terminal.ts`
- Create: `ui/src/lib/terminal.test.ts`
- Regenerate: `web/dist/`

**Steps:**

1. Run `git log --oneline -8` and confirm `6dc24de` is an ancestor.
2. Install exactly `@xterm/xterm`, `@xterm/addon-fit`, and dev dependency `vitest`; add script `"test": "vitest run"`.
3. Copy the API types, constants, and pure-helper contracts from terminal-plan Task 7. Do not rename them.
4. Write the pure helper tests first.
5. Run `cd ui && npm test -- src/lib/terminal.test.ts`; expected: FAIL because helpers do not exist.
6. Implement the helpers and API calls.
7. Run `cd ui && npm test && npm run typecheck && npm run build`; expected: PASS.
8. Review `git status --short`; only the listed source/lock/generated paths may appear.
9. Commit:

```bash
git add ui/package.json ui/package-lock.json ui/src/api/client.ts ui/src/lib/terminal.ts ui/src/lib/terminal.test.ts web/dist
git commit -m "feat(ui): add typed terminal client foundation"
```

### Task 2: Render one interactive xterm session

**Source of truth:** terminal-plan Task 8.

**Files:**

- Create: `ui/src/components/terminal/TerminalView.tsx`
- Create: `ui/src/components/terminal/terminalTheme.ts`
- Modify: `ui/src/index.css`
- Regenerate: `web/dist/`

**Steps:**

1. Implement the imperative xterm/fit/WebSocket lifecycle exactly as specified in terminal-plan Task 8, including replay reset, bounded reconnect, binary input/output, resize coalescing, clipboard behavior, theme updates, and cleanup.
2. Do not delete a backend session during React unmount.
3. Run `cd ui && npm test && npm run typecheck && npm run build`; expected: PASS.
4. Run `@vercel:react-best-practices` against the new TSX and fix only relevant findings.
5. Commit:

```bash
git add ui/src/components/terminal/TerminalView.tsx ui/src/components/terminal/terminalTheme.ts ui/src/index.css web/dist
git commit -m "feat(ui): render interactive xterm sessions"
```

### Task 3: Add terminal tabs, profile selection, and resizing

**Source of truth:** terminal-plan Task 9.

**Files:**

- Create: `ui/src/components/terminal/TerminalPanel.tsx`
- Create: `ui/src/components/terminal/TerminalTabs.tsx`
- Create: `ui/src/components/terminal/TerminalProfileMenu.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Steps:**

1. Implement ownership, first-open loading, max-eight sessions, create/close/exit semantics, accessible tabs, and accessible resize separator exactly as terminal-plan Task 9.
2. Confirm English and Chinese locale object shapes match.
3. Run `cd ui && npm test && npm run typecheck && npm run build`; expected: PASS.
4. Commit:

```bash
git add ui/src/components/terminal/TerminalPanel.tsx ui/src/components/terminal/TerminalTabs.tsx ui/src/components/terminal/TerminalProfileMenu.tsx ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): add resizable terminal panel controls"
```

### Task 4: Integrate the desktop terminal globally

**Source of truth:** terminal-plan Task 10.

**Files:**

- Modify: `ui/src/components/layout/AppShell.tsx`
- Modify: `ui/src/components/CommandPalette.tsx`
- Modify: `ui/src/lib/terminal.test.ts`
- Modify if needed: `ui/src/i18n/locales/en.ts`
- Modify if needed: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Steps:**

1. Add the desktop-only `Ctrl+Backquote` toggle based on `KeyboardEvent.code`.
2. Keep the panel mounted after first open and place it below route content, not inside a page.
3. Derive cwd from selected task or draft exactly as terminal-plan Task 10 says. Task 22 later changes selected tasks to prefer `execution_cwd`.
4. Add a command-palette action only on desktop.
5. Extend shortcut tests for shifted Backquote and repeats.
6. Run `cd ui && npm test && npm run typecheck && npm run build`; expected: PASS.
7. Commit:

```bash
git add ui/src/components/layout/AppShell.tsx ui/src/components/CommandPalette.tsx ui/src/lib/terminal.test.ts ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): integrate desktop terminal shortcut"
```

### Task 5: Verify and close the terminal sub-plan

**Source of truth:** terminal-plan Tasks 11–12.

**Files:** Modify only files from Tasks 1–4 if verification exposes a defect.

**Steps:**

1. Perform every Electron behavior check in terminal-plan Task 11: shortcut, cwd, tabs, profile menu, resize, hide/show persistence, renderer reload reattach, exit state, close, daemon shutdown, browser absence, and narrow width.
2. If a defect is found, write the narrowest regression test, fix it, rebuild `web/dist`, and create a focused `fix(ui): ...` commit.
3. Run:

```bash
go test -race ./internal/terminal ./internal/api ./internal/server
go test ./...
go vet ./...
cd ui && npm test && npm run typecheck && npm run build
cd ../desktop && npm run typecheck && npm run build
```

4. Use `@security-auditor` for the terminal route boundary and `@vercel:react-best-practices` for terminal TSX. Do not broaden the feature.
5. Record any manual-only check in the final execution log. Do not create a duplicate commit when no file changed.

## Phase B — Git workspace foundation

### Task 6: Accept the workspace decision and update architecture docs

**Files:**

- Modify: `docs/adr/0005-isolated-task-workspaces.md`
- Modify: `SYSTEM_DESIGN.md`
- Modify: `SYSTEM_DESIGN.zh.md`

**Step 1: Update the ADR status**

Change ADR 0005 from `Proposed` to `Accepted`. Do not change its decisions.

**Step 2: Update the implementation snapshot**

In both system-design languages, add one matching row after Local terminal:

```text
Task workspaces | Clean Git tasks default to Kin-owned worktrees; turn checkpoints use deletable Kin-private Git objects; non-Git/dirty auto mode remains shared
```

Also add one sentence to the task-engine component explaining that adapters receive an effective execution cwd while the original cwd remains task provenance.

**Step 3: Verify**

```bash
git diff --check -- docs/adr/0005-isolated-task-workspaces.md SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md
git diff -- docs/adr/0005-isolated-task-workspaces.md SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md
```

Expected: English and Chinese describe the same boundary.

**Step 4: Commit**

```bash
git add docs/adr/0005-isolated-task-workspaces.md SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md
git commit -m "docs(architecture): accept isolated task workspaces"
```

### Task 7: Define workspace types and a safe Git runner

**Files:**

- Create: `internal/workspace/types.go`
- Create: `internal/workspace/git.go`
- Create: `internal/workspace/git_test.go`

**Step 1: Write failing runner tests**

Tests must cover:

- arguments are passed without a shell;
- `GIT_TERMINAL_PROMPT=0` replaces any inherited value;
- stderr is capped at 64 KiB in returned errors;
- context timeout is preserved with `%w` so `errors.Is(err, context.DeadlineExceeded)` works;
- NUL bytes in an argument or environment key/value are rejected before process start.

Use a test helper executable pattern (`os.Args[0] -test.run=TestGitHelperProcess -- ...`) rather than `/bin/sh`, so tests remain portable.

Run:

```bash
go test ./internal/workspace -run TestGitRunner -count=1
```

Expected: FAIL because the package does not exist.

**Step 2: Add exact public types**

`types.go` must define these names and JSON values:

```go
package workspace

type RequestedMode string

const (
    ModeAuto     RequestedMode = "auto"
    ModeShared   RequestedMode = "shared"
    ModeWorktree RequestedMode = "worktree"
)

type ResolvedMode string

const (
    ResolvedShared   ResolvedMode = "shared"
    ResolvedWorktree ResolvedMode = "worktree"
)

type ProbeResult struct {
    Cwd             string `json:"cwd"`
    GitAvailable    bool   `json:"git_available"`
    IsGit           bool   `json:"is_git"`
    IsBare          bool   `json:"is_bare"`
    HasHead         bool   `json:"has_head"`
    Dirty           bool   `json:"dirty"`
    SourceRoot      string `json:"source_root,omitempty"`
    Scope           string `json:"scope,omitempty"`
    HeadOID         string `json:"head_oid,omitempty"`
    CanWorktree     bool   `json:"can_worktree"`
    RecommendedMode string `json:"recommended_mode"`
    Reason          string `json:"reason,omitempty"`
}

type Metadata struct {
    Mode       ResolvedMode
    SourceRoot string
    Root       string
    Cwd        string
    Scope      string
    BaseOID    string
    Branch     string
}

type Checkpoint struct {
    TaskID    string
    EventSeq  int
    HeadOID   string
    TreeOID   string
    SizeBytes int64
    CreatedAt int64
}

func (m Metadata) EffectiveCwd(fallback string) string {
    if m.Cwd != "" { return m.Cwd }
    return fallback
}
```

Add sentinel errors `ErrGitUnavailable`, `ErrNotGit`, `ErrNoHead`, `ErrBareRepository`, `ErrDirtySource`, `ErrInvalidMode`, `ErrNotIsolated`, `ErrCheckpointUnavailable`, and `ErrSnapshotTooLarge`.

**Step 3: Implement the runner**

`git.go` must use `exec.CommandContext`, never `sh -c`. Define:

```go
type gitRunner interface {
    Run(ctx context.Context, dir string, env map[string]string, stdoutLimit int64, args ...string) ([]byte, error)
}

type execGit struct { Path string }
```

Use one helper to replace environment keys rather than append duplicates. Callers pass an explicit stdout limit: use 64 KiB for control commands, 4 MiB for path lists, and the text hard limit plus one byte for file bodies. Exceeding it returns a stable `ErrOutputTooLarge`; never return silently truncated protocol data. Cap captured stderr at 64 KiB. Give callers the context; do not hide a second untestable timeout in the runner.

**Step 4: Run tests and format**

```bash
gofmt -w internal/workspace/types.go internal/workspace/git.go internal/workspace/git_test.go
go test ./internal/workspace -run TestGitRunner -count=1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/workspace/types.go internal/workspace/git.go internal/workspace/git_test.go
git commit -m "feat(workspace): add safe git command boundary"
```

### Task 8: Probe Git repositories deterministically

**Files:**

- Create: `internal/workspace/manager.go`
- Create: `internal/workspace/probe.go`
- Create: `internal/workspace/probe_test.go`

**Step 1: Write real-repository fixture tests**

Use `exec.LookPath("git")`; call `t.Skip` only when Git is absent. Create repositories inside `t.TempDir()` with `git init`, local `user.name/user.email`, one committed file, and no global configuration dependence.

Test these table rows:

| Fixture | Expected |
|---|---|
| non-Git directory | `IsGit=false`, `RecommendedMode=shared` |
| clean repository root | `CanWorktree=true`, `Dirty=false`, `RecommendedMode=worktree` |
| clean nested directory | root is repo root; scope is slash path; recommended worktree |
| modified tracked file | `Dirty=true`, `CanWorktree=true`, recommended shared |
| untracked file | dirty and recommended shared |
| unborn repository | `HasHead=false`, cannot worktree |
| bare repository path | `IsBare=true`, cannot worktree |
| missing cwd | error mentioning cwd without environment dump |

Run `go test ./internal/workspace -run TestProbe -count=1`; expected: FAIL.

**Step 2: Implement Manager construction**

```go
type Manager struct {
    stateDir string
    gitPath  string
    git      gitRunner
    now      func() time.Time
}

func NewManager(stateDir string) *Manager
func (m *Manager) Probe(ctx context.Context, cwd string) (ProbeResult, error)
```

`NewManager` resolves Git once with `exec.LookPath`. `Probe` cleans and absolutizes cwd, verifies it is a directory, uses `git rev-parse --show-toplevel`, `--is-bare-repository`, `rev-parse HEAD`, and `status --porcelain=v1 -z --untracked-files=normal`. Convert scope to slash form; use `.` for repository root.

Set `CanWorktree=true` only when Git exists, repository is non-bare, and `HEAD` resolves. Dirty affects recommendation, not capability.

**Step 3: Verify**

```bash
gofmt -w internal/workspace/manager.go internal/workspace/probe.go internal/workspace/probe_test.go
go test ./internal/workspace -run TestProbe -count=1
```

Expected: PASS.

**Step 4: Commit**

```bash
git add internal/workspace/manager.go internal/workspace/probe.go internal/workspace/probe_test.go
git commit -m "feat(workspace): probe git task isolation support"
```

### Task 9: Prepare Kin-owned task worktrees

**Files:**

- Create: `internal/workspace/prepare.go`
- Create: `internal/workspace/prepare_test.go`

**Step 1: Write failing tests**

Cover:

1. `auto` + clean Git creates `stateDir/worktrees/<task-id>`, branch `kin/task/<lowercase-task-id>`, preserves nested scope in `Metadata.Cwd`, and leaves source checkout unchanged.
2. `auto` + dirty Git resolves shared and returns source cwd.
3. `auto` + non-Git resolves shared.
4. explicit `shared` never calls `git worktree add` but records base metadata when available.
5. explicit `worktree` + dirty Git succeeds from committed `HEAD`; dirty source changes do not appear in the task worktree.
6. explicit `worktree` + non-Git/unborn/bare returns the matching sentinel error.
7. invalid mode returns `ErrInvalidMode`.
8. task IDs not matching `^[0-9A-HJKMNP-TV-Z]{26}$` are rejected before path construction.
9. a pre-existing worktree directory fails; it is never reused or deleted.
10. `CleanupPrepared` refuses shared metadata and any path outside `stateDir/worktrees`, but removes a prepared test worktree and its Kin branch.

Run `go test ./internal/workspace -run 'TestPrepare|TestCleanupPrepared' -count=1`; expected: FAIL.

**Step 2: Implement exact API**

```go
func (m *Manager) Prepare(ctx context.Context, taskID, cwd string, requested RequestedMode) (Metadata, error)
func (m *Manager) CleanupPrepared(ctx context.Context, taskID string, meta Metadata) error
```

Implementation rules:

- Use `Probe` first.
- `auto` returns shared metadata for dirty/unsupported sources.
- `worktree` requires `CanWorktree`; dirty is allowed.
- Create `stateDir/worktrees` with mode `0700`.
- The worktree path contains only validated task ID.
- Run `git -C <source-root> worktree add -b <branch> <path> <head-oid>` with a 30-second context.
- On failure, report bounded Git stderr; do not remove a path unless this call created it and containment is verified.
- Cleanup runs `git -C <source-root> worktree remove --force <path>` only for the prepared-but-not-started rollback path, then `git branch -D <branch>`. This method is not exposed over HTTP.

**Step 3: Verify**

```bash
gofmt -w internal/workspace/prepare.go internal/workspace/prepare_test.go
go test ./internal/workspace -run 'TestPrepare|TestCleanupPrepared' -count=1
```

Expected: PASS.

**Step 4: Commit**

```bash
git add internal/workspace/prepare.go internal/workspace/prepare_test.go
git commit -m "feat(workspace): prepare isolated task worktrees"
```

### Task 10: Persist workspace metadata and checkpoints

**Files:**

- Modify: `internal/store/migrate.go`
- Modify: `internal/store/store.go`
- Modify: `internal/store/store_test.go`
- Create: `internal/store/checkpoints.go`
- Create: `internal/store/checkpoints_test.go`

**Step 1: Write migration tests first**

Add tests for:

- fresh database schema version becomes `5`;
- `task_checkpoints` exists;
- a manually created populated version-4 database migrates without losing its task/events;
- migrated task resolves `WorkspaceMode="shared"` and empty `ExecutionCwd` falls back to `Cwd` through `Task.EffectiveCwd()`;
- reopen is idempotent.

The version-4 fixture must contain the old `tasks` columns exactly; do not call the modified `migration001` to build it.

Run `go test ./internal/store -run 'TestOpenAndMigrate|TestMigrateV4' -count=1`; expected: FAIL.

**Step 2: Add migration 005**

Raise `schemaVersion` to `5`. Add these columns to fresh schema and migration 005:

```sql
ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE tasks ADD COLUMN workspace_source_root TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN workspace_root TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN execution_cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN workspace_scope TEXT NOT NULL DEFAULT '.';
ALTER TABLE tasks ADD COLUMN workspace_base_oid TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN workspace_branch TEXT NOT NULL DEFAULT '';

CREATE TABLE task_checkpoints (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq  INTEGER NOT NULL,
  head_oid   TEXT NOT NULL,
  tree_oid   TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
```

Update fresh migration 001 to include the final columns/table once. Do not execute ALTER statements for a fresh database.

**Step 3: Extend store.Task**

Add JSON fields with these exact names and include them in `taskColumns`, scan, insert, and test fixtures:

```go
WorkspaceMode       string `json:"workspace_mode"`
WorkspaceSourceRoot string `json:"workspace_source_root,omitempty"`
WorkspaceRoot       string `json:"workspace_root,omitempty"`
ExecutionCwd        string `json:"execution_cwd,omitempty"`
WorkspaceScope      string `json:"workspace_scope,omitempty"`
WorkspaceBaseOID    string `json:"workspace_base_oid,omitempty"`
WorkspaceBranch     string `json:"workspace_branch,omitempty"`
```

Add:

```go
func (t Task) EffectiveCwd() string {
    if strings.TrimSpace(t.ExecutionCwd) != "" { return t.ExecutionCwd }
    return t.Cwd
}
```

Default blank mode to `shared` and blank scope to `.` while scanning.

**Step 4: Add checkpoint CRUD**

`checkpoints.go` defines `TaskCheckpoint` with the same fields as the table and methods:

```go
PutCheckpoint(ctx context.Context, cp TaskCheckpoint) error
GetCheckpoint(ctx context.Context, taskID string, eventSeq int) (TaskCheckpoint, error)
GetCheckpointAtOrBefore(ctx context.Context, taskID string, eventSeq int) (TaskCheckpoint, error)
GetInitialCheckpoint(ctx context.Context, taskID string) (TaskCheckpoint, error)
DeleteCheckpointsFrom(ctx context.Context, taskID string, eventSeq int) error
ListCheckpoints(ctx context.Context, taskID string) ([]TaskCheckpoint, error)
```

Use UPSERT for `PutCheckpoint`. Return `store.ErrNotFound` consistently. Lists are never nil and sort by event sequence ascending.

**Step 5: Verify**

```bash
gofmt -w internal/store/migrate.go internal/store/store.go internal/store/store_test.go internal/store/checkpoints.go internal/store/checkpoints_test.go
go test ./internal/store -count=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add internal/store/migrate.go internal/store/store.go internal/store/store_test.go internal/store/checkpoints.go internal/store/checkpoints_test.go
git commit -m "feat(store): persist task workspaces and checkpoints"
```

### Task 11: Route task execution through prepared workspaces

**Files:**

- Modify: `internal/task/engine.go`
- Modify: `internal/task/engine_test.go`
- Modify: `internal/task/orchestrate.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/serve_flags_test.go` only if constructor wiring requires it

**Step 1: Write failing engine tests**

Add a narrow fake runtime in task tests with recorded calls. It must implement:

```go
type WorkspaceRuntime interface {
    Prepare(ctx context.Context, taskID, cwd string, requested workspace.RequestedMode) (workspace.Metadata, error)
    CleanupPrepared(ctx context.Context, taskID string, meta workspace.Metadata) error
    Capture(ctx context.Context, meta workspace.Metadata, taskID string, eventSeq int) (workspace.Checkpoint, error)
    Restore(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error
    PrepareFork(ctx context.Context, newTaskID string, source workspace.Metadata, cp workspace.Checkpoint) (workspace.Metadata, error)
}
```

Tests must establish:

1. `CreateRequest.WorkspaceMode` is passed to `Prepare`.
2. Prepared metadata is persisted on the task.
3. The adapter receives `Task.EffectiveCwd()`, not original `Cwd`.
4. All workers in `runOrchestrated` receive the same effective cwd.
5. Nil runtime preserves current shared behavior and existing tests.
6. prepare failure inserts no task and starts no adapter.
7. insert failure after prepare calls `CleanupPrepared` exactly once.

Run:

```bash
go test ./internal/task -run 'TestCreate.*Workspace|TestOrchestrated.*Workspace' -count=1
```

Expected: FAIL because the request/runtime fields do not exist.

**Step 2: Add engine wiring**

- Add `WorkspaceMode workspace.RequestedMode` with JSON `workspace_mode,omitempty` to `CreateRequest`.
- Add `workspace WorkspaceRuntime` to `Engine`.
- Add `SetWorkspaceRuntime(runtime WorkspaceRuntime)`; do not change `NewEngine` parameters because many tests construct it.
- With nil runtime, synthesize shared metadata using the original cwd.
- With a runtime, call `Prepare` after generating the task ID and before inserting the task.
- Convert metadata into the seven store fields from Task 10.
- If `InsertTask` fails, call `CleanupPrepared` with a five-second background timeout and return the insert error. Cleanup errors may be logged but must not replace the primary error.
- Change every `adapter.TaskSpec{Cwd: ...}` in single and orchestrated runs to use `t.EffectiveCwd()`.

Do not capture checkpoints in this task; Task 13 adds that behavior.

**Step 3: Wire the server**

In `ServeWith`, construct:

```go
workspaces := workspace.NewManager(stateDir)
eng.SetWorkspaceRuntime(workspaces)
```

The API dependency is added later. Do not create a second manager.

**Step 4: Verify**

```bash
gofmt -w internal/task/engine.go internal/task/engine_test.go internal/task/orchestrate.go internal/task/fork_retry_test.go internal/server/server.go
go test ./internal/task ./internal/server -count=1
go test ./internal/adapter/... -count=1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/task/engine.go internal/task/engine_test.go internal/task/orchestrate.go internal/task/fork_retry_test.go internal/server/server.go internal/server/serve_flags_test.go
git commit -m "feat(task): execute tasks in prepared workspaces"
```

### Task 12: Make workspace file APIs use the effective task root

**Files:**

- Modify: `internal/api/workspace.go`
- Modify: `internal/api/workspace_test.go`

**Step 1: Write failing tests**

Insert a task whose original `Cwd` contains `source.txt` and whose `ExecutionCwd` contains different `isolated.txt`. Assert:

- list root returns only the execution workspace entries;
- reading `isolated.txt` succeeds;
- reading `source.txt` returns 404;
- response `root` is the effective cwd;
- historical task with empty `ExecutionCwd` still reads original cwd.

Run `go test ./internal/api -run TestTaskWorkspaceUsesEffectiveCwd -count=1`; expected: FAIL.

**Step 2: Implement the one-line semantic boundary**

Change `workspaceEnvForTask` to call `newWorkspaceEnv(t.EffectiveCwd())`. Do not weaken any path, symlink, binary, UTF-8, or size check.

**Step 3: Verify**

```bash
gofmt -w internal/api/workspace.go internal/api/workspace_test.go
go test ./internal/api -run 'TestTaskWorkspace' -count=1
```

Expected: PASS.

**Step 4: Commit**

```bash
git add internal/api/workspace.go internal/api/workspace_test.go
git commit -m "fix(api): resolve files from task execution workspace"
```

## Phase C — private checkpoints and filesystem-aware history

### Task 13: Capture and restore private Git tree checkpoints

**Files:**

- Create: `internal/workspace/checkpoint.go`
- Create: `internal/workspace/checkpoint_test.go`
- Modify: `internal/workspace/manager.go`
- Modify: `internal/workspace/types.go`

**Step 1: Write failing real-Git tests**

Use a prepared isolated worktree fixture. Tests must cover:

1. Capture after modifying a tracked file, deleting a tracked file, and creating an untracked non-ignored file.
2. The returned `TreeOID`, `HeadOID`, and positive size are stable and non-empty.
3. New object files exist under `stateDir/checkpoints/<task-id>/objects`.
4. The source repository object directory does not gain the captured untracked file's blob. Compute its blob OID with `git hash-object --stdin` before capture and assert `<repo-objects>/<first2>/<rest>` does not appear afterward.
5. Ignored `.env` is excluded from the checkpoint and restore leaves it untouched; Kin never uses `git clean -fdx`.
6. After additional edits and an agent-created commit, Restore returns the branch to captured `HeadOID` and exactly restores tracked/deleted/untracked checkpoint content.
7. Restore leaves the real index matching `HeadOID`; restored differences appear as ordinary unstaged/untracked changes.
8. shared metadata returns `ErrNotIsolated` without running destructive Git.
9. a symlink or metadata path outside Kin's worktree/checkpoint roots is rejected.
10. one changed file over 16 MiB or aggregate changed files over 256 MiB returns `ErrSnapshotTooLarge` before `git add`.
11. cancellation leaves no temporary index file.

Run `go test ./internal/workspace -run 'TestCheckpoint|TestRestore' -count=1`; expected: FAIL.

**Step 2: Implement checkpoint paths and limits**

Add constants:

```go
const (
    MaxCheckpointFileBytes  int64 = 16 << 20
    MaxCheckpointTotalBytes int64 = 256 << 20
)
```

Add:

```go
func (m *Manager) Capture(ctx context.Context, meta Metadata, taskID string, eventSeq int) (Checkpoint, error)
func (m *Manager) Restore(ctx context.Context, meta Metadata, taskID string, cp Checkpoint) error
```

Capture algorithm, in order:

1. Validate isolated metadata, ULID task ID, worktree containment, and effective cwd.
2. Run `git status --porcelain=v1 -z --untracked-files=normal`; extract candidate paths and stat regular files without following symlinks. Enforce limits. Deleted paths count as zero.
3. Resolve real common Git dir with `git rev-parse --git-common-dir`, absolutize it, and use `<common>/objects` as the normal object directory.
4. Create private object directory `stateDir/checkpoints/<task-id>/objects` mode `0700` and a temporary index in the same task checkpoint directory.
5. For capture commands set:

```text
GIT_INDEX_FILE=<temp-index>
GIT_OBJECT_DIRECTORY=<private-objects>
GIT_ALTERNATE_OBJECT_DIRECTORIES=<normal-objects>
GIT_TERMINAL_PROMPT=0
```

6. Run from `meta.Root`: `git read-tree HEAD`, `git add -A -- .`, `git write-tree`, and `git rev-parse HEAD`.
7. Always remove the temporary index. Return the tree/head OIDs and measured size.

Restore algorithm, in order:

1. Reject non-isolated metadata and validate both Kin-owned roots.
2. Verify the supplied task ID matches checkpoint task ID and OIDs are 40–64 lowercase hex characters.
3. With a 60-second context run `git reset --hard <head-oid>` and `git clean -fd` in the Kin-owned worktree.
4. Run `git read-tree --reset -u <tree-oid>` with the repository's normal object directory and private object directory as an alternate.
5. Run `git reset --mixed <head-oid>` to return the real index to HEAD without changing restored files.

Never log file names/content from private checkpoint capture errors.

**Step 3: Verify including race**

```bash
gofmt -w internal/workspace/checkpoint.go internal/workspace/checkpoint_test.go internal/workspace/manager.go internal/workspace/types.go
go test ./internal/workspace -run 'TestCheckpoint|TestRestore' -count=1
go test -race ./internal/workspace -count=1
```

Expected: PASS.

**Step 4: Commit**

```bash
git add internal/workspace/checkpoint.go internal/workspace/checkpoint_test.go internal/workspace/manager.go internal/workspace/types.go
git commit -m "feat(workspace): capture private turn checkpoints"
```

### Task 14: Capture a checkpoint before every user turn

**Files:**

- Modify: `internal/task/engine.go`
- Modify: `internal/task/approvals.go`
- Modify: `internal/task/engine_test.go`
- Modify: `internal/task/approvals_test.go`
- Modify: `internal/task/fork_retry_test.go`

**Step 1: Add failing tests**

Fake the runtime Capture method and verify:

- initial task creation captures once with the initial user-message sequence before queue pumping starts;
- a completed-task follow-up captures immediately before requeue;
- interrupt-and-guide captures only after the prior handle has stopped and before the guided run starts;
- shared/nil runtime creates no checkpoint rows;
- successful capture writes the exact returned OIDs/size to store;
- `ErrSnapshotTooLarge` and other capture failures append one `checkpoint_skipped` event and still run the task;
- no error string includes environment values;
- a captured checkpoint is keyed to a user message, never an assistant/meta event.

Run:

```bash
go test ./internal/task -run 'Test.*Checkpoint' -count=1
```

Expected: FAIL.

**Step 2: Add conversion helpers**

In task package add private helpers:

```go
func workspaceMetadata(t store.Task) workspace.Metadata
func storeCheckpoint(cp workspace.Checkpoint) store.TaskCheckpoint
func runtimeCheckpoint(cp store.TaskCheckpoint) workspace.Checkpoint
```

Do not duplicate effective-cwd logic.

**Step 3: Add best-effort capture**

Add:

```go
func (e *Engine) captureCheckpoint(ctx context.Context, t store.Task, userSeq int)
```

It returns immediately for nil runtime or non-worktree tasks. On success it calls `PutCheckpoint`. On failure it appends and publishes a `checkpoint_skipped` event with only a stable reason category (`too_large`, `git_error`, or `unavailable`), not raw command output.

Creation order must be:

1. prepare and insert task;
2. append/publish user message and obtain sequence;
3. capture/persist checkpoint;
4. enqueue/pump.

Follow-up order must similarly capture after appending the user event and before enqueue. It is acceptable for capture failure to degrade recovery; it must not block the task.

**Step 4: Verify**

```bash
gofmt -w internal/task/engine.go internal/task/approvals.go internal/task/engine_test.go internal/task/approvals_test.go internal/task/fork_retry_test.go
go test ./internal/task -run 'Test.*Checkpoint' -count=1
go test ./internal/task -count=1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/task/engine.go internal/task/approvals.go internal/task/engine_test.go internal/task/approvals_test.go internal/task/fork_retry_test.go
git commit -m "feat(task): checkpoint isolated workspaces per turn"
```

### Task 15: Restore files during Retry and clone files during Fork

**Files:**

- Modify: `internal/workspace/prepare.go`
- Modify: `internal/workspace/prepare_test.go`
- Modify: `internal/task/approvals.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`

**Step 1: Write failing Retry tests**

Extend `RetryRequest` with:

```go
RestoreFiles *bool `json:"restore_files,omitempty"`
```

Semantics: omitted means true for isolated tasks and false for shared tasks. Tests must prove:

1. isolated retry looks up the checkpoint for the resolved user turn and calls Restore before `TruncateEventsFrom`;
2. restore error returns `workspace.ErrCheckpointUnavailable` or wrapped Git error and leaves every event/checkpoint/task status unchanged;
3. after successful restore, checkpoints from the selected sequence onward are deleted, the user event is re-seeded, and a replacement checkpoint is captured;
4. `restore_files=false` preserves today's conversation-only behavior;
5. shared historical retry never attempts restore.

Use a store wrapper/hook or query event rows inside the fake Restore callback to prove truncation has not happened yet.

**Step 2: Write failing Fork tests**

Add `Manager.PrepareFork` tests and engine tests:

- select `GetCheckpointAtOrBefore(sourceTask, maxSeq)`;
- create a new worktree at checkpoint `HeadOID`;
- Restore the source private tree into the new worktree using the source checkpoint objects;
- capture a new initial checkpoint under the fork task ID;
- persist new task workspace metadata and keep source workspace untouched;
- if an isolated source has no usable checkpoint, return `ErrCheckpointUnavailable` and insert no fork task;
- shared/historical sources preserve shared transcript-only fork behavior.

**Step 3: Implement PrepareFork**

```go
func (m *Manager) PrepareFork(ctx context.Context, newTaskID string, source Metadata, cp Checkpoint) (Metadata, error)
```

Create the destination worktree/branch at `cp.HeadOID`, materialize `cp.TreeOID` using the source task's private object directory as an alternate, reset the destination index to `cp.HeadOID`, and return destination metadata with `BaseOID=source.BaseOID`. Implement this through a private `restoreTree` helper that accepts a checkpoint-object owner separately; the public `Restore` method must still require `taskID == cp.TaskID`. On any partial failure, clean only the newly prepared destination using `CleanupPrepared`.

**Step 4: Implement engine ordering**

Retry must restore first. Fork must prepare filesystem before inserting destination task. Convert checkpoint errors to HTTP `409 Conflict` in retry/fork handlers; invalid input remains `400` and missing task remains `404`.

**Step 5: Verify**

```bash
gofmt -w internal/workspace/prepare.go internal/workspace/prepare_test.go internal/task/approvals.go internal/task/fork_retry_test.go internal/api/api.go internal/api/api_test.go
go test ./internal/workspace -run TestPrepareFork -count=1
go test ./internal/task -run 'TestRetry|TestFork' -count=1
go test ./internal/api -run 'Test.*Retry|Test.*Fork' -count=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add internal/workspace/prepare.go internal/workspace/prepare_test.go internal/task/approvals.go internal/task/fork_retry_test.go internal/api/api.go internal/api/api_test.go
git commit -m "feat(task): restore workspace state on retry and fork"
```

### Task 16: Add explicit whole-task discard

**Files:**

- Modify: `internal/task/approvals.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`

**Step 1: Write failing tests**

Add engine method contract:

```go
func (e *Engine) RestoreWorkspace(ctx context.Context, taskID string, eventSeq int) (store.Task, error)
```

Tests:

- eventSeq `0` chooses initial checkpoint;
- a positive sequence chooses checkpoint at or before that sequence;
- queued/running/waiting task returns `task.ErrConflict` and does not call Restore;
- shared task returns `workspace.ErrNotIsolated`;
- success appends `workspace_restored` meta event containing only `event_seq` and publishes it;
- restore failure appends nothing and does not change task status;
- repeated restore is safe.

API route:

```text
POST /api/tasks/{id}/workspace/restore
body: {"event_seq": 0}
```

Status mapping: `200` task, `404` missing task/checkpoint, `409` non-terminal/shared conflict, `500` unexpected restore failure with no Git stderr/file content.

**Step 2: Implement and verify**

Register the route beside workspace list/file. Decode a strict JSON body with `DisallowUnknownFields`; empty body means event sequence zero.

```bash
gofmt -w internal/task/approvals.go internal/task/fork_retry_test.go internal/api/api.go internal/api/api_test.go
go test ./internal/task -run TestRestoreWorkspace -count=1
go test ./internal/api -run TestRestoreWorkspace -count=1
```

Expected: PASS.

**Step 3: Commit**

```bash
git add internal/task/approvals.go internal/task/fork_retry_test.go internal/api/api.go internal/api/api_test.go
git commit -m "feat(api): restore isolated task workspace"
```

## Phase D — source-of-truth diff API

### Task 17: Enumerate Git changes safely

**Files:**

- Create: `internal/workspace/changes.go`
- Create: `internal/workspace/changes_test.go`
- Modify: `internal/workspace/types.go`

**Step 1: Add exact response types**

```go
type ChangeStatus string

const (
    ChangeAdded     ChangeStatus = "added"
    ChangeModified  ChangeStatus = "modified"
    ChangeDeleted   ChangeStatus = "deleted"
    ChangeRenamed   ChangeStatus = "renamed"
    ChangeCopied    ChangeStatus = "copied"
    ChangeType      ChangeStatus = "type_changed"
    ChangeUntracked ChangeStatus = "untracked"
)

type Change struct {
    Path    string       `json:"path"`
    OldPath string       `json:"old_path,omitempty"`
    Status  ChangeStatus `json:"status"`
}

type ChangesResult struct {
    Supported bool     `json:"supported"`
    Mode      string   `json:"mode"`
    BaseOID   string   `json:"base_oid,omitempty"`
    Changes   []Change `json:"changes"`
    Warning   string   `json:"warning,omitempty"`
}
```

**Step 2: Write failing NUL-parser unit tests**

Test byte fixtures for `git diff --name-status -z -M` containing modified, added, deleted, type change, rename with old/new paths, copy, spaces, tabs, newline inside a filename, invalid status, truncated rename pair, absolute paths, and `../` paths. Invalid/traversing output must return an error, never be skipped silently.

Test untracked `git ls-files -z` parsing and de-duplication when a path already appears in tracked changes.

Run `go test ./internal/workspace -run 'TestParse.*Changes' -count=1`; expected: FAIL.

**Step 3: Write failing integration tests**

In a real prepared worktree, create:

- committed change after task base;
- staged modification;
- unstaged modification;
- added/untracked file;
- deletion;
- rename.

Assert `Manager.Changes` returns every item once, relative to `Metadata.Scope`, sorted by `Path` then `OldPath`. Add a nested-scope test proving sibling changes are excluded. Shared Git metadata with a recorded base works but returns a warning; non-Git/historical metadata returns `Supported=false` and an empty non-nil list.

**Step 4: Implement**

```go
func (m *Manager) Changes(ctx context.Context, meta Metadata) (ChangesResult, error)
```

Commands:

```text
git diff --name-status -z -M <base-oid> -- <scope>
git ls-files --others --exclude-standard -z -- <scope>
```

Use a 15-second context. Strip the repository-scope prefix only after validating that each repo-relative path is inside it. Return slash-separated task-relative paths. Do not derive changes from event logs in this package.

**Step 5: Verify and commit**

```bash
gofmt -w internal/workspace/types.go internal/workspace/changes.go internal/workspace/changes_test.go
go test ./internal/workspace -run 'TestParse.*Changes|TestChanges' -count=1
git add internal/workspace/types.go internal/workspace/changes.go internal/workspace/changes_test.go
git commit -m "feat(workspace): enumerate task git changes"
```

### Task 18: Read bounded old and new versions for one change

**Files:**

- Create: `internal/workspace/diff.go`
- Create: `internal/workspace/diff_test.go`
- Modify: `internal/workspace/types.go`

**Step 1: Define the response**

```go
type FileDiff struct {
    Path         string       `json:"path"`
    OldPath      string       `json:"old_path,omitempty"`
    Status       ChangeStatus `json:"status"`
    OldContent   string       `json:"old_content"`
    NewContent   string       `json:"new_content"`
    OldTruncated bool         `json:"old_truncated"`
    NewTruncated bool         `json:"new_truncated"`
    Binary       bool         `json:"binary"`
}
```

Reuse the existing workspace text policy: hard limit 5 MiB, soft response limit 512 KiB, NUL binary probe, valid UTF-8, and trimming at a UTF-8 boundary. Move shared constants/helpers from `internal/api/workspace.go` into `internal/workspace/text.go` as exported `TextReadHardLimit`, `TextReadSoftLimit`, `TextBinaryProbe`, `ReadTextFile`, and `TrimValidUTF8`. In `internal/api/workspace.go`, keep compatibility aliases for existing package tests (`workspaceReadHardLimit = workspace.TextReadHardLimit`, etc.) and call the shared helpers rather than duplicate behavior.

**Step 2: Write failing tests**

Cover modified, added, untracked, deleted, and renamed text files; binary old/new sides; hard-limit response; soft truncation; Unicode boundary; path traversal; symlink escape; path not present in `Changes`; nested scope; a filename beginning with `-`; and a committed change after base.

`Manager.FileDiff` must first call/validate against the structured change list so an arbitrary Git object path cannot be requested.

Run `go test ./internal/workspace -run 'TestFileDiff|TestTextContent' -count=1`; expected: FAIL.

**Step 3: Implement exact sources**

```go
func (m *Manager) FileDiff(ctx context.Context, meta Metadata, taskRelativePath string) (FileDiff, error)
```

- Modified/deleted old side: `git show <base-oid>:<repo-relative-old-path>`.
- Added/untracked old side: empty.
- Modified/added/untracked new side: containment-checked filesystem read under effective task cwd.
- Deleted new side: empty.
- Rename old side uses `OldPath`; new side uses `Path`.
- Binary on either present side sets `Binary=true` and returns both contents empty.
- Never put file content into an error.

**Step 4: Update existing API text helpers**

Make workspace list/read tests remain green after sharing helpers. Do not change their HTTP response shapes in this task.

**Step 5: Verify and commit**

```bash
gofmt -w internal/workspace/types.go internal/workspace/text.go internal/workspace/diff.go internal/workspace/diff_test.go internal/api/workspace.go internal/api/workspace_test.go
go test ./internal/workspace ./internal/api -run 'TestFileDiff|TestTextContent|TestTaskWorkspace' -count=1
git add internal/workspace/types.go internal/workspace/text.go internal/workspace/diff.go internal/workspace/diff_test.go internal/api/workspace.go internal/api/workspace_test.go
git commit -m "feat(workspace): read bounded task file diffs"
```

### Task 19: Expose probe, changes, and diff APIs

**Files:**

- Modify: `internal/api/api.go`
- Modify: `internal/api/workspace.go`
- Modify: `internal/api/workspace_test.go`
- Modify: `internal/server/server.go`

**Step 1: Add the dependency and routes**

Add `Workspaces *workspace.Manager` to `api.Server`. Pass the same manager instance already installed on the engine.

Register authenticated routes:

```text
POST /api/workspaces/probe                         {"cwd":"..."}
GET  /api/tasks/{id}/workspace/changes
GET  /api/tasks/{id}/workspace/diff?path=<path>
```

Probe body uses `DisallowUnknownFields`, max 64 KiB, and requires non-empty cwd. These are normal authenticated APIs because they expose only the same local workspace information already available to task APIs; terminal routes remain separately loopback-only.

**Step 2: Write failing handler tests**

Test missing auth, invalid/unknown JSON, empty cwd, clean/dirty probe response, missing task, unsupported historical task (`200` with `supported=false`), structured changes, encoded Unicode/newline path, traversal rejection, binary diff response, oversized file status, and manager unavailable (`503`).

Expected status mapping:

- malformed request/path: `400`;
- missing task/change/file: `404`;
- hard-limit content: `413`;
- Git timeout/unexpected error: `500` with generic operation message;
- absent workspace manager: `503`.

Run `go test ./internal/api -run 'TestWorkspaceProbe|TestTaskWorkspaceChanges|TestTaskWorkspaceDiff' -count=1`; expected: FAIL.

**Step 3: Implement handlers and verify**

Use `store.Task` metadata conversion in one API helper. Always return `changes: []`, never null.

```bash
gofmt -w internal/api/api.go internal/api/workspace.go internal/api/workspace_test.go internal/server/server.go
go test ./internal/api ./internal/server -count=1
```

Expected: PASS.

**Step 4: Commit**

```bash
git add internal/api/api.go internal/api/workspace.go internal/api/workspace_test.go internal/server/server.go
git commit -m "feat(api): expose task workspace diffs"
```

## Phase E — desktop isolation and review UI

### Task 20: Add typed workspace clients and pure review helpers

**Files:**

- Modify: `ui/src/api/client.ts`
- Create: `ui/src/lib/workspaceReview.ts`
- Create: `ui/src/lib/workspaceReview.test.ts`

**Step 1: Write failing pure tests**

Define tests for:

- resolved display state for clean auto, dirty auto, explicit shared, explicit worktree, and non-Git;
- change sorting by status group then path;
- deduplicating review comments by `(path, side, line)` while keeping latest text;
- rejecting blank comments and line numbers below one;
- deterministic review prompt serialization with paths and comment text preserved verbatim but fenced safely;
- retry body defaults: isolated tasks send `restore_files:true`, shared tasks omit it.

Run `cd ui && npm test -- src/lib/workspaceReview.test.ts`; expected: FAIL.

**Step 2: Add exact API types/calls**

Add types mirroring Go JSON:

```ts
export type WorkspaceRequestedMode = "auto" | "shared" | "worktree";
export type WorkspaceResolvedMode = "shared" | "worktree";
export type WorkspaceChangeStatus =
  | "added" | "modified" | "deleted" | "renamed"
  | "copied" | "type_changed" | "untracked";
```

Extend `Task` with the seven workspace fields. Extend `CreateTaskBody` with `workspace_mode?`. Extend retry body with `restore_files?`.

Add:

```ts
probeWorkspace(cwd: string): Promise<WorkspaceProbe>
listTaskWorkspaceChanges(taskId: string): Promise<WorkspaceChangesResult>
getTaskWorkspaceDiff(taskId: string, path: string): Promise<TaskWorkspaceDiff>
restoreTaskWorkspace(taskId: string, eventSeq?: number): Promise<Task>
```

All task/path IDs use `encodeURIComponent`; query paths use `URLSearchParams`.

**Step 3: Implement helpers and verify**

The review prompt must use this stable structure:

```text
Please address the following code review comments. Preserve unrelated changes and report how each item was resolved.

1. `path/to/file.go` — new line 42
   <comment text>
```

Do not use JSON serialization as the human-facing prompt.

```bash
cd ui
npm test -- src/lib/workspaceReview.test.ts
npm run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add ui/src/api/client.ts ui/src/lib/workspaceReview.ts ui/src/lib/workspaceReview.test.ts
git commit -m "feat(ui): add typed workspace review clients"
```

### Task 21: Add workspace isolation choice to New Chat

**Files:**

- Create: `ui/src/components/chat/WorkspaceModePicker.tsx`
- Modify: `ui/src/pages/NewChatPage.tsx`
- Modify: `ui/src/lib/draftChat.ts`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Implement draft persistence**

Add best-effort localStorage helpers for `WorkspaceRequestedMode` under key `kin_draft_workspace_mode`, default `auto`. Use the same subscription pattern as cwd if cross-component updates are needed. Invalid values reset to `auto`.

**Step 2: Implement debounced probe**

In NewChat, probe a non-empty cwd after 300 ms. Use a monotonically increasing request ID so stale results cannot replace a newer cwd. Probe failure shows a small unavailable hint but never prevents shared task creation.

**Step 3: Implement accessible picker**

Render three radio choices below permission mode:

- Auto (recommended): isolated for clean Git, shared otherwise;
- Isolated worktree;
- Current folder.

Show probe facts without raw Git stderr:

- clean Git: “A separate task branch will be created.”
- dirty Git + auto: “Current folder will be used because it has uncommitted changes.”
- dirty Git + explicit isolated: “Uncommitted source changes are not included.”
- non-Git/unborn/no Git: disable explicit isolated and show reason.

The submit body includes `workspace_mode`. Keep default selection across reloads.

**Step 4: Verify**

```bash
cd ui
npm test
npm run typecheck
npm run build
```

Run `@vercel:react-best-practices` on the picker/NewChat changes. Confirm keyboard operation and both locale shapes.

**Step 5: Commit**

```bash
git add ui/src/components/chat/WorkspaceModePicker.tsx ui/src/pages/NewChatPage.tsx ui/src/lib/draftChat.ts ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): choose isolated task workspaces"
```

### Task 22: Make desktop terminal and task chrome workspace-aware

**Files:**

- Modify: `ui/src/components/layout/AppShell.tsx`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Use effective cwd for terminal**

Change selected-task terminal cwd to:

```ts
selectedTask?.execution_cwd || selectedTask?.cwd || ""
```

Do not change sidebar grouping; it must continue to use original `task.cwd`.

**Step 2: Add task workspace badge**

In task detail header show:

- `Isolated` for `workspace_mode=worktree`, with original project path in title and execution path in details;
- `Shared folder` for shared tasks;
- no alarming badge for historical tasks whose field is absent—treat them as shared.

Pass effective cwd to `WorkspacePanel`, while its project label continues to show original cwd.

**Step 3: Verify and commit**

```bash
cd ui && npm test && npm run typecheck && npm run build
cd ..
git add ui/src/components/layout/AppShell.tsx ui/src/pages/TaskDetailPage.tsx ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): surface task workspace isolation"
```

### Task 23: Add Files and Changes tabs to the workspace panel

**Files:**

- Create: `ui/src/components/workspace/WorkspaceTabs.tsx`
- Create: `ui/src/components/workspace/ChangeList.tsx`
- Create: `ui/src/components/workspace/DiffViewer.tsx`
- Modify: `ui/src/components/workspace/WorkspacePanel.tsx`
- Modify: `ui/src/components/workspace/CodeViewer.tsx`
- Modify: `ui/src/components/workspace/ChangedFilesBar.tsx`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Build tab state**

WorkspacePanel owns `activeTab: "files" | "changes"`. Opening a path from the existing file tree selects Files. Clicking the changed-files bar opens Changes and selects that change when it exists; otherwise it falls back to Files.

Tabs must be semantic buttons with `aria-selected`, visible focus, and left/right keyboard movement.

**Step 2: Load changes on demand**

On first Changes open, call `listTaskWorkspaceChanges`. Reload when:

- task becomes terminal;
- a follow-up starts/finishes;
- the user clicks Refresh.

Do not poll continuously. Preserve the selected path if still present. Empty, unsupported, loading, error, binary, and disconnected states require explicit UI.

**Step 3: Render Monaco DiffEditor**

`DiffViewer` imports `DiffEditor` from `@monaco-editor/react` and reuses local Monaco setup. Options:

```ts
const DIFF_OPTIONS = {
  readOnly: true,
  renderSideBySide: true,
  enableSplitViewResizing: true,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  originalEditable: false,
} as const;
```

Use inline diff below 760 px via `matchMedia`; subscribe/unsubscribe correctly. Added/deleted sides use empty strings. Binary/oversized files show metadata without Monaco. Keep an error boundary fallback similar to CodeViewer.

**Step 4: Replace event-inferred changes when Git is supported**

TaskDetail may continue calculating `extractChangedFiles(events)` as fallback. When API changes are supported, map them into the changed-files bar and label the bar “Changed files”; do not mix inferred reads into the Git list.

**Step 5: Verify**

```bash
cd ui
npm test
npm run typecheck
npm run build
```

Run `@vercel:react-best-practices`. Manually inspect modified, added, deleted, rename, binary, empty, and narrow-width states.

**Step 6: Commit**

```bash
git add ui/src/components/workspace/WorkspaceTabs.tsx ui/src/components/workspace/ChangeList.tsx ui/src/components/workspace/DiffViewer.tsx ui/src/components/workspace/WorkspacePanel.tsx ui/src/components/workspace/CodeViewer.tsx ui/src/components/workspace/ChangedFilesBar.tsx ui/src/pages/TaskDetailPage.tsx ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): review task changes in a diff panel"
```

### Task 24: Add line-specific review drafts and submit feedback

**Files:**

- Create: `ui/src/components/workspace/ReviewDraft.tsx`
- Modify: `ui/src/components/workspace/DiffViewer.tsx`
- Modify: `ui/src/components/workspace/WorkspacePanel.tsx`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Add selected-line contract**

`DiffViewer` exposes:

```ts
type DiffSelection = {
  path: string;
  side: "old" | "new";
  line: number;
};
```

On Monaco mount, listen to cursor selection changes for original and modified editors. Update selection only for line >= 1. Dispose listeners on unmount/file change.

Provide a keyboard-accessible “Comment on old/new line N” button outside Monaco. Do not rely solely on mouse gutter interaction.

**Step 2: Build ReviewDraft**

The component displays selected location, textarea, Add/Update, cancel, comment list, remove, and “Send review (N)”. Keep draft comments in WorkspacePanel state so switching files/tabs preserves them; clearing the panel/task clears them. Do not use `window.prompt` and do not persist comments to localStorage.

**Step 3: Submit through existing follow-up**

WorkspacePanel calls an `onSubmitReview(prompt)` prop. TaskDetail passes a wrapper around existing composer submission/follow-up behavior. On success:

- clear comments;
- close the comment editor;
- keep Changes tab open;
- show the existing sending/running state.

On failure keep every draft comment. Disable submit when task action is busy, no comments exist, or any comment is blank.

**Step 4: Verify and commit**

```bash
cd ui && npm test && npm run typecheck && npm run build
cd ..
git add ui/src/components/workspace/ReviewDraft.tsx ui/src/components/workspace/DiffViewer.tsx ui/src/components/workspace/WorkspacePanel.tsx ui/src/pages/TaskDetailPage.tsx ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): send line-specific diff review feedback"
```

### Task 25: Add safe Retry restore and whole-task discard UI

**Files:**

- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/components/chat/ChatStream.tsx`
- Modify: `ui/src/components/workspace/WorkspacePanel.tsx`
- Modify: `ui/src/lib/workspaceReview.ts`
- Modify: `ui/src/lib/workspaceReview.test.ts`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Retry behavior**

For an isolated task, the existing Retry action sends `{from_seq, restore_files:true}` and its title says both conversation and files will rewind. Shared/historical tasks preserve conversation-only retry and explicitly say files are unchanged.

If isolated Retry returns `409` checkpoint unavailable, keep the UI unchanged and show a message explaining that the user may choose conversation-only retry. Provide a secondary confirmation action that resends with `restore_files:false`; never fall back automatically.

**Step 2: Discard behavior**

WorkspacePanel shows “Discard task changes” only when task is terminal and isolated. Clicking opens an in-app confirmation containing:

- task title;
- execution workspace path;
- statement that the task transcript remains;
- statement that all files return to the initial checkpoint.

Confirm calls `restoreTaskWorkspace(task.id, 0)`. On success reload changes and file tree, clear selected file/review comments, and show a toast. On failure do not clear UI state. Never show this action for a shared task.

Do not use a generic browser `confirm`; use the repository's existing modal pattern or create a small semantic dialog local to WorkspacePanel.

**Step 3: Verify and commit**

```bash
cd ui && npm test && npm run typecheck && npm run build
cd ..
git add ui/src/pages/TaskDetailPage.tsx ui/src/components/chat/ChatStream.tsx ui/src/components/workspace/WorkspacePanel.tsx ui/src/lib/workspaceReview.ts ui/src/lib/workspaceReview.test.ts ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): restore files during task history actions"
```

## Phase F — end-to-end hardening

### Task 26: Add end-to-end Git workspace integration coverage

**Files:**

- Create: `internal/workspace/integration_test.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/api/workspace_test.go`
- Modify: `docs/IMPL_NOTES.md`

**Step 1: Write one real full-flow test**

Use a real temporary Git repository, real workspace Manager, store, task engine, and a fake adapter that edits files in `spec.Cwd`. Cover this exact flow:

1. create clean source repo and initial commit;
2. create isolated task;
3. assert adapter cwd is Kin worktree and source file is unchanged;
4. fake first turn modifies tracked file and creates a file;
5. follow-up captures checkpoint, then second turn changes both;
6. changes/diff show second-turn state;
7. Retry the second user turn with restore and assert first-turn file state exists before rerun;
8. Fork from the second user turn and assert source/destination worktrees are distinct with equal checkpoint contents;
9. mutate fork and prove source task is unchanged;
10. restore source task initial checkpoint and assert source checkout remains unchanged.

Do not use the developer's repository or global Git config.

**Step 2: Add recovery/failure tests**

Cover daemon `Recover` retaining workspace metadata/checkpoints, missing worktree directory producing a stable error instead of falling back to source cwd, and a timed-out Git command leaving events untouched.

**Step 3: Document implementation facts**

Add an “Isolated task workspaces” section to IMPL_NOTES covering schema version, auto-mode rules, state directories, effective cwd, checkpoint limits, API routes, and retention/non-goals. Do not copy the whole plan.

**Step 4: Verify and commit**

```bash
gofmt -w internal/workspace/integration_test.go internal/task/fork_retry_test.go internal/api/workspace_test.go
go test -race ./internal/workspace ./internal/task ./internal/api -count=1
git diff --check -- docs/IMPL_NOTES.md internal/workspace/integration_test.go internal/task/fork_retry_test.go internal/api/workspace_test.go
git add internal/workspace/integration_test.go internal/task/fork_retry_test.go internal/api/workspace_test.go docs/IMPL_NOTES.md
git commit -m "test(workspace): cover isolated task lifecycle"
```

### Task 27: Verify the shipped desktop experience

**Files:** Modify only relevant files when a reproduced defect requires a fix; regenerate `web/dist/` after UI fixes.

**Step 1: Automated verification**

Run in order:

```bash
go test -race ./internal/workspace ./internal/task ./internal/api ./internal/server ./internal/terminal
go test ./...
go vet ./...
cd ui
npm ci
npm test
npm run typecheck
npm run build
cd ../desktop
npm ci
npm run typecheck
npm run build
cd ..
make test
```

Every command must pass. If a generated Monaco bundle makes global `git diff --check` report minifier-owned trailing whitespace, run diff-check on every hand-written changed file and record the generated exception; do not hand-edit minified output.

**Step 2: Electron scenario verification**

Create a disposable real Git repository. In Electron verify:

1. clean repo defaults to isolated; dirty repo defaults to shared with explanation;
2. explicit isolated dirty task excludes source uncommitted changes and says so;
3. two tasks from one clean repo have different execution paths and cannot see each other's edits;
4. terminal opens in selected task execution cwd and survives hide/show/reload;
5. Files tree reads isolated content, not source checkout;
6. Changes shows modified/added/deleted/renamed/binary states;
7. side-by-side desktop and inline narrow diff layouts have no blank/squeezed panel regression;
8. line comments survive file/tab changes and submit one follow-up prompt;
9. failed review submission preserves comments;
10. isolated Retry restores both conversation and files; conversation-only fallback is explicit;
11. Fork creates a distinct workspace with matching selected checkpoint state;
12. discard restores initial task files while source checkout and transcript remain;
13. shared/non-Git tasks never expose destructive restore;
14. normal browser/phone UI has no terminal but can read task diffs and submit review feedback;
15. keyboard/focus operation works for workspace mode, tabs, change list, comment draft, confirmation, and terminal.

Capture representative 1440, 1024, 800, and 700 px screenshots under an ignored temporary path. Do not commit screenshots unless the repository already tracks a deliberate visual fixture.

**Step 3: Required reviews**

- Run `@security-auditor` on Git command construction, path containment, private objects, restore ordering, and HTTP errors.
- Run `@vercel:react-best-practices` on every changed TSX file.
- Review migration 005 with populated and empty databases.
- Review `git diff main...HEAD --stat` and every hand-written diff.

Fix only blocking findings. Each fix gets its own test and focused Conventional Commit.

### Task 28: Final checkpoint and handoff

**Files:** No planned source changes.

**Step 1: Confirm history and tree**

```bash
git status --short --branch
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
```

Expected: clean feature worktree and atomic commits matching the plan.

**Step 2: Confirm acceptance criteria**

- [ ] Terminal Tasks 7–12 are complete and desktop-only.
- [ ] Clean Git tasks default to separate Kin worktrees.
- [ ] Dirty/non-Git auto mode remains shared with clear UI.
- [ ] Original cwd remains project grouping/provenance; adapters/terminal/files use effective cwd.
- [ ] Git change list includes committed, staged, unstaged, rename/delete, and untracked content.
- [ ] Diff content is bounded, UTF-8 checked, binary aware, and traversal safe.
- [ ] Review comments serialize deterministically and survive submission failure.
- [ ] Every isolated user turn has a checkpoint or visible skipped reason.
- [ ] Retry restores before truncating conversation; Fork clones checkpoint files.
- [ ] Discard is terminal-only, isolated-only, explicit, and leaves source checkout untouched.
- [ ] Existing schema-v4/historical tasks remain usable as shared tasks.
- [ ] Full Go/UI/Desktop verification passes and `web/dist` matches source.
- [ ] No secrets, local databases, state directories, Git fixtures, logs, or screenshots are staged.

**Step 3: Merge policy**

Do not push, force-push, or rebase a shared branch. The user has already requested direct integration into `main` in this thread, so after all acceptance items pass, fast-forward the main worktree without another confirmation:

```bash
git -C /path/to/main-worktree merge --ff-only feat/desktop-core-workflows
```

Then report the final commit range, verification commands, manual scenarios, any generated-file diff-check exception, and any intentionally deferred item.

## Expected commit sequence

The executor may add focused `fix(...)` commits after a failed verification, but must not squash these planned checkpoints:

```text
feat(ui): add typed terminal client foundation
feat(ui): render interactive xterm sessions
feat(ui): add resizable terminal panel controls
feat(ui): integrate desktop terminal shortcut
docs(architecture): accept isolated task workspaces
feat(workspace): add safe git command boundary
feat(workspace): probe git task isolation support
feat(workspace): prepare isolated task worktrees
feat(store): persist task workspaces and checkpoints
feat(task): execute tasks in prepared workspaces
fix(api): resolve files from task execution workspace
feat(workspace): capture private turn checkpoints
feat(task): checkpoint isolated workspaces per turn
feat(task): restore workspace state on retry and fork
feat(api): restore isolated task workspace
feat(workspace): enumerate task git changes
feat(workspace): read bounded task file diffs
feat(api): expose task workspace diffs
feat(ui): add typed workspace review clients
feat(ui): choose isolated task workspaces
feat(ui): surface task workspace isolation
feat(ui): review task changes in a diff panel
feat(ui): send line-specific diff review feedback
feat(ui): restore files during task history actions
test(workspace): cover isolated task lifecycle
```

## Stop conditions

Stop execution and ask for direction when any of these occurs:

- the base branch lacks terminal backend commits through `6dc24de`;
- schema version is no longer 4 before Task 10 because another migration landed;
- a worktree/checkpoint target cannot be proven inside the configured Kin state directory;
- Git on the supported macOS target does not accept a required plumbing command;
- private-object capture writes an object into the source repository during the isolation test;
- restore would need to run destructive Git against a shared/source checkout;
- Retry cannot guarantee restore-before-truncate ordering;
- an existing API consumer requires `tasks.cwd` to change meaning;
- tests require real Claude/Codex credentials or network access;
- an unrelated dirty file overlaps a planned edit;
- any full-suite check fails for a reason introduced by the feature.
