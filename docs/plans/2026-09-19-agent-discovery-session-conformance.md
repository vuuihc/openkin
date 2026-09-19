# Agent Discovery and Session Conformance

**Status:** M10 complete
**Date:** 2026-09-19
**Related:** [Local Agent Session Hub](./2026-09-17-local-agent-session-hub.md), [Agent Platform Gap-Closure Plan](./2026-09-17-agent-platform-gap-closure.md)

## 1. Goal

Make local Agent support predictable and inspectable:

- Kin detects installed local Agents and their actual capabilities;
- each Agent has an explicit discovery/session adapter instead of ad hoc
  parser branches;
- provider history is normalized into readable conversation and tool events;
- the UI exposes which Agents are detected, importable, resumable, or
  unsupported;
- unsupported products remain visible as presence-only integrations rather
  than appearing to have fake session support.

The first target set is Codex, Claude Code, Droid, Trae, WorkBuddy, Doubao,
and Zcode. Kin remains local-first and does not copy provider transcripts into
Kin storage.

## 2. Current Findings

### 2.1 Existing implementation

- `internal/adapter/detect` has a runnable Agent catalog and a broader
  skills-ecosystem presence catalog, but it does not describe session
  capabilities or source health.
- Codex and Claude Code have file-backed JSONL catalogs.
- The normalized history now emits semantic `message`, `tool_call`,
  `tool_result`, and `reasoning` items for Codex and Claude Code. Tool
  summaries are bounded and redacted before they reach the UI.
- The detail page now groups adjacent message fragments, uses conversational
  user/assistant layout, and renders tool activity and reasoning as collapsed
  disclosures. Markdown/code rendering and richer turn grouping remain
  follow-up work.
- Droid is runnable through a JSON-RPC adapter and now has a bounded
  `~/.factory/sessions` metadata/history catalog. Native resume remains on the
  existing JSON-RPC `load_session` adapter.
- Trae, WorkBuddy, Doubao, and Zcode do not yet have a confirmed stable local
  session protocol or adapter in this repository.

### 2.2 Explicit non-goals

- Do not scrape arbitrary provider directories without a format contract.
- Do not treat screenshots or GUI automation as native session history.
- Do not persist provider prompts, model output, tool payloads, reasoning, or
  screenshots in Kin's durable session index.
- Do not claim that a detected binary implies list/history/resume support.

## 3. Target Architecture

### 3.1 Provider manifest

Add one declarative manifest per integration:

```go
type AgentProviderManifest struct {
    ID              string
    DisplayName     string
    BinaryCandidates []string
    HomeRoots       []string
    ConfigRoots     []string
    Capabilities    []Capability
    Detector        Detector
    SessionCatalog  SessionCatalog
    ResumeAdapter   ResumeAdapter
}
```

`Capabilities` are observed results, not promises. Use separate states:

- `not_detected`
- `detected`
- `available`
- `unsupported`
- `degraded`
- `permission_required`

### 3.2 Detection contract

Detection is bounded and read-only:

```go
type Detector interface {
    Detect(context.Context) (DetectionResult, error)
}
```

The result records binary path/version, config presence, session-store
presence, last scan time, source health, and capability evidence. Detection
must never execute a provider task or read secrets.

### 3.3 Session adapter contract

Split session support into independent operations:

```go
type SessionAdapter interface {
    List(context.Context, SessionQuery) (SessionPage, error)
    Inspect(context.Context, string) (SessionInfo, error)
    ReadEvents(context.Context, string, HistoryQuery) (EventPage, error)
    Resume(context.Context, string, ResumeRequest) (ResumeHandle, error)
}
```

`ReadEvents` returns bounded semantic events rather than only text:

```go
type SessionEvent struct {
    ID         string
    Kind       string // user, assistant, tool_call, tool_result, reasoning, system
    Role       string
    Text       string
    ToolName   string
    DataDigest string
    OccurredAt time.Time
    SourceRev  string
}
```

Large tool input/output is represented by a bounded summary and digest. The
detail UI may request a transient provider page for an expanded view, but the
raw payload is never inserted into `agent_sessions`.

## 4. Provider Matrix

### 4.1 Codex

Current evidence: `~/.codex/sessions` and `~/.codex/archived_sessions` contain
JSONL session files. The format contains `session_meta`, `message`,
`reasoning`, `function_call`, and `function_call_output` records.

Delivery:

1. replace text-only parsing with semantic event parsing;
2. retain tool call/result summaries as collapsible events;
3. group events into user-turn and assistant-turn sections;
4. preserve source cursor and revision;
5. test current and archived session fixtures;
6. verify native resume against the installed CLI before marking `resume`
   available.

### 4.2 Claude Code

Current evidence: `~/.claude/projects` contains project-scoped JSONL files.

Delivery:

1. parse user/assistant messages and content blocks;
2. normalize tool use/result blocks;
3. keep system and hook records out of the default conversation while
   exposing a bounded diagnostics disclosure;
4. validate project path mapping and native resume;
5. add golden fixtures for tool use, attachments, compaction, and subagents.

### 4.3 Droid

Droid is already a runnable JSON-RPC Agent, but session discovery/history is
not implemented. The first implementation must establish the local contract
from the installed CLI/IPC or documented JSON-RPC method, with a fixture-based
fake server.

Delivery:

