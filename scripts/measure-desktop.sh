#!/usr/bin/env bash
# Measure the desktop shell's memory and startup cost.
#
# What this measures
#   * The Electron process tree (main, renderer, GPU, utility, crashpad) as a
#     whole, plus each process, sampled while a scenario is held.
#   * The `kin` daemon process tree (supervisor + daemon) on the same machine,
#     measured separately. Agent/CLI children spawned by the daemon are
#     reported as a separate column, not folded into the daemon total.
#   * Startup: spawn → first CDP page target, → DOM ready, → first contentful
#     paint, read from the page's own performance timeline.
#
# What this never does
#   * It does not restart, stop, or reconfigure the daemon on :7777. It only
#     attaches to it (the desktop shell already attaches to an external daemon
#     without touching it) and reads a handful of authenticated endpoints.
#   * It does not kill any process it did not spawn. The only processes killed
#     are the Electron main process this script started and its descendants,
#     after checking the root's executable and start time.
#   * It does not create a daemon. If nothing healthy answers on the port it
#     stops before launching, because the shell's sidecar would otherwise
#     spawn one.
#   * It does not run scripts/desktop-rebuild.sh.
#
# Isolation
#   Each run gets a fresh `--user-data-dir` and its own CDP port, so runs cannot
#   collide with the user's running dev shell (whose Electron singleton lock
#   lives in ~/Library/Application Support/Kin-dev). A tiny launcher in the run
#   directory runs the real `desktop/dist/main.js` bundle and only:
#     - suppresses `app.setAsDefaultProtocolClient`, so a short-lived
#       measurement instance does not rewrite the system's kin:// handler;
#     - turns `BrowserWindow.show()` into `showInactive()` and `focus()` into a
#       no-op, so runs do not steal keyboard focus. The window is still visible
#       and rendered; it is not hidden (hidden windows are throttled).
#
# Scenarios
#   idle      freshly launched, home/new view
#   session   one long session open (most tokens in the live daemon)
#   task      a probe task is created, run, measured, then deleted
#   soak      one long run, sampled at --soak-interval, growth fitted in MB/h
#   startup   launch + first paint only
#
# Decision rule (pre-registered in the program plan)
#   idle Electron tree > 400 MB, or growth > 100 MB/h, means "evaluate a light
#   shell"; otherwise no rewrite. This script reports both summed RSS and
#   summed phys_footprint; apply the rule to both and say which one triggered,
#   if either. A missing footprint is reported as missing, never summed as
#   zero; without footprint, RSS alone carries the rule.
#
# Usage
#   scripts/measure-desktop.sh [flags]
#     --scenario LIST        comma list of idle,session,task,soak,startup
#                            (default: idle,session,task,startup,soak)
#     --runs N               runs per scenario where a fresh launch applies (5)
#     --task-runs N          probe-task runs (3; each one spends model tokens)
#     --soak-minutes N       soak length in minutes (60)
#     --soak-interval SEC    soak sampling interval (30)
#     --settle-seconds SEC   wait after ready before sampling (25)
#     --samples N            samples per settled scenario run (5)
#     --sample-interval SEC  seconds between settled samples (2)
#     --session-id ID        task id to open for the session scenario
#     --soak-session-id ID   optional task id to hold open during the soak
#                            (default: the soak stays on the home view)
#     --daemon-port PORT     must be 7777: the desktop shell hardcodes it
#     --electron PATH        Electron binary (default: desktop/node_modules)
#     --out DIR              output directory (default .tmp/measure-desktop-<ts>)
#     --keep-userdata        do not delete per-run user-data directories
#     --no-task              skip the probe-task scenario even if requested
#     --summarize-only       recompute summary.txt/json from an existing --out
#                            directory; launches and samples nothing
#
# Requires: macOS, node >= 22 (global WebSocket), curl, python3, lsof, ps,
# and `footprint` (/usr/bin/footprint) for phys_footprint. Without `footprint`
# the report falls back to RSS only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/desktop"

SCENARIOS="idle,session,task,startup,soak"
RUNS=5
TASK_RUNS=3
SOAK_MINUTES=60
SOAK_INTERVAL=30
SETTLE_SECONDS=25
SAMPLES=5
SAMPLE_INTERVAL=2
SESSION_ID=""
SOAK_SESSION_ID=""
DAEMON_PORT="${KIN_PORT:-7777}"
ELECTRON_BIN=""
OUT=""
KEEP_USERDATA=0
NO_TASK=0
SUMMARIZE_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario|--runs|--task-runs|--soak-minutes|--soak-interval|--settle-seconds|--samples|--sample-interval|--session-id|--soak-session-id|--daemon-port|--electron|--out)
      [ $# -ge 2 ] || { echo "missing value for $1" >&2; exit 2; } ;;
  esac
  case "$1" in
    --scenario) SCENARIOS="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --task-runs) TASK_RUNS="$2"; shift 2 ;;
    --soak-minutes) SOAK_MINUTES="$2"; shift 2 ;;
    --soak-interval) SOAK_INTERVAL="$2"; shift 2 ;;
    --settle-seconds) SETTLE_SECONDS="$2"; shift 2 ;;
    --samples) SAMPLES="$2"; shift 2 ;;
    --sample-interval) SAMPLE_INTERVAL="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --soak-session-id) SOAK_SESSION_ID="$2"; shift 2 ;;
    --daemon-port) DAEMON_PORT="$2"; shift 2 ;;
    --electron) ELECTRON_BIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep-userdata) KEEP_USERDATA=1; shift ;;
    --no-task) NO_TASK=1; shift ;;
    --summarize-only) SUMMARIZE_ONLY=1; shift ;;
    -h|--help)
      awk 'NR > 1 && /^set -euo pipefail$/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[measure] %s\n' "$*" >&2; }
die() { printf '[measure] error: %s\n' "$*" >&2; exit 1; }

