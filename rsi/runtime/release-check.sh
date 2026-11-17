#!/bin/bash
# release-check.sh — may the loop roll today's merged work to the live node and the Hub?
#
# A release restarts the node on :7777 and redeploys the Hub, so it interrupts whatever
# Ethan is doing. MANDATE ("Release gate") allows it only when BOTH hold:
#   * nothing is in flight — the live node answers /api/tasks with no session in
#     queued / running / waiting_approval / waiting_input / retrying, and no merge is
#     landing (state/.land.lock free);
#   * enough has piled up — at least RSI_RELEASE_MIN merged PRs (default 5) sit on
#     origin/main that no release has shipped yet.
#
# "Unshipped" is measured per target: state/last_release records the SHA each target
# (node, hub) last ran, and the count starts from the older of the two, so a release
# that shipped the node but failed on the Hub is retried instead of counted done.
#
# Prints KEY=VALUE lines and exits 0 (GO) / 10 (HOLD) / 2 (usage, config error).
# --json prints one object. Never prints the node token.
#
# Overrides (tests, and a second checkout):
#   RSI_RELEASE_STATE   state dir              (default <ctrl>/rsi/state)
#   RSI_REPO            checkout to count from (default <ctrl>)
#   RSI_RELEASE_MIN     minimum unshipped PRs  (default 5)
#   KIN_API             live node base URL     (default http://127.0.0.1:7777)
#   KIN_TOKEN_FILE      node token file        (default ~/.kin/token)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CTRL="$(cd "$HERE/../.." && pwd)"
STATE="${RSI_RELEASE_STATE:-$CTRL/rsi/state}"
REPO="${RSI_REPO:-$CTRL}"
MIN="${RSI_RELEASE_MIN:-5}"
KIN_API="${KIN_API:-http://127.0.0.1:7777}"
TOKEN_FILE="${KIN_TOKEN_FILE:-$HOME/.kin/token}"
MARKER="$STATE/last_release"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1
[ -n "${1:-}" ] && [ "${1:-}" != "--json" ] && { echo "usage: release-check.sh [--json]" >&2; exit 2; }

git="$(command -v git)"
[ -x "$git" ] || { echo "release-check: git not found" >&2; exit 2; }
$git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "release-check: not a git checkout: $REPO" >&2; exit 2; }

# marker_sha <target> — the SHA that target last released, or empty.
marker_sha() { [ -f "$MARKER" ] && sed -n "s/^$1=//p" "$MARKER" | head -1 || true; }

# baseline — oldest marker, or, on a machine that has never released, the commit the
# installed node binary was built from (its mtime is the release time), so the very
# first run counts real work instead of starting from zero.
baseline() {
  local node hub old=""
  node="$(marker_sha node)"; hub="$(marker_sha hub)"
  for s in "$node" "$hub"; do
    [ -n "$s" ] || continue
    if [ -z "$old" ]; then old="$s"
    elif $git -C "$REPO" merge-base --is-ancestor "$s" "$old" 2>/dev/null; then old="$s"; fi
  done
  [ -n "$old" ] && { printf '%s' "$old"; return; }
  local bin="$HOME/.kin/node/kin"
  if [ -f "$bin" ]; then
    $git -C "$REPO" log -1 --format=%H --before="$(date -r "$bin" '+%Y-%m-%d %H:%M:%S')" origin/main 2>/dev/null
  fi
}

$git -C "$REPO" fetch -q origin main 2>/dev/null || true
if ! $git -C "$REPO" rev-parse --verify -q origin/main >/dev/null; then
  echo "release-check: no origin/main in $REPO" >&2; exit 2
fi
BASE="$(baseline)"
if [ -n "$BASE" ] && ! $git -C "$REPO" rev-parse --verify -q "$BASE^{commit}" >/dev/null; then
  BASE=""
fi
if [ -n "$BASE" ]; then
  read -r UNSHIPPED COMMITS <<<"$($git -C "$REPO" log --format=%s "$BASE..origin/main" 2>/dev/null |
    awk 'BEGIN{p=0;c=0} {c++; if ($0 ~ /\(#[0-9]+\)$/) p++} END{print p+0, c+0}')"
  BASE="$(printf '%s' "$BASE" | cut -c1-8)"
else
  UNSHIPPED=0; COMMITS=0; BASE="none"
fi

# sessions — a conversation the rebuild would kill. Fail closed: if the node answers
# but refuses the request, we cannot see who is mid-turn, so do not release.
sessions=""; sessions_num=0; note=""
health="$(curl -fs -o /dev/null -m 3 "$KIN_API/api/health" 2>/dev/null && echo up || echo down)"
if [ "$health" = "up" ]; then
  token="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
  body="$(curl -s -m 5 -H "Authorization: Bearer ${token}" "$KIN_API/api/tasks" 2>/dev/null)"
  parsed="$(printf '%s' "$body" | python3 -c '
import json, sys
live = {"queued", "running", "waiting_approval", "waiting_input", "retrying"}
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("UNREADABLE 0"); raise SystemExit
tasks = d if isinstance(d, list) else d.get("tasks") or []
hot = [t for t in tasks if (t.get("status") or t.get("state")) in live]
names = ", ".join("%s %s" % ((t.get("id") or "?")[:8], t.get("status") or t.get("state")) for t in hot[:4])
print("%s %d" % (names or "-", len(hot)))
' 2>/dev/null)"
  case "$parsed" in
    UNREADABLE*) note="node answered /api/tasks but the reply could not be parsed" ;;
    *) sessions="${parsed% *}"; sessions_num="${parsed##* }"
       [ "$sessions" = "-" ] && sessions="" ;;
  esac
else
  health="down"   # nothing to interrupt
fi
case "$sessions_num" in ''|*[!0-9]*) sessions_num=0 ;; esac

# jobs — a merge landing right now would be raced by the rebuild's build steps.
jobs=0
for lock in "$STATE/.land.lock" "$STATE"/lanes/*.lock "$STATE"/merge/*.lock; do
  [ -d "$lock" ] || continue
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && jobs=$((jobs + 1))
done

verdict=GO; reason=""
if [ "$note" != "" ]; then
  verdict=HOLD; reason="sessions unknown: $note"
elif [ "$sessions_num" -gt 0 ]; then
  verdict=HOLD; reason="sessions in flight: $sessions"
elif [ -d "$STATE/.land.lock" ] && [ -n "$(cat "$STATE/.land.lock/pid" 2>/dev/null)" ] && kill -0 "$(cat "$STATE/.land.lock/pid" 2>/dev/null)" 2>/dev/null; then
  verdict=HOLD; reason="a merge is landing"
elif [ "$UNSHIPPED" -lt "$MIN" ]; then
  verdict=HOLD; reason="unshipped $UNSHIPPED < $MIN"
fi

if [ "$JSON" = 1 ]; then
  printf '{"verdict":"%s","reason":"%s","unshipped":%d,"commits":%d,"baseline":"%s","sessions":%d,"jobs":%d,"node":"%s"}\n' \
    "$verdict" "$reason" "$UNSHIPPED" "$COMMITS" "$BASE" "$sessions_num" "$jobs" "$health"
else
  echo "baseline=$BASE"
  echo "unshipped=$UNSHIPPED commits=$COMMITS min=$MIN"
  echo "sessions=$sessions_num node=$health"
  echo "jobs=$jobs"
  echo "verdict=$verdict"
  [ -n "$reason" ] && echo "reason=$reason"
fi
[ "$verdict" = GO ] && exit 0 || exit 10
