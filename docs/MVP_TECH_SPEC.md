# Kin MVP Tech Spec

**Status:** v0.1 — implementation contract for the MVP (the agent console)  
**Audience:** the implementing engineer/agent. Follow this document literally. Where it says MUST/MUST NOT, do not improvise.  
**Context:** [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §2 (scope), §5 (remote ladder), §6 (implementation snapshot).

The MVP in one sentence: a self-hosted daemon that wraps external coding agents (Claude Code first), and a web console usable from desktop and phone to **dispatch, watch, and approve** their tasks — with cost per task.

---

## 0. Ground rules for the implementer

- **MUST NOT** build: a chat product, a memory system, user accounts, a Kin cloud/relay, an agent of your own, Docker/K8s deployment, React Native, any message queue or external database.
- **MUST NOT** add dependencies beyond the ones listed in §2 without a written reason in the PR description.
- The UI **MUST** talk to the daemon only via the HTTP/WS API in §6. No other channel.
- Every milestone in §10 has acceptance criteria. A milestone is done when its criteria pass, not before. Implement milestones **in order**.
- When Claude Code CLI behavior differs from this spec (flags renamed, JSON shape changed), trust the installed CLI: run `claude --help` and adapt the adapter, then note the difference in `docs/IMPL_NOTES.md`.

---

## 1. Repository layout

```text
kin/
├── go.mod                    # module github.com/vuuihc/kin   (confirm path, §12)
├── cmd/kin/main.go           # single binary: serve | run | approve-mcp | version
├── internal/
│   ├── adapter/              # Adapter interface + implementations
│   │   ├── adapter.go
│   │   ├── claudecode/
│   │   ├── codex/            # M4
│   │   └── rawpty/           # M4
│   ├── task/                 # task engine: state machine, event log
│   ├── store/                # SQLite persistence
│   ├── api/                  # HTTP + WS handlers (generated skeleton + glue)
│   ├── remote/               # LAN / tsnet / funnel listeners, auth
│   └── notify/               # Bark / ntfy webhooks (M3)
├── api/openapi.yaml          # single source of truth for the API
├── ui/                       # Vite + React + TS + Tailwind
│   └── src/{pages,components,api}
├── web/                      # `ui` build output, embedded via go:embed
└── docs/IMPL_NOTES.md        # deviations, gotchas, discovered CLI behavior
```

Desktop (Electron) shell is **out of scope for this spec**; it is a separate later task on the same API.

---

## 2. Locked technology choices

| Concern | Choice | Notes |
|---------|--------|-------|
| Language | Go ≥ 1.22 | daemon + CLI in one binary |
| SQLite | `modernc.org/sqlite` | pure Go, **no CGO anywhere** |
| PTY | `github.com/creack/pty` | rawpty adapter only |
| Router | `github.com/go-chi/chi/v5` | plus stdlib `net/http` |
| WebSocket | `nhooyr.io/websocket` | |
| IDs | `github.com/oklog/ulid/v2` | lexicographically sortable |
| Tailnet | `tailscale.com/tsnet` | M3 |
| API codegen | `oapi-codegen` (Go) + `openapi-typescript` (TS) | regenerate in CI, fail on drift |
| UI | Vite, React 18, TypeScript strict, Tailwind, `zustand` | no other state/query libs |
| QR | `github.com/skip2/go-qrcode` (terminal) + `qrcode.react` (settings page) | |

State directory: `~/.kin/` → `kin.db`, `token`, `logs/`. Default port: **7777**.

---

## 3. Data model (SQLite)

Apply as migration 001 via `PRAGMA user_version`.

```sql
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,          -- ULID
  title       TEXT NOT NULL,             -- first 80 chars of prompt if not given
  agent       TEXT NOT NULL,             -- 'claude-code' | 'codex' | 'rawpty'
  cwd         TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  model       TEXT,
  session_ref TEXT,                      -- agent-side session id (for follow-ups)
  status      TEXT NOT NULL,             -- queued|running|waiting_approval|succeeded|failed|canceled
  exit_code   INTEGER,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL,
  created_at  INTEGER NOT NULL,          -- unix ms
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE TABLE events (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  seq      INTEGER NOT NULL,             -- per-task, monotonically increasing
  ts       INTEGER NOT NULL,
  type     TEXT NOT NULL,                -- see §4 event types
  payload  TEXT NOT NULL,                -- JSON
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,          -- ULID
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  kind        TEXT NOT NULL,             -- 'tool_use' | 'generic'
  payload     TEXT NOT NULL,             -- JSON: tool name, input, agent-provided context
  decision    TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|denied|expired
  decided_via TEXT,                      -- 'web' | 'timeout'
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);

CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
```

Rules: events are **append-only**; every event is written to SQLite **before** being broadcast on WS. Task status transitions only through the engine (§5), never by handlers writing SQL directly.

---

## 4. Adapter layer

```go
type Adapter interface {
    // Start launches the agent process for a task and returns a handle.
    Start(ctx context.Context, spec TaskSpec) (RunHandle, error)
}

type RunHandle interface {
    Events() <-chan Event   // closed when the process exits
    Cancel() error          // SIGTERM, then SIGKILL after 5s
}

type Event struct {
    Type    string          // task_started | message | tool_use | approval_requested |
                            // usage | result | raw_output | error
    Payload json.RawMessage
}
```

### 4.1 Claude Code adapter (M1)

Launch per task, in `spec.Cwd`:

```bash
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --include-partial-messages \
  --mcp-config <generated-kin-mcp.json> \
  --permission-prompt-tool mcp__kin__approve
```

- Parse stdout line-by-line as JSON (`system/init` → capture `session_id` into `tasks.session_ref`; `assistant`/`user` messages → `message` events; `result` → `result` event with `total_cost_usd` and usage → write `cost_usd`, `tokens_*`).
- Unparseable lines become `raw_output` events; never crash on unknown JSON.
- Follow-up prompts (§6, M2): same command plus `--resume <session_ref>`.
- If `claude` is not on PATH, task fails with a clear `error` event naming the fix.

### 4.2 Approval bridge (M2) — how permission requests reach the phone

`--permission-prompt-tool` makes Claude Code call an MCP tool whenever it needs permission. Kin provides that tool:

1. Daemon writes a per-task MCP config file registering server `kin` = command `kin approve-mcp`, with env `KIN_TASK_ID`, `KIN_DAEMON=http://127.0.0.1:7777`, `KIN_TOKEN`.
2. `kin approve-mcp` is a **stdio MCP server** inside the same binary, exposing one tool `approve`. On each call it: POSTs the request to the daemon (`POST /internal/approvals`), then **long-polls** `GET /internal/approvals/{id}/wait` until decided.
3. It returns Claude Code's expected JSON: `{"behavior":"allow","updatedInput":<original input>}` or `{"behavior":"deny","message":"denied via Kin console"}`.
4. Daemon side: creating an approval sets task status `waiting_approval`, emits `approval_requested`, fires notifications (M3). Decision via API resumes it. **Timeout: 1 hour → decision `expired`, behavior deny.**

### 4.3 Codex adapter (M4)

Wrap `codex exec --json "<prompt>"` the same way (map its JSON events; tokens from usage events; cost from the local price table in `settings`, key `price_table`). If `--json` is unavailable in the installed version, fall back to rawpty and note it in IMPL_NOTES.

### 4.4 Raw PTY adapter (M4)

Any command under a PTY; emit chunked `raw_output` (coalesce to ≥100ms intervals); no structured approvals; exit code → result.

---

## 5. Task engine

- In-memory registry of running handles over the store. Dispatch → row `queued` → adapter start → `running`. Concurrency limit: 4 (setting `max_concurrent`), FIFO queue.
- Statuses: `queued → running → (waiting_approval ↔ running) → succeeded | failed | canceled`.
- On daemon restart: rows stuck in running-ish states become `failed` with an `error` event `"daemon restarted"`. (Reattach is out of scope.)

## 6. API

`api/openapi.yaml` is authoritative; routes:

```text
POST /api/tasks                    {agent, cwd, prompt, model?, title?} → Task
GET  /api/tasks?status=&limit=&before=      → Task[]
GET  /api/tasks/{id}                        → Task
GET  /api/tasks/{id}/events?since_seq=      → Event[]
POST /api/tasks/{id}/prompt        {prompt} → Task     (M2, resume follow-up)
POST /api/tasks/{id}/cancel                 → Task
GET  /api/approvals?status=pending          → Approval[]
POST /api/approvals/{id}/decision  {decision: approved|denied}
GET  /api/usage/summary?days=30             → per-day, per-agent tokens + cost   (M4)
GET  /api/health · GET /api/version
GET  /api/ws                                → WebSocket
POST /internal/approvals · GET /internal/approvals/{id}/wait     (127.0.0.1 only)
```

WS: server pushes `{kind: task_update|event|approval_update, data}` for all tasks. Reconnecting clients re-sync via `since_seq`. Clients never send anything except pings.

**Auth:** 32-byte random hex token generated at first run (`~/.kin/token`). All `/api/*` require `Authorization: Bearer` or `?token=` (for QR links; the UI moves it to localStorage and strips the URL). Constant-time compare; 20 req/min per IP on auth failures. `/internal/*` binds loopback only and requires the token.

## 7. Remote access (M3)

| Mode | Command | Behavior |
|------|---------|----------|
| Local | `kin serve` | 127.0.0.1:7777 |
| LAN | `kin serve --lan` | 0.0.0.0:7777; prints terminal QR of `http://<lan-ip>:7777/?token=…` |
| Tailnet | `kin serve --tailscale` | tsnet node `kin`; prints login URL on first run; QR of tailnet URL |
| Funnel | `kin serve --tailscale --funnel` | adds public HTTPS via Funnel; QR of public URL |

Flags stack sensibly; `--port` overrides. Token auth applies on **every** rung.

## 8. Notifications (M3)

Settings keys `notify.bark_url`, `notify.ntfy_topic`. On `approval_requested` and task finish, POST fire-and-forget (5s timeout, one retry) with title/body/deep-link URL.

## 9. Web console (UI)

Mobile-first, dark default, no i18n for MVP (English). Pages:

1. **Tasks** `/` — cards: title, agent badge, live status, elapsed, cost; "New task" modal (agent select, cwd text input with recent-dirs suggestions, prompt textarea).
2. **Task detail** `/tasks/:id` — transcript rendered from events (markdown for assistant text, collapsible monospace blocks for tool use, streamed via partial messages), cost/tokens header, Cancel; follow-up prompt box when finished (M2).
3. **Approvals** `/approvals` — pending cards: tool name, pretty-printed input (diffs shown as diffs), task context link, Approve/Deny buttons; badge count in nav. **This page is the product's money shot — polish it.**
4. **Settings** `/settings` — connection QR + token reveal, network mode display, notification URLs, price table editor (M4).

Empty/error/loading states for every page. Approval decisions must be a single tap from a phone.

## 10. Milestones and acceptance criteria

**M0 — Scaffold.** Repo builds (`make build` → single `kin` binary embedding UI); `kin serve` shows empty task list; CI (GitHub Actions) runs build + `go test` + UI typecheck on push.

**M1 — Watch.** From the UI: dispatch a Claude Code task ("summarize this repo") in a chosen cwd; transcript streams live; task ends `succeeded` with nonzero cost; daemon restart preserves history. Golden-file tests for stream-json parsing.

**M2 — Approve.** Task "create hello.txt with contents hi" pauses; approval appears in inbox; Approve → file exists, task succeeds; Deny (fresh task) → no file, transcript shows denial; every decision visible in task detail (audit). Follow-up prompt on a finished task resumes the same session (`--resume`). Timeout path unit-tested.

**M3 — Reach.** `--lan`: phone on same WiFi scans QR and approves M2's scenario end-to-end. `--tailscale --funnel`: phone on cellular does the same via public URL; Bark or ntfy notification arrives on approval request and task completion; tapping it deep-links to the approval.

**M4 — Track + Codex.** Codex adapter passes the M1 scenario; usage summary shows ≥2 agents' spend over the period; price table editable; rawpty adapter runs an arbitrary command with live output.

## 11. Testing & quality bar

- Unit: task state machine, approval timeout, token auth, stream-json + codex parsers (golden files under `internal/adapter/*/testdata/`).
- One happy-path integration test with a **fake agent binary** (shell script emitting canned stream-json) — CI must not require real `claude`.
- `go vet` + `golangci-lint` default set; `tsc --noEmit` + eslint for UI. All green in CI.

## 12. Inputs required from the maintainer (human)

Blocking items marked ⛔; the rest can land later.

1. ⛔ **Go module path** — confirm `github.com/vuuihc/kin` (spec assumes it).
2. ⛔ **Machine with Claude Code installed and authenticated** (`claude -p "say hi"` works) + a throwaway test repo directory agents may write to.
3. ⛔ **License decision** — Apache-2.0 was "intended"; the implementation repo needs the LICENSE file on day one.
4. **Tailscale account** (free tier) for M3; run the printed login URL once; enable Funnel for the tailnet when prompted (Tailscale admin console → DNS/Funnel policy).
5. **Bark device URL and/or ntfy topic** for M3 notification testing.
6. **Codex CLI installed and authenticated** for M4 (`codex exec "say hi"` works).
7. **Price table JSON** for non-Claude cost math (M4), e.g. `{"gpt-5-codex": {"in": 1.25, "out": 10.0}}` USD per 1M tokens — Claude Code needs none (cost comes from `result` events).
8. **Port confirmation** if 7777 collides with anything on your machines.
