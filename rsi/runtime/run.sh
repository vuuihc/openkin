#!/bin/bash
# run.sh <pulse|daily|dream> [--force] [--dry-run]   |   run.sh --check | --status
# Runner for the Kin RSI loop (parallel lanes, CEO 2026-11-15).
#   pulse = FILL: a short director run (DeepSeek V4.1 Flash --effort max) that assigns tasks to idle worker lanes, then launches them detached.
#           Cadence: launchd every 20 min + whenever a lane finishes / the merge lane acts. Quick no-op when no lane is idle.
#   daily/dream = planner regroom / nightly consolidation + morning report. They wait (bounded) for the fill lock only,
#           never for lane or merge locks, and still run if the wait times out.
# Worker lanes live in lane.sh, the merge/review lane in merge.sh (own launchd job).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
# Keep the control worktree on origin/main once the loop itself has landed there (it is owned by the loop).
#   clean tree          -> fast-forward (today's path, silent).
#   dirty but identical -> adopt with reset --hard. After a loop PR lands, the tracked files already
#                          equal origin/main while HEAD is behind, so status is non-empty and a plain
#                          fast-forward would skip forever and the loop would keep running old runtime
#                          scripts. `git diff origin/main` compares the whole tracked worktree, staged
#                          changes included, and ignores untracked files: exit 0 proves nothing is lost.
#   untracked collision -> a path the loop left untracked is now tracked by main. Identical bytes are
#                          adopted (nothing is lost, the ff writes the same content); different bytes pin
#                          the tree with a line naming the path, because both the ff and `reset --hard`
#                          would either abort or overwrite that draft silently.
#   anything else       -> leave alone and pin loudly; unmerged local loop commits on rsi/ceo-loop must survive.
#
# Never silent: a tree that cannot move says why and `--sync-check` exits non-zero. 2026-11-18 a stale
# untracked draft of rsi/runtime/reviewer-misses.py pinned the live tree 5 commits behind main with no
# output at all, and a 30-minute-old draft of rsi/GOAL.md did the same to a 7-commit lag: every merge
# ran the old runtime scripts while `--sync-check` printed nothing and exited 0.

