# rsi/ — the Kin self-improvement loop

A small agent team that moves Kin toward T3-Code-class dogfood quality, unattended, report-after.

```
launchd every 20 min (+ whenever a lane finishes) ─► run.sh pulse = FILL: director (DeepSeek --effort max, ≤20 min, no-op if no lane is idle)
        │   rework sendbacks → idle lanes automatically; queue → ≤25 min / ≤$5 / ≲400-line slices, each declaring its paths
        ▼   lanes.py claim REFUSES overlapping paths between active lanes
 worker lane 1 ┐   lane.sh run N: worktree ~/.kin/worktrees/rsi-<slug> (branch rsi/<slug>) → worker (deepseek flash, 40 min watchdog,
 worker lane 2 ├─►   $6 guard) → push → PR → hand over          (own lock per lane; default RSI_MAX_LANES=2 (3 supported), vitest workers=2)
 (lane 3 only if RSI_MAX_LANES=3) ┘
        ▼
 launchd every 10 min (+ after each lane) ─► merge.sh = MERGE LANE (one at a time, oldest PR first)
        merge origin/main into the branch (never force-push; web/dist/index.html conflicts auto-rebuilt) → hold rules →
        gate.sh → independent review (DeepSeek --effort max, or codex for risky/>500 lines; stronger models only per rsi/ROUTING.md) → UX vision gate after #73 (codex default, Carbon on necessity) → CI → squash-merge
        failure → state/sendback/<slug>.md → rework lane (max 3 rounds, then state/needs-ceo.md)
launchd 07:40 + 08:55 ─► run.sh dream  ─► state/reports/YYYY-MM-DD-morning.md
launchd 08:15 ─► run.sh daily  ─► planner regroom of the queue (items sized for lanes)
```

Files: `GOAL.md` · `MANDATE.md` · `DECISIONS.md` · `STATUS.md`/`scorecard.md` (seeds; live copies in `state/`) · `roles/*.md` · `runtime/`.
Control worktree: `~/.kin/worktrees/rsi-ceo` (branch `rsi/ceo-loop`, owned by the loop; auto-synced to `origin/main`).

Operate:
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
