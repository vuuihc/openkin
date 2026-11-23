#!/bin/bash
# test-gap-log-guard.sh — a fix PR closes its gap-log entry, and the merge gate refuses it otherwise.
#
# Measured 2026-11-22/23: three fix PRs landed without moving their own `## Open` entry, and each
# paid a second docs-only PR (#611, #615, #632) to correct the record, because docs/plans/gap-log.md
# says a fixed entry never stays under `## Open` (docs/plans/gap-log.md:25-27) and nothing enforced
# it. This suite drives rsi/runtime/gap_log_check.py end to end on throwaway trees, through
# merge.sh's two hermetic seams (`--gap-log-check` = the script; `--gap-log-gate-check` = the same
# gap_log_gate() the verifier calls, mechanical sendback included). The last case is a wiring pin:
# it proves the call site sits between NEED_REV being decided and the reviewer being launched, so
# the guard costs no model call. A string test proves a string; the rule itself is proven by the
# cases above it, and the mutant manifest turns each case red on its own.
#
# Hermetic: temp dirs, a stubbed PR state, no network, no gh, no model, no git. Set
# RSI_TEST_ONLY=<case name> to run one case (used to show a red run per case); both the function
# name and the case name work, so `RSI_TEST_ONLY=gap-log-guard-wiring` is one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="gap-log-guard"
ITEM="R-gap-log-close-guard"
CASE=""; RC=0; OUT=""; RSI_CTRL=""

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# Red by construction, and safe: without the rule or the seams every case would invoke merge.sh
# with an unknown option, which falls through to the live dispatcher. Stop before that happens.
[ -f "$ROOT/rsi/runtime/gap_log_check.py" ] \
  || fail "rsi/runtime/gap_log_check.py is missing; the gap-log rule does not exist here"
grep -qF -- '--gap-log-check' "$MERGE" \
  || fail "merge.sh has no --gap-log-check seam; the guard is not wired"

st() { echo "$RSI_CTRL/rsi/state"; }
sb() { echo "$(st)/sendback/$SLUG.md"; }
gaptxt() { echo "$(st)/merge/$SLUG.gap-log.txt"; }
first() { head -1 "$T/$CASE.out"; }

# gap_log <worktree> <open-text> <fixed-text> — a gap-log whose header prose mentions both
# headings inline, exactly as the real file does (docs/plans/gap-log.md:22-30). The example line
# between the inline mention and the real `## Open` heading cites `ui/src/a.tsx` on purpose: a
# parser that split on the raw string `## Open` would read it as an open entry, and case 2 would
# stop being NA.
gap_log() {
  mkdir -p "$1/docs/plans"
  {
    printf '%s\n' \
      '# Gap Log' \
      '' \
      'Small, real defects found while dogfooding that are not worth interrupting the' \
      'current round for. This file is committed and pushed with the session that writes it.' \
      '' \
      'How an entry moves:' \
      '' \
      '- The sweep reads `## Open` directly. It does **not** open or close GitHub issues.' \
      '- A reader who treats the inline mention of `## Open` above as a heading would read' \
      '  the example line `ui/src/a.tsx` as an open entry; it is not one.' \
      '- When a fix lands, the sweep moves the entry to `## 已修` in the same PR, with' \
      '  the commit / PR and the verification it ran.' \
      '' \
      '## Open' \
      ''
    printf '%s\n' "$2"
    printf '%s\n' '' '## 已修' '' '每条只留一行：症状、落地提交、PR。' ''
    printf '%s\n' "$3"
  } > "$1/docs/plans/gap-log.md"
}

# RSI_PR_STATE_CMD replaces the gh state read; OPEN keeps sendback_mech() on today's path.
cat > "$T/pr-state-stub.sh" <<'SH'
#!/bin/bash
printf '%s\n' "${STUB_STATE_OUT:-OPEN}"
SH

# new_case <name> — fresh control tree, body and changed-files list. The control tree gets its own
# copy of gap_log_check.py at the deployed path, exactly as the merge lane resolves it, so a seam
# that read the script from anywhere else would go red.
new_case() {
  CASE="$1"
  RSI_CTRL="$T/ctrl-$CASE"
  rm -rf "$RSI_CTRL"
  mkdir -p "$RSI_CTRL/rsi/state/merge" "$RSI_CTRL/rsi/state/sendback" "$RSI_CTRL/rsi/runtime"
  cp "$ROOT/rsi/runtime/gap_log_check.py" "$RSI_CTRL/rsi/runtime/gap_log_check.py"
  BODY="$T/$CASE.body"; PATHS="$T/$CASE.paths"
  : > "$BODY"; : > "$PATHS"
  WT="$T/wt-$CASE"
  rm -rf "$WT"; mkdir -p "$WT"
}

