# ADR 0002: Session context management (compress-at-entry + KV-cache-first)

**Status:** Accepted (v1 — re-reviewed)  
**Date:** 2026-07-16 (v0)  
**Revised:** 2026-07-17 (v1 re-review — P0/P1a/P1b shipped)  
**Related:** ADR 0001 (Provider + Kin agent), multi-agent orchestration

## Context

Kin has **two independent context paths**:

| Path | Role |
|------|------|
| **Cross-turn** | Follow-up / handoff / no-`session_ref` → inject prior transcript into the next prompt |
| **Intra-turn** | `kinagent.runAgentLoop` appends assistant + tool results until stop |

### What shipped in v0 (P0/P1)

1. **Newest-first Context Pack** for handoff (`internal/sessionctx.BuildPack`) — fixes “latest turns dropped.”
2. **Reactive tool prune** in the Kin loop — full tool output is appended first; only when estimated size > ~100k (or provider overflow) are **older** tool payloads collapsed.

### Why v0 is not good enough (user review)

Two hard requirements were underspecified:

1. **Compress at entry into the main dialogue** — tool / sub-agent results must be reduced to **key facts by rules** *before* they become part of the main agent’s context. “Dump full, prune later” is the wrong default.
2. **KV-cache hit rate is a first-class goal** — prompt assembly must keep a **stable, append-only prefix** whenever possible. Mid-loop rewrite of earlier tool messages and every-turn re-packing of history both thrash provider prompt cache.

User-facing symptom of the old handoff bug (oldest-first fill) is fixed in packing order, but **cost/latency under long tool loops** and **cache invalidation under re-pack** remain design debt.

## Goals (ordered)

1. **Correctness** — recent user intent and open decisions survive; no silent “forgot the last turn.”
2. **KV-cache friendliness** — maximize reusable prefix across steps and turns (see Policy K).
3. **Main-context density** — only high-signal tool / worker digests enter the main agent messages (see Policy C).
4. **Recoverability** — full fidelity stays off-model in SQLite `events`; agent can retrieve via `session_search` (P2).
5. **Bounded cost** — char/token budgets on every injection path.

Non-goals unchanged: full PRINCIPLE memory product, cross-task embeddings, rewriting CLI agents’ internal context.

---

## Decision

Keep the **layered archive + Context Pack** architecture, but change the **hot path** rules:

```text
events (SQLite SoT)  ── full tool/worker payloads, UI, audit ──┐
                                                                │ retrieve
                ┌───────────────────────────────────────────────▼──┐
                │  Compact-on-entry (rules)                         │
                │  tool → ToolDigest ; worker → WorkerDigest        │
                └───────────────────────┬───────────────────────────┘
                                        │ append-only to model path
                ┌───────────────────────▼───────────────────────────┐
                │  Main agent messages (KV-cache stable prefix)     │
                │  system | pinned | sealed segments | live tail    │
                └───────────────────────────────────────────────────┘
```

### Policy C — Compress at entry (main dialogue)

**Rule:** Anything that is not the live user utterance or the model’s own assistant text is **digested before** it is appended to the main agent’s `messages` (or to the cross-turn pack the main agent will re-read).

| Source | Enter main context as | Full text lives in |
|--------|----------------------|--------------------|
| Kin `bash` / `read_file` / … | **ToolDigest** (rule-based) | `events` tool_result (+ optional raw blob) |
| `@claude` / `@codex` worker | **WorkerDigest** (rule-based, not 8k dump) | task-only worker events |
| Orchestrator chrome (`→ worker`) | omit or one-line status | events |
| User message | full (budgeted only if pathological) | events |
| Assistant final answer | full (soft cap for handoff re-inject) | events |

**Not allowed as default:**

- Append full tool stdout (80k hard cap only) into main loop messages, then hope a later prune saves you.
- Re-inject multi-kilobyte worker “final” verbatim into the next main-agent turn without a digest pass.
- Rely on “soft limit 100k then collapse old tools” as the primary compression strategy.

**v0 reactive prune** remains a **safety net** for overflow / hostile outputs, not the design center.

#### ToolDigest (rules, deterministic, no extra LLM)

