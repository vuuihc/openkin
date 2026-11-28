#!/bin/bash
# test-release.sh — the release gate must refuse in exactly the two cases Ethan named
# (a session in flight, not enough shipped work) and must not be fooled by a node it
# cannot read, a half-written marker, or a merge landing right now.
#
# Hermetic: temp git repo, temp state, a throwaway HTTP node stub on a free port, and a
# fake HOME so the "installed node binary" fallback never reads the real machine.
# Prints "PASS <case>" per case; exits non-zero on the first failure.
set -u
# The default threshold is what this suite proves; a caller's export (the CEO fill runs
# with RSI_RELEASE_MIN=1) must not stand in for it. Cases that need another value pass it.
unset RSI_RELEASE_MIN
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../release-check.sh"
RELEASE="$HERE/../release.sh"
T="$(mktemp -d)"; trap 'stop_node; [ -f "$T/dev.pid" ] && kill "$(cat "$T/dev.pid")" 2>/dev/null; rm -rf "$T"' EXIT
fail() {
  echo "FAIL $*" >&2
  if declare -F cleanup_fetch_fixture >/dev/null 2>&1; then cleanup_fetch_fixture; fi
  exit 1
}
pass() { echo "PASS $*"; }

# Kill a fake-git tree still recorded by the fetch cases. A hung fetch leaves its
# fake git (and its sleep child) behind when the wall ceiling fires, and none of it
# may outlive the suite.
cleanup_fetch_fixture() {
  local f p
  for f in "${GIT_PID:-}" "${GIT_CHILD_PID:-}"; do
    [ -n "$f" ] || continue
    p="$(cat "$f" 2>/dev/null || true)"
    [ -n "$p" ] && kill -KILL "$p" 2>/dev/null
    rm -f "$f"
  done
  return 0
}

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
start_node() { # start_node <raw-body> [http-status]
  stop_node
  rm -f "$T/port"
  python3 - "$1" "${2:-200}" "$T/port" <<'PY' &
import http.server, socketserver, sys
body, status, portfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return
        if self.headers.get("Authorization") != "Bearer tok":
            self.send_response(401); self.end_headers(); return
        data = body.encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
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

# 3b. Only user-visible commits count. A commit is user-visible unless EVERY path it changes
#     is non-shipped (docs/, rsi/, .github/, scripts/, markdown, Go tests, *.test.* / *.spec.*,
#     *.mutants.json, testdata/, __snapshots__/, *.snap); unknown paths count as visible, and
#     the f1..f6 fixture files below are unknown, so they stay visible. The
#     fixture grows one commit at a time so each case reads its own real range above its own
#     baseline.
VIS="$T/vis"; mkdir -p "$VIS"
git -C "$VIS" init -q -b main
( cd "$VIS" && echo base > base.txt && git add base.txt && git commit -q -m "chore: init"
  mkdir -p docs/plans && echo x > docs/plans/x.md && git add docs/plans/x.md
  git commit -q -m "docs(plans): x (#201)"
  mkdir -p rsi/runtime && echo x > rsi/runtime/x.sh && git add rsi/runtime/x.sh
  git commit -q -m "chore(rsi): x (#202)"
  echo x > README.md && git add README.md && git commit -q -m "docs: readme (#203)" )
git -C "$VIS" remote add origin "$VIS"
git -C "$VIS" update-ref refs/remotes/origin/main HEAD
VIS_ROOT="$(git -C "$VIS" rev-list --max-parents=0 HEAD)"

echo "node=$VIS_ROOT" > "$STATE/last_release"
run 10 "visible-only: docs-only-never-ships" RSI_REPO="$VIS"
grep -q '^unshipped=0 ' <<<"$LAST" || fail "visible-only: docs-only-never-ships: unshipped must be 0: $LAST"
grep -q ' commits=3 ' <<<"$LAST" || fail "visible-only: docs-only-never-ships: commits must be 3: $LAST"
grep -q '^reason=.*visible' <<<"$LAST" || fail "visible-only: docs-only-never-ships: reason must name visible: $LAST"

( cd "$VIS" && mkdir -p ui/src/pages && echo x > ui/src/pages/X.tsx && git add ui/src/pages/X.tsx
  git commit -q -m "feat(ui): x (#204)" )
git -C "$VIS" update-ref refs/remotes/origin/main HEAD
run 0 "visible-only: one-visible-commit-ships-by-default" RSI_REPO="$VIS"
grep -q '^unshipped=1 ' <<<"$LAST" || fail "visible-only one: unshipped must be 1: $LAST"
grep -q ' commits=4 ' <<<"$LAST" || fail "visible-only one: commits must be 4: $LAST"

VIS_UI_TIP="$(git -C "$VIS" rev-parse HEAD)"
( cd "$VIS" && mkdir -p internal/store && echo x > internal/store/x_test.go && git add internal/store/x_test.go
  git commit -q -m "test(store): x (#205)" )
git -C "$VIS" update-ref refs/remotes/origin/main HEAD
echo "node=$VIS_UI_TIP" > "$STATE/last_release"
run 10 "visible-only: test-only-change-does-not-count" RSI_REPO="$VIS"
grep -q '^unshipped=0 ' <<<"$LAST" || fail "visible-only test: unshipped must be 0: $LAST"
grep -q ' commits=1 ' <<<"$LAST" || fail "visible-only test: commits must be 1: $LAST"

VIS_TEST_TIP="$(git -C "$VIS" rev-parse HEAD)"
( cd "$VIS" && mkdir -p internal/api && echo x > internal/api/x.go && git add internal/api/x.go
  git commit -q -m "feat(api): x (#206)" )
git -C "$VIS" update-ref refs/remotes/origin/main HEAD
echo "node=$VIS_TEST_TIP" > "$STATE/last_release"
run 0 "visible-only: daemon-change-counts" RSI_REPO="$VIS"
grep -q '^unshipped=1 ' <<<"$LAST" || fail "visible-only daemon: unshipped must be 1: $LAST"

# A docs commit does not pad the count: one visible + one docs commit is still 1 against 2.
OV="$T/ov"; mkdir -p "$OV"
git -C "$OV" init -q -b main
( cd "$OV" && echo base > base.txt && git add base.txt && git commit -q -m "chore: init"
  mkdir -p docs && echo x > docs/x.md && git add docs/x.md && git commit -q -m "docs: x (#301)"
  mkdir -p internal/api && echo x > internal/api/x.go && git add internal/api/x.go
  git commit -q -m "feat(api): x (#302)" )
git -C "$OV" remote add origin "$OV"
git -C "$OV" update-ref refs/remotes/origin/main HEAD
echo "node=$(git -C "$OV" rev-list --max-parents=0 HEAD)" > "$STATE/last_release"
run 10 "visible-only: override-still-holds" RSI_REPO="$OV" RSI_RELEASE_MIN=2
grep -q '^unshipped=1 ' <<<"$LAST" || fail "visible-only override: unshipped must be 1: $LAST"
rm -f "$STATE/last_release"

# --- the origin/main refresh is bounded -------------------------------------
# release-check refreshes origin/main before every release decision. On 2026-11-28
# 02:47 that fetch's git-remote-https child sat silent for ~3 minutes while a bounded
# `git ls-remote origin main` and an HTTPS probe both succeeded: no verdict, no HOLD,
# no GO, and release.sh calls this check before it can even log one. A fake git on
# PATH answers `fetch` the way each case needs and execs the real git for every other
# call (release-check also runs rev-parse, merge-base, log and rev-list). PATH is set
# per invocation, so the fake never leaks into the cases below.
REAL_GIT="$(command -v git)"
FAKEBIN="$T/fakebin"; mkdir -p "$FAKEBIN"
GIT_PID="$T/fakegit.pid"; GIT_CHILD_PID="$T/fakegit-child.pid"
cat > "$FAKEBIN/git" <<SH
#!/bin/bash
case " \$* " in
  *" fetch "*)
    case "\${FAKE_FETCH_MODE:-hang}" in
      exit1) exit 1 ;;
      sleep1) sleep 1; exit 0 ;;
      sleep2) sleep 2; exit 0 ;;
      *) echo \$\$ > "$GIT_PID"
         sleep 600 & c=\$!
         echo \$c > "$GIT_CHILD_PID"
         wait \$c
         exit 0 ;;
    esac ;;
