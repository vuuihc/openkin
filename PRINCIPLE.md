# OpenKin Product Principles

[中文](./PRINCIPLE.zh.md)

**Status:** Draft v0.1
**Nature:** Open-source, self-hosted, cross-device, model-agnostic multi-agent console
**Project / brand:** OpenKin
**Product subject:** Kin (the continuous local agent you own)
**CLI:** `kin` (alias: `ok`)
**Promise:**

> Your agents. Your machines. Any device.

**Positioning (short):** a multi-agent console you host yourself — dispatch, watch, and approve agents across your machines, from any device.

> Not the same product as Kin / mykin.ai (commercial personal-AI companion for iOS/Android). OpenKin is an independent open-source project.

---

## 1. Product definition

Kin is a user-owned agent console. It runs coding and research agents on machines the user controls, and gives the user one place to dispatch them, watch them, and approve what they propose to do—from any device they sign in on.

Kin is not itself a model. Claude, GPT, Gemini, DeepSeek, local models, and other inference services are backends the agents it supervises can call.

```text
Kin
├── Sessions     What was asked, what the agent did, what was decided
├── Agency       What agents may plan and execute
├── Tools        Systems and services they are allowed to call
├── Policies     Permission, confirmation, safety, privacy
└── Embodiments  macOS, iOS, Android, Web, CLI, …
```

The model is a replaceable “brain.”
Clients are “bodies” on different devices.
Tools are “hands” on the real world.
**Sessions and the audit trail** are the continuous subject.

---

## 2. Vision

Kin runs agents on machines the user owns, and lets the user drive them from
whatever device is in their hand. The user owns the runtime, the data, and the
credentials; nothing has to pass through a vendor.

A Kin that is working should:

1. Show what an agent is doing while it does it, on the device you are holding.
2. Let you approve or stop it from that device, and record that you did.
3. Survive a device change: the same sessions, on the next screen.
4. Act inside clear permission boundaries—not only answer questions.
5. Let the user inspect, correct, export, and delete their own data.

That is the whole of it. Kin is not trying to become a companion, a memory, or
a second self; the ambitions that used to live in this section were the reason
the project stalled, and they are recorded as non-goals in §11 instead.

---

## 3. Problems to solve

### 3.1 Model locked to user identity

Working setup—prompts, tool wiring, session history, habits—gets trapped in one vendor’s client. Switching models means rebuilding all of it.

Kin keeps sessions and configuration in the user’s own storage, so changing the model behind them is a swap, not a migration.

### 3.2 Server-first, thin clients

Many agent systems center a server, gateway, or bot channel. Clients become thin shells and ignore native shortcuts, files, clipboard, share sheets, notifications, sensors, offline use, and device-specific habits.

Kin is **client-first**. Each client is a native embodiment of device capability—not just a chat window.

### 3.3 Agency without clear authority

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

Personal data, config, and workflows belong to the user—not maintainers, clouds, or model vendors.

Must support: local use, export, delete, self-host, replace sync, replace model vendors, and core function without official services.

Official cloud accounts must not be a hard dependency for core capability.

### 5.2 Self-hosted, no vendor in the path

Kin’s data lives on machines the user controls. That may be one laptop running standalone—the default—or a Hub the user runs on their own server and reaches at their own domain. Both are the user’s; neither is ours.

What this forbids:

- An OpenKin-operated service being required for core capability
- Data passing through infrastructure the user does not control
- Credentials leaving the machine that holds them

What it does not forbid:

- A Hub that stays on, so devices keep the same sessions without a laptop awake
- Cloud model providers—those are backends the agents call, not the datastore
- Remote execution on a machine the user owns

Standalone remains the default for a user who never configures a Hub, and offline
use of what is already on the device keeps working. But “local is always the first
copy” is not a rule Kin holds itself to once the user has put a Hub in the picture.

### 5.3 Model-agnostic

Core capability must not depend on one vendor’s proprietary API semantics.

Backends plug in through a unified capability surface, e.g.:

```text
Generation · Streaming · Structured Output · Tool Calling
Vision · Audio · Reasoning · Embeddings · Reranking · Context Caching
```

Provider quirks must not pollute sessions, configuration, or tools.

Users should set per-task models, defaults and fallbacks, OpenAI-compatible endpoints, local inference, degrade when a model fails, and see model, cost, and latency per task.

Routing may exist; it must not become mandatory complexity.

### 5.4 One Kin, many embodiments

From the user’s view, Kin is one subject—not a separate bot per device.

Device capabilities differ (macOS files/clipboard/menu bar; mobile share/voice/notifications; Web for config and audit; CLI for scripts). Sessions and task state stay continuous.

### 5.5 Simplicity over feature pile-up

Internals may be complex; daily UX must not be.

