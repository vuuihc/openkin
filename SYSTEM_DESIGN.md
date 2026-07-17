# Kin System Design

[中文](./SYSTEM_DESIGN.zh.md)

**Status:** Draft v0.3 — direction, not an API contract
**Based on:** [PRINCIPLE.md](./PRINCIPLE.md) · [中文](./PRINCIPLE.zh.md) — console-first §12; v0.3 inserts an Artifacts slice before Memory (see §2, §7)
**Promise:** Your agent. Your memory. Any model.

Exploratory drafts and implementation diaries do not live in this repo. This is a **public** architecture snapshot: enough to decide whether Kin is for you—not an internal working memo.

---

## 1. Overview

```text
User-owned Kin Core (local-first daemon)
  ├── Agent adapters            ← drive external coding agents (Claude Code, Codex, any CLI)
  ├── Task engine + approvals   ← dispatch, watch, approve, audit
  ├── Provider / cost layer     ← usage and spend per task and model
  ├── Remote access (ladder)    ← LAN → tailnet / Funnel; never a Kin cloud
  ├── Artifacts (near-term)     ← session deliverables library + reader; multi-device via same daemon
  ├── Identity + Memory (v2)    ← continuous subject, governed memory (may extract from Artifacts)
  └── Client shells             ← desktop app + any-device web console
```

**Hard constraints** (from principles):

| Constraint | Meaning |
|------------|---------|
| User-owned | No Kin account required; export / delete / self-host |
| Local-first | Device is source of truth; cloud only when explicitly enabled |
| Model-agnostic | Provider quirks do not own identity or memory |
| Progressive authority | External effects are authorizable and auditable |
| Small by default | Optional layers are later, not v1 entities ([§5.11](./PRINCIPLE.md)) |

**Positioning.** Both major vendors already ship remote control: Claude Code Remote Control relays every message through Anthropic’s cloud; Codex device control syncs via an OpenAI account and requires their desktop app on the host. Structurally: single-vendor, vendor cloud in the middle. Kin is the cross-agent, self-hosted alternative: **one console for all your agents, on your own network.**

---

## 2. What ships first (MVP = agent console)

Entry point: **dispatch, watch, and approve agent tasks from any device** — self-hosted, cross-agent, traffic never forced through an agent vendor.

**In MVP scope**

- Kin daemon **adapters** wrap external coding agents: Claude Code and Codex as first-class; generic PTY fallback for any CLI
- Task lifecycle: dispatch / streaming progress / cancel / history
- **Approval inbox**: permission requests on desktop and phone; every decision audited
- Cost transparency: tokens and spend per task and provider
- Remote access ladder (§5): LAN QR → embedded tailnet + Funnel → full tailnet
- Export; core use without any Kin account

**Near-term slice after MVP, before Memory — Artifacts**

Real pain: agents often produce topic study materials (Markdown / HTML); users manually download them, lose session linkage, and struggle to read across devices.
**Artifacts** keep **readable session deliverables** in a local library, preserve provenance to the source task, and offer a console reader; multi-device access reuses the remote ladder against **your** daemon—not a Kin content cloud.
Checklist: [docs/TODO.md](./docs/TODO.md). Decision: [docs/adr/0003-artifacts-and-reader.md](./docs/adr/0003-artifacts-and-reader.md).

- **P0** — capture (propose to save) · file truth + index · library list · MD / sandboxed HTML reader · jump to source task
- **P1** — companion sidebar (explain selection / quiz / chapter summary) · resume by `artifact_id` · tags and search

**Explicitly later — or never**

- Governed memory + identity — the v2 story (“Kin knows you across agents”); semantics in §3 stay stable; **may extract from Artifacts, but is not the same object**
- Full LLM Wiki / second-brain PKM — must not jump the queue ahead of Artifacts
- Kin-built code agent — **never**; adapters supervise, they do not reimplement
- Native mobile apps — fast follow on the same API; web console first (store review must not gate MVP iteration)
- Kin-operated relay / content cloud — relay only if traction demands it and it stays optional; **artifact sync is not a Kin cloud**
- Full sync product, multi-user, long-lived routines, automatic model routing

**Note on PRINCIPLE §12.** This design re-ordered the MVP: console before conversation/memory. Conversation already happens inside the agents Kin supervises; the unmet need—validated by both vendors shipping remote control—is cross-agent supervision without a vendor in the middle. PRINCIPLE §12/§13 were updated (2026-07).
**2026-07-17:** Insert **Artifacts** between console MVP and Remember (v2), still under §5.11: shelf + reader before memory governance.

---

## 3. Concept model (stable semantics)

Even if users only see the console first, these names keep their meaning in later versions.

| Concept | Meaning |
|---------|---------|
| **Kin** | The user-owned subject; not one model and not one chat window |
| **Task** | One goal-directed unit of agent work (dispatch, stream, approvals, result) |
| **Adapter** | Bridges an external agent CLI to unified task / event / approval APIs |
| **Approval** | A human decision before external effects; written to the audit log |
| **Cost record** | Tokens and spend on tasks and providers; local price table |
| **Provider config** | Endpoints and capabilities; secrets in the OS secret store, never in logs |
| **Artifact** (near-term) | Readable session deliverable (md/html/…); files are truth; metadata holds source task and status (`proposed|saved|archived`) |
| **Export bundle** | Versioned takeaway package (**no** secrets; **includes** artifacts tree convention) |
| **Identity / Profile** (v2) | Structured “who Kin is and how it acts” |
| **Memory** (v2) | Governed items with type, source, confidence, confirmation; inference ≠ user fact |

