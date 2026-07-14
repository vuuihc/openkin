# Kin System Design

[中文](./SYSTEM_DESIGN.zh.md)

**Status:** Draft v0.2 — direction, not an API contract  
**Based on:** [PRINCIPLE.md](./PRINCIPLE.md) · [中文](./PRINCIPLE.zh.md) — with one deliberate re-ordering of §12 priorities (see §2)  
**Promise:** Your agent. Your memory. Any model.

Working notes and thrashing design stay out of this repo. This file is the **public** architecture snapshot: enough to understand Kin and judge fit—not an implementation diary.

---

## 1. Overview

```text
User-owned Kin Core (local-first daemon)
  ├── Agent Adapters            ← drive external coding agents (Claude Code, Codex, any CLI)
  ├── Task Engine + Approvals   ← dispatch, monitor, confirm, audit
  ├── Provider / Cost Layer     ← usage and spend, per task and per model
  ├── Remote Access (ladder)    ← LAN → tailnet / Funnel; never a Kin cloud
  ├── Identity + Memory (v2)    ← continuous subject, governed memory
  └── Client Shells             ← desktop app + any-device web console
```

**Hard constraints** (from principles):

| Constraint | Meaning |
|------------|---------|
| User-owned | No required Kin account; export / delete / self-host |
| Local-first | Device is primary store; cloud only when explicitly enabled |
| Model-agnostic | Provider quirks must not own identity or memory |
| Progressive authority | External effects need clear permission and audit |
| Small by default | Optional layers are later, not v1 entities ([§5.11](./PRINCIPLE.md)) |

**Positioning.** Both vendors now ship remote control: Claude Code's Remote Control relays every message through Anthropic's cloud; Codex's device control syncs live state through the OpenAI account and requires its desktop app as host. Single-vendor by construction, vendor cloud in the loop. Kin is the cross-agent, self-hosted alternative: **one console for all your agents, on your own network.**

---

## 2. What ships first (MVP = the agent console)

The wedge: **dispatch, watch, and approve agent tasks from any device** — self-hosted, cross-agent, traffic never routed through an agent vendor.

**In scope for MVP**

- Kin daemon wrapping external coding agents via **adapters**: first-class Claude Code and Codex, generic PTY fallback for any CLI
- Task lifecycle: dispatch / stream progress / cancel / history
- **Approval inbox**: agent permission requests surfaced on desktop and phone, every decision audited
- Cost visibility: tokens and spend per task, per provider
- Remote access ladder (§5): LAN QR → embedded tailnet + Funnel → full tailnet
- Export; core use without any Kin account

**Explicitly later — or never**

- Governed memory + identity — the v2 story ("Kin gets to know you across agents"); semantics in §3 unchanged
- A Kin-built code agent — **never**; adapters supervise, they do not reimplement
- Native mobile app — fast-follow on the same API; web console first (App Store cycles must not gate MVP iteration)
- Kin-hosted relay — only if traction demands it; would be optional and end-to-end encrypted
- Full sync product, multi-user, long-lived routines, auto model-routing

**Note on PRINCIPLE §12.** This re-orders the MVP: the console ships before conversation/memory (§12 P1). Rationale: conversation already happens inside the agents Kin supervises; the unmet need — validated by both vendors shipping remote control — is cross-agent supervision without a vendor in the middle. PRINCIPLE §12/§13 updated to match (2026-07).

---

## 3. Core concepts (logical model)

Implementation storage may differ; the **ideas** should stay stable.

| Concept | Role |
|---------|------|
| **Task / Run** | A unit of dispatched agent work: goal, agent, status, transcript, cost |
| **Agent adapter** | How Kin drives an external agent: structured events where available (Claude Code stream-json, Codex exec), PTY otherwise |
| **Approval request** | A permission question from an agent, routed to whichever device the user is on; once / session / scoped grants |
| **Audit event** | What ran, under what authority, with redacted I/O where needed |
| **Cost record** | Tokens and spend attached to tasks and providers; local price table |
| **Provider config** | Endpoints and capability flags; secrets in OS key material, not logs |
| **Export bundle** | Versioned takeout **without** secrets |
| **Identity / Profile** *(v2)* | Structured who Kin is and how it should behave |
| **Memory** *(v2)* | Governed items with type, source, confidence, confirmation state; inference ≠ user fact |