body() { printf '%s\n' "$@" > "$BODY"; }
paths() { printf '%s\n' "$@" > "$PATHS"; }

# run_check — the script seam: no state write, exit code is the check's own.
run_check() {
  RSI_CTRL="$RSI_CTRL" bash "$MERGE" --gap-log-check "$WT" "$BODY" "$PATHS" > "$T/$CASE.out" 2>&1
  RC=$?; OUT="$(cat "$T/$CASE.out")"
}

# run_gate — the verifier's path: gap_log_gate(), mechanical sendback included.
run_gate() {
  RSI_CTRL="$RSI_CTRL" RSI_PR_STATE_CMD="bash $T/pr-state-stub.sh \"\$1\"" STUB_STATE_OUT=OPEN \
    bash "$MERGE" --gap-log-gate-check 461 "$SLUG" "$ITEM" "$WT" "$BODY" "$PATHS" > "$T/$CASE.out" 2>&1
  RC=$?; OUT="$(cat "$T/$CASE.out")"
}

expect_sent_back() { # <case> <detail fragment>
  [ "$RC" -ne 0 ] || fail "$1: exit 0, want a failed check ($OUT)"
  [ -f "$(sb)" ] || fail "$1: no sendback at $(sb) ($OUT)"
  grep -qF -- 'kind: mechanical' "$(sb)" || fail "$1: sendback is not mechanical"
  grep -qF -- 'source: mech-gap-log' "$(sb)" || fail "$1: sendback source is not mech-gap-log"
  grep -qF -- 'cmd: python3 rsi/runtime/gap_log_check.py' "$(sb)" \
    || fail "$1: sendback does not name the command to re-run"
  [ -f "$(gaptxt)" ] || fail "$1: no gap-log detail at $(gaptxt)"
  grep -qF -- "$2" "$(gaptxt)" || fail "$1: gap-log detail lacks '$2': $(cat "$(gaptxt)")"
}

# --- 1. a diff that touches no cited path needs no line -----------------------------------------
test_uncited_diff_needs_no_line() {
  new_case gap-log-guard-uncited-diff-needs-no-line
  gap_log "$WT" \
    '- 2026-11-22 · 高 · 新建对话页的封面 chip 仍小于 44px — ui/src/a.tsx:60 的规则只对手机生效' ''
  paths "ui/src/b.tsx"
  body "No gap-log line here."
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in GAP_LOG_NA:*) ;; *) fail "$CASE: output is '$OUT', want GAP_LOG_NA" ;; esac
  pass "$CASE"
}

# --- 2. an empty ## Open never fails, and the inline heading prose is not an entry --------------
test_empty_open_never_fails() {
  new_case gap-log-guard-empty-open-never-fails
  gap_log "$WT" '' ''
  paths "ui/src/a.tsx"          # cited only by the header's example line, never by an entry
  body ""
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in GAP_LOG_NA:*) ;; *) fail "$CASE: output is '$OUT', want GAP_LOG_NA" ;; esac
  pass "$CASE"
}

# --- 3. a bare `Gap-log: none` on a cited path names the entry, the path and both legal forms ---
test_bare_none_on_a_cited_path_fails() {
  new_case gap-log-guard-bare-none-on-a-cited-path-fails
  gap_log "$WT" \
    '- 2026-11-22 · 高 · 手机端的搜索框在 iPad 上仍是桌面密度 — ui/src/index.css:279 的规则只对手机生效' ''
  paths "ui/src/index.css"
  body "Gap-log: none"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in GAP_LOG_FAIL:*) ;; *) fail "$CASE: output is '$OUT', want GAP_LOG_FAIL" ;; esac
  case "$OUT" in *'搜索框在 iPad 上仍是桌面密度'*) ;; \
    *) fail "$CASE: does not name the entry title: $OUT" ;; esac
  case "$OUT" in *'ui/src/index.css'*) ;; \
    *) fail "$CASE: does not name the cited path: $OUT" ;; esac
  case "$OUT" in *'Gap-log: none: <reason'*) ;; \
    *) fail "$CASE: does not name the reasoned waiver form: $OUT" ;; esac
  case "$OUT" in *'Gap-log: <text'*) ;; \
    *) fail "$CASE: does not name the declaration form: $OUT" ;; esac
  pass "$CASE"
}

