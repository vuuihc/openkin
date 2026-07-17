# Integrated Terminal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a VS Code-style bottom terminal panel to the Kin Electron desktop app, toggled with `Ctrl+Backquote`, with multiple ephemeral terminal tabs and a profile picker for installed shells such as zsh, bash, and fish.

**Architecture:** Add a standalone `internal/terminal` runtime that owns interactive PTY processes, bounded output replay, resize, attachment, and cleanup. Expose it through token-authenticated, true-loopback-only REST and WebSocket routes; render each session with xterm.js in a resizable panel mounted by `AppShell`. Keep this separate from `rawpty`, task history, SQLite, remote access, and Electron IPC so the existing HTTP/WebSocket language boundary stays intact without exposing a local shell over LAN, Tailnet, or Funnel.

**Tech Stack:** Go 1.26, `creack/pty`, `nhooyr.io/websocket`, React 18, TypeScript 5, Vite, `@xterm/xterm`, `@xterm/addon-fit`, Vitest, Electron 33.

---

## 1. Decision and scope

Implement this feature, but ship a deliberately smaller terminal than VS Code's mature terminal subsystem.

### 1.1 Required first-release behavior

1. `Ctrl+Backquote` toggles a bottom panel in the main Electron window. Use `KeyboardEvent.code === "Backquote"` so the shortcut is not broken by keyboard layout or Shift producing `~`.
2. Opening the panel for the first time creates one terminal with the default detected profile when a working directory is known.
3. The new-terminal dropdown lists backend-detected shell profiles. Selecting one starts that executable; xterm.js does not discover or start shells.
4. The user can keep up to eight terminal tabs, switch between them, and explicitly close them.
5. The panel can be resized vertically. Its height is a client preference stored in `localStorage`; shell sessions and terminal output are not stored there.
6. A terminal starts in the current task's `cwd`, or the current new-chat draft `cwd`. If neither exists, show a choose-folder empty state and use the existing Electron native directory picker.
7. Hiding the panel does not stop its terminals. Closing a tab does stop that PTY process group. Daemon shutdown stops every PTY process group.
8. Reloading the renderer lists live sessions and can reattach. A bounded 1 MiB per-session output buffer replays recent output; output older than that is intentionally discarded.
9. A shell exit leaves the tab visible with an exit status until the user closes it. Exited sessions are automatically removed after five minutes if the UI does not close them.
10. Terminal REST and WebSocket routes require both the existing Kin token and a true loopback TCP peer. `X-Forwarded-For` must neither grant nor revoke local access.
11. The panel is rendered only when `window.kinDesktop?.isDesktop` is true. It is absent from the tray popover, normal browser UI, phone UI, LAN, Tailnet, and Funnel.
12. All new user-visible strings are added to both English and Chinese catalogs, and the generated `web/dist/` is committed with UI source changes.

### 1.2 Explicit non-goals

- No shell or terminal transcript persistence in SQLite.
- No terminal sessions attached to Kin tasks, approvals, task events, or cost accounting.
- No remote terminal access, sharing, collaborative terminals, SSH profiles, containers, WSL, or task-runner profiles.
- No arbitrary executable or arguments supplied by the browser. The browser sends only a backend-issued `profile_id`.
- No VS Code shell integration protocol, semantic command decorations, split panes, link providers, search UI, terminal history UI, GPU renderer add-on, or extension API.
- No Windows support in this release. macOS is the supported target; Linux can remain best-effort because `creack/pty` already supports it.
- No changes to `internal/adapter/rawpty`. That adapter executes one task prompt through `/bin/sh -c`, coalesces task output, and has no interactive input/resize contract. Sharing its handle would couple terminal lifetime to task lifetime.
- No multiline-paste warning in the first release. Record this as follow-up work if user testing shows accidental execution is common.

### 1.3 Why this design

| Approach | Decision | Reason |
|---|---|---|
| Go PTY manager + loopback HTTP/WS + xterm.js | **Use** | Matches the existing UI-to-core boundary, reuses `creack/pty`, supports renderer reload, and centralizes process cleanup. |
| Electron `node-pty` over IPC | Reject for v1 | Adds a second terminal backend and native Node module packaging, bypasses the documented HTTP/WS boundary, and behaves differently in browser development. |
| Reuse `rawpty.Adapter` | Reject | It is a one-shot task adapter without input, resize, attachment, replay, or independent session lifecycle. |

The security property is transport-level, not a UI convention: a valid Kin token received over LAN/Tailnet/Funnel still receives `403 loopback only` from every terminal route.

## 2. Target data flow

```text
Electron renderer (desktop marker present)
  AppShell
    └── TerminalPanel
          ├── REST: profiles / sessions / delete
          └── one WebSocket per mounted terminal tab
                 binary client → server: raw PTY input
                 binary server → client: raw PTY output
                 text client → server: resize / ping controls
                 text server → client: ready / exit / error controls
                         │
                         ▼
              loopbackOnly + token auth
                         │
                         ▼
                terminal.Manager
                  ├── detected, immutable profiles
                  ├── max 8 ephemeral sessions
                  ├── 1 MiB output ring per session
                  └── PTY process group cleanup
```

Do not put terminal messages on the existing global `/api/ws` bus. PTY traffic is binary, high volume, session-specific, and requires backpressure behavior that task updates do not.

## 3. Contracts that must remain stable

### 3.1 REST

All routes below sit in their own `chi` group with `loopbackOnly` followed by `s.Auth.Middleware`.

```text
GET    /api/terminal/profiles
GET    /api/terminal/sessions
POST   /api/terminal/sessions
DELETE /api/terminal/sessions/{id}
GET    /api/terminal/sessions/{id}/ws       WebSocket upgrade
```

Response and request shapes:

