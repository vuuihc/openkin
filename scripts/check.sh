#!/usr/bin/env bash
# Run the checks that match a change set, in parallel, with one summary.
#
# Usage:
#   ./scripts/check.sh            # the checks CI does not run, scoped to the change set
#   ./scripts/check.sh --all      # every check, including the eight CI runs on every push
#   ./scripts/check.sh --list     # print the job names this run would start, then exit
#   KIN_CHECK_SCOPE=rn ./scripts/check.sh
#                               # RN-only gate scope: just the jobs that judge a
#                               # mobile-rn/-only diff (mobile-rn + stories)
#   KIN_CHECK_SCOPE=docs KIN_CHECK_CHANGED=<file> ./scripts/check.sh
#                               # docs-only gate scope: stories + ux-spec-refs +
#                               # doc-refs (suites that name the changed paths)
#
# CI (.github/workflows/ci.yml) already runs vet, go test ./..., the console suite and
# typecheck, the desktop suite and typecheck, the inventory ratchet and the added-file
# lint guard on every push, and the merge gate requires green PR checks, so the default
# run leaves that duplicate work out (R-gate-ci-dedupe); --all is the complete local run.
# gate.sh still runs its own lint, changed-file test, build and ratchet steps.
#
# Each job writes its own log; a failing job prints the tail. Exit status is
# nonzero if any job failed, so this is safe to use at a commit gate.
set -uo pipefail
export GOMAXPROCS="${GOMAXPROCS:-2}" GO_TEST_P="${GO_TEST_P:-2}" VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
cd "$ROOT"

ALL=0
LIST=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --list) LIST=1 ;;
    *) echo "check.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# gate.sh sets KIN_CHECK_SCOPE=rn when every changed path is mobile-rn/... or the RN ADR
# (docs/adr/0036-*), and =docs when every changed path is markdown outside ui/, web/ and
# mobile-rn/ (AGENTS.md/CLAUDE.md stay full): on 2026-11-24 the gate lock sat 11.2 h of
# 21.5 h on RN/docs PRs, each paying ~10 min for repo-wide jobs (job_shell_test's ~90
# suites) that cannot judge the diff. A scope starts only its own job set; --all always
# wins; any other value is a caller bug.
SCOPE="${KIN_CHECK_SCOPE:-}"
RN_SCOPE_JOBS="mobile-rn stories"
DOCS_SCOPE_JOBS="stories ux-spec-refs doc-refs"
SCOPE_JOBS=""
case "$SCOPE" in
  "") ;;
  rn) SCOPE_JOBS="$RN_SCOPE_JOBS" ;;
  docs) SCOPE_JOBS="$DOCS_SCOPE_JOBS" ;;
  *) echo "check.sh: unknown KIN_CHECK_SCOPE: '$SCOPE'" >&2; exit 2 ;;
esac
SCOPED=0
[ -n "$SCOPE" ] && [ "$ALL" -eq 0 ] && SCOPED=1
# doc-refs greps the changed-path list for the suites that name it, so a docs-scoped run
# (not --all, which overrides the whole scope) needs the file gate.sh passes it.
if [ "$SCOPE" = docs ] && [ "$SCOPED" -eq 1 ]; then
  { [ -n "${KIN_CHECK_CHANGED:-}" ] && [ -f "$KIN_CHECK_CHANGED" ]; } || {
    echo "check.sh: KIN_CHECK_SCOPE=docs needs KIN_CHECK_CHANGED=<file of changed paths>" >&2
    exit 2
  }
fi
# scope_jobs <name> — true when name survives this scoped run. --list and start() both
# read the one set, so the printed plan cannot drift from what a run starts.
scope_jobs() { [[ " $SCOPE_JOBS " == *" $1 "* ]]; }

