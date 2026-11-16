# Natural-Language Model Directives & Model Policy

**Goal:** Let users steer which model each delegated agent uses through *natural language* in
the chat — both concrete ("这个任务用 Codex 的 GPT-5.6 Terra 执行") and macro
("聪明贵的模型做计划，便宜的模型做执行") — instead of the structured `@agent[model]` syntax.
The orchestrator resolves these into the existing per-step `Model` before workers launch.

**Non-goal:** Changing how models are *executed*. The path
`DelegateStep.Model → adapter.TaskSpec.Model → CLI --model/-m` already works and is untouched.

---

## Background — what already exists

- `@agent[model]` inline syntax parses into `DelegateStep.Model` (`plan.go`), resolved by
  `effectiveStepModel(t, step)` (step → task → empty) and passed to every adapter.
- `store.PriceTable` maps `model → {in, out}` USD/1M tokens — a cost signal for tiering.
- `SummarizeTitle` (`title.go`) is the precedent for a **best-effort LLM pre-pass** using the
  engine's `TitleResolver` provider client. This feature mirrors that pattern.

## Design — a model-resolution layer

Everything reduces to filling each step's `Model` (and, for bare tasks, the task model) via a
precedence chain evaluated before workers start:

```
1. explicit @agent[model]        (already parsed; always wins)
2. NL directive: per-agent       ← "用 Codex 的 GPT-5.6 Terra"
3. NL directive: global model    ← "整个任务用 opus 跑"
4. macro policy: role → tier      ← "计划用聪明模型，执行用便宜模型"
5. task / per-agent default       (existing fallback)
```

Deterministic parsing cannot handle unknown names ("GPT-5.6 Terra") or abstract preferences
("聪明的模型"), so steps 2–4 come from a **gated LLM structured-extraction pass**. Steps 1 and 5
stay deterministic — no LLM cost on the common path.

### New: `internal/task/modelcatalog.go`

A per-agent catalog of known models, each tagged with a tier. Does double duty: **name
normalization** (fuzzy "GPT 5.6 Terra" → canonical id) and **tier resolution** (pick
cheapest/smartest for an agent).

```go
type ModelTier string // "smart" | "balanced" | "fast"

type ModelSpec struct {
    ID      string
    Agent   string
    Tier    ModelTier
    Aliases []string // "gpt5.6", "5.6 terra", ...
}

type ModelCatalog map[string][]ModelSpec // agent → specs

func BuiltinCatalog() ModelCatalog
func (c ModelCatalog) Normalize(agent, freeText string) (id string, ok bool)
func (c ModelCatalog) PickByTier(agent string, tier ModelTier) (id string, ok bool)
```

- Seeded with current models per agent (claude-code: opus=smart / sonnet=balanced /
  haiku=fast; codex: gpt-5.1-codex-max=smart / gpt-5-codex=balanced / o4-mini=fast; grok; kin).
- Cost ordering cross-checked against `PriceTable` where entries exist, so tiers stay
  consistent with real prices without hardcoding a second cost source.
- Unknown-but-explicit names (a model not in the catalog) pass through verbatim — the catalog
  only *helps*, it never blocks a name the user typed.

### New: `internal/task/modeldirective.go`

```go
type ModelDirective struct {
    Global       string            // model for all workers
    PerAgent     map[string]string // agent id → model
    PlannerTier  ModelTier         // macro: model tier for planning-ish steps
    ExecutorTier ModelTier         // macro: model tier for execution-ish steps
}

// Gated: returns ok=false (no LLM call) when the message has no model-ish hint.
func ExtractModelDirective(ctx, client, model, userTurn string, cat ModelCatalog) (ModelDirective, bool, error)

// Fills step.Model where empty, honoring precedence + catalog normalization.
func (d ModelDirective) ApplyTo(plan *DelegatePlan, cat ModelCatalog)
```

- **Prefilter** (`modelHintRE`): only invoke the LLM when the turn mentions model-ish terms
  (`模型|model|gpt|claude|opus|sonnet|haiku|grok|gemini|贵|便宜|聪明|成本|快|cheap|smart|cost|fast|tier`).
- **LLM call**: system prompt asks for strict JSON matching the directive shape, given the
  catalog's known ids per agent. Temperature ~0, small max-tokens, ~10s timeout, best-effort
  (any failure → empty directive, orchestration proceeds on defaults). Mirrors `SummarizeTitle`.
- **Role heuristic for tiers**: a step is "planner-ish" vs "executor-ish" from its instruction
  (调研/计划/设计/review/plan/design vs 实现/执行/修/implement/run) — reuse the existing
  `intent.go` regex vocabulary; `PlannerTier`/`ExecutorTier` then map through
  `catalog.PickByTier(step.Agent, tier)`.

### Wiring — `internal/task/engine.go`

- Reuse the existing `titleFn TitleResolver` (same provider) — no new resolver plumbing.
- In `run()`, after the plan is built (`shouldOrchestrate` / `AutoCodingPlan`) and before
  `runOrchestrated`, extract the directive from the **live user turn** (`UserTurnPrompt`) and
  `ApplyTo` the plan. Explicit `@agent[model]` steps are already filled and won't be overwritten.
- Single-agent (non-orchestrated) path: if the directive names a global/host-agent model and the
  task has none, set the task model for that run. (Agent *routing* by NL — "switch to Codex" —
  is out of scope here; `@codex` already covers that.)

## Phasing

- **Phase 1 — concrete directives:** catalog + `Global`/`PerAgent` extraction + `ApplyTo` +
  single-task model. Delivers "用 Codex 的 GPT-5.6 Terra 执行".
- **Phase 2 — macro policy:** `PlannerTier`/`ExecutorTier` + role heuristic + `PickByTier`.
  Delivers "聪明模型做计划，便宜模型做执行". Same code path; only the extraction schema and the
  tier-resolution branch grow.

Both phases share one resolver, so Phase 2 is additive.

## Tests

- `modelcatalog_test.go`: normalization (fuzzy → canonical, unknown pass-through), `PickByTier`
  honors PriceTable ordering.
- `modeldirective_test.go`: prefilter gates the LLM (stub client asserts no call on plain text);
  per-agent + global + tier extraction from a stub JSON response; `ApplyTo` precedence
  (explicit `@model` not overwritten, empty steps filled).
- `orchestrate_test.go`: end-to-end — directive on a two-step plan assigns distinct models.

## Risks

- **Latency/cost:** mitigated by the prefilter gate + best-effort timeout; plain messages never
  call the LLM.
- **Wrong model from a hallucinated id:** catalog normalization + "explicit user text passes
  through" keep it bounded; unknown ids surface in the existing per-agent model label so the user
  sees what was chosen.
- **Ambiguous macro intent:** Phase 2 only; conservative default is "no tier change" when the
  extractor is unsure.
