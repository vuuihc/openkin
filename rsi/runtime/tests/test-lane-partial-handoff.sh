#!/bin/bash
# test-lane-partial-handoff.sh — a committed lane is never stranded by a missing hand-off body.
#
# A worker lane can finish its code, commit it and return before it writes
# state/lanes/<slug>.pr-body.md (a watchdog bite, an exhausted budget, a session that simply
# stopped after the last commit). Every body-dependent seam below the worker then reads a missing
# file, the first of them fails the lane, and the branch is never pushed: the run ends as
# `failed "" "claim check: ... no output"` while its worktree holds a clean, tested commit, and a
# person has to recover that commit by hand.
#
# rsi/runtime/lane-body.sh writes a clearly labelled partial body for exactly that case, so the
# merge lane — not the body seams — decides. A body the worker did write is never touched.
#
# Hermetic: mktemp dirs, no real git (a stub git is passed as the helper's fifth argument and
# refuses any invocation but the one the helper may make), no network. npm/npx/node/go/curl/gh
# and a bare `git` are booby-trapped on PATH, so a helper that reaches for one fails loudly.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
HELPER="$RUNTIME/lane-body.sh"
LANE="$RUNTIME/lane.sh"
CHECK="$REPO/scripts/check.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
STATE="$T/state"
WT="$T/worktree"
mkdir -p "$STATE/lanes" "$WT"
OUT=""; RC=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# --- booby traps -------------------------------------------------------------------------------
# The helper owns no tools but the git binary it is given. Anything else on PATH that could reach
# the network or a build is a trap; a bare `git` is one too, because the helper must use $5.
TRAP="$T/bin"; mkdir -p "$TRAP"
for tool in npm npx node go curl gh git; do
  printf '#!/bin/sh\necho "booby trap: %s must not run" >&2\nexit 99\n' "$tool" > "$TRAP/$tool"
  chmod +x "$TRAP/$tool"
done
export PATH="$TRAP:$PATH"

# stub_git — the only git the helper may call. It answers the one invocation the helper is allowed
# (`-C <wt> rev-list --count origin/main..HEAD`) with $STUB_AHEAD and refuses everything else.
STUB="$T/stub-git"
cat > "$STUB" <<'EOF'
#!/bin/sh
if [ "$#" -eq 5 ] && [ "$1" = "-C" ] && [ "$3" = "rev-list" ] && [ "$4" = "--count" ] \
   && [ "$5" = "origin/main..HEAD" ]; then
  printf '%s\n' "${STUB_AHEAD:-0}"
  exit 0
fi
echo "stub git: unexpected invocation: $*" >&2
exit 9
EOF
chmod +x "$STUB"

# reset_state — a fresh state dir per case, so one case's fallback cannot satisfy another.
reset_state() { rm -rf "$STATE"; mkdir -p "$STATE/lanes"; }
need_helper() { [ -f "$HELPER" ] || fail "helper missing: $HELPER"; source "$HELPER"; }

# --- cases -------------------------------------------------------------------------------------

# 1. The measured case: no body on disk, one commit over origin/main. The helper writes the
# fallback, prints its path and succeeds.
test_missing_body_with_a_commit_writes_a_partial_fallback() {
  reset_state; need_helper
  export STUB_AHEAD=1
  OUT="$(ensure_handoff_body "$STATE" 7 R-partial-item "$WT" "$STUB" demo-slug 2>"$T/err")"; RC=$?
  [ "$RC" -eq 0 ] || fail "expected rc 0, got $RC ($(cat "$T/err"))"
  [ "$OUT" = "$STATE/lanes/7.pr-body.fallback.md" ] \
    || fail "printed '$OUT', want the fallback path"
  [ -s "$OUT" ] || fail "the fallback file was not written"
  grep -qF 'Partial:' "$OUT" || fail "the fallback is not labelled partial"
}

