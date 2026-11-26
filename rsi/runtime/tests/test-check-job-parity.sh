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

# RSI_TEST_ONLY=<case> restricts the ci.yml classifier cases at the bottom to one
# case, so a mutants manifest can show a red run per case. The parity cases above
# still run; they are cheap and do not read the classifier.
ONLY="${RSI_TEST_ONLY:-}"
CLASSIFY_CASES_RUN=0

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

# --- cases 6-11: the workflow's docs classifier --------------------------------------------
# The `changes` job's `- id: classify` run block decides, from the changed file
# list, whether the build and mobile-rn jobs run. Nothing else tested it: a
# regression there silently skips CI and the PR still merges green-looking.
# These cases execute the workflow's own text — extracted from $CI by indentation,
# never copied — against temp git repositories and assert both answers.
#
# Hermetic: every fixture is committed in a mktemp repo with a local identity, so
# no global git config or network is involved.

# extract_classify_block <ci-file> <out-script> — write the `- id: classify`
# step's `run: |` body, de-indented. The block starts after that `run: |` line
# and ends at the first non-empty line indented no deeper than the `run:` key.
extract_classify_block() {
  awk '
    function lead(s,  i) { i = 0; while (substr(s, i + 1, 1) == " ") i++; return i }
    /^[[:space:]]*- id: classify[[:space:]]*$/ { step = 1; next }
    step && !run && /^[[:space:]]*run:[[:space:]]*\|[[:space:]]*$/ {
      key = lead($0); run = 1; next
    }
    step && run {
      if ($0 ~ /^[[:space:]]*$/) { buf[++n] = ""; next }
      ind = lead($0)
      if (ind <= key) exit
      buf[++n] = $0
      if (!have || ind < min) { min = ind; have = 1 }
    }
    END {
      if (!run) exit 3
      print "#!/bin/bash"
      for (i = 1; i <= n; i++) {
        if (buf[i] == "") { print ""; continue }
        print substr(buf[i], min + 1)
      }
    }
  ' "$1" > "$2"
}

# gitf <repo> <git args...> — git with a fixture identity, independent of the
# container's global config (a bare runner has none, and signing is off).
gitf() {
  git -c user.name=fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false -C "$1" "${@:2}"
}

# new_repo <tag> — a temp repo with one base commit; prints its path.
new_repo() {
  local repo="$T/repo-$1-$RANDOM"
  mkdir -p "$repo"
  git -c init.defaultBranch=main init -q "$repo"
  printf 'base\n' > "$repo/README.md"
  gitf "$repo" add README.md
  gitf "$repo" commit -qm base
  printf '%s\n' "$repo"
}

# classify_run <ci-file> <repo> <base> — run the extracted block inside <repo>
# with BASE_SHA and a fresh GITHUB_OUTPUT, then print the code=/rn= lines.
classify_run() {
  local ci="$1" repo="$2" base="$3" scr out log
  scr="$(mktemp "$T/classify-XXXXXX")"
  out="$(mktemp "$T/github-output-XXXXXX")"
  log="$(mktemp "$T/classify-XXXXXX")"
  extract_classify_block "$ci" "$scr" \
    || fail "classify: no '- id: classify' run block in $ci"
  # GitHub runs `run:` steps with `bash -eo pipefail`; mirror that so a mutant
  # that lets an unusable base reach the diff aborts here instead of coasting.
  ( cd "$repo" && BASE_SHA="$base" GITHUB_OUTPUT="$out" \
      bash -eo pipefail "$scr" ) >"$log" 2>&1 \
    || { cat "$log" >&2; fail "classify: the extracted block exited nonzero (ci=$ci base=${base:-<empty>})"; }
  cat "$out"
}

# expect_classify <label> <ci-file> <repo> <base> <code> <rn>
expect_classify() {
  local got
  got="$(classify_run "$2" "$3" "$4")" || exit 1
  if ! grep -qx "code=$5" <<<"$got" || ! grep -qx "rn=$6" <<<"$got"; then
    fail "classify: $1 expected code=$5 rn=$6, got: $(tr '\n' ' ' <<<"$got")"
  fi
}

# A doc no test names is not code.
case_unreferenced_doc() {
  local repo base doc
  repo="$(new_repo unreferenced)"; base="$(gitf "$repo" rev-parse HEAD)"
  doc="docs/notes-$RANDOM$RANDOM.md"
  mkdir -p "$repo/docs"; printf 'notes\n' > "$repo/$doc"
  gitf "$repo" add -A; gitf "$repo" commit -qm "add a doc"
  expect_classify "an unreferenced doc is not code" "$CI" "$repo" "$base" false false
  echo "PASS classify-unreferenced-doc"
}

# A doc a ui test names is code. The naming test is in the base commit, so the
# doc is the only changed path: code=true can only come from the lookup.
case_ui_named_doc() {
  local repo base doc ts
  repo="$(new_repo ui-named)"
  doc="docs/named-$RANDOM$RANDOM.md"
  ts="ui/src/lib/named-$RANDOM$RANDOM.test.ts"
  mkdir -p "$repo/ui/src/lib" "$repo/docs"
  printf '// names %s\n' "$doc" > "$repo/$ts"
  gitf "$repo" add -A; gitf "$repo" commit -qm "a ui test names a doc"
  base="$(gitf "$repo" rev-parse HEAD)"
  printf 'named\n' > "$repo/$doc"
  gitf "$repo" add -A; gitf "$repo" commit -qm "add the named doc"
  expect_classify "a doc a ui test names is code" "$CI" "$repo" "$base" true false
  echo "PASS classify-ui-named-doc"
}

