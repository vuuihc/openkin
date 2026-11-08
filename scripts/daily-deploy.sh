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
# process tree, so it survives the restart and relaunches the app.
#
# Guarantees:
#   - a commit whose origin/main CI is not green is never deployed;
#   - a tree that fails the local gate is never deployed (the local branch has
#     commits CI has not seen);
#   - tracked uncommitted changes block the deploy instead of riding along;
#   - nothing is pushed, force-pushed, reset, or rewritten.
#
# Usage, from the primary checkout:
#   ./scripts/daily-deploy.sh               # gate, merge, schedule the rebuild
#   ./scripts/daily-deploy.sh --check-only  # gate and merge, do not rebuild
#   ./scripts/daily-deploy.sh --dry-run     # report the plan, change nothing
#   ./scripts/daily-deploy.sh --force       # rebuild even if HEAD already shipped
#
# Environment:
#   KIN_DEPLOY_DIR    state/log directory (default ~/.kin/deploy)
#   KIN_DEPLOY_DELAY  seconds between scheduling and the rebuild (default 180)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

GIT=/usr/bin/git
GH=/opt/homebrew/bin/gh
DEPLOY_DIR="${KIN_DEPLOY_DIR:-$HOME/.kin/deploy}"
DELAY="${KIN_DEPLOY_DELAY:-180}"
LABEL=dev.openkin.daily-deploy
LAST_RUN="$DEPLOY_DIR/last-run.json"
LOCK="$DEPLOY_DIR/lock"

MODE=deploy
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check-only) MODE=check ;;
    --dry-run) MODE=dry ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[[ "$DELAY" =~ ^[0-9]+$ ]] || DELAY=180

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ORIGIN_SHA=""
HEAD_AFTER=""
REPO=""

say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

notify() { # title message
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier -title "$1" -message "$2" -sound Glass >/dev/null 2>&1 || true
  else
    osascript -e "display notification \"$2\" with title \"$1\" sound name \"Glass\"" >/dev/null 2>&1 || true
  fi
}

write_failure() { # reason
  python3 - "$DEPLOY_DIR/last-failure.json" "$1" "${ORIGIN_SHA:-}" "$($GIT rev-parse HEAD 2>/dev/null || true)" <<'PY' 2>/dev/null || true
import datetime, json, os, sys
path, reason, origin, head = sys.argv[1:5]
now = datetime.datetime.now().astimezone()
data = {
    "at": now.isoformat(timespec="seconds"),
    "status": "failed",
    "reason": reason,
    "origin_sha": origin,
    "head": head,
}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

fail() { # reason
  say "FAIL: $*"
  write_failure "$*"
  notify "OpenKin 每日部署" "未发布：$*"
  exit 1
}

# Last scheduled deploy, if one is recorded. Prints "<epoch> <head> <log>".
last_scheduled() {
  [[ -f "$LAST_RUN" ]] || return 1
  python3 - "$LAST_RUN" <<'PY' 2>/dev/null || return 1
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("at", 0), d.get("head", ""), d.get("log", ""))
PY
}

write_last_run() { # head log method
  python3 - "$LAST_RUN" "$ORIGIN_SHA" "$1" "$2" "$3" <<'PY' || return 1
import datetime, json, os, sys
path, origin, head, log, method = sys.argv[1:6]
now = datetime.datetime.now().astimezone()
data = {
    "at": int(now.timestamp()),
    "at_iso": now.isoformat(timespec="seconds"),
    "origin_sha": origin,
    "head": head,
    "log": log,
    "method": method,
    "status": "scheduled",
}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

acquire_lock() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]]; then
      say "removing a stale lock ($LOCK)"
      rmdir "$LOCK" 2>/dev/null || true
    fi
    mkdir "$LOCK" 2>/dev/null || fail "another daily-deploy is still running ($LOCK)"
  fi
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}