esac
exec "$REAL_GIT" "\$@"
SH
chmod +x "$FAKEBIN/git"
# A helper `timeout` for the cases, not a source-tree one: macOS has no capped
# builtin and the suite must not depend on the shell's own watchdog.
TIMEOUT_BIN="/usr/bin/timeout"
[ -x "$TIMEOUT_BIN" ] || TIMEOUT_BIN="$(command -v timeout || true)"
[ -n "$TIMEOUT_BIN" ] || fail "the fetch cases need a timeout binary to cap a hung check"
cap_fetch() { # <want-exit> <case> [env...]
  local want="$1" name="$2"; shift 2
  local start took
  start=$(date +%s)
  run "$want" "$name" "$@" "$TIMEOUT_BIN" 20
  took=$(( $(date +%s) - start ))
  [ "$took" -lt 20 ] || fail "$name: took ${took}s; the fetch did not answer inside the bound"
}

# 1. A fetch that never answers holds the release inside its bound: exit 10 with a
#    reason, not a process that never prints a verdict.
cap_fetch 10 "fetch-timeout-holds" RSI_FETCH_TIMEOUT=1 PATH="$FAKEBIN:$PATH"
grep -q '^verdict=HOLD$' <<<"$LAST" || fail "fetch-timeout-holds: verdict is not HOLD: $LAST"
grep -q '^reason=fetch timeout$' <<<"$LAST" || fail "fetch-timeout-holds: reason is not 'fetch timeout': $LAST"
grep -q '^unshipped=unknown ' <<<"$LAST" || fail "fetch-timeout-holds: an unmeasured count must not print as a number: $LAST"

# 2. The whole tree is gone. This is the case a direct-child-only kill leaves red:
#    git's hang lives in the child (git-remote-https), not the pid the check started.
gone() { ! kill -0 "$1" 2>/dev/null || ps -o stat= -p "$1" 2>/dev/null | grep -q Z; }
wait_gone() { for _ in $(seq 1 30); do gone "$1" && return 0; sleep 0.1; done; return 1; }
[ -s "$GIT_PID" ] || fail "fetch-timeout-tree-is-gone: the fake git never recorded its pid"
[ -s "$GIT_CHILD_PID" ] || fail "fetch-timeout-tree-is-gone: the fake git never recorded its child"
wait_gone "$(cat "$GIT_PID")" || fail "fetch-timeout-tree-is-gone: the git process survived the bound"
wait_gone "$(cat "$GIT_CHILD_PID")" \
  || fail "fetch-timeout-tree-is-gone: the fetch child survived; only the direct pid was killed"
rm -f "$GIT_PID" "$GIT_CHILD_PID"
pass "fetch-timeout-tree-is-gone"

# 3. --json names the timeout and carries no number it did not measure.
out="$(env RSI_RELEASE_STATE="$STATE" RSI_REPO="$REPO" KIN_API="$(API)" RSI_FETCH_TIMEOUT=1 \
  PATH="$FAKEBIN:$PATH" "$TIMEOUT_BIN" 20 bash "$CHECK" --json 2>&1)"; rc=$?
LAST="$out"
[ "$rc" = 10 ] || { printf '%s\n' "$out" >&2; fail "fetch-timeout-json: expected exit 10, got $rc"; }
parsed="$(printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
null = lambda v: "null" if v is None else v
print("%s|%s|%s" % (d.get("verdict"), d.get("reason"), null(d.get("unshipped"))))
' 2>/dev/null)"
[ "$parsed" = "HOLD|fetch timeout|null" ] \
  || fail "fetch-timeout-json: expected HOLD|fetch timeout|null, got '$parsed' ($out)"
pass "fetch-timeout-json"

# 4. A fetch that fails is NOT a timeout: the old `|| true` tolerance stays and the
#    check decides from the refs it already has.
cap_fetch 10 "fetch-error-is-not-a-timeout" FAKE_FETCH_MODE=exit1 PATH="$FAKEBIN:$PATH"
grep -q '^reason=unshipped visible 0 < 1$' <<<"$LAST" \
  || fail "fetch-error-is-not-a-timeout: the check did not decide normally: $LAST"

# 5. A slow fetch inside its bound still decides normally.
cap_fetch 10 "slow-fetch-inside-bound-still-decides" RSI_FETCH_TIMEOUT=10 FAKE_FETCH_MODE=sleep1 PATH="$FAKEBIN:$PATH"
grep -q '^reason=unshipped visible 0 < 1$' <<<"$LAST" \
  || fail "slow-fetch-inside-bound-still-decides: the check did not decide normally: $LAST"

# 6. The default bound is comfortably above a slow-but-working fetch: with no
#    RSI_FETCH_TIMEOUT in the environment a 2 s fetch must not be called a timeout.
cap_fetch 10 "default-bound-is-not-tiny" FAKE_FETCH_MODE=sleep2 PATH="$FAKEBIN:$PATH"
grep -q '^reason=unshipped visible 0 < 1$' <<<"$LAST" \
  || fail "default-bound-is-not-tiny: the default bound treated a 2 s fetch as a timeout: $LAST"
unset GIT_PID GIT_CHILD_PID

# 1. Nothing released yet and no installed binary: nothing to count, so HOLD rather than
#    shipping on a guess.
run 10 "HOLD: no marker and no installed binary to derive a baseline from"

# 2. The main gate: six merged PRs unshipped, node idle.
echo "node=$ROOT" > "$STATE/last_release"
start_node '[]'
run 0 "GO: 6 unshipped, node idle"
grep -q '^unshipped=6 ' <<<"$LAST" || fail "GO: unshipped count wrong: $LAST"
[ -f "$STATE/last_release" ] || fail "the check must never write the marker"

# 3. The threshold: one visible merge ships by default, and an explicit override still
#    holds the same tree.
echo "node=$BASE1" > "$STATE/last_release"
run 0 "GO: 1 unshipped visible merge ships by default"
run 10 "HOLD: RSI_RELEASE_MIN=2 holds the same tree" RSI_RELEASE_MIN=2

echo "node=$BASE2" > "$STATE/last_release"
run 0 "GO: 2 unshipped visible merges ship by default"
run 10 "HOLD: RSI_RELEASE_MIN=3 holds the same tree" RSI_RELEASE_MIN=3

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

