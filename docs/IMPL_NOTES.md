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

## M2

### Approval bridge (no MCP SDK)

§2 lists no MCP SDK. `kin approve-mcp` is a hand-rolled JSON-RPC 2.0 server over **newline-delimited JSON** on stdio (not Content-Length framing). Claude Code's stdio transport matches this.

Handled methods: `initialize` (echoes `protocolVersion`, `capabilities.tools`, `serverInfo`), `notifications/initialized` (no-op), `tools/list` (single tool `approve` with open object schema), `tools/call` for `approve`, and `ping`. Protocol logs go to **stderr only**.

### Permission tool return shape

On allow, tool result text is exactly:
`{"behavior":"allow","updatedInput":<input>}` where `updatedInput` is the `input` field of the tool arguments when present (Claude Code permission shape `{tool_name, input, ...}`), else the whole arguments object. Deny/expiry: `{"behavior":"deny","message":"denied via Kin console"}`.

### Adapter launch line (M2)

```bash
claude -p "<prompt>" \
  --output-format stream-json --verbose --include-partial-messages \
  --mcp-config <temp kin-mcp-*.json> \
  --permission-prompt-tool mcp__kin__approve \
  [--resume <session_ref>] [--model <model>]
```

Per-task MCP config is written under the system temp dir and removed when the process exits. Binary path from `os.Executable()` (+ `EvalSymlinks` when possible). **Never** `--dangerously-skip-permissions`.

If `DaemonURL`/`Token` are empty on the adapter (unit tests without the bridge), MCP flags are omitted so fake agents keep working.

### Internal routes + loopback

`POST /internal/approvals` and `GET /internal/approvals/{id}/wait` require Bearer token **and** a loopback `RemoteAddr` middleware (in addition to the daemon binding 127.0.0.1). Long-poll default/max is 30s; still-pending returns the pending row so the MCP client re-polls.

### Expiry

Pending approvals older than **1 hour** become `decision=expired`, `decided_via=timeout` (deny behavior for MCP). Enforced in `WaitApproval` and a 1-minute periodic `ExpireStale` sweep. Engine clock + TTL are injectable for unit tests.

### Follow-up prompts

`POST /api/tasks/{id}/prompt` reuses the **same** task row: requires terminal status + non-empty `session_ref` (else 409). Clears `finished_at`/`exit_code`, sets `queued`, appends a user `message` event, re-launches with `--resume`. Tokens and `cost_usd` accumulate additively across runs; event `seq` continues.

### WS

`approval_update` messages are broadcast alongside `task_update` / `event`. UI nav badge and Approvals page subscribe for live pending count.

### OpenAPI still deferred

Approval and follow-up handlers are hand-written like the rest of M0–M2.

## M3

### Go version

`tailscale.com` (tsnet; currently v1.100.0 in `go.mod`) requires **Go ≥ 1.23.1**. `go.mod` and CI use 1.23.x (spec allows ≥ 1.22).

### Token reload (not file watch)

`remote.NewFileAuth` **re-reads `~/.kin/token` on every request** (no fsnotify watcher). `kin token rotate` rewrites the file; a running daemon accepts the new token and rejects the old one immediately. Documented in `docs/REMOTE_ACCESS.md`.

MCP approve-mcp children started before rotate still carry the old `KIN_TOKEN` in their env until the task restarts; new tasks resolve the token via `TokenFunc` at adapter `Start`.

### Transport / serve flags

- Default: `loopback` (`127.0.0.1`).
- `--lan`: `0.0.0.0` (covers loopback for MCP).
- `--tailscale`: additional tsnet listener (node hostname `kin`, state `~/.kin/tsnet/`).
- `--funnel`: requires `--tailscale`; uses `ListenFunnel` on `:443`. Incompatible with `--ts-control-url` (error before listen).
- Same `http.Handler` is `Serve`d on all active listeners; Ctrl-C → graceful `Shutdown`.

### Import boundary

`tailscale.com/*` only under `internal/remote/tsnet/`. Enforced by `TestTailscaleImportBoundary` in `internal/remote` (runs in CI via `go test ./...`).

### Notifications

