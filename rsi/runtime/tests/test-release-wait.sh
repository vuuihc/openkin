#!/bin/bash
# test-release-wait.sh — the machine slot is the one HOLD a release waits out.
#
# 2026-11-22: the gate holds on `heavy:` while a verification build or UX walk owns the
# machine-wide slot (the rebuild's own npm/go build takes no slot, and two builds at once is
# the memory condition behind the 2026-11-18/19 false reds). The hold is right, but a patrol
# reads the gate once per round: six merges sat unshipped from 20:15 to 21:3x because every
# reading landed on a walk that was already minutes from ending.
#
# release.sh now re-reads the whole gate every RSI_RELEASE_STEP (default 20s) for up to
# RSI_RELEASE_WAIT (default 600s) — but only while the binding reason is `heavy:`. A session
# in flight, a merge landing, or too few unshipped still stops the run on the first reading,
# because those are the holds that protect a conversation and the count. A wait that runs out
# aborts with the last gate output and rebuilds nothing. Each attempt is one GATE_WAIT line in
# state/releases.log, so the cost of waiting is measurable instead of invisible.
#
# Hermetic: a temp git repo whose origin/main is its own HEAD, a temp state, a stub gate
# (RSI_RELEASE_CHECK) and a stub node command (RSI_RELEASE_NODE_CMD). No node, no network,
# no docker. Prints "PASS <case>"; exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASE="$HERE/../release.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export HOME="$T/home"; mkdir -p "$HOME"

REPO="$T/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
( cd "$REPO" && echo base > base.txt && git add base.txt && git commit -q -m "chore: init"
  for n in 1 2 3 4 5 6; do
    echo "$n" > "f$n"; git add "f$n"; git commit -q -m "feat(x): change $n (#$((100 + n)))"
  done )
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" remote add origin "$REPO"
ROOT="$(git -C "$REPO" rev-list --max-parents=0 HEAD)"
STATE="$T/state"; mkdir -p "$STATE"

