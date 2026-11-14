# rsi/ — the Kin self-improvement loop

A small agent team that moves Kin toward T3-Code-class dogfood quality, unattended, report-after.

```
launchd (hourly :30) ─► runtime/run.sh pulse ─► director (kimi) picks ONE item from state/STATUS.md
                                                 ├─ worker (deepseek flash) in its own worktree rsi/<slug>
                                                 ├─ runtime/gate.sh  (check.sh, ui tests, ratchet)
                                                 ├─ reviewer (kimi / codex, never the worker's model)
                                                 └─ PR → squash-merge if MANDATE gate green, else leave PR open
launchd 07:40 ─► run.sh dream  ─► state/reports/YYYY-MM-DD-morning.md (what merged, blocked, what to dogfood, reversible decisions)
launchd 08:15 ─► run.sh daily  ─► planner regroom of the queue from gap-log + docs
```

Files: `GOAL.md` · `MANDATE.md` · `DECISIONS.md` · `STATUS.md`/`scorecard.md` (seeds; live copies in `state/`) · `roles/*.md` · `runtime/`.
Control worktree: `~/.kin/worktrees/rsi-ceo` (branch `rsi/ceo-loop`, owned by the loop; auto-synced to `origin/main`).

Operate:
- Status: `cat ~/.kin/worktrees/rsi-ceo/rsi/state/STATUS.md`; logs in `rsi/runtime/runs/`; reports in `rsi/state/reports/`.
- Pause everything: `touch ~/.kin/worktrees/rsi-ceo/rsi/state/PAUSE` · resume: `rm` it. Stop merging only: `touch .../state/NO_MERGE`.
- Run now: `rsi/runtime/run.sh pulse --force` · dry check: `rsi/runtime/run.sh --check`.
- Reuse for another project: copy `rsi/`, edit GOAL/MANDATE/roles and the paths in `runtime/common.sh`.