`internal/notify`: settings `notify.bark_url`, `notify.ntfy_topic`, `ui.base_url`. On `approval_requested` and task terminal status, fire-and-forget POST (5s client timeout, one retry after 200ms). ntfy: `Title` + `Click` headers; Bark: JSON `{title,body,url}` to `{bark_url}/push`.

`ui.base_url` is set at serve start to the most-public active listener URL (https/funnel > tsnet > lan > loopback) and is overridable via `PUT /api/settings`.

### Settings API

`GET/PUT /api/settings` (auth required). PUT accepts only `notify.bark_url`, `notify.ntfy_topic`, `ui.base_url`. GET also returns `network_mode`, `connect_url` (QR target with token), and `token`.

### UI

Settings page: connection QR (`qrcode.react`), network mode, token reveal/copy, Bark/ntfy/base URL fields.

### Dependencies added (M3)

- `tailscale.com` (tsnet) — only imported from `internal/remote/tsnet`
- `github.com/skip2/go-qrcode` — terminal QR
- UI: `qrcode.react`

### Live verification limits

Automated/agent verification covers loopback, LAN bind + QR print, funnel+control-url error path, token rotate, and notify against a local httptest. Real Tailscale login, Funnel enablement, and phone QR scan require the maintainer’s account/device.

## M4

### Codex CLI event shapes (`codex exec --json`)

Parser coded against documented JSONL thread events (OpenAI non-interactive docs + community cheatsheets). Real `codex` on this machine was **broken** (npm wrapper ENOENT for native binary) during implementation — adapter verified with golden fixtures + fake binary only.

| Event `type` | Kin mapping |
|---|---|
| `thread.started` + `thread_id` | `task_started` (`session_id` = `thread_id` → `tasks.session_ref`) |
| `turn.started` | ignored |
| `turn.completed` + `usage.{input,output,cached,reasoning}_tokens` | `usage` + `result` with `tokens_in`/`tokens_out` (`is_error: false`) |
| `turn.failed` + `error.message` | `result` with `is_error: true` |
| `error` + `message` | `error` event; messages starting with `Reconnecting` → `raw_output` (non-fatal) |
| `item.completed` / `agent_message` or `reasoning` | `message` (role `assistant` / `reasoning`) |
| `item.*` / `command_execution`, `mcp_tool_call`, `file_change`, `web_search`, `todo_list` | `tool_use` (`phase`, `name`, `item`) |
| non-JSON / missing `type` | `raw_output` |
| unknown JSON `type` | dropped (never crash) |

