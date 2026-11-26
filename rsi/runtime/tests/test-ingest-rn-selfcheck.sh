#!/bin/bash
# test-ingest-rn-selfcheck.sh — R-producer-checks part A: the Mac self-check must typecheck and
# test mobile-rn whenever the job's changed paths can reach it (#778 merged with an RN tsc
# failure the ui-only self-check could not see; only GitHub CI's mobile-rn job caught it).
# The `== mobile-rn` section is required exactly when mobile-rn/** or ui/src/** (which mobile-rn
# imports) changed; a missing or failed section is RED through the same failure path a tsc
# failure takes — never silently green.
#
# Hermetic: the real selfcheck_mac() text extracted from ingest-nas.sh, run against mktemp
# repos with heavy.sh/prep/npx all stubbed through the NAS_SELFCHECK_* seams. No ssh, no npm.
# Prints "PASS <case>" per case. Set RSI_TEST_ONLY=<case> for one.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
INGEST="$(cd "$HERE/../nas" && pwd)/ingest-nas.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
GIT=/usr/bin/git
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
run() { if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi; "$1" || exit 1; pass "$1"; }

extract() {
  sed -n '/^selfcheck_mac()/,/^}/p' "$INGEST" > "$T/fn.sh"
  [ -s "$T/fn.sh" ] || fail "selfcheck_mac not found in ingest-nas.sh"
}

mk_wt() { # <dir> <changed-path...> — repo on `feat` adding the named paths vs origin/main
  local d="$1"; shift
  $GIT init -q -b main "$d" || fail "init $d"
  $GIT -C "$d" commit -qm base --allow-empty || fail "base"
  $GIT -C "$d" update-ref refs/remotes/origin/main HEAD
  $GIT -C "$d" checkout -q -b feat
  local p
  for p in "$@"; do mkdir -p "$d/$(dirname "$p")"; echo x > "$d/$p"; done
  $GIT -C "$d" add -A; $GIT -C "$d" commit -qm feat || fail "feat"
}

# sc_run <wt> — run the real selfcheck_mac with every heavy dependency stubbed. The caller
# overrides check bodies via SC_TSC/SC_INV/SC_VIT/SC_RN (default true) and picks the heavy stub
# with SC_DROP_RN_HDR=1 (simulates a section that never printed its header). Sets SC_RC.
sc_run() {
  local wt="$1"
  mkdir -p "$T/j"; : > "$T/j/selfcheck.txt"; rm -f "$T/j/marker"
  if [ "${SC_DROP_RN_HDR:-0}" = 1 ]; then
    cat > "$T/heavy.sh" <<SH
#!/bin/bash
"\$@"
sed -i '' '/^== mobile-rn\$/d' "$T/j/selfcheck.txt" 2>/dev/null || sed -i '/^== mobile-rn\$/d' "$T/j/selfcheck.txt"
SH
  else
    cat > "$T/heavy.sh" <<'SH'
#!/bin/bash
"$@"
SH
  fi
  cat > "$T/prep.sh" <<'SH'
#!/bin/bash
exit 0
SH
  (
    . "$T/fn.sh"
    with_timeout() { shift; "$@"; }
    PREP="$T/prep.sh"; HEAVY="$T/heavy.sh"; GIT="$GIT"
    NAS_SELFCHECK_TSC="${SC_TSC:-true}" NAS_SELFCHECK_INV="${SC_INV:-true}" \
    NAS_SELFCHECK_VITEST="${SC_VIT:-true}" NAS_SELFCHECK_RN="${SC_RN:-true}" \
    selfcheck_mac "$wt" "$T/j"
  )
  SC_RC=$?
}

test_rn_section_runs_for_rn_paths() {
  extract; mk_wt "$T/w1" mobile-rn/app/pair.tsx
  SC_RN="echo RN-RAN >> '$T/j/marker'" sc_run "$T/w1"
  [ $SC_RC -eq 0 ] || fail "rn: self-check red on green stubs ($(cat "$T/j/selfcheck.txt"))"
  grep -qx '== mobile-rn' "$T/j/selfcheck.txt" \
    || fail "rn: no == mobile-rn section ($(cat "$T/j/selfcheck.txt"))"
  [ -f "$T/j/marker" ] || fail "rn: the NAS_SELFCHECK_RN command did not run"
}

test_rn_section_runs_for_ui_src() {
  extract; mk_wt "$T/w2" ui/src/lib/usage.ts
  SC_RN="echo RN-RAN >> '$T/j/marker'" sc_run "$T/w2"
  [ $SC_RC -eq 0 ] || fail "ui/src: self-check red ($(cat "$T/j/selfcheck.txt"))"
  grep -qx '== mobile-rn' "$T/j/selfcheck.txt" || fail "ui/src: no == mobile-rn section"
  [ -f "$T/j/marker" ] || fail "ui/src: the NAS_SELFCHECK_RN command did not run"
}

test_rn_section_skipped_for_other_paths() {
  extract; mk_wt "$T/w3" internal/foo/a.go
  SC_RN="echo SHOULD-NOT >> '$T/j/marker'" sc_run "$T/w3"
  [ $SC_RC -eq 0 ] || fail "skip: self-check red ($(cat "$T/j/selfcheck.txt"))"
  ! grep -qx '== mobile-rn' "$T/j/selfcheck.txt" \
    || fail "skip: the rn section ran for non-rn paths"
  [ ! -f "$T/j/marker" ] || fail "skip: the NAS_SELFCHECK_RN command ran anyway"
}

test_failing_rn_section_is_red_like_tsc() {
  extract; mk_wt "$T/w4" mobile-rn/app/x.tsx
  SC_RN=false sc_run "$T/w4"
  [ $SC_RC -ne 0 ] || fail "fail: an RN-FAIL section read as green"
  grep -qx 'RN-FAIL' "$T/j/selfcheck.txt" \
    || fail "fail: no RN-FAIL marker ($(cat "$T/j/selfcheck.txt"))"
  # same verdict a tsc failure produces on the same paths
  SC_TSC=false sc_run "$T/w4"
  [ $SC_RC -ne 0 ] || fail "fail: a TSC-FAIL section read as green"
}

test_missing_rn_section_is_red() {
  extract; mk_wt "$T/w5" mobile-rn/app/y.tsx
  SC_DROP_RN_HDR=1 sc_run "$T/w5"
  [ $SC_RC -ne 0 ] || fail "missing: a dropped == mobile-rn header read as green"
  grep -q 'never ran == mobile-rn' "$T/j/selfcheck.txt" \
    || fail "missing: no missing-section line ($(cat "$T/j/selfcheck.txt"))"
}

test_body_line_reports_rn_coverage() {
  extract
  grep -q 'SELFCHECK_RN_NOTE' "$INGEST" \
    || fail "body: no skip/run note variable for the mobile-rn section"
  grep -n 'Mac self-check after NAS hand-over' "$INGEST" | grep -q 'SELFCHECK_RN_NOTE' \
    || fail "body: the PR-body self-check line does not say what mobile-rn coverage ran"
}

run test_rn_section_runs_for_rn_paths
run test_rn_section_runs_for_ui_src
run test_rn_section_skipped_for_other_paths
run test_failing_rn_section_is_red_like_tsc
run test_missing_rn_section_is_red
run test_body_line_reports_rn_coverage
echo ALL-PASS
