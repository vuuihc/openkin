# ADR 0004: Local-only integrated terminal

**Status:** Accepted
**Date:** 2026-07-17
**Related:** [SYSTEM_DESIGN.md](../../SYSTEM_DESIGN.md) · [Integrated terminal plan](../plans/2026-07-17-integrated-terminal.md)

## Context

The Electron desktop app benefits from a persistent, VS Code-style terminal for working in the current task or draft directory. A local interactive shell has fundamentally different authority and traffic characteristics from Kin tasks: it runs with the local user account's shell permissions, produces high-volume binary PTY traffic, and must survive renderer reloads without becoming task history.

Kin's normal console is intentionally reachable through the remote-access ladder. Reusing that exposure for a shell would turn possession of a Kin token into remote command execution. Reusing `internal/adapter/rawpty` would also couple an interactive terminal's lifetime to a one-shot task adapter that has no input, resize, attachment, or replay contract.

## Decision

- The integrated terminal is an Electron-desktop convenience, not a remotely accessible Kin capability. It is not rendered in the normal browser, phone, tray, LAN, Tailnet, or Funnel surfaces.
- Every terminal REST and WebSocket route requires both the existing Kin token and a real loopback TCP peer. Forwarded headers cannot grant or revoke access.
- Terminal sessions and their bounded replay buffers are ephemeral. They are excluded from SQLite, export bundles, task events, approvals, cost accounting, and audit history.
- The backend detects and owns an immutable set of shell profiles. Clients may submit only a backend-issued profile ID and never an executable path or argument list.
- A standalone terminal runtime owns PTY processes, attachment, resize, replay, exit, and cleanup. `internal/adapter/rawpty` remains a one-shot task adapter and is not reused as the session runtime.
- Starting a terminal intentionally grants the shell authority of the local user account. It is a direct desktop action, not an approval-gated Kin tool, and it does not inherit the task approval model.

## Consequences

- A valid Kin token received over LAN, Tailnet, Funnel, or another non-loopback transport still receives `403 loopback only` for terminal routes.
- Renderer reload can reattach to live in-memory sessions, while daemon shutdown destroys all PTY process groups and buffered output.
- Terminal output is deliberately absent from persistence, audit, export, and remote-console workflows.
- Profile detection and server-owned arguments prevent the browser from turning session creation into arbitrary executable selection.
- The desktop feature uses the existing HTTP/WebSocket language boundary without adding Electron IPC or a native Node PTY dependency.

## Rejected alternatives

1. **Electron `node-pty` over IPC** — adds a second terminal backend and native Node packaging path while bypassing the documented UI-to-core HTTP/WebSocket boundary.
2. **Reuse `rawpty.Adapter`** — its task-scoped, one-shot `/bin/sh -c` contract cannot safely represent interactive input, resize, replay, attachments, or independent session lifetime.
3. **Expose terminal routes through the normal authenticated API** — a token alone is insufficient protection for local-shell authority and would make remote access an unintended command-execution surface.
4. **Persist terminal transcripts** — conflicts with the intentionally ephemeral desktop convenience and would add secret exposure, retention, export, and audit obligations outside this feature's scope.