# --- 4. a reasoned waiver passes and its reason is echoed ---------------------------------------
test_reason_waiver_passes() {
  new_case gap-log-guard-reason-waiver-passes
  gap_log "$WT" \
    '- 2026-11-22 · 高 · 手机端的搜索框在 iPad 上仍是桌面密度 — ui/src/index.css:279 的规则只对手机生效' ''
  paths "ui/src/index.css"
  body "Gap-log: none: the cited rule is unrelated to this token pass"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  [ "$(first)" = "GAP_LOG_WAIVED: the cited rule is unrelated to this token pass" ] \
    || fail "$CASE: first line is '$(first)', want the echoed waiver"
  pass "$CASE"
}

# --- 5. a declared entry must actually move to ## 已修 -------------------------------------------
test_declared_entry_must_move() {
  new_case gap-log-guard-declared-entry-must-move
  local entry text
  entry='- 2026-11-23 · 低 · 中文界面的「例行任务」页把同一个东西叫出三个名字（搜索框 / 加载更多 / 筛选空态）— 01c3d445（PR #625）：三个 zh 值统一为「例行任务」，见 ui/src/i18n/locales/zh.ts:1747'
  text='中文界面的「例行任务」页把同一个东西叫出三个名字'
  # The gap-log file is in the diff in BOTH halves: the still-open half must fail on the move,
  # not on the same-PR half, or a mutant that drops the move check would survive.
  paths "ui/src/i18n/locales/zh.ts" "docs/plans/gap-log.md"
  body "Gap-log: $text"
  gap_log "$WT" "$entry" ''
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: still open: exit $RC, want 1 ($OUT)"
  case "$OUT" in *'move the entry to ## 已修 in this PR'*) ;; \
    *) fail "$CASE: still open: output lacks the exact edit: $OUT" ;; esac
  # The same wording, moved: the declaration now passes.
  gap_log "$WT" '' "$entry"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: moved: exit $RC, want 0 ($OUT)"
  case "$OUT" in GAP_LOG_OK:*) ;; *) fail "$CASE: moved: output is '$OUT', want GAP_LOG_OK" ;; esac
  pass "$CASE"
}

# --- 6. a declaration without the gap-log file in the diff is not the same-PR move --------------
test_declaration_needs_the_file_in_the_diff() {
  new_case gap-log-guard-declaration-needs-the-file-in-the-diff
  local entry text
  entry='- 2026-11-23 · 低 · 中文界面的「例行任务」页把同一个东西叫出三个名字 — ui/src/i18n/locales/zh.ts:1747'
  text='中文界面的「例行任务」页把同一个东西叫出三个名字'
  gap_log "$WT" '' "$entry"
  paths "ui/src/i18n/locales/zh.ts"      # docs/plans/gap-log.md deliberately absent
  body "Gap-log: $text"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in *'docs/plans/gap-log.md'*) ;; \
    *) fail "$CASE: does not name the missing same-PR file: $OUT" ;; esac
  pass "$CASE"
}

# --- 7. the gate sends it back mechanically and names the command to re-run ---------------------
test_gate_sends_back_and_names_the_command() {
  new_case gap-log-guard-gate-sends-back-and-names-the-command
  gap_log "$WT" \
    '- 2026-11-22 · 高 · 手机端的搜索框在 iPad 上仍是桌面密度 — ui/src/index.css:279 的规则只对手机生效' ''
  paths "ui/src/index.css"
  body "This PR fixes the search box density."
  run_gate
  expect_sent_back "$CASE" "搜索框在 iPad 上仍是桌面密度"
  pass "$CASE"
}

