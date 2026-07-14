# Kin System Design

[中文](./SYSTEM_DESIGN.zh.md)

**Status:** Draft v0.1 — direction, not an API contract  
**Based on:** [PRINCIPLE.md](./PRINCIPLE.md) · [中文](./PRINCIPLE.zh.md)  
**Promise:** Your agent. Your memory. Any model.

Working notes and thrashing design stay out of this repo. This file is the **public** architecture snapshot: enough to understand Kin and judge fit—not an implementation diary.

---

## 1. Overview

```text
User-owned Kin Core (local-first)
  ├── Identity + Memory + Policies   ← continuous subject
  ├── Runtime + Tools / Skills       ← plan and act
  ├── Provider Layer                 ← swappable models
  ├── Sync (optional, replaceable)   ← never the center
  └── Client Shells                  ← desktop first; more later
```

**Hard constraints** (from principles):

| Constraint | Meaning |
|------------|---------|
| User-owned | No required official account; export / delete / self-host |
| Local-first | Device is primary store; cloud only when explicitly enabled |
| Model-agnostic | Provider quirks must not own identity or memory |
| Progressive authority | External effects need clear permission and audit |
| Small by default | Optional layers are later, not v1 entities ([§5.11](./PRINCIPLE.md)) |

---

## 2. What ships first (MVP themes)

Not a full digital twin—a personal agent worth using every day on one machine.

**In scope for early product**

- Shared **Kin Core** + stable **desktop** client (CLI when it shares the same core)
- Multi-provider chat (streaming; at least common API shapes + a local path)
- Governed memory: propose / confirm / view / delete—not silent black-box recall
- Tools with permission prompts and a readable **Review** trail
- Open tool hook (e.g. MCP-compatible) without hard-locking the architecture to one protocol
- Import / export; core use without an official login

**Explicitly later**

- Full multi-device sync product
- Mobile as a complete second client
- Long-lived routines, auto model-routing platforms, user-facing multi-agent casts
- Homegrown networking / remote orchestration as a product center

Priority matches PRINCIPLE §12: conversation, providers, memory, tools, confirm, audit **before** cross-device theater.

---

## 3. Core concepts (logical model)

Implementation storage may differ; the **ideas** should stay stable.

| Concept | Role |
|---------|------|
| **Identity / Profile** | Structured who Kin is and how it should behave—not one unmaintainable mega-prompt |
| **Session / Message** | Conversation history; optional model/cost metadata |
| **Memory** | Governed items with type, source, confidence, confirmation state; inference ≠ user fact |
| **Task / Step** | Goals, plans, pause/resume-friendly execution state |
| **Tool invocation + Audit** | What ran, under what authority, with redacted I/O where needed |
| **Provider config** | Endpoints and capability flags; secrets in OS key material, not logs |
| **Permission grant** | Once / session / scoped duration—least privilege |
| **Export bundle** | Versioned takeout **without** secrets |

Memory write path users should feel: **save · propose · confirm/reject · edit/delete**.

Authority ladder (product language): Observe → Prepare → Confirmed action → Scoped delegation → User-defined routines.

External coding CLIs or harnesses, if used at all, are **tools**—not a second Kin identity or runtime.

---

## 4. Components (stable names)

| Component | Responsibility |
|-----------|----------------|
| Identity | Preferences, boundaries, consistency across models/devices |
| Memory | Lifecycle of governed memory (including conflict and export) |
| Runtime | Context assembly, model loop, tools, confirmation gates, traces |
| Providers | Pluggable generation/streaming/tool-calling backends |
| Tools / Skills | Atomic actions and reusable methods; risk + permission metadata |
| Trust & Audit | Grants, confirmations, credentials, outbound awareness |
| Sync | Optional; replaceable; never required for core use |
| Client shell | Desktop (then others): same Kin, native device affordances |

---

## 5. Public roadmap themes

Themes, not a calendar. Details change; order of value should not.

1. **Talk** — solid local chat, multiple providers  
2. **Remember** — profile + confirmable memory  
3. **Act** — tools, confirmation, audit/review  
4. **Leave** — export/import and clear delete story  
5. **Live in it** — polish until maintainers use it for real work  

Cross-device phases stay high-level (PRINCIPLE §13): desktop/CLI → companion clients → deeper multi-device only when single-machine Kin is excellent.

---

## 6. Open development

What we publish, and when we invite trials or contributors: [docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md).

Open core promise (with code later): runtime, providers, local memory, trust/audit, tool SDK, a basic client, import/export, local mode—**without** forcing a vendor cloud.

---

## 7. Summary

Kin is a **local-first personal agent core**: identity and memory travel across models; tools act only under legible authority; complexity grows from real use, not completeness anxiety.

> Kin should grow with the user, without owning the user.
