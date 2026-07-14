# Implementation notes

Deviations from [MVP_TECH_SPEC.md](./MVP_TECH_SPEC.md), gotchas, and discovered CLI behavior.

## M0

### Auth exemptions for health/version

Spec §6: *All `/api/*` require Authorization: Bearer or `?token=`.*

M0 deliverable explicitly requires `GET /api/health` without auth. `/api/version` is also left unauthenticated so operators and load balancers can probe without the secret. All other `/api/*` routes (starting with `/api/tasks`) enforce token auth.

### UI embed path: `web/dist` not bare `web/`

Spec layout shows `web/` as the Vite build output. Vite's `emptyOutDir: true` would delete a co-located `web/embed.go`. Build output therefore goes to `web/dist/`, and `web/embed.go` embeds `all:dist`. The public URL path is still `/` (contents of `dist` are served at the HTTP root).

### Dependencies not yet pulled

§2 lists packages used in later milestones. M0 only requires:

- `github.com/go-chi/chi/v5`
- `modernc.org/sqlite`

Not yet in `go.mod` (will add when first used): `creack/pty`, `nhooyr.io/websocket`, `oklog/ulid`, `tailscale.com/tsnet`, `skip2/go-qrcode`, `oapi-codegen`. UI has `zustand` and `react-router-dom` (router needed for nav skeleton; not listed in §2 table but implied by multi-page §9).

### `react-router-dom`

§2 UI row names Vite/React/TS/Tailwind/zustand only. Client-side routes for Tasks / Approvals / Settings need a router; `react-router-dom` v6 is used. No other state/query libraries.

### OpenAPI / codegen deferred

`api/openapi.yaml` and oapi-codegen are §2 choices for the full API surface. M0 hand-writes the three endpoints; OpenAPI lands when the surface stabilizes (M1+).

### CGO

Confirmed pure Go: `modernc.org/sqlite` only. No `CGO_ENABLED` requirement; builds with `CGO_ENABLED=0`.

## M1

### Claude Code CLI flags (approval bridge deferred)

Spec §4.1 lists `--mcp-config` and `--permission-prompt-tool mcp__kin__approve`. M1 omits both (approval bridge is M2). Launch line:

```bash
claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
```

Optional: `--model`, and `--resume <session_ref>` when set (M2 follow-up path pre-wired in the adapter but not exposed via API yet). **Never** uses `--dangerously-skip-permissions`.

### Stream-json shapes observed (Claude Code 2.x)

- `system` / `subtype: init` carries `session_id` (also present on almost every later line).
- Partial text arrives as `stream_event` → `event.type = content_block_delta` → `delta.type = text_delta`.
- Complete turns arrive as `assistant` / `user` with nested `message.content[]` blocks (`text`, `tool_use`, `tool_result`, `thinking`).
- Terminal line is `result` with `total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, `is_error`, `session_id`.
- Noise lines (`rate_limit_event`, hook system events, `message_start`/`message_stop` stream events) are ignored, not stored.

Parser maps: `init` → `task_started`; `assistant`/`user` text → `message`; `tool_use` blocks → `tool_use`; text deltas → `message` with `partial: true`; `result` → `result` (normalized `cost_usd` / `tokens_*`); non-JSON → `raw_output`.

### Dependencies added (M1)

- `github.com/oklog/ulid/v2` — task IDs
- `nhooyr.io/websocket` — `/api/ws`

### SQLite single connection

`store.Open` sets `db.SetMaxOpenConns(1)`. Concurrent task runners (up to 4) share one connection so writers never hit `SQLITE_BUSY` under WAL.

### Extra API: `GET /api/recent-cwds`

Not in the §6 route table; added so the New Task modal can suggest recent directories from prior tasks. Auth-protected like other `/api/*` routes.

### Fake agent / binary override

Integration tests inject a shell script via `claudecode.Adapter.Binary`. Runtime override: env `KIN_CLAUDE_BIN` (path to a fake or alternate binary) — for CI and local debugging only.

### Port override

`KIN_PORT` overrides the default `7777` bind (useful for parallel local runs / tests). Still loopback-only in M1.

### OpenAPI still deferred

Handlers remain hand-written. Surface is now larger (tasks CRUD-ish, events, cancel, WS); OpenAPI can land once M2 freezes the approval routes.

### UI markdown

No markdown dependency added (not in §2). Task detail uses a small in-house renderer (paragraphs, headings, fenced code, inline code, bold).
