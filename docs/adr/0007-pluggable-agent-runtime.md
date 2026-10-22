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

## Follow-up

Tier 2 generic CLI agents (`internal/adapter/genericcli`, ADR 0009) register through the same factory composition root without engine ID switches. Presence-only catalog entries remain non-runnable until an invocation row exists and passes smoke tests.

## Amendments

- **Cross-machine agent execution** is no longer a non-goal: ADR 0022 makes it the architecture (a Hub owns sessions, any device runs the turn with its own agent). The reasoning above is left as written.
- **Protocol agents** are a fourth access path alongside the built-ins, tier 2, and the Kin runtime: `internal/adapter/acp` registers one *client* for the Agent Client Protocol, and which agent it drives is the machine's own choice (`KIN_ACP_BIN`). It registers through the same composition root; the per-agent policy that used to be implied by an agent id (permission ceiling) is asked of the adapter instead.

