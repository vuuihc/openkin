# STATUS (seed — live copy is rsi/state/STATUS.md; keep ≤ 80 lines, last 48h of facts)

Updated: (seed)  Mode: running  NO_MERGE: no

This tracked file is the **template** the loop copies to `rsi/state/STATUS.md` on a
fresh install (`rsi/runtime/run.sh`). It is not the live queue: do not add queue rows
here.

## Current state

Facts with the command that proves each (checked 2026-11-19):

- Astryx programme complete: `python3 rsi/runtime/slices.py status` prints
  `Astryx programme: 62/62 slices merged`.
- No slice is dispatchable: `python3 rsi/runtime/slices.py ready --local` prints
  `(no ready Astryx slice)`.
- The live queue is `rsi/state/STATUS.md` (gitignored; written by the fill pulse, the daily regroom and dream — write it atomically).
- Phases live in `rsi/GOAL.md`: P9 is current, P1–P8 are closed.

## Template — sections a live STATUS uses

A live `rsi/state/STATUS.md` is written with these `##` headings, in this order:

| Section | What it holds |
|---|---|
| Current position | Where the loop is now: programme line, open PRs, what is green / red / unverified. |
| Queue | One row per open item (`R-<slug>`, item, flow, source, state); the top row is next. |
| Concurrency | Which items may run in parallel and which paths each claims. |
| Lanes | One line per worker lane: item, slug, state. |
| Merge lane | Gate / review / merge state, and the last merged PR. |
| Parked | Items waiting on a person or an external event, each with the single question. |
| Programme notes | Milestone facts that outlive one queue row. |
| Watch | Signals the next pulse must re-check (failing checks, stale locks). |
| Last 48h | One line per landed item with its PR URL or SHA. |
