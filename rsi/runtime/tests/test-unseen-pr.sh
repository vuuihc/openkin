#!/bin/bash
# test-unseen-pr.sh — the merge dispatcher must name an open rsi/* PR it never selected.
#
# The dispatcher selects rows with one predicate and prints only about that set, so a wrong
# predicate does not skip one PR — the tick says "no open rsi PRs", which is false, and nothing
# names the stranded PR. Observed twice in three days: #392 (rsi/ceo-ok-marker) and #535
# (rsi/dream-phone-line), both green / MERGEABLE / CI 4/4, zero cycles.log entries for 2.5 hours
# until a person noticed and renamed a head.
#
# rsi/runtime/unseen-pr.py re-derives the selection with a deliberately COARSER rule than
# pr_select.is_candidate(): it must be independent of the selector, or a wrong selector makes the
# check tautological. Every dispatcher tick feeds it the gh `pr list` JSON it already fetched and
# the TSV rows it already built, and says each open PR the coarse rule accepts but the selected
# rows do not contain. The call sits BEFORE the empty-set early exit, because with an empty
# selected set the alarm is the only output there is.
#
# Hermetic: mktemp dirs, fixture files, no network, no gh, no writes outside the temp dir.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per mutant).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"                 # the rsi/ dir
TOOL="$RSI/runtime/unseen-pr.py"
MERGE="$RSI/runtime/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""
mkdir -p "$T/state/merge"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# run_tool <fixture|-> <rows> <state> — run unseen-pr.py over a gh `pr list` array on stdin.
# Sets RC and OUT (stdout only). "-" means empty stdin.
run_tool() {
  local in="$1" rows="$2" state="$3"
  if [ "$in" = "-" ]; then
    OUT="$(printf '' | python3 "$TOOL" --rows "$rows" --state "$state" 2>"$T/err")"; RC=$?
  else
    OUT="$(python3 "$TOOL" --rows "$rows" --state "$state" < "$in" 2>"$T/err")"; RC=$?
  fi
}

# --- fixtures ----------------------------------------------------------------------------------

# The stranded shape: a CEO-named head, open, not a draft, no labels. #101 is selected normally.
cat > "$T/unseen.json" <<'EOF'
[{"number":101,"headRefName":"rsi/other","isDraft":false,"labels":[]},
 {"number":392,"headRefName":"rsi/ceo-ok-marker","isDraft":false,"labels":[]}]
EOF
ROWS_101="$(printf '101\tother\tSome selected work\tsmall\t')"

# Every exclusion the coarse rule still honours, plus a foreign head: all silent.
cat > "$T/silent.json" <<'EOF'
[{"number":500,"headRefName":"rsi/draft","isDraft":true,"labels":[]},
 {"number":501,"headRefName":"rsi/held","isDraft":false,"labels":[{"name":"needs-ceo"}]},
 {"number":502,"headRefName":"feature/x","isDraft":false,"labels":[]},
 {"number":503,"headRefName":"rsi/ceo-loop","isDraft":false,"labels":[]},
 {"number":504,"headRefName":"rsi/held-too","isDraft":false,"labels":[{"name":"hold"}]}]
EOF

# A selected PR is not unseen.
cat > "$T/selected.json" <<'EOF'
[{"number":600,"headRefName":"rsi/x","isDraft":false,"labels":[]}]
EOF
ROWS_600="$(printf '600\tx\tA selected PR\tlarge\tsome-label')"

# Dedupe: the same PR, then the same PR with a renamed head.
cat > "$T/dedupe-a.json" <<'EOF'
[{"number":392,"headRefName":"rsi/ceo-ok-marker","isDraft":false,"labels":[]}]
EOF
cat > "$T/dedupe-b.json" <<'EOF'
[{"number":392,"headRefName":"rsi/ceo-ok-marker-2","isDraft":false,"labels":[]}]
EOF

# --- cases -------------------------------------------------------------------------------------

# The motivating case: one open PR the selected rows do not contain is named, alone, exit 0.
unseen_flagged() {
  run_tool "$T/unseen.json" "$ROWS_101" "$T/state"
  [ "$RC" -eq 0 ] || fail "unseen-flagged: exit $RC ($OUT)"
  [ "$OUT" = "unseen-pr #392 rsi/ceo-ok-marker" ] \
    || fail "unseen-flagged: want exactly 'unseen-pr #392 rsi/ceo-ok-marker', got: $OUT"
}

# Draft, needs-ceo, hold, a foreign head and the control branch are never reported.
draft_hold_and_foreign_silent() {
  rm -rf "$T/silent-state"; mkdir -p "$T/silent-state/merge"
  run_tool "$T/silent.json" "" "$T/silent-state"
  [ "$RC" -eq 0 ] || fail "draft-hold-and-foreign-silent: exit $RC ($OUT)"
  [ -z "$OUT" ] || fail "draft-hold-and-foreign-silent: want no output, got: $OUT"
  [ ! -e "$T/silent-state/merge/unseen-pr.log" ] \
    || fail "draft-hold-and-foreign-silent: nothing reported but a log line was written"
}

