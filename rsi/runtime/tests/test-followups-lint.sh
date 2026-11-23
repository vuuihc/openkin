#!/bin/bash
# test-followups-lint.sh — a follow-up that already landed must not read as still open.
#
# The loop's process defects are written into `state/followups.md`, one `- [ ]` line each, usually
# naming the PR or commit it is about. Nothing ever marks those lines done, so the file grew
# past 1,600 lines; on 2026-11-21 a planner reading it nearly started three lanes for work already on
# `main`. followups-lint.py is a read-only report: it checks each open line's refs against
# `merged.log` (PR numbers) and `git merge-base --is-ancestor` (commit ids) and says which cite a
# merged ref — a hint to read that line, never a claim that it is done. It never edits the list and
# a ref it cannot resolve is open.
#
# Hermetic: mktemp state, fixture followups/merged.log, a throwaway git repo for the SHA cases, no
# network, no writes outside the temp dirs. Prints "PASS <case>" per case and exits non-zero on the
# first failure. Set RSI_TEST_ONLY=<case> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
TOOL="$RSI/runtime/followups-lint.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
S="$T/state"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

reset() { rm -rf "$S"; mkdir -p "$S"; : > "$S/followups.md"; : > "$S/merged.log"; }

# fu <line>... — append follow-up lines verbatim.
fu() { printf '%s\n' "$@" >> "$S/followups.md"; }

# merged <pr> — a merged.log line in the shape the merge lane writes.
merged() {
  printf '2026-11-21 09:00 PR #%s followups-lint R-followups-lint merged a81cbaa1 https://example.invalid/pull/%s\n' \
    "$1" "$1" >> "$S/merged.log"
}

# run [args...] — stdout in $out, stderr in $T/err.txt (separate: --status must be one stdout line).
run() {
  out="$(python3 "$TOOL" --state "$S" "$@" 2>"$T/err.txt")"; rc=$?
  printf '%s' "$out" > "$T/out.txt"
}

# sha256 <file> — shasum on macOS, sha256sum on Linux; loud when neither exists, so the
# "not modified" case cannot pass vacuously.
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
  else fail "sha256: neither shasum nor sha256sum is available"; fi
}

command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 \
  || fail "neither shasum nor sha256sum is available"

# --- 1. a follow-up citing a merged PR is cited -------------------------------------------------
case_merged_pr_is_cited() {
  want merged-pr-is-cited || return 0
  reset
  printf '\xef\xbb\xbf' >> "$S/followups.md"    # a BOM must not swallow the first line
  fu '- [ ] fix the thing from #42 in internal/api' '- [ ] unrelated follow-up'
  merged 42
  run --status
  [ "$rc" -eq 0 ] || fail "merged-pr: rc=$rc ($out; $(cat "$T/err.txt"))"
  [ "$out" = 'followups: 2 open, 1 cite a merged ref (#42)' ] || fail "merged-pr: status '$out'"
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["open"] == 2 and d["cited"] == 1, d
assert "stale" not in d and "landed" not in d, d
assert d["items"][0]["cited"] == "#42", d["items"][0]
assert d["items"][0]["line"] == 1, d["items"][0]
assert d["items"][1]["cited"] is None, d["items"][1]
PY
  run
  printf '%s\n' "$out" | grep -q '^cited 1 fix the thing from #42 in internal/api$' \
    || fail "merged-pr: default table ($out)"
  pass merged-pr-is-cited
}

# --- 2. a PR that is not in merged.log is open, and the URL path is not the marker ---------------
case_unmerged_pr_is_open() {
  want unmerged-pr-is-open || return 0
  reset
  fu '- [ ] needs #43' '- [ ] see https://example.invalid/pull/43 for context'
  merged 42
  # A merge line for something else whose URL happens to end in /pull/43 and carries no
  # `#43` token: if the tool matched URL paths this would mark the #43 follow-up landed.
  printf '2026-11-21 09:05 PR #7 x R-z merged bbbbbbbb https://example.invalid/pull/43\n' \
    >> "$S/merged.log"
  run --status
  [ "$rc" -eq 0 ] || fail "unmerged-pr: rc=$rc"
  [ "$out" = 'followups: 2 open, 0 cite a merged ref' ] || fail "unmerged-pr: status '$out'"
  pass unmerged-pr-is-open
}

