#!/bin/bash
# gate-test.sh — checks the UX gate plumbing without any model or PR: slice gate, claim guard, walker on a prebuilt binary, threshold maths.
#   UX_KIN_BIN=/path/to/kin bash rsi/runtime/ux/gate-test.sh      (the binary only serves a throwaway daemon on a free port)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; RT="$(cd "$HERE/.." && pwd)"; RSI="$(cd "$RT/.." && pwd)"; WT="$(cd "$RSI/.." && pwd)"
fail=0; ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; fail=1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; mkdir -p "$T/st"
# 1 slice gate
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok S1 && bad "S1 open without APPROVED" || ok "S1 gated without APPROVED"
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok F1 && ok "ungated slice F1 open" || bad "F1 wrongly gated"
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok NOT-A-SLICE && ok "unknown item never gated" || bad "unknown item gated"
echo "# brief" > "$T/brief.md"
RSI_STATE="$T/st" python3 "$RT/lanes.py" claim 1 --slug t --item S2 --brief "$T/brief.md" --paths ui/src/components/layout/PhoneFooter.tsx >"$T/claim.out" 2>&1; [ $? -eq 7 ] && ok "lanes.py refuses to claim S2 before APPROVED" || bad "claim S2 not refused: $(cat "$T/claim.out")"
mkdir -p "$T/st/ux-proto"; touch "$T/st/ux-proto/APPROVED"
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok S1 && ok "S1 open after APPROVED" || bad "S1 still gated after APPROVED"
# 2 threshold maths (ux-gate.sh decision block, fed by a stub reviewer; walker needs UX_KIN_BIN + chrome)
if [ -n "${UX_KIN_BIN:-}" ]; then
  for case in "PASS 4 4 4 4 3 0" "mean 3 3 3 3 4 1" "axis 5 5 5 2 5 1" "noscore x x x x x 1"; do
    set -- $case; name=$1
    if [ "$name" = noscore ]; then STUB='echo "looks fine"; echo "UX_VERDICT: PASS"'; else STUB="echo findings; echo 'UX_SCORES: clarity=$2 density=$3 consistency=$4 feedback=$5 keyboard=$6'; echo 'UX_VERDICT: PASS'"; fi
    RSI_UX_REVIEW_CMD="$STUB" bash "$RT/ux-gate.sh" "$WT" "gate-test-$name" "TEST" 0 "deadbeef" >/dev/null 2>&1; rc=$?
    want=${@: -1}; [ $rc -eq "$want" ] && ok "ux-gate $name -> exit $rc" || bad "ux-gate $name exit $rc, want $want"
  done
  python3 - "$RSI/state/ux/gate-test-mean/scores.json" <<'PY' && ok "scores.json recorded" || bad "scores.json missing"
import json, sys; d = json.load(open(sys.argv[1])); assert d["pass"] is False and d["mean"] == 3.2 and any("mean" in r for r in d["reasons"])
PY
  rm -rf "$RSI"/state/ux/gate-test-* "$RSI"/state/shots/gate-test-* "$RSI"/state/merge/gate-test-* "$RSI"/state/briefs/gate-test-*
else echo "skip ux-gate walk cases (set UX_KIN_BIN)"; fi
# 3 J3: choosing where the work runs is a precondition of Start, not a product failure
if [ -n "${UX_KIN_BIN:-}" ]; then
  JPID=""
  freeport() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
  start_daemon() { # $1 state dir -> JPORT + JTOKEN; false when the binary cannot serve
    JPORT=$(freeport); mkdir -p "$1"
    KIN_STATE_DIR="$1" "$UX_KIN_BIN" serve --port "$JPORT" >"$1/daemon.log" 2>&1 & JPID=$!
    for _ in $(seq 1 120); do
      if curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$JPORT/api/health" 2>/dev/null; then JTOKEN="$(cat "$1/token" 2>/dev/null)"; return 0; fi
      kill -0 "$JPID" 2>/dev/null || return 1; sleep 0.25
    done; return 1
  }
  stop_daemon() { [ -n "$JPID" ] && kill -KILL "$JPID" 2>/dev/null; wait "$JPID" 2>/dev/null; JPID=""; }
  walk_j3() { mkdir -p "$1"; node "$RT/ux/walk.mjs" --base "http://127.0.0.1:$JPORT" --token "$JTOKEN" --out "$1" --journeys J3 >"$1/walk.log" 2>&1; }

  # 3.1 a daemon that knows a project root: open the picker, choose it, Start becomes usable
  if start_daemon "$T/j3-started/state"; then
    python3 - "$JPORT" "$JTOKEN" "$T/j3-started/project" <<'PY'