# --list prints the names the start lines below would start, in start order, and exits
# before any job (or temp dir) is created. It reads those lines from this file, so the
# printed list cannot drift from what a run starts; the block between the markers is
# the --all-only set and is skipped unless --all was given.
if [[ "$LIST" == "1" ]]; then
  awk -v all="$ALL" -v scoped="$SCOPED" -v scope="$SCOPE" -v scj=" $SCOPE_JOBS " '
    /^# BEGIN all-only jobs/    { block = 1; next }
    /^# END all-only jobs/      { block = 0; next }
    /^# BEGIN docs-scope jobs/  { dblock = 1; next }
    /^# END docs-scope jobs/    { dblock = 0; next }
    /^[[:space:]]*start [A-Za-z0-9._-]+ job_[A-Za-z0-9_]+$/ {
      if (block && all != 1) next
      if (dblock && (scoped != 1 || scope != "docs")) next
      if (scoped == 1 && index(scj, " " $2 " ") == 0) next
      print $2
    }
  ' "$SELF" || exit 1
  exit 0
fi

LOG_DIR="$(mktemp -d /tmp/kin-check.XXXXXX)"
trap 'rm -rf "$LOG_DIR"' EXIT

NAMES=()
PIDS=()

# Name the jobs a killed run took down. The gate used to record only anonymous PIDs
# (`line 402: 95876 Terminated: 15`), which cannot say which job the kill interrupted; on
# 2026-11-23 that ambiguity turned a machine-side SIGTERM into `FAIL: check` and a rework
# round for PR #640 that found nothing to fix. A zombie (finished, not yet reaped) is not
# running, so `ps` state is the liveness read here, not `kill -0`.
interrupt_report() { # signal
  local i p st names=""
  for ((i = 0; i < ${#PIDS[@]}; i++)); do
    p="${PIDS[$i]}"
    [ -n "$p" ] || continue
    st="$(ps -o state= -p "$p" 2>/dev/null | tr -d ' ')"
    if [ -n "$st" ] && [ "${st#Z}" = "$st" ]; then
      names="${names:+$names }${NAMES[$i]}"
    fi
  done
  printf 'check.sh: interrupted by SIG%s; jobs still running: %s\n' "$1" "${names:-none}" >&2
}
on_interrupt() { # signal
  local i
  interrupt_report "$1"
  for ((i = 0; i < ${#PIDS[@]}; i++)); do
    [ -n "${PIDS[$i]:-}" ] && kill -TERM "${PIDS[$i]}" 2>/dev/null
  done
  exit 143
}
trap 'on_interrupt TERM' TERM
trap 'on_interrupt INT' INT

# RSI_CHECK_JOB_STUB replaces every job body with one shell command, handed the job name as
# $0. Hermetic suites use it to exercise this script's own interrupt reporting
# (rsi/runtime/tests/test-gate-no-verdict.sh): a real run takes minutes and would recurse into
# itself from inside a job.
start() { # name function
  local name="$1"
  shift
  # Same SCOPE_JOBS set --list filters on, so a scoped run starts what it printed.
  [[ "$SCOPED" == "1" ]] && ! scope_jobs "$name" && return 0
  NAMES+=("$name")
  if [ -n "${RSI_CHECK_JOB_STUB:-}" ]; then
    ( bash -c "$RSI_CHECK_JOB_STUB" "$name" ) >"$LOG_DIR/$name.log" 2>&1 &
  else
    ( "$@" ) >"$LOG_DIR/$name.log" 2>&1 &
  fi
  PIDS+=($!)
}

changed_go_files() {
  git status --porcelain=v1 2>/dev/null | awk '{print $NF}' | grep -E '\.go$' || true
}

changed_go_pkgs() {
  local dirs
  dirs="$(changed_go_files | xargs -n1 dirname 2>/dev/null | sort -u |
    grep -E '^(cmd|internal|web)/' || true)"
  [[ -z "$dirs" ]] && return 0
  # A removed package still shows up in `git status` as its last files being
  # deleted, but there is no directory left to vet or test. Passing it on makes
  # the check fail with "directory not found" on exactly the change that
  # removed it.
  while IFS= read -r dir; do
    [[ -d "$dir" ]] && printf './%s\n' "$dir"
  done <<<"$dirs"
}

changed_probe_files() {
  git status --porcelain=v1 2>/dev/null | awk '{print $NF}' | grep -E '^probe/[^/]+/.*\.go$' || true
}

changed_shell_files() {
  git status --porcelain=v1 2>/dev/null | awk '{print $NF}' | grep -E '\.sh$' || true
}

changed_python_files() {
  git status --porcelain=v1 2>/dev/null | awk '{print $NF}' | grep -E '\.py$' || true
}

changed_ui_files() {
  git status --porcelain=v1 2>/dev/null | awk '{print $NF}' |
    grep -E '^ui/(src/|package\.json$|package-lock\.json$|tsconfig|vite\.config|index\.html$)' || true
}

changed_api_files() {
  git status --porcelain=v1 2>/dev/null | awk '{print $NF}' |
    grep -E '^(api/openapi\.yaml|ui/src/api/generated/openapi\.ts)$' || true
}

job_gofmt() {
  local files
  files="$(changed_go_files)"
  if [[ -z "$files" ]]; then
    echo "no changed Go files"
    return 0
  fi
  local out
  # shellcheck disable=SC2086
  out="$(gofmt -l $files)"
  if [[ -n "$out" ]]; then
    echo "not gofmt'd:"
    echo "$out"
    return 1
  fi
}

job_vet() {
  if [[ "$ALL" == "1" ]]; then
    go vet ./...
    return
  fi
  local pkgs
  pkgs="$(changed_go_pkgs)"
  if [[ -z "$pkgs" ]]; then
    echo "no changed Go packages"
    return 0
  fi
  echo "packages: $pkgs"
  # shellcheck disable=SC2086
  go vet $pkgs
}

job_gotest() {
  if [[ "$ALL" == "1" ]]; then
    go test -p "${GO_TEST_P:-2}" -timeout 300s ./...
    return
  fi
  local pkgs
  pkgs="$(changed_go_pkgs)"
  if [[ -z "$pkgs" ]]; then
    echo "no changed Go packages"
    return 0
  fi
  echo "packages: $pkgs"
  # shellcheck disable=SC2086
  go test -p "${GO_TEST_P:-2}" -timeout 120s -count=1 $pkgs
}

# The probes are their own Go modules, so the root vet/test jobs cannot see
# them. Run each module; a failure in either fails the job.
job_probe() {
  if [[ "$ALL" != "1" ]] && [[ -z "$(changed_probe_files)" ]]; then
    echo "no changed probe files"
    return 0
  fi
  local mod
  for mod in probe/kin-probe probe/kin-probe-w4 probe/kin-probe-w4b; do
    ( cd "$mod" && go vet ./... && go test -p "${GO_TEST_P:-2}" -race -timeout 300s -count=1 ./... ) || return 1
  done
}

job_desktop_test() {
  ( cd desktop && node --test "src/**/*.test.ts" )
}

job_desktop_tsc() {
  ( cd desktop && npx tsc --noEmit )
}

# The console's own suite and typecheck. UI changes are the ones a Go or shell
# job never sees; gated on ui/ paths so a backend-only change set does not pay
# for them, and always run under --all.
job_ui_test() {
  if [[ "$ALL" != "1" ]] && [[ -z "$(changed_ui_files)" ]]; then
    echo "no changed console files"
    return 0
  fi
  ( cd ui && npm run test -- --maxWorkers="${VITEST_MAX_WORKERS:-2}" )
}

job_ui_tsc() {
  if [[ "$ALL" != "1" ]] && [[ -z "$(changed_ui_files)" ]]; then
    echo "no changed console files"
    return 0
  fi
  ( cd ui && npx tsc --noEmit )
}

# The checked-in OpenAPI types are a build artifact: a spec edit without
# `npm run generate:api` fails CI and `make test`, and neither the Go nor the
# console job above would see it.
job_api_contract() {
  if [[ "$ALL" != "1" ]] && [[ -z "$(changed_api_files)" ]]; then
    echo "no changed API contract files"
    return 0
  fi
  ./scripts/check-openapi.sh
}

# The contract must name every path a shipped client calls, and no path the
# daemon no longer registers. Always run: a new client call is drift even when
# the spec itself did not change, and neither the Go nor the console job sees it.
job_api_coverage() {
  ./scripts/check-api-coverage.sh
}

job_shell_syntax() {
  local files
  files="$(changed_shell_files)"
  if [[ -z "$files" ]]; then
    echo "no changed shell files"
    return 0
  fi
  local f
  for f in $files; do
    echo "bash -n $f"
    bash -n "$f" || return 1
  done
}

# The installer and the loop's own guard scripts are shell, so no Go or console job
# sees them. Their contract tests use fake Docker, stubbed npm/launchctl, temp git
# repos and no network, so the whole set stays cheap; every hermetic suite under
# rsi/runtime/tests, rsi/runtime/nas/tests and rsi/runtime/ux is wired here
# (test-wiring.sh enforces that), because a broken claim, tier, sendback or
# backpressure guard otherwise lands on main unnoticed and the next fill pulse
# stalls or refuses a valid claim.
job_shell_test() {
  ./scripts/install-hub.test.sh || return 1
  bash rsi/runtime/format-changed.test.sh || return 1
  bash rsi/runtime/tests/node-stamp-test.sh || return 1
  bash rsi/runtime/tests/test-escalate.sh || return 1
  bash rsi/runtime/tests/test-weekly-report.sh || return 1
  bash rsi/runtime/tests/test-scorecard-fold.sh || return 1
  bash rsi/runtime/tests/test-gate-backpressure.sh || return 1
  bash rsi/runtime/tests/test-outside-tests.sh || return 1
  bash rsi/runtime/tests/test-throughput.sh || return 1
  bash rsi/runtime/tests/test-lanes-history.sh || return 1
  bash rsi/runtime/tests/test-lane-spare-pressure.sh || return 1
  bash rsi/runtime/tests/test-claim-merged.sh || return 1
  bash rsi/runtime/tests/test-lanes-claim-paths.sh || return 1
  bash rsi/runtime/tests/test-runtime-modes.sh || return 1
  bash rsi/runtime/tests/test-merge-gen-resolve.sh || return 1
  bash rsi/runtime/tests/test-gate-carry.sh || return 1
  # The default gate starts only the jobs CI does not run; this pins the split and the
  # premises that make dropping the rest safe (R-gate-ci-dedupe).
  bash rsi/runtime/tests/test-check-job-parity.sh || return 1
  # An RN-only PR scopes the gate's check step to mobile-rn + stories (KIN_CHECK_SCOPE=rn).
  bash rsi/runtime/tests/test-check-rn-scope.sh || return 1
  # A docs-only PR scopes the gate's check step to stories + ux-spec-refs + doc-refs.
  bash rsi/runtime/tests/test-check-docs-scope.sh || return 1
  bash rsi/runtime/tests/test-rename-copy-check.sh || return 1
  bash rsi/runtime/tests/test-ux-carry-key.sh || return 1
  bash rsi/runtime/tests/test-verifier-ci-hold.sh || return 1
  bash rsi/runtime/tests/test-merge-sync-skip.sh || return 1
  bash rsi/runtime/tests/test-merge-sync-abort.sh || return 1
  bash rsi/runtime/tests/test-merge-pr-select.sh || return 1
  bash rsi/runtime/tests/test-merge-slot-priority.sh || return 1
  bash rsi/runtime/tests/test-unseen-pr.sh || return 1
  bash rsi/runtime/tests/test-merge-rework-stalled.sh || return 1
  bash rsi/runtime/tests/test-merge-batch.sh || return 1
  bash rsi/runtime/tests/test-merge-ceo-ok.sh || return 1
  bash rsi/runtime/tests/test-gate-lock-timeout.sh || return 1
  bash rsi/runtime/tests/test-gate-no-verdict.sh || return 1
  # The walk mutant's red proof builds the UI twice, so the gate runs only the
  # runner's hermetic mode here; the browser proof itself is one command by hand
  # (rsi/runtime/ux/walk-mutant-test.sh).
  bash rsi/runtime/tests/test-walk-mutant.sh || return 1
  bash rsi/runtime/tests/test-mutants-restore.sh || return 1
  bash rsi/runtime/tests/test-journeys-smoke-assets.sh || return 1
  bash rsi/runtime/tests/test-smoke-assets.sh || return 1
  bash rsi/runtime/tests/test-dream-contract.sh || return 1
  bash rsi/runtime/ux/walk-mutant-test.sh --print-manifest >/dev/null || return 1
  bash rsi/runtime/tests/test-ux-walker.sh || return 1
  bash rsi/runtime/tests/test-ux-walk-timeout.sh || return 1
  # An optional walk step waits out one bounded paint before it records a skip
  # (Watch 62: J14 logged 展开全部 as skipped while the list was rendering).
  bash rsi/runtime/tests/test-optional-grace.sh || return 1
  bash rsi/runtime/tests/test-loop-sendback-stale.sh || return 1
  bash rsi/runtime/tests/test-lane-autofill.sh || return 1
  bash rsi/runtime/tests/test-lane-worker-contract.sh || return 1
  bash rsi/runtime/tests/test-lane-sendback-reserve.sh || return 1
  bash rsi/runtime/tests/test-lane-control-tree-guard.sh || return 1
  bash rsi/runtime/tests/test-evidence-widths.sh || return 1
  bash rsi/runtime/tests/test-claim-copies.sh || return 1
  bash rsi/runtime/tests/test-lanes-facts.sh || return 1
  bash rsi/runtime/tests/test-sendback-provenance.sh || return 1
  bash rsi/runtime/tests/test-release.sh || return 1
  # The release gate waits out a `heavy:` HOLD instead of being read once per patrol; the
  # wait, its deadline, its log line and its dry-run exit are proven red here (2026-11-22).
  bash rsi/runtime/tests/test-release-wait.sh || return 1
  bash rsi/runtime/tests/test-release-wait-red.sh || return 1
  bash rsi/runtime/tests/test-pace.sh || return 1
  bash rsi/runtime/tests/test-control-sync.sh || return 1
  bash rsi/runtime/tests/test-install.sh || return 1
  bash rsi/runtime/tests/test-utf8-truncation.sh || return 1
  bash rsi/runtime/tests/test-fill-claim-check.sh || return 1
  bash rsi/runtime/tests/test-claim-check.sh || return 1
  # A fix PR must move its own gap-log entry to ## 已修 in the same PR, and the merge gate
  # refuses it otherwise (R-gap-log-close-guard; #611/#615/#632 each paid a docs-only PR).
  bash rsi/runtime/tests/test-gap-log-guard.sh || return 1
  # A claimed test must go red when its file is reverted to origin/main (red-first lane seam).
  bash rsi/runtime/tests/test-red-first.sh || return 1
  bash rsi/runtime/tests/test-reviewer-misses.sh || return 1
  bash rsi/runtime/tests/test-rework-attrib.sh || return 1
  bash rsi/runtime/tests/test-followups-lint.sh || return 1
  bash rsi/runtime/tests/test-worktree-report.sh || return 1
  bash rsi/runtime/tests/test-live-config-ignore.sh || return 1
  bash rsi/runtime/tests/test-lane-bash-timeout.sh || return 1
  bash rsi/runtime/tests/test-dispatch-codex-timeout.sh || return 1
  bash rsi/runtime/tests/test-dispatch-review-findings.sh || return 1
  bash rsi/runtime/tests/test-lane-pr-retry.sh || return 1
  # A finished round survives one transient `git push` failure; a final failure leaves it
  # committed and marked delivered-unpushed instead of throwing the work away (R-lane-push-retry).
  bash rsi/runtime/tests/test-lane-push-retry.sh || return 1
  # A worker that left its own process tree (setsid -> launchd, booted simulators)
  # is still reaped: cleanup sweeps by worktree cwd and shuts down only the
  # simulators this lane booted (2026-11-25 orphan-simulator incident).
  bash rsi/runtime/tests/test-lane-orphan-reap.sh || return 1
  bash rsi/runtime/nas/tests/test-nas.sh || return 1
  bash rsi/runtime/nas/tests/test-install-preflight.sh || return 1
  bash rsi/runtime/ux/retry-test.sh || return 1
  bash rsi/runtime/tests/test-ux-gate-confirm-red.sh || return 1
  bash rsi/runtime/tests/test-ux-gate-confirm-variant.sh || return 1
  bash rsi/runtime/tests/test-ux-gate-grounded-red.sh || return 1
  bash rsi/runtime/tests/test-switch-attribution.sh || return 1
  bash rsi/runtime/tests/test-lane-leftovers.sh || return 1
  bash rsi/runtime/tests/test-lane-mutants.sh || return 1
  bash rsi/runtime/tests/test-lane-claim-check.sh || return 1
  bash rsi/runtime/tests/test-removed-literal-check.sh || return 1
  bash rsi/runtime/tests/test-wiring.sh
}

# The RN client's own typecheck and suite. The merge gate runs this default set,
# so the scaffold cannot land without the gate ADR 0036 §4 fixed the job id for.
# The scaffold has no committed package-lock.json yet (the NAS lane that wrote it
# has no registry access), so a first run resolves node_modules with npm install,
# and --no-package-lock keeps it from writing an untracked lockfile that would
# leave the tree dirty for gate.sh; once a lockfile lands, npm ci is the
# reproducible path. Either install is stamped inside node_modules and skipped
# while the manifest's hash is unchanged, so a repeat run does not reinstall.
job_mobile_rn() {
  ( cd mobile-rn || exit 1
    if [[ -f package-lock.json ]]; then
      stamp=node_modules/.kin-lock-sha; want="$(git hash-object package-lock.json)" || exit 1
      if [[ "$(cat "$stamp" 2>/dev/null)" != "$want" ]]; then
        npm ci --no-audit --no-fund || exit 1
        printf '%s\n' "$want" > "$stamp" || exit 1
      fi
    else
      stamp=node_modules/.kin-pkg-sha; want="$(git hash-object package.json)" || exit 1
      if [[ "$(cat "$stamp" 2>/dev/null)" != "$want" ]]; then
        npm install --no-package-lock --no-audit --no-fund || exit 1
        printf '%s\n' "$want" > "$stamp" || exit 1
      fi
    fi
    npx tsc --noEmit || exit 1
    npx jest --ci )
}

job_python_syntax() {
  local files
  files="$(changed_python_files)"
  if [[ -z "$files" ]]; then
    echo "no changed Python files"
    return 0
  fi
  local f
  for f in $files; do
    echo "ast.parse $f"
    # Parse without writing __pycache__ into the tree.
    python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$f" || return 1
  done
}

# Story contracts, the registry index, and the tests that name them must agree.
# Cheap enough to run on every change set, and it is the only check that sees a
# story whose test was renamed away.
job_stories() {
  python3 scripts/stories.py
}

# The inventory ratchet and the tests that prove the checker can fail. Started
# only by --all: CI runs the ratchet on every push, so the default gate leaves it
# there, while a complete local run must not let a new raw control land without a
# ui/ change or local RSI state. `-B` avoids __pycache__ in the tree.
job_ui_inventory() {
  python3 -B scripts/check-ui-inventory.test.py || return 1
  python3 -B scripts/check-ui-inventory.py
}

# The deletions this repo made on purpose, and the tests that prove the
# checker can fail. Always runs: a merge that restores a deleted surface must
# turn this job red even when no Go, shell or console job looks at that path,
# and a changed-file glob would miss exactly that merge.
job_removed_surfaces() {
  python3 -B scripts/check-removed-surfaces.test.py || return 1
  python3 -B scripts/check-removed-surfaces.py
}

# The journey spec's refs against the live console facts: an area, a route or a
# `data-kin-*` hook a journey still names after its surface retired. Always
# runs: #584's sendback was one stale `[data-area="projects"]` selector, and
# only the ~20-minute browser walk noticed. The suite runs first, so a broken
# guard is reported as the guard. `-B` avoids __pycache__ in the tree.
job_ux_spec_refs() {
  python3 -B scripts/ux_spec_refs_test.py || return 1
  python3 -B scripts/ux_spec_refs.py
}

# The added-file bans and their own tests. Started only by --all: CI runs both on
# every push, so the default gate leaves them there, while a complete local run
# still turns this job red when a disabled rule passes `ui-test`.
job_ui_lint_guard() {
  python3 -B -m unittest scripts/ui_lint_guard_test.py || return 1
  ./scripts/ui-lint-guard.sh
}

# The journey walk's J3/J7 spec contracts, checked without a browser. walk.mjs's
# --check-spec is the merge gate's proof that J3 presses Start, puts the mid-run
# follow-up on screen before the first answer, and that J7 lands on the card the
# notification named; a spec that regresses those rules must turn this job red
# instead of reaching dogfooding. `-B` avoids __pycache__ in the tree.
job_walk_contract() {
  python3 -B scripts/journeys_walk_test.py || return 1
}

# The phone console baseline's parser and six guards, checked without a browser.
# `--self-check` feeds synthetic mark sets through the same `runGuards` a real
# measurement uses and proves each guard exits 2 and a good set prints a number;
# no build, browser, or web/dist is needed, so a guard regression turns this job
# red instead of quietly producing an untrustworthy median.
job_phone_baseline_contract() {
  node scripts/phone-console-startup.mjs --self-check || return 1
}

# The smoke summarizer reads the same journeys.json and walk.json, and its
# fixture cases are hermetic and cheap, so they run beside the walk contract.
job_journeys_smoke() {
  python3 -B scripts/journeys_smoke_test.py || return 1
}

# KIN-QUALITY-001's reading rules, fixture and gate wiring without a browser;
# the pixel rows are the one-command walk the PR carries.
job_quality_reading_contract() {
  python3 -B scripts/quality_001_reading_test.py
}

# A docs-only diff cannot pay for the repo-wide suite: the evidence is the suites that
# actually name the changed file. Started only under KIN_CHECK_SCOPE=docs (the
# docs-scope start block below). For each path in $KIN_CHECK_CHANGED it greps the loop's
# shell suites — rsi/runtime/**/tests/*.sh and any *.test.sh under rsi/runtime or
# scripts — for the repo-relative path and the basename, runs every match once, and
# names each one it ran so the gate log proves it. A ui/**/*.test.*, *_test.py /
# *.test.py or *_test.go hit is coverage this job cannot run hermetically, so it prints
# DOC_REFS_FALLBACK and fails closed rather than silently skipping it.
job_doc_refs() {
  local changed="${KIN_CHECK_CHANGED:-}"
  [ -n "$changed" ] && [ -f "$changed" ] || {
    echo "doc-refs: KIN_CHECK_CHANGED is not set or not a file: '${changed:-unset}'"
    return 2
  }
  local path base rc=0 ran=0 s f fb
  local suites="$LOG_DIR/doc-refs.suites"
  : >"$suites"
  while IFS= read -r path || [ -n "$path" ]; do
    [ -z "$path" ] && continue
    base="${path##*/}"
    while IFS= read -r s; do
      grep -qF -e "$path" -e "$base" -- "$s" && echo "$s" >>"$suites"
    done < <(find rsi/runtime scripts -type f -name '*.sh' \
      \( -path '*/tests/*' -o -name '*.test.sh' \))
    fb="$( { grep -rlF --include='*.test.*' --exclude-dir=node_modules \
              -e "$path" -e "$base" ui 2>/dev/null
            grep -rlF --include='*_test.go' --exclude-dir=.git \
              --exclude-dir=node_modules -e "$path" -e "$base" . 2>/dev/null
            grep -rlF --include='*_test.py' --include='*.test.py' \
              --exclude-dir=.git --exclude-dir=node_modules \
              -e "$path" -e "$base" . 2>/dev/null; } | sort -u )"
    if [ -n "$fb" ]; then
      while IFS= read -r f; do echo "DOC_REFS_FALLBACK $f"; done <<<"$fb"
      echo "docs scope cannot cover the tests that name $path; run full"
      rc=1
    fi
  done <"$changed"
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    echo "doc-refs: $s names a changed doc — running it"
    bash "$s" || rc=1
    ran=$((ran + 1))
  done < <(sort -u "$suites")
  echo "doc-refs: $ran suite(s) ran"
  return "$rc"
}

start gofmt job_gofmt
start probe job_probe
start api-contract job_api_contract
start api-coverage job_api_coverage
start shell-syntax job_shell_syntax
start shell-test job_shell_test
start python-syntax job_python_syntax
start stories job_stories
start removed-surfaces job_removed_surfaces
start ux-spec-refs job_ux_spec_refs
start walk-contract job_walk_contract
start phone-baseline-contract job_phone_baseline_contract
start journeys-smoke job_journeys_smoke
start quality-reading-contract job_quality_reading_contract
start mobile-rn job_mobile_rn

# doc-refs exists only inside a docs-scoped run — it reads $KIN_CHECK_CHANGED, which the
# default and --all runs do not carry — so its start line lives behind the same kind of
# marker as the --all block and --list shows it only for KIN_CHECK_SCOPE=docs.
# BEGIN docs-scope jobs
if [[ "$SCOPE" == "docs" ]] && [[ "$ALL" == "0" ]]; then
  start doc-refs job_doc_refs
fi
# END docs-scope jobs

# The eight jobs CI already runs on every push (.github/workflows/ci.yml): `go vet
# ./...` and `go test ./...` (build job), `npm test` + `npx tsc --noEmit` (build job's
# UI step), `npm test` + `npm run typecheck` (desktop job), the inventory ratchet with
# its test, and the added-file lint guard with its test (build job). The merge gate
# requires green PR checks (rsi/MANDATE.md), so starting them again locally only
# lengthens every gate without adding evidence (R-gate-ci-dedupe). --all starts them
# for a complete one-command local run; gate.sh keeps its own lint, changed-file test,
# build and ratchet steps.
# BEGIN all-only jobs
if [[ "$ALL" == "1" ]]; then
  start vet job_vet
  start gotest job_gotest
  start desktop-test job_desktop_test
  start desktop-tsc job_desktop_tsc
  start ui-test job_ui_test
  start ui-tsc job_ui_tsc
  start ui-inventory job_ui_inventory
  start ui-lint-guard job_ui_lint_guard
fi
# END all-only jobs

FAILED=()
for i in "${!PIDS[@]}"; do
  name="${NAMES[$i]}"
  if wait "${PIDS[$i]}"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    FAILED+=("$name")
  fi
done

if ((${#FAILED[@]})); then
  for name in "${FAILED[@]}"; do
    echo ""
    echo "--- $name ---"
    # A package failure can be hundreds of ok lines above the end of the log;
    # name it before the tail so a load-induced or ordering failure is
    # diagnosable without re-running the whole gate.
    if grep -qE '(^FAIL|--- FAIL|panic:|test timed out|signal: killed)' "$LOG_DIR/$name.log"; then
      grep -nE '(^FAIL|--- FAIL|panic:|test timed out|signal: killed)' "$LOG_DIR/$name.log" | head -20
      echo "--- tail ---"
    fi
    tail -25 "$LOG_DIR/$name.log"
  done
  exit 1
fi