# 5b. An HTTP error or a reply of the wrong shape must never read as "0 sessions".
start_node '{"error":"unauthorized"}' 500
run 10 "HOLD: an HTTP error from /api/tasks fails closed"
grep -q 'sessions unknown' <<<"$LAST" || fail "HTTP error: reason must say the sessions are unknown"
start_node '{"error":"unauthorized"}' 401
run 10 "HOLD: a refused /api/tasks fails closed"
start_node 'null'
run 10 "HOLD: a JSON null reply fails closed"
start_node '"err"'
run 10 "HOLD: a JSON string reply fails closed"
start_node '[null]'
run 10 "HOLD: a task list of non-objects fails closed"
start_node '{"tasks":[{"id":"aaaabbbb","status":"running"}]}'
run 10 "HOLD: a dict with a live task still blocks"
start_node '{"tasks":[]}'
run 0 "GO: a dict with an empty task list is idle"

# 6. A node that is down has nothing to interrupt.
stop_node
run 0 "GO: node down is nothing to interrupt"

# 7. A merge landing right now would be raced by the rebuild.
start_node '[]'
mkdir -p "$STATE/.land.lock"; echo $$ > "$STATE/.land.lock/pid"
run 10 "HOLD: a merge is landing right now"
rm -rf "$STATE/.land.lock"

# 7b. A build or a walk holding the machine-wide slot would be raced by the rebuild's own
#     npm/go build, which takes no slot (2026-11-19 04:42: a release started inside a
#     12-mutant walk). A live slot pid holds it; a stale pid does not; a lane waiting on a
#     model call holds no slot, so four idle-lane locks must not block the release.
echo "node=$ROOT" > "$STATE/last_release"
mkdir -p "$STATE/heavy/slot1"; echo $$ > "$STATE/heavy/slot1/pid"
run 10 "HOLD: a build/test holds the heavy slot"
grep -q '^reason=heavy: ' <<<"$LAST" || fail "heavy: reason must start with 'heavy:': $LAST"
# ... and it is the binding reason only once enough work is waiting: below the threshold the
#     older, stable explanation wins, so a misshapen marker is not blamed on a build.
echo "node=$BASE1" > "$STATE/last_release"
run 10 "HOLD: below the threshold the unshipped reason wins over the heavy slot" RSI_RELEASE_MIN=2
grep -q 'unshipped visible 1 < 2' <<<"$LAST" || fail "heavy: threshold reason overwritten by the heavy slot: $LAST"
echo "node=$ROOT" > "$STATE/last_release"
echo 99999998 > "$STATE/heavy/slot1/pid"   # no such process
run 0 "GO: a stale heavy pid does not hold the release"
rm -rf "$STATE/heavy/slot1"
mkdir -p "$STATE/lanes/1.lock" "$STATE/lanes/2.lock" "$STATE/merge/x.lock"
for l in "$STATE/lanes/1.lock" "$STATE/lanes/2.lock" "$STATE/merge/x.lock"; do echo $$ > "$l/pid"; done
run 0 "GO: lanes waiting on a model call hold no slot"
rm -rf "$STATE/lanes" "$STATE/merge"

# 7c. Two releases must not run at once. Two patrol rounds can pass the same gate seconds
#     apart (2026-11-21, overlapping CEO rounds); the second must refuse before it reads
#     anything, so the live node is restarted once. The lock is a live pid; a dead one is
#     a crash leftover and must not block the next real release.
mkdir -p "$STATE/.release.lock"; printf '%s\n' $$ > "$STATE/.release.lock/pid"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$T/not-a-checkout" KIN_API="$(API)" \
  bash "$RELEASE" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "release-lock: a held lock must skip with exit 0, got $rc"; }
grep -q 'another release is running' <<<"$out" || fail "release-lock: the skip did not name the holder"
case "$out" in *verdict=*) fail "release-lock: the second release ran the gate instead of refusing" ;; esac
rm -rf "$STATE/.release.lock"
pass "release: a second release refuses while the first holds the lock"

mkdir -p "$STATE/.release.lock"; printf '99999998\n' > "$STATE/.release.lock/pid"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_REPO="$REPO" KIN_API="$(API)" RSI_RELEASE_MIN=99 \
  bash "$RELEASE" --node-only --repo "$REPO" 2>&1)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "release-lock: a stale lock must let the release reach its gate (got $rc)"; }
grep -q 'clearing a stale release lock' <<<"$out" || fail "release-lock: the stale lock was not reported"
[ -d "$STATE/.release.lock" ] && fail "release-lock: a HOLD release left the lock behind"
pass "release: a dead pid is a stale lock, and a HOLD releases it"

# 8. Unshipped is measured per target, so a half-release is retried, never counted done.
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$ROOT" > "$STATE/last_release"
run 0 "GO: node at tip but hub baseline at the root still counts the work"
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$BASE2" > "$STATE/last_release"
run 10 "HOLD: node at tip, hub two merges behind" RSI_RELEASE_MIN=3
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$HEAD_SHA" > "$STATE/last_release"
run 10 "HOLD: both targets already at the tip"
echo "node=$HEAD_SHA" > "$STATE/last_release"
run 10 "HOLD: hub has no marker at all, so nothing is released for it"

# 9. Integrating into a primary checkout: fast-forward when it lags, a plain merge commit
#    when local main has its own unpublished work, and a refusal (no reset, no rewrite)
#    when the two conflict. RSI_RELEASE_NODE_CMD stands in for desktop-rebuild.sh.
SECOND="$T/second"; git clone -q "$REPO" "$SECOND"
git -C "$SECOND" checkout -q main
git -C "$SECOND" remote set-url origin "$REPO"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
LAST_OUT=""
merge_run() { # merge_run <case> <want-exit>
  local name="$1" want="$2" out rc
  out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
    RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
  LAST_OUT="$out"
  [ "$rc" = "$want" ] || { printf '%s\n' "$out" >&2; fail "$name: expected exit $want, got $rc"; }
  pass "$name"
}
# (a) origin/main moved on, local checkout only lags -> fast-forward, node marked.
git -C "$SECOND" reset -q --hard "$BASE2"
merge_run "release: a lagging checkout is fast-forwarded" 0
[ "$(git -C "$SECOND" rev-list --count origin/main..HEAD)" = 0 ] || fail "fast-forward left local commits"
grep -q "^node=$HEAD_SHA" "$STATE/last_release" || fail "node marker not written after a release"
[ -d "$STATE/.release.lock" ] && fail "release-lock: a finished release left its lock behind"

# (b) local main has an unpublished docs commit -> merge commit, nothing rewritten.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
echo note >> "$SECOND/NOTES.md"; git -C "$SECOND" add NOTES.md
git -C "$SECOND" commit -q -m "docs: local only"
merge_run "release: an unpublished local commit is merged, not reset" 0
grep -q "docs: local only" <(git -C "$SECOND" log --format=%s -5) || fail "local commit lost"
[ -z "$(git -C "$SECOND" status --porcelain)" ] || fail "merge left the checkout dirty"

