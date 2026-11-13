#!/usr/bin/env bash
# Daily sync + gate + rebuild-and-relaunch.
#
# The hourly gap sweep lands fixes on origin/main. This is the release half:
# once a day it proves origin/main's CI is green and that merging it into this
# checkout still passes the local gate, then hands the rebuild to launchd.
#
# The handoff is the point. `desktop-rebuild.sh` restarts the :7777 node, and
# that node is the process running this script's task. A rebuild started as a
# child of the task would kill its own parent; a launchd job is not in that
# process tree, so it survives the restart and relaunches the app. The job
# verifies its own result (health + the Electron process) and writes the
# success marker the next run uses to skip an unchanged HEAD.
#
# Guarantees:
#   - a commit whose origin/main CI is not green is never deployed;
#   - a tree that fails the local gate is never deployed (the local branch has
#     commits CI has not seen);
#   - tracked or untracked uncommitted files block the deploy instead of
#     riding along, and the rebuild re-checks the tree after the delay;
#   - nothing is pushed, force-pushed, reset, or rewritten.
#
# Usage, from the primary checkout:
#   ./scripts/daily-deploy.sh               # gate, merge, schedule the rebuild
#   ./scripts/daily-deploy.sh --check-only  # gate and merge, do not rebuild
#   ./scripts/daily-deploy.sh --dry-run     # report the plan, change nothing
#   ./scripts/daily-deploy.sh --force       # rebuild even if HEAD already shipped
#
# Environment:
#   KIN_DEPLOY_DIR         state/log directory (default ~/.kin/deploy)
#   KIN_DEPLOY_DELAY       seconds between scheduling and the rebuild (default 300)
#   KIN_DEPLOY_NO_NOTIFY   set to 1 to suppress system notifications (tests)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

GIT=/usr/bin/git
GH=/opt/homebrew/bin/gh
DEPLOY_DIR="${KIN_DEPLOY_DIR:-$HOME/.kin/deploy}"
DELAY="${KIN_DEPLOY_DELAY:-300}"
LABEL_PREFIX=dev.openkin.daily-deploy
LAST_RUN="$DEPLOY_DIR/last-run.json"
LAST_SUCCESS="$DEPLOY_DIR/last-success.json"
LAST_REBUILD_FAILURE="$DEPLOY_DIR/last-rebuild-failure.json"
LOCK="$DEPLOY_DIR/lock"

