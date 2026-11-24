#!/bin/bash
# test-check-job-parity.sh — the default local gate starts exactly the jobs CI does not run.
#
# scripts/check.sh exists to catch what CI will not, on this machine, before a push.
# CI (.github/workflows/ci.yml) already runs eight of its jobs on every push: `go vet
# ./...` and `go test ./...`, the console suite + `npx tsc --noEmit`, the desktop
# suite + `npm run typecheck`, the inventory ratchet (with its own test) and the
# added-file lint guard (with its own test). The merge gate requires green PR checks,
# so starting those eight again locally buys no evidence; R-gate-ci-dedupe moved them
# behind --all. This suite pins the split from both sides:
#
#   * the default `--list` is the 15 local-only jobs and none of the eight;
#   * `--all --list` is all 23, so a complete one-command local run still exists;
#   * each of the eight is still run by CI, with the console pair read from its own
#     CI step and the desktop pair from the `desktop:` job (the file contains
#     `npm test` three times, so a bare grep would prove nothing);
#   * the premises that make dropping them safe still hold: gate.sh runs check.sh and
#     its own lint / changed-file test / build / ratchet steps, and the console build
#     script still typechecks;
#   * the checker reports drift itself: a temp check.sh with a CI job back in the
#     default block, one with a local job removed, and a temp workflow whose desktop
#     job lost `npm test`.
#
# RSI_CHECK_SH points the suite at another check.sh (the negative cases use temp
# copies; with it set only the default-list case runs, so a copy cannot recurse).
# RSI_CI_FILE does the same for the workflow, honoured only when the file exists;
# RSI_CI_NEGATIVE stops the nested CI-parity negative from re-entering itself.
#
# Hermetic: temp dirs, no network, and no job is started (the --list guard below
# refuses to run an older check.sh that would ignore the flag and start the gate).
# Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DEFAULT_CHECK="$REPO/scripts/check.sh"
CHECK="${RSI_CHECK_SH:-$DEFAULT_CHECK}"
CI="${RSI_CI_FILE:-}"
[ -f "$CI" ] || CI="$REPO/.github/workflows/ci.yml"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

# The 15 jobs CI does not run, and the eight it does: the names the two --list modes print.
LOCAL_ONLY=(gofmt probe api-contract api-coverage shell-syntax shell-test
  python-syntax stories removed-surfaces ux-spec-refs walk-contract
  phone-baseline-contract journeys-smoke quality-reading-contract mobile-rn)
CI_JOBS=(vet gotest desktop-test desktop-tsc ui-test ui-tsc ui-inventory ui-lint-guard)
[ "${#LOCAL_ONLY[@]}" -eq 15 ] || fail "default-list: the local-only list is not 15 jobs"
[ "${#CI_JOBS[@]}" -eq 8 ] || fail "default-list: the CI list is not eight jobs"

sorted() { LC_ALL=C sort; }

# default_list <check.sh> — the names its default run would start, or fail the case.
default_list() {
  local out
  # Guard before invoking: a check.sh older than this change ignores --list and would
  # start every job, so a hermetic suite must not call it "just to see". The red-first
  # seam reverts this file and relies on this failure naming the case.
  grep -qE '^[[:space:]]*--list\)' "$1" \
    || fail "default-list: $1 has no --list mode; refusing to start a full gate"
  out="$(bash "$1" --list 2>&1)" || fail "default-list: --list exited nonzero: $out"
  printf '%s\n' "$out"
}

# --- case 1: the default run is the 15 local-only jobs and none of the eight ----------------
# `fail` inside the command substitution ends that subshell, so carry its status out.
if ! out="$(default_list "$CHECK")"; then exit 1; fi
want="$(printf '%s\n' "${LOCAL_ONLY[@]}" | sorted)"
if [ "$(printf '%s\n' "$out" | sorted)" != "$want" ]; then
  fail "default-list: expected the 15 local-only jobs, got $(grep -c . <<<"$out") line(s): $out"
fi
for j in "${CI_JOBS[@]}"; do
  grep -qx -- "$j" <<<"$out" && fail "default-list: CI job '$j' is in the default list"
done
echo "PASS default-list"

