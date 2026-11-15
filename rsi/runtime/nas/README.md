# NAS lanes (rsi/runtime/nas)

Extra RSI worker capacity on a LAN NAS (UGREEN DX4600, UGOS Pro). The Mac can SSH to it (`Host nas` in
`~/.ssh/config`), so the loop is **unattended and Mac-driven**: no CopyToBox hop, no inbound ports on
the NAS stack.

The NAS CPU is weak (Celeron N5105, 4 cores) but RAM is plentiful. Lanes do **agent thinking only**.
Full `tsc` / UI inventory / vitest run on the Mac under `heavy.sh` after the result is fetched.

This slice ships the **Mac-side control plane** (`pulse-nas.sh`, `ingest-nas.sh`, their tests, and the
launchd/run.sh hooks). The isolated Compose stack, the in-container `nas-lane.sh`, the installer and
the `claude -p` smoke probe are a follow-up slice (`R-nas-worker-lanes-stack`, recorded in
`rsi/state/followups.md`), which keeps this review under the merge lane's size cap. Until that lands
the pulse probes the NAS, ingests nothing, logs `NAS worker container not running` and exits 0. The
deferred installer needs a provisioned magpie **gateway/caller** key in `<NAS root>/secrets/magpie.key`
(mode 600); a browser UI key is not a caller key.

```
launchd every 20 min + run.sh pulse ─► pulse-nas.sh
  0. bounded ssh probe (unreachable NAS = no remote work this round)
  1. ingest-nas.sh     finished jobs: fetch bundle, heavy.sh self-check, push rsi/<slug>
                       (never force), open the PR, cloud-release, kick merge.sh
                       jobs are marked `ingested` on the NAS + acked locally: a second pulse does nothing
  2. reconcile         status=running with no nas-lane.sh process, or queued/running older than
                       NAS_JOB_MAX_SECS (3900s), is marked failed so it cannot hold a slot forever
  3. if a NAS lane is idle:
       claim a state/cloud/*.json brief with no taker (never steal taker=box or taker=nas)
       set taker=nas under state/lanes/.flock (atomic replace), heartbeat claimed_at
       ship brief + git bundle of origin/main over ssh (every call bounded)
       docker exec nas-lane.sh in the isolated container (Claude Code → host magpie :3425)
```

## Ownership and conflict rules

- **One pulse at a time.** `state/nas/.pulse.lock` carries the owner pid; a pulse that finds a live one exits
  without touching it, and the EXIT trap removes the lock only when the pid inside is still its own (a stale
  lock is reclaimed only after its pid is dead or still runs `pulse-nas.sh`).
- **Failed discovery is not an empty worker list.** If the `/proc` scan over ssh fails, the pulse logs
  `worker process discovery failed` and stops before reconciling or claiming: an empty `ALIVE` set otherwise
  means "every running job is dead".
- **A claim is released only by the run that owns it.** `job.json` carries the claim's `launched_at` as the run
  identity. `ingest-nas.sh` releases (success or failure) under `state/lanes/.flock` only when `taker=nas`, the
  slug matches, and the stamp still matches; a brief that a failed start returned and box then took is left
  alone, and a finished result under a foreign claim is reported instead of published.
- **An existing worktree is fast-forwarded, never reset.** Ingest reuses `$WT_ROOT/rsi-<slug>` only when it is
  clean, on `rsi/<slug>`, and its HEAD is an ancestor of the fetched bundle commit. Commits a merge or rework
  lane added (or uncommitted edits) stop the job with a log line instead of being discarded.
- **A PR head must contain the result before it is consumed.** Ingest pushes whether or not a PR exists, and
  refuses (holding the job with `state/nas/hold/<slug>.md`) when the remote branch or PR head is not an
  ancestor of the NAS commit. Nothing is force-pushed.

## Self-check

The Mac self-check is green only when the heavy command exited cleanly, the log carries the
`== selfcheck complete` marker written after all three checks, each check header is present, and no
`TSC-FAIL` / `INV-FAIL` / `VITEST-FAIL` marker was printed. An interrupted or timed-out run therefore cannot
read as green; the failing log and the reason are kept in `state/nas/xfer/<slug>/selfcheck.txt`.

## Lanes and guards

- `NAS_MAX_LANES=2` (default). Lane 2 starts only when NAS 1-minute load `< 3` and `MemAvailable > 6 GB`.
- New work is skipped if load `>= 5` or available RAM `< 3 GB`.
- `NAS_MAX_START_FAILS=2`: after two failed ssh/scp/`docker exec` starts for the same slug the brief is left untaken and skipped, instead of retried every 20 minutes.
- `NAS_JOB_MAX_SECS=3900`: a queued/running record older than this is marked failed and ingested; a `running` record whose `nas-lane.sh` process is gone (container restart, OOM) is marked failed on the next pulse.
- Every remote call runs under a timeout (`NAS_SSH_TIMEOUT=90`, `NAS_XFER_TIMEOUT=600`); a pulse older than `NAS_PULSE_MAX_SECS=7200` is reclaimed, and only if its pid still runs `pulse-nas.sh`.
- `touch rsi/state/PAUSE` also stops the NAS pulse.

## Screenshots and visible UI

NAS workers have no browser. When a finished job changes rendered UI (`ui/src/**/*.tsx|css`, tests excluded)
in the diff against `origin/main` — computed from Git, never from the worker's `status.base` — and
`rsi/state/shots/<slug>/` does not hold a real 390-wide **and** a real 1100-wide capture (PNG/JPEG, named for
its width), `ingest-nas.sh` pushes the branch but does **not** open the PR: it writes
`rsi/state/nas/hold/<slug>.md` with the exact capture-and-publish command and one line in
`rsi/state/needs-ceo.md`. Capture 390x844 and 1100x760, then create the PR. Workers are told to write
`Screenshots: pending …` rather than claiming "none"; one capture, a text file, or a diff that cannot be
computed all hold the job rather than publishing it.

## Operate

- Pulse now: `rsi/runtime/nas/pulse-nas.sh`
- Reinstall the launchd job: `rsi/runtime/launchd/install.sh nas`
- Regression tests: `bash rsi/runtime/nas/tests/test-nas.sh` (fake ssh/scp/docker/gh; no NAS, no network)
- Revert: `launchctl bootout gui/$(id -u)/com.ethan.kin-rsi-nas` and delete `~/Library/LaunchAgents/com.ethan.kin-rsi-nas.plist`. Tearing down the NAS Compose project belongs to the follow-up stack slice (`ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'`); data stays in `~/kin-rsi-nas` until you delete it.
