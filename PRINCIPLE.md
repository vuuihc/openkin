# Kin Product Principles

[中文](./PRINCIPLE.zh.md)

**Status:** Draft v0.1  
**Nature:** Open-source, local-first, cross-device, model-agnostic personal agent  
**Name:** Kin  
**Promise:**

> Your agent. Your memory. Any model.

---

## 1. Product definition

Kin is a user-owned personal agent that persists across devices.

It builds a long-term understanding of the user’s background, goals, preferences, and ways of working; discusses problems; offers advice; and—with appropriate authority—uses tools to get real work done.

Kin is not equivalent to any single large language model.

Claude, GPT, Gemini, DeepSeek, local models, and other inference services are cognition backends Kin can use for different tasks. Users can switch models without losing Kin’s memory, identity, configuration, tools, workflows, or history of the relationship.

```text
Kin
├── Identity       Who it is, and its relationship with the user
├── Memory         What it understands about the user and the past
├── Habits         Preferences and ways of working
├── Agency         What it may plan and execute
├── Tools          Systems and services it is allowed to call
├── Policies       Permission, confirmation, safety, privacy
└── Embodiments    macOS, iOS, Android, Web, CLI, …
```

The model is a replaceable “brain.”  
Clients are “bodies” on different devices.  
Tools are “hands” on the real world.  
**Memory, identity, and the user relationship** are the continuous subject.

---

## 2. Vision

Kin’s long-term goal is not a chat client with more features. It is personal intelligence infrastructure the user owns for years.

A mature Kin should:

1. Avoid forcing the user to re-explain themselves every session.  
2. Feel like the same Kin after a device change.  
3. Keep identity and long-term memory when model vendors change.  
4. Learn the user’s language, workflow, and judgment standards.  
5. Act inside clear permission boundaries—not only answer questions.  
6. Let the user inspect, correct, export, and delete personal data.  
7. Extend the user’s capability without taking control of important decisions.

Long term:

> A digital partner that knows me, can deliberate with me, can handle some affairs on my behalf, and remains under my control.

---

## 3. Problems to solve

### 3.1 Model locked to user identity

Habits, context, and long-term memory are often trapped in one vendor or client. Switching models means redoing prompts, context, memory, tools, workflows, and interaction habits.

Kin separates the personal agent’s identity from the model service.

### 3.2 Server-first, thin clients

Many agent systems center a server, gateway, or bot channel. Clients become thin shells and ignore native shortcuts, files, clipboard, share sheets, notifications, sensors, offline use, and device-specific habits.

Kin is **client-first**. Each client is a native embodiment of device capability—not just a chat window.

### 3.3 Opaque long-term memory

Products “remember the user” while hiding what is stored, why, from where, whether it is still true, conflicts, and how to edit or delete.

Kin memory must be inspectable, explainable, correctable, and portable.

### 3.4 Agency without clear authority

File, mail, calendar, browser, terminal, and account access create real-world impact. Higher autonomy is not automatically better product.

Kin aims for:

> Lowest possible friction while remaining understandable, authorizable, auditable, and revocable.

---

## 4. Target users

Kin first serves people willing to configure and own a long-lived agent:

- Developers and engineers  
- Indie builders  
- Researchers  
- Knowledge workers  
- Privacy- and sovereignty-conscious power users  
- Multi-model, multi-device users  
- People building personal automation over time  

Early Kin is **not** primarily for zero-configuration mass consumers. Some technical bar is acceptable if concepts are clear, defaults are solid, and daily use stays simple.

---

## 5. Core product principles

### 5.1 The user owns Kin

Personal data, memory, config, and workflows belong to the user—not maintainers, clouds, or model vendors.

Must support: local use, export, delete, self-host, replace sync, replace model vendors, and core function without official services.

Official cloud accounts must not be a hard dependency for core capability.

### 5.2 Local-first

The user’s device is the primary home of data—not a cache of the cloud.

Local-first does not forbid cloud. It means:

- Local is the first copy  
- Offline access to what is already on device  
- Cloud only for explicitly enabled sync, backup, or remote execution  
- Visibility into what left the device  
- Sensitive credentials not synced by default  
- Cloud components replaceable or self-hostable  

