# Kin TODO

**Status:** living backlog (not a calendar)
**Related:** [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) · [PRINCIPLE.md](../PRINCIPLE.md) · [ADR 0003](./adr/0003-artifacts-and-reader.md) · [ADR 0008](./adr/0008-project-one-pager.md)

This file tracks **near-term product work after the MVP agent console**. MVP milestones M0–M4 remain in [MVP_TECH_SPEC.md](./MVP_TECH_SPEC.md).

---

## Theme: Artifacts (产物库)

**Promise:** Agent sessions produce readable deliverables (study notes, HTML primers, write-ups). Kin captures them locally, keeps the link to the source session, and lets you read them on any device that can reach your daemon—without dumping files into Downloads and losing context.

**Not in this theme (yet):** full PKM, second-brain wiki UI, Kin-hosted sync cloud, Anki-class review product.

**Ordering principle:** Artifacts (deliverable shelf + reader) before Wiki/Memory (long-term governed notes). Wiki may later **extract from** artifacts; it does not replace them.

---

### P0 — Capture → library → read

Goal: end the “generate → download → re-open elsewhere → lose session” loop.

- [x] **Artifact model + local store**
  - File truth under user data dir (e.g. `~/.kin/artifacts/**`); SQLite index for metadata only
  - Fields: `id`, `title`, `type` (`markdown` | `html` | `text`), `status` (`proposed` | `saved` | `archived`), `source.task_id` / message pointer, `tags`, `created_at`, `path`
  - Exportable; no Kin account
- [x] **Capture from sessions**
  - Detect strong candidates: structured long Markdown; full HTML documents; user intent (“整理成资料 / 写成讲义 / 导出”) — *P0: manual save only; auto-propose deferred*
  - UX: propose card aligned with Approvals language — `[入库] [预览后入库] [忽略]` (no silent high-impact auto-confirm) — *P0: manual “入库” on assistant messages*
  - Manual “Save as artifact” on a message / selection
- [x] **Artifacts library UI**
  - Nav entry alongside Tasks / Approvals
  - List/cards: title, type, source task, time
  - Open source task from an artifact; show artifact card on task detail — *source-task link on library + reader; in-task card deferred*
- [x] **Reader (P0)**
  - Markdown render + outline — *Markdown render; outline deferred*
  - HTML in **sandboxed** iframe / webview (untrusted content)
  - Readable via existing remote ladder (phone on LAN/tailnet opens same library)

**P0 acceptance**

- [x] A supervised agent produces a study primer (md or html) → user saves to Artifacts in one or two taps
- [x] Same artifact opens on phone through Kin remote without a separate file transfer
- [x] Artifact retains a working link back to the source task/session
- [x] Library survives daemon restart; files remain user-visible on disk

---

### P1 — Companion reader (陪读)

Goal: read without leaving context; ask about *this* document.

- [ ] **Split view:** Reader | Companion sidebar (drawer on small screens)
- [ ] **Artifact-scoped thread** keyed by `artifact_id` (resume later)
- [ ] **Context policy:** inject current section / selection + short artifact digest—not the whole doc every turn
- [ ] **Actions:** explain selection, exemplify, quiz me, summarize chapter
- [ ] **Basic organize:** tags, full-text search, archive
- [ ] **Task bridge:** from companion, optional “open follow-up task” with cite-back to artifact section

**P1 acceptance**

- [ ] User highlights a paragraph → companion explains it with the correct local context
- [ ] Companion thread resumes after leaving and re-opening the artifact
- [ ] Mobile: readable primary column + companion in a drawer; no dead ends

---

### Later (not scheduled)

- Highlight / margin notes persistence
- “Extract to Wiki / Memory” propose flow (depends on Memory v2)
- Flashcards / spaced review (only if pain remains after P1)
- Optional user-driven folder sync (Syncthing / iCloud / git)—Kin does not host content cloud
- Richer capture from workspace files written by agents

---

## Theme: Projects + One-Pager (项目封面)

**Promise:** Optional project containers with a single living **One-Pager**—goals, current focus, conclusions, open questions, next steps, evidence links. Casual sessions stay free-form; structure grows on a cover page the user owns. Agent proposes patches; user accepts.

**Docs:** [ADR 0008](./adr/0008-project-one-pager.md) · [plan](./plans/project-one-pager.md) · [Kin role / coaching loop](./plans/project-agent-role-design.md)

**Not in this theme:** kanban / sprint boards, completion %, streak guilt, fixed “overview session” as source of truth, always-on CEO dashboard, multi-user PM, Memory/Wiki replacement.

**Ordering principle:** Project P0 (cover + continue) can ship in parallel with Artifacts P1. Project P1 (recycle / catch-up) is the habit loop. Project companion should reuse Artifacts companion patterns when both exist.