# --- 3. a commit that is an ancestor of the base branch is cited -------------------------------
case_ancestor_sha_is_cited() {
  want ancestor-sha-is-cited || return 0
  local R="$T/repo" BASE SHA UP
  git init -q "$R" || fail "ancestor: git init"
  git -C "$R" config user.email owner@example.com
  git -C "$R" config user.name Fixture
  git -C "$R" config commit.gpgsign false    # never depend on the developer's global config
  echo a > "$R/a.txt"; git -C "$R" add a.txt; git -C "$R" commit -qm base
  BASE="$(git -C "$R" rev-parse --abbrev-ref HEAD)"
  SHA="$(git -C "$R" rev-parse HEAD)"
  UP="$(printf '%s' "$SHA" | tr 'a-f' 'A-F')"
  reset
  fu "- [ ] landed in $UP"      # uppercase input, lowercase compare and output
  run --repo "$R" --base "$BASE" --status
  [ "$rc" -eq 0 ] || fail "ancestor: rc=$rc ($out)"
  [ "$out" = "followups: 1 open, 1 cite a merged ref ($SHA)" ] || fail "ancestor: status '$out'"
  pass ancestor-sha-is-cited
}

# --- 4. a commit on a side branch that never merged is open -------------------------------------
case_non_ancestor_sha_is_open() {
  want non-ancestor-sha-is-open || return 0
  local R="$T/repo" BASE SHA
  # Reuse case 3's repo when only this case runs.
  if [ ! -d "$R/.git" ]; then
    git init -q "$R" || fail "non-ancestor: git init"
    git -C "$R" config user.email owner@example.com
    git -C "$R" config user.name Fixture
    git -C "$R" config commit.gpgsign false
    echo a > "$R/a.txt"; git -C "$R" add a.txt; git -C "$R" commit -qm base
  fi
  BASE="$(git -C "$R" rev-parse --abbrev-ref HEAD)"
  git -C "$R" checkout -q -B side
  echo b >> "$R/a.txt"; git -C "$R" commit -qam side
  SHA="$(git -C "$R" rev-parse HEAD)"
  git -C "$R" checkout -q "$BASE"
  reset
  fu "- [ ] not merged yet $SHA"
  run --repo "$R" --base "$BASE" --status
  [ "$rc" -eq 0 ] || fail "non-ancestor: rc=$rc ($out)"
  [ "$out" = 'followups: 1 open, 0 cite a merged ref' ] || fail "non-ancestor: status '$out'"
  pass non-ancestor-sha-is-open
}

# --- 5. an id that does not resolve locally is open, never landed -------------------------------
case_unknown_sha_is_open() {
  want unknown-sha-is-open || return 0
  local R="$T/repo" BASE
  if [ ! -d "$R/.git" ]; then
    git init -q "$R" || fail "unknown: git init"
    git -C "$R" config user.email owner@example.com
    git -C "$R" config user.name Fixture
    git -C "$R" config commit.gpgsign false
    echo a > "$R/a.txt"; git -C "$R" add a.txt; git -C "$R" commit -qm base
  fi
  BASE="$(git -C "$R" rev-parse --abbrev-ref HEAD)"
  reset
  fu '- [ ] a shallow clone must not call this done deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  run --repo "$R" --base "$BASE" --status
  [ "$rc" -eq 0 ] || fail "unknown: rc=$rc ($out)"
  [ "$out" = 'followups: 1 open, 0 cite a merged ref' ] || fail "unknown: status '$out'"
  pass unknown-sha-is-open
}

# --- 6. checked lines and lines with no checkbox are not counted --------------------------------
case_checked_and_refless_lines_are_ignored() {
  want checked-and-refless-lines-are-ignored || return 0
  reset
  fu '- [x] done already #42' 'just prose mentioning #42' '- not a checkbox #42' '- [ ] real one #43'
  merged 42
  run --status
  [ "$rc" -eq 0 ] || fail "ignore: rc=$rc"
  [ "$out" = 'followups: 1 open, 0 cite a merged ref' ] || fail "ignore: status '$out'"
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["open"] == 1 and d["cited"] == 0, d
assert d["items"][0]["line"] == 4, d["items"][0]
PY
  pass checked-and-refless-lines-are-ignored
}