### 5.3 Model-agnostic

Core capability must not depend on one vendor’s proprietary API semantics.

Backends plug in through a unified capability surface, e.g.:

```text
Generation · Streaming · Structured Output · Tool Calling
Vision · Audio · Reasoning · Embeddings · Reranking · Context Caching
```

Provider quirks must not pollute identity, memory, or tools.

Users should set per-task models, defaults and fallbacks, OpenAI-compatible endpoints, local inference, degrade when a model fails, and see model, cost, and latency per task.

Routing may exist; it must not become mandatory complexity.

### 5.4 One Kin, many embodiments

From the user’s view, Kin is one subject—not a separate bot per device.

Device capabilities differ (macOS files/clipboard/menu bar; mobile share/voice/notifications; Web for config and audit; CLI for scripts). Identity, memory, and task state stay continuous.

### 5.5 Simplicity over feature pile-up

Internals may be complex; daily UX must not be.

Stable entrances: **Ask · Plan · Do · Remember · Review · Routine**.

Advanced concepts (many agents, workflows, skills, nodes, providers) expose gradually. Users may own a complex system without managing it every day.

### 5.6 Memory must be governable

Memory is not only chat logs or a vector DB. Distinguish at least:

```text
Profile · Episodic · Semantic · Procedural · Task · Relationship
```

Non-raw memories should carry content, source, times, confidence, scope, sensitivity, user confirmation, conflicts, and review/expiry rules.

Model inference must never be disguised as user-stated fact. Users must see why Kin believes something.

### 5.7 Judgment over sycophancy

Kin optimizes for the user’s long-term goals, not instant agreement: separate fact/inference/opinion, surface risks, disagree when warranted.

### 5.8 Progressive authority

```text
Level 0 — Observe
Level 1 — Prepare          (no external side effects)
Level 2 — Confirmed Action
Level 3 — Scoped Delegation
Level 4 — Routine Automation
```

No broad, permanent, invisible system power by default. External effects leave an audit trail.

### 5.9 Recoverability over “full auto”

Plan first, persist state, step execution, retry, pause/resume, mark external effects, undo/compensate when possible.

Assume models err, tools fail, networks drop, users change mind, devices go offline, external state drifts.

### 5.10 Observability is a product feature

A task should show goal, plan, models, tools, key I/O, confirmations, timing, cost, errors/retries, and external effects.

### 5.11 Do not multiply entities without necessity (scope discipline)

Kin aims to be **small and sharp**, not large and complete.

In an era of exploding model and agent surface area, what ships fastest is usually a product with correct daily feel—not a platform sketched in advance. Roadmaps may hold vision; **code and user-visible concepts should not grow entities without pain.**

#### Discipline

1. **Nail the main path first:** worth opening daily on one machine—accurate memory, real work, legible history.  
2. **Do not prepay distant architecture:** implement multi-device and orchestration stories when friction is real.  
3. **External executors are Tools, not a second Kin:** third-party coding agents or harnesses may be invoked; they are not a second identity or runtime.  
4. **Do not center the product on networking infrastructure** Kin does not need to own; prefer user-chosen or existing connectivity when remote access is needed later.  
5. **One fewer concept the user must learn is a win:** complexity may live inside; default UX stays short-path.  

#### Three questions before adding an entity

For every new module, daemon, sync surface, device abstraction, or product noun:

1. **Does today’s main path still work without it?**  
2. **Does it fix repeated friction, or prepay a future story?**  
3. **Must the user learn another concept for daily use?**  

If (1) is “yes” and (2) is “prepay”—default **do not add**.

#### Default: do not add yet

Fine as long-term vision; **not default v1 surface** unless real use demands it:

- Multi-device orchestration as a product center  
- Full sync stacks before single-machine excellence  
- Desktop control / computer-use as a default capability  
- User-facing multi-agent casts  
- Plugin marketplaces and routing platforms  
- Official cloud as the only path for identity, memory, or execution  

Until a capability is needed repeatedly in daily use, prefer the simpler path: the same Kin on the machine that already has the tools.

#### Small, not empty

