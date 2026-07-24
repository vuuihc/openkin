# Ask User Question Tool — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Related:** [ADR 0010](../adr/0010-ask-user-question-tool.md) · spec §4.2 (approval bridge) · `internal/task/approvals.go` (the primitive this mirrors)

**Goal:** Give agents a real `ask_user_question` tool — a structured, multi-choice clarifying question that pauses the task and blocks until the user answers — instead of guessing or silently waiting for an unprompted follow-up. Ships first for the `claude-code` adapter via the existing MCP approval bridge.

**Non-goals (deferred):** Codex / kinagent / generic-CLI (Tier 2) / rawpty adapters. Auto-answering in `yolo` mode. A merged "Inbox" page — v1 folds questions into the existing `TaskDetailPage` pending-approvals queue.

**Architecture:** Add a `UserQuestion` primitive that is a structural sibling of the existing `Approval` primitive (`internal/store/approvals.go` / `internal/task/approvals.go`), not a variant of it — own table, own status enum, own bus event, own REST routes, own long-poll wait. Wire it into `internal/approvemcp/server.go` as a second MCP tool (`ask_user_question`) alongside the existing `approve` tool, on the same per-task MCP config already written by `internal/adapter/claudecode/adapter.go` — no adapter/CLI-flag changes needed. The task status enum gains `waiting_input`. Interrupt handling (`Engine.FollowUpWith`) is extended to resolve pending questions the same way it already resolves pending approvals before killing a subprocess.

**Design decisions (locked):**
- **Shape:** one question, a header label (short, e.g. "Auth method"), 2–6 options (`label` + optional `description`), an optional `multi_select` flag, and an implicit free-text "Other" escape hatch on every question (mirrors the reference `AskUserQuestion` tool contract, minus multi-question batching — YAGNI for v1).
- **Answer payload:** `{"selected": string[], "other_text": string}`. `selected` holds the chosen option `label`(s) verbatim (not indices) so the tool_result text stays self-describing without a lookup.
- **Permission-mode independence:** a question is asked in every `PermissionMode` (`default`, `accept_edits`, `yolo`). It is not a consent gate.
- **Protocol nuance:** the `approve` MCP tool's reply must follow Claude Code's permission-prompt-tool contract (`{"behavior":"allow"|"deny", ...}`) because it is wired via `--permission-prompt-tool`. `ask_user_question` is a normal MCP tool the model calls voluntarily — its `tools/call` result is free-form `content` text (compact JSON), not the allow/deny envelope.
- **Fail-open, not fail-closed:** if the daemon is unreachable, the question expires, or the task is interrupted, `approve-mcp` returns a neutral "no response — proceed with your best judgement" tool_result rather than blocking forever or denying. (Contrast with `approve`, which fails *closed* on error, since an unanswered permission check must not silently allow a risky action.)
- **Status reuse:** `waiting_input` is a new task status, not an overload of `waiting_approval` — the console must be able to tell "needs your permission" apart from "needs your answer."

**Tech Stack:** Go, SQLite (`modernc.org/sqlite`, `PRAGMA user_version` migrations), JSON-RPC 2.0 over stdio (MCP bridge), React 18, strict TypeScript, Vitest, Tailwind, Kin REST + WebSocket APIs.

---

### Task 1: Store layer — `user_questions` table and CRUD

**Files:**
- Modify: `internal/store/migrate.go`
- Create: `internal/store/user_questions.go`
- Create: `internal/store/user_questions_test.go`

**Step 1: Write failing store tests**