# 2. A worker body is authoritative: same bytes, same path, no fallback beside it.
test_existing_body_is_never_rewritten() {
  reset_state; need_helper
  local body="$STATE/lanes/demo-slug.pr-body.md" before after
  printf 'KEEP\nME\n' > "$body"
  before="$(cksum < "$body")"
  export STUB_AHEAD=1
  OUT="$(ensure_handoff_body "$STATE" 8 R-partial-item "$WT" "$STUB" demo-slug 2>"$T/err")"; RC=$?
  [ "$RC" -eq 0 ] || fail "expected rc 0, got $RC ($(cat "$T/err"))"
  [ "$OUT" = "$body" ] || fail "printed '$OUT', want the worker body $body"
  after="$(cksum < "$body")"
  [ "$before" = "$after" ] || fail "the worker body was modified"
  [ ! -e "$STATE/lanes/8.pr-body.fallback.md" ] || fail "a fallback was written beside a worker body"
}

# 3. Nothing to hand off: no body and no commit writes nothing and fails.
test_no_commit_writes_no_fallback() {
  reset_state; need_helper
  export STUB_AHEAD=0
  OUT="$(ensure_handoff_body "$STATE" 9 R-partial-item "$WT" "$STUB" demo-slug 2>"$T/err")"; RC=$?
  [ "$RC" -ne 0 ] || fail "a lane with no commit reported success"
  [ -z "$OUT" ] || fail "a lane with no commit printed: $OUT"
  [ ! -e "$STATE/lanes/9.pr-body.fallback.md" ] || fail "a fallback was written with no commit"
}

# 4. The fallback body must say what is missing, where the evidence is, and carry the six
# sections the merge gate reads. This is the operator's only explanation of a partial hand-off.
test_partial_body_names_the_missing_hand_off_evidence() {
  reset_state; need_helper
  local fb="$STATE/lanes/10.pr-body.fallback.md" h
  export STUB_AHEAD=1
  ensure_handoff_body "$STATE" 10 R-partial-item "$WT" "$STUB" demo-slug >/dev/null 2>&1 \
    || fail "the helper did not write the fallback"
  [ -s "$fb" ] || fail "the fallback file is missing"
  grep -qF 'Partial:' "$fb" || fail "the fallback has no Partial: label"
  grep -qF 'state/lanes/10.worker.txt' "$fb" || fail "the fallback does not point at the worker log"
  grep -qF 'RSI item: R-partial-item' "$fb" || fail "the fallback does not name the RSI item"
  for h in Symptom Change Verification Claims Screenshots Risk; do
    grep -qE "^## ${h}$" "$fb" || fail "the fallback has no '## $h' section"
  done
}

# 5. Wiring: lane.sh calls the helper after AHEAD is known and before the first body seam
# (--claim-check-check), on an executable line. A helper nothing calls is not a fix.
test_lane_writes_the_fallback_before_the_body_dependent_seams() {
  [ -f "$LANE" ] || fail "wiring: $LANE missing"
  local call ahead claim swap flag
  call="$(grep -nF 'ensure_handoff_body' "$LANE" | grep -vE '^[0-9]+:[[:space:]]*#' \
    | head -1 | cut -d: -f1)"
  [ -n "$call" ] || fail "wiring: lane.sh never calls ensure_handoff_body"
  ahead="$(grep -nE '^AHEAD=' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$ahead" ] || fail "wiring: lane.sh has no AHEAD= line"
  claim="$(grep -nF 'bash "$SELF" --claim-check-check' "$LANE" \
    | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1)"
  [ -n "$claim" ] || fail "wiring: lane.sh never invokes --claim-check-check"
  [ "$call" -gt "$ahead" ] || fail "wiring: the helper call (line $call) precedes AHEAD (line $ahead)"
  [ "$call" -lt "$claim" ] \
    || fail "wiring: the helper call (line $call) runs after the first claim seam (line $claim)"
  # Writing the fallback is not the fix: the lane must swap the body it reads, or the helper runs
  # and is ignored and the seams still read the missing worker body.
  swap="$(grep -nF 'STATUS_NOTE_FILE="$HANDOFF_BODY"' "$LANE" \
    | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1)"
  [ -n "$swap" ] || fail "wiring: lane.sh never swaps STATUS_NOTE_FILE to the fallback body"
  [ "$swap" -gt "$ahead" ] \
    || fail "wiring: the STATUS_NOTE_FILE swap (line $swap) precedes AHEAD (line $ahead)"
  [ "$swap" -lt "$claim" ] \
    || fail "wiring: the STATUS_NOTE_FILE swap (line $swap) runs after the first claim seam (line $claim)"
  flag="$(grep -nE '^[[:space:]]*PARTIAL_HANDOFF=1[[:space:]]*$' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$flag" ] || fail "wiring: lane.sh never sets PARTIAL_HANDOFF=1"
  [ "$flag" -gt "$ahead" ] || fail "wiring: PARTIAL_HANDOFF=1 (line $flag) precedes AHEAD (line $ahead)"
  [ "$flag" -lt "$claim" ] \
    || fail "wiring: PARTIAL_HANDOFF=1 (line $flag) runs after the first claim seam (line $claim)"
}

