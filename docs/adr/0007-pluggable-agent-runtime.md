# ADR 0007: Pluggable Agent Runtime

## Status

Accepted (2026-07-17 plan; implemented as compiled plugins)

## Context

Kin historically treated itself as a special engine identity: default host, orchestration speaker, transcript clearing, API discovery, and UI whitelists all branched on the literal ID `"kin"`. Claude Code / Codex were process adapters only. Making hosts interchangeable required a plugin boundary above `adapter.Adapter`.

## Decision

1. Keep `task.Engine` as the trusted execution kernel (validation, scheduling, cancellation, permissions, events, persistence).
2. Introduce `internal/agent` with `Factory` / `Registry` / `Controller` / `SessionHooks` contracts.
3. Built-in agents (`kin`, `claude-code`, `codex`, `grok`, optional `rawpty`) register via factories in the server composition root (`internal/server/agents.go`).
4. `tasks.agent` is the **session host**. Explicit `@agent` mentions assign workers; they never silently replace the host.
5. Control-plane completion (`Controller`) is optional, read-only, and fail-closed to deterministic plan/summary fallback.
6. Plugin-private session state (e.g. Kin `kin_messages`) is reset through `SessionHooks`, not engine ID checks.
7. Adapter runtimes emit/parse canonical event payloads (`session_ref`, nested `usage`) with legacy-tolerant readers.

## Non-goals

- Hot-loading Go `.so` plugins or arbitrary third-party binaries as plugins
- Model-directed arbitrary agent spawning outside explicit `@` plans
- Cross-machine agent execution
- Lossless hot-switch of an in-flight host mid-turn

## Consequences

- Adding an agent is one factory + one composition-root registration line.
- Engine/API/UI must not grow new `switch agentID` behavior switches.
- Hosts without `orchestrate` still work; multi-agent turns use deterministic waves and summary.