In `user_questions_test.go`, cover:
- `InsertUserQuestion` / `GetUserQuestion` round-trip, default `status = "pending"`.
- `ListUserQuestions(opts)` filters by status and joins `task_title`/`task_agent`, ordered `created_at DESC`, same shape as `ListApprovals`.
- `AnswerUserQuestion(id, response, via, answeredAt)` — only updates a still-pending row (optimistic, mirrors `DecideApproval`); returns `ErrAlreadyDecided`-equivalent (reuse or add `ErrAlreadyAnswered`) when called twice; returns `ErrNotFound` for a missing id.
- `ListPendingUserQuestionsForTask(taskID)` and `ListPendingUserQuestionsOlderThan(cutoffMs)` (mirrors `ListPendingForTask` / `ListPendingOlderThan`).
- Execution attribution columns (`execution_id/agent/step/model`) round-trip nullable, same pattern as `approvals_execution_test.go`.

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/store -run UserQuestion`

Expected: failure — table and types do not exist yet.

**Step 3: Add migration 010**

In `migrate.go`, bump `schemaVersion` to `10` and add a migration block (mirrors the `v == 8` → 9 block) that creates:

```sql
CREATE TABLE user_questions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  payload         TEXT NOT NULL,   -- {question, header, options:[{label,description}], multi_select}
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | answered | expired
  response        TEXT,            -- {selected:[]string, other_text} — null until resolved
  answered_via    TEXT,            -- web | timeout | interrupt
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  execution_id     TEXT,
  execution_agent  TEXT,
  execution_step   INTEGER,
  execution_model  TEXT
);
```

Guard the same way migration 009 guards `approvals`: fresh DBs get the table
from a new `migration001`-adjacent block is unnecessary here since this is a
net-new table (no legacy-column-add case) — a single `CREATE TABLE IF NOT
EXISTS` inside the `v == 9` step is sufficient.

**Step 4: Add the store type and accessors**

In `user_questions.go`, mirroring `approvals.go`'s structure exactly:
- `const UQStatusPending = "pending"`, `UQStatusAnswered = "answered"`, `UQStatusExpired = "expired"`.
- `const DefaultUserQuestionTTL = time.Hour` (same default as `DefaultApprovalTTL`; configurable later if needed).
- `type UserQuestion struct` with `ID, TaskID, Payload, Status, Response, AnsweredVia *string, CreatedAt, AnsweredAt *int64`, plus the four nullable `Execution*` fields and joined `TaskTitle`/`TaskAgent` — same nullable-scan pattern as `scanApproval`.
- `InsertUserQuestion`, `GetUserQuestion`, `ListUserQuestions(opts ListUserQuestionsOpts)`, `AnswerUserQuestion`, `ListPendingUserQuestionsForTask`, `ListPendingUserQuestionsOlderThan`, `CountUserQuestions` — one-to-one with the `Approval` equivalents.
- `var ErrAlreadyAnswered = errors.New("user question already answered")`.

**Step 5: Verify and commit**

Run: `go test ./internal/store`

Commit: `feat(store): add user_questions table and CRUD`

---

### Task 2: Engine layer — request/answer/wait/expire + interrupt integration

**Files:**
- Modify: `internal/task/engine.go` (status constant)
- Modify: `internal/task/bus.go`
- Modify: `internal/task/approvals.go` (interrupt path)
- Create: `internal/task/user_questions.go`
- Create: `internal/task/user_questions_test.go`

**Step 1: Write failing engine tests**

Mirror `approvals_test.go`'s cases for the new primitive:
- `RequestUserQuestion` on a running task inserts a pending row, flips task status to `StatusWaitingInput`, appends a `user_question_requested` event, and publishes both a `task_update` and a `user_question_update` on the bus.
- `AnswerUserQuestion` records the response, appends `user_question_answered`, and resumes the task to `StatusRunning` only when there are no other pending approvals *and* no other pending user questions for that task (two-way coupling with `RequestApproval`'s resume check).
- `WaitUserQuestion` long-polls and returns promptly once answered (same bounded-timeout pattern as `WaitApproval`, capped at 30s).
- `ExpireStaleUserQuestions` flips questions older than the TTL to `expired` with `answered_via = "timeout"`, and `StartExpiryLoop` sweeps both approvals and user questions on the same ticker.
- **Interrupt integration:** starting a `FollowUp`/steer while a question is pending auto-resolves it with `answered_via = "interrupt"` (empty `selected`) *before* the process is canceled, so `WaitUserQuestion` (and therefore the blocked `approve-mcp` process) does not hang. Assert this the same way `approvals_test.go` asserts pending approvals are auto-denied on interrupt.

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/task -run UserQuestion`

Expected: failure — methods and status constant do not exist yet.

**Step 3: Add `StatusWaitingInput`**

