# ADR 0031: A Pull Request's Reviews Live in the Observation Snapshot

**Status:** Accepted (documentation only; the migration is held for owner approval)
**Date:** 2026-11-19
**Related:** ADR 0022 (Hub/Node split) · `rsi/GOAL.md` P9 item 1 · `ui/src/lib/prObservation.ts` (the panel that reads it)

## Context

The PR panel already answers "did the checks pass?" without leaving the conversation:
`ci_state` and `ci_summary` are read from GitHub by the node's `internal/github`
package, written into `pr_observations`, handed to the Hub in the same snapshot, and
rendered as one line by `ciLabel` (`ui/src/lib/prObservation.ts`). It does not answer
"is this review asking me for something?" — a review's author, state and body are
never read, so that question is answered on GitHub, in the flow where Kin is strongest.

This ADR decides the shape of that read. It is documentation only: landing it does not
create the column and does not approve it. The ordered migration and its two database
tests are a separate row held for the owner, because a schema change is one of the
changes this project does not take on a model's judgement alone.

Three properties of the existing code constrain the shape, and they are the reason this
is one column rather than a new table:

- **A row is a snapshot, not a history.** `pr_observations` is keyed by
  `(repo, head_branch)` and every successful refresh replaces the row's observed
  columns; the store keeps the newest *question's* answer, not the answers to older
  questions (`RecordPRObservation`, `WHERE` clause). Nothing reads a past snapshot.
- **There is exactly one writer.** `Service.record` (`internal/github/service.go`)
  marshals what the reader returned into `ci_summary` and writes the row. The panel
  reads the cached row; opening the panel asks GitHub nothing that the refresh did not
  already ask.
- **A source that cannot be read is not a source that reported nothing.** `readCI`
  keeps the pull request and leaves the CI state unknown (`none`) when either check
  source fails, because "not reported" and "not read" are different facts. Reviews
  must obey the same rule or a permission failure will render as "no reviews".

## Decision

**One additive column on `pr_observations`: `reviews TEXT NOT NULL DEFAULT ''`,**
holding a JSON array of `{author, state, body}`, written only by the same explicit
refresh that writes `ci_summary`.

### The column

- `''` (the default) means **never read**: no refresh has successfully asked for this
  branch's reviews, including every row written before this column existed. `[]` means
  **read, and the pull request carries none**. A failed review read keeps the previous
  value if there was one and otherwise leaves `''`; it never writes `[]`, exactly as a
  failed CI read leaves the state unknown rather than reporting success.
- The array is ordered as GitHub returns it (oldest first) and is not sorted by Kin;
  the panel is free to render it in that order. Each element carries `author` (the
  login as the forge spells it), `state`, and `body` (the review's markdown text).
- `state` is the forge's vocabulary, not a Kin verdict:
  `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED` / `PENDING`. Anything
  else is stored as `UNKNOWN` and rendered as a neutral "review" — the panel never
  infers approval from a word it does not know.
- Bounds are enforced at the boundary, because the payload is untrusted input: at most
  **20** reviews per snapshot (the newest 20, keeping their relative order), `author`
  at most 100 runes, `body` at most 4000 runes, truncated at a rune boundary and
  keeping the head. The read asks for the newest page it can — `per_page=100`, then
  the response's `rel="last"` link when one exists — so "the newest 20" is the newest
  the API will hand back in one page, never the oldest twenty of a long list.
  `apiRunner` returns only a JSON body today, so this read also needs the response's
  `Link` header from both transports; without it the honest bound is the first page
  returned. The panel may clamp the visible body (for example to eight lines with an
  expand affordance); it must not drop a review or misreport a clamped body as a
  complete one.

### The write path

`Service.record` stays the only writer. The reviews are read inside the existing
explicit `lookup` sequence — the same call that reads the pull request and its checks —
by one added request to the pull request's reviews endpoint. That makes the cost
visible where it belongs: one more GET on a refresh somebody asked for, never a read
on panel open, never a background poll the panel added, and no second code path that
can write a partial row.

A reviews read that fails is not a reviews answer. The pull request and its checks are
still a good observation, so `record` writes the row with `reviews` unchanged; only a
row that never had an answer reads `''`. The all-column upsert (`RecordPRObservation`)
takes every observed column from `excluded`, so carrying the old value is the
implementation's job, and it is safe to do with
`CASE WHEN excluded.reviews = '' THEN pr_observations.reviews ELSE excluded.reviews END`
precisely because a *successful* empty answer is `[]` and never `''`. `RecordPRFailure`
already writes only the attempt columns, so a failed attempt preserves it. The panel
can therefore say "reviews not read" only for `''`; a kept array's only age is the
row's `observed_at`, which the successful pull-request read refreshes even when the
reviews read failed.

`api/openapi.yaml` documents `reviews` next to `ci_summary`, and the change regenerates
the console's typed client (`ui/src/api/generated/openapi.ts` via
`npm run generate:api`, which `scripts/check-openapi.sh` compares):
`additionalProperties: false` makes skipping that regeneration a contract break. The
node→Hub carrier is *not* the openapi object: it is `worker.PRObserveResult`
(`internal/remote/worker/query.go`), copied in `internal/node/responder_pr.go` and
rebuilt in `internal/github/service.go`. The field is added in all three places, and
the `''`/`[]` distinction has to survive the hop, or a phone reading a remote task
shows "not read" for reviews the node did read.

