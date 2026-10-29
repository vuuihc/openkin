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

start gofmt job_gofmt
start vet job_vet
start gotest job_gotest
start desktop-test job_desktop_test
start desktop-tsc job_desktop_tsc
start ui-test job_ui_test
start ui-tsc job_ui_tsc
start shell-syntax job_shell_syntax
start python-syntax job_python_syntax

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
    tail -25 "$LOG_DIR/$name.log"
  done
  exit 1
fi