SCENARIOS="$(printf '%s' "$SCENARIOS" | tr -d '[:space:]')"
[ "$(uname -s)" = "Darwin" ] || die "macOS only (the desktop shell is macOS-only)"
for c in curl python3 ps lsof node; do
  command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required (global WebSocket); found $(node -v)"
command -v footprint >/dev/null 2>&1 || log "warning: footprint not found; phys_footprint unavailable, RSS only"
if [ "$SUMMARIZE_ONLY" != "1" ] && [ "$DAEMON_PORT" != "7777" ]; then
  die "the desktop shell hardcodes :7777; --daemon-port/KIN_PORT=$DAEMON_PORT cannot point it elsewhere"
fi
case ",$SCENARIOS," in
  *,soak,*)
    [ "$SOAK_INTERVAL" -ge 5 ] 2>/dev/null || die "--soak-interval must be >= 5 seconds"
    [ "$SOAK_MINUTES" -ge 10 ] 2>/dev/null \
      || log "warning: soaks shorter than 10 minutes get no growth estimate"
    ;;
esac

if [ -z "$OUT" ]; then
  OUT="$ROOT/.tmp/measure-desktop-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$OUT/logs" "$OUT/userdata" "$OUT/harness"
OUT="$(cd "$OUT" && pwd)"   # the launcher subshell changes directory

if [ "$SUMMARIZE_ONLY" = "1" ]; then
  [ -f "$OUT/tree-samples.csv" ] \
    || die "no tree-samples.csv in $OUT; nothing to summarize"
else
  [ -f "$DESKTOP/dist/main.js" ] && [ -f "$DESKTOP/dist/preload.js" ] \
    || die "desktop bundle missing; run: (cd desktop && npm install && npm run build)"
  if [ -z "$ELECTRON_BIN" ]; then
    ELECTRON_BIN="$(cd "$DESKTOP" && node -p 'require("electron")' 2>/dev/null || true)"
  fi
  [ -n "$ELECTRON_BIN" ] && [ -x "$ELECTRON_BIN" ] \
    || die "Electron binary not found; run: (cd desktop && npm install) or pass --electron PATH"
fi

TOKEN=""
read_token() {
  TOKEN="$(cat "$HOME/.kin/token" 2>/dev/null || true)"
  [ -n "$TOKEN" ] || die "no daemon token at ~/.kin/token (start the daemon once)"
}

api_get() { # path
  curl -sS -m 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$DAEMON_PORT$1"
}
api_post() { # path, json
  curl -sS -m 30 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST "http://127.0.0.1:$DAEMON_PORT$1" -d "$2"
}
api_delete() { # path
  curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    -X DELETE "http://127.0.0.1:$DAEMON_PORT$1"
}

now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000'
  else
    python3 -c 'import time; print(int(time.time()*1000))'
  fi
}

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

# ---------------------------------------------------------------------------
# Launcher and CDP helpers
# ---------------------------------------------------------------------------

cat > "$OUT/harness/package.json" <<'JSON'
{"name":"kin-measure-launcher","main":"main.js"}
JSON
cat > "$OUT/harness/main.js" <<'JS'
// Runs the real desktop bundle. Only two side effects are suppressed:
// the system-wide kin:// handler registration and focus stealing.
const { app, BrowserWindow } = require("electron");
app.setAsDefaultProtocolClient = () => true;
BrowserWindow.prototype.show = function show() {
  this.showInactive();
};
BrowserWindow.prototype.focus = function focus() {};
require(process.env.KIN_MEASURE_BUNDLE);
JS

cat > "$OUT/cdp.mjs" <<'JS'
// Evaluate one expression in a CDP page target and print its value as JSON.
const [wsUrl, expr] = process.argv.slice(2);
const timer = setTimeout(() => {
  console.error("cdp: timeout");
  process.exit(2);
}, 8000);
const ws = new WebSocket(wsUrl);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: expr, returnByValue: true, awaitPromise: true },
  }));
});
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== 1) return;
  clearTimeout(timer);
  if (msg.error) {
    console.error("cdp: " + JSON.stringify(msg.error));
    process.exit(3);
  }
  const r = msg.result && msg.result.result;
  process.stdout.write(JSON.stringify(r && "value" in r ? r.value : null));
  ws.close();
});
ws.addEventListener("error", () => {
  clearTimeout(timer);
  console.error("cdp: websocket error");
  process.exit(4);
});
JS

cdp_target() { # port -> "wsurl<TAB>url" for the first page target
  local json
  json="$(curl -s -m 1 "http://127.0.0.1:$1/json/list" 2>/dev/null || true)"
  [ -n "$json" ] || return 0
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for t in items:
    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
        print(t["webSocketDebuggerUrl"] + "\t" + (t.get("url") or ""))
        break
'
}

cdp_eval() { # wsurl, expression
  node "$OUT/cdp.mjs" "$1" "$2"
}

# Return an object, not JSON.stringify(...): cdp.mjs prints the CDP value as
# JSON, and a string return value would arrive double-encoded.
READY_EXPR='({ready:document.readyState,root:document.querySelector("#root")?document.querySelector("#root").children.length:-1,fcp:Math.round((performance.getEntriesByName("first-contentful-paint")[0]||{startTime:-1}).startTime),fp:Math.round((performance.getEntriesByName("first-paint")[0]||{startTime:-1}).startTime),dcl:performance.timing.domContentLoadedEventEnd?performance.timing.domContentLoadedEventEnd-performance.timing.navigationStart:-1,load:performance.timing.loadEventEnd?performance.timing.loadEventEnd-performance.timing.navigationStart:-1,href:location.href})'