---

### P0 — Project + One-Pager + Continue Focus

Goal: open a project, see *your* goals/focus in one page, start a session without re-explaining.

- [x] **Project model + local store**
  - Table `projects` (+ `project_roots`); files under e.g. `~/.kin/projects/<id>/ONE_PAGER.md`
  - Fields: `id`, `name`, `mode` (`ship` | `learn` | `explore` | `maintain`), `status`, `one_pager_rel`, optional `soft_progress`, timestamps
  - `tasks.project_id` nullable FK; no forced project on every task
  - Exportable; no Kin account
- [x] **One-Pager as file truth**
  - Stable skeleton: What / North Star / Current Focus / Conclusions / Open questions / Next (≤3) / Evidence
  - Mode templates (P0 at least **ship** + **learn**; explore/maintain strings ok)
  - Soft progress language only (`fog` → `can_explain` → `can_build` → `can_ship` → `can_teach`) — **no % bar**
  - Direct UI edit + optimistic concurrency on save
- [x] **Create / list / home UI**
  - Nav: Projects
  - Create from cwd / name + mode; optional suggest when cwd matches a root
  - Project Home: One-Pager + recent tasks + related artifacts + primary CTA **继续当前焦点**
- [x] **Continue Focus**
  - Creates task with short inject block (North Star, Focus, ≤3 next, brief digest)—not full history dump
  - Kin host: pinned/system short block; external CLIs: best-effort description / first message prefix
- [x] **Zero regression without projects**
  - Users who never create a project keep today’s Tasks-only path

**P0 acceptance**

- [x] From a repo cwd, create project → template One-Pager on disk → edit survives daemon restart
- [x] Associate tasks; project home lists them
- [x] Continue Focus opens a new task whose initial context includes Focus + North Star
- [x] No kanban columns, no completion percentage UI
- [x] Phone via existing remote ladder can open Project Home / read One-Pager

---

### P1 — Recycle + Catch-up

Goal: keep the cover warm without turning work into status theater.

Interaction contract: Kin remains one identity. The main agent works against North Star / Current Focus; mode-specific coaching stays low-frequency, and the session-end deputy-editor proposes only 0–3 evidence-backed patches. See [Kin role / coaching loop](./plans/project-agent-role-design.md).

- [ ] **Session-end recycle card** (long sessions or manual 收工 only)
  - One-line session summary (editable)
  - Propose 0–3 One-Pager patches (conclusions / open / next)
  - Optional Focus update suggestion
  - UX: `[采纳] [编辑后采纳] [忽略]` — never silent overwrite of North Star
- [ ] **Catch-up**
  - From last N project sessions → patch diff against current One-Pager → user confirm
- [ ] **Overview refresh** (explicit, rare): full-page draft with preview/discard
- [ ] **Stale hint** (e.g. 14 days): “可能过期了” + Catch-up; no red guilt UX
- [ ] **Diff view** before accept

**P1 acceptance**

- [ ] After a substantial session, user can write 0–3 lines back to the cover in ~20 seconds
- [ ] Catch-up never silently replaces the file
- [ ] User edits to North Star / Next stick unless a new suggestion is accepted

---

### P2 — Companion, handoff, on-demand map

- [ ] One-Pager companion thread (reuse Artifacts P1 thread model)
- [ ] Tighter Focus inject aligned with ADR 0002 packing budgets
- [ ] On-demand **module map** as a normal Artifact (not system truth / not % complete)
- [ ] Handoff pack: One-Pager + Focus + recent digests for cross-agent continue
- [ ] Polish explore / maintain templates

---

### Later (not scheduled)

- Auto-scan all disks for repos to “become projects”
- Multi-root monorepo UX beyond simple `project_roots`
- Wiki/Memory extract from One-Pagers (v2 Remember track)
- Optional weak kanban *view* (only if real pain remains—not default IA)

---

## Theme: Wiki / governed memory (pointer)

Semantic memory / LLM wiki remains the **v2 Remember** track. Prefer: Artifacts P0/P1 → Project One-Pagers as active covers → then sparse Wiki extraction. Do not dual-build a second notes product in parallel without a written ADR.

One-Pagers and Artifacts are **upstream shelves** for later memory—not memory themselves.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-17 | Added Artifacts P0/P1 from study-material / multi-device reading pain |
| 2026-03-22 | Added Projects + One-Pager theme (ADR 0008 + plan); explicit non-goals: kanban / % / overview-session-as-SoT |
| 2026-03-22 | Projects P0 implemented: store/API/UI, Continue Focus, One-Pager edit |
| 2026-03-22 | IA: sidebar cwd group *is* the project; cover via hover icon; remove Tasks/Projects footer tabs |
| 2026-03-22 | Project home lists related artifacts via source-task project_id |
