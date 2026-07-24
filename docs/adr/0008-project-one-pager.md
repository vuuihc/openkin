# ADR 0008: Project container + One-Pager (活文档封面)

**Status:** Accepted (P0 implemented; P1+ not started)
**Date:** 2026-03-22
**Related:** [ADR 0013 Prompt Recipes](./0013-prompt-recipes.md) · [TODO.md](../TODO.md) · [plan](../plans/project-one-pager.md) · [Kin role / coaching loop](../plans/project-agent-role-design.md) · ADR 0002 (session context) · ADR 0003 (Artifacts) · PRINCIPLE §5.11 / §6.2.1 · SYSTEM_DESIGN §2

## Context

Kin’s MVP is an **agent console** (tasks, approvals, remote, cost). Artifacts (ADR 0003) capture cold deliverables from sessions. Users still lack a **project-scale surface**: after many free-form sessions, it is hard to answer “what is this project for, what’s the focus, what’s decided, what’s next?” without re-reading transcripts.

We considered three shapes:

1. **Status lights only** (running / needs-you) — useful, too small to be the stickiness layer.
2. **Kanban (Todo / Doing / Review / Done)** — high maintenance; turns casual solo coding/chat into faux-Scrum; weak “done” semantics for exploratory work.
3. **A fixed overview session per project** — conversations rot; the “source of truth” sinks into the middle of a thread; hard to share across agents.

Solo users need **optional structure without progress-management tax**. Goals differ by intent (ship vs learn vs explore); a single % complete bar is dishonest.

## Decision

Introduce a thin **Project** container and a **One-Pager** as the project’s living cover page.

> **Project** groups related sessions and artifacts (usually by git root / cwd cluster, with manual override).  
> **One-Pager** is a single, structured, user-owned Markdown page: goals, focus, conclusions, open questions, next steps, and evidence links.  
> It is **not** a chat transcript, not a kanban, not Memory v2.

### Shape

| Layer | Role |
|-------|------|
| Project | Container: id, name, root path(s), mode, timestamps |
| One-Pager | Special artifact (`kind=project_brief` or dedicated row) — **file is source of truth** |
| Sessions / tasks | Materials under a project (provenance), not swimlanes |
| Artifacts | Evidence and deliverables linked from the One-Pager |
| Companion (later) | Optional thread scoped to the One-Pager (same spirit as Artifacts P1) |
| Session end recycle | Propose 0–3 patches into the One-Pager (user accept / edit / ignore) |

### Product rules (non-negotiable)

1. **One-Pager is the truth surface; sessions are process.** Do not make “the overview session” the SoT.
2. **User owns goals and mode.** Agent may suggest goal drift; never silently rewrite North Star / mode.
3. **Propose → accept** for agent writes (same language as Approvals / Artifacts capture). No silent high-impact overwrite.
4. **No mandatory state maintenance.** Users may open free-form sessions forever; structure is opt-in and salvageable at “收工”.
5. **No default kanban / KPI / completion %.** Soft progress language only (e.g. fog → can-explain → can-build → can-ship).
6. **Mode-sensitive templates, stable skeleton.** Same sections; different emphasis for Ship / Learn / Explore / Maintain.
7. **North Star ≠ Current Focus.** Long-term why vs this week’s single mainline; new sessions inject Focus strongly, full page sparingly.
8. **Evidence over prose.** Conclusions and next steps should link sessions / artifacts / (later) files when possible.
9. **Small by default (PRINCIPLE §5.11).** No second Jira, no wiki graph, no auto CEO dashboard on home.

### Canonical One-Pager skeleton

All modes share:

1. What this is (one line)
2. North Star (user-authored goal)
3. Current Focus (single mainline)
4. Established conclusions (with evidence links)
5. Open questions
6. Next 1–3 steps (not an infinite backlog)
7. Evidence index (sessions / artifacts)

Mode extras (templates, not separate products):

| Mode | Extra emphasis |
|------|----------------|
| **Ship** | Demo definition of done; risks; milestone notes |
| **Learn** | Understood / still fuzzy; teach-back box; practice ideas |
| **Explore** | Hypotheses; rejected paths; signals to deepen |
| **Maintain** | Health notes; known footguns; do-not-touch zones |

### Commands (product, not necessarily slash-UX v1)

- **Catch-up:** patch One-Pager from recent sessions (default, preview diff).
- **Overview refresh:** regenerate whole page draft (explicit, preview, easy discard).
- **Continue focus:** open a new task/session with Focus + short digest injected (not full history dump).

### Non-goals (this ADR)

- Kanban / sprint boards as default IA
- Automatic % complete or streak / guilt UX
- Replacing Artifacts library or session transcripts
- Full governed Memory / Wiki (v2 may **extract from** One-Pagers later)
- Multi-user project management, assignments, due dates
- Forcing every cwd into a Project on first sight
- Making the home screen a permanent “CEO cockpit”

### Identity with tasks (clarification)

- **Task** = one session/work unit (process).
- **Project** = durable cover for a **working directory** (usually the same “project” as the sidebar cwd group).
- Projects are **lazily materialized** from cwd (`POST /api/projects/ensure`); not a second manual hierarchy.
- Console IA: the **sidebar cwd group is the project**. One-Pager opens from a quiet control on that row (not a primary footer tab). Tasks remain sessions under the group; no separate Tasks/Projects nav entities required.
- New tasks auto-link when `cwd` matches a project root.

### Phasing

- **P0 — Project + One-Pager + Continue:** model, store, templates, editor/reader, link recent sessions/artifacts, “continue focus” task create, manual edit.
- **P0.5 — Pulse strip:** deterministic session/git heat + managed auto suggestions on cover (refresh button; window configurable).
- **P1 — Recycle + Catch-up:** session-end propose patches; catch-up from last N sessions; stale hint (not alarm).
- **P2 — Companion + deeper inject:** One-Pager-scoped companion; better prompt packing with Focus/digest (ADR 0002-aligned); optional module map **on demand** only.

See [plans/project-one-pager.md](../plans/project-one-pager.md) and [TODO.md](../TODO.md).

## Consequences

- Console IA gains **Projects** (or project home entry) without waiting on Memory v2.
- Artifacts gain a distinguished brief type / linkage; export must include project briefs.
- Task create paths should accept `project_id` + optional focus injection.
- Reduces pressure to invent kanban or “workbench status theater.”
- Gives a natural cover document for future cross-agent handoff packs.
- Risk: if agent auto-writes too aggressively, trust collapses — mitigate with propose/accept and user-editable file truth.

## Alternatives considered

1. **Fixed overview session only** — rejected as SoT; allowed later only as companion UX on top of the page.
2. **Kanban of sessions** — rejected as default; optional views not scheduled.
3. **Jump to Memory/Wiki** — higher governance cost; weaker “one glance cover” UX for active work/learn projects.
4. **IDE-style todo list only** — no narrative goal/focus; poor for learn/explore modes.
5. **Always-on auto module tree + % done** — high wrongness and pressure; deferred as rare on-demand “map” artifact, not system truth.
