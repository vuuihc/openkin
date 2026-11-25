#!/bin/bash
# test-check-rn-scope.sh — the RN-only merge-gate scope starts just the jobs that can judge it.
#
# 2026-11-24 measurement: .gate.lock was held 21.5 h across 100 gate runs and 11.2 h of it
# was RN/docs PRs; an RN-only PR still paid 10–11 min because gate.sh's check step started
# every job in check.sh unconditionally. gate.sh now classifies the changed-file list —
# `rn` when it is non-empty and every path is mobile-rn/... or docs/adr/0036-* — and runs
# check.sh with KIN_CHECK_SCOPE=rn, which starts only the mobile-rn and stories jobs.
# This suite pins the seam from both sides:
#
#   * KIN_CHECK_SCOPE=rn --list is exactly `stories` then `mobile-rn`, in start order;
#   * an unset scope leaves the default list untouched (15 jobs incl. shell-test);
#   * scope=rn with --all still lists the full 23-job set;
#   * any other scope value exits 2;
#   * gate.sh --scope-of prints rn only for non-empty all-mobile-rn(/0036-adr) lists.
#
# RSI_CHECK_SH points the check.sh cases at another script, RSI_GATE_SH the gate.sh ones
# (the red-first lane uses both against origin/main copies). Hermetic: temp files, no
# network, and check.sh only ever runs with --list — the grep guard refuses an older
# check.sh that would ignore the scope and start a full gate. Prints "PASS <case>" per
# case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CHECK="${RSI_CHECK_SH:-$REPO/scripts/check.sh}"
GATE="${RSI_GATE_SH:-$REPO/rsi/runtime/gate.sh}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

# scoped_list <scope> [args...] — `KIN_CHECK_SCOPE=<scope> check.sh [args] --list`, after
# proving the script has both seams (an unaware copy would ignore them and start jobs).
scoped_list() {
  local scope="$1"; shift
  grep -q 'KIN_CHECK_SCOPE' "$CHECK" \
    || fail "scoped-list: $CHECK has no KIN_CHECK_SCOPE handling; refusing to run it"
  grep -qE '^[[:space:]]*--list\)' "$CHECK" \
    || fail "scoped-list: $CHECK has no --list mode; refusing to start a full gate"
  KIN_CHECK_SCOPE="$scope" bash "$CHECK" "$@" --list
}

# --- rn --list is exactly the two jobs an RN-only diff can be judged by, in start order ------
out="$(scoped_list rn)" || fail "rn-list: --list exited nonzero: $out"
[ "$out" = $'stories\nmobile-rn' ] \
  || fail "rn-list: expected 'stories' then 'mobile-rn', got: $out"
echo "PASS rn-list"

# --- unset scope leaves the default list untouched -------------------------------------------
grep -qE '^[[:space:]]*--list\)' "$CHECK" \
  || fail "default-list: $CHECK has no --list mode; refusing to start a full gate"
out="$(env -u KIN_CHECK_SCOPE bash "$CHECK" --list)" || fail "default-list: exited nonzero: $out"
[ "$(grep -c . <<<"$out")" -eq 15 ] || fail "default-list: expected 15 jobs, got: $out"
for j in shell-test mobile-rn stories; do
  grep -qx "$j" <<<"$out" || fail "default-list: $j missing from: $out"
done
echo "PASS default-list"

# --- --all always wins: scope=rn --all is the full 23-job set --------------------------------
out="$(scoped_list rn --all)" || fail "rn-all-list: --all --list exited nonzero: $out"
[ "$(grep -c . <<<"$out")" -eq 23 ] || fail "rn-all-list: expected 23 jobs, got: $out"
grep -qx vet <<<"$out" || fail "rn-all-list: vet missing from: $out"
echo "PASS rn-all-list"

# --- any other scope value is a caller bug: exit 2 -------------------------------------------
out="$(KIN_CHECK_SCOPE=bogus bash "$CHECK" --list 2>&1)"; rc=$?
[ "$rc" -eq 2 ] || fail "bogus-scope: expected exit 2, got $rc: $out"
echo "PASS bogus-scope"

# --- gate.sh --scope-of: rn only for non-empty mobile-rn(/0036-adr) lists --------------------
grep -q -- '--scope-of' "$GATE" || fail "scope-of: $GATE has no --scope-of seam"
scope_of() { # <paths...> — one per line through a temp file, print the gate's scope
  local f="$T/paths.$((i += 1))"
  printf '%s\n' "$@" >"$f"
  bash "$GATE" --scope-of "$f"
}
i=0
[ "$(scope_of mobile-rn/src/App.tsx)" = rn ] \
  || fail "scope-of: mobile-rn-only list is not rn"
[ "$(scope_of mobile-rn/src/App.tsx docs/adr/0036-rn-gate.md)" = rn ] \
  || fail "scope-of: mobile-rn + docs/adr/0036-* is not rn"
[ "$(scope_of mobile-rn/src/App.tsx ui/src/x.ts)" = full ] \
  || fail "scope-of: mobile-rn + ui/ should be full"
[ "$(scope_of mobile-rn/src/App.tsx rsi/runtime/x.sh)" = full ] \
  || fail "scope-of: mobile-rn + rsi/ should be full"
# A non-0036 ADR alone is markdown-only outside mobile-rn/, so since the docs scope
# landed it is `docs`, not `full` — the rn assertion is that it is not `rn`.
[ "$(scope_of docs/adr/0035-x.md)" = docs ] \
  || fail "scope-of: a non-0036 ADR alone should be docs (rn loses precedence but is not full)"
: >"$T/empty"
[ "$(bash "$GATE" --scope-of "$T/empty")" = full ] \
  || fail "scope-of: an empty list should be full"
echo "PASS scope-of"