# wait_for_page PORT TIMEOUT_SEC [URL_SUBSTRING]
# Sets WAIT_WS / WAIT_URL / WAIT_TARGET_MS / WAIT_READY_MS / WAIT_JSON.
# With URL_SUBSTRING, waits until the page's own location contains it, so an
# about:blank or still-old document is not mistaken for the page under test.
WAIT_WS=""
WAIT_URL=""
WAIT_TARGET_MS=""
WAIT_READY_MS=""
WAIT_JSON=""
wait_for_page() {
  local port="$1" timeout="${2:-40}" want="${3:-}"
  local deadline=$(( $(date +%s) + timeout ))
  local tgt out ready href misses=0
  WAIT_READY_MS=""; WAIT_JSON=""
  if [ -z "$WAIT_WS" ]; then
    while [ "$(date +%s)" -lt "$deadline" ]; do
      tgt="$(cdp_target "$port")" || true
      if [ -n "$tgt" ]; then
        WAIT_WS="${tgt%%$'\t'*}"
        WAIT_URL="${tgt#*$'\t'}"
        WAIT_TARGET_MS="$(now_ms)"
        break
      fi
      sleep 0.05
    done
  fi
  [ -n "$WAIT_WS" ] || return 1
  local ready_ms="" fcp="" after=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    out="$(cdp_eval "$WAIT_WS" "$READY_EXPR" 2>/dev/null || true)"
    if [ -z "$out" ] || [ "$out" = "null" ]; then
      # A navigation can replace the target; re-discover after a few misses.
      misses=$((misses + 1))
      if [ "$misses" -ge 10 ]; then
        misses=0
        tgt="$(cdp_target "$port")" || true
        if [ -n "$tgt" ]; then
          WAIT_WS="${tgt%%$'\t'*}"
          WAIT_URL="${tgt#*$'\t'}"
        fi
      fi
    fi
    if [ -n "$out" ] && [ "$out" != "null" ]; then
      IFS=$'\t' read -r ready href fcp < <(printf '%s' "$out" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("\t\t-1"); raise SystemExit
print("%s\t%s\t%s" % (d.get("ready",""), d.get("href",""), d.get("fcp",-1)))')
      if [ "$ready" = "complete" ] && { [ -z "$want" ] || case "$href" in *"$want"*) true ;; *) false ;; esac; }; then
        # DOM complete is the ready timestamp. Paint can land a frame or two
        # later, and a document caught mid-redirect may have no paint entry
        # yet, so keep polling for it without moving the ready timestamp.
        [ -n "$ready_ms" ] || ready_ms="$(now_ms)"
        WAIT_JSON="$out"
        if [ "$fcp" -ge 0 ] 2>/dev/null; then
          WAIT_READY_MS="$ready_ms"
          return 0
        fi
        # No paint entry after ~5s of polling: accept the ready document and
        # record fcp=-1 rather than spending the whole startup budget here.
        after=$((after + 1))
        if [ "$after" -gt 50 ]; then
          WAIT_READY_MS="$ready_ms"
          return 0
        fi
      fi
    fi
    sleep 0.1
  done
  if [ -n "$ready_ms" ]; then
    WAIT_READY_MS="$ready_ms"
    return 0
  fi
  return 1
}

navigate_to() { # wsurl, url
  local ws="$1" url="$2"
  cdp_eval "$ws" "location.assign($(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$url")); true" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Process trees and sampling
# ---------------------------------------------------------------------------

# all_pids ROOT -> root and every descendant, one per line
all_pids() {
  ps -Ao pid=,ppid= | awk -v r="$1" '
    { pp[$1] = $2 }
    END {
      inTree[r] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (p in pp) {
          if (!(p in inTree) && (pp[p] in inTree)) { inTree[p] = 1; changed = 1 }
        }
      }
      for (p in inTree) print p
    }'
}

# process_rows ROOT -> "pid<TAB>rss_kb<TAB>args" for root and descendants
process_rows() {
  local root="$1" psfile="$OUT/.ps.$$"
  ps -Ao pid=,ppid=,rss=,command= > "$psfile"
  awk -v r="$root" '
    {
      pid = $1; ppid = $2; rss = $3
      cmd = ""
      for (i = 4; i <= NF; i++) cmd = cmd (i > 4 ? " " : "") $i
      pp[pid] = ppid; rssOf[pid] = rss; cmdOf[pid] = cmd
    }
    END {
      inTree[r] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (p in pp) {
          if (!(p in inTree) && (pp[p] in inTree)) { inTree[p] = 1; changed = 1 }
        }
      }
      for (p in inTree) printf "%s\t%s\t%s\n", p, rssOf[p], cmdOf[p]
    }' "$psfile"
  rm -f "$psfile"
}

footprint_mb() { # pid -> footprint MB on stdout, empty when unavailable
  # `footprint -p` exits 66 when the pid vanished between the ps snapshot and
  # this call, and a short-lived daemon child does that often enough that an
  # unguarded call would abort a 60-minute soak under set -e/pipefail.
  #
  # This reads the `Footprint:` header. On this machine it tracked the
  # auxiliary `phys_footprint:` ledger (the value Activity Monitor shows)
  # within about 2%, and it is the number the W3 report quotes; reading the
  # auxiliary line instead would move every total by that much.
  command -v footprint >/dev/null 2>&1 || return 0
  footprint -p "$1" 2>/dev/null | awk -F'Footprint: ' '
    NF > 1 {
      split($2, a, " ")
      v = a[1] + 0
      u = a[2]
      if (u == "KB") v = v / 1024
      else if (u == "GB") v = v * 1024
      printf "%.1f\n", v
      exit
    }' || true
}

classify_electron() { # args
  case "$1" in
    *--type=renderer*) echo renderer ;;
    *--type=gpu-process*) echo gpu ;;
    *--type=utility*) echo utility ;;
    *--type=crashpad-handler*) echo crashpad ;;
    *) echo main ;;
  esac
}

classify_daemon() { # args
  # Only the supervisor and the server are daemon overhead. Any other kin CLI
  # or agent process is a child and goes in the separate columns: a task's
  # model process must not be counted as daemon memory.
  case "$1" in
    *" supervise"*) echo supervise ;;
    *" serve"*) echo serve ;;
    *) echo daemon-child ;;
  esac
}

