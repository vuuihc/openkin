# Token Efficiency Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Add trustworthy request-level Token and Cache accounting with task-level and aggregate visibility in the Kin console.

**Architecture:** Normalize provider/agent usage events into an append-only SQLite ledger keyed by the persisted task event. Update the existing task summary transactionally for live compatibility, then expose additive task and aggregate APIs to a compact task summary and the existing Usage page.

**Tech Stack:** Go, SQLite (`modernc.org/sqlite`), React 18, strict TypeScript, Vitest, Tailwind, Kin REST/WebSocket APIs.

---

### Task 1: Add the usage ledger migration and store types

**Files:**
- Modify: `internal/store/migrate.go`
- Modify: `internal/store/store.go`
- Modify: `internal/store/store_test.go`
- Test: `internal/store/usage_test.go`

**Step 1: Write failing migration tests**

Add tests that open a fresh database and a populated schema-v4 database, then
assert `usage_records` exists, existing tasks remain readable, and schema
version advances to 5.

**Step 2: Run the migration tests and confirm failure**

Run: `go test ./internal/store -run 'Test(OpenFresh|MigrateV4UsageLedger)'`

Expected: failure because schema version 5 and `usage_records` do not exist.

**Step 3: Add migration 005**

Create `usage_records` with the columns and indexes from the accepted design.
Keep migration 001 as the current fresh schema and add the new table there, so
new installs do not replay historical migrations.

**Step 4: Add store domain types and validation**

Add `UsageRecord`, cache status constants, input semantics constants, and cost
source constants. Reject negative token counts and invalid enum values before
writing.

**Step 5: Add persistence tests**

Cover a reported zero cache value, nullable unknown cache, a duplicate
`(task_id,event_seq)`, and cascade/foreign-key behavior.

**Step 6: Verify the store package**

Run: `go test ./internal/store`

Expected: PASS.

**Step 7: Commit the module**

Stage only the four store files and commit:
`feat(usage): add request-level usage ledger`

### Task 2: Normalize adapter and provider usage semantics

**Files:**
- Create: `internal/task/usage.go`
- Create: `internal/task/usage_test.go`
- Modify: `internal/provider/provider.go`
- Modify: `internal/provider/openai_compat.go`
- Modify: `internal/provider/provider_test.go`
- Modify: `internal/adapter/codex/parse.go`
- Modify: `internal/adapter/codex/parse_test.go`
- Modify: `internal/adapter/claudecode/parse.go`
- Modify: `internal/adapter/claudecode/parse_test.go`
- Modify: `internal/adapter/grok/adapter.go`

**Step 1: Write table-driven normalizer tests**

Fixtures must cover Codex inclusive input, Claude uncached-only input plus cache
read/write, Kin known zero, Kin unknown cache, malformed JSON, negative values,
and a generic result fallback.

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/task -run TestNormalizeUsage`

Expected: failure because the normalizer is absent.

**Step 3: Preserve cache field presence in provider responses**

Add an explicit cache-reported boolean to `provider.Usage`. Decode optional
OpenAI-compatible cache fields with pointers so missing and zero remain
different.

**Step 4: Emit canonical adapter usage events**

Keep Codex's existing `usage` event. Add a normalized `usage` event before
Claude and Grok result events. Preserve provider-native details in the payload
for audit and forward compatibility.

**Step 5: Implement the pure normalizer**

Map payload shapes to `store.UsageRecord`, choose input semantics, calculate
logical/eligible input, and reject impossible counts without mutating state.

**Step 6: Verify focused packages**

Run: `go test ./internal/provider ./internal/adapter/codex ./internal/adapter/claudecode ./internal/adapter/grok ./internal/task -run 'Usage|Parse'`

Expected: PASS.

**Step 7: Commit the module**

Commit explicit paths with:
`feat(adapter): normalize token and cache usage`

### Task 3: Persist usage and live task summaries atomically

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/store/usage_test.go`
- Modify: `internal/task/engine.go`
- Modify: `internal/task/engine_test.go`

**Step 1: Write failing transaction and engine tests**

Test event + ledger + task summary atomicity, task cache state aggregation,
Codex usage/result de-duplication, Kin multi-round usage without cumulative
result double counting, Claude result completion, and follow-up accumulation.

**Step 2: Run focused tests and confirm failure**

Run: `go test ./internal/store ./internal/task -run 'Usage|DoubleCount|Cache'`

Expected: failure because usage events are not consumed.

**Step 3: Add transactional append**

Implement one store method that allocates the event sequence, inserts the
event, inserts the ledger row, and increments the task read model in a single
transaction. Publish only after commit.