Example lines:

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"..."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```

### Codex launch line

```bash
codex exec --json "<prompt>" [--model <model>]
# follow-up:
codex exec resume <session_ref> --json "<prompt>"
```

Binary override: env `KIN_CODEX_BIN` (same pattern as `KIN_CLAUDE_BIN`). Follow-up without `session_ref` is rejected by the engine (`409` / no session_ref) before the adapter runs.

### Cost accounting

- **claude-code:** unchanged — `total_cost_usd` / `cost_usd` from CLI `result` events.
- **codex:** CLI has no cost field. At `result` time the engine multiplies tokens × `settings.price_table` for the task model (default model name `gpt-5-codex` when unset). Missing model → `cost_usd` left null + `raw_output` note.
- **rawpty:** no tokens/cost.

Default `price_table` (USD per 1M tokens), returned by GET settings when unset:

```json
{"gpt-5-codex":{"in":1.25,"out":10.0},"gpt-5.1-codex":{"in":1.25,"out":10.0},"gpt-5.1-codex-max":{"in":1.25,"out":10.0},"o3":{"in":2.0,"out":8.0},"o4-mini":{"in":1.1,"out":4.4}}
```

PUT validates JSON shape (`model → {in, out}` with non-negative numbers). Editable as raw JSON on Settings.

### Raw PTY adapter

- Prompt = shell command: `/bin/sh -c "<prompt>"` under `creack/pty`.
- Output: coalesced `raw_output` events with `{"chunk":"..."}` every ≥100ms.
- Exit code → `result` (`is_error` if non-zero).
- Cancel: SIGTERM to process group (`-pid`; session leader from pty `Setsid`), SIGKILL after 5s.
- **macOS note:** do not set `SysProcAttr.Setpgid` before `pty.Start` — it conflicts with creack/pty’s `Setsid` and fails with `operation not permitted`. Session leader pgid == pid, so `Kill(-pid, …)` still works.

### Usage summary

`GET /api/usage/summary?days=30` → SQL aggregates over `tasks` grouped by UTC date + agent: `{date, agent, tasks, tokens_in, tokens_out, cost_usd}`. UI: Usage page (nav) with per-agent totals and per-day table.

### Dependencies added (M4)

- `github.com/creack/pty` (whitelisted; rawpty only)

### Human-verify items

1. **Real codex run** — when the machine’s Codex CLI is fixed/authenticated: dispatch agent=`codex` with a real prompt; confirm transcript, `session_ref`, tokens, and price-table cost. Follow-up prompt should call `codex exec resume <thread_id> --json`.
2. Confirm current Codex model names/prices in the default price table match the operator’s plan (edit in Settings if needed).

## M5 (UI/UX polish)

Dogfooding on a phone over high-latency Funnel drove this milestone. No new product features; no adapter/engine/auth-semantics changes. API shape unchanged except additive response headers (`Cache-Control`, `Content-Encoding` via chi Compress).

### Auth recovery (401 funnel)

Any `apiFetch` 401 calls `requireToken("unauthorized")` on the global zustand store. `App` swaps the whole tree for `ConnectScreen` (paste token → `localStorage` → reload). Missing token at boot uses the same screen (`reason: "missing"`). Pages no longer render raw “no auth token” / “Unauthorized” dead-ends for 401.

### Instant shell + skeletons + slow hint

Nav/header always paint first. List/detail pages show skeleton placeholders while loading. `useSlowHint` (10s) surfaces “Still connecting — your link may be slow.”

### Optimistic updates

- **Approvals:** Approve/Deny keep the card with `Approving…` / `Denying…`; success drops the card; failure restores via re-fetch + error toast.
- **New task:** Modal closes immediately; a temp `opt_*` row appears as `queued`; server create reconciles (or rolls back + toast on failure).

### Connection status + self-heal

Single app-wide WebSocket (pages subscribe via `subscribeWS` fan-out). Nav shows a status dot; slim “reconnecting…” banner when not connected. Exponential reconnect backoff (1s…15s). On re-open, `reconnectGen` bumps and list/detail pages re-fetch (task detail uses `since_seq` for events).

### Asset caching + compression

- `middleware.Compress(5)` on the chi root (gzip for JSON + HTML/text when `Accept-Encoding: gzip`).
- Static handler: `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`; `index.html` / SPA shell / manifest → `no-cache`.
- PWA `manifest.webmanifest` + hand-made monochrome “K” icons (`ui/public/icons/`, dark `#0f1115` / accent `#6ee7b7`).
- **No service worker** (optional in the polish brief). Update strategy if added later: cache-first hashed `/assets/*` only; never API; bump SW version on each UI release so `index.html` revalidation picks new hashes.

### Mobile ergonomics

`viewport-fit=cover`, safe-area CSS, ≥44px tap targets on Approvals/task actions/nav, `overflow-x: hidden`, long cwd/prompts truncate with `title` / expand (`Truncated`).

### Dependencies

None new. `zustand` (already whitelisted) used for auth/WS/toasts. Chi Compress is part of `go-chi/chi/v5`.

## Notify (Bark path fix)

### Root cause

`internal/notify.barkRequest` POSTed JSON `{title, body, url}` to `<bark_url>/push` (e.g. `https://api.day.app/DEVICEKEY/push`). Bark's HTTP API accepts:

1. **Device URL (form a):** POST JSON directly to the configured device URL `https://api.day.app/DEVICEKEY` (no extra path).
2. **Server root `/push` (form b):** POST to `https://api.day.app/push` with `device_key` in the JSON body.

Appending `/push` to a device-key URL is neither form — day.app returns a non-2xx and the push never arrives. Failures were also silent: fire-and-forget discarded `postWithRetry` errors with no log line.

### Fix

