#!/bin/bash
# test-fill-fingerprint.sh — a successful no-work director may be skipped only while
# every input that can create work is unchanged. The suite mutates each input class
# independently; probe failures and control-tree dirt must fail open (run, never skip).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/../fill_fingerprint.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

new_fixture() { # <case>
  CASE="$1"
  D="$T/$CASE"; REPO="$D/repo"; STATE="$D/state"
  mkdir -p "$REPO/rsi/runtime" "$REPO/docs/plans" "$REPO/docs/product/stories" \
    "$STATE/sendback" "$STATE/merge" "$STATE/dogfood" "$STATE/fake-lanes"
  git -C "$REPO" init -q -b main
  cat > "$REPO/rsi/DECISIONS.md" <<'EOF'
# Decisions
EOF
  cat > "$REPO/rsi/GOAL.md" <<'EOF'
# Goal
EOF
  cat > "$REPO/docs/plans/gap-log.md" <<'EOF'
# Gap log

## Open

## 已修
EOF
  echo '{"stories":[]}' > "$REPO/docs/product/stories/registry.json"
  git -C "$REPO" add rsi/DECISIONS.md rsi/GOAL.md docs/product/stories/registry.json
  git -C "$REPO" commit -qm init
  git -C "$REPO" update-ref refs/remotes/origin/main HEAD

  cat > "$REPO/rsi/runtime/slices.py" <<'PY'
import sys
if sys.argv[1] == "ready":
    print("(no ready Astryx slice)")
elif sys.argv[1] == "cloud-pending":
    print("[]")
else:
    raise SystemExit(2)
PY
  cat > "$REPO/rsi/runtime/lanes.py" <<'PY'
import os, sys
cmd = sys.argv[1]
if cmd == "cloud-list":
    p = os.path.join(os.environ["RSI_STATE"], "fake-lanes", "cloud-list")
    if os.path.exists(p):
        sys.stdout.write(open(p).read())
    sys.exit(0)
p = os.path.join(os.environ["RSI_STATE"], "fake-lanes", cmd)
if os.path.exists(p):
    sys.stdout.write(open(p).read())
elif cmd not in ("idle", "claimed", "status"):
    raise SystemExit(2)
PY
  printf '1\n' > "$STATE/fake-lanes/idle"
  : > "$STATE/fake-lanes/claimed"

  cat > "$STATE/STATUS.md" <<'EOF'
# STATUS

## Queue

| # | ID |
|---|---|
| 94 | `R-held` |

## Closed
EOF
  echo followups > "$STATE/followups.md"
  echo ledger > "$STATE/rework-attrib.md"
  echo needs > "$STATE/needs-ceo.md"
  echo director-output > "$STATE/decisions-pending.md"
  echo old > "$STATE/dogfood/old.md"
  NOW=1000
  python3 - "$STATE/dogfood/old.md" <<'PY'
import os, sys
os.utime(sys.argv[1], (1000, 1000))
PY

  FAKE_GH="$D/fake-gh"; GH_PR_FILE="$D/gh-pr.json"; GH_ISSUE_FILE="$D/gh-issue.json"
  echo '[]' > "$GH_PR_FILE"; echo '[]' > "$GH_ISSUE_FILE"
  cat > "$FAKE_GH" <<'SH2'
#!/bin/bash
[ "${GH_FAIL:-0}" = 1 ] && exit 7
case " $* " in
  *" pr "*) file="$GH_PR_FILE" ;;
  *" issue "*) file="$GH_ISSUE_FILE" ;;
  *) exit 2 ;;
esac
# Honour --json like the real CLI: a field the probe stops asking for is absent from the
# answer, so a snapshot that forgets the PR revision or an update timestamp really is blind.
fields="$(printf '%s\n' "$@" | awk '/^--json$/{getline; print; exit}')"
python3 - "$file" "$fields" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
keep = set(f for f in sys.argv[2].split(",") if f)
print(json.dumps([{k: v for k, v in r.items() if not keep or k in keep} for r in rows],
                 separators=(",", ":")))
PY
SH2
  chmod +x "$FAKE_GH"
}

run_fp() { # <expected-rc> <now> <subcommand> [args...]
  local want="$1" now="$2" cmd="$3"; shift 3
  OUT="$(env RSI_FILL_FP_GH="$FAKE_GH" GH_PR_FILE="$GH_PR_FILE" GH_ISSUE_FILE="$GH_ISSUE_FILE" \
    python3 "$HELPER" --repo "$REPO" --state "$STATE" --now "$now" "$cmd" "$@" 2>&1)"
  RC=$?
  [ "$RC" = "$want" ] || fail "$CASE $cmd: expected exit $want, got $RC: $OUT"
}

