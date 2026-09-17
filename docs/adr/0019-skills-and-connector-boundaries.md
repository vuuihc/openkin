# ADR 0019: File-backed Skills and bounded MCP connectors

**Status:** Accepted
**Date:** 2026-09-17
**Related:** [Agent platform gap-closure plan](../plans/2026-09-17-agent-platform-gap-closure.md)

## Context

OpenKin needs reusable instructions and user-owned external tools without
turning every workflow into a new schema, marketplace, or hosted identity
system. Skills and MCP connectors have different trust boundaries:

- a Skill changes the task prompt and may contain local resources;
- a connector starts a local process or sends a request to an explicitly
  allowlisted remote domain.

Both must remain inspectable, bounded, and removable without invalidating
historical task events.

## Decision

Skills are file-backed `SKILL.md` packages discovered from bundled, user, and
project roots in that precedence order. A higher-precedence package replaces a
lower-precedence package by name. Packages are validated for manifest shape,
path containment, symlinks, world-writable files, executable declarations, and
bounded instruction size before they influence a task. Explicit local, URL, and
Git imports are supported; marketplace discovery and automatic remote
installation are out of scope.

Connectors are managed in memory by a bounded host and use either:

- one-shot MCP JSON-RPC over a local stdio process; or
- HTTPS Streamable HTTP with an explicit remote-domain allowlist.

Connector credentials are referenced by opaque secret-store identifiers and are
never put into task prompts or audit payloads. Tool calls fail closed unless
the connector and tool are enabled. Timeouts, cancellation, output limits, and
disabled connectors are enforced at the host boundary.

Every call records the connector, tool, principal, task, SHA-256 argument hash,
allowlist decision, result status, latency, and sanitized error. When a task is
available, the audit record is appended as a `connector_call` task event,
reusing the existing event stream instead of adding a connector table.

## Consequences

Installing or removing a Skill changes only future task context and does not
rewrite historical events. Connector configuration can be revoked immediately,
but connector definitions are not yet a marketplace or a broad bespoke
integration layer. OAuth flows and reference connector presets remain follow-up
work; token storage and transport boundaries are in place for that extension.