```go
type Profile struct {
    ID         string   `json:"id"`
    Name       string   `json:"name"`
    Executable string   `json:"executable"`
    Args       []string `json:"-"` // never let the client mutate these
    Default    bool     `json:"default"`
}

type SessionInfo struct {
    ID        string `json:"id"`
    ProfileID string `json:"profile_id"`
    Name      string `json:"name"`
    Cwd       string `json:"cwd"`
    Status    string `json:"status"` // running | exited | closing
    ExitCode  *int   `json:"exit_code,omitempty"`
    CreatedAt int64  `json:"created_at"` // Unix milliseconds
}

type CreateRequest struct {
    ProfileID string `json:"profile_id"`
    Cwd       string `json:"cwd"`
    Cols      uint16 `json:"cols"`
    Rows      uint16 `json:"rows"`
}
```

Contract details:

- `GET profiles` returns `{ "profiles": [...], "default_profile_id": "zsh" }`; an empty profile list is `200`, not `null` and not `500`.
- `GET sessions` returns a stable `created_at` ordering and always returns `[]` rather than `null`.
- `POST sessions` returns `201` plus `SessionInfo`.
- Unknown profile: `400`. Invalid/missing/non-directory cwd: `400`. Invalid size: `400`. Session cap: `429`. PTY startup failure: `500` with operation context but no environment dump.
- `DELETE` is idempotent: a known session returns `204`; an unknown/already-removed session also returns `204`. This keeps React cleanup safe under Strict Mode and retries.
- The backend clamps accepted dimensions to `2..500` columns and `1..200` rows. Do not pass zero or unbounded values to `pty.Setsize`.
- Cwd is cleaned and converted to an absolute path, then checked with `os.Stat` and `IsDir`. Do not attempt workspace containment: a local interactive shell can `cd` anywhere anyway.

### 3.2 WebSocket framing

Use WebSocket message type, not a JSON `data` wrapper, to distinguish streams:

```text
binary client → server    exact bytes to write to PTY
binary server → client    exact bytes read from PTY
text client → server      {"type":"resize","cols":120,"rows":40}
text client → server      {"type":"ping"}
text server → client      {"type":"ready","session":{...}}
text server → client      {"type":"exit","exit_code":0}
text server → client      {"type":"error","message":"..."}
```

Rules:

- Send `ready` first, then the current replay snapshot, then live output. Register the subscriber and take the snapshot under the same session lock so bytes cannot fall into a gap.
- Permit only one attached WebSocket per session. A second attachment gets HTTP `409` before upgrade. This prevents two renderer instances from racing over input and resize.
- A WebSocket disconnect detaches only the client; it does not kill the shell. A reloaded renderer can list and reattach.
- Bound the subscriber channel. If the renderer cannot keep up, close that attachment with `StatusPolicyViolation` and keep the PTY running; never block the PTY reader on a slow WebSocket.
- Use five-second write timeouts and validate every text control frame. Unknown controls close with `StatusUnsupportedData`.
- Cap a single input/control frame at 64 KiB with `conn.SetReadLimit(64 << 10)`.
- If an `Origin` header exists, parse it and require a loopback hostname. This is defense in depth; true-peer loopback plus token auth remains authoritative. CLI clients without `Origin` are allowed.

## 4. Session lifecycle invariants

The implementation is incomplete unless all of these are covered by tests:

1. `Manager.Create` never binds child lifetime to the HTTP request context.
2. Profile definitions are copied into the manager and cannot be mutated by callers.
3. A session starts via `pty.StartWithSize` with `TERM=xterm-256color`, `COLORTERM=truecolor`, and `TERM_PROGRAM=Kin`. Replace existing keys instead of appending duplicate environment entries.
4. The process inherits the daemon environment because an interactive local shell is explicitly the feature, but no environment values are logged or returned by the API.
5. `Session.Write`, `Session.Resize`, attachment changes, output buffering, and close/exit transitions are race-safe.
6. EOF from the PTY is followed by exactly one `cmd.Wait`. Exit status is recorded once; normal shell exit is not reported as a daemon error.
7. Explicit close sends `SIGTERM` to the PTY process group, closes the PTY to unblock reads, and sends `SIGKILL` after five seconds only if the process has not exited.
8. `Manager.Close` is idempotent and waits for all session cleanup, bounded by the same five-second kill path.
9. The output buffer is byte-oriented, keeps only the newest 1 MiB, and is copied before returning to avoid data races.
10. Exited sessions remain listable/attachable long enough for the UI to show the exit code; a reaper removes exited sessions after five minutes.
11. Running sessions with no attached client remain alive. The eight-session cap prevents unbounded leaks after repeated renderer reloads.
12. A removed session ID cannot be reused; generate IDs with the repository's existing ULID dependency.

### 4.1 Execution protocol

- Execute this plan in a dedicated feature worktree/branch created from the commit containing this document; keep `main` as the review base.
- Use `@executing-plans` to run tasks in order and stop at the named verification checkpoints.
- Use `@tdd` for Tasks 2–5. Do not write production behavior before the listed failing test exists.
- After changing TSX, run `@vercel:react-best-practices` if that skill is available and address only findings relevant to this feature.
- Before final handoff, use `@security-auditor` to review the terminal route boundary, profile selection, WebSocket validation, and process cleanup. This is review, not permission to broaden the implementation.
- Preserve every unrelated working-tree change. Stage only the explicit paths listed by each task.

## 5. Implementation tasks

### Task 1: Record the local-shell security decision

**Files:**

- Create: `docs/adr/0004-local-integrated-terminal.md`
- Modify: `SYSTEM_DESIGN.md`
- Modify: `SYSTEM_DESIGN.zh.md`

**Step 1: Write the ADR**

Create an ADR with status `Accepted`, context, decision, consequences, and rejected alternatives. It must state:

- the integrated terminal is an Electron-desktop convenience, not a remotely accessible Kin capability;
- every terminal API requires a real loopback peer plus the Kin token;
- sessions are ephemeral and excluded from SQLite/export/audit;
- the backend accepts only detected profile IDs, never browser-provided executable paths or args;
- `rawpty` remains a task adapter and is not the session runtime;
- the feature intentionally grants the local user account's shell authority and is not an approval-gated Kin tool.