# --- 7. the tool is a report, never an editor ---------------------------------------------------
case_file_is_not_modified() {
  want file-is-not-modified || return 0
  reset
  fu '- [ ] fix #42' '- [ ] deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  merged 42
  local before after
  before="$(sha256 "$S/followups.md")"
  run --json
  run
  run --status
  after="$(sha256 "$S/followups.md")"
  [ "$before" = "$after" ] || fail "not-modified: followups.md changed"
  pass file-is-not-modified
}

# --- 8. the status line is exactly one line in the documented shape ----------------------------
case_status_is_one_line() {
  want status-is-one-line || return 0
  reset
  fu '- [ ] one' '- [ ] two'
  run --status
  [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] || fail "status-line: not one line ($out)"
  printf '%s\n' "$out" | grep -Eq '^followups: [0-9]+ open, [0-9]+ cite a merged ref' \
    || fail "status-line: wrong shape ($out)"
  [ "$out" = 'followups: 2 open, 0 cite a merged ref' ] || fail "status-line: '$out'"
  pass status-is-one-line
}

# --- 9. missing files are zero rows and one message, not a crash -------------------------------
case_missing_files_are_not_a_crash() {
  want missing-files-are-not-a-crash || return 0
  rm -rf "$S"; mkdir -p "$S"
  run --status
  [ "$rc" -eq 0 ] || fail "missing: rc=$rc"
  [ "$out" = 'followups: 0 open, 0 cite a merged ref' ] || fail "missing: status '$out'"
  [ -s "$T/err.txt" ] || fail "missing: no message on stderr"
  pass missing-files-are-not-a-crash
}

# --- 10. a usage error is exit 2, distinct from every successful read ---------------------------
case_usage_error_exits_two() {
  want usage-error-exits-two || return 0
  python3 "$TOOL" --not-a-flag >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 2 ] || fail "usage: want rc=2, got $rc"
  pass usage-error-exits-two
}

# --- 11. the suite is wired into the gate -------------------------------------------------------
case_wiring_runs_the_suite() {
  want wiring-runs-the-suite || return 0
  bash "$RSI/runtime/tests/test-wiring.sh" >/dev/null 2>&1 \
    || fail "wiring: test-wiring.sh fails (name this suite in scripts/check.sh job_shell_test)"
  grep -q 'followups-lint.py --status --state {{STATE}} --repo {{CTRL}}' "$RSI/runtime/prompts/fill.md" \
    || fail "wiring: fill.md never names followups-lint.py to the planner"
  grep -q 'must still be read, not skipped' "$RSI/runtime/prompts/fill.md" \
    || fail "wiring: fill.md does not say a cited line must be read"
  pass wiring-runs-the-suite
}

# --- 12. a line citing a merged ref as its trigger/failure is a citation, never "done" ----------
case_cited_ref_is_not_done() {
  want cited-ref-is-not-done || return 0
  reset
  # The live 2026-11-21 shape (followups.md line 680): #161 is the trigger the follow-up reacts
  # to ("after the lint ban lands, tighten again"), not the work it asks for; #506 is cited as
  # the cause of a failure. Both are citations a planner must still read, never a landed verdict.
  fu '- [ ] G1 #161 落地 lint ban 后应再收紧一次' '- [ ] #506 改了 schema 于是 build 红，需要修'
  merged 161
  merged 506
  run --status
  [ "$rc" -eq 0 ] || fail "cited-ref: rc=$rc ($out)"
  [ "$out" = 'followups: 2 open, 2 cite a merged ref (#161, #506)' ] || fail "cited-ref: status '$out'"
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["open"] == 2 and d["cited"] == 2, d
assert "stale" not in d and "landed" not in d, d      # the verdict is a citation, not "done"
assert d["items"][0]["cited"] == "#161", d["items"][0]
assert "stale" not in d["items"][0] and "landed" not in d["items"][0], d["items"][0]
PY
  run
  printf '%s\n' "$out" | grep -q '^cited 1 G1 #161 ' || fail "cited-ref: default table ($out)"
  printf '%s\n' "$out" | grep -Eqi 'landed|stale' && fail "cited-ref: output still claims done ($out)"
  pass cited-ref-is-not-done
}