# A temp check.sh only needs the split proven; the other cases read the real repo files.
if [ "$CHECK" != "$DEFAULT_CHECK" ]; then
  exit 0
fi

# --- case 2: --all still lists every job, in either argument order --------------------------
out="$(bash "$CHECK" --all --list 2>&1)" || fail "all-list: --all --list exited nonzero: $out"
want="$( { printf '%s\n' "${LOCAL_ONLY[@]}"; printf '%s\n' "${CI_JOBS[@]}"; } | sorted)"
if [ "$(printf '%s\n' "$out" | sorted)" != "$want" ]; then
  fail "all-list: expected the 15 + the eight, got $(grep -c . <<<"$out") line(s): $out"
fi
[ "$(grep -c . <<<"$out")" -eq 23 ] || fail "all-list: expected 23 lines, got $(grep -c . <<<"$out")"
out2="$(bash "$CHECK" --list --all 2>&1)" || fail "all-list: --list --all exited nonzero: $out2"
[ "$out2" = "$out" ] || fail "all-list: --list --all and --all --list disagree"
echo "PASS all-list"

# --- case 3: each of the eight is still run by CI -------------------------------------------
# YAML comments are stripped first: a commented-out command runs nowhere.
ci_body() { sed -E 's/(^|[[:space:]])#.*$//' "$CI"; }

# job_block <job> — the lines under one top-level CI job, from the comment-stripped file.
job_block() {
  awk -v want="$1" '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      name = $0; sub(/^  /, "", name); sub(/:.*/, "", name)
      on = (name == want); next
    }
    on { print }
  '
}

# step_block <name substring> — the lines of one named step inside the given block.
step_block() {
  awk -v want="$1" '
    /^      - name:/ { on = (index($0, want) > 0); next }
    /^      - / { on = 0 }
    on { print }
  '
}

[ -f "$CI" ] || fail "ci-parity: the CI workflow is missing: $CI"
body="$(ci_body)"
[ -n "$body" ] || fail "ci-parity: the CI workflow is empty: $CI"
build="$(job_block build <<<"$body")"
desktop="$(job_block desktop <<<"$body")"
[ -n "$build" ] || fail "ci-parity: the CI workflow has no build job"
[ -n "$desktop" ] || fail "ci-parity: the CI workflow has no desktop job"

in_block() { # <block> <job> <pattern> <what>
  grep -qE -- "$3" <<<"$1" || fail "ci-parity: $2 no longer runs $4 in $CI"
}

# The console suite and typecheck are read from their own step: `npm test` also appears
# in the relay step and the desktop job, so a bare grep would stay green after the UI
# step lost it.
ui_step="$(step_block 'UI install' <<<"$build")"
[ -n "$ui_step" ] || fail "ci-parity: the build job has no UI install step"
in_block "$ui_step" ui-test '^[[:space:]]*npm test$' '`npm test`'
in_block "$ui_step" ui-tsc '^[[:space:]]*npx tsc --noEmit$' '`npx tsc --noEmit`'

# The desktop suite and typecheck are read from the desktop job for the same reason.
in_block "$desktop" desktop-test '^[[:space:]]*npm test$' '`npm test`'
in_block "$desktop" desktop-tsc '^[[:space:]]*npm run typecheck$' '`npm run typecheck`'

# The rest name unique commands, so the whole (comment-stripped) workflow is the scope.
in_block "$body" vet '^[[:space:]]*run: go vet \./\.\.\.$' '`go vet ./...`'
in_block "$body" gotest '^[[:space:]]*run: go test \./\.\.\.$' '`go test ./...`'
in_block "$body" ui-inventory '^[[:space:]]*python3 -B scripts/check-ui-inventory\.py$' \
  '`scripts/check-ui-inventory.py`'
in_block "$body" ui-inventory '^[[:space:]]*python3 -B scripts/check-ui-inventory\.test\.py$' \
  'the inventory ratchet test'
in_block "$body" ui-lint-guard '^[[:space:]]*\./scripts/ui-lint-guard\.sh$' \
  '`scripts/ui-lint-guard.sh`'
in_block "$body" ui-lint-guard '^[[:space:]]*python3 -B -m unittest scripts/ui_lint_guard_test\.py$' \
  'the lint guard test'