# (c) a real conflict stops the release and leaves the checkout as it was.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
echo mine > "$SECOND/f6"; git -C "$SECOND" add f6; git -C "$SECOND" commit -q -m "fix: conflicting local edit"
before="$(git -C "$SECOND" rev-parse HEAD)"
merge_run "release: a conflict holds and rewrites nothing" 1
[ "$(git -C "$SECOND" rev-parse HEAD)" = "$before" ] || fail "a conflicting release moved HEAD"
[ -d "$SECOND/.git" ] && [ ! -f "$SECOND/.git/MERGE_HEAD" ] || fail "merge not aborted"
git -C "$SECOND" status --porcelain | grep -q '^UU' && fail "conflict markers left behind"
grep -q 'release: .*f6' <<<"$LAST_OUT" || fail "a conflicting release did not name the conflicting file: $LAST_OUT"

# (c1) A local commit whose change is *already upstream* — it landed as a PR, so the local
#      patch is redundant — can still conflict textually because upstream later touched the
#      same lines. Nothing local can be lost, so the release must merge taking upstream's
#      side and then prove the resulting tree equals origin/main. A dedicated fixture has
#      its own upstream so both branches really reach this checkout.
UP="$T/up"; mkdir -p "$UP"; git -C "$UP" init -q -b main
( cd "$UP" && printf 'one\n' > file.txt && git add file.txt && git commit -q -m "chore: base"
  printf 'one\ntwo\n' > file.txt && git commit -qam "feat: x (#11)"
  printf 'one\ntwo\nthree\n' > file.txt && git commit -qam "feat: y (#12)" )
UP_ROOT="$(git -C "$UP" rev-list --max-parents=0 HEAD)"
DUP="$T/dup"; git clone -q "$UP" "$DUP"; git -C "$DUP" checkout -q main
git -C "$DUP" reset -q --hard "$UP_ROOT"
printf 'one\ntwo\n' > "$DUP/file.txt"; git -C "$DUP" add file.txt
GIT_COMMITTER_DATE="2020-01-01T00:00:00 +0000" git -C "$DUP" commit -q -m "feat: x (local duplicate)"
DUP_SHA="$(git -C "$DUP" rev-parse HEAD)"
cherry_now="$(git -C "$DUP" cherry origin/main HEAD)"
[ -n "$cherry_now" ] || fail "fixture: git cherry printed nothing for a patch-equivalent commit"
printf '%s\n' "$cherry_now" | grep -q '^+' && fail "fixture: the local duplicate is not patch-equivalent to upstream"
printf 'node=%s\nhub=%s\n' "$UP_ROOT" "$UP_ROOT" > "$STATE/last_release"
out="$(env RSI_RELEASE_MIN=1 RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$DUP" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$DUP" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "patch-equivalent: expected exit 0, got $rc"; }
git -C "$DUP" diff --quiet origin/main HEAD || fail "patch-equivalent: merged tree differs from origin/main"
git -C "$DUP" merge-base --is-ancestor "$DUP_SHA" HEAD || fail "patch-equivalent: the local commit is no longer an ancestor"
grep -q '^node=' "$STATE/last_release" || fail "patch-equivalent: node marker not written"
[ ! -f "$DUP/.git/MERGE_HEAD" ] || fail "patch-equivalent: MERGE_HEAD left behind"
[ -z "$(git -C "$DUP" status --porcelain)" ] || fail "patch-equivalent: checkout left dirty"
pass "release: a local commit already upstream merges onto origin/main"

# (c2) The proof-of-equality guard cannot be skipped: a merge that reports success but
#      leaves the tree unlike origin/main must stop, name the files that differ, and leave
#      the checkout exactly as it was (no merge commit, clean tree) so the next release
#      stops again instead of seeing origin/main as an ancestor and shipping the tree.
REALGIT="$(command -v git)"
git -C "$DUP" reset -q --hard "$DUP_SHA"
WRAP2="$T/wrap-fake-merge"; mkdir -p "$WRAP2"
cat > "$WRAP2/git" <<SH
#!/bin/bash
case " \$* " in
  *" cherry "*) echo "- $DUP_SHA"; exit 0 ;;
  *" merge "*"-X theirs"*) exit 0 ;;
esac
exec "$REALGIT" "\$@"
SH
chmod +x "$WRAP2/git"
printf 'node=%s\nhub=%s\n' "$UP_ROOT" "$UP_ROOT" > "$STATE/last_release"
out="$(env PATH="$WRAP2:$PATH" RSI_RELEASE_MIN=1 RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$DUP" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$DUP" --node-only 2>&1)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "unproven merge: expected exit 1, got $rc"; }
grep -q 'file.txt' <<<"$out" || fail "unproven merge: the abort did not name the differing file: $out"
[ "$(git -C "$DUP" rev-parse HEAD)" = "$DUP_SHA" ] || fail "unproven merge: the failed proof moved HEAD"
[ -z "$(git -C "$DUP" status --porcelain)" ] || fail "unproven merge: the failed proof left the checkout dirty"
[ ! -f "$DUP/.git/MERGE_HEAD" ] || fail "unproven merge: MERGE_HEAD left behind"
pass "release: a merge that leaves the tree different from origin/main stops and names the file"

# (d) the node rebuild is told to detach: desktop-rebuild.sh ends by launching Electron
#     and must not hold the release open until the desktop app exits.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
STUB="$T/node-cmd.sh"; printf '#!/bin/bash\necho "detach=${KIN_REBUILD_DETACH:-unset}"\n' > "$STUB"; chmod +x "$STUB"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD="$STUB" bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "detach: expected exit 0, got $rc"; }
grep -q 'detach=1' "$STATE/releases.log" || fail "release must pass KIN_REBUILD_DETACH=1 to the node rebuild"
pass "release: the node rebuild is asked to detach"

# (e) A fetch that fails must stop before anything is rebuilt. On 2026-11-18 19:51 a
#     transient github.com SSL error made release.sh log an empty SHA, rebuild and restart
#     the live node, and only then abort at the Hub with `git archive ""`, leaving a
#     `node=` line with no SHA in the marker.
#
#     A git wrapper on PATH fails exactly the second fetch — release-check's probe is (1)
#     and the pre-flight capture is (2) — so a counter that reaches 3 would mean the run
#     went on to the integration fetch, i.e. the pre-flight guard did not fire.
start_node '[]'
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
REALGIT="$(command -v git)"
WRAP1="$T/wrap-fail"; mkdir -p "$WRAP1"
COUNT1="$T/fetch-count"; echo 0 > "$COUNT1"
cat > "$WRAP1/git" <<SH
#!/bin/bash
case " \$* " in
  *" fetch "*"origin main"*)
    n=\$(( \$(cat "$COUNT1") + 1 )); echo "\$n" > "$COUNT1"
    if [ "\$n" = 2 ]; then
      echo "fatal: unable to access 'https://github.com/example/kin.git/': SSL_ERROR_SYSCALL" >&2
      exit 128
    fi ;;
esac
exec "$REALGIT" "\$@"
SH
chmod +x "$WRAP1/git"
RAN="$T/node-ran"; rm -f "$RAN"
STUB2="$T/node-cmd-nofetch.sh"; printf '#!/bin/bash\ntouch %s\n' "$RAN" > "$STUB2"; chmod +x "$STUB2"
out="$(env PATH="$WRAP1:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD="$STUB2" bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "release: a failed fetch must abort (got exit $rc)"; }
grep -qi 'fetch origin main failed' <<<"$out" || fail "release: the abort did not name the failed fetch"
[ "$(cat "$COUNT1")" = 2 ] || fail "release: the run reached the integration fetch; the pre-flight guard did not fire"
[ -e "$RAN" ] && fail "release: the node was rebuilt after a failed fetch"
grep -q "^node=$ROOT$" "$STATE/last_release" || fail "release: a failed fetch moved the node marker"
pass "release: a failed fetch stops before the node rebuild (marker untouched)"