Applied **once** at tool completion, before `messages = append(..., RoleTool)`.

| Tool | Keep in digest | Drop / defer to archive |
|------|----------------|-------------------------|
| `bash` | exit ok/err; command one-liner; **tail** of stdout/stderr (e.g. last 40 lines or ≤2–4k chars); extracted paths / `FAIL` / error signatures | huge build logs, repeated identical lines |
| `read_file` | path; size; **focused excerpt** (e.g. ≤120 lines or ≤4k) when file is large; if caller needed full file, prefer “path + hash/lines + note: use re-read” over pasting whole file every time | multi-10k source dumps |
| `write_file` | path + bytes written (already small) | content body (already not returned) |
| `list_dir` / `glob` | entry/match count + first N + “+K more” | unbounded listings |
| unknown | name + ≤1k head | rest |

UI may still show a longer `tool_result` in the event log; **model path ≠ UI path**.

Constants live in `sessionctx` / kinagent (tunable later via settings). Prefer **stable templates** so two similar tools produce similar digest shapes (helps both humans and any future cache of digests).

#### WorkerDigest (rules)

`buildMainSummary` / prior-result injection into the **main** chat must not paste up to 8k of each worker by default.

Per worker, keep:

1. Agent id + assignment one-liner  
2. Outcome: ok / failed  
3. **Key findings** extractive bullets: paths touched, commands run, test verdicts, explicit recommendations (heuristic line picks + hard cap, e.g. **≤1.5–2k runes** per worker for main context)  
4. Pointer: `seq` range or “details in task log / session_search”

Full worker answer remains in events (task-only column / expand in UI).

Worker **briefs** (what the sub-agent receives) may still carry a larger “Conversation so far” pack — that path is not the main Kin KV prefix; still budget it, but Policy C is about **main** dialogue density.

### Policy K — KV-cache hit rate first

Prompt-cache / KV reuse on modern APIs is **prefix-based**: the longest **byte-identical** message prefix shared with a previous call can be cached. Any edit to an earlier message invalidates that prefix and everything after it.

#### Hard rules

| # | Rule | Rationale |
|---|------|-----------|
| K1 | **Stable system prompt** for a running session (no per-turn injection of volatile “today’s pack” into system) | System is the leftmost prefix |
| K2 | **Append-only within a Kin loop turn** — do not rewrite earlier `RoleTool` / assistant messages for routine compression | Mid-loop `pruneLoopMessages` that mutates old tool bodies **kills** cache for the whole transcript |
| K3 | **Digest before append** (Policy C) so the appended tool message is already small and **final** | Avoid need to rewrite |
| K4 | **Cross-turn: prefer true multi-turn transcript continuation** over rebuilding a single giant “handoff user blob” every follow-up | Re-packing history every turn almost always changes the middle of the prompt |
| K5 | When history must shrink, **seal a segment**: immutable summary message **appended** (or replace only a dedicated “working_summary” slot that is *after* a frozen prefix), never reshuffle/re-summarize the entire past each time | Segment close is rare; re-pack every turn is frequent |
| K6 | **Newest-first budget selection is for offline pack build / first cold start**, not for mutating an already-cached live messages array | Pack ≠ live KV prefix |
| K7 | Tool schemas / tool def JSON stay **identical** across calls in a session | Many providers hash tools into the cache key |
| K8 | Optional later: send `cache_control` / provider-specific breakpoints only on **sealed** boundaries (system, pinned, segment summaries) | Amplifies K1–K5 |

#### What v0 code did wrong under Policy K (re-review status)

Motivating debt from the v0 review. Status column reflects the v1 re-review (P1a/P1b shipped).

