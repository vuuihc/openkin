# shellcheck shell=bash
# Shared environment for the Kin RSI loop. Sourced by run.sh, dispatch.sh, gate.sh.
export TZ=Asia/Singapore
export HOME="${HOME:-/Users/$(id -un)}"
RSI_CTRL="${RSI_CTRL:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RSI_DIR="$RSI_CTRL/rsi"
STATE="$RSI_DIR/state"
RUNS="${RSI_RUNS:-$RSI_DIR/runtime/runs}"
GH_REPO="vuuihc/openkin"
WT_ROOT="$HOME/.kin/worktrees"
MAIN_CHECKOUT="$HOME/Workspace/study/kin-multidevice"   # primary checkout

NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="$HOME/.antigravity/antigravity/bin:$HOME/.local/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
# Heavy-command shims (npm/npx/go): builds, full tests and tsc run one at a time machine-wide (see heavy.sh).
# The first full parallel fill put this 16 GB Mac at load 300+ and swap 90% because three builds/test runs overlapped.
export PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/shim:$PATH"
export RSI_HEAVY_SLOTS="${RSI_HEAVY_SLOTS:-1}" UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-4}"

CLAUDE="$HOME/.local/bin/claude"
GIT="${GIT:-/usr/bin/git}"
GH="${RSI_GH:-/opt/homebrew/bin/gh}"
KIN_BIN="$HOME/.kin/node/kin"

# Public repo: commit as the noreply identity everywhere.
export GIT_AUTHOR_NAME=vuuihc GIT_AUTHOR_EMAIL=vuuihc@users.noreply.github.com
export GIT_COMMITTER_NAME=vuuihc GIT_COMMITTER_EMAIL=vuuihc@users.noreply.github.com
export GIT_TERMINAL_PROMPT=0
# Let the Bash tool wait for long builds/tests inside a claude -p run, but keep the
# DEFAULT well under LANE_WORKER_SECS (3000 s = 50 min watchdog, below): a default
# longer than the watchdog turns one stuck call into a lost round (2026-11-18, lane 2:
# a nested heredoc swallowed its closing `)` and hung on stdin for 2,400 s). Known-long
# builds/tests (walk and mutant suites, check.sh) must pass an explicit `timeout`, up
# to the 30-min max.
export BASH_DEFAULT_TIMEOUT_MS=600000 BASH_MAX_TIMEOUT_MS=1800000
# Every loop process resolves "opus" to DeepSeek, never to Kimi (CEO 2026-11-17, ROUTING.md):
# worker lanes pass --model explicitly, but Claude Code's own sub-agents and any internal
# "opus" resolution read this env first, and the global ~/.claude mapping points at Kimi.
export ANTHROPIC_DEFAULT_OPUS_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'

# Model routing — policy in rsi/ROUTING.md (CEO 2026-11-15). Default DeepSeek; escalate only on necessity.
# Workers / rework: DeepSeek V4.1 Flash at --effort high. Director/planner/dream/first reviewer: same model at --effort max.
# Strong reviewers: Antigravity gemini-4-hydrogen-medium first (UX too — Hydrogen is multimodal).
# hydrogen-high only for F1–F4 / S1–S3 / architecture, or a second strong pass after disagreement.
# Never xhigh by default. gpt-6.1-sol second, Carbon third, Kimi last (Volcengine, ¥150/day cap).
M_WORKER='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
M_DIRECTOR='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
M_ALT='codex/gpt-6.1-sol'
M_CODEX='codex/gpt-6.1-sol'
M_KIMI='volcengine-gw/kimi-k3.1-pro[1m]'
M_HYDROGEN='agy/gemini-4-hydrogen-medium'
M_HYDROGEN_HIGH='agy/gemini-4-hydrogen-high'
M_HYDROGEN_AGY="${M_HYDROGEN_AGY:-gemini-4-hydrogen-medium}"
M_HYDROGEN_HIGH_AGY="${M_HYDROGEN_HIGH_AGY:-gemini-4-hydrogen-high}"
M_CARBON='agy/gemini-4-carbon-high'
M_CARBON_AGY="${M_CARBON_AGY:-gemini-4-carbon-high}"
# Pin the Antigravity CLI; launchd PATH is short and command -v can miss it.
if [ -z "${AGY:-}" ] || [ ! -x "${AGY:-}" ]; then
  for _agy in /opt/homebrew/bin/agy "$HOME/.antigravity/antigravity/bin/agy" "$(command -v agy 2>/dev/null || true)"; do
    [ -n "$_agy" ] && [ -x "$_agy" ] && AGY="$_agy" && break
  done
  unset _agy
