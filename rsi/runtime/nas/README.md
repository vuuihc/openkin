# NAS lanes (rsi/runtime/nas)

Extra RSI worker capacity on a LAN NAS (UGREEN DX4600, UGOS Pro). The Mac can SSH to it (`Host nas` in
`~/.ssh/config`), so the loop is **unattended and Mac-driven**: no CopyToBox hop, no inbound ports on
the NAS stack.

The NAS CPU is weak (Celeron N5105, 4 cores) but RAM is plentiful. Lanes do **agent thinking only**.
Full `tsc` / UI inventory / vitest run on the Mac under `heavy.sh` after the result is fetched.

**Both halves live in this tree: `pulse-nas.sh` fills a NAS lane from the Mac, `ingest-nas.sh` brings
the result back.** Every 20 minutes the pulse first ingests finished work, then — only when the worker
container is up and a lane is idle — claims a ready cloud brief nobody has taken, ships `job.json` and
an `origin/main` git bundle over ssh, writes a starter `status.json` (`queued`), and `docker exec`s
`nas-lane.sh <slug>` detached inside the isolated container; the Mac runs the full `tsc` / UI inventory
/ vitest self-check under `heavy.sh` after the result is fetched.
BASE is the head of the shipped bundle, never a ref the NAS repo happened to keep:
`nas-lane.sh` applies the bundle (head
`refs/remotes/origin/main`, or `refs/heads/main` from an older producer) through `nas-side/nas-base.sh`
and builds only from the ref that bundle named, falling back to the bare repo's `refs/heads/main` when
none arrived.

The pulse refuses to steal a claim (`taker=box` or `taker=nas` is left byte-identical), to start when
`docker inspect` says the container is not running, when the NAS is under pressure (load >= 5 or
MemAvailable < 3 GB), or when every lane is busy (`NAS_MAX_LANES=2`; lane 2 additionally needs load < 3
and MemAvailable > 6 GB). A `docker exec` that fails marks the remote record failed, hands the brief
back under the shared scheduler flock, and stops retrying it after `NAS_MAX_START_FAILS` (2), so a bad
start cannot silently burn a slot for the 5 h claim hold.

For each finished NAS job `ingest-nas.sh` fetches the git bundle, proves a worktree at the bundle's
commit, runs the full self-check on the Mac, pushes `rsi/<slug>` (never force), opens or refreshes the
PR, releases the cloud claim only while this run still owns it, marks the job `ingested`/`held` on the
NAS, acks it locally and kicks `merge.sh`. The launchd job that schedules the pulse is installed on the
Mac outside this repo; `run.sh` also starts the pulse when the script is executable. The in-container
pieces ship in this tree: the Compose stack in `compose/`, the lane entrypoint `nas-side/nas-lane.sh`,
`install-nas.sh`, and the `smoke-nas.sh` probe.

```
pulse-nas.sh (every 20 min) ─► container runs nas-lane.sh ─► <NAS>/work/jobs/<slug>/{job.json,status.json,bundle}
                                                                          │
                                                        ingest-nas.sh ◄───┘
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
  instead of published. The pulse hands a brief back under the same flock when `docker exec` fails, and stops
  re-claiming it after `NAS_MAX_START_FAILS`, so a broken start is a counted failure rather than a 5 h slot.
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

## Claim check for prose deliveries

A result that changes a prose-assertion path (`rsi/GOAL.md`, `rsi/DECISIONS.md`, `rsi/ASTRYX-PLAN.md`,
`AGENTS.md`, `PRINCIPLE.md`, `SYSTEM_DESIGN.md`, `docs/adr/`, `docs/plans/`, `docs/product/`) runs the
merge gate's own rule before the self-check: `rsi/runtime/claim_check.py`, the single file `lane.sh` and
`merge.sh` already call, against the lane's exact `origin/main...<bundle>` changed-file computation. The
check is bounded by `NAS_CLAIM_TIMEOUT` (120 s). A missing or false `Claim check:`, a diff that cannot be
read, a non-zero rc, or an expired bound (recorded as `NO_VERDICT`) writes
`rsi/state/nas/hold/<slug>.md`, marks the job `held` and appends one `held for claim check` line to
`needs-ceo.md`; no PR is opened and no live PR body is overwritten. A new branch is pushed so the result
survives for the local rework; an already-open PR keeps its previous head, because pushing would let the
merge lane claim-check the previous body against a diff it never verified.
The cloud brief tells the worker to run the same check in its own session.

## Operate

- Ingest now: `rsi/runtime/nas/ingest-nas.sh` (the pulse runs it first on every round).
- Pulse now: `rsi/runtime/nas/pulse-nas.sh` (also scheduled by the Mac's launchd job and by `run.sh pulse`
  when the script is executable).
- Regression tests: `bash rsi/runtime/nas/tests/test-nas.sh` (fake ssh/scp/docker/gh; no NAS, no network).
  `t_pulse_*` pins the forward path and the rest the return path; every test runs in a throwaway tree and
  never reads or writes the real `rsi/state`.
- Revert: delete the scripts and tests, or keep them unused. The launchd job, the Compose project and
  the `kin-rsi-nas` gateway key belong to the install path
  (`launchctl bootout gui/$(id -u)/com.ethan.kin-rsi-nas` and
  `ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'`).
