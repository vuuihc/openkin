#!/bin/bash
# test-rename-copy-check.sh — a locale rename must not leave an untouched test asserting the old
# value, and the lane must run that rule before it pushes.
#
# The rule was prose in worker_contract since 2026-11-22 and still did not fire: on 2026-11-24
# PR #665 renamed `nav.openCover` in en.ts and left four `getByRole` queries on the old English in
# Sidebar.dom.test.tsx. CI went red, the merge lane's full gate spent its run to say the same
# thing, and the CEO hand-fixed it. A prose rule the worker must remember is not a gate; the lane
# seam `--renamed-copy-check` is. This suite pins its two stages statically: the removed values it
# derives from the branch diff, and the call site in the lane pipeline that makes it real.
#
# Hermetic: one temp git repo per case (origin/main via update-ref), RSI_CTRL redirected into the
# temp dir, stubbed lane-pr.sh/volc-budget.py. No network, no npm, no node: npm, npx, node, go and
# curl are booby traps, and stage 2 runs the stub ui/node_modules/.bin/vitest the case writes. A
# fixture without that stub has no ui/node_modules, so a stage-1 hit yields the NA reason that
# names the candidate — that is how the static cases read stage 1's finding.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LANE="$(cd "$HERE/.." && pwd)/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""; R=""; CASE=""

pass() { echo "PASS $*"; }
# The case name rides on the failure line: a Claims entry names this case, and red_first.py
# requires the named test on a line that itself marks the failure.
fail() { echo "FAIL ${CASE:-?}: $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# Booby traps: the static stage must decide without them; stage 2 is the lane's own bound.
npm() { exit 97; }; npx() { exit 97; }; go() { exit 97; }; node() { exit 97; }; curl() { exit 97; }
export -f npm npx go node curl

CTRL="$T/ctrl"; ST="$CTRL/rsi/state"
mkdir -p "$ST/lanes" "$CTRL/rsi/runtime" "$T/home"
# common.sh probes the budget and lane.sh sources lane-pr.sh before any seam: both must be stubs.
printf 'import sys\nsys.exit(0)\n' > "$CTRL/rsi/runtime/volc-budget.py"
printf '#!/bin/bash\n# stub: the seam never creates a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
chmod +x "$CTRL/rsi/runtime/lane-pr.sh"
printf '#!/bin/bash\n# stub: the seam never pushes\n' > "$CTRL/rsi/runtime/lane-push.sh"
chmod +x "$CTRL/rsi/runtime/lane-push.sh"

# seam — lane.sh --renamed-copy-check against the temp control tree and a temp HOME. The seam must
# exit before locks, fetch, dispatch or any lane bookkeeping. Sets RC and OUT.
seam() {
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --renamed-copy-check "$R" 2>&1)"; RC=$?
}

# new_repo — base tree on main (origin/main points at it), checked out on `feat`. The base carries
# a locale pair and one untouched DOM test asserting the English label, the #665 shape.
new_repo() {
  R="$T/repo"; rm -rf "$R"; mkdir -p "$R"
  g init -q -b main || fail "git init"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/ui/src/i18n/locales" "$R/ui/src/components"
  cat > "$R/ui/src/i18n/locales/en.ts" <<'TS'
const en = {
  nav: {
    openCover: "Show only this project",
    back: "Back",
    sameValue: "Shared sentence for both keys",
  },
};
export default en;
TS
  cat > "$R/ui/src/i18n/locales/zh.ts" <<'TS'
const zh = {
  nav: {
    openCover: "只显示这个项目",
    back: "返回",
    sameValue: "两个键共用的句子",
  },
};
export default zh;
TS
  cat > "$R/ui/src/components/Sidebar.dom.test.tsx" <<'TSX'
it("opens the cover", () => {
  screen.getByRole("button", { name: "Show only this project" });
});
TSX
  g add -A >/dev/null && g commit -q -m base || fail "base commit"
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feat
}

# commit_feat — the branch's own commit; the seam diffs origin/main...HEAD.
commit_feat() {
  g add -A >/dev/null && g commit -q -m feat || fail "feat commit"
}

one_line() { [ "$(printf '%s\n' "$1" | wc -l | tr -d ' ')" = 1 ]; }