# sample_electron SCENARIO RUN MAIN_PID
# Appends per-process rows to samples.csv; sets E_PROCS / E_RSS / E_FP for the
# combined tree row that sample_all writes.
E_PROCS=0
E_RSS=0
E_FP=0
E_FP_MISSING=0
sample_electron() {
  local scenario="$1" run="$2" main="$3" ts rows rss_mb fp_mb procs=0
  ts="$(date +%s)"
  rows="$OUT/.rows.$$"
  process_rows "$main" > "$rows"
  : > "$OUT/.e.$$"
  while IFS=$'\t' read -r pid rss args; do
    [ -n "$pid" ] || continue
    # A process that exited between ps and footprint contributes no row.
    rss_mb="$(awk -v k="$rss" 'BEGIN{printf "%.1f", k/1024}')"
    fp_mb="$(footprint_mb "$pid")"
    cls="$(classify_electron "$args")"
    printf '%s,%s,%s,%s,%s,%s,%s\n' "$ts" "$scenario" "$run" "$pid" "$cls" "$rss_mb" "${fp_mb:-}" >> "$OUT/samples.csv"
    printf '%s\t%s\t%s\n' "$pid" "$rss_mb" "${fp_mb}" >> "$OUT/.e.$$"
    procs=$((procs + 1))
  done < "$rows"
  rm -f "$rows"
  # An absent footprint stays absent: summing it as zero would let a missing
  # metric silently pass the 400 MB check.
  read -r E_RSS E_FP E_FP_MISSING < <(awk -F'\t' '
    { r += $2; if ($3 != "") { f += $3; n++ } }
    END { printf "%.1f %.1f %d\n", r, f, NR - n }' "$OUT/.e.$$")
  rm -f "$OUT/.e.$$"
  E_PROCS=$procs
  log "  electron[$scenario/$run] procs=$procs rss=${E_RSS}MB footprint=${E_FP}MB missing_footprint=$E_FP_MISSING"
}

# daemon_root -> topmost kin ancestor of whatever listens on DAEMON_PORT
daemon_root() {
  local listener ppid pcmd
  listener="$(lsof -tiTCP:"$DAEMON_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -n "$listener" ] || return 0
  while :; do
    ppid="$(ps -p "$listener" -o ppid= 2>/dev/null | tr -d ' ' || true)"
    [ -n "$ppid" ] || break
    [ "$ppid" -le 1 ] && break
    pcmd="$(ps -p "$ppid" -o command= 2>/dev/null || true)"
    case "$pcmd" in
      *"/kin "*|*"/kin"|"kin "*|"kin") listener="$ppid" ;;
      *) break ;;
    esac
  done
  printf '%s\n' "$listener"
}

