#!/bin/bash
# test-release.sh — the release gate must refuse in exactly the two cases Ethan named
# (a session in flight, not enough shipped work) and must not be fooled by a node it
# cannot read, a half-written marker, or a merge landing right now.
#
# Hermetic: temp git repo, temp state, a throwaway HTTP node stub on a free port, and a
# fake HOME so the "installed node binary" fallback never reads the real machine.
# Prints "PASS <case>" per case; exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../release-check.sh"
RELEASE="$HERE/../release.sh"
T="$(mktemp -d)"; trap 'stop_node; rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export HOME="$T/home"; mkdir -p "$HOME"     # no ~/.kin/node/kin here on purpose

# --- a repo whose subjects look like this loop's squash merges ("… (#12)")
REPO="$T/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
( cd "$REPO" && echo base > base.txt && git add base.txt && git commit -q -m "chore: init"
  for n in 1 2 3 4 5 6; do
    echo "$n" > "f$n"; git add "f$n"; git commit -q -m "feat(x): change $n (#$((100 + n)))"
  done )
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" remote add origin "$REPO"
ROOT="$(git -C "$REPO" rev-list --max-parents=0 HEAD)"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
BASE1="$(git -C "$REPO" rev-parse HEAD~1)"
BASE2="$(git -C "$REPO" rev-parse HEAD~2)"
STATE="$T/state"; mkdir -p "$STATE"
TOKEN="$T/token"; echo tok > "$TOKEN"
export KIN_TOKEN_FILE="$TOKEN"
PORT=""

# --- node stub: /api/health always answers; /api/tasks needs the bearer token.
start_node() { # start_node <raw-body>
  stop_node
  rm -f "$T/port"
  python3 - "$1" "$T/port" <<'PY' &
import http.server, socketserver, sys
body, portfile = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return
        if self.headers.get("Authorization") != "Bearer tok":
            self.send_response(401); self.end_headers(); return
        data = body.encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    open(portfile, "w").write(str(s.server_address[1]))
    s.serve_forever()
PY
  SRV_PID=$!
  for _ in $(seq 1 100); do
    [ -s "$T/port" ] && { PORT="$(cat "$T/port")"; return 0; }
    sleep 0.05
  done
  fail "node stub did not start"
}
stop_node() {
  if [ -n "${SRV_PID:-}" ]; then kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; fi
  SRV_PID=""
}
API() { echo "http://127.0.0.1:${PORT:-9}"; }

# run <expected-exit> <case> [extra env assignments...]
run() {
  local want="$1" name="$2"; shift 2
  local out rc
  out="$(env RSI_RELEASE_STATE="$STATE" RSI_REPO="$REPO" KIN_API="$(API)" "$@" bash "$CHECK" 2>&1)"; rc=$?
  LAST="$out"
  [ "$rc" = "$want" ] || { printf '%s\n' "$out" >&2; fail "$name: expected exit $want, got $rc"; }
  pass "$name"
}

# 1. Nothing released yet and no installed binary: nothing to count, so HOLD rather than
#    shipping on a guess.
run 10 "HOLD: no marker and no installed binary to derive a baseline from"

# 2. The main gate: six merged PRs unshipped, node idle.
echo "node=$ROOT" > "$STATE/last_release"
start_node '[]'
run 0 "GO: 6 unshipped, node idle"
grep -q '^unshipped=6 ' <<<"$LAST" || fail "GO: unshipped count wrong: $LAST"
[ -f "$STATE/last_release" ] || fail "the check must never write the marker"

# 3. The threshold and its override.
echo "node=$BASE1" > "$STATE/last_release"
run 10 "HOLD: 1 unshipped is below the default 5"
run 0 "GO: RSI_RELEASE_MIN=1 accepts the same tree" RSI_RELEASE_MIN=1

echo "node=$BASE2" > "$STATE/last_release"
run 10 "HOLD: 2 unshipped is below the default 5"

# 4. A conversation in flight is what a rebuild would kill.
echo "node=$ROOT" > "$STATE/last_release"
start_node '[{"id":"aaaabbbbcccc","status":"running"}]'
run 10 "HOLD: a running session blocks the rebuild"
grep -q 'sessions in flight' <<<"$LAST" || fail "HOLD: reason must name the sessions"

start_node '[{"id":"aaaabbbbcccc","status":"waiting_approval"}]'
run 10 "HOLD: a session waiting for a person is still in flight"

start_node '[{"id":"aaaabbbbcccc","status":"succeeded"},{"id":"dddd","status":"failed"},{"id":"eeee","status":"canceled"}]'
run 0 "GO: finished sessions do not block"

# 5. Fail closed when the node answers but the list cannot be read.
start_node 'not json at all'
run 10 "HOLD: an unreadable task list fails closed"

# 6. A node that is down has nothing to interrupt.
stop_node
run 0 "GO: node down is nothing to interrupt"

# 7. A merge landing right now would be raced by the rebuild.
start_node '[]'
mkdir -p "$STATE/.land.lock"; echo $$ > "$STATE/.land.lock/pid"
run 10 "HOLD: a merge is landing right now"
rm -rf "$STATE/.land.lock"

# 8. Unshipped is measured per target, so a half-release is retried, never counted done.
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$ROOT" > "$STATE/last_release"
run 0 "GO: node at tip but hub baseline at the root still counts the work"
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$BASE2" > "$STATE/last_release"
run 10 "HOLD: node at tip, hub two merges behind"
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$HEAD_SHA" > "$STATE/last_release"
run 10 "HOLD: both targets already at the tip"
echo "node=$HEAD_SHA" > "$STATE/last_release"
run 10 "HOLD: hub has no marker at all, so nothing is released for it"

# 9. A dry run reports the plan and writes nothing.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
before="$(cat "$STATE/last_release")"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$REPO" KIN_API="$(API)" \
  bash "$RELEASE" --repo "$REPO" --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "dry run exit $rc"; }
[ "$(cat "$STATE/last_release")" = "$before" ] || fail "dry run wrote the marker"
pass "GO: dry run changes nothing"

echo "all cases passed"