- POST JSON to `notify.bark_url` **as-is** (trim trailing slash only). Do not append `/push`.
- Single synchronous `Sender.Deliver` returns `[]ChannelResult` per channel (`channel`, `ok`, `status`/`error`); logs one line per attempt (`notify: bark ok` / `notify: bark failed: …`). `Send` still fire-and-forgets by calling `Deliver` in a goroutine.
- Operator tooling: `kin notify test` (reads `~/.kin/kin.db` without the daemon), `POST /api/notify/test` (auth), and a Settings "Send test notification" button with toast results.

## Desktop shell (Electron)

**Scope:** `desktop/` only — menu-bar app that supervises the Go daemon as a sidecar and loads the existing web console. No Go/UI changes; uses existing `GET /api/health`, `GET /api/version`, `GET /api/approvals?status=pending`, `POST /api/approvals/{id}/decision`, and `GET /api/ws?token=`.

### Architecture

```text
Electron main process
  ├── Sidecar      spawn/attach `kin serve`; stop on quit only if we started it
  ├── Tray         template icon + pending count title; menu
  ├── MainWindow   BrowserWindow → http://127.0.0.1:7777/?token=…
  ├── DaemonWS     main-process WS (?token=); drives tray + notifications
  └── Notifier     native Notification on approval / terminal task status
```

- **Dev binary:** repo-root `./kin` (resolved from `desktop/` cwd).
- **Packaged binary:** `extraResources` → `Contents/Resources/kin`.
- **Token:** read from `~/.kin/token` (same file the daemon writes on first serve).
- **Version match:** on launch, probe health + version; if a daemon is already up, attach (even on mismatch — do not kill foreign processes; log a warning). If down, spawn our binary.
- **Window:** 1100×760 default; bounds persisted under Electron `userData`; close hides to tray; dock hidden while no visible window (menu-bar behavior). `backgroundColor: #0e0e10` matches SPA page so first paint is never a white flash. Token is resolved live from `~/.kin/token` on every navigate (tray can open before `ensureRunning` finishes). `did-fail-load` retries with backoff; after the sidecar is healthy, open windows get `reloadWhenReady()` so a boot race does not leave a blank error page until the user closes/reopens.
- **Security:** `contextIsolation: true`, `nodeIntegration: false`, no preload (SPA talks to the daemon itself). `will-navigate` / `setWindowOpenHandler` allow only `127.0.0.1|localhost:7777`.
- **WS auth:** reuses query `?token=` — `internal/remote/auth.go` `extractToken` accepts Bearer or `?token=` for all auth-gated routes including `/api/ws`.
- **WS client:** Electron's Node (20.x) has no global `WebSocket`, and the shell forbids extra runtime deps. Main process uses a minimal RFC6455 client over `net` (text frames + ping/pong).
- **Dev launcher:** `scripts/run-electron.mjs` clears `ELECTRON_RUN_AS_NODE` / `ELECTRON_FORCE_IS_PACKAGED` so IDE agent shells do not break `require("electron")`.

### Notification actions (decision)

Electron `Notification` supports `actions` on macOS (`Approve` / `Deny`). We attach them and, when the `action` event fires, call `POST /api/approvals/{id}/decision` from the main process with the Bearer token.

**Caveat:** action buttons are not reliable across macOS focus/banner styles (sometimes only the click-to-open path works). **Primary UX:** clicking the notification opens the window at `/approvals?focus=<id>`. Terminal task notifications are silent (`silent: true`) with no actions.

### Build / dist

| Target | What |
|--------|------|
| `make desktop-dev` | `go-build` + icons + `electron .` |
| `make desktop-dist` | full `make build`, copy `kin` → `desktop/resources/kin`, electron-builder **dmg** darwin-arm64 → `desktop/dist-electron/` |

- Runtime deps in `desktop/`: **none** (only Electron/electron-builder/esbuild/typescript as devDependencies).
- No code signing (`identity: null`). First open: right-click → Open, or `xattr -cr /Applications/Kin.app`.
- Desktop packaging is **not** on CI (explicit product choice).

### Headless limits

Cannot verify tray clicks or Notification UI without a human. Programmatic checks: typecheck, `make desktop-dist` produces a `.dmg`, and a short `desktop-dev` run logs tray setup + daemon detect/spawn lines.

### Manual verification checklist

