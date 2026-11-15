# NAS lanes (rsi/runtime/nas)

Extra RSI worker capacity on a LAN NAS (UGREEN DX4600, UGOS Pro). The Mac can SSH to it (`Host nas` in
`~/.ssh/config`), so the loop is **unattended and Mac-driven**: no CopyToBox hop, no inbound ports on
the NAS stack.

The NAS CPU is weak (Celeron N5105, 4 cores) but RAM is plentiful. Lanes do **agent thinking only**.
Full `tsc` / UI inventory / vitest run on the Mac under `heavy.sh` after the result is fetched.

**This slice is the return path: `ingest-nas.sh` and its regression suite.** For each finished NAS job
it fetches the git bundle, proves a worktree at the bundle's commit, runs the full self-check on the
Mac, pushes `rsi/<slug>` (never force), opens or refreshes the PR, releases the cloud claim only while
this run still owns it, marks the job `ingested`/`held` on the NAS, acks it locally and kicks
`merge.sh`. The forward path — `pulse-nas.sh` (claim untaken cloud briefs, ship brief + origin/main
bundle over ssh, start `nas-lane.sh`) with the launchd job and the `run.sh pulse` hook — is the
follow-up `R-nas-worker-lanes-pulse` slice, and the in-container Compose stack is
`R-nas-worker-lanes-stack`; both are recorded in `rsi/state/followups.md`. Until they land nothing
invokes this script automatically: run it by hand against an existing `work/jobs` tree, where it is a
no-op when no job is finished.

```
pulse (follow-up) ─► container runs nas-lane.sh ─► <NAS>/work/jobs/<slug>/{job.json,status.json,bundle}
                                                                   │
                                                  ingest-nas.sh ◄──┘        (this slice)
  1. list finished jobs over ssh (bounded; -n and fd 3 so ssh cannot drain the list)
  2. failed job: release the claim only when this run still owns it, mark ingested, tell the CEO once
  3. done job: require a valid `launched_at`, fetch + verify the bundle, then prove the claim still matches
     before the self-check and again before publishing
  4. worktree: under the per-slug merge lock, only when clean, on rsi/<slug>, and HEAD is an ancestor of
     the bundle; fast-forwarded with `merge --ff-only`, never re-pointed
  5. visible UI (diff from origin/main, never the worker's `base`) without two decodable captures → hold;
     an already-open PR keeps its previous head
  6. self-check under heavy.sh (tsc, UI inventory ratchet, full vitest), green only when it completed
  7. push (never force), open/refresh the PR, history row, release claim, mark ingested, kick merge.sh
```

## Ownership and conflict rules

- **A claim is released or a result published only by the run that proves it owns it.** `job.json` carries
  the claim's `launched_at` as the run identity. Ingest requires a valid numeric stamp on both sides: a
  missing, malformed or legacy `job.json` (including a failed metadata transfer) neither releases the claim
  nor publishes the result, and a claim without the same stamp is left alone. Releases happen under
  `state/lanes/.flock` only when `taker=nas`, the slug matches, and the stamp still matches. A brief that a
  failed start returned and box then took is left alone; a finished result under a foreign claim is reported
  instead of published.
- **An existing worktree is fast-forwarded, never reset.** Ingest takes the same per-slug lock as the merge
  lane (`state/merge/<slug>.lock`) for the mutation, and skips the slug while a merge verifier or a local
  lane is active. It reuses `$WT_ROOT/rsi-<slug>` only when it is clean, on `rsi/<slug>`, and its HEAD is an
  ancestor of the fetched bundle; the update is `git merge --ff-only`, so a HEAD that advanced after the
  checks fails the job instead of being discarded. Creation uses `-b`/an existing branch checkout, never
  `-B`. Commits a merge or rework lane added (or uncommitted edits) stop the job with a log line.
- **A PR head must contain the result before it is consumed.** Ingest pushes whether or not a PR exists, and
  refuses (holding the job with `state/nas/hold/<slug>.md`) when the remote branch or PR head is not an
  ancestor of the NAS commit. Nothing is force-pushed. When an incoming result changes visible UI without
  captures, an already-open PR is left at its previous head rather than receiving the unpublishable change.
- **A handled job is handled once.** The remote record is marked `ingested`/`held` and the exact run identity
  (`slug:status:started_at`) is appended to `state/nas/acks.txt`, so a second run repairs a half-finished pass
  without repeating the work, the history row or the CEO notice.

## Self-check

The Mac self-check is green only when the heavy command exited cleanly, the log carries the
`== selfcheck complete` marker written after all three checks, each check header is present, and no
`TSC-FAIL` / `INV-FAIL` / `VITEST-FAIL` marker was printed. An interrupted or timed-out run therefore cannot
read as green; the failing log and the reason are kept in `state/nas/xfer/<slug>/selfcheck.txt`.

## Screenshots and visible UI

NAS workers have no browser. When a finished job changes rendered UI (`ui/src/**/*.tsx|css`, tests excluded)
in the diff against `origin/main` — computed from Git, never from the worker's `status.base` — and
`rsi/state/shots/<slug>/` does not hold two **distinct, decodable** captures at exactly **390x844** and
**1100x760**, `ingest-nas.sh` does **not** publish the change. Filenames are not evidence: PNG chunks are
CRC-checked, their IDAT stream is decompressed and size-checked, JPEGs must reach EOI, and the measured
dimensions must match. Truncated, corrupt, wrong-size, duplicated or single-file evidence all hold the job.
The hold writes `rsi/state/nas/hold/<slug>.md` with the exact capture-and-publish command and one line in
`rsi/state/needs-ceo.md`. An unpublished branch is pushed first so captures can be taken from it; an
already-open PR keeps its previous head, because pushing would publish visible UI with no captures. Workers
are told to write `Screenshots: pending …` rather than claiming "none".

## Operate

- Ingest now: `rsi/runtime/nas/ingest-nas.sh` (also kicked by `pulse-nas.sh` once `R-nas-worker-lanes-pulse` lands)
- Regression tests: `bash rsi/runtime/nas/tests/test-nas.sh` (fake ssh/scp/gh; no NAS, no network)
- Revert: this slice installs nothing; delete the script/tests, or keep them unused. The launchd job,
  the Compose project and the `kin-rsi-nas` gateway key belong to the two follow-up slices
  (`launchctl bootout gui/$(id -u)/com.ethan.kin-rsi-nas` and
  `ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'` once they exist).