# stub_vitest — stage 2 must execute the binary it checked, so the case writes that binary itself:
# a plain shell script, no npm, npx, node or real vitest involved. <exit-code> <output-line>.
stub_vitest() {
  mkdir -p "$R/ui/node_modules/.bin"
  printf '#!/bin/bash\nprintf "%%s\\n" %q\nexit %s\n' "$2" "$1" > "$R/ui/node_modules/.bin/vitest"
  chmod +x "$R/ui/node_modules/.bin/vitest"
}

# --- cases -------------------------------------------------------------------------------------

# Stage 1: the removed English value is still quoted in an untouched test. The fixture has no
# ui/node_modules, so the seam must stop at stage 2 with an NA that names the candidate it found,
# rather than pretending it ran vitest.
test_removed_value_still_asserted_is_a_candidate() {
  new_repo
  sed -i '' 's/Show only this project/Only this project/' "$R/ui/src/i18n/locales/en.ts"
  commit_feat
  seam
  [ "$RC" -eq 0 ] || fail "still-asserted: seam exited $RC ($OUT)"
  case "$OUT" in RENAME_COPY_NA:*) ;; *) fail "still-asserted: expected NA (stage 2 unavailable), got: $OUT" ;; esac
  [[ "$OUT" == *"Show only this project"* ]] || fail "still-asserted: the verdict never names the removed value: $OUT"
  [[ "$OUT" == *"ui/src/components/Sidebar.dom.test.tsx:2"* ]] || fail "still-asserted: the verdict never names the test file and line: $OUT"
  one_line "$OUT" || fail "still-asserted: the seam printed more than one line: $OUT"
}

# The worker did the whole rename: catalogue and the test now quote the new label. The old value
# is gone from the branch, so no test can be stale and the seam is green.
test_value_renamed_everywhere_is_ok() {
  new_repo
  sed -i '' 's/Show only this project/Only this project/' "$R/ui/src/i18n/locales/en.ts"
  sed -i '' 's/Show only this project/Only this project/' "$R/ui/src/components/Sidebar.dom.test.tsx"
  commit_feat
  seam
  [ "$RC" -eq 0 ] || fail "renamed-everywhere: seam exited $RC ($OUT)"
  [ "$OUT" = "RENAME_COPY_OK: 1 removed value(s); no test asserts them" ] \
    || fail "renamed-everywhere: expected the one-candidate OK line, got: $OUT"
}

# A key rename that keeps the value is a move, not a removal: the value still appears in the
# branch's catalogues, so a test quoting it is not stale. Only removing the still-present filter
# turns this case red (the manifest's mutant).
test_moved_value_is_not_a_candidate() {
  new_repo
  sed -i '' 's/sameValue:/movedValue:/' "$R/ui/src/i18n/locales/en.ts"
  commit_feat
  seam
  [ "$RC" -eq 0 ] || fail "moved-value: seam exited $RC ($OUT)"
  [ "$OUT" = "RENAME_COPY_OK: 0 removed value(s); no test asserts them" ] \
    || fail "moved-value: the moved value was treated as removed: $OUT"
}

# Short labels ("Back", "Save") churn constantly and carry no stale-test signal. Only deleting the
# length floor turns this case red.
test_short_value_is_ignored() {
  new_repo
  sed -i '' 's/back: "Back"/back: "Return"/' "$R/ui/src/i18n/locales/en.ts"
  commit_feat
  seam
  [ "$RC" -eq 0 ] || fail "short-value: seam exited $RC ($OUT)"
  [ "$OUT" = "RENAME_COPY_OK: 0 removed value(s); no test asserts them" ] \
    || fail "short-value: a sub-8-character value became a candidate: $OUT"
}

# A PR that touches no locale catalogue has no renamed copy to check; the seam must not invent a
# verdict for it.
test_no_locale_change_is_na() {
  new_repo
  printf '// touched\nexport const x = 1;\n' >> "$R/ui/src/components/Sidebar.dom.test.tsx"
  commit_feat
  seam
  [ "$RC" -eq 0 ] || fail "no-locale-change: seam exited $RC ($OUT)"
  one_line "$OUT" || fail "no-locale-change: the seam printed more than one line: $OUT"
  [ "$OUT" = "RENAME_COPY_NA: no locale change" ] \
    || fail "no-locale-change: expected one NA for a non-locale diff, got: $OUT"
}