# --- the gate stub: counts its own invocations, HOLDs `heavy:` HEAVY_FIRST times, then GO.
#     MODE=sessions HOLDs for a reason that must never be waited on.
CK="$T/gate.sh"; COUNT="$T/gate-count"
cat > "$CK" <<SH
#!/bin/bash
n=\$(( \$(cat "$COUNT" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "$COUNT"
echo "baseline=$ROOT"
if [ "\${MODE:-}" = sessions ]; then
  echo "sessions=1 node=up"; echo "verdict=HOLD"; echo "reason=sessions in flight: aaaabbbb running"; exit 10
fi
echo "unshipped=6 commits=6 min=5"; echo "sessions=0 node=up"
if [ "\$n" -le "\${HEAVY_FIRST:-0}" ]; then
  echo "verdict=HOLD"; echo "reason=heavy: a build/test holds the machine (slot1 pid=redacted)"; exit 10
fi
echo "verdict=GO"; exit 0
SH
chmod +x "$CK"

# --- a health stub on a free port: release.sh waits for /api/health after the rebuild.
PORTFILE="$T/port"; rm -f "$PORTFILE"
python3 - "$PORTFILE" <<'PYSRV' &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/api/health" else 404); self.end_headers()
        self.wfile.write(b"ok")
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    open(sys.argv[1], "w").write(str(s.server_address[1]))
    s.serve_forever()
PYSRV
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 100); do [ -s "$PORTFILE" ] && break; sleep 0.05; done
API_PORT="$(cat "$PORTFILE" 2>/dev/null)"
[ -n "$API_PORT" ] || fail "health stub did not start"

# --- the node command stub: records that a rebuild was reached.
NODE="$T/node.sh"; RAN="$T/node-ran"
printf '#!/bin/bash\ntouch %s\n' "$RAN" > "$NODE"; chmod +x "$NODE"

reset_case() { # reset_case <extra env assignments for the stub gate>...
  printf 'node=%s\nhub=%s\n' "$ROOT" "$ROOT" > "$STATE/last_release"
  echo 0 > "$COUNT"; rm -f "$RAN"; : > "$STATE/releases.log"
  git -C "$REPO" reset -q --hard HEAD
}
run_release() { # run_release [env assignments...] -- <release args...>
  local envs=() args=() seen=0 a
  for a in "$@"; do
    if [ "$a" = "--" ]; then seen=1; continue; fi
    [ "$seen" = 1 ] && args+=("$a") || envs+=("$a")
  done
  env RSI_RELEASE_STATE="$STATE" RSI_RELEASE_REPO="$REPO" KIN_API="http://127.0.0.1:$API_PORT" \
      RSI_RELEASE_CHECK="$CK" RSI_RELEASE_NODE_CMD="$NODE" "${envs[@]}" \
      bash "$RELEASE" --repo "$REPO" "${args[@]}" 2>&1
}

# 1. The slot frees: the run re-reads the gate and ships at the first GO.
reset_case
out="$(run_release RSI_RELEASE_WAIT=60 RSI_RELEASE_STEP=1 HEAVY_FIRST=2 -- --node-only)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "wait: a slot that frees must ship (exit $rc)"; }
[ "$(cat "$COUNT")" = 3 ] || fail "wait: expected two re-reads before GO, saw $(cat "$COUNT")"
[ -e "$RAN" ] || fail "wait: the node was never rebuilt after the slot freed"
grep -q 'GATE_WAIT heavy:' "$STATE/releases.log" || fail "wait: the wait was not recorded in releases.log"
grep -q "^node=$(git -C "$REPO" rev-parse HEAD)$" "$STATE/last_release" || fail "wait: the node marker is not the shipped SHA"
[ -d "$STATE/.release.lock" ] && fail "wait: a waited release left its lock behind"
pass "release: a heavy HOLD is waited out and ships at the first GO"

# 2. The slot never frees: abort at the deadline, rebuild nothing, move no marker.
reset_case
out="$(run_release RSI_RELEASE_WAIT=2 RSI_RELEASE_STEP=1 HEAVY_FIRST=99 -- --node-only)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "timeout: a slot that never frees must abort (exit $rc)"; }
[ -e "$RAN" ] && fail "timeout: the node was rebuilt while the slot stayed busy"
grep -q "^node=$ROOT$" "$STATE/last_release" || fail "timeout: a held release moved the node marker"
grep -q 'GATE_WAIT gave up' "$STATE/releases.log" || fail "timeout: the give-up was not recorded"
[ -d "$STATE/.release.lock" ] && fail "timeout: an aborted wait left its lock behind"
pass "release: a slot that never frees aborts without rebuilding"

# 3. A conversation in flight is not a wait: it is the hold that protects the session.
reset_case
out="$(run_release RSI_RELEASE_WAIT=600 RSI_RELEASE_STEP=1 MODE=sessions -- --node-only)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "sessions: must abort at once (exit $rc)"; }
[ "$(cat "$COUNT")" = 1 ] || fail "sessions: the gate was re-read $(cat "$COUNT") times for a non-heavy HOLD"
[ -e "$RAN" ] && fail "sessions: the node was rebuilt with a session in flight"
grep -q 'sessions in flight' <<<"$out" || fail "sessions: the abort does not print the reason"
pass "release: a non-heavy HOLD is never waited on"

# 4. A dry run reports; it does not sit in the loop (the patrol asks for a reading).
reset_case
out="$(run_release RSI_RELEASE_WAIT=600 RSI_RELEASE_STEP=1 HEAVY_FIRST=99 -- --dry-run)"; rc=$?
[ "$rc" = 1 ] || { printf '%s\n' "$out" >&2; fail "dry: a dry run must stop at the HOLD (exit $rc)"; }
[ "$(cat "$COUNT")" = 1 ] || fail "dry: a dry run re-read the gate $(cat "$COUNT") times"
pass "release: a dry run never waits"

# 5. --help prints the header whole: the range must follow the header, not end mid-sentence.
out="$(env -u RSI_RELEASE_STATE bash "$RELEASE" --help)"; rc=$?
[ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; fail "help: --help must exit 0 (exit $rc)"; }
grep -q '^# usage: release.sh' <<<"$out" || fail "help: --help omits the usage line"
grep -q '^#      RSI_HUB_TIMEOUT' <<<"$out" || fail "help: --help truncates the Env block"
pass "release: --help prints the complete header"

echo "all cases passed"