| Behavior | File | Cache impact | v1 status |
|----------|------|----------------|-----------|
| Full tool output appended; later `pruneLoopMessages` rewrites older `RoleTool` content | `kinagent/loop.go` | Invalidates prefix at first rewritten tool message every N steps | **Fixed (P1a/P1b):** `ToolDigest` before append (loop.go:145); proactive prune removed — `pruneLoopMessages` is now a thin alias of `overflowCompactMessages`, called only on provider overflow (loop.go:82) |
| Every follow-up rebuilds `formatHandoffPrompt(…, contextBlock, user)` as a **new single user string** with a re-selected pack | `approvals.go` | Almost no cross-turn prefix reuse for Kin (no real session messages array) | **Partial:** pack now has fixed-order sealed slots (below); true durable messages array is **P1.5** (still open) |
| `BuildPack` newest-first drops different older lines each time budget fills | `sessionctx/pack.go` | Pack body churns even when recent turns stable | **Fixed (P1b):** `BuildSealedPack` seals overflow into `[Sealed summary]`+`[Session index]` instead of dropping; deterministic seal (re-derived per follow-up until P1.5) |
| `buildMainSummary` injects large worker text into main chat, then handoff re-truncates differently | `orchestrate.go` | Large volatile blocks in the only “history” Kin sees next turn | **Fixed (P1a):** `WorkerDigest` (≤1.8k runes, extractive) before main context (orchestrate.go:556) |

#### Target shape (Kin multi-turn)

Long-term (P1.5 / P2):

```text
messages = [
  system,                         // frozen for session
  // optional: sealed segment summaries (append-only over time)
  user_1, assistant_1,            // prior turns (persisted)
  user_2, assistant_2, tool…,     // ...
  user_live                        // only new suffix
]
```

v1 interim (minimal change, still Policy K–aware):

- Intra-turn: **compact-on-entry only**; delete routine mid-loop rewrite; keep overflow safety net **only** on provider error, and prefer dropping/omitting **newest giant** tool body + “see archive” over rewriting the entire old tail if that preserves a longer cached prefix (document tradeoff in code).
- Cross-turn: keep Context Pack for cold start / handoff / CLI switch, but:
  - structure pack slots in a **fixed order** with **stable headings**;
  - grow **sealed summary** + **recent tail** rather than reshuffling all lines;
  - avoid putting the full pack into `system`.

### Layer 0 — Archive (unchanged decision)

- **SoT:** SQLite `events` (UI / WS / approvals / concurrent writers).
- **P2:** `session_search` over events; optional JSONL **mirror** for `rg`, never sole archive.
- Models do not see the full log by default.

### Layer 1 — Context Pack (cross-turn injection)

Still used when there is no durable Kin messages session (handoff, interrupt, orchestrate cold start):

```text
[Session index]     short keyword lines (stable once sealed)
[Pinned]            goals, decisions, key paths
[Sealed summary]    compressed older narrative (immutable until next seal)
[Recent turns]      last K user/assistant digests (newest-first fill, then chrono)
[User request]      live turn only
```

**Budget:** newest-first inside Recent only; never oldest-first.  
**KV note:** a pack is a **new** prompt prefix when the sealed summary or recent window changes — accept cache miss on seal; avoid miss on every trivial follow-up by **not** changing sealed/index slots when only Recent gains one line (append-only Recent inside the pack template if possible).

### Layer 2 — When to seal / slide (secondary to C+K)

| Signal | Action | Cache note |
|--------|--------|------------|
| Topic shift / wave boundary | Seal previous segment → index keywords + summary; start new Recent | Seal once; then prefix stable |
| Pack over budget | Drop oldest Recent; do not rewrite Sealed | Touches only tail of pack |
| Provider overflow | Safety compact (prefer suffix / last tool) + single retry | Last resort |

### Layer 3 — Sub-agent isolation

Main prompt / main loop receive **WorkerDigest only** (Policy C).  
Workers still get briefs + prior digests; process traces stay task-only.

### Layer 4 — Retrieve (P2)

`session_search` + session index lines; agent reloads detail from archive instead of keeping raw tool logs in hot context.

---

## Phased delivery (revised)

### P0 — Correctness (done / keep)

1. Newest-first pack for handoff; prefer message signal over noise.  
2. Tests: latest turns survive when total > maxChars.

### P1a — Compact-on-entry (priority now)

1. `sessionctx.ToolDigest` / per-tool rules; wire in `kinagent` **before** append to `messages`.  
2. Lower `maxToolOutBytes` role: archive/UI cap only; model sees digest budgets (few k, not 80k).  
3. `WorkerDigest` in `buildMainSummary` + any re-inject into main pack (cap ~1.5–2k/worker, extractive).  
4. Keep UI event payloads informative; split “model content” vs “stored output” if needed.  
5. Tests: digest determinism + “full dump not present in RoleTool content.”