# --- 13-20. --stale: does the path (and line) a follow-up cites still exist at the base ref? ----
# The missing column: on 2026-11-23 the intake held 54 open lines and 25 cited a merged ref, yet
# the three open lines checked by hand that evening were all already delivered. A citation is a
# hint; only "the cited path is gone at origin/main" is the actionable column.

# fixture_repo — a throwaway repo whose base commit holds ui/src/keep.ts (3 known lines) and
# ui/src/deleted.ts; sets R and BASE. Reused (and mutated) by the stale cases, never by the
# SHA cases above.
fixture_repo() {
  R="$T/fixture"
  if [ ! -d "$R/.git" ]; then
    git init -q "$R" || fail "fixture: git init"
    git -C "$R" config user.email owner@example.com
    git -C "$R" config user.name Fixture
    git -C "$R" config commit.gpgsign false
    mkdir -p "$R/ui/src"
    printf 'alpha\nbravo\ncharlie\n' > "$R/ui/src/keep.ts"
    printf 'gone later\n' > "$R/ui/src/deleted.ts"
    git -C "$R" add -A
    git -C "$R" commit -qm base
  fi
  BASE="$(git -C "$R" rev-parse --abbrev-ref HEAD)"
}

case_stale_path_gone_is_named() {
  want stale-path-gone-is-named || return 0
  reset
  fixture_repo
  fu '- [ ] broken since the #42 rewrite: ui/src/gone.ts'
  merged 42
  run --repo "$R" --base "$BASE" --stale
  [ "$rc" -eq 0 ] || fail "stale-path-gone-is-named: rc=$rc ($out; $(cat "$T/err.txt"))"
  printf '%s\n' "$out" | grep -q '^cited 1 ref=#42 merged=yes path=ui/src/gone.ts present=no at=- text=' \
    || fail "stale-path-gone-is-named: wrong row ($out)"
  pass stale-path-gone-is-named
}

case_stale_path_present_is_named() {
  want stale-path-present-is-named || return 0
  reset
  fixture_repo
  fu '- [ ] keep ui/src/keep.ts as the evidence'
  run --repo "$R" --base "$BASE" --stale
  [ "$rc" -eq 0 ] || fail "stale-path-present-is-named: rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'path=ui/src/keep.ts present=yes at=-' \
    || fail "stale-path-present-is-named: wrong row ($out)"
  pass stale-path-present-is-named
}

case_stale_line_beyond_eof_is_not_present() {
  want stale-line-beyond-eof-is-not-present || return 0
  reset
  fixture_repo
  fu '- [ ] past the end ui/src/keep.ts:999' '- [ ] the second line ui/src/keep.ts:2'
  run --repo "$R" --base "$BASE" --stale
  [ "$rc" -eq 0 ] || fail "stale-line-beyond-eof-is-not-present: rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'path=ui/src/keep.ts:999 present=no at=-' \
    || fail "stale-line-beyond-eof-is-not-present: past-EOF line not stale ($out)"
  printf '%s\n' "$out" | grep -q 'path=ui/src/keep.ts:2 present=yes at=bravo' \
    || fail "stale-line-beyond-eof-is-not-present: in-range line wrong ($out)"
  pass stale-line-beyond-eof-is-not-present
}

case_stale_reads_base_not_worktree() {
  want stale-reads-base-not-worktree || return 0
  reset
  fixture_repo
  printf 'worktree only\n' > "$R/ui/src/wt-only.ts"   # never committed
  rm -f "$R/ui/src/deleted.ts"                        # committed at base, deleted in the worktree
  fu '- [ ] untracked here ui/src/wt-only.ts' '- [ ] deleted here ui/src/deleted.ts'
  run --repo "$R" --base "$BASE" --stale
  [ "$rc" -eq 0 ] || fail "stale-reads-base-not-worktree: rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'path=ui/src/wt-only.ts present=no' \
    || fail "stale-reads-base-not-worktree: worktree file counted as present ($out)"
  printf '%s\n' "$out" | grep -q 'path=ui/src/deleted.ts present=yes' \
    || fail "stale-reads-base-not-worktree: base file counted as gone ($out)"
  pass stale-reads-base-not-worktree
}

