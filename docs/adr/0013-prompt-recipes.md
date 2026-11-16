# ADR 0013: Prompt Recipes（应用层用配方扩展，不用专用业务 API）

**Status:** Accepted (convention; slices 0–4 landed 2026-07-25)  
**Date:** 2026-07-25  
**Related:** [plan](../plans/2026-07-25-prompt-recipes-migration.md) · [ADR 0008](./0008-project-one-pager.md) · [ADR 0011](./0011-routines.md) · [coaching-loop spec](../plans/project-coaching-loop-feature-spec.md) · PRINCIPLE §5.5 / technical decision filter · AGENTS.md §3a

## Context

Kin already has a complete **execution bus**:

| Primitive | Role |
|-----------|------|
| `POST /api/tasks` / Follow-up | Start or continue work |
| Agent loop + tools | Read/write files, run commands, change the world |
| Project bind + One-Pager inject | `maybeInjectProjectContext` / `BuildContinuePrompt` |
| `ONE_PAGER.md` (+ later memory files) | User-owned narrative source of truth |
| Chat UI | Human review happens in conversation / files |

Several **application-layer** features were still implemented as **side APIs** that re-wrap the same idea:

- **Session recycle / 收工** — dedicated table, REST, suggestion accept/ignore UI *(removed from UI and backend; schema drop in migration 012)*.
- **Continue focus** — `POST /api/projects/{id}/continue` ≈ `BuildContinuePrompt` + `Engine.Create` (inject already runs on normal create).
- **Summarize cover** — `POST /api/projects/{id}/summarize` + `mergeCoverProposal` ≈ “ask a model to draft cover edits” outside the agent loop.

These paths:

1. Force users to learn opaque product nouns (收工、辅助更新) instead of talking to Kin.
2. Duplicate LLM orchestration **beside** the task engine (second prompt stack, second merge semantics).
3. Grow schema + REST + cards for behavior a **reviewable prompt** could express.
4. Make the next feature (project memory, catch-up, teach-back) look like “add another API” by default.

Routines (ADR 0011) already proved the right shape for *productized* automation: **thin scheduler + normal Task + prompt convention**, not a workflow engine. Application coaching should follow the same gravity—except without even a ticker when the user is present.

## Decision

### 1. Single execution entrance for application behavior

Interactive application features that mean “have Kin do/think something” **must** launch through:

```text
render prompt (optional recipe)
  → POST /api/tasks  or  Follow-up on an existing task
  → agent loop + tools
  → user reviews in chat and/or in the files Kin changed
```

No parallel “suggestion engine”, “cover patch engine”, or “coaching card engine”.

### 2. Prompt Recipe = data/convention, not a runtime platform

A **Recipe** is a named, reviewable prompt template used to start work. It is **not** a new daemon concept.

```text
Recipe
  id                 stable key (e.g. focus.continue, cover.update)
  title              short UI label (i18n)
  description        optional one-liner
  prompt_template    text with simple placeholders
  launch             create_task | follow_up
  defaults           optional agent / permission_mode / model hints
```

**Allowed placeholders (v1, string replace only):**

| Token | Meaning |
|-------|---------|
| `{{project_name}}` | Project display name |
| `{{project_id}}` | Project id |
| `{{cwd}}` | Working directory / primary root |
| `{{mode}}` | Project mode (`ship` / …) if set |
| `{{user_note}}` | Optional free text from the button/composer |

**Explicitly not in v1:** template DSL, conditionals, loops, server-side section merge, accept/ignore suggestion records, recipe marketplace, versioned remote catalogs.

**Storage (v1):** repo-owned defaults (e.g. `internal/recipes` or `ui` constants + optional later `docs/recipes/*.md`). User overrides are a later opt-in; do not block migration on a DB table.

**Execution:** always `Engine.Create` / Follow-up with the **rendered string** as `prompt`. Project context injection stays on the existing create path (`maybeInjectProjectContext`); recipes must not re-implement digest assembly in a second stack unless a recipe truly needs a different inject policy (default: reuse inject).

### 3. Sources of truth