In `engine.go`, add `StatusWaitingInput = "waiting_input"` next to `StatusWaitingApproval`. Confirm `isTerminalStatus` and any status-based routing/log elsewhere in `internal/task` correctly treat it as non-terminal (grep for every `StatusWaitingApproval` switch case and add the `waiting_input` arm where the two states must behave alike — e.g. `FollowUpWith`'s `case StatusRunning, StatusWaitingApproval, StatusQueued:` must also accept `StatusWaitingInput`).

**Step 4: Add `internal/task/user_questions.go`**

One-to-one with `approvals.go`:
- `type CreateUserQuestionRequest struct { TaskID, Question, Header string; Options []AskQuestionOption; MultiSelect bool; ExecutionID, ExecutionAgent string; ExecutionStep int; ExecutionModel string }` and `type AskQuestionOption struct { Label, Description string }`.
- `type AnswerUserQuestionRequest struct { Selected []string; OtherText string }`.
- `RequestUserQuestion(ctx, req) (store.UserQuestion, error)`: validate `TaskID`/`Question`/`len(Options) >= 2`, reuse `normalizeExecutionAttribution`, check task status is `Running` or `WaitingApproval` or `WaitingInput` (same conflict semantics as `RequestApproval`), insert the row, set task status to `StatusWaitingInput`, append `user_question_requested` (payload: `{question_id, question, header, options, multi_select, execution_*}` — same shape as the `approval_requested` event), publish task + user_question.
- `AnswerUserQuestion(ctx, id, resp, via)`: mirrors `Decide` — persist the response, append `user_question_answered`, notify long-poll waiters, resume task to `Running` only if both `ListPendingForTask` (approvals) and `ListPendingUserQuestionsForTask` are empty, publish.
- `WaitUserQuestion`, `maybeExpireUserQuestion`, `ExpireStaleUserQuestions`, `registerUserQuestionWaiter`/`unregisterUserQuestionWaiter`/`notifyUserQuestionWaiters` — copy the approval waiter-channel machinery verbatim, parameterized on the new type.
- Extend `StartExpiryLoop`'s ticker body to call both `ExpireStale` (approvals) and `ExpireStaleUserQuestions` each tick, rather than adding a second goroutine/ticker.

**Step 5: Wire interrupt resolution**

In `approvals.go`'s `interruptAndFollowUp`, alongside the existing:

```go
if pending, err := e.store.ListPendingForTask(ctx, id); err == nil {
    for _, a := range pending {
        _, _ = e.Decide(ctx, a.ID, store.DecisionDenied, "web")
    }
}
```

add the equivalent for questions, answering with an empty `Selected` so `approve-mcp` gets a neutral "no answer" result instead of hanging:

```go
if pending, err := e.store.ListPendingUserQuestionsForTask(ctx, id); err == nil {
    for _, q := range pending {
        _, _ = e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{}, "interrupt")
    }
}
```

**Step 6: Add `Bus.PublishUserQuestion`**

In `bus.go`:

```go
func (b *Bus) PublishUserQuestion(q store.UserQuestion) {
    b.Publish(WSMessage{Kind: "user_question_update", Data: q})
}
```

Update the `WSMessage.Kind` doc comment to list the new value.

**Step 7: Verify and commit**

Run: `go test ./internal/task`

Commit: `feat(task): add user question request/answer/wait engine flow`

---

### Task 3: REST API — list, answer, internal create/wait

**Files:**
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`

**Step 1: Write failing API tests**

Mirror the approval handler tests:
- `GET /api/user-questions?status=pending` returns `[]store.UserQuestion` (never `null`).
- `POST /api/user-questions/{id}/answer` with `{"selected":["JWT"]}` returns the updated row and unblocks a concurrent `WaitUserQuestion`; answering twice returns 409.
- `POST /internal/user-questions` (loopback + bearer token, same auth middleware as `/internal/approvals`) requires `task_id`, `question`, and `>= 2` options; rejects otherwise with 400.
- `GET /internal/user-questions/{id}/wait?timeout=1` returns `status: "pending"` immediately when unanswered within the timeout, and the resolved row once answered concurrently (same pattern as the existing `handleInternalWaitApproval` test).

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/api -run UserQuestion`

**Step 3: Register routes and handlers**

In `api.go`, next to the approval routes:

```go
r.Get("/api/user-questions", s.handleListUserQuestions)
r.Post("/api/user-questions/{id}/answer", s.handleAnswerUserQuestion)
...
r.Post("/internal/user-questions", s.handleInternalCreateUserQuestion)
r.Get("/internal/user-questions/{id}/wait", s.handleInternalWaitUserQuestion)
```

Implement each handler as the direct analog of its approval counterpart
(`handleListApprovals`, `handleDecision`, `handleInternalCreateApproval`,
`handleInternalWaitApproval`) — same query-param parsing, same timeout
clamping, same loopback/token auth middleware group for the `/internal/*`
pair.

**Step 4: Verify and commit**

Run: `go test ./internal/api`

Commit: `feat(api): add user-question REST routes`

---

### Task 4: `approve-mcp` bridge — `ask_user_question` MCP tool

**Files:**
- Modify: `internal/approvemcp/server.go`
- Create/modify: `internal/approvemcp/server_test.go`

**Step 1: Write failing bridge tests**

- `handleToolsList` now returns two tools: `approve` (unchanged) and `ask_user_question`, with a JSON Schema requiring `question` (string) and `options` (array of `{label, description?}`, minItems 2), and optional `header`/`multiSelect`.
- `handleToolsCall` with `name: "ask_user_question"` POSTs to `/internal/user-questions` with the task/execution context already carried by the server (same fields as `postApproval`), long-polls `/internal/user-questions/{id}/wait`, and returns a `tool_result` whose `content[0].text` is compact JSON `{"selected":[...], "other_text":"..."}` — **not** the `{behavior:...}` envelope used by `approve`.
- On daemon error, timeout, or an `expired`/`interrupt`-resolved question, the tool_result text is a neutral fallback (e.g. `{"selected":[],"note":"no response — proceed with your best judgement"}`), not an error and not a deny.
- `handleToolsCall` with an unknown tool name still returns the existing `-32602` error.

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/approvemcp`

**Step 3: Implement**

- Extend `handleToolsList`'s `tools` array with the `ask_user_question` entry (description should explicitly tell the model *when* to use it: ambiguous requirements, multiple reasonable approaches, or a decision the user should own — not for routine tool permission, which stays on `approve`).
- Extend `handleToolsCall` to switch on `params.Name`: keep the existing `approve` branch byte-for-byte; add an `ask_user_question` branch that validates arguments (`question` + `>= 2` options), calls a new `postUserQuestion`/`waitUserQuestionAnswer` pair (structurally identical to `postApproval`/`waitDecision` but hitting `/internal/user-questions*` and reading `status`/`response` instead of `decision`), and formats the tool_result.
- No changes to `internal/adapter/claudecode/adapter.go` — the same `--mcp-config` file already used for `approve` carries both tools.

**Step 4: Verify and commit**

Run: `go test ./internal/approvemcp`

Commit: `feat(approvemcp): add ask_user_question MCP tool`

---

### Task 5: Console UI — question card, wiring, status badge

**Files:**
- Modify: `ui/src/api/client.ts`
- Create: `ui/src/components/cards/UserQuestionCard.tsx`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/pages/ApprovalsPage.tsx`
- Modify: `ui/src/components/StatusBadge.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Write failing pure UI tests**

Add (or extend an existing `lib` test file) covering:
- Parsing a `UserQuestion.payload` into `{question, header, options, multiSelect}`, tolerant of missing `header`/`multiSelect` (mirrors `parseApprovalPayload`).
- Building the answer body from selected option labels + optional other-text, including the single-select "replace selection" vs multi-select "toggle" behavior.

**Step 2: Run tests and confirm failure**

Run from `ui/`: `npm test -- --run` (target the new test file)

**Step 3: Extend the API client**

- Add `type UserQuestion = { id, task_id, payload, status, response, answered_via, created_at, answered_at, execution_*, task_title, task_agent }`.
- Add `{ kind: "user_question_update"; data: UserQuestion }` to the `WSMessage` union.
- Add `listUserQuestions(status?)`, `answerUserQuestion(id, body: { selected: string[]; other_text?: string })`.
- Add `parseUserQuestionPayload(payload)` returning `{ question, header, options, multiSelect }`.

**Step 4: Build `UserQuestionCard.tsx`**

Structurally modeled on `ApprovalCard.tsx` (same card chrome, `focused` ring, keyboard affordance) but:
- Distinct accent color (e.g. indigo/blue) so it reads as "needs your input" rather than "needs your permission" (approval keeps its amber/orange treatment).
- Title "Question" instead of "Permission needed".
- Renders `header` as a small chip if present, then the `question` text.
- Renders `options` as toggle buttons: radio-style (single active) when `!multiSelect`, checkbox-style (multi-active) when `multiSelect`.
- Always renders an "Other" text input as an escape hatch.
- One "Submit" button, disabled until at least one option is selected or other-text is non-empty; `busy` state while submitting (mirrors `ApprovalCard`'s `busy` prop).
- Keyboard: number keys `1`–`9` toggle the corresponding option, `Enter` submits — additive to (not conflicting with) `ApprovalCard`'s existing `A`/`D` shortcuts.

**Step 5: Wire into `TaskDetailPage.tsx`**

- Add `userQuestions` state, populate from `listUserQuestions("pending")` alongside the existing `approvals` fetch, and handle `msg.kind === "user_question_update"` in the WS switch the same way `"approval_update"` is handled today (upsert-or-remove by id/status).
- Merge `approvals` and `userQuestions` into the single ordered "needs you" queue already driving `focusIdx`/keyboard navigation, so Tab/arrow cycling and the render loop treat both card kinds uniformly (render `ApprovalCard` or `UserQuestionCard` per entry based on which list it came from).
- Add `onAnswer(questionId, body)` mirroring `onDecide`, calling `answerUserQuestion` and removing the entry from local state on success.

**Step 6: Status badge + pending-approvals page**

- Add a `waiting_input` entry to `StatusBadge.tsx`'s `STYLES` map (indigo tone, consistent with the card accent chosen in Step 4).
- Extend `ApprovalsPage.tsx` with a second "Questions" section using the same list/poll/answer pattern as its existing approvals section (do not introduce a new page/nav entry — ADR 0010 non-goals).

**Step 7: i18n**

Add both locales' strings for: card title, header chip, "Other" placeholder, submit button, empty state, and the `waiting_input` status label.

**Step 8: Verify, build, and inspect**

```sh
cd ui
npm test
npm run build
```

Manually verify on `TaskDetailPage` and `ApprovalsPage` at ~1280px and ~390px: empty state, single pending question (single-select), multi-select question, "Other" text path, and a mixed queue of one approval + one question (keyboard cycling between them).

**Step 9: Commit**

Commit UI sources and regenerated `web/dist/` together with:
`feat(ui): add ask-user-question card and wiring`

---

### Task 6: Full verification and docs

**Files:**
- Modify if needed: `SYSTEM_DESIGN.md`
- Modify if needed: `SYSTEM_DESIGN.zh.md`
- Modify if needed: `docs/IMPL_NOTES.md`

**Step 1: Backend verification**

```sh
go test ./...
go vet ./...
```

**Step 2: Console verification**

```sh
cd ui
npm test
npm run build
```

Expected: PASS, no uncommitted generated drift in `web/dist/`.

**Step 3: Compatibility review**

Confirm the change is additive: an existing task with no pending questions
behaves exactly as before (`waiting_input` is never reached), `/api/user-questions`
returns `[]` on a fresh DB, and migration 010 runs cleanly against a fixture
DB that stops at `user_version = 9`.

**Step 4: Document the capability**

Record, in both `SYSTEM_DESIGN.md` and `SYSTEM_DESIGN.zh.md`: the
`UserQuestion` primitive and its parity/divergence from `Approval`, the
`ask_user_question` MCP tool, the `waiting_input` task status, and the
current `claude-code`-only scope (link ADR 0010 for the full rationale and
non-goals).

**Step 5: Commit**

Use an atomic Conventional Commit matching the actual final changes. Do not
stage unrelated working-tree files.
