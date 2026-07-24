# ADR 0009: Generic CLI Agent Tier (Tier 2)

## Status

Accepted (2026-07-22)

## Context

Kin already ships first-class process adapters for Claude Code, Codex, and Grok (Tier 1 / 1.5), plus a presence-only skills discovery catalog (~70 agents). Many popular coding CLIs expose a headless non-interactive mode but do not justify a bespoke adapter. Users still want them listed, installable, and runnable when parameters are known.

## Decision

1. Introduce **Tier 2** agents launched by a single declarative adapter package: `internal/adapter/genericcli`.
2. Hand-maintain `detect.GenericInvocations()` (argv templates, auto-confirm flags/env, mode `json`|`text`) and `detect.InstallURL()` (homepage/install docs). Do not edit generated `skills_catalog.go` for these tables.
3. Composition root (`internal/server/agents.go`) auto-registers one factory per invocation entry; no global enable switch.
4. **Default available** when the binary is on PATH and `NeedsVerification` is false. `NeedsVerification` is the only human gate for unsmoke-tested launch lines (`qoder` / `opencode` / `pi` initially).
5. Tier 2 agents declare only `run` (optionally `resume` later). No `approvals`, `tools`, or `orchestrate`.
6. **Permission gate**: create-task rejects Tier 2 under `permission_mode=default` because there is no Kin approval channel; require `accept_edits` or `yolo` so the CLI's own auto-confirm flags/env can apply.
7. `GET /api/agents` merges registry entries with the full skills discovery catalog and `install_url`, so the UI can show four states: native / generic / verifying / not installed.

## Non-goals

- Guessing headless entrypoints for pure IDE/plugin tools (Cursor IDE body, Windsurf, Zed, Copilot, Cline, Roo, Continue, …) — remain Tier 3 presence + install link.
- Dynamic loading of arbitrary third-party binaries or plugin protocols (ADR 0007).
- Changing `rawpty` (user-typed shell commands; different semantics).

## Consequences

- Adding a Tier 2 agent is one row in `invocations.go` (+ optional install URL).
- Smoke-test failures stay offline via `NeedsVerification` until maintainers flip the flag.
- UI must not filter the catalog to runnable-only when presenting discovery; task dispatch still requires `available`.
