#!/bin/bash
# test-sendback-provenance.sh — every sendback says who caught it and how to reproduce it.
#
# Retro 2026-11-18 §5.2: 18 archived sendbacks, and the retro could not tell which were real
# defects and which were harness false reds without opening each one and rebuilding the scene.
# Two of them (#251's walker/spec mismatch, the --no-build assets mismatch) were harness bugs
# that cost ~2 walks and 2 vision reviews each. write_sendback() now prints `source:`, `spec:`
# and `cmd:` directly after `kind:`, so the retro counts false reds by source in seconds and a
# rework lane can reproduce a bounce without guessing which script wrote it.
#
# Hermetic: temp RSI_CTRL (STATE redirected into it), one throwaway local git repo for spec_rev,
# no network, no locks, no gh. Drives merge.sh --sendback-check / --spec-rev / --stale-check,
# the early seams that run before PAUSE, locks, fetch, gate, review and dispatch.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
# MERGE=<path> points every case at another merge.sh (the red proof against origin/main).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="${MERGE:-$(cd "$HERE/.." && pwd)/merge.sh}"
GIT="${GIT:-/usr/bin/git}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="sendback-prov"
ITEM="R-sendback-provenance"
CASE=""; RC=0; DET=""
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
st() { echo "$RSI_CTRL/rsi/state"; }
sf() { echo "$(st)/sendback/$SLUG.md"; }
line_of() { grep -n -x -F -- "$1" "$(sf)" 2>/dev/null | head -1 | cut -d: -f1; }

# new_case <name> — fresh control tree and detail file. PAUSE is left set on purpose: if a seam
# ever moved behind the PAUSE check the cases go red (and a dispatcher run could reach the real gh).
new_case() {
  CASE="$1"
  RSI_CTRL="$T/ctrl-$CASE"
  rm -rf "$RSI_CTRL"
  mkdir -p "$RSI_CTRL/rsi/state/merge" "$RSI_CTRL/rsi/runtime"
  touch "$RSI_CTRL/rsi/state/PAUSE"
  DET="$T/$CASE.detail.txt"
  printf 'raw failure report for %s\n' "$CASE" > "$DET"
}

# run_sb <title> <attempt> <kind> [source] [spec] [cmd] — call merge.sh --sendback-check the
# way the land loop calls write_sendback(); absent trailing args exercise the defaults.
run_sb() {
  local title="$1" a="$2" kind="$3"; shift 3
  RSI_CTRL="$RSI_CTRL" bash "$MERGE" --sendback-check "$SLUG" "$ITEM" "$title" "$DET" "$a" "$kind" "$@" \
    > "$T/$CASE.out" 2>&1
  RC=$?
}

# header_check <case> <kind> <source> <spec> <cmd> — the three provenance lines sit directly
# after `kind:` and above the title line: the retro reads this block positionally.
header_check() {
  local c="$1" kind="$2" src="$3" spec="$4" cmd="$5" k s p x t
  [ -s "$(sf)" ] || fail "$c: no sendback written (expected \"source: $src\")"
  k="$(line_of "kind: $kind")"; s="$(line_of "source: $src")"
  p="$(line_of "spec: $spec")"; x="$(line_of "cmd: $cmd")"
  t="$(grep -n -F -- '# Sent back by the merge lane:' "$(sf)" | head -1 | cut -d: -f1)"
  [ -n "$k" ] || fail "$c: no 'kind: $kind' line"
  [ -n "$s" ] || fail "$c: no 'source: $src' line (expected \"source: $src\" right after kind:)"
  [ -n "$p" ] || fail "$c: no 'spec: $spec' line (expected \"spec: $spec\")"
  [ -n "$x" ] || fail "$c: no 'cmd: $cmd' line (expected \"cmd: $cmd\")"
  [ -n "$t" ] || fail "$c: no title line"
  [ "$s" = "$((k+1))" ] || fail "$c: source is line $s, want $((k+1)) directly after kind:"
  [ "$p" = "$((k+2))" ] || fail "$c: spec is line $p, want $((k+2))"
  [ "$x" = "$((k+3))" ] || fail "$c: cmd is line $x, want $((k+3))"
  [ "$x" -lt "$t" ] || fail "$c: provenance must stay above the title line"
}

# --- cases -------------------------------------------------------------------------------------

# Every argument is optional and the defaults are explicit words, never blank: a retro can then
# count by source even for a site that forgot to pass one.
test_defaults_are_explicit() {
  new_case defaults
  run_sb "gate failed" 1 targeted
  [ "$RC" -eq 0 ] || fail "defaults: seam exited $RC ($(tr '\n' ' ' < "$T/$CASE.out"))"
  header_check defaults targeted unknown - -
}