**Step 2: Update both system-design languages**

Under the implementation snapshot/client-shell discussion, add one concise row/paragraph describing the desktop-only local integrated terminal and its loopback-only API boundary. Keep English and Chinese semantically aligned. Do not promote it into an MVP product pillar.

**Step 3: Review the diff**

Run:

```bash
git diff --check
git diff -- docs/adr/0004-local-integrated-terminal.md SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md
```

Expected: no whitespace errors; both languages describe the same restriction.

**Step 4: Commit**

```bash
git add docs/adr/0004-local-integrated-terminal.md SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md
git commit -m "docs(architecture): define local terminal boundary"
```

### Task 2: Add deterministic shell profile discovery

**Files:**

- Create: `internal/terminal/profile.go`
- Create: `internal/terminal/profile_test.go`

**Step 1: Write failing table-driven tests**

Cover these cases with injected `getenv`, `lookPath`, and `stat` functions rather than mutating the developer machine:

- `$SHELL=/bin/zsh` makes zsh the default.
- `$SHELL` absent falls back to the first valid candidate in order `zsh`, `bash`, `fish`.
- duplicate resolved paths appear once.
- a missing, relative, directory, or non-executable candidate is skipped.
- an unknown but valid absolute login shell appears with a stable `login` ID.
- exactly one returned profile has `Default=true` when the list is non-empty.
- returned profiles are sorted default first, then case-insensitive name.

The detector should use a private dependency struct so production still calls `os.Getenv`, `exec.LookPath`, and `os.Stat` directly.

**Step 2: Run the test to verify it fails**

```bash
go test ./internal/terminal -run TestDetectProfiles -count=1
```

Expected: FAIL because the package/contracts do not exist.

**Step 3: Implement the profile model and detector**

Use this public surface:

```go
const (
    DefaultCols = 80
    DefaultRows = 24
)

type Profile struct {
    ID         string   `json:"id"`
    Name       string   `json:"name"`
    Executable string   `json:"executable"`
    Args       []string `json:"-"`
    Default    bool     `json:"default"`
}

func DetectProfiles() []Profile
func DefaultProfileID(profiles []Profile) string
```

Discovery algorithm:

1. Inspect `$SHELL` first when it is absolute.
2. Inspect `exec.LookPath` for `zsh`, `bash`, and `fish` in that order.
3. Resolve each path to an absolute clean path. Do not require symlink resolution; deduplicate on the clean absolute result returned by discovery.
4. Require a regular file with at least one execute bit.
5. Use login args `[]string{"-l"}` for known shells. For an unknown `$SHELL`, use `-l` only after manually verifying that shell supports it; otherwise use no args. For v1, treating unknown login shells as no-arg is the safe compatibility choice.
6. Prefer IDs `zsh`, `bash`, `fish`; use `login` only for an unknown login shell. Resolve ID collisions deterministically.
7. Mark the `$SHELL` match default; otherwise mark the first candidate default.

Do not read `/etc/shells` in v1; it produces profiles that may be administrative shells or unavailable in the daemon's execution environment.

**Step 4: Run and format**

```bash
gofmt -w internal/terminal/profile.go internal/terminal/profile_test.go
go test ./internal/terminal -run TestDetectProfiles -count=1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/terminal/profile.go internal/terminal/profile_test.go
git commit -m "feat(terminal): discover local shell profiles"
```

### Task 3: Build and test the PTY session manager

**Files:**

- Create: `internal/terminal/manager.go`
- Create: `internal/terminal/ring.go`
- Create: `internal/terminal/manager_test.go`
- Create: `internal/terminal/ring_test.go`

**Step 1: Write the ring-buffer tests**

Test empty snapshot, append below cap, append across cap, one append larger than cap, and snapshot copy isolation. Use a tiny cap such as eight bytes in tests.

**Step 2: Run the ring tests to verify failure**

```bash
go test ./internal/terminal -run TestByteRing -count=1
```

Expected: FAIL because `byteRing` is undefined.

**Step 3: Implement the bounded byte ring**

Keep it private. The owner session lock provides synchronization; do not add a second mutex. Required methods:

```go
func newByteRing(capacity int) *byteRing
func (r *byteRing) Append(p []byte)
func (r *byteRing) Snapshot() []byte
```

**Step 4: Write manager tests before manager code**

Use a test-only profile pointing to `/bin/sh` and a temporary cwd. Cover:

- create rejects unknown profile, missing cwd, file cwd, and out-of-range dimensions;
- create starts in requested cwd (`pwd` output contains the temp directory);
- writing `printf 'KIN_PTY_OK\\n'\nexit\n` produces output and records exit code 0;
- `stty size` changes after `Resize`;
- output before attachment appears in the replay snapshot;
- attach is exclusive; detach permits a later attach;
- a deliberately full subscriber does not block subsequent PTY reads and is evicted;
- max sessions returns `ErrSessionLimit`;
- close removes/kills a long-running shell and is idempotent;
- manager close terminates all children and rejects future creates;
- environment replacement has one value for `TERM`, `COLORTERM`, and `TERM_PROGRAM`.

Every test must register `t.Cleanup(manager.Close)` and use timeouts/selects so failures cannot hang `go test`.

**Step 5: Run manager tests to verify failure**

```bash
go test ./internal/terminal -run 'TestManager|TestSession' -count=1 -timeout=30s
```

Expected: FAIL because manager/session types are undefined.

**Step 6: Implement the public manager surface**

Use these contracts; private fields may differ:

```go
const (
    MaxSessions      = 8
    ReplayBytes      = 1 << 20
    SubscriberDepth  = 64
    ExitedRetention  = 5 * time.Minute
)

var (
    ErrNotFound     = errors.New("terminal session not found")
    ErrProfile      = errors.New("invalid terminal profile")
    ErrCwd          = errors.New("invalid terminal cwd")
    ErrSize         = errors.New("invalid terminal size")
    ErrSessionLimit = errors.New("terminal session limit reached")
    ErrAttached     = errors.New("terminal session already attached")
    ErrClosed       = errors.New("terminal manager closed")
)

type CreateRequest struct {
    ProfileID string `json:"profile_id"`
    Cwd       string `json:"cwd"`
    Cols      uint16 `json:"cols"`
    Rows      uint16 `json:"rows"`
}

type SessionInfo struct { /* exact fields from section 3.1 */ }

type Attachment struct {
    Replay []byte
    Output <-chan []byte
    Exit   <-chan int
    detach func()
}

func (a *Attachment) Detach()

type Manager struct { /* private state */ }

func NewManager(profiles []Profile) *Manager
func (m *Manager) Profiles() []Profile
func (m *Manager) List() []SessionInfo
func (m *Manager) Create(req CreateRequest) (SessionInfo, error)
func (m *Manager) Attach(id string) (*Attachment, error)
func (m *Manager) Write(id string, p []byte) error
func (m *Manager) Resize(id string, cols, rows uint16) error
func (m *Manager) Remove(id string) error
func (m *Manager) Close() error
```

Implementation notes for the weaker executor:

- Call `exec.Command`, not `exec.CommandContext` with a request context.
- Set `cmd.Dir` to the validated absolute cwd.
- Build environment through a helper that replaces keys rather than blindly appending.
- Start with `pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})`.
- `creack/pty` starts a new session/process group on Unix. Signal `-cmd.Process.Pid` as existing adapters do; do not combine `Setpgid` with `Setsid` on macOS.
- One goroutine owns PTY reads. It appends a copied chunk to replay, snapshots subscribers under lock, unlocks, then performs non-blocking sends.
- One goroutine calls `cmd.Wait` exactly once after the read loop reaches EOF. Record exit code under lock and notify the attachment once.
- Protect PTY writes with a write mutex because xterm input and clipboard paste can overlap.
- Make `Remove` delete the session from the manager map before signaling it, preventing new attachments during shutdown.
- Start one manager reaper ticker (for example, once per minute), not one ticker per session. `Close` stops it.
- Return copied `Profile`, `SessionInfo`, replay, and output chunks across public boundaries.

**Step 7: Run focused tests and the race detector**

```bash
gofmt -w internal/terminal/*.go
go test ./internal/terminal -count=1 -timeout=30s
go test -race ./internal/terminal -count=1 -timeout=60s
```

Expected: PASS with no goroutine leak, timeout, or race report.

**Step 8: Commit**

```bash
git add internal/terminal/manager.go internal/terminal/ring.go internal/terminal/manager_test.go internal/terminal/ring_test.go
git commit -m "feat(terminal): manage interactive PTY sessions"
```

### Task 4: Add loopback-only terminal REST handlers

**Files:**

- Modify: `internal/api/api.go`
- Create: `internal/api/terminal.go`
- Create: `internal/api/terminal_test.go`

**Step 1: Extend the API dependency container**

Add without changing existing constructor patterns:

```go
type Server struct {
    // existing fields...
    Terminals *terminal.Manager
}
```

Keep the terminal handlers in `terminal.go`; do not grow `api.go` with implementation details.

**Step 2: Write route/security tests first**

Update the test helper only as necessary to create a manager with a test shell profile. Test:

- no token from `127.0.0.1` returns `401`;
- valid token from `192.0.2.10` returns `403` for profiles, create, list, delete, and WS path;
- valid token and `X-Forwarded-For: 127.0.0.1` from a non-loopback `RemoteAddr` still returns `403`;
- valid token and `X-Forwarded-For: 192.0.2.10` from loopback still succeeds, proving the captured TCP peer wins;
- profile response does not serialize args;
- empty manager profile/session lists serialize as `[]`;
- create status/error mapping matches section 3.1;
- list returns the newly created session;
- delete twice returns `204` both times.

**Step 3: Run to verify failure**

```bash
go test ./internal/api -run 'TestTerminal.*REST|TestTerminal.*Loopback' -count=1
```

Expected: FAIL because routes do not exist.

**Step 4: Register a separate protected route group**

In `Handler`, after the general authenticated API group, add:

```go
r.Group(func(r chi.Router) {
    r.Use(loopbackOnly)
    r.Use(s.Auth.Middleware)
    r.Get("/api/terminal/profiles", s.handleTerminalProfiles)
    r.Get("/api/terminal/sessions", s.handleTerminalSessions)
    r.Post("/api/terminal/sessions", s.handleCreateTerminalSession)
    r.Delete("/api/terminal/sessions/{id}", s.handleDeleteTerminalSession)
    r.Get("/api/terminal/sessions/{id}/ws", s.handleTerminalWS)
})
```

Do not also register these under the existing public API group. Middleware order should reject non-loopback callers before performing terminal work.

If `s.Terminals == nil`, handlers return `503 {"error":"terminal unavailable"}`. This keeps existing API tests and alternate server construction deterministic.

**Step 5: Implement only REST handlers in this task**

Use `json.Decoder` with a small body limit (16 KiB is ample). Map sentinel errors with `errors.Is`; do not switch on error strings.

**Step 6: Format, run, and commit**

```bash
gofmt -w internal/api/api.go internal/api/terminal.go internal/api/terminal_test.go
go test ./internal/api -run 'TestTerminal.*REST|TestTerminal.*Loopback' -count=1
git add internal/api/api.go internal/api/terminal.go internal/api/terminal_test.go
git commit -m "feat(api): expose local terminal sessions"
```

Expected: focused tests PASS before commit.

### Task 5: Implement and test the terminal WebSocket bridge

**Files:**

- Modify: `internal/api/terminal.go`
- Modify: `internal/api/terminal_test.go`

**Step 1: Write an end-to-end WebSocket test**

Use a real `httptest.Server`, create a session by HTTP with a valid token, then dial its WS URL with `nhooyr.io/websocket`. Assert:

1. first text frame is `ready` with the correct session ID;
2. a binary input containing `printf 'KIN_WS_OK\\n'\n` yields binary output containing `KIN_WS_OK`;
3. a text resize control is accepted and a later `stty size` reports the requested rows/cols;
4. malformed resize closes with unsupported-data/policy status;
5. a second simultaneous dial fails with `409`;
6. after closing the first socket, a new dial succeeds and receives replay;
7. remote-peer behavior is already covered at handler level because `httptest.Server` connections are loopback.

Use bounded contexts for every read. Do not assume one PTY read equals one WebSocket frame; accumulate bytes until the marker appears.

**Step 2: Run to verify failure**

```bash
go test ./internal/api -run TestTerminalWebSocket -count=1 -timeout=30s
```

Expected: FAIL because WS handler is incomplete.

**Step 3: Implement attachment-before-upgrade reservation**

Call `Manager.Attach` before `websocket.Accept`; if it returns `ErrAttached`, respond `409` while HTTP status is still available. If accept fails, immediately detach.

After upgrade:

- set read limit;
- send ready text;
- send replay as one binary frame only when non-empty;
- start a read loop for input/control frames;
- run the output/write loop in the handler goroutine;
- cancel both directions on any error or request cancellation;
- detach exactly once with `defer`;
- translate exit notification to a text `exit` frame but keep the socket open until the client closes or the handler decides no more output remains.

Use `context.WithTimeout` for writes and never call concurrent `conn.Write` from multiple goroutines. Funnel all server writes through one loop/select.

**Step 4: Add Origin validation**

Implement a small helper with unit tests:

```go
func terminalOriginAllowed(origin string) bool
```

Empty is allowed. Otherwise parse with `url.Parse`, extract `Hostname`, parse as IP or accept `localhost`, and require loopback. Reject malformed values and non-loopback hosts. Do not trust `Host` or `X-Forwarded-Host` as a replacement.

**Step 5: Run focused tests and race detector**

```bash
gofmt -w internal/api/terminal.go internal/api/terminal_test.go
go test ./internal/api -run TestTerminal -count=1 -timeout=30s
go test -race ./internal/api -run TestTerminalWebSocket -count=1 -timeout=60s
```

Expected: PASS.

**Step 6: Commit**

```bash
git add internal/api/terminal.go internal/api/terminal_test.go
git commit -m "feat(api): stream local terminal PTY over websocket"
```

### Task 6: Wire terminal lifetime into the daemon

**Files:**

- Modify: `internal/server/server.go`
- Create: `internal/server/terminal_test.go`

**Step 1: Add a construction test or a narrow injectable helper**

The test must prove the API server receives the same manager that is later closed. Do not launch a full Tailscale transport to test this. If current `ServeWith` is too monolithic, extract only a small `newTerminalManager()` helper; do not refactor unrelated server bootstrap.

**Step 2: Construct and defer cleanup**

Immediately before creating `api.Server`:

```go
profiles := terminal.DetectProfiles()
terminals := terminal.NewManager(profiles)
defer terminals.Close()
```

Set `Terminals: terminals` in `api.Server`.

No profiles is not a daemon startup error. The UI will show “No supported shell found,” and task/chat features keep working.

**Step 3: Preserve shutdown ordering**

Allow `httpServer.Shutdown` to close handlers first, then deferred `terminals.Close` kills remaining children before `ServeWith` returns. Do not close the manager before active WebSocket handlers have been canceled by HTTP shutdown.

**Step 4: Verify**

```bash
gofmt -w internal/server/server.go internal/server/terminal_test.go
go test ./internal/server ./internal/api ./internal/terminal -count=1 -timeout=60s
```

**Step 5: Commit**

```bash
git add internal/server/server.go internal/server/terminal_test.go
git commit -m "feat(server): supervise integrated terminal sessions"
```

### Task 7: Add xterm dependencies and typed terminal client helpers

**Files:**

- Modify: `ui/package.json`
- Modify: `ui/package-lock.json`
- Modify: `ui/src/api/client.ts`
- Create: `ui/src/lib/terminal.ts`
- Create: `ui/src/lib/terminal.test.ts`

**Step 1: Install dependencies through npm**

```bash
cd ui
npm install @xterm/xterm @xterm/addon-fit
npm install --save-dev vitest
```

Do not hand-edit resolved versions in `package-lock.json`. Do not install deprecated `xterm` or `xterm-addon-fit` package names.

Add the script:

```json
"test": "vitest run"
```

**Step 2: Add pure helper tests**

Test:

- `isTerminalToggle` accepts only non-repeating `Ctrl+Backquote` and rejects `Meta+Backquote`, plain backquote, and other codes;
- panel height parsing falls back on invalid storage, clamps to minimum 180, and clamps to at most 70% of viewport;
- `contextCwd` prefers selected task cwd, then draft cwd, then empty;
- WS URL uses `ws:` for HTTP and `wss:` for HTTPS and URL-encodes token/session ID.

Keep helpers pure by passing location/viewport/storage strings as arguments. This lets Vitest run without jsdom.

**Step 3: Run to verify failure**

```bash
cd ui
npm test -- src/lib/terminal.test.ts
```

Expected: FAIL because helpers are absent.

**Step 4: Add typed API shapes and calls**

In `client.ts` add:

```ts
export type TerminalProfile = {
  id: string;
  name: string;
  executable: string;
  default: boolean;
};

export type TerminalSession = {
  id: string;
  profile_id: string;
  name: string;
  cwd: string;
  status: "running" | "exited" | "closing";
  exit_code?: number | null;
  created_at: number;
};

export type CreateTerminalSessionBody = {
  profile_id: string;
  cwd: string;
  cols: number;
  rows: number;
};

export function listTerminalProfiles(): Promise<{
  profiles: TerminalProfile[];
  default_profile_id: string;
}>;
export function listTerminalSessions(): Promise<TerminalSession[]>;
export function createTerminalSession(body: CreateTerminalSessionBody): Promise<TerminalSession>;
export function deleteTerminalSession(id: string): Promise<void>;
```