Stable entrances: **Ask · Plan · Do · Read/Artifacts · Review · Routine**.

**Artifacts** cover readable session deliverables (study primers, HTML notes, long-form outputs)—capture, library, reader, provenance.

Advanced concepts (many agents, workflows, skills, nodes, providers) expose gradually. Users may own a complex system without managing it every day.

**Prefer simple implementations too.** Application-level behaviors (session wrap-up, cover write-back, coaching nudges) should start as reviewable prompts / in-conversation flows—not as hard-coded APIs, tables, state machines, and dedicated UI entities. Reserve hard-coded paths for: permission and safety boundaries, durable sources of truth, stream/task protocols, and contracts a prompt cannot reliably guarantee.

Counter-example: a dedicated recycle table + REST + review card for “write wrap-up into the One-Pager” is heavier, harder to understand, and harder to maintain than asking Kin in the chat to update the cover.

### 5.6 Label what Kin inferred

Kin states things the user told it, things it read, and things it concluded — and
does not blur them. A summary, a suggestion, or a "you usually prefer X" is
marked as Kin's reading, never dressed up as the user's own words or as fact.

This is the whole of the old memory-governance principle that survives: Kin does
not keep a memory subsystem, but it still owes the user provenance on anything it
says on the user's behalf.

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

1. **Nail the main path first:** worth opening daily on one machine—real work, legible history.
2. **Do not prepay distant architecture:** implement multi-device and orchestration stories when friction is real.
   *Condition met 2026-10-22:* friction is real — users already switch between daemons and lose conversation continuity on every switch. ADR 0022 is the response. The rule itself stands; for this one item it now reads "implement", not "defer".
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

- ~~Multi-device orchestration as a product center~~ — **withdrawn 2026-10-22 by [ADR 0022](./docs/adr/0022-hub-node-multi-device-sessions.md)**
- ~~Full sync stacks before single-machine excellence~~ — **withdrawn 2026-10-22 by ADR 0022.** The item's own ordering condition was "before single-machine excellence"; that work came first, so the objection no longer applies rather than being overruled
- Desktop control / computer-use as a default capability
- User-facing multi-agent casts
- Plugin marketplaces and routing platforms
- Official cloud as the only path for sessions, execution, or identity

Until a capability is needed repeatedly in daily use, prefer the simpler path: the same Kin on the machine that already has the tools.

#### What the 2026-10-22 withdrawals do and do not change

Two list items were withdrawn because their stated condition was met, not because
scope discipline stopped mattering. Everything else in §5.11 remains in force, and
the multi-device design was in fact built *with* it:

- The three questions above were run and passed — the design adds no new session
  entity (Task remains the session), standalone mode stays the default, and a user
  who changes nothing learns no new concept.
- §5.1 (the user owns Kin, not OpenKin) and §9 (privacy floor) are load-bearing for
  the new design, not casualties of it: they are why the Hub is self-hosted with no
  vendor in the path, and why secrets never leave a device.
- Item 3 below ("external executors are Tools, not a second Kin") is what keeps ACP
  an adapter family rather than a second runtime.

Treat this as **narrow, cited withdrawal**, not a general relaxation. A future
proposal that needs §5.11 relaxed again must cite its own ADR.

#### Small, not empty

Fewer entities must not mean a soulless chat shell. Keep these seeds—**implemented small**:

| Keep | Small form |
|------|------------|
| User ownership | Self-hosted; export; no required OpenKin account |
| Model portability | A few providers; no routing platform |
| Legible authority | Confirm before external effects; one readable timeline |

#### One line

> Make a small Kin excellent, then let it grow. Growth is driven by use-pain, not completeness anxiety.

---

## 6. Core product components

### 6.1 Kin Artifacts (session deliverables)

Artifacts are **readable deliverables** produced in agent sessions (topic study Markdown, HTML primers, long write-ups)—not vector memory and not a bookmark drawer.

Responsibilities: capture or user-save from sessions; file-backed truth plus searchable index; provenance to source task/session; library + reader in the console; later, document-scoped companion reading.

Constraints: propose/confirm for high-impact saves; sandbox untrusted HTML; multi-device through the user's own Hub, not a vendor content cloud; included in export/leave.

Checklist: [docs/TODO.md](./docs/TODO.md). Decision: [docs/adr/0003-artifacts-and-reader.md](./docs/adr/0003-artifacts-and-reader.md).

### 6.2 Kin Runtime

Context assembly, model calls, tool calls, agent loop, plans, pause/resume/retry, human confirmation, execution traces.

Sub-agents may exist internally; the user still meets one Kin. Workers are internal, not a cast of personalities to manage.

### 6.3 Provider Layer

Pluggable providers, configurable endpoints, user-controlled API keys, local models, capability detection, timeout/retry/fallback, cost metadata. Sensitive context is not sent to every provider by default.