Fewer entities must not mean a soulless chat shell. Keep these seeds—**implemented small**:

| Keep | Small form |
|------|------------|
| User ownership | Local-first; export; no required official account |
| Model portability | A few providers; no routing platform |
| Governable memory | Confirm, view, delete, source; prefer sparse over dirty |
| Legible authority | Confirm before external effects; one readable timeline |

#### One line

> Make a small Kin excellent, then let it grow. Growth is driven by use-pain, not completeness anxiety.

---

## 6. Core product components

### 6.1 Kin Identity

Stable identity: agent name, user settings, style, boundaries, long-term goals, default decision principles, consistency across devices and models.

Not one unmaintainable mega system prompt—structured config + explicit user settings + governed long-term memory.

### 6.2 Kin Memory

Extract, store, retrieve, update, merge, conflict, expire, delete, import/export.

Separate: raw records, user-stated facts, model summaries, model inferences, user-corrected conclusions.

### 6.3 Kin Runtime

Context assembly, model calls, tool calls, agent loop, plans, pause/resume/retry, human confirmation, execution traces.

Sub-agents may exist internally; the user still meets one Kin. Workers are internal, not a cast of personalities to manage.

### 6.4 Provider Layer

Pluggable providers, configurable endpoints, user-controlled API keys, local models, capability detection, timeout/retry/fallback, cost metadata. Sensitive context is not sent to every provider by default.

### 6.5 Tool and Skill Layer

**Tool:** atomic capability (read file, search mail, create event).  
**Skill:** reusable method (prep a meeting, summarize a day, tidy downloads).

Clear I/O, permission declarations, risk level, testability, versioning, logs, disable/uninstall, clear failure semantics.

Compatible with open tool protocols (e.g. MCP) without hard-wiring the whole architecture to one external protocol.

### 6.6 Sync Layer

Optional consistency for identity, config, conversations, memory, tasks, workflows, non-sensitive tool config.

Must handle offline edits, conflicts, partial sync, device revoke, E2E encryption, versions, schema upgrades, large attachments, local-only secrets.

Sync is replaceable—not the center of Kin.

### 6.7 Client Shell

Same Kin, memory, task state, permission system, provider/skill config across shells; platform differences in integration, input, background work, notifications, tools, layout, OS permissions.

### 6.8 Trust and Audit

Permissions, confirmation, credentials, sandboxing, audit, risk tiers, outbound data prompts, sensitive handling, revoke and device management.

Security is not a late bolt-on.

---

## 7. Core interaction model

Not chat-only: **Converse · Plan · Act · Review · Routine**.

Plans include steps, deps, risks, permissions, tools, open questions.  
Act names effects, tools, confirmations, outbound data.  
Review covers outcomes, failures, Kin decisions, new memories, fix/undo.  
Routines need triggers, bounds, permissions, last status, history, pause/delete.

---

## 8. Personality

No fixed, intense, unchangeable persona by default.

Default tone: clear, reliable, respectful, not overly warm, not fake-human, not cutesy, no casual over-promise; separates fact from judgment; can point at problems directly.

User-adjustable structured prefs: length, style, proactivity, risk appetite, advice style, disagreement frequency, reminders, no-go areas—not hidden in an unmaintainable prompt.

---

## 9. Privacy and safety floor

1. No private data upload without user awareness.  
2. No default use of long-term memory for model training.  
3. No plaintext secrets in logs.  
4. Credentials not exposed raw to the model.  
5. Device-level keys not synced by default.  
6. Plugins cannot bypass the unified permission system.  
7. Agents cannot hide external actions already taken.  
8. No send/pay/publish/delete without clear authority.  
9. Deletes state scope and residual backup policy clearly.  
10. Full export and exit must be possible.  

High-risk actions use deterministic policy and tool constraints—not model politeness alone.

---

## 10. Open-source principles

The open version is a real independent personal agent—not a demo shell of a commercial product.

Open core should include at least: runtime, provider interface, local memory, permission/audit, tool/skill SDK, basic client, import/export, local mode, self-host docs, plugin docs.

Prefer a permissive license suitable for ecosystem growth (e.g. Apache-2.0).