**Step 4: Update the engine accounting path**

Consume canonical `usage` events. Treat `result` as lifecycle-only after usage
was seen, retaining a structured fallback for legacy adapters. Preserve all
existing model-directive work already present in `engine.go`.

**Step 5: Verify focused packages**

Run: `go test ./internal/store ./internal/task`

Expected: PASS.

**Step 6: Commit the module**

Review `git diff internal/task/engine.go` to ensure unrelated working-tree
changes are not staged. Commit reviewed hunks with:
`feat(task): account for usage events atomically`

### Task 4: Expose task and aggregate Usage APIs

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/store/usage_test.go`
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`
- Modify: `internal/api/usage_test.go`

**Step 1: Write failing aggregate tests**

Cover eligible denominators for inclusive and uncached-only inputs, a reported
0% hit rate, unknown, unsupported, mixed coverage, occurrence-time day grouping,
model/source subtotals, and the existing fields expected by old clients.

**Step 2: Run tests and confirm failure**

Run: `go test ./internal/store ./internal/api -run Usage`

Expected: failure because the new fields and task endpoint are absent.

**Step 3: Implement store summaries**

Add coverage-aware aggregation from `usage_records`. Merge legacy task totals
only for tasks with no ledger rows, while leaving their cache state unknown.

**Step 4: Add the task Usage endpoint**

Register `GET /api/tasks/{id}/usage`; reuse existing authentication and 404
semantics. Extend `/api/usage/summary` additively.

**Step 5: Verify API behavior**

Run: `go test ./internal/store ./internal/api`

Expected: PASS.

**Step 6: Commit the module**

Commit explicit paths with:
`feat(api): expose token efficiency summaries`

### Task 5: Add task and global Cache visibility

**Files:**
- Create: `ui/src/lib/usage.ts`
- Create: `ui/src/lib/usage.test.ts`
- Create: `ui/src/components/usage/TaskUsageSummary.tsx`
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/pages/UsagePage.tsx`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`
- Regenerate: `web/dist/`

**Step 1: Write failing pure UI tests**

Test token formatting, reported zero, unknown, unsupported, mixed status,
coverage labels, and cache rate formatting.

**Step 2: Run tests and confirm failure**

Run from `ui/`: `npm test -- --run src/lib/usage.test.ts`

Expected: failure because usage helpers are absent.

**Step 3: Extend strict API types and client**

Add task and aggregate usage response types and `getTaskUsage`. Avoid `any`;
narrow nullable and enum fields at the API boundary.

**Step 4: Build the task summary component**

Use a compact 2×2/single-row metric layout and an accessible details toggle
with `aria-expanded` and `aria-controls`. Do not add per-request noise to the
chat transcript.

**Step 5: Extend the Usage page**

Use `grid-cols-2 sm:grid-cols-4` for Spend, Tokens, Cache Hit Rate, and Tasks.
Add cache detail and coverage to each agent row. Move all touched page text into
both locale files.

**Step 6: Verify unit tests and production build**

Run from `ui/`:

```sh
npm test
npm run build
```

Expected: PASS and regenerated `web/dist/`.

**Step 7: Inspect desktop and narrow widths**

Verify loading, empty, unknown, supported-zero, mixed, and populated states at
approximately 1280 px and 390 px widths. Confirm keyboard operation and visible
focus for the details toggle.

**Step 8: Commit the module**

Commit UI sources and generated bundle together with:
`feat(ui): show token cache efficiency`

### Task 6: Full verification and documentation alignment

**Files:**
- Modify if needed: `SYSTEM_DESIGN.md`
- Modify if needed: `SYSTEM_DESIGN.zh.md`
- Modify if needed: `docs/plans/2026-07-18-token-efficiency-observability-design.md`

**Step 1: Run backend verification**

```sh
go test ./...
go vet ./...
```

Expected: PASS.

**Step 2: Run console verification**

```sh
cd ui
npm test
npm run build
```

Expected: PASS with no uncommitted generated drift.

**Step 3: Review migration and compatibility risks**

Open both a new database and a populated v4 fixture. Confirm old task JSON
fields are unchanged, new fields are additive, and no historical task reports a
false 0% Cache Hit Rate.

**Step 4: Align English and Chinese architecture text**

Document the ledger and best-effort limit capability only if implementation
changes the public architecture snapshot. Keep both top-level files aligned.

**Step 5: Commit final documentation or fixes**

Use an atomic Conventional Commit matching the actual final changes. Do not
stage the user's unrelated working-tree files.
