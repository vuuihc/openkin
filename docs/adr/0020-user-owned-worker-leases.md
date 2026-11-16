# ADR 0020: User-Owned Worker Leases

## Status

Accepted

## Context

OpenKin needs optional headless workers so a task can continue after the
Desktop window closes or use another user-owned machine. The daemon already
owns task state, approvals, workspace policy, and device credentials. Adding a
hosted account or a second remote database would violate the local-first
boundary and duplicate authority.

## Decision

The first remote worker transport is an authenticated HTTP-compatible protocol.
The same versioned frames may travel over direct HTTPS or the existing outbound
Relay. A worker advertises capabilities with `hello`, receives an in-memory
lease, renews it with `heartbeat`, and must reconnect after daemon restart.

Worker registration and heartbeat use an existing paired device credential.
Each lease records its owning device ID:

- a device may register and renew only its own workers;
- the master token may list and revoke all workers;
- revoking a device immediately revokes only that device's worker leases;
- a lease crossing its TTL becomes `offline` once and emits the configured
  worker-offline notification.

The registry is intentionally process-local in this first slice. Durable task,
quota-wait, Routine, and workspace state remains in SQLite. A worker is
expected to reconnect and re-register after daemon restart; task assignment
reconciliation is required before adding durable remote execution.

## Consequences

This keeps the privacy and authority model narrow and makes device revocation
precise without rotating unrelated credentials. Worker presence is not
historical state yet, and an in-flight remote assignment cannot be recovered
from the lease registry alone. The next worker slice must add assignment
reconciliation, bounded event/artifact ingestion, and reconnect tests before
remote execution is advertised as durable.
