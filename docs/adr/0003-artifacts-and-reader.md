# ADR 0003: Artifacts library + reader (capture before Wiki)

**Status:** Accepted (product direction; implementation not started)
**Date:** 2026-07-17
**Related:** [TODO.md](../TODO.md) · PRINCIPLE §5.5 / §5.6 / §5.11 · SYSTEM_DESIGN §2–§3 · ADR 0002 (session context ≠ long-lived deliverables)

## Context

Users often ask coding / chat agents to produce **topic study materials** (Markdown or HTML). Today those deliverables:

1. Live inside a transcript bubble or vendor canvas
2. Require manual download
3. Lose the link to the generating session
4. Are awkward to re-open across phone and desktop

Kin already is a **self-hosted console** for agent work (tasks, approvals, remote ladder). Governed **Memory / Wiki** is still v2. We need a thinner product slice that matches this pain **without** building a full PKM or silent long-term memory.

## Decision

Add an **Artifacts** capability:

> **Artifacts** are readable deliverables produced in agent sessions. Kin stores them as local files, indexes metadata, keeps provenance to the source task/session, exposes a library + reader in the console, and (P1) a document-scoped companion sidebar. Multi-device access reuses the existing remote ladder (one daemon as library server). Kin does **not** become a content cloud.

### Shape

| Layer | Role |
|-------|------|
| Files on disk | Source of truth (`.md` / `.html` / `.txt` under user data dir) |
| SQLite index | Metadata, status, source pointers, tags |
| Library UI | List / open / archive; nav peer of Tasks & Approvals |
| Reader | MD render; **sandboxed** HTML |
| Companion (P1) | Sidebar chat scoped to `artifact_id` + selection/section context |
| Wiki / Memory (later) | Optional **extract** from an artifact into governed memory—not the same object |

### Capture rules (product)

- Prefer **propose → user accept** (same language as Approvals). No silent “confirmed forever” for high-impact saves.
- Strong signals: long structured Markdown; full HTML documents; explicit user intent to export / 整理成资料.
- Manual save always available.
- Agents and tools may only create **proposed** artifacts unless the user confirms (policy can relax later for trusted paths).

### Non-goals (this ADR)

- Full LLM Wiki / graph PKM as the first UI
- Vendor-style opaque memory replacing files
- Kin-hosted multi-device sync service
- Replacing session context management (ADR 0002): Artifacts are **cold deliverables**, not the hot agent loop transcript
- Building a second Anki

### Phasing

- **P0:** model + store, capture, library, reader, source-task link, remote-readable
- **P1:** companion sidebar, artifact-scoped thread, selection actions, tags/search
- **Later:** wiki extract, annotations, optional user-driven file sync

See [TODO.md](../TODO.md) for checklist acceptance criteria.

## Consequences

- Console IA gains an **Artifacts** entry without waiting on Memory v2.
- Export / backup story must include the artifacts directory.
- HTML rendering requires a clear trust boundary (sandbox).
- Reduces pressure to overfit “memory” to “long chat files.”
- Wiki, when built, should treat Artifacts as an upstream shelf, not a parallel notes app.

## Alternatives considered

1. **Bookmarks / 收藏夹 only** — too weak; does not solve reading + continuation.
2. **Jump straight to Wiki/Memory** — higher governance cost; weaker fit for whole primers as first-class objects.
3. **Leave files only in task workspace cwd** — still multi-device and “find that HTML” painful; weak library UX.
