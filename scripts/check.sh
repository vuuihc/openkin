#!/usr/bin/env bash
# Run the checks that match a change set, in parallel, with one summary.
#
# Usage:
#   ./scripts/check.sh            # changed Go packages, vet, gofmt, desktop, tsc, console
#   ./scripts/check.sh --all      # go test ./... instead of changed packages
#
# Each job writes its own log; a failing job prints the tail. Exit status is
# nonzero if any job failed, so this is safe to use at a commit gate.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALL=0
[[ "${1:-}" == "--all" ]] && ALL=1

LOG_DIR="$(mktemp -d /tmp/kin-check.XXXXXX)"
trap 'rm -rf "$LOG_DIR"' EXIT

NAMES=()
PIDS=()

start() { # name function
  local name="$1"
  shift
  NAMES+=("$name")
  ( "$@" ) >"$LOG_DIR/$name.log" 2>&1 &
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
  printf './%s\n' $dirs
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
    go test -timeout 300s ./...
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
  go test -timeout 120s -count=1 $pkgs
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
    ( cd "$mod" && go vet ./... && go test -race -timeout 300s -count=1 ./... ) || return 1
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
  ( cd ui && npm run test )
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

# The installer is the path an agent runs end to end. Its contract tests use a
# fake Docker, so they are fast and need no daemon; no other job executes the
# script's behavior.
job_shell_test() {
  ./scripts/install-hub.test.sh
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

start gofmt job_gofmt
start vet job_vet
start gotest job_gotest
start probe job_probe
start desktop-test job_desktop_test
start desktop-tsc job_desktop_tsc
start ui-test job_ui_test
start ui-tsc job_ui_tsc
start api-contract job_api_contract
start api-coverage job_api_coverage
start shell-syntax job_shell_syntax
start shell-test job_shell_test
start python-syntax job_python_syntax
start stories job_stories

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