1. Tray icon appears; pending count updates when an approval is created.
2. Approval → native notification; click opens the approvals view.
3. Approve/Deny action buttons (if shown) decide without opening the window.
4. Task terminal status → quieter notification.
5. Close window → app stays in tray; dock icon hides; Open Kin restores window + dock.
6. Start/Stop daemon from menu (Stop only when this app spawned the daemon).
7. Launch at Login toggle.
8. Install `.dmg`; unsigned open caveat as above.


## Multi-agent orchestration (mixed mode)

- **Trigger:** only explicit `@worker` tokens in the *current user message* (`UserTurnPrompt`). Prior transcript / handoff wrappers must not re-fan-out.
- **Mixed modes:** round N can `@claude` + `@codex`; round N+1 with no `@` stays on the selected session host alone.
- **Main chat UI:** orchestrator/delegate lines + host messages are user-facing; worker CLI text/tools are task-only (hidden from the main column).
- **Approvals:** `/internal/*` loopback check uses the TCP peer captured *before* `RealIP`, so `X-Forwarded-For` cannot break the MCP approve bridge. Permission allow path also accepts `tool_input` / `arguments` keys.



## Session permission mode (all agents)

Session-scoped default applied to every agent run in a task (main + multi-@ workers).

| Mode | Meaning | Claude Code | Codex | Grok |
|------|---------|-------------|-------|------|
| `default` | Ask before risky tools | MCP approve bridge | CLI defaults | CLI defaults |
| `accept_edits` | Auto-accept file edits | `--permission-mode acceptEdits` (+ MCP for other tools) | `--sandbox workspace-write` | `--always-approve` |
| `yolo` | Skip permission prompts | `--dangerously-skip-permissions` (no MCP) | `--dangerously-bypass-approvals-and-sandbox` | `--always-approve` |

- Stored on `tasks.permission_mode` (default `default`). Set once at create; UI locks it for the session.
- Composer footer picker (New chat + task detail). Draft choice remembered in `localStorage` (`kin_permission_mode`).
- Engine passes `TaskSpec.PermissionMode` to single-agent runs and to every orchestrated worker (same mode for all agents).
- Aliases normalized: `acceptEdits`/`accept-edits` → `accept_edits`; `bypass`/`bypassPermissions` → `yolo`.

## Session title summarization

Task titles used to be `prompt[:80]` (byte-sliced). Create now:

1. Immediate fallback: first line of the prompt, rune-truncated to ~48 chars (`TruncateTitle`).
2. If the user did not pass `title` and a cognition provider is configured, the engine asynchronously asks the provider for a 3–8 word session name and patches `tasks.title`, broadcasting a `task_update` so the sidebar refreshes.

Failures / missing provider leave the fallback in place. Explicit `title` in `POST /api/tasks` is never overwritten.


## Context management (ADR 0002 v1)

Design: [docs/adr/0002-context-management.md](./adr/0002-context-management.md) — **compress-at-entry + KV-cache-first**.

### Shipped (P0 + P1a + P1b)

- Cross-turn: **newest-first Context Pack** (`sessionctx.BuildPack` via `handoffContext` → `formatHandoffPrompt`) so recent turns are not dropped.
- **Sealed pack** (`sessionctx.BuildSealedPack` / `PackSections.Render`): the pack now emits the full fixed-order template — `[Session index]`, `[Pinned]`, `[Sealed summary]`, `[Recent turns]` — with byte-stable headers (Policy K). On overflow, older turns are **compressed into an extractive sealed summary + keyword index** instead of being silently dropped (Layer 1 / Layer 4 retrieval hint). Seal is derived deterministically (identical inputs → identical output); the `[Pinned]` slot is caller-supplied and currently passed empty (auto-derivation deferred to P1.5). `FormatPackSections` is retained as the recent-only shortcut and now delegates to `PackSections.Render`.
- Full fidelity in SQLite `events`; model path ≠ UI path.
- **Policy C — compact-on-entry:**
  - `sessionctx.ToolDigest` (per-tool rules: bash tail, read_file excerpt, list/glob first-N, …) applied in `kinagent` **before** `RoleTool` append.
  - `sessionctx.WorkerDigest` (≤~1.8k runes, extractive) in `buildMainSummary` so main chat does not paste multi-k worker dumps.
  - Raw tool stdout still hard-capped at 80k for archive/UI safety; digests are few-k.