# 6. The suite must run in the gate (AGENTS.md rule 12): scripts/check.sh's job_shell_test()
# names it on an executable line.
test_suite_is_wired_into_check_sh() {
  [ -f "$CHECK" ] || fail "wiring: $CHECK missing"
  local body
  body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' "$CHECK")"
  [ -n "$body" ] || fail "wiring: check.sh has no job_shell_test()"
  body="$(sed -E 's/(^|[[:space:]])#.*$//' <<<"$body")"
  grep -qE '(^|[[:space:]])bash[[:space:]]+rsi/runtime/tests/test-lane-partial-handoff\.sh([[:space:]]|$)' \
    <<<"$body" || fail "wiring: job_shell_test() does not run this suite"
}

# 7. The fallback must clear the first body-dependent seam it meets, not merely exist: a lane whose
# commit touches a prose-assertion path runs claim_check.py against the body, and a body with no
# column-0 `Claim check:` line fails there ("no 'Claim check:' line"), so the fallback would strand
# the very commit it was written to save. The waiver is the body's own proof of that seam.
test_partial_body_waives_the_claim_seam() {
  reset_state; need_helper
  local fb="$STATE/lanes/12.pr-body.fallback.md" changed="$T/changed.txt" out
  export STUB_AHEAD=1
  ensure_handoff_body "$STATE" 12 R-partial-item "$WT" "$STUB" demo-slug >/dev/null 2>&1 \
    || fail "the helper did not write the fallback"
  printf '%s\n' 'docs/product/IA.md' > "$changed"
  out="$(python3 "$RUNTIME/claim_check.py" "$WT" "$fb" "$changed" 2>&1)" \
    || fail "claim_check.py rejected the partial body: $out"
  grep -q '^CLAIM_WAIVED' <<<"$out" \
    || fail "the partial body did not waive the claim seam: $out"
}

# --- runner ------------------------------------------------------------------------------------
RAN=0; PASSED=0
run() {
  local name="$1" short="${1#test_}"; short="${short//_/-}"
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || [ "$ONLY" = "$short" ] || return 0
  RAN=$((RAN + 1))
  "$name" || exit 1
  PASSED=$((PASSED + 1))
  pass "$name"
}

run test_missing_body_with_a_commit_writes_a_partial_fallback
run test_existing_body_is_never_rewritten
run test_no_commit_writes_no_fallback
run test_partial_body_names_the_missing_hand_off_evidence
run test_lane_writes_the_fallback_before_the_body_dependent_seams
run test_suite_is_wired_into_check_sh
run test_partial_body_waives_the_claim_seam
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo "lane partial handoff: $PASSED/$RAN cases passed"