### 6.4 Tool and Skill Layer

**Tool:** atomic capability (read file, search mail, create event).
**Skill:** reusable method (prep a meeting, summarize a day, tidy downloads).

Clear I/O, permission declarations, risk level, testability, versioning, logs, disable/uninstall, clear failure semantics.

Compatible with open tool protocols (e.g. MCP) without hard-wiring the whole architecture to one external protocol.

### 6.5 Sync Layer

The Hub holds an account's sessions. Any device the user signs in on — phone, laptop, console — reads the same sessions from it, and can aim an agent running on a Node it can reach.

The model is deliberately narrow:

- **Sessions are append-only streams.** One writer (the Node running the agent), one order, assigned by the Hub. Readers replay from a cursor. There is no merge step and no CRDT, because two writers never edit the same session.
- **Offline writes queue locally.** A message composed while disconnected shows immediately and is sent on reconnect; the Hub assigns its position on arrival. Order is by arrival, not by device clock.
- **Secrets never sync.** Provider API keys, agent OAuth tokens, and `~/.kin/secrets/` stay on the machine that holds them. The Hub stores capability metadata, not credentials.
- **Revoking a device is immediate** and needs no cooperation from that device.

That is the whole commitment. End-to-end encryption and conflict resolution are **not** promised anywhere in Kin; see [ADR 0022](./docs/adr/0022-hub-node-multi-device-sessions.md). Do not describe Kin as providing them until they exist.

### 6.6 Client Shell

Same Kin, session state, permission system, provider/skill config across shells; platform differences in integration, input, background work, notifications, tools, layout, OS permissions.

### 6.7 Trust and Audit

Permissions, confirmation, credentials, sandboxing, audit, risk tiers, outbound data prompts, sensitive handling, revoke and device management.

Security is not a late bolt-on.

---

## 7. Core interaction model

Not chat-only: **Converse · Plan · Act · Review · Routine**.

Plans include steps, deps, risks, permissions, tools, open questions.
Act names effects, tools, confirmations, outbound data.
Review covers outcomes, failures, Kin decisions, fix/undo.
Routines need triggers, bounds, permissions, last status, history, pause/delete.

---

## 8. Personality

No fixed, intense, unchangeable persona by default.

Default tone: clear, reliable, respectful, not overly warm, not fake-human, not cutesy, no casual over-promise; separates fact from judgment; can point at problems directly.

User-adjustable structured prefs: length, style, proactivity, risk appetite, advice style, disagreement frequency, reminders, no-go areas—not hidden in an unmaintainable prompt.

---

## 9. Privacy and safety floor

1. No private data upload without user awareness.
2. No use of session content, prompts, or user data for model training by default.
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

Open core should include at least: runtime, provider interface, permission/audit, tool/skill SDK, basic client, import/export, local mode, self-host docs, plugin docs.

Prefer a permissive license suitable for ecosystem growth (e.g. Apache-2.0).

Official hosted services must not be the only source of identity, model access, sync protocol, plugin install, or export. A user must be able to run the Hub themselves.

Encourage third-party clients, providers, tools/skills, local models, and compatible implementations.

See [docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md) for what we publish and how we pace open development.

---

## 11. Non-goals (early)

Not trying to be: multi-tenant enterprise agent platform; large-scale agent cluster scheduler; a new foundation model; a full OS; a social network; avatar/VTuber platform; dependency-driven companion bot; default full device control; universal low-code SaaS replacement; a thin chat skin for one vendor.

Multi-agent tech is fine; showing many agents is not the goal.
Cloud run is fine; cloud-hosted is not the center.
Companionship is fine; addictive dependence is not.

### Retired 2026-10-23

Earlier revisions of this document described a Kin that accumulates long-term
memory, a persistent "Kin Identity" that survives model changes, and a
continuous-learning loop that makes Kin better the more it is used. Those were a
second product sitting on top of this one, and they are what stalled the project.

They are **not** on the roadmap. They are not "v2". They are not a reason to shape
today's schema, storage, or API. If Kin ever needs them, they come back as a
proposal that cites its own ADR—not as a debt the current reader is assumed to owe.

---

## 12. MVP scope

The MVP is the **agent console**: dispatch, watch, and approve external agent tasks from any device—self-hosted, cross-agent, no vendor relay. Not a full digital twin—the first slice worth using every day.

### Must-have