| Concern | Source | How it changes |
|---------|--------|----------------|
| Project narrative | `ONE_PAGER.md` | User edit via GET/PUT **or** agent tools in a task |
| Task history | events / transcript | Normal task pipeline |
| Deterministic signals | pulse (git/sessions) | Optional read-only metrics; not coaching prose |
| Long-term memory (future) | governed memory / files | Same rule: prompt + tools + user authority—not a recycle clone |

Server-side **semantic merge of cover sections** (`mergeCoverProposal`, recycle accept patch) is **retired** as a product pattern. If a draft is needed, the agent writes a proposal in chat or edits the file under user-visible tool steps.

### 4. When a new hard-coded API *is* allowed

Add schema/REST/UI machinery only when at least one holds:

1. **Permission / safety boundary** (approvals, sandbox, auth).
2. **Durable source of truth** that must outlive a single chat and stay inspectable without an LLM (project row, one-pager file path, artifacts blob).
3. **Stream / task / workspace protocol** (execution identity, events, FIFO queue).
4. **Deterministic metrics** a model must not invent (usage ledger, pulse counts).
5. **Scheduling / capture the user is not present for** (Routines ticker—ADR 0011).

If a feature is only “choose words → model acts → user confirms”, it is a **recipe** (or plain user message), not an API.

### 5. UI contract

- Buttons such as “继续当前焦点 / 辅助更新封面 / 整理项目记忆” are **recipe launchers**: fill template → `createTask` (or navigate to composer with prefilled prompt).
- Review UX is the **existing task transcript** (and file diff/tools), not a second card framework.
- Command palette may list recipes; still the same launch path.

### 6. Relationship to Project mode / soft_progress

- **Mode** may remain a light template switch for default One-Pager headings and a single inject line—but strategy text should trend toward **user-owned cover content**, not growing hard-coded coaching taxonomies.
- **soft_progress** enums are not an execution engine; prefer free text on the cover over new APIs. Product may thin or remove the enum UI without a new subsystem.

### 7. Retired / to-migrate surfaces

| Surface | Disposition |
|---------|-------------|
| Recycle REST + `project_recycles` + review cards | **Removed** (code + UI; table dropped in schema 12) |
| `POST /api/projects/{id}/continue` | **Migrate** → recipe `focus.continue` + `POST /api/tasks` |
| `POST /api/projects/{id}/summarize` + proposal merge | **Migrate** → recipe `cover.update` (+ agent edits file or drafts in chat) |
| Coaching-loop “收工卡片” as P1 product | **Superseded** by this ADR; do not reintroduce hard-coded suggestion batches |
| Catch-up / overview refresh (ADR 0008 commands) | **Recipes** when implemented—not new patch engines |

`GET/PUT` one-pager, project CRUD/ensure, pulse **read**, task inject: **keep**.

## Consequences

### Positive

- New application behaviors default to **copy, not code**.
- One place to observe and approve work (task stream).
- Aligns with PRINCIPLE §5.5 (“实现上也优先简单”) and AGENTS §3a (*Prompt before product machinery*).
- Same pattern as Routines: product thin, execution reused.

### Negative / trade-offs

- Cover updates become **agent-mediated** (tool writes) rather than a guaranteed structured JSON patch—slightly less “form-like”, more “assistant-like”. Acceptable: user still owns the file and can hand-edit.
- Recipe quality depends on prompt maintenance; mitigate with a small checked-in catalog and tests that render templates (not that parse free-form model JSON into section patchers).
- Power users who loved one-click “采纳建议” lose a dedicated card; they gain ordinary chat control and file history.

### Non-goals

- Generic workflow / DAG engine  
- Server-side Accept/Ignore suggestion records  
- Recipe plugin marketplace or remote signed catalogs (v1)  
- Replacing Routines, Artifacts, Approvals, or Provider layers  
- Auto-firing recipes without user (or Routine) intent  

## Compliance check (for reviewers)

Before merging a feature that adds API/table/UI for “help with project/session narrative”:

1. Can a recipe + task express it? → **Do that.**  
2. Does it only exist to merge model JSON into markdown sections? → **Reject; agent edits file or user pastes.**  
3. Is it permissions, durability, protocol, metrics, or schedule? → **Hard-code allowed.**

## Implementation pointer

See [plan: Prompt Recipes migration](../plans/2026-07-25-prompt-recipes-migration.md) for slices: convention docs → continue → summarize → catalog → optional palette.