echo "PASS ci-parity"

# --- case 4: the premises that make dropping the eight safe still hold ----------------------
gate="$REPO/rsi/runtime/gate.sh"
[ -f "$gate" ] || fail "gate-premises: gate.sh is missing: $gate"
grep -qF 'step check ./scripts/check.sh' "$gate" \
  || fail "gate-premises: gate.sh no longer runs ./scripts/check.sh"
grep -qF 'selected lint && step lint' "$gate" \
  || fail "gate-premises: gate.sh lint step is gone"
grep -qF 'selected test && step test' "$gate" \
  || fail "gate-premises: gate.sh changed-file test step is gone"
grep -qF 'selected build' "$gate" \
  || fail "gate-premises: gate.sh build step is gone"
grep -qF 'ratchet.py" check' "$gate" \
  || fail "gate-premises: gate.sh ratchet no longer calls ratchet.py check"
python3 - "$REPO/ui/package.json" <<'PY' \
  || fail "gate-premises: the ui build script no longer begins with tsc --noEmit"
import json, sys
script = json.load(open(sys.argv[1], encoding="utf-8"))["scripts"]["build"]
sys.exit(0 if script.startswith("tsc --noEmit") else 1)
PY
# The helper header a worker reads must not promise the checks the default run now
# leaves to CI: prep-worktree.sh told them check.sh runs desktop tsc/tests.
grep -qF 'check.sh --all also runs desktop tsc/tests' \
  "$REPO/rsi/runtime/prep-worktree.sh" \
  || fail "gate-premises: prep-worktree.sh no longer qualifies the desktop checks with --all"
echo "PASS gate-premises"

# --- case 5: the checker reports drift ------------------------------------------------------

# A CI job back in the default block: the default-list set must be reported.
mkdir -p "$T/readd"
awk '{ print } /^start gofmt job_gofmt$/ { print "start ui-test job_ui_test" }' \
  "$DEFAULT_CHECK" > "$T/readd/check.sh"
if out="$(RSI_CHECK_SH="$T/readd/check.sh" bash "$HERE/test-check-job-parity.sh" 2>&1)"; then
  fail "negative-readd-ui-test: checker exited 0"
fi
grep -q 'default-list' <<<"$out" \
  || fail "negative-readd-ui-test: output does not report default-list: $out"
echo "PASS negative-readd-ui-test"

# A local job removed from the default block: the same mismatch, the other way.
grep -v '^start shell-test job_shell_test$' "$DEFAULT_CHECK" > "$T/drop.sh"
if out="$(RSI_CHECK_SH="$T/drop.sh" bash "$HERE/test-check-job-parity.sh" 2>&1)"; then
  fail "negative-drop-shell-test: checker exited 0"
fi
grep -q 'default-list' <<<"$out" \
  || fail "negative-drop-shell-test: output does not report default-list: $out"
echo "PASS negative-drop-shell-test"

# The desktop job loses `npm test` while the console step and the relay step keep theirs:
# CI parity must still fail, which proves the desktop pair is read from its own job. The
# nested run sets RSI_CI_NEGATIVE so a wrongly-green inner run cannot re-enter this case
# (which would recurse instead of reporting); it still fails at case 3.
if [ -z "${RSI_CI_NEGATIVE:-}" ]; then
  mkdir -p "$T/ci"
  awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      name = $0; sub(/^  /, "", name); sub(/:.*/, "", name); in_desktop = (name == "desktop")
    }
    in_desktop && /^[[:space:]]*npm test[[:space:]]*$/ { print "          npm run test:desktop"; next }
    { print }
  ' "$CI" > "$T/ci/desktop-without-npm-test.yml"
  if out="$(RSI_CI_NEGATIVE=1 RSI_CI_FILE="$T/ci/desktop-without-npm-test.yml" \
    bash "$HERE/test-check-job-parity.sh" 2>&1)"; then
    fail "negative-desktop-scope: checker exited 0"
  fi
  grep -q 'ci-parity' <<<"$out" \
    || fail "negative-desktop-scope: output does not report ci-parity: $out"
  echo "PASS negative-desktop-scope"
fi