# A site that knows its provenance records it verbatim, header block included.
test_explicit_provenance_recorded() {
  new_case explicit
  run_sb "UX gate failed (clarity=2 mean=2.8)" 2 targeted \
    ux-gate abcdef123456 \
    "bash /ctrl/rsi/runtime/ux-gate.sh /wt sendback-prov R-sendback-provenance 242 deadbeef1234 reviewer"
  [ "$RC" -eq 0 ] || fail "explicit: seam exited $RC ($(tr '\n' ' ' < "$T/$CASE.out"))"
  header_check explicit targeted ux-gate abcdef123456 \
    "bash /ctrl/rsi/runtime/ux-gate.sh /wt sendback-prov R-sendback-provenance 242 deadbeef1234 reviewer"
}

# The #251 false red differed in the journey spec, so the sendback must name the blob revision
# the UX gate actually walked: the same value rev-parse gives for HEAD:rsi/runtime/ux/journeys.json.
test_spec_rev_reads_the_journeys_blob() {
  new_case spec_rev
  local repo="$T/spec-repo" want got
  mkdir -p "$repo/rsi/runtime/ux"
  "$GIT" -C "$repo" init -q
  printf '{"journeys":[]}\n' > "$repo/rsi/runtime/ux/journeys.json"
  "$GIT" -C "$repo" add -A
  "$GIT" -C "$repo" -c user.email=owner@example.com -c user.name=provenance -c commit.gpgsign=false commit -qm seed
  want="$("$GIT" -C "$repo" rev-parse --short=12 HEAD:rsi/runtime/ux/journeys.json)"
  got="$(RSI_CTRL="$RSI_CTRL" bash "$MERGE" --spec-rev "$repo" 2>&1)"; RC=$?
  [ "$RC" -eq 0 ] || fail "spec-rev: seam exited $RC ($got)"
  [ "$got" = "$want" ] || fail "spec-rev: printed '$got', want '$want'"
}

# No journeys.json (or no repo at all) is "-" and exit 0, never a crash or a partial hash: a
# rework lane must be able to read the header even when the scene cannot be resolved.
test_spec_rev_missing_file_is_dash() {
  new_case spec_rev_missing
  local repo="$T/empty-repo" plain="$T/plain-dir" got
  mkdir -p "$repo" "$plain"
  "$GIT" -C "$repo" init -q
  printf 'no spec here\n' > "$repo/README"
  "$GIT" -C "$repo" add -A
  "$GIT" -C "$repo" -c user.email=owner@example.com -c user.name=provenance -c commit.gpgsign=false commit -qm seed
  got="$(RSI_CTRL="$RSI_CTRL" bash "$MERGE" --spec-rev "$repo" 2>&1)"; RC=$?
  [ "$RC" -eq 0 ] || fail "spec-rev-missing: repo exited $RC ($got)"
  [ "$got" = "-" ] || fail "spec-rev-missing: repo printed '$got', want -"
  got="$(RSI_CTRL="$RSI_CTRL" bash "$MERGE" --spec-rev "$plain" 2>&1)"; RC=$?
  [ "$RC" -eq 0 ] || fail "spec-rev-missing: plain dir exited $RC ($got)"
  [ "$got" = "-" ] || fail "spec-rev-missing: plain dir printed '$got', want -"
}