fi
# Re-enabled now that dispatch feeds the diff inline and allows read_file (the earlier empty SUCCESS
# was Bash denied in headless, not a missing sign-in). Set either to 0 to disable all agy models.
export RSI_CARBON_ENABLED="${RSI_CARBON_ENABLED:-1}"
export RSI_AGY_ENABLED="${RSI_AGY_ENABLED:-$RSI_CARBON_ENABLED}"
M_WORKER_EFFORT="${M_WORKER_EFFORT:-high}"
M_DIRECTOR_EFFORT="${M_DIRECTOR_EFFORT:-max}"
BUDGET_GUARD="${BUDGET_GUARD:-15}"

# --- Parallel lanes (CEO 2026-11-15) ---
export RSI_STATE="$STATE"
[ -e "$STATE/BOX_OFF" ] && export RSI_CLOUD_MAX="${RSI_CLOUD_MAX:-2}"
export RSI_MAX_LANES="${RSI_MAX_LANES:-2}"        # worker lanes; the merge lane is separate. 3 swamped this 16 GB Mac (swap 90%, load 100+) -> 2.
# Ethan 2026-11-18: the Mac's memory is the constraint, so the SECOND local worker is optional
# capacity and stands down unless the machine is genuinely cool; the rest of the work goes to the
# NAS lanes. Measured at the change: 6.5 GB reclaimable, 1.3 GB swap -> the spare lane starts.
export RSI_LANE2_MEM_MIN_MB="${RSI_LANE2_MEM_MIN_MB:-5120}"
export RSI_LANE2_PRESSURE_MAX="${RSI_LANE2_PRESSURE_MAX:-1}"
export RSI_LANE2_SWAP_FREE_MIN_MB="${RSI_LANE2_SWAP_FREE_MIN_MB:-512}"
# Do not default RSI_LOAD_MAX to 100000 (that disabled the guard). lanes.py
# treats a missing or >=10000 value as 2× cores.
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"  # three lanes of default-parallel vitest overload 8 cores
export GOMAXPROCS="${GOMAXPROCS:-2}"
export GO_TEST_P="${GO_TEST_P:-2}"
LANE_WORKER_SECS="${LANE_WORKER_SECS:-3000}"       # worker watchdog (50 min); Astryx slices target ~45 min / <= $8 / <= 800 lines
LANE_BUDGET_USD="${LANE_BUDGET_USD:-9}"            # runaway guard per worker run (target spend <= $5)
FILL_SECS="${FILL_SECS:-1200}"
LANES_PY="$RSI_DIR/runtime/lanes.py"
mkdir -p "$STATE/lanes" "$STATE/sendback" "$STATE/merge"

# Restore a lost +x bit on a runtime script that the repository records as executable.
#
# Why: the live control tree is patched in place (CEO hotfixes), and a temp-file+mv edit drops
# the mode to 644. A caller that invokes a runtime script as a program — ux-gate.sh runs
# `dispatch.sh`, not `bash dispatch.sh` — then dies with exit 126 and the reviewer reports
# "unavailable" while the code is fine (2026-11-17 23:24, dispatch.sh and ux-gate.sh both left
# 644; #238's UX gate lost a cooldown cycle to it). run.sh, merge.sh, lane.sh, gate.sh,
# dispatch.sh, ux-gate.sh and ux-walk.sh source this file, so the heal lands before they
# dispatch anything. release.sh does not source it and calls release-check.sh via `bash`.
#
# Only files git records as 100755 are healed: rsi/runtime/tests/*.sh and three top-level
# scripts are tracked 644 on purpose, and chmod-ing them would leave a mode-only modification
# that run.sh:40 (control-tree fast-forward) and gate.sh:114 ("build left uncommitted changes")
# read as operator edits. A tree that is not a git checkout has no recorded modes to respect,
# so there everything is healed.
if git -C "$RSI_CTRL" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$RSI_CTRL" ls-files -s -- rsi/runtime 2>/dev/null \
    | awk '$1 == "100755" && $4 ~ /^rsi\/runtime\/[^\/]+\.sh$/ {print substr($4, 13)}' \
    | while read -r _rsi_sh; do
        [ -n "$_rsi_sh" ] || continue
        [ -x "$RSI_DIR/runtime/$_rsi_sh" ] && continue
        chmod +x "$RSI_DIR/runtime/$_rsi_sh" 2>/dev/null \
          && echo "rsi: restored +x on $_rsi_sh" >&2
      done