import json, os, sys, urllib.request
port, token, root = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(root, exist_ok=True)
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/projects",
    data=json.dumps({"name": "[walk] J3 project", "mode": "ship", "roots": [root]}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST")
body = json.load(urllib.request.urlopen(req, timeout=10))
assert body.get("roots") == [root], body
PY
    [ $? -eq 0 ] || bad "J3 case 1: the project fixture was refused"
    walk_j3 "$T/j3-started"
    python3 - "$T/j3-started/walk.json" <<'PY' && ok "J3 reaches started" || bad "J3 did not reach a startable composer (see $T/j3-started/walk.json)"
import json, sys
d = json.load(open(sys.argv[1]))
hard = [h for h in d["hardFail"] if "J3/" in h]
assert not hard, hard
screens = d["screens"]
for vp in ("phone", "mac"):
    hit = [s for s in screens if s["name"].startswith(f"J3-{vp}-") and s["name"].endswith("-started")]
    assert hit, f"no J3-{vp}-*-started screen in {[s['name'] for s in screens]}"
    assert any("enabled" in note for note in hit[-1].get("notes", [])), hit[-1]
PY
  else bad "J3 case 1: the throwaway daemon did not start"; fi
  stop_daemon

  # 3.2 nothing to choose: an explicit skip with a reason, never a hard failure
  if start_daemon "$T/j3-skip/state"; then
    walk_j3 "$T/j3-skip"
    python3 - "$T/j3-skip/walk.json" <<'PY' && ok "J3 skips when no workdir can be chosen" || bad "J3 did not skip on an empty daemon (see $T/j3-skip/walk.json)"
import json, sys
d = json.load(open(sys.argv[1]))
hard = [h for h in d["hardFail"] if "J3/" in h]
assert not hard, hard
screens = d["screens"]
for vp in ("phone", "mac"):
    hit = [s for s in screens if s["name"].startswith(f"J3-{vp}-") and s["name"].endswith("-skipped-no-workdir")]
    assert hit, f"no J3-{vp}-skipped-no-workdir screen in {[s['name'] for s in screens]}"
    assert hit[-1].get("notes"), hit[-1]
PY
  else bad "J3 case 2: the throwaway daemon did not start"; fi
  stop_daemon

  # 3.3 the guard that keeps the skip honest: a Start that is off with no reason on screen is broken
  mkdir -p "$T/j3-fixture/new"
  cat > "$T/j3-fixture/new/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>J3 fixture</title>
<p>A static page shaped like the draft: a prompt, a place row, and a Start control that is off with no reason on screen.</p>
<textarea aria-label="prompt">Draft</textarea>
<div data-place-option="true" onclick="this.dataset.picked='1'">/tmp/kin-journey</div>
<button type="button" aria-label="开始" disabled>开始</button>
HTML
  : > "$T/j3-fixture/favicon.ico"
  FPORT=$(freeport)
  python3 -m http.server "$FPORT" --bind 127.0.0.1 --directory "$T/j3-fixture" >"$T/j3-fixture/server.log" 2>&1 & FPID=$!
  for _ in $(seq 1 40); do curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$FPORT/new/" 2>/dev/null && break; sleep 0.1; done
  mkdir -p "$T/j3-disabled"
  node "$RT/ux/walk.mjs" --base "http://127.0.0.1:$FPORT" --out "$T/j3-disabled" --journeys J3 >"$T/j3-disabled/walk.log" 2>&1
  kill -KILL "$FPID" 2>/dev/null; wait "$FPID" 2>/dev/null
  python3 - "$T/j3-disabled/walk.json" <<'PY' && ok "a disabled Start with no explanation is still a hard failure" || bad "a disabled Start with no explanation was not a hard failure (see $T/j3-disabled/walk.json)"
import json, sys
d = json.load(open(sys.argv[1]))
hard = [h for h in d["hardFail"] if "J3/" in h and "disabled" in h and "no on-screen explanation" in h]
assert hard, d["hardFail"]
PY

  # 3.4 a worktree cut before the seed existed falls back to origin/main's script and still walks
  mkdir -p "$T/fakewt"
  git -C "$T/fakewt" init -q
  mkdir -p "$T/fakewt/scripts"
  printf '#!/usr/bin/env python3\nprint("fallback-seed-ran")\n' > "$T/fakewt/scripts/journeys_seed.py"
  git -C "$T/fakewt" add scripts/journeys_seed.py
  git -C "$T/fakewt" -c user.email=walker@example.com -c user.name=walker commit -qm seed
  git -C "$T/fakewt" update-ref refs/remotes/origin/main "$(git -C "$T/fakewt" rev-parse HEAD)"
  git -C "$T/fakewt" checkout -q -b worker
  git -C "$T/fakewt" rm -q scripts/journeys_seed.py
  git -C "$T/fakewt" -c user.email=walker@example.com -c user.name=walker commit -qm "worktree cut before the seed"
  UX_KIN_BIN="$UX_KIN_BIN" bash "$RT/ux-walk.sh" "$T/fakewt" "$T/j3-fallback" J3 >"$T/j3-fallback.out" 2>&1
  if [ -e "$T/j3-fallback/UNAVAILABLE" ]; then bad "seed fallback run unavailable: $(cat "$T/j3-fallback/UNAVAILABLE")"
  elif grep -q 'origin/main:scripts/journeys_seed.py' "$T/j3-fallback/seed.log" 2>/dev/null && grep -q 'fallback-seed-ran' "$T/j3-fallback/seed.log" && [ -s "$T/j3-fallback/walk.json" ]; then
    ok "seed falls back to origin/main when the worktree has no script"
  else bad "seed fallback not recorded: $(cat "$T/j3-fallback/seed.log" 2>/dev/null)"; fi
else echo "skip J3 walk cases (set UX_KIN_BIN)"; fi
exit $fail