# every_site_guard — every land-loop sendback invocation names a source.
# A land-loop invocation is `sendback`/`sendback_mech` naming "$SLUG" at the start of a line or
# after `;`, `&&`, `||` or `then`; function definitions, the positional seam calls and the
# `say "sendback ..."` log line are not. Each such invocation must carry one of the known source
# literals, or forward "$src" (the mechanical escalation path). So a NEW land-loop site that
# forgets provenance turns this red, not only the six sites pinned today. Comments are stripped
# first: a token in a comment cannot false-green.
every_site_guard() {
  awk '
    {
      line = $0
      sub(/#.*/, "", line)
      hit = (line ~ /^[[:space:]]*(sendback|sendback_mech)[[:space:]]/ ||
             line ~ /(;|&&|\|\||then)[[:space:]]*(sendback|sendback_mech)[[:space:]]/) &&
            line ~ /"\$SLUG"/
      if (!hit) next
      n++
      if (line ~ /"ux-gate"|"ci"|"gate\+review"|"hold-size"|"hold-screenshots"|"test"|"mech"|"\$src"/) { ok++; next }
      bad = bad sprintf("  line %d: %s\n", FNR, $0)
    }
    END {
      if (n == 0) { print "no sendback call sites found"; exit 2 }
      if (ok != n) { printf "%s", bad; exit 1 }
    }' "$MERGE"
}

# An unset source silently becomes "unknown": countable, but wrong. Every land-loop site must
# name its source, and the six known tokens must stay present so a site cannot be deleted.
test_every_sendback_site_names_its_source() {
  local tok
  [ -f "$MERGE" ] || fail "every-site: missing $MERGE"
  every_site_guard || fail "every-site: a sendback call names no source (see lines above); an unset source becomes 'unknown'"
  for tok in ux-gate ci gate+review hold-size hold-screenshots; do
    grep -qF -- "\"$tok\"" "$MERGE" \
      || fail "every-site: no sendback call carries source '$tok' (an unset source becomes 'unknown')"
  done
  awk '/sendback_mech / && /merge conflict/' "$MERGE" | grep -q . \
    || fail "every-site: the merge-conflict mechanical sendback is gone or lost its source"
  # Its repro is the merge command the lane ran: an empty cmd is the regression this item fixes.
  awk '/sendback_mech / && /merge conflict/ && /merge -q --no-edit origin\/main/' "$MERGE" | grep -q . \
    || fail "every-site: the merge-conflict sendback no longer records the merge command"
  # The one site where the spec matters: the UX gate must record the revision it walked.
  awk '/sendback / && /ux-gate/ && /spec_rev/' "$MERGE" | grep -q . \
    || fail "every-site: the UX gate sendback does not record spec_rev (the #251 false red)"
}

# The mechanical/merge-conflict path has its own sendback_mech() function: prove it forwards
# provenance into write_sendback end to end, and that its default source is the word `mech`.
test_mech_sendback_forwards_provenance() {
  new_case mech
  RSI_CTRL="$RSI_CTRL" bash "$MERGE" --mech-check "$SLUG" "$ITEM" "merge conflict with main" "$DET" \
    "mech" - "git -C /wt merge -q --no-edit origin/main" > "$T/$CASE.out" 2>&1
  RC=$?
  [ "$RC" -eq 0 ] || fail "mech: seam exited $RC ($(tr '\n' ' ' < "$T/$CASE.out"))"
  header_check mech mechanical mech - "git -C /wt merge -q --no-edit origin/main"
  grep -q 'MECHANICAL fix' "$(sf)" || fail "mech: the mechanical note is gone"
  new_case mech_defaults
  RSI_CTRL="$RSI_CTRL" bash "$MERGE" --mech-check "$SLUG" "$ITEM" "merge conflict with main" "$DET" \
    > "$T/$CASE.out" 2>&1
  RC=$?
  [ "$RC" -eq 0 ] || fail "mech-defaults: seam exited $RC ($(tr '\n' ' ' < "$T/$CASE.out"))"
  header_check mech_defaults mechanical mech - -
}

# The ordinary stale seam is unchanged behaviour, and this also proves sendback() forwards the
# provenance it was given rather than only write_sendback() accepting it.
test_stale_seam_still_writes_a_real_sendback() {
  new_case stale_seam
  cat > "$T/head-stub.sh" <<'SH'
#!/bin/bash
printf '%s\n' "${STUB_HEAD_OUT:-}"
SH
  RSI_CTRL="$RSI_CTRL" RSI_PR_HEAD_CMD="bash $T/head-stub.sh" STUB_HEAD_OUT=aaaa1111 \
    bash "$MERGE" --stale-check "$SLUG" "$ITEM" 242 aaaa1111 "$DET" > "$T/$CASE.out" 2>&1
  RC=$?
  [ "$RC" -eq 0 ] || fail "stale-seam: exited $RC ($(tr '\n' ' ' < "$T/$CASE.out"))"
  [ -s "$(sf)" ] || fail "stale-seam: no sendback for a reviewed head (expected \"source: test\")"
  [ "$(cat "$(st)/merge/$SLUG.attempts" 2>/dev/null)" = 1 ] \
    || fail "stale-seam: attempts is $(cat "$(st)/merge/$SLUG.attempts" 2>/dev/null), want 1"
  header_check stale_seam targeted test - "bash rsi/runtime/tests/test-loop-sendback-stale.sh"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$1" || exit 1
  pass "$1"
}

RAN=0
run test_defaults_are_explicit
run test_explicit_provenance_recorded
run test_spec_rev_reads_the_journeys_blob
run test_spec_rev_missing_file_is_dash
run test_every_sendback_site_names_its_source
run test_mech_sendback_forwards_provenance
run test_stale_seam_still_writes_a_real_sendback
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