`terminalSocketURL` belongs in `ui/src/lib/terminal.ts` because it returns a WebSocket URL rather than fetching JSON. Reuse `getToken` rather than duplicating token storage keys.

**Step 5: Implement and test pure helpers**

Constants:

```ts
export const TERMINAL_HEIGHT_KEY = "kin_terminal_height";
export const MIN_TERMINAL_HEIGHT = 180;
export const DEFAULT_TERMINAL_HEIGHT = 320;
export const MAX_TERMINAL_VIEWPORT_RATIO = 0.7;
```

Make storage access best-effort with `try/catch`, matching existing theme/draft helpers.

**Step 6: Verify and commit**

```bash
cd ui
npm test
npm run typecheck
npm run build
cd ..
git add ui/package.json ui/package-lock.json ui/src/api/client.ts ui/src/lib/terminal.ts ui/src/lib/terminal.test.ts web/dist
git commit -m "feat(ui): add typed terminal client foundation"
```

Expected: tests and typecheck PASS.

### Task 8: Implement one xterm session view

**Files:**

- Create: `ui/src/components/terminal/TerminalView.tsx`
- Create: `ui/src/components/terminal/terminalTheme.ts`
- Modify: `ui/src/index.css`

**Step 1: Build `TerminalView` around an imperative xterm lifecycle**

Props:

```ts
type Props = {
  session: TerminalSession;
  active: boolean;
  onExit: (id: string, exitCode: number) => void;
  onConnectionChange: (
    id: string,
    status: "connecting" | "connected" | "disconnected",
  ) => void;
};
```

On mount:

1. Create one `Terminal` and one `FitAddon`; store both in refs.
2. Use `scrollback: 5000`, `cursorBlink: true`, `fontFamily` beginning with `SFMono-Regular, Menlo, Monaco, Consolas, monospace`, and `fontSize: 13`.
3. Open xterm on a dedicated container ref.
4. Set `WebSocket.binaryType = "arraybuffer"`.
5. On binary messages, call `terminal.write(new Uint8Array(...))`.
6. On text messages, narrow JSON by `type`; update exit state only for a valid numeric exit code. Never write control JSON into the terminal.
7. On `terminal.onData`, send binary UTF-8 using `TextEncoder`; do nothing unless socket state is `OPEN`.
8. On cleanup, dispose listeners, `ResizeObserver`, fit add-on, xterm, and socket. Do not delete the backend session merely because React unmounted.
9. Reconnect an unexpectedly closed socket with bounded backoff (250 ms, 500 ms, 1 s, then cap at 5 s) while the session is not known to have exited. Cancel the retry timer on unmount.
10. On every `ready` control, reset the local xterm before applying replay. This prevents duplicated output after reconnect; the bounded replay then reconstructs the recent screen/scrollback.

**Step 2: Resize correctly**

Observe the container with `ResizeObserver`. Coalesce calls through one `requestAnimationFrame`, call `fit.fit()`, then send a resize control only when cols/rows changed and are non-zero. When `active` changes true, fit and focus after layout via `requestAnimationFrame`.

Do not resize when the panel is hidden and its container reports zero size.

**Step 3: Implement clipboard keys**

Use `attachCustomKeyEventHandler`:

- `Ctrl+Backquote` returns `false` so `AppShell` owns the toggle.
- On macOS, `Meta+C` with a selection copies `terminal.getSelection()` and returns `false`; without selection, allow the event so the shell receives the interrupt semantics only for actual `Ctrl+C`, not `Meta+C`.
- `Meta+V`/`Ctrl+Shift+V` reads `navigator.clipboard` where available and calls `terminal.paste`; return `false` when handled.
- Fail clipboard promises silently but do not swallow the normal terminal key when the clipboard API is unavailable.

Do not override ordinary `Ctrl+C`; it must still send ETX when there is no selected text.

**Step 4: Theme through existing Kin tokens**

`terminalTheme.ts` should return xterm colors based on whether the root is light/dark. Listen for the existing theme change mechanism or observe root class/data changes with `MutationObserver`; update `terminal.options.theme` without rebuilding the session.

Add:

```css
@import "@xterm/xterm/css/xterm.css";
```

and only minimal `.kin-terminal` overrides needed to fill the container and preserve xterm accessibility textarea behavior. Do not globally restyle `.xterm` in a way that breaks dimensions.

**Step 5: Typecheck**

```bash
cd ui
npm run typecheck
npm run build
```

Expected: both PASS. The panel is not integrated yet, so there is no visible behavior to inspect.

**Step 6: Commit source and its generated console at this checkpoint**

```bash
cd ..
git add ui/src/components/terminal/TerminalView.tsx ui/src/components/terminal/terminalTheme.ts ui/src/index.css web/dist
git commit -m "feat(ui): render interactive xterm sessions"
```

The component is not routed yet, but `index.css` changes the shipped bundle, so `web/dist/` must stay atomic with this source commit.

### Task 9: Build the terminal panel, tabs, profile picker, and resize handle

**Files:**

- Create: `ui/src/components/terminal/TerminalPanel.tsx`
- Create: `ui/src/components/terminal/TerminalTabs.tsx`
- Create: `ui/src/components/terminal/TerminalProfileMenu.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`

**Step 1: Define panel ownership**

`TerminalPanel` owns:

- live `profiles`, `defaultProfileID`, and `sessions`;
- `activeSessionID`;
- loading/create/delete errors;
- connection status per session;
- profile menu open state;
- panel height and pointer-drag state.

It receives:

```ts
type Props = {
  open: boolean;
  cwd: string;
  onClose: () => void;
};
```

Keep the panel mounted once first opened so toggling visibility does not tear down xterm sockets. Use an internal `hasOpened` latch and render `null` only before the first open. Afterward use layout/CSS visibility while preserving component instances.

**Step 2: Load profiles and live sessions once**

On first open, call profiles and sessions in parallel. Handle React Strict Mode by guarding the effect with a ref or making state merge idempotent. Pick the newest running session as active, otherwise the newest exited session.