Memory write path users should feel (v2): **save · propose · confirm/reject · edit/delete**.

Authority ladder (product language): Observe → Prepare → Confirmed action → Scoped delegation → User-defined routines.

External coding agents are **managed workers behind adapters** — Kin supervises them; it does not reimplement them, and they are not a second Kin identity.

---

## 4. Components (stable names)

| Component | Responsibility |
|-----------|----------------|
| Adapters | Drive external agents; normalize events, approvals, cost telemetry |
| Task engine | Dispatch, state machine, pause/cancel, history |
| Trust & Audit | Grants, confirmations, credentials, outbound awareness |
| Providers / Cost | Provider config, usage accounting, spend per task |
| Remote access | The ladder in §5; never a required Kin cloud |
| Console UI | One UI for desktop shell and any-device web |
| Identity *(v2)* | Preferences, boundaries, consistency across models/devices |
| Memory *(v2)* | Lifecycle of governed memory (including conflict and export) |
| Sync *(later)* | Optional; replaceable; never required for core use |

---

## 5. Remote access ladder

Networking is bought, not built. Each rung is optional; the floor works with zero accounts.

| Rung | User cost | Mechanism |
|------|-----------|-----------|
| Same LAN | Zero | Scan QR, phone opens local IP + token |
| Remote, default | One Tailscale SSO click (no app install) | Embedded tailnet node (tsnet) + Funnel public HTTPS; TLS terminates on the user's device, relay sees ciphertext |
| Remote, private | Tailscale app on phone | Pure tailnet, no public endpoint |
| Bring-your-own | Advanced | Any reverse proxy / VPN in front of the daemon |

**Vendor-account note:** the Funnel rung uses an optional Tailscale account — theirs, not ours, remote-only, and replaceable by the rungs above and below it. The no-account floor (LAN, BYO) always remains.

Public endpoints demand hard auth from day one: single-use long random token in the QR URL, session cookies, rate limiting.

---

## 6. Implementation snapshot

Current choices; may change with evidence. The one invariant: **UI talks to the core only over HTTP/WebSocket** — never in-process bindings across the language boundary.

| Layer | Choice |
|-------|--------|
| Daemon | Go, single static binary; pure-Go SQLite (no CGO); embeds the web console; tsnet built in |
| Desktop shell | Electron; daemon as supervised sidecar; tray, native notifications for approvals, auto-update |
| UI | One React + Tailwind codebase for the Electron window and the phone web console |
| API contract | OpenAPI as single source; codegen for Go handlers and TS types |
| Distribution | .dmg / .exe double-click for desktops; `curl \| sh` or brew for headless boxes |

---

## 7. Public roadmap themes

Themes, not a calendar. Details change; order of value should not.

1. **Watch** — wrap one agent, stream progress to a local console  
2. **Approve** — confirmations from desktop and phone, audited  
3. **Reach** — the remote ladder, QR onboarding  
4. **Track** — cost per task and provider  
5. **Remember** *(v2)* — profile + governed memory that travels across agents and models  
6. **Live in it** — polish until maintainers run their daily agent work through Kin

---

## 8. Open development

What we publish, and when we invite trials or contributors: [docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md).

Open core promise (with code later): daemon, adapters, task engine, trust/audit, cost accounting, console UI, import/export, local mode — **without** forcing a vendor cloud. The memory layer, when it lands, is open too: it is the part most worth being seen.

---

## 9. Summary

Kin is a **self-hosted console for your agents, growing into a personal agent core**: one place to dispatch, watch, and approve agent work across vendors — on your own network — with identity and memory that later travel across models.

> Kin should grow with the user, without owning the user.