# Stage 2's block-the-push path: the checked binary fails, so the seam must report RED naming the
# removed value, the untouched test and vitest's failing line, and exit 1 so the lane stops.
test_failing_vitest_is_red() {
  new_repo
  sed -i '' 's/Show only this project/Only this project/' "$R/ui/src/i18n/locales/en.ts"
  commit_feat
  stub_vitest 1 "FAIL  src/components/Sidebar.dom.test.tsx > opens the cover"
  seam
  [ "$RC" -eq 1 ] || fail "failing-vitest: the seam exited $RC, not 1: $OUT"
  case "$OUT" in RENAME_COPY_RED:*) ;; *) fail "failing-vitest: expected RED, got: $OUT" ;; esac
  [[ "$OUT" == *"Show only this project"* ]] || fail "failing-vitest: the verdict never names the removed value: $OUT"
  [[ "$OUT" == *"ui/src/components/Sidebar.dom.test.tsx:2"* ]] \
    || fail "failing-vitest: the verdict never names the untouched test: $OUT"
  [[ "$OUT" == *"FAIL src/components/Sidebar.dom.test.tsx"* ]] \
    || fail "failing-vitest: the verdict never carries vitest's failing line: $OUT"
  one_line "$OUT" || fail "failing-vitest: the seam printed more than one line: $OUT"
}

# The other half of the mapping: the same static hit with a green checked binary is OK, and the
# line says the string is asserted but passing. A regression to `npx` lands in NA here (the booby
# trap exits 97), so this case also pins that the seam runs the binary it checked.
test_passing_vitest_is_ok() {
  new_repo
  sed -i '' 's/Show only this project/Only this project/' "$R/ui/src/i18n/locales/en.ts"
  commit_feat
  stub_vitest 0 ""
  seam
  [ "$RC" -eq 0 ] || fail "passing-vitest: the seam exited $RC: $OUT"
  case "$OUT" in RENAME_COPY_OK:*) ;; *) fail "passing-vitest: expected OK, got: $OUT" ;; esac
  [[ "$OUT" == *"ui/src/components/Sidebar.dom.test.tsx:2"* ]] \
    || fail "passing-vitest: the OK line never names the asserted file:line: $OUT"
  one_line "$OUT" || fail "passing-vitest: the seam printed more than one line: $OUT"
}

# The seam is only a gate when the lane runs it. Pin the call site inside the run path: after the
# format commit (so the diff it reads is the committed branch) and before the push. Deleting the
# call site, or moving it after the push, fails this case.
test_lane_pipeline_calls_the_seam() {
  local call_ln fmt_ln push_ln
  call_ln="$(grep -nF -- '--renamed-copy-check "$WT"' "$LANE" | head -1 | cut -d: -f1)"
  fmt_ln="$(grep -nF 'format-changed.sh" --write --commit --check' "$LANE" | head -1 | cut -d: -f1)"
  push_ln="$(grep -nF 'git_push_retry "$GIT" "$WT" "$BR"' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$call_ln" ] || fail "pipeline-call: the lane never calls --renamed-copy-check on \$WT"
  [ -n "$fmt_ln" ] || fail "pipeline-call: no format-commit call site found"
  [ -n "$push_ln" ] || fail "pipeline-call: no push call site found"
  [ "$fmt_ln" -lt "$call_ln" ] || fail "pipeline-call: the seam runs before the format commit ($fmt_ln !< $call_ln)"
  [ "$call_ln" -lt "$push_ln" ] || fail "pipeline-call: the seam runs after the push ($call_ln !< $push_ln)"
  grep -qF -- '$STATE/lanes/$N.rename.txt' "$LANE" \
    || fail "pipeline-call: a RED verdict leaves no evidence under \$STATE/lanes/\$N.rename.txt"
}

run() { # <case> <fn>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1)); CASE="$1"
  "$2" || exit 1
  pass "$1"
}

RAN=0
run test_removed_value_still_asserted_is_a_candidate test_removed_value_still_asserted_is_a_candidate
run test_value_renamed_everywhere_is_ok test_value_renamed_everywhere_is_ok
run test_moved_value_is_not_a_candidate test_moved_value_is_not_a_candidate
run test_short_value_is_ignored test_short_value_is_ignored
run test_no_locale_change_is_na test_no_locale_change_is_na
run test_failing_vitest_is_red test_failing_vitest_is_red
run test_passing_vitest_is_ok test_passing_vitest_is_ok
run test_lane_pipeline_calls_the_seam test_lane_pipeline_calls_the_seam
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