# 9b. A second release on the same checkout must not keep stacking merge commits, and
#     the script must carry its own KIN_API default: `set -u` turns a missing one into an
#     abort *after* the node rebuild, which no hermetic case can reach (the real node owns
#     :7777), so it is asserted as a static guard here.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
echo note2 >> "$SECOND/NOTES.md"; git -C "$SECOND" add NOTES.md
git -C "$SECOND" commit -q -m "docs: second local only"
before_count="$(git -C "$SECOND" rev-list --count HEAD)"
merge_run "release: a second release merges once, then stops adding commits" 0
first_count="$(git -C "$SECOND" rev-list --count HEAD)"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
merge_run "release: a repeat release adds no merge commit" 0
[ "$(git -C "$SECOND" rev-list --count HEAD)" = "$first_count" ] || fail "a repeat release stacked another merge commit"
[ "$first_count" -gt "$before_count" ] || fail "the merge did not happen at all"
grep -q 'KIN_API="${KIN_API:-http://127.0.0.1:7777}"' "$RELEASE" || fail "release.sh lost its KIN_API default (unbound under set -u)"

# 10. A dry run reports the plan and writes nothing.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
before="$(cat "$STATE/last_release")"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$REPO" KIN_API="$(API)" \
  bash "$RELEASE" --repo "$REPO" --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "dry run exit $rc"; }
[ "$(cat "$STATE/last_release")" = "$before" ] || fail "dry run wrote the marker"
pass "GO: dry run changes nothing"

# 11. The Hub build is bounded by `with_timeout`, not the `timeout` binary macOS does not
#     ship. A stub docker that never finishes must be cut off, not waited on.
BIN="$T/bin"; mkdir -p "$BIN"
cat > "$BIN/docker" <<'SH'
#!/bin/bash
case "${1:-}" in
  info) exit 0 ;;
  build) exec sleep 30 ;;   # the watchdog must end this
  save) exit 0 ;;
esac
exit 0
SH
cat > "$BIN/ssh" <<'SH'
#!/bin/bash
case "$*" in *"docker ps"*) echo "Up 1 minute (healthy)" ;; esac
exit 0
SH
chmod +x "$BIN/docker" "$BIN/ssh"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
start=$(date +%s)
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$REPO" KIN_API="$(API)" \
  RSI_HUB_TIMEOUT=1 PATH="$BIN:$PATH" bash "$RELEASE" --repo "$REPO" --hub-only 2>&1)"; rc=$?
took=$(( $(date +%s) - start ))
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "hub: expected the timed-out build to abort, got exit $rc"; }
grep -q 'failed or timed out' <<<"$out" || fail "hub: timeout did not abort the build"
case "$out" in *"command not found"*) fail "hub: build used a command this platform lacks" ;; esac
[ "$took" -lt 20 ] || fail "hub: with_timeout did not stop the build ($took s)"
pass "hub: a build that never finishes is cut off without GNU timeout"

# 12. desktop-rebuild.sh must return promptly when asked to detach and leave the desktop
#     app running: release.sh runs it in the foreground.
FAKE="$T/fakerepo"; mkdir -p "$FAKE/scripts" "$FAKE/ui" "$FAKE/desktop" "$T/fakebin"
cp "$HERE/../../../scripts/desktop-rebuild.sh" "$FAKE/scripts/desktop-rebuild.sh"
printf '#!/bin/bash\nexit 0\n' > "$FAKE/scripts/dev-sign.sh"
cat > "$T/fakebin/go" <<'SH'
#!/bin/bash
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then shift; : > "$1"; chmod +x "$1"; fi
  shift
done
exit 0
SH
cat > "$T/fakebin/npm" <<'SH'
#!/bin/bash
if [ "${1:-}" = run ] && [ "${2:-}" = dev ]; then
  [ -n "${DEV_PID_FILE:-}" ] && echo $$ > "$DEV_PID_FILE"
  exec sleep 60
fi
exit 0
SH
printf '#!/bin/bash\nexit 0\n' > "$T/fakebin/node"
chmod +x "$FAKE/scripts/dev-sign.sh" "$T/fakebin/go" "$T/fakebin/npm" "$T/fakebin/node"
start=$(date +%s)
out="$(env HOME="$T/home2" PATH="$T/fakebin:$PATH" KIN_PORT=1 KIN_REBUILD_DETACH=1 \
  DEV_PID_FILE="$T/dev.pid" bash "$FAKE/scripts/desktop-rebuild.sh" 2>&1)"; rc=$?
took=$(( $(date +%s) - start ))
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "desktop-rebuild detach: exit $rc"; }
[ "$took" -lt 20 ] || fail "desktop-rebuild detach: still blocked after ${took}s"
for _ in $(seq 1 100); do [ -s "$T/dev.pid" ] && break; sleep 0.05; done   # the app starts after the script returns
[ -s "$T/dev.pid" ] && kill -0 "$(cat "$T/dev.pid")" 2>/dev/null \
  || fail "desktop-rebuild detach: the desktop process did not survive the script"
kill "$(cat "$T/dev.pid")" 2>/dev/null || true
pass "desktop-rebuild: KIN_REBUILD_DETACH=1 returns and leaves the app running"

# 13. A merge landing between the pre-flight fetch and the integration fetch must not split
#     the record from the shipped tree: the marker, the built node and the archived commit
#     all have to name the same SHA. A wrapper advances origin immediately before the
#     integration fetch — matching fetch number 3 — and the node stub records the HEAD it
#     was built from. Placed last because it adds a commit to $REPO.
start_node '[]'
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
WRAP3="$T/wrap-advance"; mkdir -p "$WRAP3"
COUNT3="$T/fetch-count-advance"; echo 0 > "$COUNT3"
cat > "$WRAP3/git" <<SH
#!/bin/bash
case " \$* " in
  *" fetch "*"origin main"*)
    n=\$(( \$(cat "$COUNT3") + 1 )); echo "\$n" > "$COUNT3"
    if [ "\$n" = 3 ]; then
      "$REALGIT" -C "$REPO" commit -q --allow-empty -m 'feat(x): advance origin mid-release (#999)'
      "$REALGIT" -C "$REPO" update-ref refs/remotes/origin/main HEAD
    fi ;;
esac
exec "$REALGIT" "\$@"
SH
chmod +x "$WRAP3/git"
BUILT="$T/built-sha"; rm -f "$BUILT"
STUB3="$T/node-cmd-sha.sh"
cat > "$STUB3" <<SH
#!/bin/bash
"$REALGIT" -C "$SECOND" rev-parse HEAD > "$BUILT"
SH
chmod +x "$STUB3"
out="$(env PATH="$WRAP3:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD="$STUB3" bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "mid-release: expected exit 0, got $rc"; }
[ -s "$BUILT" ] || fail "mid-release: the node stub did not run"
[ "$(cat "$BUILT")" != "$HEAD_SHA" ] || fail "mid-release: origin did not advance mid-release"
grep -q "^node=$(cat "$BUILT")$" "$STATE/last_release" \
  || fail "mid-release: the marker must name the commit the node built"