### The migration, held

The migration is **049**, appended after 048 in the same ordered list in
`internal/store/migrate.go`, guarded by `pragma_table_info('pr_observations')` the way
048 guards `routines.conversation_mode`: if `reviews` is absent, one
`ALTER TABLE pr_observations ADD COLUMN reviews TEXT NOT NULL DEFAULT ''`, then
`PRAGMA user_version = 49`. Old rows read as `''` — "no reviews cached" — which is the
honest value, not an empty review list.

A fresh install never runs 049, and the ADR has to say so or the held row will ship a
column half the world lacks: `migrate()` applies `migration001` (which already contains
`migrationPRObservations`) and then stamps `PRAGMA user_version = schemaVersion`, so a
new database jumps straight to the current version. The held row therefore also adds
`reviews TEXT NOT NULL DEFAULT ''` to the `migrationPRObservations` DDL and bumps
`schemaVersion` to 49. The guarded 049 ALTER covers every existing database, and the
held row also adds an `ensurePRObservationReviewsSchema` reconcile to
`ensureCurrentSchema` with the same `pragma_table_info` guard as 048, so a database
whose version says 49 but whose table lacks the column is repaired on open; the
empty-database test proves the fresh-install half.

Both database tests AGENTS.md requires are part of that held row: one on an empty
database (a fresh install has the column present and `''` by default — the test that
catches a migration-only change) and one on a populated database (a row written before
49 upgrades with `''`, keeps every other column, and a row written after it round-trips
a two-review array through `RecordPRObservation`/`GetPRObservation`).

**No SQL, no Go, no test code is written in this delivery.** The ADR records the shape;
the schema row stays open with `needs-ceo` until the owner answers.

## Consequences

- The panel can render author, state and body from the cached snapshot with no GitHub
  call of its own, and keeps the failing-check names it already shows. A snapshot with
  `''` says "reviews not read" in one line instead of looking like a pull request
  nobody reviewed — the failure that would make the feature actively misleading. A
  kept array whose refresh failed renders from the snapshot with the row's
  `observed_at` — the only timestamp the row carries for it — and the panel must not
  present that as a fresh reviews read.
- The reviews are not a durable history. If a review is edited or dismissed, the next
  refresh shows the new answer; nothing recovers the old one. That is the same
  trade-off the row already makes for the PR's own state, and it is the right one for a
  panel that answers "what does this pull request say now?".
- The node→Hub hop carries the field: `worker.PRObserveResult`, `responder_pr.go` and
  the Hub's rebuild all name it, so a phone reading a remote task sees the same cached
  reviews as the desktop. The Hub needs no new route and no new table.
- `pr_observations` grows by one TEXT column, bounded at the boundary (20 × ~4100 runes
  worst case) and replaced wholesale like every other observed column.
- An anonymous reader may be refused reviews on a private repository while it can read
  the pull request itself. That is visible as "not read", never as "none", and the
  panel keeps the failing-check line it already has.

## Alternatives considered

- **A `pr_reviews` child table.** Rejected: the snapshot is replaced wholesale, only
  the last read is ever shown, and no query in this product wants per-review rows. A
  table adds a join, a write order, and a second place a partial refresh can land —
  plus an invitation to incremental per-review writes, which the "a failed read never
  erases a good observation" rule does not cover. If a future feature needs review
  history, that is a different decision with its own ADR; this column does not block
  it (a table can be backfilled from the snapshots as they arrive).
- **Reusing `ci_summary` with a second top-level key.** Rejected: one column whose name
  says "checks" would then hold two unrelated facts, and every reader would have to
  parse both to know which it got.
- **Reading reviews when the panel opens.** Rejected: it would put a GitHub call on a
  read the user did not ask for, break the offline/rate-limit behaviour the cache
  exists for, and make the panel slower on exactly the flow it is meant to serve.
- **Rendering review state as a Kin verdict (approved / changes requested).** Rejected:
  a forge's review state is not Kin's judgment about whether the change is good, and a
  merged pull request can carry `CHANGES_REQUESTED` from before a fix. The panel shows
  the word the forge used.

## Evidence seam for the implementation

The walk cannot prove this today: `J2` asserts the "not in a GitHub repository" state,
and the seeded journeys are API-only, so no seeded observation carries a review. The
implementation row therefore proves it with three seams and says so in its PR: a Go test
that runs the reader against a fake transport answering a two-review payload (including
the failed-read case, asserting the previous array survives and `''` stays `''`) and
round-trips the snapshot through the store; a hop test that a fake machine answer
carrying `[]` and one carrying `''` arrive at the Hub as themselves; and a DOM suite on
the panel fed by a cached observation with `[]`, `''` and a two-review array. Faking a
review inside the walk is
not allowed — it would prove the seed, not the read.