If no sessions exist and `cwd` is non-empty, create the default profile. If `cwd` is empty, do not send a failing request; show a choose-folder empty state.

**Step 3: Implement create semantics**

- The main `+` action creates the default profile.
- The adjacent chevron opens a menu listing every profile, with a check/default marker.
- Selecting a profile creates it in the current `cwd` with `80x24`; `TerminalView` sends the fitted size immediately after connection.
- Disable create while a request is in flight and when eight sessions already exist.
- If the route's `cwd` later changes, existing terminals keep their original cwd; only new terminals use the new value.
- If cwd is empty, call existing `pickDirectory`, then create with the chosen path. Store that choice as a panel-local `cwdOverride` so later new terminals reuse it; prefer a later non-empty `cwd` prop over the override. Do not mutate the chat draft automatically from a terminal-only folder choice.

**Step 4: Implement tabs and exit/close behavior**

- Tab label: profile display name, plus an ordinal only when more than one of the same profile exists.
- Active tab has semantic `aria-selected=true`; arrow keys move among tabs; Delete/Backspace closes only after focus is on a tab.
- A close button calls DELETE and removes local state only after success; for a disconnected daemon, allow a retry rather than pretending the child died.
- On exit, update the matching local session to `status="exited"` and show `exit {code}`. Do not auto-close the tab.
- When closing the active tab, select the nearest remaining tab. If none remain, leave the panel open on its empty state.

**Step 5: Implement accessible panel resizing**

The top edge is a separator:

```tsx
<div
  role="separator"
  aria-orientation="horizontal"
  aria-valuemin={MIN_TERMINAL_HEIGHT}
  aria-valuemax={maxHeight}
  aria-valuenow={height}
  tabIndex={0}
/>
```

- Pointer drag upward increases height; downward decreases it.
- Capture/release the pointer so dragging outside the handle continues safely.
- Arrow Up/Down changes height by 16 px; Home uses minimum; End uses maximum.
- Clamp to 180 px and 70% of current viewport.
- Store only the final clamped value after pointerup/keyboard adjustment.
- Add a visible focus state and at least a 6 px hit target without making the divider visually heavy.

**Step 6: Add all i18n keys in both catalogs**

At minimum:

```text
terminal.title
terminal.toggle
terminal.new
terminal.newWithProfile
terminal.closePanel
terminal.closeSession
terminal.chooseFolder
terminal.noProfiles
terminal.noSessions
terminal.loading
terminal.connecting
terminal.disconnected
terminal.exited
terminal.sessionLimit
terminal.createFailed
terminal.closeFailed
terminal.resize
```

The English and Chinese object shapes must remain identical because English is typed from the Chinese message tree.

**Step 7: Typecheck and commit**

```bash
cd ui
npm test
npm run typecheck
npm run build
cd ..
git add ui/src/components/terminal/TerminalPanel.tsx ui/src/components/terminal/TerminalTabs.tsx ui/src/components/terminal/TerminalProfileMenu.tsx ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): add resizable terminal panel controls"
```

Expected: PASS.

### Task 10: Integrate desktop toggle and command-palette discovery

**Files:**

- Modify: `ui/src/components/layout/AppShell.tsx`
- Modify: `ui/src/components/CommandPalette.tsx`
- Modify: `ui/src/lib/terminal.test.ts`
- Regenerate: `web/dist/`

**Step 1: Derive the cwd in `AppShell`**

The existing `tasks` state already carries each task cwd. Derive:

```ts
const selectedTask = tasks.find((task) => task.id === selectedTaskId);
const terminalCwd = selectedTask?.cwd ?? (draftActive ? getDraftCwd() : "");
```

Subscribe to draft changes while on `/new` using `subscribeDraft`, because the user can choose a folder after `AppShell` rendered. Do not fetch a task again solely for terminal cwd.

**Step 2: Own panel visibility globally**

Add `terminalOpen` state in `AppShell`. In the existing global shortcut effect:

```ts
if (desktop && isTerminalToggle(e)) {
  e.preventDefault();
  e.stopPropagation();
  setTerminalOpen((value) => !value);
  return;
}
```

Compute `desktop = isKinDesktop()` once per render. Ignore `e.repeat`. Keep existing new-chat and palette shortcuts unchanged.

**Step 3: Place the panel below route content**

Inside the right-side `flex-col`, render route content as the flexible upper region and `TerminalPanel` as a flex-none lower region. The disconnected banner and mobile header stay above both. Do not put the panel inside individual pages, or it will unmount on navigation.

**Step 4: Add a command-palette action**

Pass `onToggleTerminal` and `terminalAvailable` to `CommandPalette`. Add “Toggle Terminal” with `Ctrl+`` hint only when desktop is true. This provides discoverability and keyboard-accessible fallback. Add matching i18n keys to both catalogs if Task 9 did not already include them.

**Step 5: Add shortcut regression assertions**

Extend the pure helper test for Shift+Ctrl+Backquote (the physical key can produce `~`) and a synthetic repeat event. The expected decision is based on `code`, not `key`.

**Step 6: Build shipped assets**

```bash
cd ui
npm test
npm run build
cd ..
git status --short
```

Expected: source changes plus regenerated `web/dist/` files; no cache/log files.

**Step 7: Commit the completed UI and generated console**

```bash
git add ui/src/components/layout/AppShell.tsx ui/src/components/CommandPalette.tsx ui/src/lib/terminal.test.ts ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts web/dist
git commit -m "feat(ui): integrate desktop terminal shortcut"
```

Only stage locale files here if they changed after Task 9.

### Task 11: Verify behavior in Electron at desktop and narrow widths

**Files:**

- Modify only if verification exposes a bug: relevant files from Tasks 7–10
- Regenerate after any UI correction: `web/dist/`

**Step 1: Start the desktop development app**

In one terminal:

```bash
cd desktop
npm run dev
```

Expected: Electron launches, supervises the Go daemon, and opens the main Kin window in dev mode.

**Step 2: Verify the primary flow manually**

Record pass/fail for each item:

1. `Ctrl+`` opens the panel and focuses the prompt.
2. Running `printf 'hello\\n'` renders output without doubled newlines.
3. `pwd` equals the selected task/draft cwd.
4. The dropdown shows detected profiles; selecting bash/zsh/fish starts the selected shell.
5. Two tabs accept independent input and retain state while switching.
6. Hiding/reopening the panel preserves processes and screen contents.
7. Dragging and keyboard resizing update both panel height and `stty size`.
8. Text selection plus copy works; unselected `Ctrl+C` interrupts `sleep 30`.
9. Closing a tab terminates `sleep 300` and leaves no child process after the five-second grace period.
10. `exit 7` shows an exited tab with code 7.
11. Reloading the Electron renderer lists and reattaches to a running session with recent output replayed.
12. Command palette exposes Toggle Terminal.