### P1b — KV-cache hygiene

1. Stop **proactive** mid-loop `pruneLoopMessages` that rewrites older tools; rely on P1a. ✅  
2. Overflow path: retry strategy documented for cache (prefer not rewriting entire history). ✅  
3. Stable system prompt; fixed tool defs. ✅  
4. Handoff pack: fixed section headers; sealed summary slot; reduce full re-pack churn. ✅ — `sessionctx.BuildSealedPack` emits `[Session index] / [Pinned] / [Sealed summary] / [Recent turns]` in fixed order; overflow is sealed (extractive + keyword index), not dropped. `[Pinned]` is caller-supplied (empty until P1.5); seal is deterministic but re-derived per follow-up (true persistence = P1.5).  
5. Metrics (debug): prompt chars, optional `cached_tokens` from provider usage when present. _(open)_

### P1.5 — Durable Kin transcript (real multi-turn messages)

1. Persist Kin `messages` (or equivalent turns) per task for same-agent follow-up instead of only `formatHandoffPrompt` blob.  
2. Follow-up = append user turn to frozen prefix (maximum cache hits).  
3. Handoff / agent switch still builds a pack (cold prefix).

### P2 — `session_search` + optional JSONL mirror

Unchanged intent; digests may include “search keys” to encourage retrieval.

### P3 — Optional LLM micro-summarize for sealed segments only

Never for every tool line; only at seal boundaries when extractive quality is poor.

---

## Alternatives considered

| Alternative | Why not alone |
|-------------|----------------|
| Dump full tools + prune when near limit | Cheap to implement; **cache thrash** + main context stays dirty until limit; rejected as default |
| Pure sliding window every turn | Simple; loses decisions; rewrites prefix often |
| Pure LLM summarize every tool | Cost/latency; non-deterministic; hurts cache and audits |
| Only sub-agent isolation | Does not fix single-agent Kin tool loops |
| JSONL-only + GREP as SoT | Fork from `events`; mirror only |
| Newest-first pack as the only “session memory” | Good cold-start; **bad** as every-turn KV strategy |

---

## Consequences

- Main agent context stays **small and factual** by construction.  
- Tool/worker detail remains recoverable from **events** + later search.  
- Long Kin loops should see **higher cache hit rates** and lower $/turn if the provider supports prompt cache.  
- Implementation cost: digest rules need maintenance per tool; tests must lock templates.  
- CLI agents (`claude-code` / `codex`) still manage their own resume sessions; Kin applies C+K on orchestration boundaries and native loop only.

---

## Implementation map

| Area | Path |
|------|------|
| Pack / digests | `internal/sessionctx/` |
| Kin loop | `internal/adapter/kinagent/loop.go`, `tools.go` |
| Handoff | `internal/task/approvals.go` (`handoffContext`, `formatHandoffPrompt`) |
| Orchestration | `internal/task/orchestrate.go` (`buildMainSummary`, `buildWorkerBrief`) |
| Archive | `internal/store` events |

## Review checklist (re-open ADR if violated)

v1 re-review verdicts (2026-07-17):

- [x] Does a new tool result enter main `messages` only as a digest? — **Yes.** `ToolDigest` at `loop.go:145` before `RoleTool` append; raw stdout capped at 80k for events/UI only.
- [x] Does any routine path rewrite a non-tail message already sent to the model? — **No routine path.** Only `overflowCompactMessages` on provider overflow (one retry), documented as last resort.
- [~] Does each follow-up rebuild a wholly new history blob when a durable transcript would suffice? — **Still true for Kin follow-ups** (`formatHandoffPrompt` blob); accepted as debt until **P1.5** durable messages.
- [x] Are sub-agent process traces absent from the main hot pack? — **Yes.** `WorkerDigest` only (`orchestrate.go:556`); worker CLI text/tools stay task-only.
- [x] Is full fidelity still in SQLite for UI/audit? — **Yes.** `events` remains SoT; model path ≠ UI path.

Legend: `[x]` satisfied · `[~]` known debt tracked in Phased delivery.