else
  for _rsi_sh in "$RSI_DIR"/runtime/*.sh; do
    [ -f "$_rsi_sh" ] || continue
    [ -x "$_rsi_sh" ] && continue
    chmod +x "$_rsi_sh" 2>/dev/null && echo "rsi: restored +x on ${_rsi_sh##*/}" >&2
  done
fi
unset _rsi_sh


# Reap a process and its descendants (children first). Never signals pid 1.
# Used on lane exit/timeout so a killed worker cannot leave vitest/go/node/agy behind.
# Freeze each parent before enumerating its children: a live parent whose first
# child dies can fork a replacement while the loop is still walking, and that
# replacement then outlives this function (measured in PR #376's review).
rsi_kill_tree() {
  local root="${1:-}" c
  [ -n "$root" ] && [ "$root" -gt 1 ] 2>/dev/null || return 0
  kill -STOP "$root" 2>/dev/null || true
  for c in $(pgrep -P "$root" 2>/dev/null || true); do
    rsi_kill_tree "$c"
  done
  kill -TERM "$root" 2>/dev/null || true
  sleep 0.3
  kill -KILL "$root" 2>/dev/null || true
  kill -CONT "$root" 2>/dev/null || true   # only matters if KILL was denied; never leave it stopped
}

# Like with_timeout, but for a wait whose children must not survive it: the walk
# runs heavy.sh -> node -> Chromium, and killing only the direct child leaves the
# walker driving the browser after the gate has moved on. Returns 124 at the
# ceiling so the caller can say "no verdict" instead of guessing a failure.
# The parent blocks in wait(), so a child that finishes keeps its own status; a
# polling loop would relabel a fast failure as a timeout whenever the poll tick
# straddles the deadline. The watchdog only kills a process it can still
# identify as the one started here, because a reaped pid can be reused.
bounded_run() { # secs cmd...
  local secs="$1" p ident flag w rc now _i; shift
  flag="$(mktemp "${TMPDIR:-/tmp}/bounded-run.XXXXXX")" || return 2
  rm -f "$flag"
  "$@" & p=$!
  # Pin the child's identity while it is certainly alive: a reaped pid can be
  # reused, and the watchdog must not freeze a stranger. The read is retried
  # briefly because the first call can race the fork.
  ident=""
  for _i in 1 2 3 4 5; do
    ident="$(ps -o lstart= -p "$p" 2>/dev/null | tr -d ' \n' || true)"
    [ -n "$ident" ] && break
    kill -0 "$p" 2>/dev/null || break
    sleep 0.05
  done
  ( sp=""
    # A cancelled watchdog must not leave its sleep behind for the whole ceiling.
    trap '[ -n "${sp:-}" ] && kill "$sp" 2>/dev/null; exit 0' TERM INT
    sleep "$secs" & sp=$!; wait "$sp" || exit 0
    now="$(ps -o lstart= -p "$p" 2>/dev/null | tr -d ' \n' || true)"
    # An empty read is a failed inspection, not a verdict: fall back to liveness
    # (fail closed). A non-empty read that disagrees is a reused pid: leave it.
    if [ -n "$ident" ] && [ -n "$now" ] && [ "$now" != "$ident" ]; then exit 0; fi
    kill -0 "$p" 2>/dev/null || exit 0
    printf 'timeout\n' > "$flag" 2>/dev/null || true
    rsi_kill_tree "$p"
  ) >/dev/null 2>&1 & w=$!
  wait "$p"; rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  # The child's own answer wins even when the watchdog raced it: only a signal
  # death from the watchdog (rc >= 128) is the no-verdict 124.
  if [ -s "$flag" ] && [ "$rc" -ge 128 ] 2>/dev/null; then rm -f "$flag"; return 124; fi
  rm -f "$flag"
  return $rc
}