**Step 3: Verify responsive/security presentation**

- Resize the Electron window to approximately 1280×800 and 700×600; confirm the terminal remains usable and does not overlap sidebar/mobile header.
- Open the daemon URL in a normal browser: terminal UI must not appear.
- If a LAN listener is available for testing, request `/api/terminal/profiles` from another device with a valid token and confirm `403`. Do not weaken the route if this check is inconvenient.

**Step 4: Fix only observed defects**

For every correction, rerun `npm test`, `npm run build`, and the focused Go test that covers the affected boundary. Keep corrections in an atomic `fix(terminal): ...` commit; do not amend commits made by another worker.

### Task 12: Run full verification and review the final diff

**Files:** none expected unless a check exposes a defect.

**Step 1: Backend checks**

```bash
go test ./...
go vet ./...
```

Expected: PASS.

**Step 2: Console and desktop checks**

```bash
cd ui
npm test
npm run build
cd ../desktop
npm run typecheck
npm run build
cd ..
```

Expected: PASS. `ui npm run build` must leave `web/dist/` identical to committed output.

**Step 3: Repository convenience check**

```bash
make test
```

Expected: PASS. If this duplicates prior commands, still run it because repository instructions explicitly name it as the whole-repository target.

**Step 4: Race checks for the new concurrent boundary**

```bash
go test -race ./internal/terminal ./internal/api -run Terminal -count=1 -timeout=90s
```

Expected: PASS with no race report.

**Step 5: Review scope and generated output**

```bash
git status --short
git diff --check main...HEAD
git log --oneline --decorate -12
```

Review that:

- no token, environment value, terminal output, database, logs, or local paths from manual testing were committed;
- terminal routes are absent from the remotely accessible authenticated API group;
- no executable/args field from a request reaches `exec.Command`;
- all process exit paths call `Wait` exactly once;
- `web/dist/` corresponds to the final UI source;
- English/Chinese catalogs match;
- unrelated working-tree changes remain untouched.

If all visible changes belong to this feature and verification is green, the working tree should be clean. Otherwise report each intentional exception and its risk instead of hiding it in a broad commit.

## 6. Acceptance criteria

The implementation is ready for review only when all statements are true:

- [ ] In Electron, `Ctrl+Backquote` toggles a persistent bottom panel from every main route.
- [ ] The panel can create terminals using a backend-detected default or explicitly selected shell profile.
- [ ] Each profile selection starts only the server-owned executable and args for that profile.
- [ ] Multiple tabs, input, ANSI rendering, copy/paste, resize, exit status, close, hide/show, and renderer reattach work.
- [ ] A selected task/draft cwd is used for new sessions; missing cwd produces a folder-choice state.
- [ ] Closing tabs and daemon shutdown leave no terminal child processes.
- [ ] Output buffering and slow clients cannot grow memory without bound or stall PTY reads.
- [ ] Terminal endpoints require a valid token and true loopback peer; forwarded headers cannot bypass this.
- [ ] Normal browser/remote/mobile/tray surfaces show no terminal UI.
- [ ] Backend, API, race, UI, desktop, build, and full repository checks pass.
- [ ] Both locales, architecture docs, ADR, UI source, lockfile, and generated `web/dist/` are committed atomically.

## 7. Review guide for the stronger reviewer

Review in this order; lifecycle/security defects matter more than visual polish:

1. **Remote exposure:** trace every terminal route through `loopbackOnly` and token auth using the captured TCP peer, not `RealIP` output.
2. **Command injection:** confirm request JSON can select only a profile ID and cwd; executable and args come exclusively from immutable server profiles.
3. **Process lifecycle:** enumerate create failure, normal exit, explicit tab close, WS disconnect, renderer reload, HTTP shutdown, and daemon signal paths. Confirm `Wait` once and eventual process-group kill.
4. **Concurrency/backpressure:** inspect locks, buffer copies, bounded channels, WebSocket single-writer behavior, attachment exclusivity, race-test results, and manager close idempotence.
5. **Protocol correctness:** verify binary PTY frames remain byte-exact and text frames are strictly narrowed controls.
6. **UI lifetime:** confirm route navigation/panel hiding does not delete sessions, while explicit close does.
7. **Accessibility/i18n:** verify focus, tabs, separator keyboard controls, labels, and both catalogs.
8. **Scope:** reject task history integration, remote terminal toggles, arbitrary custom profiles, broad Electron refactors, and unrelated cleanup from this change.

## 8. Expected commit sequence

The executor should produce small green commits in approximately this order:

```text
docs(architecture): define local terminal boundary
feat(terminal): discover local shell profiles
feat(terminal): manage interactive PTY sessions
feat(api): expose local terminal sessions
feat(api): stream local terminal PTY over websocket
feat(server): supervise integrated terminal sessions
feat(ui): add typed terminal client foundation
feat(ui): render interactive xterm sessions
feat(ui): add resizable terminal panel controls
feat(ui): integrate desktop terminal shortcut
fix(terminal): ...                       # only for observed verification defects
```

Never commit a known failing checkpoint. If an earlier task's public contract must change, update this plan or record the deviation in the implementation handoff before continuing so the reviewer can distinguish an intentional design correction from drift.