# sample_daemon SCENARIO RUN
# Appends per-process rows to daemon-samples.csv; sets D_* / C_* for the
# combined tree row. Agent/CLI children of the daemon are reported separately
# so a running task's model process is not mistaken for daemon overhead.
D_PROCS=0
D_RSS=0
D_FP=0
D_FP_MISSING=0
C_RSS=0
C_FP=0
sample_daemon() {
  local scenario="$1" run="$2" root ts rows pid rss args cls rss_mb fp_mb
  D_PROCS=0; D_RSS=0; D_FP=0; D_FP_MISSING=0; C_RSS=0; C_FP=0
  root="$(daemon_root)"
  [ -n "$root" ] || { log "  daemon: no listener on :$DAEMON_PORT"; return 0; }
  ts="$(date +%s)"
  rows="$OUT/.rows.$$"
  process_rows "$root" > "$rows"
  : > "$OUT/.d.$$"
  while IFS=$'\t' read -r pid rss args; do
    [ -n "$pid" ] || continue
    rss_mb="$(awk -v k="$rss" 'BEGIN{printf "%.1f", k/1024}')"
    fp_mb="$(footprint_mb "$pid")"
    cls="$(classify_daemon "$args")"
    printf '%s,%s,%s,%s,%s,%s,%s\n' "$ts" "$scenario" "$run" "$pid" "$cls" "$rss_mb" "${fp_mb:-}" >> "$OUT/daemon-samples.csv"
    printf '%s\t%s\t%s\t%s\n' "$pid" "$cls" "$rss_mb" "${fp_mb}" >> "$OUT/.d.$$"
  done < "$rows"
  rm -f "$rows"
  read -r D_RSS D_FP C_RSS C_FP D_PROCS D_FP_MISSING < <(awk -F'\t' '
    {
      if ($2 == "daemon-child") {
        cr += $3
        if ($4 != "") { cf += $4; cn++ } else { missing++ }
      } else {
        dr += $3
        if ($4 != "") { df += $4; n++ } else { missing++ }
      }
    }
    END { printf "%.1f %.1f %.1f %.1f %d %d\n", dr, df, cr, cf, n, missing }' "$OUT/.d.$$")
  rm -f "$OUT/.d.$$"
  log "  daemon[$scenario/$run] kin_procs=$D_PROCS rss=${D_RSS}MB footprint=${D_FP}MB missing_footprint=$D_FP_MISSING children_rss=${C_RSS}MB"
}

sample_all() { # scenario run main_pid
  sample_electron "$1" "$2" "$3"
  sample_daemon "$1" "$2"
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$(date +%s)" "$1" "$2" "$E_PROCS" "$E_RSS" "$E_FP" \
    "$D_PROCS" "$D_RSS" "$D_FP" "$C_RSS" "$C_FP" \
    "$E_FP_MISSING" "$D_FP_MISSING" >> "$OUT/tree-samples.csv"
}

# ---------------------------------------------------------------------------
# Launch / teardown
# ---------------------------------------------------------------------------

SHELL_PID=""
SHELL_LSTART=""
RUN_CDP=""
RUN_UD=""
RUN_LOG=""
T0=""

spawn_shell() { # scenario run
  local scenario="$1" run="$2" tgt deadline
  RUN_CDP="$(free_port)"
  RUN_UD="$OUT/userdata/$scenario-$run"
  RUN_LOG="$OUT/logs/$scenario-$run.log"
  rm -rf "$RUN_UD"
  mkdir -p "$RUN_UD"
  T0="$(now_ms)"
  (
    cd "$DESKTOP"
    exec env -u ELECTRON_RUN_AS_NODE -u LODY_ELECTRON_BOOTSTRAP -u KIN_DESKTOP_DEV \
      KIN_MEASURE_BUNDLE="$DESKTOP/dist/main.js" \
      "$ELECTRON_BIN" "$OUT/harness" \
      --user-data-dir="$RUN_UD" \
      --remote-debugging-port="$RUN_CDP" \
      >"$RUN_LOG" 2>&1
  ) &
  SHELL_PID=$!
  SHELL_LSTART="$(ps -p "$SHELL_PID" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  WAIT_WS=""; WAIT_URL=""; WAIT_TARGET_MS=""; WAIT_READY_MS=""; WAIT_JSON=""
  deadline=$(( $(date +%s) + 40 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$SHELL_PID" 2>/dev/null; then
      log "  shell exited during startup; tail of $RUN_LOG:"
      tail -20 "$RUN_LOG" >&2 || true
      SHELL_PID=""; SHELL_LSTART=""
      return 1
    fi
    tgt="$(cdp_target "$RUN_CDP")" || true
    if [ -n "$tgt" ]; then
      # Record the first sighting: this is the spawn→target startup metric.
      WAIT_WS="${tgt%%$'\t'*}"
      WAIT_URL="${tgt#*$'\t'}"
      WAIT_TARGET_MS="$(now_ms)"
      return 0
    fi
    sleep 0.05
  done
  # A launch that exposed no CDP target is still a live Electron tree; stop it
  # now instead of leaking it into the next scenario's samples.
  if kill -0 "$SHELL_PID" 2>/dev/null; then
    log "  no CDP target after 40s; stopping pid=$SHELL_PID"
    kill_shell "$SHELL_PID" || true
  fi
  SHELL_PID=""; SHELL_LSTART=""
  return 1
}

kill_shell() {
  local pid="${1:-$SHELL_PID}" pids p exe lstart now
  [ -n "$pid" ] || return 0
  # The app sets process.title = "Kin", so `ps -o command` for the main process
  # is just "Kin". The executable path from lsof is the reliable identity check,
  # and the recorded start time guards against the pid having been reused.
  exe="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  case "$exe" in
    *"$ELECTRON_BIN"*) ;;
    *) log "refusing to kill pid $pid: executable is '${exe:-unknown}', not this repo's Electron"; return 0 ;;
  esac
  now="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  if [ -n "$SHELL_LSTART" ] && [ "$now" != "$SHELL_LSTART" ]; then
    log "refusing to kill pid $pid: start time '$now' != recorded '$SHELL_LSTART' (pid reused)"
    return 0
  fi
  pids="$(all_pids "$pid" | tr '\n' ' ')"
  for p in $pids; do
    [ "$p" = "$$" ] && continue
    kill "$p" 2>/dev/null || true
  done
  sleep 2
  for p in $pids; do
    [ "$p" = "$$" ] && continue
    kill -9 "$p" 2>/dev/null || true
  done
  wait "$pid" 2>/dev/null || true
  if [ "$KEEP_USERDATA" != "1" ]; then
    rm -rf "$RUN_UD" 2>/dev/null || true
  fi
  SHELL_PID=""
  SHELL_LSTART=""
}

cleanup() {
  if [ -n "$SHELL_PID" ]; then
    log "cleanup: stopping measurement shell pid=$SHELL_PID"
    kill_shell "$SHELL_PID" || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# ---------------------------------------------------------------------------
# Startup probe
# ---------------------------------------------------------------------------

# measure_startup SCENARIO RUN -> appends a row to startup.csv
measure_startup() {
  local scenario="$1" run="$2" ok=0
  wait_for_page "$RUN_CDP" 40 ":$DAEMON_PORT" && ok=1 || true
  if [ "$ok" != "1" ]; then
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$(date +%s)" "$scenario" "$run" "" "" "" "" "" "" "" "no ready page" "no-cdp" \
      >> "$OUT/startup.csv"
    log "  startup[$scenario/$run] FAILED: no ready page"
    return 1
  fi
  local spawn_target spawn_ready nav_dcl nav_load fcp fp href rootn spawn_fcp
  spawn_target=$(( WAIT_TARGET_MS - T0 ))
  spawn_ready=$(( WAIT_READY_MS - T0 ))
  read -r nav_dcl nav_load fcp fp href rootn < <(printf '%s' "$WAIT_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("dcl", -1), d.get("load", -1), d.get("fcp", -1), d.get("fp", -1), d.get("href", ""), d.get("root", -1))
')
  # The app includes the bearer token in the load URL; never persist it.
  href="$(printf '%s' "$href" | sed -E 's/([?&]token=)[^&]*/\1<redacted>/g')"
  local note="ok"
  if [ "$fcp" -ge 0 ] 2>/dev/null; then
    spawn_fcp=$(( spawn_target + fcp ))
    [ "$rootn" -gt 0 ] 2>/dev/null || note="no-mount"
  else
    spawn_fcp=""
    note="no-fcp"
  fi
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$(date +%s)" "$scenario" "$run" "$spawn_target" "$spawn_ready" "$nav_dcl" "$nav_load" "$fcp" "$spawn_fcp" "$(printf '%s' "$href" | tr ',' ';')" "$note" "ok" \
    >> "$OUT/startup.csv"
  log "  startup[$scenario/$run] spawn→target=${spawn_target}ms spawn→ready=${spawn_ready}ms fcp=${fcp}ms total≈${spawn_fcp}ms"
}

# ---------------------------------------------------------------------------
# Scenario implementations
# ---------------------------------------------------------------------------

settled_samples() { # scenario run
  local scenario="$1" run="$2" i
  sleep "$SETTLE_SECONDS"
  for i in $(seq 1 "$SAMPLES"); do
    sample_all "$scenario" "$run" "$SHELL_PID"
    if [ "$i" -lt "$SAMPLES" ]; then sleep "$SAMPLE_INTERVAL"; fi
  done
}

run_idle() {
  local i
  for i in $(seq 1 "$RUNS"); do
    log "idle run $i/$RUNS"
    spawn_shell idle "$i" || { log "idle run $i: launch failed"; continue; }
    measure_startup idle "$i" || true
    settled_samples idle "$i"
    kill_shell
  done
}

longest_session_id() {
  api_get "/api/tasks?limit=200" | python3 -c '
import json, sys
try:
    tasks = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # a transient API failure must not abort the run
best = None
for t in tasks:
    if t.get("status") == "running":
        continue
    score = (t.get("tokens_in") or 0) + (t.get("tokens_out") or 0)
    if best is None or score > best[0]:
        best = (score, t.get("id"))
if best:
    print(best[1])
' || true
}

run_session() {
  local i sid
  sid="$SESSION_ID"
  if [ -z "$sid" ]; then
    sid="$(longest_session_id)"
  fi
  [ -n "$sid" ] || { log "session: no session id available; skipping"; return 0; }
  log "session: opening /tasks/$sid"
  for i in $(seq 1 "$RUNS"); do
    log "session run $i/$RUNS"
    spawn_shell session "$i" || { log "session run $i: launch failed"; continue; }
    # Wait for the app's own /new load before navigating the same renderer, or
    # the app's loadURL can land after ours and win.
    wait_for_page "$RUN_CDP" 40 ":$DAEMON_PORT" || true
    navigate_to "$WAIT_WS" "http://127.0.0.1:$DAEMON_PORT/tasks/$sid"
    wait_for_page "$RUN_CDP" 40 "/tasks/$sid" || log "session run $i: task page did not become ready"
    settled_samples session "$i"
    kill_shell
  done
}

probe_cwd() {
  local repo="$ROOT/.tmp/measure-probe-repo"
  if [ ! -d "$repo/.git" ]; then
    mkdir -p "$repo"
    ( cd "$repo" && git init -q \
      && git config user.email "probe@example.com" \
      && git config user.name "kin probe" \
      && printf 'probe\n' > README.md \
      && git add README.md && git commit -qm "probe repo" )
  fi
  printf '%s\n' "$repo"
}

probe_agent() {
  api_get /api/agents | python3 -c '
import json, sys
try:
    agents = json.load(sys.stdin)
except Exception:
    agents = []
for a in agents:
    if a.get("available") and a.get("default"):
        print(a.get("id")); raise SystemExit
for a in agents:
    if a.get("available"):
        print(a.get("id")); raise SystemExit
print("kin")
' || true
}

create_probe_task() { # run -> task id on stdout
  local run="$1" cwd title payload id
  cwd="$(probe_cwd)"
  title="w3-probe-footprint-$(date +%Y%m%d-%H%M%S)-$run"
  payload="$(python3 - "$cwd" "$title" "$(probe_agent)" <<'PY'
import json, sys
print(json.dumps({
    "agent": sys.argv[3],
    "cwd": sys.argv[1],
    "prompt": "Reply with exactly: ok. Do not use any tools and do not read or write files.",
    "title": sys.argv[2],
    "permission_mode": "default",
    "workspace_mode": "shared",
}))
PY
)"
  id="$(api_post /api/tasks "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id",""))
except Exception: pass' || true)"
  [ -n "$id" ] || return 1
  printf '%s\n' "$id"
}

wait_task_terminal() { # id timeout_sec -> status on stdout
  local id="$1" timeout="${2:-180}" deadline status
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(api_get "/api/tasks/$id" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("status",""))
except Exception: pass' || true)"
    case "$status" in
      succeeded|failed|canceled) printf '%s\n' "$status"; return 0 ;;
    esac
    sleep 1
  done
  printf 'timeout\n'
  return 1
}

run_task() {
  local n="$TASK_RUNS" i id status del
  [ "$NO_TASK" = "1" ] && { log "task: skipped (--no-task)"; return 0; }
  [ "$n" -gt "$RUNS" ] && n="$RUNS"
  for i in $(seq 1 "$n"); do
    log "task run $i/$n: launching shell"
    spawn_shell task "$i" || { log "task run $i: launch failed"; continue; }
    # Create the task only after the shell is up, so the shell observes the
    # whole run (creation, live updates, terminal state) rather than a page
    # that was already finished before the renderer existed.
    wait_for_page "$RUN_CDP" 40 ":$DAEMON_PORT" || true
    log "task run $i: creating probe task"
    if ! id="$(create_probe_task "$i")"; then
      log "task run $i: create failed; skipping"
      kill_shell
      continue
    fi
    log "task run $i: probe task $id"
    navigate_to "$WAIT_WS" "http://127.0.0.1:$DAEMON_PORT/tasks/$id"
    wait_for_page "$RUN_CDP" 40 "/tasks/$id" || log "task run $i: task page did not become ready"
    status="$(wait_task_terminal "$id" 180 || true)"
    log "task run $i: status=$status"
    settled_samples task "$i"
    kill_shell
    del="$(api_delete "/api/tasks/$id" || true)"
    printf '%s,%s,%s,%s,%s,%s\n' "$(date +%s)" "task" "$i" "$id" "$status" "$del" >> "$OUT/task-runs.csv"
    case "$del" in
      2*) log "task run $i: deleted probe task $id" ;;
      *) log "task run $i: DELETE $id returned ${del:-no response}; task may remain" ;;
    esac
  done
}