# A doc a mobile-rn test names turns rn on. Same base-commit trick.
case_rn_named_doc() {
  local repo base doc ts
  repo="$(new_repo rn-named)"
  doc="mobile-rn/docs/named-$RANDOM$RANDOM.md"
  ts="mobile-rn/src/named-$RANDOM$RANDOM.test.ts"
  mkdir -p "$repo/mobile-rn/docs" "$repo/mobile-rn/src"
  printf '// names %s\n' "$doc" > "$repo/$ts"
  gitf "$repo" add -A; gitf "$repo" commit -qm "an rn test names a doc"
  base="$(gitf "$repo" rev-parse HEAD)"
  printf 'named\n' > "$repo/$doc"
  gitf "$repo" add -A; gitf "$repo" commit -qm "add the named rn doc"
  expect_classify "a doc a mobile-rn test names turns rn on" "$CI" "$repo" "$base" false true
  echo "PASS classify-rn-named-doc"
}

# A real rename in the repo: with --no-renames the deleted shell path stays in
# the list and is code; without it git reports only docs/tool.md, which is not.
case_rename_out_of_shell() {
  local repo base
  repo="$(new_repo rename)"
  printf '#!/bin/sh\n' > "$repo/tool.sh"
  gitf "$repo" add -A; gitf "$repo" commit -qm "add tool.sh"
  base="$(gitf "$repo" rev-parse HEAD)"
  mkdir -p "$repo/docs"
  gitf "$repo" mv tool.sh docs/tool.md
  gitf "$repo" commit -qm "rename the shell file to markdown"
  expect_classify "a rename out of a shell file is code" "$CI" "$repo" "$base" true false
  echo "PASS classify-rename-out-of-shell"
}

# An empty base and a non-existent sha both fail safe: code and rn stay on.
case_unusable_base() {
  local repo
  repo="$(new_repo unusable)"
  printf 'changed\n' > "$repo/note-$RANDOM.md"
  gitf "$repo" add -A; gitf "$repo" commit -qm "add a note"
  expect_classify "an empty base fails safe" "$CI" "$repo" "" true true
  expect_classify "a bogus base fails safe" "$CI" "$repo" \
    ffffffffffffffffffffffffffffffffffffffff true true
  echo "PASS classify-unusable-base"
}

# The harness executes the extracted text, not a baked-in copy: the same fixture
# answers true through the real workflow and false through a copy whose only
# change is the markdown branch's ui-test lookup.
case_block_is_real() {
  local repo base doc ts copy changed
  repo="$(new_repo real-block)"
  doc="docs/named-$RANDOM$RANDOM.md"
  ts="ui/src/lib/named-$RANDOM$RANDOM.test.ts"
  mkdir -p "$repo/ui/src/lib" "$repo/docs"
  printf '// names %s\n' "$doc" > "$repo/$ts"
  gitf "$repo" add -A; gitf "$repo" commit -qm "a ui test names a doc"
  base="$(gitf "$repo" rev-parse HEAD)"
  printf 'named\n' > "$repo/$doc"
  gitf "$repo" add -A; gitf "$repo" commit -qm "add the named doc"

  expect_classify "the block is read from the workflow" "$CI" "$repo" "$base" true false

  copy="$T/ci-$RANDOM.yml"
  python3 - "$CI" "$copy" <<'PY' || fail "classify: could not build the mutated workflow copy"
import sys
src, dst = sys.argv[1], sys.argv[2]
old = 'named_by_test "$p" && code=true'
text = open(src, encoding="utf-8").read()
if text.count(old) != 1:
    sys.exit("expected exactly one %r, found %d" % (old, text.count(old)))
open(dst, "w", encoding="utf-8").write(text.replace(old, ":"))
PY
  changed="$(diff "$CI" "$copy" | grep -cE '^[<>]')"
  [ "$changed" -eq 2 ] || fail "classify: the copy differs by $changed line(s), expected one"
  expect_classify "the answer follows the workflow text" "$copy" "$repo" "$base" false false
  echo "PASS classify-block-is-real"
}

run_classifier_case() { # <case> <function> — skip unless RSI_TEST_ONLY names it
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || return 0
  CLASSIFY_CASES_RUN=$((CLASSIFY_CASES_RUN + 1))
  "$2"
}

run_classifier_case classify-unreferenced-doc case_unreferenced_doc
run_classifier_case classify-ui-named-doc case_ui_named_doc
run_classifier_case classify-rn-named-doc case_rn_named_doc
run_classifier_case classify-rename-out-of-shell case_rename_out_of_shell
run_classifier_case classify-unusable-base case_unusable_base
run_classifier_case classify-block-is-real case_block_is_real

if [ -n "$ONLY" ] && [ "$CLASSIFY_CASES_RUN" -eq 0 ]; then
  fail "RSI_TEST_ONLY='$ONLY' matched no classifier case"
fi
