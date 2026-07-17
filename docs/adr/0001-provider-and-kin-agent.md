# ADR 0001: Cognition Provider + Kin as an agent

**Status:** Accepted (v0)  
**Date:** 2026-07-16

## Context

MVP Kin is a **console** over external coding CLIs (claude / codex / grok). That is correct for dispatch and approvals, but multi-agent orchestration and LLM-wiki memory need a **direct cognition path** (chat/completions), not only shelling out to agent CLIs.

## Decision

1. Introduce a **Provider** layer (`internal/provider`): pluggable LLM backends, first implementation **OpenAI-compatible HTTP** (`/chat/completions`). base_url may point at OpenAI, xAI, Ollama, or a reverse proxy such as cliproxyapi / LiteLLM.
2. Treat **Kin + Provider as agent id `kin`**: same task engine, events, handoff, and UI as CLI agents. It does not replace coding adapters; it is the default “brain” when configured.
3. Keep **Agent Adapters** (CLI) separate from **Providers** (API). cliproxyapi is a possible `provider.base_url`, not a special-cased codex reverse-proxy module inside Kin.
4. Secrets: `provider.api_key` in settings DB; GET returns a **masked** value; PUT ignores masked placeholders.

## Consequences

- Settings UI gains a Cognition / Provider section.
- `GET /api/agents` includes `kin` when provider is configured (base_url + model).
- Default agent preference: if `kin` is available, it is preferred over CLI agents for “chat” tasks; coding still via explicit agent or handoff.
- Follow-ups on `kin` use engine context injection (synthetic `session_id=kin:<taskId>`).
- Future: streaming, tools, embeddings, multi-provider list — without changing the agent console model.