baseline_success() {
  run_fp 0 1000 check
  grep -q '^run:' <<<"$OUT" || fail "$CASE baseline: first check did not run: $OUT"
  [ -s "$STATE/fill-fingerprint.inflight" ] || fail "$CASE baseline: no inflight fingerprint"
  run_fp 0 1000 record
  [ -s "$STATE/fill-fingerprint" ] || fail "$CASE baseline: no success fingerprint"
  [ ! -e "$STATE/fill-fingerprint.inflight" ] || fail "$CASE baseline: inflight left behind"
}

expect_change_runs() { # <case-name> — call after baseline_success and one mutation.
  run_fp 0 1000 check
  grep -q 'inputs changed' <<<"$OUT" || fail "$CASE: mutation did not force a director run: $OUT"
  pass "$CASE"
}

# 1. Byte-identical inputs after a successful director are the one case that may skip.
new_fixture same-inputs
baseline_success
run_fp 10 1000 check
grep -q '^skip: fill inputs unchanged' <<<"$OUT" || fail "same-inputs: did not skip: $OUT"
pass same-inputs

# 2. A forced pulse still runs the director, but leaves an inflight fingerprint so a
#    successful forced run can become the next baseline.
new_fixture forced
baseline_success
run_fp 0 1000 check --force
grep -q '^run: forced' <<<"$OUT" || fail "forced: --force did not run: $OUT"
pass forced

# 3. Even with no input change, the maximum age forces a periodic re-read.
new_fixture periodic
baseline_success
run_fp 0 3701 check --max-age 2700
grep -q 'periodic refresh' <<<"$OUT" || fail "periodic: stale fingerprint did not refresh: $OUT"
pass periodic

# 4. Each work-creating input class independently invalidates the fingerprint.
new_fixture sendback-change
baseline_success
echo retry > "$STATE/sendback/x.md"
expect_change_runs sendback-change

new_fixture github-change
baseline_success
echo '[{"number":825,"title":"x","headRefName":"rsi/x","mergeable":"CONFLICTING","isDraft":false,"labels":[]}]' > "$GH_PR_FILE"
expect_change_runs github-change

new_fixture gap-change
baseline_success
python3 - "$REPO/docs/plans/gap-log.md" <<'PY'
from pathlib import Path
p=Path(__import__('sys').argv[1])
p.write_text(p.read_text().replace('## Open\n', '## Open\n\n- new defect\n'))
PY
expect_change_runs gap-change

new_fixture story-change
baseline_success
echo '# signed story' > "$REPO/docs/product/stories/KIN-X-001.md"
expect_change_runs story-change

new_fixture blocked-change
baseline_success
echo blocked > "$STATE/merge/x.blocked"
expect_change_runs blocked-change

new_fixture followup-change
baseline_success
echo new-followup >> "$STATE/followups.md"
expect_change_runs followup-change

new_fixture origin-change
baseline_success
echo change > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm change
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
expect_change_runs origin-change

# 5. Dogfood eligibility is part of the fingerprint: the expiry itself must wake the
#    director even when every file and GitHub answer is unchanged. max-age is raised so
#    only the dogfood bit can explain this run.
new_fixture dogfood-expiry
baseline_success
run_fp 0 22601 check --max-age 999999
grep -q 'inputs changed' <<<"$OUT" || fail "dogfood-expiry: expiry did not force a run: $OUT"
pass dogfood-expiry

# 6. Director bookkeeping is deliberately not an input; otherwise every no-dispatch
#    director invalidates its own fingerprint and the guard can never skip.
new_fixture bookkeeping-stable
baseline_success
echo '- 2026-11-28 23:22 +08 · **Waiver: no At-3+ shape**' >> "$STATE/decisions-pending.md"
run_fp 10 1000 check
grep -q '^skip:' <<<"$OUT" || fail "bookkeeping-stable: director output invalidated inputs: $OUT"
pass bookkeeping-stable

# 7. If inputs move while the director is running, the run is not a baseline for skips.
new_fixture input-drift
run_fp 0 1000 check
echo retry > "$STATE/sendback/drift.md"
run_fp 1 1000 record
grep -q 'changed during the director' <<<"$OUT" || fail "input-drift: drift was not reported: $OUT"
[ ! -e "$STATE/fill-fingerprint" ] || fail "input-drift: success fingerprint written despite drift"
pass input-drift

