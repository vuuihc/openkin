# Per-Agent Usage Limits Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Let each agent carry an optional daily usage limit (spend USD and/or tokens) and surface **used-vs-limit** progress with near/over warnings in the Kin console. Display-only in this plan; usage is never blocked.

**Non-goals (deferred):** Blocking or throttling an over-limit agent at task-creation time (soft enforcement). This is documented as a follow-up in Task 5, not built here.

**Architecture:** Store per-agent limits as a single JSON `settings` row (`agent_limits`), reusing the exact pattern already used by `price_table`. A pure store aggregation joins those limits with the current natural-day slice of the existing `usage_records` ledger and returns per-agent status rows. A new additive read endpoint exposes those rows; the limits themselves round-trip through the existing settings GET/PUT plumbing. The Usage page renders a progress bar and warning color per agent row; the Settings page gains a JSON editor mirroring the price-table field.

**Design decisions (locked):**
- **Metric:** both spend USD and token count are supported per agent; each is independently optional (empty ⇒ unlimited on that metric).
- **Behavior:** display-only. No task is blocked.
- **Period:** natural day, using the same occurrence-time day convention as the existing `UsageSummary` daily grouping (server-local timezone).
- **Warning thresholds:** `ok` < 80% of limit, `warn` ≥ 80%, `over` ≥ 100%. A metric with no limit is always `ok` and shows no bar.

**Tech Stack:** Go, SQLite (`modernc.org/sqlite`), React 18, strict TypeScript, Vitest, Tailwind, Kin REST APIs.

---

### Task 1: Add agent-limit config and daily usage aggregation to the store

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/store/usage_test.go`

**Step 1: Write failing store tests**

Add tests that:
- Round-trip `agent_limits` through `GetAgentLimits`/`SetAgentLimits`, including an empty/absent key returning an empty map (not an error).
- Reject invalid limit JSON and negative limit values.
- `AgentLimitStatuses` aggregates only the current natural day from `usage_records`, groups by agent, and computes `used_spend_usd`/`used_tokens` from ledger rows.
- An agent with a limit but zero usage today reports `used = 0`, `status = ok`.
- An agent with usage but no configured limit reports the metric as unlimited (`limit = nil`, no bar-eligible status).
- Threshold boundaries: 79% ⇒ `ok`, 80% ⇒ `warn`, 100% ⇒ `over`, spend and tokens evaluated independently and the row status is the more severe of the two.
- A day-boundary fixture: a record from yesterday is excluded from today's totals.

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/store -run 'AgentLimit'`

Expected: failure because the types and methods are absent.

**Step 3: Add the config types and accessors**

- Add `const KeyAgentLimits = "agent_limits"`.
- Add `type AgentLimit struct { SpendUSDDaily *float64; TokensDaily *int64 }` (JSON: `spend_usd_daily`, `tokens_daily`, both `omitempty`).
- Add `GetAgentLimits(ctx) (map[string]AgentLimit, error)` reading the settings key, tolerating an empty value, and validating non-negative numbers.
- Add `SetAgentLimits(ctx, map[string]AgentLimit) error` that validates then marshals to the settings key. (May be unused by the API if PUT reuses raw settings; keep it for tests and future callers, or omit if the API path fully covers validation — decide during Step 4.)

**Step 4: Add the daily aggregation**

- Add `type AgentLimitStatus struct` with: `Agent`, `LimitSpendUSD *float64`, `UsedSpendUSD float64`, `LimitTokens *int64`, `UsedTokens int64`, `Status string` (`ok|warn|over`), `PeriodStart` (RFC3339, start of day).
- Add `AgentLimitStatuses(ctx) ([]AgentLimitStatus, error)`:
  - Compute the start-of-day boundary consistent with `UsageSummary`'s day grouping.
  - Aggregate `usage_records` for `occurred_at >= start_of_day` grouped by agent into spend/token totals.
  - Left-join against `GetAgentLimits`: include every agent that either has a limit configured or has usage today. Compute per-metric ratio and the row `Status` as the max severity across configured metrics; unconfigured metrics do not contribute.
  - Return rows sorted by agent for deterministic output.

**Step 5: Verify the store package**

Run: `go test ./internal/store`

Expected: PASS.

**Step 6: Commit the module**

Stage only the two store files and commit:
`feat(store): add per-agent daily usage limits`

### Task 2: Expose limit status and accept limit config over the API

**Files:**
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`
- Modify: `internal/api/usage_test.go`

**Step 1: Write failing API tests**

- `GET /api/usage/limits` returns `AgentLimitStatuses` JSON, reuses existing auth, and returns `[]` (not `null`) when empty.
- Settings round-trip: `PUT /api/settings` with `agent_limits` persists, and `GET /api/settings` echoes it back; invalid JSON is rejected with 400.
- An agent configured over its limit surfaces `status: "over"` through the endpoint (integration through the store).

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/api -run 'Usage|Limit|Settings'`

Expected: failure because the route, allowlist entry, and settings field are absent.

