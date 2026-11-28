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
    "$STATE/sendback" "$STATE/merge" "$STATE/dogfood"
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
import sys
if sys.argv[1] != "cloud-list":
    raise SystemExit(2)
PY

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
  *" pr "*) cat "$GH_PR_FILE" ;;
  *" issue "*) cat "$GH_ISSUE_FILE" ;;
  *) exit 2 ;;
esac
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


# 10. End-to-end wiring in run.sh: with a recorded successful fingerprint and unchanged
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

  cp "$HERE/../run.sh" "$HERE/../common.sh" "$HERE/../fill_fingerprint.py" "$REPO/rsi/runtime/"
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
  *" pr "*) cat "$GH_PR_FILE" ;;
  *" issue "*) cat "$GH_ISSUE_FILE" ;;
  *) exit 2 ;;
esac
SH2
  chmod +x "$FAKE_GH"

  HOME_FAKE="$D/home"; CLAUDE_LOG="$D/claude-called"
  mkdir -p "$HOME_FAKE/.local/bin"
  cat > "$HOME_FAKE/.local/bin/claude" <<'SH2'
#!/bin/bash
echo called >> "$CLAUDE_LOG"
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

echo "fill fingerprint ok"