# The CI gate. A green local gate on a merge of an unverified tip is not the
# contract the user asked for: origin/main's own checks must have passed first.
require_ci() {
  local deadline=$((SECONDS + 900)) summary total pending failed missing names
  while :; do
    summary="$("$GH" api "repos/$REPO/commits/$ORIGIN_SHA/check-runs" --jq '
      [.check_runs[] | {name, status, conclusion}] as $r
      | [($r | length),
         ([$r[] | select(.status != "completed")] | length),
         ([$r[] | select(.status == "completed" and .conclusion != "success")] | length),
         ((["build", "desktop", "smoke"]
           - [$r[] | select(.status == "completed" and .conclusion == "success") | .name]) | length),
         ([$r[].name] | unique | join(","))]
      | @tsv
    ' 2>/dev/null)" || fail "cannot read check runs for ${ORIGIN_SHA:0:9}"

    IFS=$'\t' read -r total pending failed missing names <<<"$summary"
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

say "repository: $ROOT"

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

# Nothing to do only when this exact HEAD was already scheduled and the
# rebuild from that schedule reached its launch stage. A failed rebuild is
# retried; a rebuild still in flight is left alone.
if [[ "$MODE" == "deploy" && "$FORCE" != "1" ]]; then
  if scheduled="$(last_scheduled)"; then
    read -r last_at last_head last_log <<<"$scheduled"
    if [[ "$last_head" == "$head_now" ]] \
      && "$GIT" merge-base --is-ancestor origin/main HEAD; then
      if [[ -n "$last_log" && -f "$last_log" ]] \
        && grep -qF '==> [5/5] launch desktop app' "$last_log"; then
        say "nothing to do: ${head_now:0:9} is already deployed (log: $last_log)"
        exit 0
      fi
      if [[ -n "$last_log" && -f "$last_log" ]] \
        && [[ $(( $(date +%s) - ${last_at:-0} )) -lt 1800 ]]; then
        say "a rebuild is still in progress (log: $last_log)"
        exit 0
      fi
      say "the previous rebuild did not reach the launch stage; retrying"
    fi
  fi
fi

require_ci

if [[ "$MODE" == "dry" ]]; then
  say "dry run: would merge origin/main into main, run the local gate,"
  say "and schedule a rebuild in ${DELAY}s. Nothing was changed."
  exit 0
fi

dirty="$("$GIT" status --porcelain --untracked-files=no)"
[[ -z "$dirty" ]] || fail "uncommitted tracked changes; commit or restore them first: $(printf '%s' "$dirty" | head -5 | tr '\n' ';')"

BASE="$("$GIT" merge-base HEAD origin/main 2>/dev/null)" || fail "no merge base with origin/main"

if "$GIT" merge-base --is-ancestor origin/main HEAD; then
  say "origin/main is already merged"
else
  say "merging origin/main into main"
  if ! "$GIT" -c user.name=vuuihc \
      -c user.email=vuuihc@users.noreply.github.com \
      -c commit.gpgsign=false \
      merge --no-edit -m "merge: sync origin/main into main" origin/main; then
    conflicts="$("$GIT" diff --name-only --diff-filter=U)"
    if [[ "$conflicts" == "web/dist/index.html" ]]; then
      # Both sides rebuilt the console, so the generated entry names two
      # different asset hashes. Rebuild from the merged sources instead of
      # picking a side that does not match them.
      say "rebuilding the console to resolve web/dist/index.html"
      if ! ( cd ui && npm run build ); then
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

if [[ ! -d ui/node_modules ]]; then
  say "installing console dependencies"
  ( cd ui && npm ci ) || fail "ui npm ci failed"
fi
if [[ ! -d desktop/node_modules ]]; then
  say "installing desktop dependencies (first run downloads Electron)"
  ( cd desktop && npm install ) || fail "desktop npm install failed"
fi
if [[ ! -d relay/node_modules ]]; then
  say "installing relay dependencies"
  ( cd relay && npm ci ) || fail "relay npm ci failed"
fi

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
say "scheduled for ${DELAY}s from now (origin ${ORIGIN_SHA:0:9}, log: $LOG)" >>"$LOG"

# The inner shell gets this script's PATH, because launchd starts it without
# the login shell's environment. `sleep` is the handoff: the task that ran us
# must be allowed to finish before the node it runs on is restarted.
cmd="export PATH=$(printf %q "$PATH"); sleep $DELAY; cd $(printf %q "$ROOT") && exec ./scripts/desktop-rebuild.sh >> $(printf %q "$LOG") 2>&1"

launchctl remove "$LABEL" >/dev/null 2>&1 || true
if launchctl submit -l "$LABEL" -- /bin/bash -lc "$cmd"; then
  method=launchctl
else
  say "launchctl submit failed; falling back to nohup"
  nohup /bin/bash -lc "$cmd" >/dev/null 2>&1 &
  disown 2>/dev/null || true
  method=nohup
fi

if ! write_last_run "$HEAD_AFTER" "$LOG" "$method"; then
  # The rebuild is already scheduled; a missing marker only means tomorrow's
  # run checks again instead of skipping.
  say "WARN: cannot write $LAST_RUN; the next run will re-check instead of skipping"
fi

say "scheduled the rebuild in ${DELAY}s via $method"
say "the rebuild restarts the :7777 node; this task will have exited by then"
notify "OpenKin 每日部署" "检查通过，已安排重建（${HEAD_AFTER:0:9}）"