pass "release: the marker records the commit the node built when origin moved mid-release"

# 14. A marker write that does not land must stop the release. mark() used to write the
#     file and never read it back, so a rename that never happened (wrong path, full disk,
#     an atomic-write bug) was indistinguishable from one that did: the run printed
#     "node: shipped" and the marker kept the previous SHA. A `mv` wrapper drops exactly
#     the temp -> last_release rename and passes every other move.
start_node '[]'
MARK="$STATE/last_release"
REALMV="$(command -v mv)"
DROPMV="$T/wrap-drop-mv"; mkdir -p "$DROPMV"
cat > "$DROPMV/mv" <<SH
#!/bin/bash
case " \${2:-} " in
  *"/last_release ") exit 0 ;;
esac
exec "$REALMV" "\$@"
SH
chmod +x "$DROPMV/mv"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$MARK"
BEFORE_MARK="$(cat "$MARK")"
out="$(env PATH="$DROPMV:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" != 0 ] || { printf '%s\n' "$out" >&2; fail "mark-readback: a lost marker write must fail the release"; }
case "$out" in *"node: shipped"*) fail "mark-readback: a lost marker write still reported the node shipped" ;; esac
[ "$(cat "$MARK")" = "$BEFORE_MARK" ] || fail "mark-readback: a lost marker write changed the marker"
pass "release: a marker write that does not land stops the release"

# 15. A value overwritten between the node and Hub phases must stop the run, not be carried
#     forward as this run's. On 2026-11-20 the node phase printed "shipped <sha>" and the
#     file held the previous SHA; mark hub then copied that old SHA into its own write.
#     The node command leaves a rewriter behind keyed to the marker landing; the docker
#     stub waits for it, so the overwrite happens after node was marked and before the Hub
#     line is written — the incident's exact window.
HEAD_NOW="$(git -C "$SECOND" rev-parse HEAD)"
REWRITE="$T/rewrite-marker.sh"
cat > "$REWRITE" <<SH
#!/bin/bash
( for _ in \$(seq 1 500); do
    grep -q "^node=$HEAD_NOW\$" "$MARK" && break
    sleep 0.02
  done
  sleep 0.2
  printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$MARK"
) &
SH
chmod +x "$REWRITE"
BIN2="$T/bin-overwrite"; mkdir -p "$BIN2"
cat > "$BIN2/docker" <<SH
#!/bin/bash
case "\${1:-}" in
  info)   # let the overwrite land before the Hub phase can record anything
    for _ in \$(seq 1 500); do grep -q "^node=$ROOT\$" "$MARK" && exit 0; sleep 0.02; done
    exit 0 ;;
esac
exit 0
SH
cat > "$BIN2/ssh" <<'SH'
#!/bin/bash
case "$*" in *"docker ps"*) echo "Up 1 minute (healthy)" ;; esac
exit 0
SH
chmod +x "$BIN2/docker" "$BIN2/ssh"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$MARK"
out="$(env PATH="$BIN2:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD="$REWRITE" bash "$RELEASE" --repo "$SECOND" 2>&1)"; rc=$?
[ "$rc" != 0 ] || { printf '%s\n' "$out" >&2; fail "cross-phase: a stale node SHA was carried into the hub write"; }
case "$out" in *"hub: shipped"*) fail "cross-phase: the run reported the hub shipped after the marker changed under it" ;; esac
grep -q "node=$ROOT" <<<"$out" || { printf '%s\n' "$out" >&2; fail "cross-phase: the abort did not print the marker contents"; }
pass "release: a marker overwritten between node and Hub stops the release"

# 16. Positive control: one run marks both targets at the shipped commit, stamps a fresh
#     released_at, and the gate's reader counts 0 unshipped against it.
printf 'node=%s\nhub=%s\nreleased_at=2000-01-01 00:00:00 +0000\n' "$ROOT" "$ROOT" > "$MARK"
BEFORE_MARK="$(cat "$MARK")"
BIN3="$T/bin-both"; mkdir -p "$BIN3"
cat > "$BIN3/docker" <<'SH'
#!/bin/bash
exit 0
SH
cp "$BIN2/ssh" "$BIN3/ssh"
chmod +x "$BIN3/docker" "$BIN3/ssh"
out="$(env PATH="$BIN3:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$SECOND" 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "both-targets: expected exit 0, got $rc"; }
grep -q "^node=$HEAD_NOW$" "$MARK" || fail "both-targets: node marker is not the shipped SHA"
grep -q "^hub=$HEAD_NOW$" "$MARK" || fail "both-targets: hub marker is not the shipped SHA"
grep -q '^released_at=' "$MARK" || fail "both-targets: no released_at line"
[ "$(cat "$MARK")" != "$BEFORE_MARK" ] || fail "both-targets: the marker was not rewritten"
run 10 "both-targets: the gate's reader sees 0 unshipped against it"
grep -q '^unshipped=0 ' <<<"$LAST" || fail "both-targets: release-check still counts unshipped work: $LAST"
pass "release: one run leaves both targets at the shipped SHA"
[ -d "$STATE/.release.lock" ] && fail "both-targets: a finished release left its lock behind"

# 17. The abort names the target, the SHA it expected and what the file actually says, so
#     the next person can see the 2026-11-20 shape without re-running the release. This
#     run marks the hub only, so the read-back (not the cross-phase check) has to speak.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$MARK"
HUB_NOW="$(git -C "$SECOND" rev-parse HEAD)"
out="$(env PATH="$DROPMV:$BIN3:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  bash "$RELEASE" --repo "$SECOND" --hub-only 2>&1)"; rc=$?
[ "$rc" != 0 ] || { printf '%s\n' "$out" >&2; fail "readback-message: a lost hub marker write must fail"; }
grep -q 'hub' <<<"$out" || fail "readback-message: the abort does not name the target"
grep -q "$HUB_NOW" <<<"$out" || fail "readback-message: the abort does not name the SHA it expected"
grep -q "$ROOT" <<<"$out" || fail "readback-message: the abort does not print the marker contents"
pass "release: the failure message names the target and the file"
[ -d "$STATE/.release.lock" ] && fail "readback-message: an aborted release left its lock behind"

# 18. local_main_only — how many non-merge commits sit on the released checkout's local
#     main and nowhere on origin/main. They ride the release (MANDATE allows it), so the
#     number is reported, never gated on. Merge commits are excluded because the release
#     itself creates them; a plain rev-list count would show a permanent non-zero number.
mk_fixture_repo() { # mk_fixture_repo <dir> -> root sha on stdout
  local d="$1"
  mkdir -p "$d"; git -C "$d" init -q -b main
  ( cd "$d" && echo base > base.txt && git add base.txt && git commit -q -m "chore: init"
    for n in 1 2 3 4 5 6; do
      echo "$n" > "f$n"; git add "f$n"; git commit -q -m "feat(x): change $n (#$((100 + n)))"
    done )
  git -C "$d" update-ref refs/remotes/origin/main HEAD
  git -C "$d" rev-list --max-parents=0 HEAD
}

