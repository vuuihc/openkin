# ADR 0024: Session Sync Cursor

- Status: Accepted
- Date: 2026-10-22

## Context

Multiple devices have to show the same set of sessions. Before this, every client
answered "what is there" by refetching the whole task list, and answered "what
changed" by hoping the WebSocket was still connected. A desktop that had been
asleep, or a phone that had been offline, had no way to ask what it missed: the
realtime channel carries no history, and `events.seq` restarts at 1 for each
task, so it orders one transcript and nothing else.

The design for the multi-device work (ADR 0022 and its plan) proposed a global
`hub_seq` column on tasks, allocated by the Hub as `MAX(hub_seq) + 1` in the same
transaction as the change, with no counter table: "monotonic and gap-free by
construction". That holds for writes to a task row. It does not hold for the row
disappearing.

## Decision

**One integer cursor per client, advanced only by the change feed.**
`GET /api/sessions?updated_since=<cursor>` returns the tasks whose rows changed
after that cursor, plus the ids of tasks that were deleted, merged into one
chronological order, with `next_cursor` and `has_more`. Without a cursor it
walks the history from the beginning, which is also how a client builds its first
snapshot. A client pages until `has_more` is false.

**Every write to a task row advances the cursor, not just event appends.** A
status flip, a workspace rebinding, a project attachment, a routine read flag, a
retry, or an orphan cleanup all change what a client renders. Each runs
`touchTaskHubSeq` inside its own transaction; the in-transaction event writers
share one helper instead of inserting into `events` directly. Tests that rewind
the schema exist to keep the migration honest, not to keep this list honest —
adding a write path without a touch is the failure mode to watch for.

**Deletion is part of the feed, and a tombstone floors the cursor.**
`MAX(hub_seq) + 1` over live tasks alone would rewind when the highest-numbered
task is deleted, handing its number to the next writer; every client holding that
cursor would then silently miss whatever reused it. Deleting a task writes a
`task_tombstones` row carrying the next cursor. The tombstone is both the
notification (a client cannot notice an absent row) and the floor under the
maximum. Rows are tiny and are never pruned, so a client that has been away for a
year still learns what it missed — an explicit trade of disk for the absence of a
silent gap.

**Realtime is an accelerant, never the truth.** `GET /api/events` streams the bus
as Server-Sent Events: plain HTTP, survives proxies that block upgrades,
reconnects on its own. `GET /api/sessions/wait` is the bounded long poll for
clients that cannot hold a stream. Neither advances a cursor — a client advances
only from a feed page, because a push frame carries one change and says nothing
about the ones it did not carry. The intended client order is: open the stream,
then drain the feed. A change arriving in that window is delivered twice, which
costs nothing because clients apply changes by id; the reverse order has a window
where a change is delivered by neither.

The WebSocket endpoint stays as a second accelerant for clients that already
speak it. It is not a delivery guarantee either.

## Consequences

- A client that was offline for any length of time catches up with a bounded
  number of requests, and its catch-up is testable without a network partition by
  moving the cursor by hand.
- `hub_seq` is exposed on every task JSON, so a client can tell how far behind a
  push frame leaves it and refetch the feed instead of trusting the frame.
- Tombstones accumulate forever. This is a deliberate choice for a personal
  daemon; a Hub with millions of deleted sessions would need a retention policy
  and a documented "away for longer than that" full resync.
- Tasks that predate the cursor are numbered by creation order during migration
  035, so an upgraded database still produces a complete history rather than an
  empty feed for clients that start from zero.
- The feed is unfiltered by design. A filtered feed would advance the cursor past
  changes the client never learned about, so filtering stays on
  `GET /api/tasks`, which is the browse endpoint and does not own the cursor.