# 8. A probe failure is fail-open: check exits 2 and writes no inflight fingerprint.
new_fixture gh-failure
GH_FAIL=1 run_fp 2 1000 check
grep -q 'probe failed' <<<"$OUT" || fail "gh-failure: failure was not loud: $OUT"
[ ! -e "$STATE/fill-fingerprint.inflight" ] || fail "gh-failure: inflight written despite probe failure"
pass gh-failure

# 9. Control-tree dirt is part of the fingerprint: a clean baseline that becomes dirty
#    runs the director rather than skipping on stale inputs.
new_fixture dirty-tree
baseline_success
echo dirty >> "$REPO/rsi/GOAL.md"
run_fp 0 1000 check
grep -q 'inputs changed' <<<"$OUT" || fail "dirty-tree: dirt did not force a run: $OUT"
pass dirty-tree


# 10. Local lane state is an input: when a lane finishes or releases its claim it becomes
#     dispatchable, and newly dispatchable R-* work must not wait for the periodic refresh
#     while the queue and GitHub answers stay byte-identical.
new_fixture lane-available
baseline_success
printf '1\n' > "$STATE/fake-lanes/claimed"
printf '2\n' > "$STATE/fake-lanes/idle"
expect_change_runs lane-available

# 10a. A running lane above a lowered MAX_LANES reserves paths but is absent from `claimed`
#      (unstarted only) and from `idle` (slots 1..MAX_LANES): its release leaves both slot
#      lists byte-identical, so only the active-lane identity/paths can make the run happen.
new_fixture lane-above-cap-release
cat > "$STATE/fake-lanes/status" <<'EOF'
lane 1: idle     last: finished R-old old mode=new pr=- note=
lane 4: ACTIVE   running  R-big rsi/big mode=rework age=12m silent=3m paths=internal/fill/a.py,internal/fill/b.py
EOF
baseline_success
cat > "$STATE/fake-lanes/status" <<'EOF'
lane 1: idle     last: finished R-old old mode=new pr=- note=
lane 4: idle     last: finished R-big rsi/big mode=rework pr=812 note=released
EOF
[ "$(cat "$STATE/fake-lanes/idle")" = 1 ] || fail "lane-above-cap-release: idle list moved"
[ ! -s "$STATE/fake-lanes/claimed" ] || fail "lane-above-cap-release: claimed list moved"
expect_change_runs lane-above-cap-release

# 10b. age and silent advance every minute on their own; they must not invalidate the
#      fingerprint while the active lane's identity and paths stay put.
new_fixture lane-above-cap-age
cat > "$STATE/fake-lanes/status" <<'EOF'
lane 1: idle     last: finished R-old old mode=new pr=- note=
lane 4: ACTIVE   running  R-big rsi/big mode=rework age=12m silent=3m paths=internal/fill/a.py,internal/fill/b.py
EOF
baseline_success
cat > "$STATE/fake-lanes/status" <<'EOF'
lane 1: idle     last: finished R-old old mode=new pr=- note=
lane 4: ACTIVE   running  R-big rsi/big mode=rework age=19m silent=9m paths=internal/fill/a.py,internal/fill/b.py
EOF
run_fp 10 1000 check
grep -q '^skip:' <<<"$OUT" || fail "lane-above-cap-age: elapsed age invalidated the fingerprint: $OUT"
pass lane-above-cap-age

# 10c. The paths an ACTIVE row reserves are part of the input: an implementation that kept
#      the row but canonicalised `paths=` away would miss a different overlap set.
new_fixture lane-above-cap-paths
cat > "$STATE/fake-lanes/status" <<'EOF'
lane 4: ACTIVE   running  R-big rsi/big mode=rework age=12m silent=3m paths=internal/fill/a.py
EOF
baseline_success
cat > "$STATE/fake-lanes/status" <<'EOF'
lane 4: ACTIVE   running  R-big rsi/big mode=rework age=12m silent=3m paths=internal/fill/a.py,internal/fill/b.py
EOF
expect_change_runs lane-above-cap-paths