# (a) one local-only commit: reported, and the verdict is unchanged.
L1="$T/lm1"; L1_ROOT="$(mk_fixture_repo "$L1")"
printf 'node=%s\nhub=%s\n' "$L1_ROOT" "$L1_ROOT" > "$STATE/last_release"
run 0 "local-main: GO with a clean local main (baseline)" RSI_REPO="$L1"
grep -q '^local_main_only=0$' <<<"$LAST" || fail "local-main baseline: expected 0: $LAST"
grep -q '^verdict=GO$' <<<"$LAST" || fail "local-main baseline: expected GO: $LAST"
git -C "$L1" commit -q --allow-empty -m "docs: local only"
run 0 "local_main_only_counts_a_local_commit" RSI_REPO="$L1"
grep -q '^local_main_only=1$' <<<"$LAST" || fail "local_main_only_counts_a_local_commit: expected 1: $LAST"
grep -q '^verdict=GO$' <<<"$LAST" || fail "local_main_only_counts_a_local_commit: verdict must stay GO: $LAST"

# (b) the release's own --no-ff merges must not be counted.
L2="$T/lm2"; L2_ROOT="$(mk_fixture_repo "$L2")"
printf 'node=%s\nhub=%s\n' "$L2_ROOT" "$L2_ROOT" > "$STATE/last_release"
git -C "$L2" commit -q --allow-empty -m "docs: local only"
for n in 1 2; do
  git -C "$L2" checkout -q -b "incoming$n" refs/remotes/origin/main
  git -C "$L2" commit -q --allow-empty -m "chore: incoming $n"
  git -C "$L2" update-ref refs/remotes/origin/main HEAD
  git -C "$L2" checkout -q main
  git -C "$L2" merge -q --no-ff --no-edit origin/main
done
run 0 "local_main_only_ignores_release_merges" RSI_REPO="$L2"
grep -q '^local_main_only=1$' <<<"$LAST" || fail "local_main_only_ignores_release_merges: expected 1 with two --no-ff merges: $LAST"

# (c) a checkout with no local main cannot be read: unknown, never 0, and the verdict and
#     reason are exactly what the same fixture says without the feature.
L3="$T/lm3"; mkdir -p "$L3"; git -C "$L3" init -q -b trunk
( cd "$L3" && echo base > base.txt && git add base.txt && git commit -q -m "chore: init"
  for n in 1 2 3 4 5 6; do
    echo "$n" > "f$n"; git add "f$n"; git commit -q -m "feat(x): change $n (#$((100 + n)))"
  done )
git -C "$L3" update-ref refs/remotes/origin/main HEAD
printf 'node=%s\n' "$(git -C "$L3" rev-parse HEAD~2)" > "$STATE/last_release"
run 10 "local_main_only_is_unknown_when_unreadable" RSI_REPO="$L3" RSI_RELEASE_MIN=3
grep -q '^local_main_only=unknown$' <<<"$LAST" || fail "unreadable: expected unknown: $LAST"
grep -q '^verdict=HOLD$' <<<"$LAST" || fail "unreadable: verdict changed: $LAST"
grep -q '^reason=unshipped visible 2 < 3$' <<<"$LAST" || fail "unreadable: reason changed: $LAST"

# (d) below the threshold the HOLD reason is untouched by the new number.
L4="$T/lm4"; L4_ROOT="$(mk_fixture_repo "$L4")"
printf 'node=%s\n' "$(git -C "$L4" rev-parse refs/remotes/origin/main~2)" > "$STATE/last_release"
for n in 1 2 3; do git -C "$L4" commit -q --allow-empty -m "docs: local only $n"; done
run 10 "local_main_only_never_changes_the_verdict" RSI_REPO="$L4" RSI_RELEASE_MIN=3
grep -q '^verdict=HOLD$' <<<"$LAST" || fail "verdict-gate: expected HOLD: $LAST"
grep -q '^reason=unshipped visible 2 < 3$' <<<"$LAST" || fail "verdict-gate: reason must stay 'unshipped visible 2 < 3': $LAST"
grep -q '^local_main_only=3$' <<<"$LAST" || fail "verdict-gate: expected 3 local-only commits: $LAST"

# (e) --json carries the number, or null when it cannot be read.
json_lmo() { python3 -c '
import json, sys
d = json.load(sys.stdin)
v = d["local_main_only"]
print("null" if v is None else v)
' <<<"$1" 2>/dev/null; }
J="$(env RSI_RELEASE_STATE="$STATE" RSI_REPO="$L1" KIN_API="$(API)" bash "$CHECK" --json 2>&1)"
[ "$(json_lmo "$J")" = 1 ] || fail "local_main_only_in_json: expected 1, got $J"
J="$(env RSI_RELEASE_STATE="$STATE" RSI_REPO="$L3" KIN_API="$(API)" bash "$CHECK" --json 2>&1)"
[ "$(json_lmo "$J")" = null ] || fail "local_main_only_in_json: expected null for an unreadable checkout, got $J"
pass "local_main_only_in_json"

# (f) the durable record carries it, and the unreviewed warning prints exactly once.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard "$BASE2"
echo note3 >> "$SECOND/NOTES.md"; git -C "$SECOND" add NOTES.md
git -C "$SECOND" commit -q -m "docs: local only for the release log"
: > "$STATE/releases.log"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "release_logs_local_main_only: expected exit 0, got $rc"; }
grep -q '^.*RELEASED .*local_main_only=1$' "$STATE/releases.log" \
  || fail "release_logs_local_main_only: RELEASED record lacks local_main_only=1: $(cat "$STATE/releases.log")"
[ "$(grep -c 'local main only' <<<"$out")" = 1 ] \
  || fail "release_logs_local_main_only: expected exactly one warning line: $out"
pass "release_logs_local_main_only"

# (g) zero local-only commits: the record says 0 and there is no warning.
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard origin/main
: > "$STATE/releases.log"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "local_main_only_zero: expected exit 0, got $rc"; }
grep -q '^.*RELEASED .*local_main_only=0$' "$STATE/releases.log" \
  || fail "local_main_only_zero: RELEASED record lacks local_main_only=0: $(cat "$STATE/releases.log")"
[ "$(grep -c 'local main only' <<<"$out")" = 0 ] \
  || fail "local_main_only_zero: a clean local main must not warn: $out"
pass "local_main_only_zero"

# (h) a gate that omits local_main_only entirely (an older check, or a hand-run stub) must
#     not reach the numeric comparison or the record as an empty value: unknown, exit 0,
#     no warning. Deleting the empty->unknown coercion records `local_main_only=` and this
#     case goes red.
STUB_GATE="$T/gate-no-local-main.sh"
cat > "$STUB_GATE" <<SH
#!/bin/bash
echo "unshipped=6 commits=6 min=5"
echo "sessions=0 node=up"
echo "verdict=GO"; exit 0
SH
chmod +x "$STUB_GATE"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
git -C "$SECOND" reset -q --hard origin/main
: > "$STATE/releases.log"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_CHECK="$STUB_GATE" RSI_RELEASE_NODE_CMD=true \
  bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "local_main_only_unknown_when_the_gate_omits_it: expected exit 0, got $rc"; }
grep -q '^.*RELEASED .*local_main_only=unknown$' "$STATE/releases.log" \
  || fail "local_main_only_unknown_when_the_gate_omits_it: RELEASED record lacks local_main_only=unknown: $(cat "$STATE/releases.log")"
