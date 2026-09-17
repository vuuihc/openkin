# ADR 0015: Durable Quota Wakeups

- Status: Accepted
- Date: 2026-09-17

## Context

Quota waits used to be represented mainly by task events and an in-memory
timer. That made a long reset window, a daemon restart, or an unknown provider
reset dependent on a user reopening the task.

## Decision

Persist one `task_limit_waits` row per task. The row stores the failed turn
identity (`event_epoch` and user sequence), provider metadata, reset/probe
deadlines, lifecycle state, attempts, and the last error. A wakeup must claim
the row transactionally before probing or retrying. Timers are only process
local wakeups; the persisted deadline is authoritative.

Unknown reset times use bounded exponential probing and a configurable maximum
elapsed wait. A newer user turn or event epoch supersedes an older wait.
Manual continue, switch, dismiss, and task deletion clear or terminally update
the durable row.

## Consequences

- Quota retries survive daemon and desktop restarts.
- Multiple wake paths cannot replay the same failed turn concurrently.
- The scheduler can expose retry state to Web, iOS, and future protocol clients.
- Retention and notification policy remain separate concerns from the wait row.