# 11. A staged edit changes the worktree even though the porcelain status and the unstaged
#     diff are unchanged between two successive edits; the tree is hashed against HEAD and
#     binary content is part of the hash, not a "Binary files differ" name line.
new_fixture staged-edit
printf 'v0\000base\n' > "$REPO/notes.bin"
git -C "$REPO" add notes.bin
git -C "$REPO" commit -qm notes
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
run_fp 0 1000 check
run_fp 0 1000 record
printf 'v1\000base\n' > "$REPO/notes.bin"
git -C "$REPO" add notes.bin
run_fp 0 1000 check
grep -q 'inputs changed' <<<"$OUT" || fail "staged-edit: first staged edit did not force a run: $OUT"
run_fp 0 1000 record
printf 'v2\000base\n' > "$REPO/notes.bin"
git -C "$REPO" add notes.bin
run_fp 0 1000 check
grep -q 'inputs changed' <<<"$OUT" || fail "staged-edit: second staged edit reused the old fingerprint: $OUT"
pass staged-edit

# 12. GitHub identity fields are not enough: a new commit on an existing PR keeps number,
#     title, labels and mergeability unchanged and must still make the director reconsider.
new_fixture github-pr-revision
echo '[{"number":825,"title":"x","headRefName":"rsi/x","headRefOid":"aaa111","mergeable":"MERGEABLE","isDraft":false,"labels":[],"updatedAt":"2026-11-28T10:00:00Z"}]' > "$GH_PR_FILE"
baseline_success
echo '[{"number":825,"title":"x","headRefName":"rsi/x","headRefOid":"bbb222","mergeable":"MERGEABLE","isDraft":false,"labels":[],"updatedAt":"2026-11-28T10:00:00Z"}]' > "$GH_PR_FILE"
expect_change_runs github-pr-revision

# 13. Feedback added to an existing issue changes only its update timestamp.
new_fixture github-issue-update
echo '[{"number":700,"title":"bug","labels":[],"updatedAt":"2026-11-28T10:00:00Z"}]' > "$GH_ISSUE_FILE"
baseline_success
echo '[{"number":700,"title":"bug","labels":[],"updatedAt":"2026-11-28T12:00:00Z"}]' > "$GH_ISSUE_FILE"
expect_change_runs github-issue-update

# 14. `lanes.py cloud-list` renders elapsed age (%dm), so an unchanged outstanding claim has
#     different text every minute. The real formatter's ownership fields are hashed and only
#     elapsed age is dropped; a new claim or an expired one still changes the fingerprint.
new_fixture cloud-age-stability
mkdir -p "$STATE/cloud/expired"
python3 - "$HERE/../lanes.py" "$HELPER" "$STATE/cloud" <<'PY' || fail "cloud-age-stability: canonical claim data check failed"
import importlib.util, json, os, subprocess, sys, time
lanes, helper, cdir = sys.argv[1], sys.argv[2], sys.argv[3]
claim = os.path.join(cdir, "c1.json")
now = time.time()
def write(**kw):
    d = {"slug": "rsi/x", "item": "R-x", "brief": "b.md", "paths": ["a.py"],
         "status": "claimed", "claimed_at": now - 60, "launched_at": now - 60,
         "expires_at": now + 3600}
    d.update(kw)
    json.dump(d, open(claim, "w"))
def cloud_list():
    env = dict(os.environ, RSI_STATE=os.path.dirname(cdir))
    return subprocess.run([sys.executable, lanes, "cloud-list"],
                          capture_output=True, text=True, env=env).stdout
spec = importlib.util.spec_from_file_location("ff", helper)
ff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ff)
write()
a = cloud_list()
write(claimed_at=now - 180, launched_at=now - 180)
b = cloud_list()
assert a != b, "fixture: the real formatter did not render a different age: %r %r" % (a, b)
ca = ff.canonical_cloud_list(a)
assert ca == ff.canonical_cloud_list(b), "age alone changed the canonical claim data: %r vs %r" % (a, b)
write(claimed_at=now - 60, launched_at=now - 60, paths=["b.py"])
assert ff.canonical_cloud_list(cloud_list()) != ca, "an ownership (paths) change was dropped"
write(paths=["a.py"], expires_at=now - 1)
assert cloud_list() == "", "fixture: the real formatter did not reap the expired claim"
assert ff.canonical_cloud_list("") != ca, "an expired claim was dropped from the fingerprint"
PY
pass cloud-age-stability

# The probe itself hashes the canonical form: the same claim rendered at a different age
# must still skip, so canonical_cloud_list being defined but bypassed in probe() is red.
new_fixture cloud-age-wiring
echo 'R-x    rsi/x    age=1m brief=b paths=a.py' > "$STATE/fake-lanes/cloud-list"
baseline_success
echo 'R-x    rsi/x    age=9m brief=b paths=a.py' > "$STATE/fake-lanes/cloud-list"
run_fp 10 1000 check
grep -q '^skip:' <<<"$OUT" || fail "cloud-age-wiring: elapsed age invalidated the fingerprint: $OUT"
pass cloud-age-wiring

