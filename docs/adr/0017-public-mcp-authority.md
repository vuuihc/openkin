# ADR 0017: Public MCP Authority Model

- Status: Accepted
- Date: 2026-09-17

## Context

OpenKin already has an internal stdio MCP bridge for managed workers. That
bridge is task-scoped and exists to carry approvals and workspace lifecycle
requests. It is not a general control-plane API for external hosts.

## Decision

Public MCP is a protocol adapter over OpenKin application services. It does not
duplicate HTTP handler policy and it never returns the daemon master token to a
model. Every request has an authenticated principal, client identity, and
explicit scope:

- `read` exposes bounded task, event, project, artifact, Routine, usage, and
  routing reads;
- `write` adds task creation and task control, subject to normal workspace and
  permission policy;
- `admin` is required for approvals, settings, provider changes, and other
  authority-expanding operations.

Local stdio may bootstrap from a user-authorized local credential, but the MCP
tool surface still enforces the configured scope. Streamable HTTP uses the
daemon authentication boundary and device credentials are never promoted to
master authority. All mutating calls use idempotency keys where retries could
duplicate work and append an audit event or task event.

## Consequences

- REST and MCP share task/approval semantics and error categories.
- A read-only remote client cannot mutate tasks or settings.
- The internal `approve-mcp` bridge remains backward compatible and separate.
- Public MCP can later support external Claude, Codex, and Droid hosts without
  introducing a second task authority.