with_timeout() { # secs cmd...   (macOS has no `timeout`)
  local s="$1"; shift
  "$@" & local p=$!
  ( sp=""
    trap '[ -n "${sp:-}" ] && kill "$sp" 2>/dev/null; exit 0' TERM INT
    sleep "$s" & sp=$!; wait "$sp" || exit 0
    kill -TERM "$p" 2>/dev/null
    sleep 5 & sp=$!; wait "$sp" || exit 0
    kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$p"; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}
# Reap every process whose current directory is <dir> or inside it. The pgid and
# pgrep -P walks above only reach the worker's own tree: a child that called
# setsid (expo start) reparents to launchd and survives both, so on lane cleanup
# we also sweep by working directory. lsof sees the current user's processes
# without root; a timeout or a missing lsof prints "no verdict" and returns 0 —
# cleanup must never block on the sweep.
rsi_reap_cwd() { # <dir> [exclude_pid...]
  local dir="${1:-}"; shift
  [ -n "$dir" ] || return 0
  local real out pid cwd n=0
  real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$dir" 2>/dev/null)" || real=""
  if [ -z "$real" ]; then
    echo "orphan sweep: no verdict (cannot resolve $dir)" >&2; return 0
  fi
  if ! out="$(bounded_run 20 lsof -n -w -a -d cwd -Fpn 2>/dev/null)"; then
    echo "orphan sweep: no verdict (lsof timed out or failed)" >&2; return 0
  fi
  pid=""
  while IFS= read -r line; do
    case "$line" in
      p*) pid="${line#p}" ;;
      n*)
        cwd="${line#n}"
        [ -n "$pid" ] || continue
        [ "$pid" -gt 1 ] 2>/dev/null || { pid=""; continue; }
        if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi
        case " $* " in *" $pid "*) continue ;; esac
        # Match against both spellings without a per-line realpath call: lsof
        # usually reports the resolved path (so $real covers a symlinked dir
        # argument), and $dir covers a system that reports the path as opened.
        if [ "$cwd" = "$real" ] || [ "${cwd#"$real"/}" != "$cwd" ] \
        || [ "$cwd" = "$dir" ] || [ "${cwd#"$dir"/}" != "$cwd" ]; then
          rsi_kill_tree "$pid"; n=$((n + 1))
        fi
        ;;
    esac
  done <<< "$out"
  [ "$n" -gt 0 ] && echo "reaped $n process(es) under $dir" >&2
  return 0
}

# Booted iOS simulator UDIDs, one per line. A lane worker that ran `expo start`
# can boot simulators that are launchd-owned and never enter our process tree;
# the lane records this list before launch and shuts down the difference on
# cleanup. Silent (rc 0) when xcrun is absent or nothing is booted; a failed or
# timed-out query returns non-zero so an incomplete snapshot is distinguishable
# from an empty one — an empty "before" would otherwise read as "nothing was up".
rsi_sim_booted() {
  command -v xcrun >/dev/null 2>&1 || return 0
  local out
  out="$(bounded_run 20 xcrun simctl list devices booted -j 2>/dev/null)" || return 1
  printf '%s\n' "$out" \
    | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
for devs in (d.get("devices") or {}).values():
    for dev in devs:
        if dev.get("state") == "Booted" and dev.get("udid"):
            print(dev["udid"])' 2>/dev/null || true
}

# Basename of another live lane holding a lock beside <self_lock>, or nothing.
# A simulator this lane booted can still be in use by a second lane, so cleanup
# consults this before shutting any down. A lock with no pid file or a dead pid
# is a leftover, not a live lane.
rsi_other_live_lane() { # <self_lock_dir>
  local self="${1:-}" lk lp
  [ -n "$self" ] || return 0
  for lk in "${self%/*}"/*.lock; do
    [ -d "$lk" ] || continue
    [ "$lk" = "$self" ] && continue
    lp="$(cat "$lk/pid" 2>/dev/null || true)"
    if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then echo "${lk##*/}"; return 0; fi
  done
  return 0
}