# --- 8. wiring pin: the check runs after NEED_REV is final and before the reviewer launch --------
# Not evidence for the rule (cases 1-7 are): this only fails when the call site is deleted or
# moved behind the review launch, which would silently restore the defect the row names.
test_gap_log_guard_runs_before_the_reviewer_is_launched() {
  local name="test_gap_log_guard_runs_before_the_reviewer_is_launched" call claim guards review
  CASE="gap-log-guard-wiring"
  call="$(grep -nF 'gap_log_gate "$N" "$SLUG"' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$call" ] || fail "$name: merge.sh has no gap_log_gate call at the verifier"
  claim="$(grep -nF 'claim_check_gate "$N" "$SLUG"' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$claim" ] || fail "$name: merge.sh has no claim_check_gate call at the verifier"
  [ "$call" -gt "$claim" ] \
    || fail "$name: the gap-log guard runs before the claim check (call $call, claim $claim)"
  guards="$(grep -nF 'if [ $NEED_REV -eq 1 ]; then' "$MERGE" | cut -d: -f1 | tr '\n' ' ')"
  review="$(echo "$guards" | awk '{print $2}')"
  [ -n "$review" ] || fail "$name: cannot locate the reviewer-launch block"
  [ "$call" -gt "$(echo "$guards" | awk '{print $1}')" ] \
    || fail "$name: the gap-log guard runs before NEED_REV is final (call $call)"
  [ "$call" -lt "$review" ] \
    || fail "$name: the gap-log guard runs after the reviewer is launched (call $call, review $review)"
  grep -qF -- '--gap-log-check <worktree>' "$MERGE" || fail "$name: no --gap-log-check seam"
  grep -qF -- '--gap-log-gate-check <pr-number>' "$MERGE" || fail "$name: no --gap-log-gate-check seam"
  pass "$CASE"
}

# --- 9. an entry the body neither declares nor waives is listed with its linking path -----------
test_uncovered_entry_is_listed() {
  new_case gap-log-guard-uncovered-entry-is-listed
  gap_log "$WT" \
    '- 2026-11-22 · 高 · 搜索框在 iPad 上仍是桌面密度 — ui/src/index.css:279' \
    '- 2026-11-23 · 低 · 中文界面的「例行任务」页把同一个东西叫出三个名字 — ui/src/i18n/locales/zh.ts:1747'
  paths "ui/src/i18n/locales/zh.ts" "ui/src/index.css" "docs/plans/gap-log.md"
  body "Gap-log: 中文界面的「例行任务」页把同一个东西叫出三个名字"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in *'搜索框在 iPad 上仍是桌面密度'*) ;; \
    *) fail "$CASE: does not list the uncovered entry: $OUT" ;; esac
  case "$OUT" in *'ui/src/index.css'*) ;; \
    *) fail "$CASE: does not name the path that linked it: $OUT" ;; esac
  pass "$CASE"
}

# --- 10. the gate logs a waiver so the patrol can watch the rate --------------------------------
test_waiver_is_logged() {
  new_case gap-log-guard-waiver-is-logged
  gap_log "$WT" \
    '- 2026-11-22 · 高 · 手机端的搜索框在 iPad 上仍是桌面密度 — ui/src/index.css:279 的规则只对手机生效' ''
  paths "ui/src/index.css"
  body "Gap-log: none: the cited rule is unrelated to this token pass"
  run_gate
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  [ ! -e "$(sb)" ] || fail "$CASE: a waiver must not write a sendback"
  grep -qF -- "#461 $SLUG gap_log=waived" "$(st)/merge/cycles.log" \
    || fail "$CASE: cycles.log lacks the gap_log=waived line"
  pass "$CASE"
}

run() { # <function> [<case name>] — RSI_TEST_ONLY accepts either spelling
  local fn="$1" name="${2:-$1}"
  [ -n "${RSI_TEST_ONLY:-}" ] && [ "$fn" != "$RSI_TEST_ONLY" ] && [ "$name" != "$RSI_TEST_ONLY" ] \
    && return 0
  "$fn" || exit 1
}
run test_uncited_diff_needs_no_line gap-log-guard-uncited-diff-needs-no-line
run test_empty_open_never_fails gap-log-guard-empty-open-never-fails
run test_bare_none_on_a_cited_path_fails gap-log-guard-bare-none-on-a-cited-path-fails
run test_reason_waiver_passes gap-log-guard-reason-waiver-passes
run test_declared_entry_must_move gap-log-guard-declared-entry-must-move
run test_declaration_needs_the_file_in_the_diff gap-log-guard-declaration-needs-the-file-in-the-diff
run test_gate_sends_back_and_names_the_command gap-log-guard-gate-sends-back-and-names-the-command
run test_uncovered_entry_is_listed gap-log-guard-uncovered-entry-is-listed
run test_waiver_is_logged gap-log-guard-waiver-is-logged
run test_gap_log_guard_runs_before_the_reviewer_is_launched gap-log-guard-wiring
echo "test-gap-log-guard: ALL-PASS"