**Step 3: Register the limits endpoint**

Add `r.Get("/api/usage/limits", s.handleUsageLimits)` next to the existing usage routes. `handleUsageLimits` calls `s.Store.AgentLimitStatuses`, coerces `nil` to `[]`, and writes JSON.

**Step 4: Round-trip limits through existing settings plumbing**

- Add `"agent_limits": true` to `puttableSettings`.
- Add `AgentLimits string json:"agent_limits"` to `settingsResponse` and populate it in `handleGetSettings` via `get(store.KeyAgentLimits)`, defaulting empty to `"{}"`.
- Ensure the PUT path validates the value as parseable agent-limit JSON before persisting (reuse the store validation; reject with 400 on failure) so a malformed blob cannot corrupt the endpoint.

**Step 5: Verify API behavior**

Run: `go test ./internal/store ./internal/api`

Expected: PASS.

**Step 6: Commit the module**

Commit explicit paths with:
`feat(api): expose per-agent usage limits`

### Task 3: Show limit progress and add a limits editor in the console

**Files:**
- Create: `ui/src/lib/agentLimits.ts`
- Create: `ui/src/lib/agentLimits.test.ts`
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/pages/UsagePage.tsx`
- Modify: `ui/src/pages/SettingsPage.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Write failing pure UI tests**

Test in `agentLimits.test.ts`:
- Progress ratio and clamping (used/limit, capped at 100% for the bar width but status still `over`).
- Status mapping for `ok`/`warn`/`over` at the 80% and 100% boundaries.
- No-limit metric yields `null` progress and renders no bar.
- Combined-row status picks the more severe of spend vs tokens.
- Label formatting reuses `formatCost`/`formatTokenCount` (e.g. `$3.20 / $10.00`, `120K / 500K`).

**Step 2: Run tests and confirm failure**

Run from `ui/`: `npm test -- --run src/lib/agentLimits.test.ts`

Expected: failure because the helpers are absent.

**Step 3: Extend strict API types and client**

- Add an `AgentLimitStatus` type and `getUsageLimits()` calling `GET /api/usage/limits`.
- Add `agent_limits` to the settings response/request types. Narrow nullable numeric fields at the boundary; no `any`.

**Step 4: Render per-agent progress on the Usage page**

In the `byAgent` block of `UsagePage.tsx`, fetch limit statuses alongside the summary, key them by agent, and add a compact progress bar + `used / limit` label under each agent row when a limit exists. Use warning colors for `warn` and `over` states via existing Tailwind/`--kin-*` tokens. Rows without a configured limit keep their current appearance (no bar). Keep the existing cache/spend/task columns intact.

**Step 5: Add a limits editor to the Settings page**

Mirror the existing `price_table` field: a JSON textarea bound to `agent_limits` with parse-on-save validation, saved through the existing settings PUT. Add helper text describing the `{"<agent-id>": {"spend_usd_daily": N, "tokens_daily": N}}` shape. Move all new copy into both locale files.

**Step 6: Verify unit tests and production build**

Run from `ui/`:

```sh
npm test
npm run build
```

Expected: PASS and regenerated `web/dist/`.

**Step 7: Inspect desktop and narrow widths**

Verify loading, empty (no limits configured), under-limit, near-limit (`warn`), and over-limit (`over`) states at ~1280 px and ~390 px. Confirm the bar and warning color are legible and the Settings editor rejects malformed JSON with a visible error.

**Step 8: Commit the module**

Commit UI sources and generated bundle together with:
`feat(ui): show per-agent usage limits`

### Task 4: Full verification

**Step 1: Backend verification**

```sh
go test ./...
go vet ./...
```

Expected: PASS.

**Step 2: Console verification**

```sh
cd ui
npm test
npm run build
```

Expected: PASS with no uncommitted generated drift.

**Step 3: Compatibility review**

Confirm the change is additive: a database with no `agent_limits` key behaves as "no limits", `/api/usage/limits` returns `[]`, existing Usage/Settings responses keep their prior fields, and no historical task is affected. `agent_limits` is a settings row, so no schema migration is required — verify this holds and note it.

### Task 5: Documentation and deferred soft-enforcement note

**Files:**
- Modify if needed: `SYSTEM_DESIGN.md`
- Modify if needed: `SYSTEM_DESIGN.zh.md`
- Modify if needed: `docs/IMPL_NOTES.md`

**Step 1: Document the capability**

Record the per-agent daily-limit config (`agent_limits` settings key), the `/api/usage/limits` read model, and the display-only semantics. Keep English and Chinese architecture text aligned.

**Step 2: Record the deferred enforcement path**

Note explicitly that limits are advisory/display-only today, and sketch the future soft-enforcement hook (check `AgentLimitStatuses` at task creation / new-round start in the engine, warn or block when `status == "over"`). This makes the follow-up cheap to pick up without implying it already exists.

**Step 3: Commit**

Use an atomic Conventional Commit matching the actual final changes. Do not stage unrelated working-tree files.