1. probe supported session list/inspect/history/resume methods;
2. use `~/.factory` only for documented metadata/index signals;
3. never treat tool-output artifacts as a transcript source;
4. add reconnect, stale-session, and protocol-version tests;
5. expose `unsupported` with evidence when the installed version lacks a
   session method.

### 4.4 Trae, WorkBuddy, Doubao, and Zcode

No stable local session contract is currently confirmed in this repository.
Each integration gets a presence detector first:

- binary/app/config detection;
- version and installation source;
- documented local endpoint or IPC availability;
- explicit capability state.

Only after a provider exposes a stable local protocol or a reviewed file
format do we add a session adapter. If the only option is GUI automation,
mark it `non_native` and defer it to the separate macOS Computer Use track.

## 5. Management UI

Add `Settings -> Local Agents` as an actual management surface, not only a
preference block:

- provider rows with detected/available/unsupported/degraded state;
- binary/version and source roots;
- capability badges: detect, list, history, attach, resume;
- last scan and source revision;
- `Refresh` per provider;
- `Import` per provider and `Import all supported`;
- an explicit unsupported reason and next action;
- link to the unified session library.

The sidebar import menu remains a shortcut, but it must be backed by the same
provider state and never show an Agent as importable unless `session_list` is
available.

## 6. Readable Session Rendering

The detail page becomes an event renderer:

- user messages: right-aligned conversational bubbles;
- assistant messages: left-aligned readable blocks with Markdown/code
  rendering;
- tool calls/results: compact collapsible rows with tool name, status, and
  bounded output preview;
- reasoning/system events: collapsed by default and explicitly labeled;
- repeated adjacent events from one turn are grouped;
- raw JSON is never the default display;
- source provider, stale state, and native resume status remain visible.

Rendering is provider-neutral after normalization. Provider adapters own only
format parsing and source reads.

## 7. Delivery Slices

### M10.1 — Conformance types and provider management

- add provider manifest, detector result, capability-state, and event types;
- expose `/api/agent-providers` with refresh and capability evidence;
- refactor existing `detect` output to use the same source of truth;
- build the Settings management table;
- add tests for installed, missing, permission-required, and unsupported
  providers.

### M10.2 — Readable event model

- [x] extend history API from text-only items to semantic events;
- [x] implement Codex event parser and readable detail renderer;
- [x] implement Claude event parser and renderer;
- [x] preserve metadata-only storage;
- [x] add provider fixtures and browser interaction coverage.

### M10.3 — Droid session conformance

- [x] establish and test the Droid local session protocol;
- [x] add list/inspect/history catalog and retain native resume adapter;
- [x] wire provider health and explicit capability evidence;
- [x] add metadata, stale cursor, native resume, and reconnect coverage.

### M10.4 — External provider probes

- [x] add presence-only detectors for Trae, Trae CN, WorkBuddy, Doubao, and Zcode;
- [x] record binary/config evidence without claiming session support;
- [x] keep adapters limited to providers with a confirmed local protocol;
- [x] document each unsupported state and its reason.

### M10.5 — Handoff and cross-provider verification

- [x] run Claude Code/Codex/Droid catalog fixtures;
- [x] verify binding history, provider namespace, workspace attribution, and
  source revision behavior;
- [x] add a provider catalog conformance harness for new file-backed adapters.

### M10.6 — Optional non-native fallback

The product keeps GUI automation separate from native session history. The
desktop acceptance pass uses the scoped browser worker/Computer Use surface
only to validate Kin's management workflow; it does not import screenshots or
GUI transcripts.

- [x] keep browser/Computer Use actions behind the existing task-scoped worker;
- [x] preserve approval and evidence boundaries for browser actions;
- [x] complete the desktop user-story acceptance pass.

## 8. Acceptance Criteria

1. The management page explains exactly which Agents are detected and which
   session operations are supported.
2. Codex history renders as readable turns with tool activity, not a flat list
   of raw assistant fragments.
3. Claude Code history renders user, assistant, and tool events without
   copying transcripts into Kin storage.
4. Droid is either session-capable through a tested local protocol or visibly
   marked unsupported with evidence.
5. Trae, WorkBuddy, Doubao, and Zcode are visible as presence-only or
   unsupported integrations until their protocols are confirmed.
6. `Import all supported` is equivalent to importing the individually
   supported providers and reports per-provider results.
7. Provider discovery failures do not clear previously indexed sessions or
   take down the task console.
8. No provider secret, unbounded transcript, raw tool payload, or screenshot
   enters the durable session catalog.
9. Go tests, fixture/golden tests, UI tests/build, OpenAPI drift, review, and
   desktop rebuild pass.

## 9. Manual Walkthrough

1. Open `Settings -> Local Agents`.
2. Confirm the table distinguishes detected Agents from session-capable
   Agents.
3. Refresh Codex and import only Codex.
4. Open a Codex session and verify user/assistant/tool grouping.
5. Refresh Claude Code and compare its tool events.
6. Inspect Droid's protocol status; verify unsupported is explicit if the
   installed version lacks session methods.
7. Inspect Trae/WorkBuddy/Doubao/Zcode presence rows and their evidence.
8. Import all supported providers and verify per-provider counts.
9. Switch Project/Agent grouping and collapse nodes; reload Kin and confirm
   disclosure state persists.
