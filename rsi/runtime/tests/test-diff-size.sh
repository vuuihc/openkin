#!/bin/bash
# test-diff-size.sh — R-producer-checks part B: the 1000-line merge cap is measured ONCE
# (diff-size.sh) and enforced at the producers, not only inside merge.sh.
#
#   (a) diff-size.sh prints exactly merge.sh's old inline formula on the same tree — three-dot
#       numstat minus web/dist/index.html and *package-lock.json — and merge.sh now calls the
#       shared script instead of its own copy.
#   (b) lane.sh --diff-size-check (the seam the run path calls before the push) refuses an
#       oversize branch (rc!=0, "OVERSIZE <n>") unless the CEO waiver file merge.sh honours
#       (state/merge/<slug>.size-ok) stands.
#   (c) ingest-nas.sh's hold_oversize writes the same hold record the claim-check hold writes,
#       and the oversize gate sits before the publish push.
#
# Hermetic: mktemp repos, stub state dirs, no gh, no model. Set RSI_TEST_ONLY=<case> for one.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
DS="$RSI/runtime/diff-size.sh"
LANE="$RSI/runtime/lane.sh"
MERGE="$RSI/runtime/merge.sh"
INGEST="$RSI/runtime/nas/ingest-nas.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export RSI_STATE="$T/state"
GIT=/usr/bin/git
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
run() { if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi; "$1" || exit 1; pass "$1"; }

# mk_repo <dir> <added-lines> — `main` plus a `feat` commit appending N lines to a.go and
# rewriting web/dist/index.html (regenerated output the count must exclude).
mk_repo() {
  local d="$1" n="${2:-5}" i
  $GIT init -q -b main "$d" || fail "init $d"
  mkdir -p "$d/internal/x" "$d/web/dist"
  printf 'package x\n' > "$d/internal/x/a.go"
  echo v1 > "$d/web/dist/index.html"
  $GIT -C "$d" add -A && $GIT -C "$d" commit -qm base || fail "base commit"
  $GIT -C "$d" update-ref refs/remotes/origin/main HEAD
  $GIT -C "$d" checkout -q -b feat
  for i in $(seq "$n"); do echo "var v$i = $i" >> "$d/internal/x/a.go"; done
  echo v2 > "$d/web/dist/index.html"
  $GIT -C "$d" add -A && $GIT -C "$d" commit -qm feat || fail "feat commit"
}

test_diff_size_matches_merge_formula() {
  mk_repo "$T/r1" 7
  local want got
  want="$($GIT -C "$T/r1" diff --numstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | awk '{s+=$1+$2} END{print s+0}')"
  got="$(bash "$DS" "$T/r1")"
  [ "$got" = "$want" ] || fail "formula: diff-size.sh=$got, inline formula=$want"
  [ "$got" = 7 ] || fail "formula: expected 7 (web/dist/index.html excluded), got $got"
  # and merge.sh no longer carries its own copy of the formula
  grep -q 'runtime/diff-size.sh" "$WT"' "$MERGE" \
    || fail "merge: SIZE is not computed by diff-size.sh"
}

test_lane_oversize_refuses_without_waiver() {
  mk_repo "$T/r2" 1200
  local out rc
  out="$(bash "$LANE" --diff-size-check "$T/r2" "$T/no-waiver" 2>&1)"; rc=$?
  [ $rc -ne 0 ] || fail "lane: oversize branch accepted ($out)"
  case "$out" in *"OVERSIZE 1200"*) ;; *) fail "lane: verdict '$out', want OVERSIZE 1200";; esac
  : > "$T/waiver"
  out="$(bash "$LANE" --diff-size-check "$T/r2" "$T/waiver" 2>&1)"; rc=$?
  [ $rc -eq 0 ] || fail "lane: waived oversize refused ($out)"
  case "$out" in OK*) ;; *) fail "lane: waived verdict '$out', want OK";; esac
  # the run path calls the same seam before the push, not after it
  local size_ln push_ln
  size_ln="$(grep -n '"\$SELF" --diff-size-check' "$LANE" | head -1 | cut -d: -f1)"
  push_ln="$(grep -n 'git_push_retry' "$LANE" | tail -1 | cut -d: -f1)"
  [ -n "$size_ln" ] && [ -n "$push_ln" ] && [ "$size_ln" -lt "$push_ln" ] \
    || fail "lane wiring: oversize check (line $size_ln) is not before the push (line $push_ln)"
}

test_ingest_holds_oversize() {
  # The hold writer is the same shape as hold_claim: hold file + needs-ceo line, no publish.
  sed -n '/^hold_oversize()/,/^}/p' "$INGEST" > "$T/hold.sh"
  [ -s "$T/hold.sh" ] || fail "ingest: no hold_oversize function"
  mkdir -p "$T/j"; : > "$T/j/pr-body.md"
  (
    . "$T/hold.sh"
    STATE="$T/st"; CTRL="$T/ctrl"; GH_REPO="x/y"
    hold_oversize myslug R-test "$T/j" 1500 "" "branch push ok"
    [ -s "$STATE/nas/hold/myslug.md" ] || exit 1
    grep -q 'oversize' "$STATE/nas/hold/myslug.md" || exit 1
    grep -q 'held.*oversize' "$STATE/needs-ceo.md" || exit 1
  ) || fail "ingest: hold_oversize did not write the hold record"
  # the oversize gate runs before the publish push (the last $REF push in the loop body)
  local gate_ln pub_ln
  gate_ln="$(grep -n 'hold_oversize "' "$INGEST" | head -1 | cut -d: -f1)"
  pub_ln="$(grep -n 'push -q origin "$REF:refs/heads/$BR"' "$INGEST" | tail -1 | cut -d: -f1)"
  [ -n "$gate_ln" ] && [ -n "$pub_ln" ] && [ "$gate_ln" -lt "$pub_ln" ] \
    || fail "ingest wiring: oversize hold (line $gate_ln) is not before the publish push (line $pub_ln)"
  grep -q '"\$NAS_SIZE" -gt 1000' "$INGEST" \
    || fail "ingest: the gate does not pin the 1000-line cap"
}

run test_diff_size_matches_merge_formula
run test_lane_oversize_refuses_without_waiver
run test_ingest_holds_oversize
echo ALL-PASS