# pinned <reason> — one line on stderr saying how far behind the tree is and which tracked paths are in
# the way, then return 1 so `--sync-check` (patrol, tests) cannot mistake a stale tree for a synced one.
pinned() {
  local behind paths
  behind="$($GIT -C "$RSI_CTRL" rev-list --count HEAD..origin/main 2>/dev/null)"
  paths="$($GIT -C "$RSI_CTRL" status --porcelain --untracked-files=no 2>/dev/null | cut -c4- | paste -sd' ' -)"
  echo "control tree pinned at $($GIT -C "$RSI_CTRL" rev-parse --short HEAD 2>/dev/null) (${behind:-?} commits behind origin/main): ${1}${paths:+: $paths}" >&2
  return 1
}
adopt_untracked_collision() {
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ -f "$RSI_CTRL/$p" ] || continue
    $GIT -C "$RSI_CTRL" ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && continue
    if [ "$($GIT -C "$RSI_CTRL" hash-object -- "$p" 2>/dev/null)" = \
         "$($GIT -C "$RSI_CTRL" rev-parse "origin/main:$p" 2>/dev/null)" ]; then
      rm -f -- "$RSI_CTRL/$p" && echo "control tree: adopted untracked $p (identical to origin/main)" >&2
      continue
    fi
    pinned "untracked $p differs from origin/main; move it aside to resume syncing"
    return 1
  done < <($GIT -C "$RSI_CTRL" diff --no-renames --name-only --diff-filter=A HEAD origin/main 2>/dev/null)
}
# adopt_pending_decisions — the last adoptable dirty shape: a pure append at EOF of
# rsi/DECISIONS.md while HEAD is behind origin/main. The director records CEO calls as
# uncommitted lines at the end of DECISIONS.md (prompts/fill.md §4); one such line pinned the
# live tree 17 commits behind main for six hours on 2026-11-20, so every gate, walker and
# GOAL.md the loop ran came from the stale tree. Only this exact shape is adopted: the added
# lines are copied to gitignored state/decisions-pending.md first, then the tracked file is
# restored and the caller fast-forwards. A deletion, a mid-file edit, a rewrite, any other
# dirty tracked path, or a tree already at origin/main returns 0 and leaves the existing
# pin/leave-alone path to speak. Returns 1 only after pinning: the tail could not be saved.
adopt_pending_decisions() {
  local behind dirty total diff_out tail_lines header l all pending
  behind="$($GIT -C "$RSI_CTRL" rev-list --count HEAD..origin/main 2>/dev/null)"
  case "$behind" in ''|*[!0-9]*|0) return 0;; esac
  $GIT -C "$RSI_CTRL" cat-file -e HEAD:rsi/DECISIONS.md 2>/dev/null || return 0
  dirty="$($GIT -C "$RSI_CTRL" diff --name-only HEAD 2>/dev/null)"
  [ "$dirty" = rsi/DECISIONS.md ] || return 0
  total="$($GIT -C "$RSI_CTRL" show HEAD:rsi/DECISIONS.md 2>/dev/null | wc -l | tr -d ' ')"
  # -U0 keeps only changed lines: no `-` line may appear (other than the --- header) and every
  # `+` hunk must start past the old file's last line, so only an EOF append passes. The diff is
  # unscoped because the path check above already proved the only dirty path is DECISIONS.md;
  # letting the path check be what restricts it keeps that guard load-bearing. The added lines
  # are printed verbatim, prefix stripped, for the pending record.
  diff_out="$($GIT -C "$RSI_CTRL" diff -U0 HEAD 2>/dev/null)"
  tail_lines="$(printf '%s\n' "$diff_out" | awk -v total="$total" '
    /^@@ / { inhunk = 1; if (!match($0, /\+[0-9]+/) || substr($0, RSTART + 1, RLENGTH - 1) + 0 <= total) early = 1; next }
    inhunk && /^-/ { deleted = 1; next }
    inhunk && /^\+/ { print substr($0, 2); next }
    END { exit (deleted || early) ? 1 : 0 }
  ')" || return 0
  [ -n "$tail_lines" ] || return 0
  pending="$STATE/decisions-pending.md"
  mkdir -p "$STATE" 2>/dev/null || { pinned "could not preserve the DECISIONS tail: cannot create $STATE"; return 1; }
  # Idempotent: a line already in the pending record is not appended again.
  all=1
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    grep -Fqx -- "$l" "$pending" 2>/dev/null || { all=0; break; }
  done <<< "$tail_lines"
  if [ "$all" = 0 ]; then
    header="- $(date '+%Y-%m-%d %H:%M %z' | sed 's/\([+-][0-9][0-9]\)[0-9][0-9]$/\1/') · adopted from an uncommitted rsi/DECISIONS.md tail (never committed) — fold into DECISIONS.md in a docs batch:"
    printf '%s\n%s\n' "$header" "$tail_lines" >> "$pending" 2>/dev/null \
      || { pinned "could not preserve the DECISIONS tail in $pending"; return 1; }
  fi
  $GIT -C "$RSI_CTRL" checkout HEAD -- rsi/DECISIONS.md 2>/dev/null \
    || { pinned "restore of rsi/DECISIONS.md after adopting its tail failed"; return 1; }
  echo "control tree: adopted the rsi/DECISIONS.md tail into rsi/state/decisions-pending.md" >&2
  return 0
}
sync_control_tree() {
  local before after
  local behind
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  if ! $GIT -C "$RSI_CTRL" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    # Not an ancestor: either HEAD carries unpublished loop commits (ahead, nothing to pull) or the
    # history diverged and origin/main moved on. The latter is behind and must not look synced.
    behind="$($GIT -C "$RSI_CTRL" rev-list --count HEAD..origin/main 2>/dev/null)"
    { [ -z "$behind" ] || [ "$behind" = 0 ]; } && return 0   # nothing behind (or no origin/main ref)
    pinned "local loop commits are unpublished; land or merge them to resume syncing"
    return 1
  fi
  adopt_untracked_collision || return 1
  adopt_pending_decisions || return 1
  if [ -z "$($GIT -C "$RSI_CTRL" status --porcelain --untracked-files=no)" ]; then
    $GIT -C "$RSI_CTRL" merge -q --ff-only origin/main 2>/dev/null || {
      pinned "fast-forward to origin/main failed"
      return 1
    }
    return 0
  fi
  if ! $GIT -C "$RSI_CTRL" diff --quiet origin/main 2>/dev/null; then
    # Dirty with tracked content that differs from origin/main. With nothing to pull this is the
    # in-place hotfix shape (HEAD already at origin/main): leave it alone, it is not a stale tree.
    if [ "$($GIT -C "$RSI_CTRL" rev-list --count HEAD..origin/main 2>/dev/null)" = 0 ]; then
      echo "control tree dirty at $($GIT -C "$RSI_CTRL" rev-parse --short HEAD 2>/dev/null) (at origin/main); leaving it alone" >&2
      return 0
    fi
    pinned "uncommitted tracked changes differ from origin/main; commit or move them aside"
    return 1
  fi
  before="$($GIT -C "$RSI_CTRL" rev-parse HEAD 2>/dev/null)"
  $GIT -C "$RSI_CTRL" reset -q --hard origin/main 2>/dev/null \
    || { pinned "reset --hard origin/main failed"; return 1; }
  after="$($GIT -C "$RSI_CTRL" rev-parse HEAD 2>/dev/null)"
  [ "$before" = "$after" ] || echo "control tree synced to ${after:0:8} (tracked content already matched)" >&2
}
# fill_plan <debounced:0|1> [workers:0|1] — the ordered actions for one pulse, one line, nothing
# else: no clock, no files, no state. The pulse makes the two decisions (may the director run?
# may workers run?) and executes the list in order. R-rework-dispatch: the debounce suppresses
# ONLY the expensive director run and its last_fill write. The model-free autofill that dispatches
# a rejected PR's rework used to sit below the debounce's `exit`, so a sendback waited out the
# eight minutes (rejection -> next verify p50 11 min, p90 31 min; 73% of open-to-merge).
fill_plan() {
  local debounced="${1:-0}" workers="${2:-1}" plan=""
  [ "$workers" = 1 ] && plan="autofill-astryx autofill-rest"
  [ "$debounced" = 1 ] || plan="${plan:+$plan }director"
  [ -n "$plan" ] && printf '%s\n' "$plan"
  return 0
}