User-visible memory path (v2): **save · propose · confirm/reject · edit/delete**.
User-visible artifact path (near-term): **propose save · confirm/ignore · read · (P1) companion · optional extract to Memory**.

Authority ladder (product language): observe → prepare → execute after confirm → delegate within scope → user-defined routines.

External coding agents are **managed workers behind adapters** — Kin supervises them, does not reimplement them, and they are not a second Kin identity.

---

## 4. Components (stable names)

| Component | Responsibility |
|-----------|-----------------|
| Adapter layer | Drive external agents; normalize events, approval requests, cost telemetry |
| Task engine | Dispatch, state machine, pause/cancel, history |
| Trust & Audit | Grants, confirmations, credentials, egress awareness |
| Providers / cost | Provider config, usage accounting, spend per task |
| Artifacts (near-term) | Capture, index, library, reader; P1 companion threads; HTML sandbox |
| Remote access | The §5 ladder; never a mandatory Kin cloud |
| Console UI | One UI shared by desktop shell and any-device web |
| Identity (v2) | Preferences, boundaries, consistency across models/devices |
| Memory (v2) | Full lifecycle of governed memory (including conflict and export); may extract from Artifacts |
| Store / Export | Local persistence and user-owned backup (including artifacts file tree) |

User-visible main paths:

1. **Dispatch** — pick agent and working directory, submit a task
2. **Watch** — streaming progress and cost
3. **Approve** — handle confirmations from any connected device
4. **Review** — history, audit, spend
5. **Read / Artifacts** (near-term) — save session deliverables and read them; from P1, companion on the current doc
6. **Remember** (v2) — profile + governed memory that travels across agents and models

---

## 5. Remote access ladder

Goal: reach “approve and watch on another device” at **lowest user cost**, never forcing traffic through a Kin-operated cloud.

| Rung | User cost | Mechanism |
|------|-----------|-----------|
| Same LAN | Zero | QR opens LAN IP + token on the phone |
| Embedded tailnet + Funnel | One device login | tsnet in the binary; optional Funnel for a reachable URL |
| User’s own tailnet | People who already run Tailscale | Join as a node on the user’s tailnet |
| User’s own tunnel | Advanced | BYO frp / Cloudflare Tunnel / etc.; documented, not required |

**Explicitly out (unless future traction demands it, and it stays optional):** Kin-account relay, Kin-operated message bus as the only path. Vendor remote control may still exist; Kin offers the path that **does not go through that vendor**.

Multi-device reading of Artifacts uses the same ladder: **the phone opens the library on your daemon**, not a Kin-hosted drive.

---

## 6. Implementation snapshot

Current choices; may change with evidence. The one invariant: **UI talks to the core only over HTTP/WebSocket** — never in-process bindings across the language boundary.

| Layer | Choice |
|-------|--------|
| Daemon | Go, single static binary; pure-Go SQLite (no CGO); embeds the web console; tsnet built in |
| Desktop shell | Electron; daemon as supervised sidecar; tray, native notifications for approvals, auto-update |
| Local terminal | Electron main window only; ephemeral PTY sessions use token-authenticated, true-loopback-only HTTP/WebSocket routes and are never exposed through LAN, Tailnet, or Funnel |
| UI | One React + Tailwind codebase for the Electron window and the phone web console |
| API contract | OpenAPI as single source; codegen for Go handlers and TS types |
| Distribution | .dmg / .exe double-click for desktops; `curl \| sh` or brew for headless boxes |
| Artifacts truth | File tree under the user data dir + SQLite metadata index (exact paths fixed at implementation) |

---

## 7. Public roadmap themes

Themes, not a calendar. Details change; order of value should not.

1. **Watch** — wrap one agent, stream progress to a local console
2. **Approve** — confirmations from desktop and phone, audited
3. **Reach** — the remote ladder, QR onboarding
4. **Track** — cost per task and provider
5. **Artifacts** (near-term) — deliverable library + reader; P1 companion sidebar ([TODO](./docs/TODO.md) · [ADR 0003](./docs/adr/0003-artifacts-and-reader.md))
6. **Remember** *(v2)* — profile + governed memory that travels across agents and models
7. **Live in it** — polish until maintainers run their daily agent work through Kin

---

## 8. Open development

What we publish, and when we invite trials or contributors: [docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md).

Open core promise (with code later): daemon, adapters, task engine, trust/audit, cost accounting, console UI, import/export, local mode — **without** forcing a vendor cloud. Artifacts and the memory layer, when they land, are open too: the user-visible data plane is the part most worth being seen.

---

## 9. Summary

Kin is a **self-hosted console for your agents, growing into a personal agent core**: one place to dispatch, watch, and approve agent work across vendors — on your own network — with readable session deliverables kept as Artifacts you can re-open across devices, and identity and memory that later travel across models.

> Kin should grow with the user, without owning the user.