Official hosted services must not be the only source of identity, long-term memory, model access, sync protocol, plugin install, or export.

Encourage third-party clients, providers, sync backends, tools/skills, local models, and compatible implementations.

See [docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md) for what we publish and how we pace open development.

---

## 11. Non-goals (early)

Not trying to be: multi-tenant enterprise agent platform; large-scale agent cluster scheduler; a new foundation model; a full OS; a social network; avatar/VTuber platform; dependency-driven companion bot; default full device control; universal low-code SaaS replacement; a thin chat skin for one vendor.

Multi-agent tech is fine; showing many agents is not the goal.  
Cloud run is fine; cloud-hosted is not the center.  
Companionship is fine; addictive dependence is not.

---

## 12. MVP scope

Not a full digital twin—a personal agent client people want daily.

### Must-have

1. Stable desktop client  
2. Kin Core shared by client and CLI  
3. Multi-model provider interface  
4. At least: one OpenAI-compatible endpoint, Anthropic, one local entry  
5. Streaming chat and structured tool calling  
6. Local conversation and task storage  
7. Explicit, editable user profile  
8. Basic long-term memory: user save, Kin propose, confirm/reject, view/delete  
9. Tool permission and execution confirmation  
10. MCP or equivalent open tools  
11. Task execution record and audit UI  
12. Full import/export  
13. Core use without official login  

### Priority

```text
P1  Conversation · provider switch · local memory · tools · confirm · audit
P2  CLI · skills · pause/resume · cost/perf stats · basic device sync
P3  Full mobile · long-lived routines · multi-device co-execution · auto routing · sub-agents
```

First version serves the creators. Live in it before expanding.

When expanding scope, follow §5.11: deepen P1 feel before unlocking P3 map.

---

## 13. Cross-device roadmap

Platform-neutral core from day one; clients by real value.

**Phase 1 — Desktop & CLI:** core daily use—chat, local tools, provider/memory/permission models.  
**Phase 2 — Companion clients:** lighter clients for chat, status, confirmations, and capture (share/voice/media) when the desktop core is solid.  
**Phase 3 — Deeper multi-device:** only after single-machine Kin is excellent—continue work across devices under explicit authority.

---

## 14. Technical decision filter

Every major feature/architecture answers:

- **Ownership:** vendor lock-in? export/migrate? works without official servers?  
- **Continuity:** works after model change? same Kin after device change? upgrade keeps history?  
- **Simplicity:** must users understand it? hideable by defaults? harming primary UX for niche power?  
- **Explainability:** why this action? what info used? can wrong state be fixed?  
- **Safety:** worst failure? undo? least privilege? unnecessary data to the model?  
- **Openness:** third-party replaceable parts? clear specs? hidden private deps?  

Violate several → does not enter Kin Core.

---

## 15. Success criteria

Not only downloads, messages, or tokens.

- Real work, sustained use  
- Model switch without rebuilding personal context  
- Habits becoming skills/routines  
- Less re-explaining after memory  
- Declining memory correction rate over time  
- Tool success and recovery after failure  
- Users understand execution traces  
- Long-term use without official cloud  
- Community providers/tools/skills/clients  

Ultimate check:

> After a device or model change, the user still believes this is the same Kin.

---

## 16. Product voice

Restrained, clear, engineering-credible. No inflated “autonomous intelligence,” no false full automation, no “replace humans” story. Emphasize ownership, continuity, openness, real capability.

> Kin is a local-first personal agent that carries your memory, habits, and capabilities across devices and models.

Shorter: **One Kin. Every device. Any model.**

Repo blurb:

> An open-source, local-first personal agent that keeps your memory, habits, tools, and identity independent from any model provider.

---

## 17. Manifesto

Kin does not belong to a model.  
Kin does not belong to a cloud.  
Kin does not restart because the device changed.  
Kin does not form uncorrectable memory out of sight.  
Kin does not confuse more permission with more intelligence.  
Kin may know the user better over time; the user keeps interpretation, correction, and final say.

Kin’s value is not seeming human—it is being a long-term, reliable, controllable part of the user’s capability.

> Kin should grow with the user, without owning the user.