# 15. A probe that times out must not leave its descendants running: run_cmd kills the whole
#     process group (slices.py can wait on a nested lanes.py blocked on the lane flock).
new_fixture process-group-timeout
python3 - "$HELPER" "$D" <<'PY' || fail "process-group-timeout: descendant cleanup check failed"
import importlib.util, os, subprocess, sys, time
helper, d = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("ff", helper)
ff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ff)
pidfile = os.path.join(d, "grandchild.pid")
probe = os.path.join(d, "spawn-descendant.sh")
with open(probe, "w") as fh:
    fh.write('#!/bin/bash\nsleep 60 &\necho $! > "$1"\nwait\n')
os.chmod(probe, 0o755)
try:
    ff.run_cmd([probe, pidfile], timeout=1)
except ff.ProbeError:
    pass
else:
    raise SystemExit("run_cmd did not time out")
for _ in range(50):
    if os.path.exists(pidfile):
        break
    time.sleep(0.05)
pid = int(open(pidfile).read().strip())
def alive(p):
    out = subprocess.run(["ps", "-p", str(p), "-o", "stat="],
                         capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")
for _ in range(100):
    if not alive(pid):
        break
    time.sleep(0.05)
assert not alive(pid), "descendant %d survived the probe timeout" % pid
PY
pass process-group-timeout

# 16. End-to-end wiring in run.sh: with a recorded successful fingerprint and unchanged
#     inputs, pulse exits before the paid director binary. The fake director records every
#     invocation, so a mutant that disables the FP_RC=10 branch turns this case red.
new_run_fixture() {
  CASE="$1"
  D="$T/$CASE"; REPO="$D/repo"; STATE="$REPO/rsi/state"
  mkdir -p "$REPO/rsi/runtime/prompts" "$REPO/docs/plans" "$REPO/docs/product/stories" \
    "$STATE/sendback" "$STATE/merge" "$STATE/dogfood"
  git -C "$REPO" init -q -b main
  echo '# Decisions' > "$REPO/rsi/DECISIONS.md"
  echo '# Goal' > "$REPO/rsi/GOAL.md"
  echo '# Scorecard' > "$REPO/rsi/scorecard.md"
  echo '{"stories":[]}' > "$REPO/docs/product/stories/registry.json"
  printf '# Gap log\n\n## Open\n\n## 已修\n' > "$REPO/docs/plans/gap-log.md"
  git -C "$REPO" add rsi/DECISIONS.md rsi/GOAL.md docs/product/stories/registry.json
  git -C "$REPO" commit -qm init
  git -C "$REPO" remote add origin "$REPO"
  git -C "$REPO" update-ref refs/remotes/origin/main HEAD

  cp "$HERE/../run.sh" "$HERE/../common.sh" "$HERE/../fill_fingerprint.py" \
     "$HERE/../parse_result.py" "$REPO/rsi/runtime/"
  cat > "$REPO/rsi/runtime/lane.sh" <<'SH2'
#!/bin/bash
exit 0
SH2
  cat > "$REPO/rsi/runtime/slices.py" <<'PYSTUB'
import sys
if sys.argv[1] == "ready":
    print("(no ready Astryx slice)")
elif sys.argv[1] == "cloud-pending":
    print("[]")
else:
    raise SystemExit(2)
PYSTUB
  cat > "$REPO/rsi/runtime/lanes.py" <<'PYSTUB'
import sys
if sys.argv[1] == "idle":
    print("1")
elif sys.argv[1] == "claimed":
    pass
elif sys.argv[1] == "status":
    print("lane 1: idle")
elif sys.argv[1] != "cloud-list":
    raise SystemExit(2)
PYSTUB
  echo 'fill prompt' > "$REPO/rsi/runtime/prompts/fill.md"
  cat > "$STATE/STATUS.md" <<'EOF'
# STATUS

## Queue

| # | ID |
|---|---|

## Closed
EOF
  echo followups > "$STATE/followups.md"
  echo ledger > "$STATE/rework-attrib.md"
  echo needs > "$STATE/needs-ceo.md"
  echo old > "$STATE/dogfood/old.md"
  python3 - "$STATE/dogfood/old.md" <<'PYSTUB'
import os, sys
os.utime(sys.argv[1], (1000, 1000))
PYSTUB

  FAKE_GH="$D/fake-gh"; GH_PR_FILE="$D/gh-pr.json"; GH_ISSUE_FILE="$D/gh-issue.json"
  echo '[]' > "$GH_PR_FILE"; echo '[]' > "$GH_ISSUE_FILE"
  cat > "$FAKE_GH" <<'SH2'
#!/bin/bash
case " $* " in
  *" pr "*) file="$GH_PR_FILE" ;;
  *" issue "*) file="$GH_ISSUE_FILE" ;;
  *) exit 2 ;;
