# rsi/ — the Kin self-improvement loop

A small agent team that moves Kin toward T3-Code-class dogfood quality, unattended, report-after.

```
launchd every 20 min (+ whenever a lane finishes) ─► run.sh pulse = FILL: director (DeepSeek --effort max, ≤20 min, no-op if no lane is idle)
        │   rework sendbacks → idle lanes automatically; queue → ≤25 min / ≤$5 / ≲400-line slices, each declaring its paths
        ▼   lanes.py claim REFUSES overlapping paths between active lanes
 worker lane 1 ┐   lane.sh run N: worktree ~/.kin/worktrees/rsi-<slug> (branch rsi/<slug>) → worker (deepseek flash, 40 min watchdog,
 worker lane 2 ├─►   $6 guard) → format changed UI/Go → push → PR → hand over   (own lock per lane; default RSI_MAX_LANES=2 (3 supported), vitest workers=2)
 (lane 3 only if RSI_MAX_LANES=3) ┘
        ▼
 launchd every 10 min (+ after each lane) ─► merge.sh = MERGE LANE (one at a time, oldest PR first)
        merge origin/main into the branch (never force-push; web/dist/index.html conflicts auto-rebuilt) → hold rules →
        gate.sh → independent review (codex/gpt-6.1-sol; never the worker's model) → CI → squash-merge
        failure → state/sendback/<slug>.md → rework lane (max 3 rounds, then state/needs-ceo.md)
launchd 07:40 + 08:55 ─► run.sh dream  ─► state/reports/YYYY-MM-DD-morning.md
launchd 08:15 ─► run.sh daily  ─► planner regroom of the queue (items sized for lanes)
```

Files: `GOAL.md` · `MANDATE.md` · `DECISIONS.md` · `STATUS.md`/`scorecard.md` (seeds; live copies in `state/`) · `roles/*.md` · `runtime/`.
Control worktree: `~/.kin/worktrees/rsi-ceo` (branch `rsi/ceo-loop`, owned by the loop; auto-synced to `origin/main`).

Operate:
- Pace: `python3 rsi/runtime/pace.py` — 24h merges, open→merge p50/p90, unshipped vs the release threshold, hours left in the current `GOAL.md` phase, and an ON-PACE/BEHIND line. The CEO quotes it every patrol; `--json` for scripts (`pace.py` is control-tree local until its own PR lands).
- Status: `rsi/runtime/run.sh --status` (lanes, flags, counters, merge lane, merged.log) · `cat rsi/state/STATUS.md` · logs in `rsi/runtime/runs/` (`*-laneN.log`, `*-dispatch-laneN-<slug>-worker.jsonl`, `gate-merge-*.log`, `launchd-merge.log`) · reports in `rsi/state/reports/`.
- Pause everything: `touch rsi/state/PAUSE` (lanes in flight finish; nothing new starts) · resume: `rm` it. Stop merging only: `touch rsi/state/NO_MERGE` (merge lane still verifies, never merges).
- Fewer lanes (machine overloaded): `RSI_MAX_LANES=2` (the default; 3 is supported but swamped this 16 GB Mac). Serial mode = `RSI_MAX_LANES=1`.
- Fill now: `rsi/runtime/run.sh pulse --force` · merge lane now: `rsi/runtime/merge.sh` (`--dry-run` to list) · one lane by hand: claim with `lanes.py claim N --slug S --item ID --brief FILE --paths P…` then `rsi/runtime/lane.sh run N`.
- Reinstall launchd jobs after editing templates: `rsi/runtime/launchd/install.sh [pulse merge dream daily]`.
- Dry check: `rsi/runtime/run.sh --check`. Old serial director prompt kept as `runtime/prompts/pulse-serial.md`.
- Reuse for another project: copy `rsi/`, edit GOAL/MANDATE/roles and the paths in `runtime/common.sh`.

## Merge pipeline and cloud lane (2026-11-15)
- `runtime/merge.sh` = dispatcher (every 10 min and after lane/merge events) → up to 2 per-PR verifiers (`merge.sh --one`): sync main → hold rules → screenshots → **review ∥ gate** → CI → land under a lock. `state/merge/cycles.log` has verify/open-to-merge times.
- Cloud slices (`executor: cloud` in `astryx-slices.json`): `slices.py cloud-pending`, briefs in `state/cloud-briefs/` (+ `INDEX.md`), `lanes.py cloud-list|cloud-release`.
- Throughput knobs (2026-11-15, see DECISIONS): tiered review `runtime/review-tier.py` (`state/merge/<slug>.tier`), verifier slots `RSI_MERGE_WORKERS=2` + `RSI_MERGE_SMALL_SLOTS=1`, remote overflow off with `touch state/NO_REMOTE_OVERFLOW`, `RSI_BOX_MAX=3`, `RSI_CARBON_ENABLED=0`, sol quota marker `state/sol-limited-until`. Queue wait is logged in `state/merge/cycles.log` (`verifier_started queue_wait=Nm`).
- Prose claim check (2026-11-20, R-latency-fix): a PR whose diff touches a prose-assertion path (`rsi/GOAL.md`, `rsi/DECISIONS.md`, `rsi/ASTRYX-PLAN.md`, `AGENTS.md`, `PRINCIPLE.md`, `SYSTEM_DESIGN.md`, `docs/adr/`, `docs/plans/`, `docs/product/`) must carry `Claim check:` with one command and `Claim output:` with the output it claims. The merge lane runs the command in the worktree (60 s) **before** launching the reviewer, and a missing or false claim is a mechanical sendback (`source: mech-claim`, no model spend). `Claim check: none: <reason ≥ 20 chars>` waives it and logs `claim_check=waived` in `state/merge/cycles.log`. `runtime/claim_check.py` owns the rule; test: `bash rsi/runtime/tests/test-claim-check.sh`. A PR opened outside `lane.sh` (the nightly DREAM consolidation, a CEO session) goes through `bash rsi/runtime/producer-pr.sh <worktree> <body-file> <repo> <base> <head> <title>`, which runs this same rule and refuses with `PRODUCER_PR_REFUSED` before `gh pr create`; the merge gate stays the backstop for producers that do not call it.

## NAS lanes (2026-11-15)

- `runtime/nas/` = Mac-driven unattended workers on the LAN NAS. **Both halves are in the tree:** `pulse-nas.sh` claims an untaken cloud brief, ships the brief + `origin/main` bundle over ssh and `docker exec`s `nas-lane.sh` (it never steals a `taker`, never starts when the container is down or the NAS is under pressure, and hands a brief back when the start fails); `ingest-nas.sh` lists finished jobs over ssh, fetches and verifies the git bundle, self-checks on the Mac (`heavy.sh`), pushes `rsi/<slug>` (never force), opens or refreshes the PR, and kicks `merge.sh`. Handled jobs are marked `ingested`/`held` on the NAS and acked locally, so a second run does nothing; a claim is released only by the run that owns it, an existing worktree is fast-forwarded only when clean and unchanged, the self-check is green only when it ran to completion, and visible UI is held (branch pushed, no PR) until real 390x844 and 1100x760 captures exist — the diff comes from `origin/main`, not the worker. The isolated Compose stack lives in `rsi/runtime/nas/compose/`, with the in-container `rsi/runtime/nas/nas-side/nas-lane.sh`, `install-nas.sh`, and `smoke-nas.sh`. Details: `runtime/nas/README.md`. Tests: `bash rsi/runtime/nas/tests/test-nas.sh`.