1. Kin daemon (Core) shared by desktop shell and CLI
2. Agent adapters: Claude Code and Codex first-class; generic PTY fallback for any CLI
3. Task lifecycle: dispatch, streaming progress, cancel, history
4. Approval inbox on desktop and phone; every decision audited
5. Cost visibility: tokens and spend per task and provider
6. Remote access ladder: LAN -> embedded tailnet / Funnel -> full tailnet; never an OpenKin-operated relay
7. Local task storage; full import/export
8. Stable desktop client (shell) + any-device web console
9. One account on a Hub the user runs: sign in on a second device and see the same sessions
10. Core use with no OpenKin-operated account—standalone, or a self-hosted Hub

### Priority

```text
P1  Adapters | dispatch | watch | approve | audit | LAN access
P2  Remote ladder | cost stats | push notifications | more adapters | CLI polish
P2b Artifacts library P0 (capture, local store, reader, source-task link)
    Artifacts companion P1 (sidebar, doc-scoped thread, tags/search)
    (see docs/TODO.md · ADR 0003)
P3  Native mobile app | long-lived routines | auto routing | sub-agents
```

First version serves the creators. Live in it before expanding.

When expanding scope, follow §5.11: deepen P1 feel before unlocking the P3 map.

*Revised 2026-07: the console ships before conversation. Conversation already happens inside the agents Kin supervises; the unmet need is cross-agent supervision without a vendor in the middle.*
*Revised 2026-07-17: explicit near-term Artifacts theme (library + reader) between console polish and later work.*
*Revised 2026-10-23: multi-device became P1, not a v2 theme—an account on the user's own Hub, with sessions following them across devices. The governed-memory and profile items were removed from P3; see §11.*

---

## 13. Cross-device roadmap

Platform-neutral core from day one; clients by real value.

**Phase 1 — Desktop daemon + console:** wrap agents; watch and approve locally and on the LAN.
**Phase 2 — Remote reach:** a Hub the user runs, reached at their own domain. Sign in once and the same sessions are on every device; the access ladder (tailnet / Funnel) remains for reaching Nodes directly.
**Phase 3 — Native companion:** a native mobile client on the same API, and remote control of the machines you left running.

---

## 14. Technical decision filter

Every major feature/architecture answers:

- **Ownership:** vendor lock-in? export/migrate? works without official servers?
- **Continuity:** works after model change? same sessions after device change? upgrade keeps history?
- **Simplicity:** must users understand it? hideable by defaults? harming primary UX for niche power? can a prompt / existing agent loop express it without a new hard-coded product entity (API, table, state machine)?
- **Explainability:** why this action? what info used? can wrong state be fixed?
- **Safety:** worst failure? undo? least privilege? unnecessary data to the model?
- **Openness:** third-party replaceable parts? clear specs? hidden private deps?

Violate several → does not enter Kin Core.

**Undecided? Go read a working implementation first.** When a question is genuinely open—how sessions should sync, what happens on an offline write, whether a step needs pairing or a plain login—look at how **Lody** does it before inventing an answer. Lody is the closest working reference for this product shape: multi-machine agent sessions, remote control from a phone, local-first writes. Matching it is the default; diverging needs a stated reason, not a preference.

This is a tie-breaker, not an authority. Lody is not a spec, its choices are not all good, and nothing here overrides §5.2 (no vendor in the path) or §9 (privacy floor). It answers "what would a working version of this look like", not "what must Kin do".

---

## 15. Success criteria

Not only downloads, messages, or tokens.

- Real work, sustained use
- A second device shows the same sessions, with nothing re-explained and nothing exported
- Model switch without losing the thread
- Habits becoming skills/routines
- Study materials / long-form agent outputs stay out of the Downloads folder, remain readable multi-device, and keep a link to the source session
- Tool success and recovery after failure
- Users understand execution traces
- Long-term use without an OpenKin-operated cloud
- Community providers/tools/skills/clients

Ultimate check:

> After a device change, the user's work is simply there—no migration, no re-setup, no re-explaining.

---

## 16. Product voice

Restrained, clear, engineering-credible. No inflated “autonomous intelligence,” no false full automation, no “replace humans” story. Emphasize ownership, continuity, openness, real capability.

> OpenKin is a multi-agent console you host yourself: dispatch, watch, and approve agents across your machines, from whatever device you are holding.

Shorter: **One Kin. Every device. Any model.**

Repo blurb:

> OpenKin — open-source, self-hosted multi-agent console. CLI: `kin` (alias: `ok`). Your machines, your data, your providers; no vendor in the path. Not the same product as mykin.ai (commercial Kin personal-AI app).

---

## 17. Manifesto

Kin does not belong to a model.
Kin does not belong to a cloud.
Kin does not restart because the device changed.
Kin does not claim credit it did not earn, or state as fact what it only inferred.
Kin does not confuse more permission with more intelligence.
Kin runs where the user puts it, and answers to the user who put it there.

Kin’s value is not seeming human—it is being a reliable, legible, controllable part of the user’s capability.

> Kin should grow with the user, without owning the user.