MODE=deploy
FORCE=0
RUN_HEAD=""
RUN_LOG=""
RUN_LABEL=""
while (($#)); do
  case "$1" in
    --check-only) MODE=check; shift ;;
    --dry-run) MODE=dry; shift ;;
    --force) FORCE=1; shift ;;
    --run-rebuild)
      [[ $# -ge 4 ]] || { echo "usage: $0 --run-rebuild <head> <log> <label>" >&2; exit 2; }
      MODE=rebuild
      RUN_HEAD="$2"
      RUN_LOG="$3"
      RUN_LABEL="$4"
      shift 4
      ;;
    -h|--help) awk 'NR > 1 && /^set -uo/{exit} NR > 1' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$DELAY" =~ ^[0-9]+$ ]] || DELAY=300

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ORIGIN_SHA=""
HEAD_AFTER=""
REPO=""

say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

notify() { # title message
  [[ "${KIN_DEPLOY_NO_NOTIFY:-0}" == "1" ]] && return 0
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier -title "$1" -message "$2" -sound Glass >/dev/null 2>&1 || true
  else
    osascript -e "display notification \"$2\" with title \"$1\" sound name \"Glass\"" >/dev/null 2>&1 || true
  fi
}

json_field() { # file key
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' \
    "$1" "$2" 2>/dev/null || true
}

write_status() { # path status reason head log
  python3 - "$1" "$2" "$3" "$4" "$5" <<'PY' 2>/dev/null || true
import datetime, json, os, sys
path, status, reason, head, log = sys.argv[1:6]
now = datetime.datetime.now().astimezone()
data = {
    "at": int(now.timestamp()),
    "at_iso": now.isoformat(timespec="seconds"),
    "status": status,
    "reason": reason,
    "head": head,
    "log": log,
}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

write_last_run() { # head log method label
  python3 - "$LAST_RUN" "$ORIGIN_SHA" "$1" "$2" "$3" "$4" <<'PY' || return 1
import datetime, json, os, sys
path, origin, head, log, method, label = sys.argv[1:7]
now = datetime.datetime.now().astimezone()
data = {
    "at": int(now.timestamp()),
    "at_iso": now.isoformat(timespec="seconds"),
    "status": "scheduled",
    "origin_sha": origin,
    "head": head,
    "log": log,
    "method": method,
    "label": label,
}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

fail() { # reason
  say "FAIL: $*"
  if [[ "$MODE" != "dry" ]]; then
    mkdir -p "$DEPLOY_DIR" 2>/dev/null || true
    write_status "$DEPLOY_DIR/last-failure.json" failed "$*" \
      "$("$GIT" rev-parse HEAD 2>/dev/null || true)" ""
    notify "OpenKin 每日部署" "未发布：$*"
  fi
  exit 1
}

acquire_lock() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [[ -n "$(find "$LOCK" -maxdepth 1 -mmin +180 2>/dev/null)" ]]; then
      say "removing a stale lock ($LOCK)"
      rmdir "$LOCK" 2>/dev/null || true
    fi
    mkdir "$LOCK" 2>/dev/null || fail "another daily-deploy is still running ($LOCK)"
  fi
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}

# The CI gate. A green local gate on a merge of an unverified tip is not the
# contract the user asked for: origin/main's own checks must have passed first.
#
# GitHub keeps superseded check runs (a rerun leaves the old failure in the
# list), and this repo's commits can also carry checks from other apps. Take
# only GitHub Actions runs and only the latest attempt per job name; otherwise
# a rerun-to-green tip looks red forever and the deploy never runs.
require_ci() {
  local deadline=$((SECONDS + 900)) summary pending failed missing names
  while :; do
    summary="$("$GH" api "repos/$REPO/commits/$ORIGIN_SHA/check-runs" --jq '
      [.check_runs[]
       | select(.app.slug == "github-actions")
       | {name, status, conclusion, started_at}]
      | group_by(.name)
      | map(max_by(.id // 0)) as $r
      | [($r | length),
         ([$r[] | select(.status != "completed")] | length),
         ([$r[] | select(.status == "completed" and .conclusion != "success")] | length),
         ((["build", "desktop", "smoke"]
           - [$r[] | select(.status == "completed" and .conclusion == "success") | .name]) | length),
         ([$r[].name] | unique | join(","))]
      | @tsv
    ' 2>/dev/null)" || fail "cannot read check runs for ${ORIGIN_SHA:0:9}"

    IFS=$'\t' read -r _ pending failed missing names <<<"$summary"
    if [[ "${failed:-1}" != "0" ]]; then
      fail "origin/main CI has a failing check (${names:-none})"
    fi
    if [[ "${pending:-1}" != "0" ]]; then
      if ((SECONDS >= deadline)); then
        fail "origin/main CI still pending after 15m (${names:-none})"
      fi
      say "waiting for origin/main CI: $pending check(s) still running"
      sleep 20
      continue
    fi
    if [[ "${missing:-1}" != "0" ]]; then
      fail "origin/main CI is missing build/desktop/smoke (saw: ${names:-none})"
    fi
    say "origin/main CI is green: $names"
    return 0
  done
}

ensure_ui_deps() {
  local stamp=ui/node_modules/.package-lock.json
  if [[ ! -d ui/node_modules || ! -f "$stamp" \
    || ui/package.json -nt "$stamp" || ui/package-lock.json -nt "$stamp" ]]; then
    say "installing console dependencies"
    ( cd ui && npm ci ) || return 1
  fi
}

ensure_desktop_deps() {
  if [[ ! -d desktop/node_modules ]]; then
    say "installing desktop dependencies (first run downloads Electron)"
    ( cd desktop && npm install ) || return 1
  fi
  # `npm ci --ignore-scripts` leaves a tree that typechecks and passes the
  # node tests but has no Electron binary; desktop-rebuild.sh would then skip
  # its own install and the launch would fail after printing [5/5].
  local bin="desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [[ ! -x "$bin" ]]; then
    say "the Electron binary is missing; running its install script"
    ( cd desktop && npm rebuild electron ) || return 1
    [[ -x "$bin" ]] || { say "still missing $bin"; return 1; }
  fi
}

# Is this checkout's Electron actually running? The main process's argv can be
# just "Kin", so check the executable the app was launched from, then fall back
# to a process named Kin whose cwd is this checkout (the same test
# desktop-rebuild.sh uses to stop the previous instance).
desktop_running() {
  local markers=(
    "$ROOT/desktop/node_modules/electron/dist/Kin.app/Contents/MacOS/Kin"
    "$ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    "$ROOT/desktop/.dev-app/Kin.app/Contents/MacOS/Kin"
  )
  local m pid cwd
  if command -v lsof >/dev/null 2>&1; then
    for m in "${markers[@]}"; do
      [[ -e "$m" ]] || continue
      if [[ -n "$(lsof -t "$m" 2>/dev/null || true)" ]]; then
        return 0
      fi
    done
    if command -v pgrep >/dev/null 2>&1; then
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
        case "$cwd" in
          "$ROOT/desktop"|"$ROOT/desktop"/*) return 0 ;;
        esac
      done < <(pgrep -x Kin 2>/dev/null || true)
    fi
  fi
  return 1
}

# Count Kin tasks that are still doing work. The rebuild restarts the node
# that hosts them; 06:00 is also the hourly gap sweep's slot, so waiting for
# idle keeps the two routines from stepping on each other. Returns 2 when the
# list cannot be read (the node may be down; no task can be running in it).
kin_active_tasks() {
  local token json
  token="$(cat "$HOME/.kin/token" 2>/dev/null || true)"
  [[ -n "$token" ]] || return 2
  json="$(curl -sS --connect-timeout 2 --max-time 10 \
    -H "Authorization: Bearer $token" \
    'http://127.0.0.1:7777/api/tasks?limit=200' 2>/dev/null)" || return 2
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    tasks = json.load(sys.stdin)
except Exception:
    sys.exit(2)
active = [t for t in tasks if t.get("status") in ("queued", "running", "waiting_approval", "waiting_input")]
print(len(active))
for t in active[:5]:
    print(t.get("id", ""), t.get("status", ""), (t.get("title") or "")[:60])
' 2>/dev/null
}

verify_gated_tree() {
  local now dirty
  now="$("$GIT" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$now" != "$RUN_HEAD" ]]; then
    say "refusing to rebuild: HEAD is ${now:-unknown}, gated $RUN_HEAD"
    return 1
  fi
  dirty="$("$GIT" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    say "refusing to rebuild: uncommitted changes appeared after the gate"
    printf '%s\n' "$dirty" | head -5
    return 1
  fi
  return 0
}

# Internal mode, run by the launchd job after the delay. It re-checks the tree
# at the last moment, starts the rebuild, and only writes the success marker
# after both the node and the desktop process are actually up. The final `wait`
# keeps the job alive as the Electron parent.
if [[ "$MODE" == "rebuild" ]]; then
  [[ -n "$RUN_HEAD" && -n "$RUN_LOG" && -n "$RUN_LABEL" ]] \
    || { echo "missing --run-rebuild arguments" >&2; exit 2; }
  mkdir -p "$DEPLOY_DIR" || exit 1
  mkdir -p "$(dirname "$RUN_LOG")" || exit 1
  exec >>"$RUN_LOG" 2>&1
  say "rebuild wrapper: verifying the gated tree"

  if ! verify_gated_tree; then
    write_status "$LAST_REBUILD_FAILURE" tree-changed "HEAD or working tree changed after the gate" "$RUN_HEAD" "$RUN_LOG"
    notify "OpenKin 每日部署" "重建已取消：闸门后代码或工作树变化"
    exit 1
  fi

  # The gap sweep runs on the hour too. Restarting the node under one of its
  # tasks kills it and counts toward the routine auto-disable limit, so let the
  # node go idle first, with a bound so one stuck task cannot block forever.
  say "waiting for other Kin tasks to finish before restarting the node"
  idle_deadline=$((SECONDS + 1800))
  while ((SECONDS < idle_deadline)); do
    if ! active="$(kin_active_tasks)"; then
      say "the Kin task list is unavailable; assuming no active tasks"
      break
    fi
    count="${active%%$'\n'*}"
    if [[ "$count" == "0" ]]; then
      say "no other Kin tasks are running"
      break
    fi
    say "still active: $count Kin task(s); waiting"
    sleep 30
  done
  if ((SECONDS >= idle_deadline)); then
    say "Kin tasks are still running after 30m; postponing the rebuild"
    write_status "$LAST_REBUILD_FAILURE" tasks-still-running "active Kin tasks after 30m" "$RUN_HEAD" "$RUN_LOG"
    notify "OpenKin 每日部署" "重建推迟：仍有 Kin 任务在运行"
    exit 1
  fi

  # The idle wait may have taken half an hour; the working tree is what gets
  # built, so check it again immediately before starting.
  if ! verify_gated_tree; then
    write_status "$LAST_REBUILD_FAILURE" tree-changed "HEAD or working tree changed after the gate" "$RUN_HEAD" "$RUN_LOG"
    notify "OpenKin 每日部署" "重建已取消：闸门后代码或工作树变化"
    exit 1
  fi

  # Stop the previous daily-deploy job only now: it is likely the Electron
  # parent, and any refusal above must leave the running app alone. Each run
  # has its own label, so this also cleans up jobs whose app already exited.
  if command -v launchctl >/dev/null 2>&1; then
    launchctl list 2>/dev/null | awk '/dev\.openkin\.daily-deploy/ {print $3}' | while IFS= read -r old_label; do
      [[ -z "$old_label" || "$old_label" == "$RUN_LABEL" ]] && continue
      say "stopping the previous deploy job: $old_label"
      launchctl remove "$old_label" >/dev/null 2>&1 || true
    done
  fi

  say "starting desktop-rebuild.sh"
  ./scripts/desktop-rebuild.sh &
  rebuild_pid=$!

  launched=0
  deadline=$((SECONDS + 1200))
  while ((SECONDS < deadline)); do
    if grep -qF '==> [5/5] launch desktop app' "$RUN_LOG"; then
      launched=1
      break
    fi
    if ! kill -0 "$rebuild_pid" 2>/dev/null; then
      break
    fi
    sleep 5
  done
  if ((launched == 0)); then
    say "the rebuild exited or stalled before the launch stage"
    write_status "$LAST_REBUILD_FAILURE" build-failed "did not reach the launch stage" "$RUN_HEAD" "$RUN_LOG"
    notify "OpenKin 每日部署" "重建失败：未到启动阶段（见日志）"
    exit 1
  fi

  # [5/5] only means the launch was attempted. Wait for the evidence the user
  # cares about: the console answers and this checkout's Electron is running.
  ok=0
  deadline=$((SECONDS + 240))
  while ((SECONDS < deadline)); do
    code="$(curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' \
      http://127.0.0.1:7777/api/health 2>/dev/null || true)"
    if [[ "$code" == "200" ]] && desktop_running; then
      ok=1
      break
    fi
    if ! kill -0 "$rebuild_pid" 2>/dev/null; then
      break
    fi
    sleep 5
  done

  if ((ok == 1)); then
    say "verified: /api/health is 200 and this checkout's Electron is running"
    write_status "$LAST_SUCCESS" succeeded "" "$RUN_HEAD" "$RUN_LOG"
    notify "OpenKin 每日部署" "已发布 ${RUN_HEAD:0:9}"
  else
    say "the console or the desktop did not come up"
    write_status "$LAST_REBUILD_FAILURE" launch-failed "health or desktop process did not come up" "$RUN_HEAD" "$RUN_LOG"
    notify "OpenKin 每日部署" "重建后应用未起来（见日志）"
    if kill -0 "$rebuild_pid" 2>/dev/null; then
      kill "$rebuild_pid" 2>/dev/null || true
    fi
    exit 1
  fi

  wait "$rebuild_pid" || true
  exit 0
fi

say "repository: $ROOT"

if [[ "$MODE" != "dry" ]]; then
  mkdir -p "$DEPLOY_DIR" 2>/dev/null || {
    echo "cannot create $DEPLOY_DIR" >&2
    exit 1
  }
fi

if [[ "$MODE" != "dry" ]]; then
  acquire_lock
fi

[[ -x "$GIT" ]] || fail "missing $GIT"
if [[ ! -x "$GH" ]]; then
  GH="$(command -v gh 2>/dev/null || true)"
fi
[[ -n "$GH" ]] || fail "gh not found"
for c in go npm node python3 curl; do
  command -v "$c" >/dev/null 2>&1 || fail "missing $c on PATH"
done
"$GH" auth status >/dev/null 2>&1 || fail "gh is not authenticated"

branch="$("$GIT" symbolic-ref --short HEAD 2>/dev/null || true)"
[[ "$branch" == "main" ]] || fail "current branch is '${branch:-detached}', expected main"
[[ -x scripts/desktop-rebuild.sh ]] || fail "scripts/desktop-rebuild.sh is missing"

REPO="$("$GH" repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" \
  || fail "cannot resolve the GitHub repository"
[[ -n "$REPO" ]] || fail "cannot resolve the GitHub repository"

say "fetching origin"
"$GIT" fetch --prune origin || fail "git fetch failed"
ORIGIN_SHA="$("$GIT" rev-parse origin/main 2>/dev/null)" || fail "no origin/main"
say "origin/main is ${ORIGIN_SHA:0:9}"

head_now="$("$GIT" rev-parse HEAD)"

# Skip only when this exact HEAD already passed the full gate *and* the rebuild
# that followed verified both the node and the desktop. The success marker is
# cleared when a new rebuild is scheduled, so a failed retry of the same HEAD
# cannot hide behind an older success.
if [[ "$MODE" == "deploy" && "$FORCE" != "1" ]]; then
  success_head="$(json_field "$LAST_SUCCESS" head)"
  success_at="$(json_field "$LAST_SUCCESS" at)"
  failure_head="$(json_field "$LAST_REBUILD_FAILURE" head)"
  failure_at="$(json_field "$LAST_REBUILD_FAILURE" at)"
  if [[ "$success_head" == "$head_now" && "$success_at" =~ ^[0-9]+$ ]] \
    && { [[ ! "$failure_at" =~ ^[0-9]+$ ]] || (( success_at >= failure_at )); } \
    && "$GIT" merge-base --is-ancestor "$ORIGIN_SHA" HEAD; then
    say "nothing to do: ${head_now:0:9} is already deployed (log: $(json_field "$LAST_SUCCESS" log))"
    exit 0
  fi
  sched_at="$(json_field "$LAST_RUN" at)"
  sched_head="$(json_field "$LAST_RUN" head)"
  if [[ "$sched_head" == "$head_now" && "$sched_at" =~ ^[0-9]+$ ]] \
    && (( $(date +%s) - sched_at < 2700 )); then
    if [[ "$failure_head" == "$head_now" && "$failure_at" =~ ^[0-9]+$ ]] \
      && (( failure_at >= sched_at )); then
      say "the previous rebuild for ${head_now:0:9} failed; retrying"
    else
      say "a rebuild for ${head_now:0:9} is still in progress (log: $(json_field "$LAST_RUN" log)); not starting another"
      exit 0
    fi
  fi
fi

require_ci

if [[ "$MODE" == "dry" ]]; then
  say "dry run: would merge origin/main into main, run the local gate,"
  say "and schedule a rebuild in ${DELAY}s. Nothing was changed."
  exit 0
fi

# Untracked files matter too: an untracked .go or .tsx file is compiled by the
# gate and the rebuild but is absent from the commit the gate claims to verify.
dirty="$("$GIT" status --porcelain)"
[[ -z "$dirty" ]] || fail "uncommitted changes; commit or restore them first: $(printf '%s' "$dirty" | head -5 | tr '\n' ';')"

BASE="$("$GIT" merge-base HEAD "$ORIGIN_SHA" 2>/dev/null)" || fail "no merge base with origin/main"

# The conflict path below rebuilds the console, so its dependencies must exist
# before the merge starts, not after a failed build.
ensure_ui_deps || fail "console dependencies could not be installed"

if "$GIT" merge-base --is-ancestor "$ORIGIN_SHA" HEAD; then
  say "origin/main is already merged"
else
  say "merging origin/main into main"
  if ! "$GIT" -c user.name=vuuihc \
      -c user.email=vuuihc@users.noreply.github.com \
      -c commit.gpgsign=false \
      merge --no-edit -m "merge: sync origin/main into main" "$ORIGIN_SHA"; then
    conflicts="$("$GIT" diff --name-only --diff-filter=U)"
    if [[ "$conflicts" == "web/dist/index.html" ]]; then
      # Both sides rebuilt the console, so the generated entry names two
      # different asset hashes. Rebuild from the merged sources instead of
      # picking a side that does not match them.
      say "rebuilding the console to resolve web/dist/index.html"
      if ! ensure_ui_deps || ! ( cd ui && npm run build ); then
        "$GIT" merge --abort || true
        fail "the console build failed while resolving web/dist/index.html"
      fi
      "$GIT" add web/dist/index.html \
        || { "$GIT" merge --abort || true; fail "cannot stage the rebuilt console entry"; }
      "$GIT" -c user.name=vuuihc \
        -c user.email=vuuihc@users.noreply.github.com \
        -c commit.gpgsign=false \
        commit --no-edit \
        || { "$GIT" merge --abort || true; fail "cannot commit the merge"; }
    else
      "$GIT" merge --abort || true
      fail "merge conflict in: ${conflicts:-unknown}"
    fi
  fi
fi

HEAD_AFTER="$("$GIT" rev-parse HEAD)"
say "HEAD is ${HEAD_AFTER:0:9}"

ensure_ui_deps || fail "ui dependencies failed"
ensure_desktop_deps || fail "desktop dependencies failed"

# npm install can rewrite a lockfile. That is a real tree change; do not build
# or deploy it as if it were the gated commit.
dirty="$("$GIT" status --porcelain --untracked-files=no)"
[[ -z "$dirty" ]] || fail "dependency installation changed tracked files; commit or restore them: $(printf '%s' "$dirty" | head -5 | tr '\n' ';')"

say "building the console"
( cd ui && npm run build ) || fail "ui build failed"
if ! "$GIT" diff --quiet -- web/dist/index.html; then
  say "committing the rebuilt console entry"
  "$GIT" add web/dist/index.html || fail "cannot stage web/dist/index.html"
  "$GIT" -c user.name=vuuihc \
    -c user.email=vuuihc@users.noreply.github.com \
    -c commit.gpgsign=false \
    commit -m "build(web): rebuild the console after syncing origin/main" \
    || fail "cannot commit web/dist/index.html"
  HEAD_AFTER="$("$GIT" rev-parse HEAD)"
fi

say "checking formatting of the files this sync touches"
(
  cd ui || exit 1
  files=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && files+=("$f")
  done < <("$GIT" diff --relative --name-only --diff-filter=ACMR "$BASE"...HEAD -- .)
  if ((${#files[@]})); then
    npx prettier --check --ignore-unknown "${files[@]}"
  else
    echo "no changed console files"
  fi
) || fail "prettier check failed"

say "checking shell syntax"
for f in scripts/*.sh; do
  bash -n "$f" || fail "bash -n $f"
done

say "running the local gate (check.sh --all)"
./scripts/check.sh --all || fail "check.sh --all failed"

say "linting the console"
( cd ui && npm run lint && npm run check:api ) || fail "console lint/API check failed"

say "checking the first-screen budget"
./scripts/check-bundle-budget.sh || fail "console bundle budget failed"

say "bundling the desktop shell"
( cd desktop && npm run build ) || fail "desktop bundle failed"

say "testing the relay"
( cd relay && npm test && npm run build ) || fail "relay tests failed"

say "booting the daemon (smoke)"
KIN_SMOKE_REQUIRE_ASSETS=1 ./scripts/smoke.sh || fail "smoke test failed"

if [[ "$MODE" == "check" ]]; then
  say "local gate passed; --check-only, so no rebuild was scheduled"
  notify "OpenKin 每日部署" "检查通过（--check-only，未重建）"
  exit 0
fi

LOG="$DEPLOY_DIR/rebuild-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG" || fail "cannot create $LOG"
printf '%s scheduled by daily-deploy (origin %s, head %s)\n' \
  "$(date '+%H:%M:%S')" "${ORIGIN_SHA:0:9}" "${HEAD_AFTER:0:9}" >>"$LOG"

# The inner shell gets this script's PATH, because launchd starts it without
# the login shell's environment. `sleep` is the handoff: the task that ran us
# must be allowed to finish before the node it runs on is restarted. The label
# is per-run so a refusal in the wrapper leaves the previous app running.
LABEL="$LABEL_PREFIX.$(date +%s)"
cmd="export PATH=$(printf %q "$PATH"); sleep $DELAY; cd $(printf %q "$ROOT") && exec ./scripts/daily-deploy.sh --run-rebuild $(printf %q "$HEAD_AFTER") $(printf %q "$LOG") $(printf %q "$LABEL") >> $(printf %q "$LOG") 2>&1"

# A new attempt owns the markers from here on: a failed retry of the same HEAD
# must not be skipped because an older success for that HEAD is still on disk.
rm -f "$LAST_SUCCESS" "$LAST_REBUILD_FAILURE" || fail "cannot clear deploy markers"

if launchctl submit -l "$LABEL" -- /bin/bash -lc "$cmd"; then
  method=launchctl
else
  say "launchctl submit failed; falling back to nohup"
  nohup /bin/bash -lc "$cmd" >/dev/null 2>&1 &
  disown 2>/dev/null || true
  method=nohup
fi

if ! write_last_run "$HEAD_AFTER" "$LOG" "$method" "$LABEL"; then
  # The rebuild is already scheduled; a missing marker only means tomorrow's
  # run checks again instead of skipping.
  say "WARN: cannot write $LAST_RUN; the next run will re-check instead of skipping"
fi

say "scheduled the rebuild in ${DELAY}s via $method (log: $LOG)"
say "the rebuild restarts the :7777 node and verifies the app before marking success"