run_soak() {
  local sid="$SOAK_SESSION_ID" end i=0
  log "soak: ${SOAK_MINUTES}m, sampling every ${SOAK_INTERVAL}s"
  spawn_shell soak 1 || { log "soak: launch failed"; return 0; }
  if [ -n "$sid" ]; then
    # Let the app finish its own loadURL("/new") first, or it can land after
    # ours and replace the task page with the home view.
    wait_for_page "$RUN_CDP" 40 ":$DAEMON_PORT" || true
    navigate_to "$WAIT_WS" "http://127.0.0.1:$DAEMON_PORT/tasks/$sid"
    wait_for_page "$RUN_CDP" 40 "/tasks/$sid" || true
  fi
  end=$(( $(date +%s) + SOAK_MINUTES * 60 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    i=$((i + 1))
    sample_all soak 1 "$SHELL_PID"
    if [ "$(date +%s)" -lt "$end" ]; then sleep "$SOAK_INTERVAL"; fi
  done
  kill_shell
  log "soak: done, $i samples"
}

run_startup() {
  local i
  for i in $(seq 1 "$RUNS"); do
    log "startup run $i/$RUNS"
    spawn_shell startup "$i" || { log "startup run $i: launch failed"; continue; }
    measure_startup startup "$i" || true
    kill_shell
  done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# Measurement mode. --summarize-only skips everything below and recomputes the
# summary from the CSVs already in --out.
if [ "$SUMMARIZE_ONLY" != "1" ]; then
read_token
version_json="$(api_get /api/version || true)"
# The shell attaches to a healthy daemon but spawns one when none answers. A
# measurement must never create the daemon it claims only to observe.
printf '%s' "$version_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if d.get("version") else 1)' \
  || die "no healthy daemon on :$DAEMON_PORT; start it before measuring (the shell would spawn one)"
DAEMON_ROOT="$(daemon_root)"
[ -n "$DAEMON_ROOT" ] || die "no kin process listening on :$DAEMON_PORT"
DAEMON_LSTART="$(ps -p "$DAEMON_ROOT" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"

python3 - "$OUT/meta.json" "$DAEMON_PORT" "$ELECTRON_BIN" "$version_json" "$DESKTOP" "$ROOT" "$DAEMON_ROOT" "$DAEMON_LSTART" <<'PY'
import hashlib, json, os, platform, shutil, subprocess, sys, time
out, port, electron, version, desktop, repo, daemon_pid, daemon_lstart = sys.argv[1:9]
try:
    daemon_version = json.loads(version)
except Exception:
    daemon_version = version
# The raw directory is local, but it is also the thing a report might share;
# the owner's desktop identity is not measurement data.
if isinstance(daemon_version, dict):
    daemon_version.pop("desktop_id", None)
    if "desktop_name" in daemon_version:
        daemon_version["desktop_name"] = "<redacted>"
pkg = json.load(open(os.path.join(desktop, "package.json")))
# `electron --version` under ELECTRON_RUN_AS_NODE prints the bundled Node
# version, so read the dist's own version file instead.
dist_version = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(electron)))), "version"
)
try:
    electron_version = open(dist_version).read().strip()