- **Policy K — KV hygiene (intra-turn):**
  - Removed **proactive** mid-loop `pruneLoopMessages` rewrite.
  - Overflow safety net only: `overflowCompactMessages` (prefer newest giant tool first) + single retry.
  - Tool defs / system prompt unchanged across calls in a turn.

### Shipped next (P1b metrics + P1.5 + P2 search)

- **P1b metrics:** `provider.Usage.CachedTokens` parsed from OpenAI `prompt_tokens_details.cached_tokens` (and flat/proxy aliases). Kin loop logs `prompt_chars` / `prompt_tokens` / `cached_tokens` per turn and emits `usage` events.
- **P1.5 durable Kin transcript:** `kin_messages` table stores model-path messages (no system). Same-agent Kin follow-up appends only the live user turn; `kinagent` reloads prior messages (Policy K). Handoff / interrupt / orchestrate / agent switch clear the table and fall back to sealed Context Pack.
- **P2 `session_search`:** tool over SQLite `events` (task-scoped LIKE + snippet). Optional JSONL mirror still deferred.

### Still open

| Item | Notes |
|------|--------|
| **P1.5 auto-`[Pinned]`** | Goals/decisions still caller-empty; could derive from durable transcript later |
| **P2 JSONL mirror** | Optional `rg`-friendly mirror; SQLite remains SoT |
| **P3** | Optional LLM micro-summarize at seal boundaries only (current seal is extractive/deterministic) |

## Per-agent daily usage limits (2026-07-19)

### Capability

Optional daily spend-USD and/or token caps per agent. Both metrics are independently optional: omitting a field means unlimited for that metric. Stored as a single JSON value under the existing `settings` key `agent_limits` — no schema migration required.

Settings key: `agent_limits`  
Shape: `{"<agent-id>": {"spend_usd_daily": 10.0, "tokens_daily": 500000}}`

### Read model

`GET /api/usage/limits` returns `[]AgentLimitStatus`. Each row contains:

- `agent` — agent id
- `limit_spend_usd` / `limit_tokens` — configured caps (omitted when unlimited)
- `used_spend_usd` / `used_tokens` — today's totals from `usage_records`
- `status` — `ok` (< 80% of all configured limits), `warn` (≥ 80%), `over` (≥ 100%)
- `period_start` — RFC3339 start of the natural day in server-local timezone

Status `over` means the more severe of the two metrics: if spend is `ok` but tokens is `over`, the row status is `over`.

An agent with usage today but no configured limit is included (with nil limit fields, status `ok`). An agent with a configured limit but no usage today is included with `used = 0, status = ok`. A database with no `agent_limits` key returns `[]` from this endpoint.

### UI

- Usage page (`/usage`): compact progress bar + `used / limit` label under each agent row in the by-agent section. Warning colors (`--kin-yellow` at warn, `--kin-red` at over). Rows without a configured limit keep their current appearance.
- Settings page (`/settings`): JSON textarea for `agent_limits`, mirroring the existing `price_table` field. Parse-on-save validation rejects malformed JSON or negative values with a visible error.

### Thresholds

`ok` < 80% · `warn` ≥ 80% · `over` ≥ 100%

### Deferred: soft enforcement

Limits are **advisory and display-only** in this version. No task is blocked.

Future soft-enforcement sketch: at task creation or new-round start in `task.Engine`, call `AgentLimitStatuses(ctx)`, check whether the target agent's row `status == "over"`, and either warn (return a non-fatal annotation on the task) or block (return an error to `Create`/`Orchestrate`). The store layer is already correct for this path; only the engine callsite is missing.

## Pluggable agent runtime (2026-07-17)

- `internal/agent` registry owns plugin metadata, readiness, controllers, session hooks.
- `task.Engine` takes `*agent.Registry`; hosts are interchangeable; `@agent` selects workers only.
- Composition root: `internal/server/agents.go` (`buildAgentRegistry`).
- Canonical adapter events: `internal/adapter/events.go` (`ParseStarted` / `ParseResult`).
- ADR: `docs/adr/0007-pluggable-agent-runtime.md`.