# Shut down each currently booted simulator not listed in <before_file> (the
# snapshot rsi_sim_booted wrote before the worker launched). Booted-by-someone-
# else simulators stay up; only the difference is this lane's. The snapshot's
# "#complete" line marks a query that actually succeeded: without it the file
# is empty because xcrun failed, not because nothing was booted, and shutting
# down everything unlisted would kill simulators that predate the lane.
rsi_sim_shutdown_new() { # <before_file>
  local before="${1:-}" udid n=0
  [ -f "$before" ] || return 0
  grep -qx '#complete' "$before" 2>/dev/null || return 0
  command -v xcrun >/dev/null 2>&1 || return 0
  while IFS= read -r udid; do
    [ -n "$udid" ] || continue
    grep -qxF "$udid" "$before" 2>/dev/null && continue
    bounded_run 20 xcrun simctl shutdown "$udid" >/dev/null 2>&1 && n=$((n + 1))
  done < <(rsi_sim_booted)
  [ "$n" -gt 0 ] && echo "shut down $n simulator(s) booted by this lane" >&2
  return 0
}

count_timeout() { # a watchdog kill: counted apart from failures; 6 in a row pauses the loop
  local t=$(( $(cat "$STATE/consec_timeout" 2>/dev/null || echo 0) + 1 )); echo $t > "$STATE/consec_timeout"
  notify "Kin RSI: $1 hit watchdog timeout ($t in a row)" "${2:-}"
  [ $t -ge 6 ] && echo "6 consecutive watchdog timeouts $(date)" > "$STATE/PAUSE"
  return 0
}
count_fail() { # real runner failure (not a gate verdict): 6 in a row pauses the loop. Never trips NO_MERGE.
  local n=$(( $(cat "$STATE/consec_fail" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/consec_fail"
  notify "Kin RSI: $1 failed ($n in a row)" "${2:-}"
  [ $n -ge 6 ] && echo "6 consecutive runner failures $(date)" > "$STATE/PAUSE"
  return 0
}
count_ok() { echo 0 > "$STATE/consec_fail"; echo 0 > "$STATE/consec_timeout"; }
scorecard_row() { # item worker reviewer result pr fpy note   (inserted above "## Weekly fold")
  python3 - "$STATE/scorecard.md" "$(date '+%F %H:%M')" "$@" <<'PY'
import sys
p, ts, item, w, r, res, pr, fpy = sys.argv[1:9]; note = sys.argv[9] if len(sys.argv) > 9 else "-"
row = f"| {ts} | {item} | `{w}` | `{r}` | {res} | {pr} | {fpy} | {note} |\n"
try: lines = open(p).read().splitlines(True)
except Exception: lines = []
idx = next((i for i, l in enumerate(lines) if l.startswith("## Weekly fold")), None)
if idx is None: lines.append(row)
else: lines.insert(idx - 1 if idx > 0 and lines[idx-1].strip() == "" else idx, row)
open(p, "w").write("".join(lines))
PY
}

notify() { # title body
  local t="$1" b="${2:-}"
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' "$b" "$t" >/dev/null 2>&1 || true
  [ -x "$KIN_BIN" ] && "$KIN_BIN" notify "$t" "$b" >/dev/null 2>&1 || true
  mkdir -p "$STATE/outbox"; printf '%s\n%s\n' "$t" "$b" > "$STATE/outbox/$(date +%F-%H%M%S)-notification.txt"
}

# Volcengine list-price budget (Mac magpie, Asia/Singapore day). See runtime/volc-budget.py and escalate.py.
# >= ¥450 (RSI_VOLC_KIMI_MAX): no Kimi; fall back to gpt-6.1-sol.
# >= ¥560 (RSI_VOLC_STOP_WORKERS): new worker lanes / box pack / NAS pulse stand down until tomorrow.
# Kimi daily cap ¥150 (RSI_VOLC_KIMI_DAY_MAX): further Kimi escalations fall back to gpt-6.1-sol.
rsi_budget_apply() {
  # Preserve a caller's explicit cap: the tool re-reads policy on every call and a cached
  # spend snapshot carries the caps it was computed with (volc-budget.py recomputes them).
  RSI_VOLC_CNY=; RSI_VOLC_LEVEL=ok; RSI_VOLC_DAY=; RSI_VOLC_KIMI_CNY=; RSI_VOLC_KIMI_DAY_MAX="${RSI_VOLC_KIMI_DAY_MAX:-150}"
  local ev
  ev="$(python3 "$RSI_DIR/runtime/volc-budget.py" --export 2>/dev/null)" || return 0
  eval "$ev" 2>/dev/null || true
}
rsi_allow_kimi() { python3 "$RSI_DIR/runtime/volc-budget.py" --allow-kimi >/dev/null 2>&1; }
rsi_allow_workers() { python3 "$RSI_DIR/runtime/volc-budget.py" --allow-workers >/dev/null 2>&1; }
# Regenerate escalations-weekly.md on the report path the morning brief reads. Quiet and
# fail-open by design: a report nobody could write must never stop a daily/dream run, and
# the run has nothing useful to say about it. escalate.py reads the exported RSI_STATE.
rsi_refresh_weekly_report() {
  python3 "$RSI_DIR/runtime/escalate.py" --weekly >/dev/null 2>&1 || true
  return 0
}
rsi_budget_apply

# Open-PR backpressure (CEO 2026-11-16): pause NEW slice dispatch when >= RSI_MAX_OPEN_PRS active rsi/* PRs
# are already open, letting rework + merge drain the queue. Set RSI_MAX_OPEN_PRS=0 (or off) to disable.
export RSI_MAX_OPEN_PRS="${RSI_MAX_OPEN_PRS:-10}"
rsi_open_pr_counts() {
  if [ -n "${RSI_OPEN_PR_COUNT:-}" ]; then
    printf '%s %s\n' "$RSI_OPEN_PR_COUNT" "$RSI_OPEN_PR_COUNT"
    return 0
  fi
  local prj
  prj="$($GH pr list --repo "$GH_REPO" --state open --limit 80 --json number,headRefName,isDraft,labels 2>/dev/null || true)"
  if ! printf '%s' "$prj" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
    sleep 2
    prj="$($GH pr list --repo "$GH_REPO" --state open --limit 80 --json number,headRefName,isDraft,labels 2>/dev/null || true)"
  fi
  printf '%s' "$prj" | STATE="$STATE" RSI_DIR="$RSI_DIR" python3 -c '
import json, os, sys
sys.path.insert(0, os.path.join(os.environ["RSI_DIR"], "runtime"))
from pr_select import is_candidate
try:
    prs = json.load(sys.stdin)
except Exception:
    sys.exit(1)
st = os.environ["STATE"]
active = 0
for p in prs:
    h = p.get("headRefName") or ""
    if not is_candidate(h, p.get("isDraft"), p.get("labels")):
        continue
    slug = h[4:]
    if os.path.exists(os.path.join(st, "merge", slug + ".blocked")):
        continue
    active += 1
print("%d %d" % (active, len(prs)))
' 2>/dev/null || { echo "-1 -1"; return 1; }
}
rsi_open_pr_backpressure() {
  RSI_OPEN_RSI_PRS=-1; RSI_OPEN_TOTAL_PRS=-1
  case "${RSI_MAX_OPEN_PRS:-10}" in
    ""|0|off|OFF|false|FALSE|*[!0-9]*) return 1 ;;
  esac
  [ "$RSI_MAX_OPEN_PRS" -ge 1 ] 2>/dev/null || return 1
  local counts
  counts="$(rsi_open_pr_counts 2>/dev/null || echo "-1 -1")"
  RSI_OPEN_RSI_PRS="${counts%% *}"; RSI_OPEN_TOTAL_PRS="${counts##* }"
  [ "${RSI_OPEN_RSI_PRS:--1}" -ge 0 ] 2>/dev/null || return 1
  [ "$RSI_OPEN_RSI_PRS" -ge "$RSI_MAX_OPEN_PRS" ] 2>/dev/null
}