esac
fields="$(printf '%s\n' "$@" | awk '/^--json$/{getline; print; exit}')"
python3 - "$file" "$fields" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
keep = set(f for f in sys.argv[2].split(",") if f)
print(json.dumps([{k: v for k, v in r.items() if not keep or k in keep} for r in rows],
                 separators=(",", ":")))
PY
SH2
  chmod +x "$FAKE_GH"

  HOME_FAKE="$D/home"; CLAUDE_LOG="$D/claude-called"
  mkdir -p "$HOME_FAKE/.local/bin"
  cat > "$HOME_FAKE/.local/bin/claude" <<'SH2'
#!/bin/bash
echo called >> "$CLAUDE_LOG"
echo '{"type":"result","result":"fill ok","is_error":false,"total_cost_usd":0,"num_turns":1}'
exit 0
SH2
  chmod +x "$HOME_FAKE/.local/bin/claude"
}

run_pulse() {
  OUT="$(env HOME="$HOME_FAKE" RSI_MAX_OPEN_PRS=0 RSI_GH="$FAKE_GH" CLAUDE_LOG="$CLAUDE_LOG" FILL_SECS=2 \
    GH_PR_FILE="$GH_PR_FILE" GH_ISSUE_FILE="$GH_ISSUE_FILE" \
    bash "$REPO/rsi/runtime/run.sh" pulse 2>&1)"
  RC=$?
}

new_run_fixture run-sh-skip
NOW_PULSE="$(python3 -c 'import time; print(int(time.time()))')"
run_fp 0 "$NOW_PULSE" check
run_fp 0 "$NOW_PULSE" record
run_pulse
[ "$RC" = 0 ] || fail "run-sh-skip: pulse exited $RC: $OUT"
grep -q '^skip: fill inputs unchanged' <<<"$OUT" || fail "run-sh-skip: pulse did not print the skip line: $OUT"
[ ! -e "$CLAUDE_LOG" ] || fail "run-sh-skip: paid director was invoked despite unchanged inputs"
pass run-sh-skip

new_run_fixture run-sh-change
NOW_PULSE="$(python3 -c 'import time; print(int(time.time()))')"
run_fp 0 "$NOW_PULSE" check
run_fp 0 "$NOW_PULSE" record
echo retry > "$STATE/sendback/x.md"
run_pulse
[ -e "$CLAUDE_LOG" ] || fail "run-sh-change: input mutation did not reach the paid director: $OUT"
pass run-sh-change

# 17. Production recording: an initially unseeded successful pulse writes the baseline itself
#     (the fake director emits a real stream-json result line through the real parse_result.py),
#     and the next eligible pulse skips on it. Deleting run.sh's recording block turns the
#     second pulse into another paid run, so this case is the red for that mutant.
new_run_fixture run-sh-record
run_pulse
[ "$RC" = 0 ] || fail "run-sh-record: first pulse exited $RC: $OUT"
[ -e "$CLAUDE_LOG" ] || fail "run-sh-record: first pulse did not run the director: $OUT"
[ -s "$STATE/fill-fingerprint" ] || fail "run-sh-record: successful pulse recorded no baseline: $OUT"
[ ! -e "$STATE/fill-fingerprint.inflight" ] || fail "run-sh-record: inflight fingerprint left behind"
echo 1 > "$STATE/last_fill"   # clear only the 8-minute debounce; it is not a fingerprinted input
run_pulse
[ "$RC" = 0 ] || fail "run-sh-record: second pulse exited $RC: $OUT"
grep -q '^skip: fill inputs unchanged' <<<"$OUT" || fail "run-sh-record: second pulse did not skip: $OUT"
[ "$(grep -c called "$CLAUDE_LOG")" = 1 ] || fail "run-sh-record: paid director ran again after recording"
pass run-sh-record

echo "fill fingerprint ok"