except OSError:
    electron_version = None
meta = {
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "os": platform.platform(),
    "machine": platform.machine(),
    "daemon_port": int(port),
    "daemon_version": daemon_version,
    "electron": electron,
    "electron_version": electron_version,
    "electron_pkg_range": pkg.get("devDependencies", {}).get("electron"),
    "node": subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip(),
    "git_sha": subprocess.run(
        ["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip(),
    "bundle_sha256": hashlib.sha256(
        open(os.path.join(desktop, "dist", "main.js"), "rb").read()
    ).hexdigest(),
    "daemon_pid": int(daemon_pid),
    "daemon_lstart": daemon_lstart,
    "has_footprint": shutil.which("footprint") is not None,
}
open(out, "w").write(json.dumps(meta, indent=2) + "\n")
PY

printf 'ts,scenario,run,pid,class,rss_mb,footprint_mb\n' > "$OUT/samples.csv"
printf 'ts,scenario,run,electron_procs,electron_rss_mb,electron_footprint_mb,daemon_procs,daemon_rss_mb,daemon_footprint_mb,daemon_children_rss_mb,daemon_children_footprint_mb,electron_footprint_missing,daemon_footprint_missing\n' > "$OUT/tree-samples.csv"
printf 'ts,scenario,run,daemon_pid,daemon_class,rss_mb,footprint_mb\n' > "$OUT/daemon-samples.csv"
printf 'ts,scenario,run,spawn_to_target_ms,spawn_to_ready_ms,nav_dcl_ms,nav_load_ms,fcp_ms,spawn_to_fcp_ms,url,note,result\n' > "$OUT/startup.csv"
printf 'ts,scenario,run,task_id,status,delete_status\n' > "$OUT/task-runs.csv"

IFS=',' read -r -a WANT <<< "$SCENARIOS"
for scenario in "${WANT[@]}"; do
  case "$scenario" in
    idle) run_idle ;;
    session) run_session ;;
    task) run_task ;;
    soak) run_soak ;;
    startup) run_startup ;;
    "") ;;
    *) die "unknown scenario: $scenario" ;;
  esac
done
fi

python3 - "$OUT" <<'PY'
import csv, json, math, os, sys

out = sys.argv[1]

def read(name):
    path = os.path.join(out, name)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))

