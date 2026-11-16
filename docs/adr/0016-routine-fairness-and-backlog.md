# ADR 0016: Routine Fairness and Backlog

- Status: Accepted
- Date: 2026-09-17

## Context

Routine definitions are user-owned automation, not a subscription quota.
However, an unbounded due scan or catch-up burst could consume every worker
slot and make interactive tasks appear stuck.

## Decision

Routine definitions remain unlimited. Listing uses cursor pagination and
search; execution uses indexed due queries, an atomic claim lease, and bounded
background concurrency. The scheduler reserves at least one worker slot for
interactive tasks. When capacity is unavailable, a due Routine remains due and
is reported through backlog health instead of being silently dropped.

Missed runs are explicit: `coalesce` runs once after downtime and advances the
schedule; `skip` records the missed run and advances without dispatching it.
Each completion records the last outcome and error.

## Consequences

- Definition count does not impose a product limit.
- Backlog is visible and recoverable.
- Interactive responsiveness has a hard scheduling guarantee.
- A future queue implementation may change the execution backend without
  changing the Routine contract.