[ "$(grep -c 'local main only' <<<"$out")" = 0 ] \
  || fail "local_main_only_unknown_when_the_gate_omits_it: an unreadable count must not warn: $out"
pass "local_main_only_unknown_when_the_gate_omits_it"

# 19-22. One writer for state/last_release. A fill turn used to read the record at the start of
#        a long turn and write it back at its end, so a release that landed in between was
#        overwritten with the pre-release values (2026-11-23 07:02: the node and the Hub both
#        shipped a newer commit while the record kept the SHA read before the release began; the
#        repair needed a four-way proof by hand). The fill's gate reading now lives in
#        state/release-gate, and release.sh refuses to ship on a record that changed under it.
start_node '[]'
MARK="$STATE/last_release"
SHIP="$(git -C "$SECOND" rev-parse HEAD)"
# The failure line carries the case's own PASS name, so a red-first proof can name the test.
CASE=""
case_fail() { fail "$CASE: $*"; }

# (a) the gate stub reads a real GO and then rewrites the record the way the 07:02 fill did.
CASE="release: a marker rewritten after the gate read aborts before the node rebuild"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$MARK"
GATE_REWRITE="$T/gate-rewrite.sh"
cat > "$GATE_REWRITE" <<SH
#!/bin/bash
out="\$(RSI_REPO="\$RSI_REPO" bash "$CHECK")"; rc=\$?
printf '%s\n' "\$out"
if [ "\$rc" = 0 ]; then
  { printf 'node=%s\nhub=%s\nreleased_at=2000-01-01 00:00:00 +0000\n' "$ROOT" "$ROOT"
    printf 'gate_at=2026-11-23 07:02:00 +0800\n'; } > "$MARK"
fi
exit \$rc
SH
chmod +x "$GATE_REWRITE"
RAN_GATE="$T/node-ran-after-gate-rewrite"; rm -f "$RAN_GATE"
NODE_SENTINEL="$T/node-cmd-sentinel.sh"
printf '#!/bin/bash\ntouch %s\n' "$RAN_GATE" > "$NODE_SENTINEL"; chmod +x "$NODE_SENTINEL"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_CHECK="$GATE_REWRITE" RSI_RELEASE_NODE_CMD="$NODE_SENTINEL" \
  bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; case_fail "expected exit 1, got $rc"; }
[ -e "$RAN_GATE" ] && case_fail "the node was rebuilt after the record changed under the gate"
grep -q 'last_release' <<<"$out" || { printf '%s\n' "$out" >&2; case_fail "the abort does not name the record"; }
grep -q 'concurrent writer' <<<"$out" || { printf '%s\n' "$out" >&2; case_fail "the abort does not name the concurrent writer"; }
case "$out" in *"node: shipped"*) case_fail "the run claimed the node shipped" ;; esac
pass "$CASE"

# (b) a foreign line lands during the node phase, after the build and before mark node. The
#     record still carries it, does not claim this run's SHA, and no Hub phase starts.
CASE="release: a marker changed mid-release aborts without claiming the node shipped"
NODE_APPEND="$T/node-cmd-append.sh"
cat > "$NODE_APPEND" <<SH
#!/bin/bash
printf 'gate_at=2026-11-23 07:02:00 +0800\n' >> "$MARK"
SH
chmod +x "$NODE_APPEND"
BIN_MARK="$T/bin-mark"; mkdir -p "$BIN_MARK"
cat > "$BIN_MARK/docker" <<SH
#!/bin/bash
: > "$T/docker-ran"
exit 0
SH
cat > "$BIN_MARK/ssh" <<'SH'
#!/bin/bash
case "$*" in *"docker ps"*) echo "Up 1 minute (healthy)" ;; esac
exit 0
SH
chmod +x "$BIN_MARK/docker" "$BIN_MARK/ssh"
rm -f "$T/docker-ran"
printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$MARK"
: > "$STATE/releases.log"
out="$(env PATH="$BIN_MARK:$PATH" RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD="$NODE_APPEND" bash "$RELEASE" --repo "$SECOND" 2>&1)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; case_fail "expected exit 1, got $rc"; }
case "$out" in *"node: shipped"*) case_fail "the run claimed the node shipped" ;; esac
grep -q 'node: shipped' "$STATE/releases.log" && case_fail "releases.log claims the node shipped"
grep -q '^gate_at=' "$MARK" || { printf '%s\n' "$(cat "$MARK")" >&2; case_fail "the foreign line was lost from the record"; }
grep -q "^node=$SHIP$" "$MARK" && case_fail "the record holds the shipped SHA after an aborted node phase"
[ -e "$T/docker-ran" ] && case_fail "the Hub phase ran after the node phase aborted"
pass "$CASE"

# (c) mark() owns node=, hub= and released_at=, not the whole file: a key written before the
#     run survives exactly once and the duplicate released_at lines collapse to this run's.
CASE="release: mark keeps a foreign key written before the run"
printf 'note=keep\nnode=%s\nhub=%s\nreleased_at=2000-01-01 00:00:00 +0000\nreleased_at=2000-01-02 00:00:00 +0000\n' \
  "$ROOT" "$ROOT" > "$MARK"
out="$(env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$SECOND" KIN_API="$(API)" \
  RSI_RELEASE_NODE_CMD=true bash "$RELEASE" --repo "$SECOND" --node-only 2>&1)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; case_fail "expected exit 0, got $rc"; }
[ "$(grep -c '^note=keep$' "$MARK")" = 1 ] || { printf '%s\n' "$(cat "$MARK")" >&2; case_fail "note=keep must survive exactly once"; }
grep -q "^node=$SHIP$" "$MARK" || { printf '%s\n' "$(cat "$MARK")" >&2; case_fail "the node marker is not the shipped SHA"; }
grep -q "^hub=$ROOT$" "$MARK" || { printf '%s\n' "$(cat "$MARK")" >&2; case_fail "a node-only run changed the hub value"; }
[ "$(grep -c '^released_at=' "$MARK")" = 1 ] || { printf '%s\n' "$(cat "$MARK")" >&2; case_fail "expected exactly one released_at line"; }
grep -q 'node: shipped' <<<"$out" || { printf '%s\n' "$out" >&2; case_fail "the read-back did not report the write"; }
pass "$CASE"

# (d) the fill's gate reading belongs in state/release-gate, never in the release record.
CASE="release: the fill prompt writes its gate reading to state/release-gate"
PROMPT="$HERE/../prompts/fill.md"
grep -q 'release-gate' "$PROMPT" || case_fail "it does not name state/release-gate"
grep -qi 'atomic' "$PROMPT" || case_fail "the gate reading is not written atomically"
grep -q 'derived, never copied' "$PROMPT" || case_fail "the 'derived, never copied' rule was lost"
grep -q 'never write or append to' "$PROMPT" || case_fail "it does not forbid writing the release record"
grep -q 'after the existing' "$PROMPT" && case_fail "it still tells the fill to append to the release record"
bad="$(grep -n 'last_release' "$PROMPT" | grep -v 'never write or append to' || true)"
[ -z "$bad" ] || { printf '%s\n' "$bad" >&2; case_fail "last_release is named outside the prohibition"; }
pass "$CASE"

echo "all cases passed"