case_stale_unknown_base_stays_unknown() {
  want stale-unknown-base-stays-unknown || return 0
  reset
  fixture_repo
  fu '- [ ] whatever ui/src/keep.ts:2'
  run --repo "$R" --base no-such-ref --stale
  [ "$rc" -eq 0 ] || fail "stale-unknown-base-stays-unknown: rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'present=unknown' \
    || fail "stale-unknown-base-stays-unknown: not unknown ($out)"
  [ -s "$T/err.txt" ] || fail "stale-unknown-base-stays-unknown: no stderr note"
  pass stale-unknown-base-stays-unknown
}

case_stale_bare_basename_and_url_are_unknown() {
  want stale-bare-basename-and-url-are-unknown || return 0
  reset
  fixture_repo
  fu '- [ ] see ActionSheet.tsx:92' '- [ ] see https://example.invalid/pull/42'
  run --repo "$R" --base "$BASE" --stale
  [ "$rc" -eq 0 ] || fail "stale-bare-basename-and-url-are-unknown: rc=$rc ($out)"
  [ "$(printf '%s\n' "$out" | grep -c 'path=- present=unknown')" = 2 ] \
    || fail "stale-bare-basename-and-url-are-unknown: a basename or URL was guessed ($out)"
  pass stale-bare-basename-and-url-are-unknown
}

case_stale_json_shape() {
  want stale-json-shape || return 0
  reset
  fixture_repo
  fu '- [ ] gone ui/src/gone.ts and #42' '- [ ] keep ui/src/keep.ts:2'
  merged 42
  run --repo "$R" --base "$BASE" --json --stale
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["open"] == 2 and d["cited"] == 1, d
assert d["stale"] == 1, d
p = d["items"][0]["paths"][0]
assert set(p) == {"token", "path", "cited_lines", "present", "at"}, p
assert p == {"token": "ui/src/gone.ts", "path": "ui/src/gone.ts",
             "cited_lines": [], "present": "no", "at": "-"}, p
q = d["items"][1]["paths"][0]
assert q == {"token": "ui/src/keep.ts:2", "path": "ui/src/keep.ts",
             "cited_lines": [2], "present": "yes", "at": "bravo"}, q
PY
  run --repo "$R" --base "$BASE" --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert "stale" not in d, d
assert all("paths" not in item for item in d["items"]), d["items"]
PY
  pass stale-json-shape
}

case_stale_status_unchanged_and_no_writes() {
  want stale-status-unchanged-and-no-writes || return 0
  reset
  fixture_repo
  fu '- [ ] gone ui/src/gone.ts' '- [ ] keep ui/src/keep.ts:2'
  merged 42
  run --status
  local plain="$out" before after
  before="$(sha256 "$S/followups.md")"
  run --status --stale
  [ "$out" = "$plain" ] || fail "stale-status-unchanged-and-no-writes: '$out' != '$plain'"
  run --repo "$R" --base "$BASE" --stale
  [ "$rc" -eq 0 ] || fail "stale-status-unchanged-and-no-writes: rc=$rc ($out)"
  after="$(sha256 "$S/followups.md")"
  [ "$before" = "$after" ] || fail "stale-status-unchanged-and-no-writes: followups.md changed"
  pass stale-status-unchanged-and-no-writes
}

for c in merged-pr-is-cited unmerged-pr-is-open ancestor-sha-is-cited non-ancestor-sha-is-open \
         unknown-sha-is-open checked-and-refless-lines-are-ignored file-is-not-modified \
         status-is-one-line missing-files-are-not-a-crash usage-error-exits-two \
         wiring-runs-the-suite cited-ref-is-not-done stale-path-gone-is-named \
         stale-path-present-is-named stale-line-beyond-eof-is-not-present \
         stale-reads-base-not-worktree stale-unknown-base-stays-unknown \
         stale-bare-basename-and-url-are-unknown stale-json-shape \
         stale-status-unchanged-and-no-writes; do
  "case_${c//-/_}"
done
echo "PASS all"
