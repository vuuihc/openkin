#!/bin/bash
# gate.sh <worktree>  — the merge gate. Prints GATE_RESULT=PASS|FAIL with the reasons.
# gate.sh --only <step[,step]> <worktree> — bisect helper: run only the named step()s (plus
# their prerequisites) and print GATE_RESULT=PARTIAL[<why>]. A filtered run is a diagnostic:
# it is never PASS or FAIL with a full-gate meaning, and the verifier must not accept it.
set -u
ONLY=""
if [ "${1:-}" = "--only" ]; then ONLY="${2:?--only needs step[,step]}"; shift 2; fi

# scope_of <file>: `rn` when the changed-file list is non-empty and every path is under
# mobile-rn/ or is the RN gate ADR (docs/adr/0036-*); `docs` when it is non-empty and every
# path is markdown outside ui/, web/ and mobile-rn/ that is not an AGENTS.md or CLAUDE.md
# (those two pin counts full-gate tests assert); anything else, including an empty list,
# is `full`. Precedence is rn > docs > full. 2026-11-24 measurement: .gate.lock was held
# 21.5 h across 100 runs and 11.2 h of it was RN/docs PRs, each paying ~10 min of
# repo-wide check jobs it cannot use.
scope_of() {
  local n=0 rn=1 docs=1 line
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    n=$((n + 1))
    case "$line" in
      mobile-rn/*|docs/adr/0036-*) ;;
      *) rn=0 ;;
    esac
    case "$line" in
      ui/*|web/*|mobile-rn/*|AGENTS.md|*/AGENTS.md|CLAUDE.md|*/CLAUDE.md) docs=0 ;;
      *.md) ;;
      *) docs=0 ;;
    esac
  done <"$1"
  [ "$n" -eq 0 ] && { echo full; return; }
  [ "$rn" -eq 1 ] && { echo rn; return; }
  [ "$docs" -eq 1 ] && { echo docs; return; }
  echo full
}
# gate.sh --scope-of <file> prints that scope for a changed-file list, then exits.
if [ "${1:-}" = "--scope-of" ]; then scope_of "${2:?--scope-of needs a file}"; exit 0; fi
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
source "$(cd "$(dirname "$0")" && pwd)/node-stamp.sh"
source "$(cd "$(dirname "$0")" && pwd)/gate-env.sh"
WT="${1:?worktree required}"; cd "$WT" || { echo "GATE_RESULT=FAIL no worktree"; exit 1; }
ONLY_MODE=0; [ -n "$ONLY" ] && ONLY_MODE=1
selected() { # <step-name> — 0 when this run should execute that step
  [ "$ONLY_MODE" -eq 0 ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}
# test/build/lint compile the console, so they need the install the node-stamp step repairs.
needs_node_stamp() {
  selected test || selected build || selected lint
}
fail=0; why=""
step() { # name cmd...
  local n="$1"; shift
  local rc=0
  echo "--- $n"
  if "$@" > "$RUNS/gate-$$-$n.log" 2>&1; then echo "ok: $n"; else
    rc=$?   # before any other command: `local` would reset $? to 0
    local envreason
    # A step the machine could not run is not a red test. ENOSPC in the step's own log is the
    # evidence (a df threshold is not: APFS counts purgeable space as free and cp still fails).
    # Report no verdict; merge.sh retries the cycle instead of sending the branch back.
    if envreason="$(gate_env_failure_in_log "$n" "$RUNS/gate-$$-$n.log")"; then
      echo "env: $n could not run ($envreason)"
      echo "GATE_RESULT=NO_VERDICT: $envreason"
      exit 3
    fi
    # A step harness that died by a signal never reached a summary, so "no line says FAIL" is
    # the only evidence it had: it did not judge the branch. 2026-11-23 #640: check.sh was
    # SIGTERM'd at 15m20s while two start() jobs were still running; the gate printed
    # `FAIL: check`, the branch was sent back for rework, and the rework found nothing to fix.
    # A red test exits 1 through the harness (its own `FAIL <job>` lines), never 128+N, so this
    # arm cannot excuse a real failure. Exit 3 = no verdict; merge.sh retries, no sendback.
    if [ "$rc" -ge 128 ]; then
      echo "env: $n was killed by signal $((rc - 128)) before it could judge"
      echo "GATE_RESULT=NO_VERDICT: $n killed by signal $((rc - 128)) before a verdict"
      exit 3
    fi
    echo "FAIL: $n (see $RUNS/gate-$$-$n.log)"
    # Keep the failing-test identifiers in the gate log itself. merge.sh classifies
    # out-of-footprint / known-flaky failures from THIS file (outside-tests.py), and the
    # per-step log is otherwise invisible to it: Vitest prints its "FAIL  src/… > name"
    # header far above the last 25 lines, so a flaky DOM test read as a quality failure.
    grep -aE '(FAIL|✗|×).*\.(test|spec)\.(tsx|ts|jsx|js)|^--- FAIL:|Failed Tests|Test Files|^FAIL[[:space:]]' "$RUNS/gate-$$-$n.log" 2>/dev/null | head -20
    tail -25 "$RUNS/gate-$$-$n.log"
    fail=1; why="$why $n"
  fi
}
# Changed-file Prettier, not a repo-wide check: 55 historical UI files fail
# `prettier --check`, so a grep over the whole tree would be permanently red
# and would hide the files this branch actually wrote. The committed range is
# `origin/main...HEAD`; uncommitted UI edits are included too, so reviewing a
# dirty tree still catches an unformatted file. `npx prettier` reads
# `ui/.prettierignore` through its own config discovery.
prettier_ui_changed() {
  local files=()
  local f list
  # A range we cannot resolve is a gate failure, not an empty change set: a
  # clone without the remote ref would otherwise print "nothing to check".
  if ! $GIT rev-parse --verify --quiet origin/main >/dev/null; then
    echo "origin/main is not available; cannot select the changed-file range"
    return 1
  fi
  # NUL-delimited git output keeps spaces in paths intact; newline is a safe
  # separator here because NULs become newlines before the read loop and a
  # newline in a UI filename is not a case this repository carries.
  #
  # The listing goes through a temporary file rather than `< <(...)` because a
  # process substitution reports success even when `git diff` fails, which
  # would turn a broken selection into "no changed UI files to format-check".
  list="$(mktemp "${TMPDIR:-/tmp}/gate-ui-paths.XXXXXX")" || {
    echo "cannot create a temporary file for the changed-file list"
    return 1
  }
  if ! {
    $GIT diff --name-only -z --diff-filter=ACMR origin/main...HEAD -- ui &&
      $GIT diff --name-only -z --diff-filter=ACMR HEAD -- ui &&
      $GIT ls-files --others --exclude-standard -z -- ui
  } >"$list"; then
    echo "cannot list changed UI files"
    rm -f "$list"
    return 1
  fi
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "ui/$f" ] && files+=("$f")
  done < <(tr '\0' '\n' <"$list" | sed 's|^ui/||' |
    grep -E '\.(ts|tsx|js|jsx|css|json|md)$' | sort -u)
  rm -f "$list"
  if [ ${#files[@]} -eq 0 ]; then
    echo "no changed UI files to format-check"
    return 0
  fi
  echo "checking ${#files[@]} changed UI file(s)"
  ( cd ui && npx prettier --check --ignore-unknown "${files[@]}" )
}

ui_vitest_gate() {
  local rel_out rel_rc rel_files=() f
  rel_out="$(python3 "$RSI_DIR/runtime/related-ui-tests.py" --worktree "$WT" 2>"$RUNS/gate-$$-related.err")"
  rel_rc=$?
  if [ $rel_rc -eq 0 ] && [ -n "$rel_out" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && rel_files+=("$f")
    done <<< "$rel_out"
  fi
  if [ ${#rel_files[@]} -gt 0 ]; then
    echo "leaf UI slice: running ${#rel_files[@]} related test file(s) incl. tokens.test.ts (full suite on GitHub CI; set RSI_GATE_VITEST=full for full local run)"
    printf '  %s\n' "${rel_files[@]}"
    ( cd ui && npx vitest run --maxWorkers="${VITEST_MAX_WORKERS:-2}" "${rel_files[@]}" )
  else
    echo "shared/full UI test run ($(tr '\n' ' ' < "$RUNS/gate-$$-related.err" 2>/dev/null || echo full))"
    ( cd ui && npm test -- --maxWorkers="${VITEST_MAX_WORKERS:-2}" )
  fi
}

mkdir -p "$RUNS"
# Before any step: can this machine write at all? Two 2026-11-22 sendbacks were a full disk
# reported as a failed PR. The probe (write, read back, delete; bounded) is the precondition —
# `df` is context only, because APFS reports free space it cannot hand out. No verdict, exit 3.
probe_dir="${TMPDIR:-}"; [ -n "$probe_dir" ] || probe_dir="$RUNS"
if ! gate_disk_probe "$probe_dir"; then
  echo "GATE_RESULT=NO_VERDICT: $GATE_PROBE_REASON"
  exit 3
fi
trap 'for kid in $(pgrep -P $$ 2>/dev/null || true); do rsi_kill_tree "$kid"; done' EXIT
export GOMAXPROCS="${GOMAXPROCS:-2}" GO_TEST_P="${GO_TEST_P:-2}" VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"
# Repair ui/node_modules before the first console compile, not after it. A bare directory-existence
# test was true for a symlink into another worktree and for an install older than its own lockfile,
# so the repair never ran and tsc/vitest/build failed on a tree that was not the PR's fault.
ui_node_stamp() { node_stamp_ensure ui; }
$GIT fetch -q origin main 2>/dev/null
changed="$($GIT diff --name-only origin/main...HEAD)"
echo "changed files: $(echo "$changed" | grep -c .)"
scope_list="$(mktemp "${TMPDIR:-/tmp}/gate-changed.XXXXXX")"
printf '%s\n' "$changed" >"$scope_list"
scope="$(scope_of "$scope_list")"
# docs scope hands the same list to check.sh as KIN_CHECK_CHANGED; the other scopes
# do not need it, so the temp file is only kept alive for that one branch.
[ "$scope" = docs ] || rm -f "$scope_list"
[ "$scope" != full ] && echo "scope: $scope-only ($(echo "$changed" | grep -c .) files)"
lines="$($GIT diff --shortstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json')"
echo "diff size: $lines"
echo "$changed" | grep -qE '^(web/dist/assets/|\.env|.*secret)' && { echo "FAIL: forbidden path in diff"; fail=1; why="$why forbidden-path"; }
[ -n "$($GIT status --porcelain)" ] && { echo "FAIL: working tree not clean (commit or discard)"; $GIT status --short | head; fail=1; why="$why dirty-tree"; }
echo "$changed" | grep -q '^ui/' && needs_node_stamp && step node-stamp ui_node_stamp
if [ -x scripts/check.sh ] && selected check; then
  case "$scope" in
    rn)
      step check env KIN_CHECK_SCOPE=rn ./scripts/check.sh ;;
    docs)
      step check env KIN_CHECK_SCOPE=docs "KIN_CHECK_CHANGED=$scope_list" ./scripts/check.sh
      rm -f "$scope_list" ;;
    *)
      step check ./scripts/check.sh ;;
  esac
fi
if echo "$changed" | grep -q '^ui/'; then
  selected lint && step lint bash -c 'cd ui && npm run lint'
  selected test && step test ui_vitest_gate
  if selected build; then
    if [ "${RSI_DIST_BUILT_SHA:-}" = "$($GIT rev-parse HEAD 2>/dev/null)" ] && [ -d web/dist/assets ]; then
      echo "--- build"
      echo "ok: build (verified at HEAD by merge lane; tsc --noEmit + vite build)"
    else
      step build bash -c 'cd ui && npm run build'
    fi
  fi
  if selected build; then
    [ -n "$($GIT status --porcelain -- . ':!web/dist/index.html')" ] && { echo "FAIL: build left uncommitted changes"; fail=1; why="$why dirty-after-build"; }
    $GIT diff --quiet -- web/dist/index.html || { echo "FAIL: web/dist/index.html stale — commit the rebuilt file"; fail=1; why="$why stale-dist"; }
  fi
fi
selected prettier && step prettier prettier_ui_changed
if selected ratchet; then
  echo "--- ratchet"; python3 "$RSI_DIR/runtime/ratchet.py" check "$WT" || { fail=1; why="$why ratchet"; }
fi
if [ "$ONLY_MODE" -eq 1 ]; then
  # A filtered run is bisect diagnosis only. PARTIAL can never be read as a full verdict;
  # the verifier's grep is for `^GATE_RESULT=PASS`, so this line is never carried.
  if [ $fail -eq 0 ]; then echo "GATE_RESULT=PARTIAL"; exit 0; else echo "GATE_RESULT=PARTIAL:$why"; exit 1; fi
fi
if [ $fail -eq 0 ]; then echo "GATE_RESULT=PASS"; exit 0; else echo "GATE_RESULT=FAIL:$why"; exit 1; fi