# A PR whose number is in the dispatcher's rows is selected, so it is not unseen.
selected_is_silent() {
  rm -rf "$T/sel-state"; mkdir -p "$T/sel-state/merge"
  run_tool "$T/selected.json" "$ROWS_600" "$T/sel-state"
  [ "$RC" -eq 0 ] || fail "selected-is-silent: exit $RC ($OUT)"
  [ -z "$OUT" ] || fail "selected-is-silent: want no output, got: $OUT"
}

# One log line per (number, head): a repeat run is quiet in the log but still on stdout; a
# renamed head is a new durable line and the new head on stdout.
dedupe_and_renamed_head() {
  local log="$T/dedupe-state/merge/unseen-pr.log" lines
  rm -rf "$T/dedupe-state"; mkdir -p "$T/dedupe-state/merge"
  run_tool "$T/dedupe-a.json" "$ROWS_101" "$T/dedupe-state"
  [ "$OUT" = "unseen-pr #392 rsi/ceo-ok-marker" ] || fail "dedupe-and-renamed-head: first run: $OUT"
  run_tool "$T/dedupe-a.json" "$ROWS_101" "$T/dedupe-state"
  [ "$OUT" = "unseen-pr #392 rsi/ceo-ok-marker" ] \
    || fail "dedupe-and-renamed-head: a repeat run must still print the live fact, got: $OUT"
  lines="$(grep -c . "$log" 2>/dev/null || true)"
  [ "$lines" -eq 1 ] || fail "dedupe-and-renamed-head: want 1 log line after the repeat, got $lines"
  run_tool "$T/dedupe-b.json" "$ROWS_101" "$T/dedupe-state"
  [ "$OUT" = "unseen-pr #392 rsi/ceo-ok-marker-2" ] \
    || fail "dedupe-and-renamed-head: renamed head must print, got: $OUT"
  lines="$(grep -c . "$log" 2>/dev/null || true)"
  [ "$lines" -eq 2 ] || fail "dedupe-and-renamed-head: want 2 log lines after the rename, got $lines"
}

# Fail closed: malformed input never speaks and never writes. This tool must never stop a tick.
garbage_is_silent() {
  local g="$T/garbage-state"
  rm -rf "$g"; mkdir -p "$g/merge"
  printf '' > "$T/empty.json"
  printf 'not json\n' > "$T/notjson.json"
  printf '{"number":1}\n' > "$T/object.json"
  local f
  for f in "$T/empty.json" "$T/notjson.json" "$T/object.json"; do
    run_tool "$f" "$ROWS_101" "$g"
    [ "$RC" -eq 0 ] || fail "garbage-is-silent: $(basename "$f") exited $RC"
    [ -z "$OUT" ] || fail "garbage-is-silent: $(basename "$f") printed: $OUT"
  done
  [ ! -e "$g/merge/unseen-pr.log" ] || fail "garbage-is-silent: a log line was written"
}

# The alarm must run before the empty-set exit: with no selected rows it is the only output.
wiring_order() {
  local dispatch call exitline calltext
  dispatch="$(grep -n 'PRS="$(printf' "$MERGE" | head -1 | cut -d: -f1)"
  call="$(grep -n 'unseen-pr\.py' "$MERGE" | head -1 | cut -d: -f1)"
  exitline="$(grep -n 'no open rsi PRs' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$dispatch" ] || fail "wiring-order: no dispatcher PRS= line in merge.sh"
  [ -n "$call" ] || fail "wiring-order: merge.sh never calls unseen-pr.py"
  [ -n "$exitline" ] || fail "wiring-order: no 'no open rsi PRs' early exit in merge.sh"
  [ "$call" -gt "$dispatch" ] || fail "wiring-order: the alarm precedes the row build"
  [ "$call" -lt "$exitline" ] \
    || fail "wiring-order: the alarm sits after the empty-set exit, where it cannot fire"
  calltext="$(sed -n "${call}p" "$MERGE")"
  case "$calltext" in
    *"|| true"*) ;;
    *) fail "wiring-order: the call can fail the tick (no '|| true'): $calltext" ;;
  esac
}

run() { # <case name> <function>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$2" || exit 1
  pass "$1"
}

run unseen-flagged unseen_flagged
run draft-hold-and-foreign-silent draft_hold_and_foreign_silent
run selected-is-silent selected_is_silent
run dedupe-and-renamed-head dedupe_and_renamed_head
run garbage-is-silent garbage_is_silent
run wiring-order wiring_order
echo ALL-PASS