def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def stats(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return {"n": 0}
    n = len(vals)
    mean = sum(vals) / n
    var = sum((v - mean) ** 2 for v in vals) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    # nearest-rank p95; with n=5 this is the maximum, stated in the report
    k = max(0, math.ceil(0.95 * n) - 1)
    return {
        "n": n,
        "median": round(vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2, 1),
        "p95": round(vals[k], 1),
        "min": round(vals[0], 1),
        "max": round(vals[-1], 1),
        "stdev": round(sd, 1),
        "cv_pct": round(100 * sd / mean, 1) if mean else None,
    }

def median(values):
    vals = sorted(values)
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2

def per_run(rows, key, scenario):
    runs = {}
    for r in rows:
        if r["scenario"] != scenario:
            continue
        v = fnum(r[key])
        if v is None:
            continue
        runs.setdefault(r["run"], []).append(v)
    # median of the settled samples inside each run, then across runs
    inner = {run: median(v) for run, v in runs.items() if v}
    return stats(inner.values()), inner

tree = read("tree-samples.csv")
startup = read("startup.csv")
summary = {"electron_tree": {}, "daemon_tree": {}, "startup": {}, "soak": {}}

for scenario in sorted({r["scenario"] for r in tree}):
    summary["electron_tree"][scenario] = {
        "rss_mb": per_run(tree, "electron_rss_mb", scenario)[0],
        "footprint_mb": per_run(tree, "electron_footprint_mb", scenario)[0],
    }
    summary["daemon_tree"][scenario] = {
        "rss_mb": per_run(tree, "daemon_rss_mb", scenario)[0],
        "footprint_mb": per_run(tree, "daemon_footprint_mb", scenario)[0],
    }

for key in ("spawn_to_target_ms", "spawn_to_ready_ms", "nav_dcl_ms", "nav_load_ms", "fcp_ms", "spawn_to_fcp_ms"):
    # -1 means "the page had no such timing entry", not a negative duration.
    vals = [v for v in (fnum(r.get(key)) for r in startup if r.get("result") == "ok")
            if v is not None and v >= 0]
    summary["startup"][key] = stats(vals)

# Soak growth: least-squares slope of the tree total over elapsed seconds.
# Always drop the first four samples (two minutes at the default 30s interval):
# they contain the post-launch settling curve, which is startup cost, not a
# leak. Refuse to report a slope from a window too short to mean anything --
# an untrimmed four-minute soak fits the launch ascent as +100 MB/h.
MIN_SOAK_SAMPLES = 8
soak_all = [r for r in tree if r["scenario"] == "soak"]
soak = soak_all[4:] if len(soak_all) > 4 else []

def slope(key):
    pts = [(float(r["ts"]), fnum(r[key])) for r in soak if fnum(r[key]) is not None]
    if len(pts) < MIN_SOAK_SAMPLES:
        return None, None
    t0 = pts[0][0]
    xs = [t - t0 for t, _ in pts]
    ys = [y for _, y in pts]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None, None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (my + b * (x - mx))) ** 2 for x, y in zip(xs, ys))
    r2 = round(1 - ss_res / ss_tot, 3) if ss_tot else None
    return round(b * 3600, 2), r2

if len(soak) >= MIN_SOAK_SAMPLES:
    fp_growth, fp_r2 = slope("electron_footprint_mb")
    rss_growth, rss_r2 = slope("electron_rss_mb")
    d_growth, d_r2 = slope("daemon_footprint_mb")
    summary["soak"] = {
        "minutes": round((float(soak[-1]["ts"]) - float(soak[0]["ts"])) / 60, 1),
        "samples": len(soak),
        "samples_before_trim": len(soak_all),
        "electron_footprint_start_mb": fnum(soak[0]["electron_footprint_mb"]),
        "electron_footprint_end_mb": fnum(soak[-1]["electron_footprint_mb"]),
        "electron_footprint_growth_mb_per_h": fp_growth,
        "electron_footprint_r2": fp_r2,
        "electron_rss_growth_mb_per_h": rss_growth,
        "electron_rss_r2": rss_r2,
        "daemon_footprint_growth_mb_per_h": d_growth,
        "daemon_footprint_r2": d_r2,
    }
else:
    summary["soak"] = {
        "samples_before_trim": len(soak_all),
        "samples": len(soak),
        "insufficient": True,
        "reason": f"fewer than {MIN_SOAK_SAMPLES} samples after the settling window",
        "electron_footprint_growth_mb_per_h": None,
        "electron_rss_growth_mb_per_h": None,
        "daemon_footprint_growth_mb_per_h": None,
    }

# A missing footprint must be visible, not folded into the total as zero.
summary["missing_footprint_samples"] = {
    "electron": sum(int(fnum(r.get("electron_footprint_missing")) or 0) for r in tree),
    "daemon": sum(int(fnum(r.get("daemon_footprint_missing")) or 0) for r in tree),
}
summary["footprint_reported"] = any(
    r.get("electron_footprint_mb") not in (None, "") for r in tree
)

# Per-process-class breakdown for the idle scenario.
classes = {}
detail = read("samples.csv")
for r in detail:
    if r["scenario"] != "idle":
        continue
    classes.setdefault(r["class"], []).append(fnum(r["footprint_mb"]))
summary["idle_by_process"] = {k: stats(v) for k, v in sorted(classes.items())}

with open(os.path.join(out, "summary.json"), "w") as f:
    json.dump(summary, f, indent=2, sort_keys=True)

lines = []
lines.append("OpenKin desktop footprint summary")
lines.append("")
for scenario in sorted(summary["electron_tree"]):
    e = summary["electron_tree"][scenario]
    d = summary["daemon_tree"].get(scenario, {})
    lines.append(f"{scenario}: electron footprint {e['footprint_mb']}  rss {e['rss_mb']}")
    lines.append(f"{scenario}: daemon   footprint {d.get('footprint_mb')}  rss {d.get('rss_mb')}")
lines.append("")
lines.append("startup (ms):")
for k, v in summary["startup"].items():
    lines.append(f"  {k}: {v}")
lines.append("")
lines.append("idle by process (footprint MB):")
for k, v in summary["idle_by_process"].items():
    lines.append(f"  {k}: {v}")
lines.append("")
lines.append(f"missing footprint samples: {summary['missing_footprint_samples']}")
lines.append("")
lines.append("soak:")
lines.append(f"  {summary['soak']}")
open(os.path.join(out, "summary.txt"), "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
PY

log "wrote $OUT/summary.txt"
log "raw: samples.csv tree-samples.csv daemon-samples.csv startup.csv task-runs.csv"
