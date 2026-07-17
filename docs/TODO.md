# Kin TODO

**Status:** living backlog (not a calendar)
**Related:** [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) · [PRINCIPLE.md](../PRINCIPLE.md) · [ADR 0003](./adr/0003-artifacts-and-reader.md)

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

## Theme: Wiki / governed memory (pointer)

Semantic memory / LLM wiki remains the **v2 Remember** track. Prefer: Artifacts P0/P1 → then sparse Wiki extraction. Do not dual-build a second notes product in parallel without a written ADR.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-17 | Added Artifacts P0/P1 from study-material / multi-device reading pain |