# --sync-check: run only the control-tree sync and exit — no lock, no daemon, no launchd.
# Exit 0 means the tree is at origin/main (or legitimately ahead with unpublished loop commits);
# exit 1 means it is pinned behind it, with the reason already on stderr.
case "${1:-}" in --sync-check) sync_control_tree || exit 1; exit 0;; esac
# --fill-plan: print the ordering decision for a test without a clock, lock or model. The worker
# gate is resolved here (the only state fill_plan needs) exactly as the pulse resolves it.
case "${1:-}" in
  --fill-plan)
    case "${2:-}" in
      0|1) [ $# -eq 2 ] || { echo "usage: run.sh --fill-plan <0|1>" >&2; exit 2; }
           FILL_WORKERS=0; rsi_allow_workers && FILL_WORKERS=1
           fill_plan "$2" "$FILL_WORKERS"; exit 0;;
      *) echo "usage: run.sh --fill-plan <0|1>" >&2; exit 2;;
    esac;;
esac

# merge_lane_line — one line of truth for the merge lane. The lane moved from one global
# .merge.lock to one lock per PR: state/merge/<slug>.lock is a directory holding the verifier's
# pid (merge.sh: mkdir "$L"; echo $$ > "$L/pid"). A lock whose pid is missing or dead is not
# running, so neither is counted. The legacy single-instance lock stays visible as `legacy`,
# so an old-format run is never invisible. The glob expands sorted, so the slugs are alphabetical.
merge_lane_line() {
  local l p n=0 names=""
  for l in "$STATE"/merge/*.lock; do
    [ -d "$l" ] || continue
    p="$(cat "$l/pid" 2>/dev/null)"
    case "$p" in ''|*[!0-9]*|0) continue;; esac   # missing/empty/garbage/0 is not a pid (`kill -0 0` signals the process group)
    kill -0 "$p" 2>/dev/null || continue
    n=$((n+1)); names="${names:+$names, }$(basename "$l" .lock)"
  done
  if p="$(cat "$STATE/.merge.lock/pid" 2>/dev/null)"; then
    case "$p" in ''|*[!0-9]*|0) p="";; esac
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && { n=$((n+1)); names="${names:+$names, }legacy"; }
  fi
  if [ "$n" -eq 0 ]; then echo "merge lane: idle"; else echo "merge lane: $n running ($names)"; fi
}

# control_tree_line — one line of truth for how far the control tree is from origin/main. The pulse
# pins a tree it cannot move on stderr only, so `--status` looked healthy while the loop ran stale
# runtime scripts, a stale walker and a stale GOAL.md (2026-11-20: one uncommitted DECISIONS line held
# the live tree 17 commits behind main for six hours). Read-only: no fetch, no fast-forward.
control_tree_line() {
  local head behind ahead dirty
  head="$($GIT -C "$RSI_CTRL" rev-parse --short HEAD 2>/dev/null)"
  behind="$($GIT -C "$RSI_CTRL" rev-list --count HEAD..origin/main 2>/dev/null)"
  ahead="$($GIT -C "$RSI_CTRL" rev-list --count origin/main..HEAD 2>/dev/null)"
  case "$head" in ''|*[!0-9a-f]*) echo "control tree: unreadable at ${head:-?} (no origin/main ref?)"; return 0;; esac
  case "$behind$ahead" in ''|*[!0-9]*) echo "control tree: unreadable at $head (no origin/main ref?)"; return 0;; esac
  dirty="$($GIT -C "$RSI_CTRL" status --porcelain --untracked-files=no 2>/dev/null | cut -c4- | paste -sd' ' -)"
  if [ "$behind" -gt 0 ]; then
    echo "control tree: PINNED $behind behind origin/main at $head$([ "$ahead" -gt 0 ] && echo ", $ahead unpublished commit(s)")${dirty:+ — uncommitted tracked changes: $dirty}"
  elif [ "$ahead" -gt 0 ]; then
    echo "control tree: $ahead unpublished commit(s) on top of origin/main ($head)${dirty:+ — uncommitted tracked changes: $dirty}"
  elif [ -n "$dirty" ]; then
    echo "control tree: at origin/main ($head) with uncommitted tracked changes: $dirty"
  else
    echo "control tree: at origin/main ($head)"
  fi
}

MODE=""; FORCE=0; DRY=0; CHECK=0; STAT=0
for a in "$@"; do case "$a" in pulse|daily|dream) MODE="$a";; --force) FORCE=1;; --dry-run) DRY=1;; --check) CHECK=1;; --status) STAT=1;; *) echo "unknown arg $a"; exit 2;; esac; done

if [ $CHECK -eq 1 ] || [ $STAT -eq 1 ]; then
  if [ $CHECK -eq 1 ]; then
    echo "ctrl: $RSI_CTRL"; for t in "$CLAUDE" "$GIT" "$GH"; do [ -x "$t" ] && echo "ok $t" || echo "MISSING $t"; done
    for t in node npm go python3; do command -v $t >/dev/null && echo "ok $t" || echo "MISSING $t"; done
    for p in fill daily dream; do [ -s "$RSI_DIR/runtime/prompts/$p.md" ] && echo "prompt $p ok" || echo "prompt $p MISSING"; done
    for m in pulse merge dream daily; do launchctl print "gui/$(id -u)/com.ethan.kin-rsi-$m" >/dev/null 2>&1 && echo "launchd $m loaded" || echo "launchd $m NOT loaded"; done
  fi
  python3 "$LANES_PY" status
  for f in PAUSE NO_MERGE VOLC_NO_KIMI VOLC_STOP_WORKERS; do [ -e "$STATE/$f" ] && echo "$f set: $(cat "$STATE/$f")"; done
  python3 "$RSI_DIR/runtime/volc-budget.py" --apply >/dev/null 2>&1 || true
  [ -s "$STATE/volc-budget.json" ] && python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('volc list CNY today: ¥%.2f (%s); Kimi ¥%.2f / ¥%.0f'%(d['cny'],d['level'],d.get('kimi_cny') or 0,d.get('kimi_day_max') or 150))" "$STATE/volc-budget.json" 2>/dev/null
  echo "consec_fail=$(cat "$STATE/consec_fail" 2>/dev/null || echo 0) consec_timeout=$(cat "$STATE/consec_timeout" 2>/dev/null || echo 0)"
  # Rework cost, read from the notes the merge lane already wrote (read-only: it prints, never writes).
  # Without this line the only way to learn which guard to build next is to grep 300 sendback notes by
  # hand, which is what the CEO did on 2026-11-21 09:00 with two clocks and got the rate wrong (0.26 vs 0.66).
  [ -f "$RSI_DIR/runtime/rework-attrib.py" ] && [ -d "$STATE/sendback/done" ] && \
    python3 "$RSI_DIR/runtime/rework-attrib.py" --status --state "$STATE" 2>/dev/null
  # Which follow-ups cite a merged ref. Read-only, one line. A citation is a prompt to read
  # that line, not proof it is done: the ref may be the trigger or the failure (2026-11-21).
  [ -f "$RSI_DIR/runtime/followups-lint.py" ] && [ -f "$STATE/followups.md" ] && \
    python3 "$RSI_DIR/runtime/followups-lint.py" --status --state "$STATE" --repo "$RSI_CTRL" 2>/dev/null
  control_tree_line
  merge_lane_line
  BP_NOTE=""
  if rsi_open_pr_backpressure; then BP_NOTE=" (BACKPRESSURE: pausing new slices; rework+merge only)"; fi
  [ "${RSI_OPEN_RSI_PRS:--1}" -ge 0 ] && echo "open PRs: rsi_active=${RSI_OPEN_RSI_PRS}/${RSI_MAX_OPEN_PRS} total=${RSI_OPEN_TOTAL_PRS}${BP_NOTE}"
  [ -e "$STATE/merged.log" ] && { echo "--- merged.log (tail)"; tail -5 "$STATE/merged.log"; }
  exit 0
fi
[ -z "$MODE" ] && { echo "usage: run.sh <pulse|daily|dream> [--force] [--dry-run] | --check | --status"; exit 2; }

# Keep the control worktree on origin/main once the loop itself has landed there (it is owned by the loop).
# Unmerged local loop commits on rsi/ceo-loop must survive; see sync_control_tree.
if [ -z "${RSI_SYNCED:-}" ]; then
  sync_control_tree || true   # already loud; a pinned tree must not block the run it was called from
  RSI_SYNCED=1 exec /bin/bash "$SELF" "$@"
fi

mkdir -p "$STATE/reports" "$STATE/outbox" "$STATE/briefs" "$RUNS"
[ -e "$STATE/STATUS.md" ] || cp "$RSI_DIR/STATUS.md" "$STATE/STATUS.md"
[ -e "$STATE/scorecard.md" ] || cp "$RSI_DIR/scorecard.md" "$STATE/scorecard.md"
[ -e "$STATE/PAUSE" ] && [ $FORCE -eq 0 ] && { echo "paused ($STATE/PAUSE)"; exit 0; }

# Locks: pulse (fill) uses .fill.lock; daily/dream use .lock (docs/report lock) and first wait, bounded, for a running
# fill so STATUS.md edits do not interleave. Lanes and the merge lane have their own locks and nobody waits on them.
if [ "$MODE" = pulse ]; then LOCK="$STATE/.fill.lock"; else LOCK="$STATE/.lock"; fi
HAVE_LOCK=0
holder_alive() { [ -d "$1" ] && kill -0 "$(cat "$1/pid" 2>/dev/null || echo 0)" 2>/dev/null; }
if [ "$MODE" != pulse ]; then w=0; while { holder_alive "$STATE/.lock" || holder_alive "$STATE/.fill.lock"; } && [ $w -lt 1500 ]; do sleep 30; w=$((w+30)); done; fi
if mkdir "$LOCK" 2>/dev/null; then HAVE_LOCK=1
else
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && ! kill -0 "$OLD" 2>/dev/null; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null && HAVE_LOCK=1; fi
  if [ $HAVE_LOCK -eq 0 ]; then
    if [ "$MODE" = pulse ]; then echo "skip: another fill holds the lock (pid ${OLD:-?})"; exit 0; fi
    echo "warning: $MODE proceeding without the lock (holder pid ${OLD:-?} still busy after wait)"
  fi
fi
[ $HAVE_LOCK -eq 1 ] && { echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT; }

TODAY="$(date +%F)"; STAMP="$(date +%F-%H%M%S)"
IDLE=""; LANES_TXT=""
case "$MODE" in
  pulse)
    MAXSECS="$FILL_SECS"; PROMPT_FILE="$RSI_DIR/runtime/prompts/fill.md"
    # debounce: lane-finish / merge triggers + the 20-min tick must not stack director runs.
    # It gates only the director (and its last_fill write), never the model-free autofill below:
    # a rejected PR's rework must not wait out the eight minutes (R-rework-dispatch).
    DEBOUNCED=0
    if [ $FORCE -eq 0 ] && [ -e "$STATE/last_fill" ] && [ $(( $(date +%s) - $(cat "$STATE/last_fill") )) -lt 480 ]; then DEBOUNCED=1; fi
    WORKERS=0; [ $DRY -eq 0 ] && rsi_allow_workers && WORKERS=1
    DIRECTOR=0
    for action in $(fill_plan "$DEBOUNCED" "$WORKERS"); do
      case "$action" in
        autofill-astryx) bash "$RSI_DIR/runtime/lane.sh" autofill astryx;;   # Astryx sendbacks -> rework lanes first, no LLM
        autofill-rest) bash "$RSI_DIR/runtime/lane.sh" autofill rest;;       # non-Astryx reworks take remaining idle slots before exit
        director) DIRECTOR=1;;
      esac
    done
    if [ $DIRECTOR -eq 0 ]; then echo "skip: fill ran <8 min ago"; exit 0; fi
    if [ $DRY -eq 0 ] && rsi_open_pr_backpressure; then
      if rsi_allow_workers && [ -x "$RSI_DIR/runtime/nas/ingest-nas.sh" ]; then
        nohup /bin/bash "$RSI_DIR/runtime/nas/ingest-nas.sh" >> "$RUNS/launchd-nas.log" 2>&1 < /dev/null & disown 2>/dev/null || true
      fi
      echo "open PR backpressure: ${RSI_OPEN_RSI_PRS} active rsi PRs >= ${RSI_MAX_OPEN_PRS} (total open ${RSI_OPEN_TOTAL_PRS}); skipping new slice fill (rework + merge only)."
      exit 0
    fi
    IDLE="$(python3 "$LANES_PY" idle | tr '\n' ' ')"
    LANES_TXT="$(python3 "$LANES_PY" status)"
    CLOUD_PENDING="$(python3 "$RSI_DIR/runtime/slices.py" cloud-pending 2>/dev/null | wc -l | tr -d ' ')"
    # Post-programme: even with no idle lane the director must still run while STATUS.md's Queue holds a
    # dispatchable R-* row, because it is the only thing that writes a NAS brief (prompts/fill.md 2c).
    # Parked rows, rows already in a lane and rows that wait on an open PR are not dispatchable.
    R_QUEUE="$(awk 'BEGIN{q=0} /^## Queue/{q=1;next} /^## /{q=0} q && /^\| `R-/ && $0 !~ /lane [0-9]/ && $0 !~ /waits/ {n++} END{print n+0}' "$STATE/STATUS.md" 2>/dev/null)"
    if [ -z "${IDLE// }" ] && [ "${CLOUD_PENDING:-0}" -eq 0 ] && [ "${R_QUEUE:-0}" -eq 0 ]; then
      if [ $DRY -eq 0 ] && rsi_allow_workers && [ -x "$RSI_DIR/runtime/nas/pulse-nas.sh" ]; then
        nohup /bin/bash "$RSI_DIR/runtime/nas/pulse-nas.sh" >> "$RUNS/launchd-nas.log" 2>&1 < /dev/null & disown 2>/dev/null || true
      fi
      echo "no idle lane, no cloud brief pending, no dispatchable R-* row. $LANES_TXT"; exit 0
    fi
    # A dry queue used to pay for a director every 8-12 minutes even while every input
    # was unchanged (2026-11-28 21:09-23:19: eleven no-dispatch directors, cost_usd 5.35).
    # The fingerprint probe is deliberately fail-open: any unreadable input runs the director.
    FP_RC=2; FP_OUT="fill fingerprint helper missing"
    if [ -f "$RSI_DIR/runtime/fill_fingerprint.py" ]; then
      fp_args=(check --max-age "${RSI_FILL_FP_MAX_AGE:-2700}")
      [ $FORCE -eq 1 ] && fp_args+=(--force)
      FP_OUT="$(RSI_FILL_FP_GH="$GH" python3 "$RSI_DIR/runtime/fill_fingerprint.py" --repo "$RSI_CTRL" --state "$STATE" --gh-repo "$GH_REPO" "${fp_args[@]}" 2>&1)"
      FP_RC=$?
    fi
    if [ $FP_RC -eq 10 ]; then
      echo "$FP_OUT"
      if [ $DRY -eq 0 ] && rsi_allow_workers; then
        bash "$RSI_DIR/runtime/lane.sh" start-claimed
        [ -x "$RSI_DIR/runtime/nas/pulse-nas.sh" ] && nohup /bin/bash "$RSI_DIR/runtime/nas/pulse-nas.sh" >> "$RUNS/launchd-nas.log" 2>&1 < /dev/null & disown 2>/dev/null || true
      fi
      exit 0
    fi
    [ $FP_RC -eq 0 ] || echo "fill fingerprint unavailable; director runs fail-open: $FP_OUT"
    date +%s > "$STATE/last_fill";;
  daily)
    [ $FORCE -eq 0 ] && ls "$RUNS"/${TODAY}*-daily.jsonl >/dev/null 2>&1 && { echo "skip: daily already ran today"; exit 0; }
    MAXSECS=5400; PROMPT_FILE="$RSI_DIR/runtime/prompts/daily.md"
    # Refresh the weekly worth-it report before the run: dream.md reads it, and a stale
    # heading is how the 2026-11-18 brief had to re-derive the numbers by hand.
    [ $DRY -eq 0 ] && rsi_refresh_weekly_report;;
  dream)
    [ $FORCE -eq 0 ] && [ -s "$STATE/reports/$TODAY-morning.md" ] && { echo "skip: report exists"; exit 0; }
    MAXSECS=5400; PROMPT_FILE="$RSI_DIR/runtime/prompts/dream.md"
    [ $DRY -eq 0 ] && rsi_refresh_weekly_report;;
esac
LOG="$RUNS/$STAMP-$MODE.jsonl"
FLAGS="NO_MERGE=$([ -e "$STATE/NO_MERGE" ] && echo yes || echo no) DRY_RUN=$DRY"
PROMPT="$(sed -e "s#{{MODE}}#$MODE#g" -e "s#{{NOW}}#$(date '+%F %H:%M %Z')#g" -e "s#{{CTRL}}#$RSI_CTRL#g" -e "s#{{STATE}}#$STATE#g" -e "s#{{WT_ROOT}}#$WT_ROOT#g" -e "s#{{FLAGS}}#$FLAGS#g" -e "s#{{GH_REPO}}#$GH_REPO#g" -e "s#{{IDLE}}#${IDLE% }#g" -e "s#{{MAXLANES}}#$RSI_MAX_LANES#g" "$PROMPT_FILE")"
if [ $DRY -eq 1 ]; then TOOLS=(Read Glob Grep); else TOOLS=(Read Write Edit Glob Grep Bash Agent Skill WebFetch WebSearch); fi
GUARD=$BUDGET_GUARD; [ "$MODE" = pulse ] && GUARD=8

run_once() { # model [effort]
  local model="$1" effort="${2:-}"
  local args=( -p "$PROMPT" --model "$model"
      --allowedTools "${TOOLS[@]}" --permission-mode bypassPermissions
      --add-dir "$WT_ROOT" "$MAIN_CHECKOUT"
      --max-budget-usd "$GUARD"
      --output-format stream-json --verbose )
  [ -n "$effort" ] && args+=( --effort "$effort" )
  ( cd "$RSI_CTRL" && "$CLAUDE" "${args[@]}" < /dev/null >> "$LOG" 2>&1 ) &
  local pid=$!
  ( sleep "$MAXSECS"; echo '{"type":"runner","note":"watchdog timeout, terminating"}' >> "$LOG"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}
echo "run=$MODE start=$(date +%T) log=$LOG model=$M_DIRECTOR effort=$M_DIRECTOR_EFFORT idle_lanes=[${IDLE% }]"
run_once "$M_DIRECTOR" "$M_DIRECTOR_EFFORT"; RC=$?
python3 "$RSI_DIR/runtime/parse_result.py" "$LOG" > "$LOG.result.txt" 2>&1; PR=$?
if { [ $RC -ne 0 ] || [ $PR -ne 0 ]; } && tail -c 4000 "$LOG" | grep -qiE '403|forbidden|quota|rate.?limit|overloaded|Failed to authenticate|credit'; then
  echo '{"type":"runner","note":"API error, retrying on fallback model"}' >> "$LOG"
  run_once "$M_ALT"; RC=$?
  python3 "$RSI_DIR/runtime/parse_result.py" "$LOG" > "$LOG.result.txt" 2>&1; PR=$?
fi
echo "run=$MODE exit=$RC result_ok=$([ $PR -eq 0 ] && echo yes || echo no) log=$LOG"

# Lanes the director claimed are launched even if its final message failed (claims expire after 25 min otherwise).
if [ "$MODE" = pulse ] && [ $DRY -eq 0 ]; then
  if rsi_allow_workers; then
    bash "$RSI_DIR/runtime/lane.sh" start-claimed
    bash "$RSI_DIR/runtime/lane.sh" autofill rest   # non-Astryx reworks only take leftover lanes
    # Pack untaken cloud claims for the box first (marks taker=box). CopyToBox is
    # done by an agent with Mac+box tools; the box has no inbound route.
    # CEO 2026-11-16: state/BOX_OFF stops packing for the box while the box sync routine is paused (claims went zombie).
    if [ -x "$RSI_DIR/runtime/box/box-pack.sh" ] && [ ! -e "$STATE/BOX_OFF" ]; then
      /bin/bash "$RSI_DIR/runtime/box/box-pack.sh" >> "$RUNS/launchd-box.log" 2>&1 || true
    fi
    [ -x "$RSI_DIR/runtime/nas/pulse-nas.sh" ] && nohup /bin/bash "$RSI_DIR/runtime/nas/pulse-nas.sh" >> "$RUNS/launchd-nas.log" 2>&1 < /dev/null & disown 2>/dev/null || true
  else
    echo "volc budget: not starting new worker lanes until next Asia/Singapore day (¥${RSI_VOLC_CNY:-?} >= ¥${RSI_VOLC_STOP_WORKERS:-560})"
  fi
fi

if [ "$MODE" = pulse ] && [ "${FP_RC:-2}" -eq 0 ] && [ $RC -eq 0 ] && [ $PR -eq 0 ] && [ $DRY -eq 0 ]; then
  FP_RECORD_OUT="$(RSI_FILL_FP_GH="$GH" python3 "$RSI_DIR/runtime/fill_fingerprint.py" --repo "$RSI_CTRL" --state "$STATE" --gh-repo "$GH_REPO" record 2>&1)"
  FP_RECORD_RC=$?
  if [ $FP_RECORD_RC -ne 0 ]; then
    echo "fill fingerprint not recorded; the next pulse runs the director fail-open: $FP_RECORD_OUT"
  fi
fi
if [ $RC -eq 143 ] && grep -q '"note":"watchdog timeout' "$LOG"; then count_timeout "$MODE" "log: ${LOG##*/}"; exit 1; fi
if [ $RC -ne 0 ] || [ $PR -ne 0 ]; then count_fail "$MODE" "$(tail -c 200 "$LOG.result.txt" | tr '\n' ' ')  log: ${LOG##*/}"; exit 1; fi
count_ok
[ "$MODE" = dream ] && notify "Kin RSI morning report ready" "$STATE/reports/$TODAY-morning.md"
exit 0
