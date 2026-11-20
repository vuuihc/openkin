#!/bin/bash
# test-merge-batch.sh — optimistic batch verification (R-batch-verify).
#
# When two or more PRs are independently ready (review PASS on their own diff, CI green, no hold),
# the loop may pay ONE gate on a union tree instead of one gate per PR, record per-slug markers,
# land the members in PR-number order, and prove each landing against the union's prefix tree.
# This suite pins the engine while `RSI_BATCH_VERIFY` is still 0: formation, union order, marker
# validity, carry-to-land, bisect attribution, and the kill switch. All hermetic: mktemp repos, a
# scratch bare remote, stubbed gate scripts, no network, no gh, no model.
#
# Exercises merge.sh --batch-plan-check / --batch-union-check / --batch-marker-check /
# --batch-prefix-check / --batch-bisect-check / --batch-invalidate-check, the existing
# --queue-carry-check (a batch marker must carry exactly like a gate), and gate.sh --only.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
MERGE="$RSI/runtime/merge.sh"
GATE="$RSI/runtime/gate.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
export GIT_AUTHOR_NAME=batch-test GIT_AUTHOR_EMAIL=batch@example.com
export GIT_COMMITTER_NAME=batch-test GIT_COMMITTER_EMAIL=batch@example.com
export GIT_TERMINAL_PROMPT=0
GIT=/usr/bin/git
mkdir -p "$T/ctrl/rsi"
cp -R "$RSI/runtime" "$T/ctrl/rsi/runtime"
mkdir -p "$T/ctrl/rsi/state"
export RSI_CTRL="$T/ctrl"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
g() { $GIT -C "$1" "${@:2}"; }

# mk_fixture <name> — bare remote + clone. `main` carries the two scripts the gate starts, so a
# real gate.sh run is hermetic: check.sh greps internal/*.go for "bad", the inventory stub passes.
mk_fixture() {
  local n="$1"
  $GIT init -q --bare "$T/$n.git" || fail "$n: bare init"
  $GIT init -q -b main "$T/$n" || fail "$n: init"
  $GIT -C "$T/$n" remote add origin "$T/$n.git"
  mkdir -p "$T/$n/scripts"
  cat > "$T/$n/scripts/check.sh" <<'SH'
#!/bin/bash
grep -Rqs bad --include='*.go' internal && exit 1
exit 0
SH
  chmod +x "$T/$n/scripts/check.sh"
  cat > "$T/$n/scripts/check-ui-inventory.py" <<'PY'
import sys
print("UI_INVENTORY_OK")
sys.exit(0)
PY
  echo base > "$T/$n/README.md"
  $GIT -C "$T/$n" add -A
  $GIT -C "$T/$n" commit -qm base
  $GIT -C "$T/$n" push -q origin main
}
# branch_with <repo> <branch> <path> <content> — branch off main, add one file, commit, push.
branch_with() {
  local repo="$1" br="$2" f="$3" c="$4"
  $GIT -C "$repo" checkout -q -B "$br" main || fail "$br: checkout"
  mkdir -p "$(dirname "$repo/$f")"
  printf '%s\n' "$c" > "$repo/$f"
  $GIT -C "$repo" add -A
  $GIT -C "$repo" commit -qm "$br"
  $GIT -C "$repo" push -q origin "$br"
  $GIT -C "$repo" rev-parse HEAD
}

# --- 1. only-partial-is-not-a-verdict ----------------------------------------------------------
case_only_partial_is_not_a_verdict() {
  mk_fixture only
  local repo="$T/only" head out rc
  head="$(branch_with "$repo" rsi/only internal/foo/a.go 'package foo')"
  $GIT -C "$repo" checkout -q rsi/only
  out="$(bash "$GATE" --only check "$repo" 2>&1)"; rc=$?
  [ $rc -eq 0 ] || fail "only-partial: filtered run rc=$rc ($out)"
  printf '%s\n' "$out" | grep -qx 'GATE_RESULT=PARTIAL' || fail "only-partial: no bare PARTIAL ($out)"
  printf '%s\n' "$out" | grep -qE '^GATE_RESULT=(PASS|FAIL)' && fail "only-partial: filtered run claimed a full verdict ($out)"
  # What the verifier does: only `^GATE_RESULT=PASS` is a verdict.
  printf '%s\n' "$out" | grep -q '^GATE_RESULT=PASS' && fail "only-partial: verifier would accept PARTIAL"
  # A normal run on the same tree is still PASS, and an unknown step runs nothing.
  out="$(bash "$GATE" "$repo" 2>&1)"; rc=$?
  [ $rc -eq 0 ] && printf '%s\n' "$out" | grep -qx 'GATE_RESULT=PASS' || fail "only-partial: normal gate not PASS ($out)"
  out="$(bash "$GATE" --only nosuchstep "$repo" 2>&1)"
  printf '%s\n' "$out" | grep -qx 'GATE_RESULT=PARTIAL' || fail "only-partial: unknown step did not stay PARTIAL ($out)"
  pass only-partial-is-not-a-verdict
}

# --- manifest helpers --------------------------------------------------------------------------
# row <n> <slug> <head> <dh> <tier> <ci> <flags> <paths...> — one manifest line + its paths file.
row() {
  local n="$1" slug="$2" head="$3" dh="$4" tier="$5" ci="$6" flags="$7"; shift 7
  mkdir -p "$T/changed" "$T/state/merge"
  printf '%s\n' "$@" > "$T/changed/$slug"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$slug" "$head" "$dh" "$tier" "$ci" "$flags" "$T/changed/$slug"
}
reviewed_pass() { printf '%s PASS %s reviewer\n' "$2" "$3" > "$T/state/merge/$1.reviewed"; }
plan() { RSI_BATCH_VERIFY="${RSI_BATCH_VERIFY:-1}" bash "$MERGE" --batch-plan-check "$T/manifest" "$T/state" "$(printf 'a%.0s' {1..40})" 2>/dev/null; }
plan_rc() { RSI_BATCH_VERIFY="${RSI_BATCH_VERIFY:-1}" bash "$MERGE" --batch-plan-check "$T/manifest" "$T/state" base >/dev/null 2>&1; echo $?; }

# --- 2. batch-formation-disjoint ---------------------------------------------------------------
case_batch_formation_disjoint() {
  local out rc
  # two disjoint internal packages, one medium + one small -> one batch in PR order
  rm -rf "$T/state"; mkdir -p "$T/state/merge"
  row 101 p1 aaaa1111 d1 medium green - internal/foo/a.go > "$T/manifest"
  row 102 p2 bbbb2222 d2 small green - internal/bar/b.go >> "$T/manifest"
  reviewed_pass p1 d1 aaaa1111; reviewed_pass p2 d2 bbbb2222
  out="$(plan)"; rc=$?
  [ $rc -eq 0 ] || fail "formation: ready pair did not batch ($out)"
  printf '%s\n' "$out" | head -1 | grep -q '^BATCH batch-' || fail "formation: no batch header ($out)"
  [ "$(printf '%s\n' "$out" | awk '$1=="MEMBER"{print $3}' | paste -sd, -)" = "p1,p2" ] \
    || fail "formation: members not in PR order ($out)"
  # overlapping path -> excluded, so one member is left -> no batch. The overlap is a docs file:
  # the main-move classifier drops docs paths, so only the path-level disjointness filter can
  # catch two members editing the same file (internal/foo/a.go would already be REGATE by package).
  row 101 p1 aaaa1111 d1 medium green - internal/foo/a.go docs/a.md > "$T/manifest"
  row 102 p2 bbbb2222 d2 small green - docs/a.md >> "$T/manifest"
  out="$(plan)"; rc=$?
  [ $rc -ne 0 ] && printf '%s\n' "$out" | grep -q '^SINGLE' || fail "formation: overlapping docs file batched ($out)"
  # shared/high-risk path -> excluded
  row 102 p2 bbbb2222 d2 small green - go.mod > "$T/manifest"
  out="$(plan)"; [ $? -ne 0 ] || fail "formation: go.mod joined a batch ($out)"
  # draft / hold / blocked / sendback / needs-ceo -> excluded
  local flag
  for flag in draft hold blocked sendback needs-ceo; do
    row 102 p2 bbbb2222 d2 small green "$flag" internal/bar/b.go > "$T/manifest"
    out="$(plan)"; [ $? -ne 0 ] || fail "formation: $flag joined a batch ($out)"
  done
  # red CI, red review -> excluded
  row 102 p2 bbbb2222 d2 small fail - internal/bar/b.go > "$T/manifest"
  out="$(plan)"; [ $? -ne 0 ] || fail "formation: red CI joined a batch ($out)"
  row 102 p2 bbbb2222 d2 small green - internal/bar/b.go > "$T/manifest"
  printf 'd2 FAIL bbbb2222 reviewer\n' > "$T/state/merge/p2.reviewed"
  out="$(plan)"; [ $? -ne 0 ] || fail "formation: red review joined a batch ($out)"
  reviewed_pass p2 d2 bbbb2222
  # a UX-walk path stays on the single path
  row 102 p2 bbbb2222 d2 small green - ui/src/App.tsx > "$T/manifest"
  out="$(plan)"; [ $? -ne 0 ] || fail "formation: UX-walk PR joined a batch ($out)"
  # two small docs-only PRs: union overhead is not worth it
  row 101 p1 aaaa1111 d1 small green - docs/a.md > "$T/manifest"
  row 102 p2 bbbb2222 d2 small green - docs/b.md >> "$T/manifest"
  out="$(plan)"; [ $? -ne 0 ] && printf '%s\n' "$out" | grep -q 'all-small' || fail "formation: two small docs batched ($out)"
  # a small + a medium of the same shape batches again (the control)
  row 101 p1 aaaa1111 d1 small green - docs/a.md > "$T/manifest"
  row 102 p2 bbbb2222 d2 medium green - internal/bar/b.go >> "$T/manifest"
  out="$(plan)" || fail "formation: small+medium did not batch ($out)"
  pass batch-formation-disjoint
}

# --- 3. union-tree-order -----------------------------------------------------------------------
case_union_tree_order() {
  mk_fixture union
  local bare="$T/union.git" work="$T/union" h1 h2 rec="$T/union.record" out rc
  h1="$(branch_with "$work" rsi/u1 internal/foo/a.go 'package foo')"
  h2="$(branch_with "$work" rsi/u2 internal/bar/b.go 'package bar')"
  local b1_before b2_before
  b1_before="$($GIT -C "$bare" rev-parse refs/heads/rsi/u1)"
  b2_before="$($GIT -C "$bare" rev-parse refs/heads/rsi/u2)"
  $GIT -C "$work" checkout -q main
  local clone="$T/union-clone"
  $GIT clone -q "$bare" "$clone"
  out="$(RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-union-check "$clone" "$($GIT -C "$clone" rev-parse origin/main)" "$rec" "$h1" "$h2" 2>&1)"; rc=$?
  [ $rc -eq 0 ] || fail "union: build failed rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q '^UNION ' || fail "union: no union tree ($out)"
  grep -qx "head 1 $h1" "$rec" || fail "union: head 1 not recorded"
  grep -qx "head 2 $h2" "$rec" || fail "union: head 2 not recorded"
  [ "$(awk '$1=="tree" && $2==1' "$rec" | wc -l | tr -d ' ')" = 1 ] || fail "union: prefix tree 1 missing"
  [ "$(awk '$1=="tree" && $2==2' "$rec" | wc -l | tr -d ' ')" = 1 ] || fail "union: prefix tree 2 missing"
  # both members' files are in the union worktree, and each prefix tree is the tree after that merge
  [ -f "$clone/internal/foo/a.go" ] && [ -f "$clone/internal/bar/b.go" ] || fail "union: members not merged"
  [ "$($GIT -C "$clone" rev-parse 'HEAD^{tree}')" = "$(awk '$1=="union"{print $2}' "$rec")" ] || fail "union: recorded union tree is not HEAD"
  [ "$($GIT -C "$clone" rev-parse "$h1^{tree}")" = "$(awk '$1=="tree" && $2==1' "$rec" | cut -d' ' -f3)" ] || fail "union: prefix 1 is not P1"
  # the PR branches were not written
  [ "$($GIT -C "$bare" rev-parse refs/heads/rsi/u1)" = "$b1_before" ] || fail "union: rsi/u1 moved"
  [ "$($GIT -C "$bare" rev-parse refs/heads/rsi/u2)" = "$b2_before" ] || fail "union: rsi/u2 moved"
  # order matters for prefixes but not for the union tree
  local rec2="$T/union2.record"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-union-check "$clone" "$($GIT -C "$clone" rev-parse origin/main)" "$rec2" "$h2" "$h1" >/dev/null 2>&1 \
    || fail "union: reversed build failed"
  [ "$(awk '$1=="union"{print $2}' "$rec2")" = "$(awk '$1=="union"{print $2}' "$rec")" ] || fail "union: union tree depends on order"
  [ "$(awk '$1=="tree" && $2==1' "$rec2" | cut -d' ' -f3)" = "$($GIT -C "$clone" rev-parse "$h2^{tree}")" ] || fail "union: reversed prefix 1 is not P2"
  # a real conflict outside web/dist/index.html aborts (rc 3) and never resolves
  local h3
  $GIT -C "$work" checkout -q -B rsi/u3 main
  mkdir -p "$work/internal/foo"
  printf 'package foo // conflicting\n' > "$work/internal/foo/a.go"
  $GIT -C "$work" add -A
  $GIT -C "$work" commit -qm u3; $GIT -C "$work" push -q origin rsi/u3
  h3="$($GIT -C "$work" rev-parse HEAD)"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-union-check "$clone" "$($GIT -C "$clone" rev-parse origin/main)" "$T/c.record" "$h1" "$h3" >/dev/null 2>&1
  [ $? -eq 3 ] || fail "union: a source conflict did not abort with rc 3"
  pass union-tree-order
}

# --- 4. marker-validity ------------------------------------------------------------------------
case_marker_validity() {
  local m="$T/state/merge/p1.batch" now
  now=$(date +%s)
  mkdir -p "$T/state/merge"
  {
    echo "batch b-1"; echo "index 1"; echo "base base1111"; echo "head head1111"
    echo "diffkey d1"; echo "tree tree1111"; echo "written $now"
  } > "$m"
  check_marker() { RSI_BATCH_VERIFY="${RSI_BATCH_VERIFY:-1}" bash "$MERGE" --batch-marker-check "$@"; }
  check_marker "$m" b-1 1 head1111 d1 "$now" > "$T/o" 2>&1 || fail "marker: valid marker rejected ($(cat "$T/o"))"
  grep -qx VALID "$T/o" || fail "marker: valid marker not VALID"
  check_marker "$m" b-1 1 head2222 d1 "$now" > "$T/o" 2>&1 && fail "marker: moved head accepted"
  grep -q 'head-moved' "$T/o" || fail "marker: moved head reason ($(cat "$T/o"))"
  check_marker "$m" b-1 1 head1111 d2 "$now" > "$T/o" 2>&1 && fail "marker: changed diffkey accepted"
  grep -q 'diffkey' "$T/o" || fail "marker: diffkey reason"
  check_marker "$m" b-1 2 head1111 d1 "$now" > "$T/o" 2>&1 && fail "marker: changed order accepted"
  grep -q 'order' "$T/o" || fail "marker: order reason"
  check_marker "$m" b-1 1 head1111 d1 "$((now + 10000))" > "$T/o" 2>&1 && fail "marker: expired marker accepted"
  grep -q 'expired' "$T/o" || fail "marker: expiry reason"
  check_marker "$m" b-1 1 head1111 d1 "$now" 5400 closed > "$T/o" 2>&1 && fail "marker: closed member accepted"
  grep -q 'member-closed' "$T/o" || fail "marker: closed reason"
  check_marker "$m" b-2 1 head1111 d1 "$now" > "$T/o" 2>&1 && fail "marker: another batch's marker accepted"
  grep -q 'other-batch' "$T/o" || fail "marker: other-batch reason"
  RSI_BATCH_VERIFY=0 bash "$MERGE" --batch-marker-check "$m" b-1 1 head1111 d1 "$now" > "$T/o" 2>&1 && fail "marker: accepted with the flag off"
  grep -q 'batch-disabled' "$T/o" || fail "marker: disabled reason"
  pass marker-validity
}

# --- 5. carry-to-land --------------------------------------------------------------------------
case_carry_to_land() {
  mk_fixture carry
  local repo="$T/carry" old new dh gate="$T/state/merge/p2.verified" rev="$T/state/merge/p2.reviewed"
  old="$(branch_with "$repo" rsi/p2 internal/foo/a.go 'package foo')"
  $GIT -C "$repo" checkout -q rsi/p2
  mkdir -p "$repo/internal/bar"; echo 'package bar' > "$repo/internal/bar/b.go"
  $GIT -C "$repo" add -A; $GIT -C "$repo" commit -qm merged-main
  new="$($GIT -C "$repo" rev-parse HEAD)"
  dh="$($GIT -C "$repo" diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16)"
  mkdir -p "$T/state/merge"
  printf '%s PASS batch\n' "$old" > "$gate"
  printf '%s PASS %s reviewer\n' "$dh" "$old" > "$rev"
  printf 'internal/foo/a.go\n' > "$T/changed-p2"
  printf 'internal/bar/b.go\n' > "$T/incoming-disjoint"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --queue-carry-check "$repo" "$old" "$new" "$T/incoming-disjoint" "$T/changed-p2" "$gate" "$rev" batch > "$T/o" 2>&1 \
    || fail "carry: disjoint main move did not carry ($(cat "$T/o"))"
  grep -q '^CARRY' "$T/o" || fail "carry: no CARRY ($(cat "$T/o"))"
  [ "$(cat "$gate")" = "$new PASS batch" ] || fail "carry: gate file not moved to the merged head ($(cat "$gate"))"
  [ "$(cut -d' ' -f1,2,3 "$rev")" = "$dh PASS $new" ] || fail "carry: review cache not moved ($(cat "$rev"))"
  # the member's own package moved -> REGATE and the marker is dropped
  printf '%s PASS batch\n' "$old" > "$gate"
  printf '%s PASS %s reviewer\n' "$dh" "$old" > "$rev"
  printf 'internal/foo/a.go\n' > "$T/incoming-own"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --queue-carry-check "$repo" "$old" "$new" "$T/incoming-own" "$T/changed-p2" "$gate" "$rev" batch > "$T/o" 2>&1 \
    && fail "carry: own package move carried"
  grep -q '^REGATE' "$T/o" || fail "carry: no REGATE ($(cat "$T/o"))"
  [ ! -e "$gate" ] || fail "carry: REGATE left the batch marker"
  # a shared surface moved -> REGATE (existing main_move_verdict shared set)
  printf 'internal/api/route.go\n' > "$T/incoming-shared"
  printf '%s PASS batch\n' "$old" > "$gate"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --queue-carry-check "$repo" "$old" "$new" "$T/incoming-shared" "$T/changed-p2" "$gate" "$rev" batch >/dev/null 2>&1 \
    && fail "carry: shared surface carried"
  # prefix-tree proof: a landed tree that differs only in web/dist/index.html still matches;
  # any other difference stops the batch. (This is the check that owns the verified tree.)
  $GIT -C "$repo" checkout -q -B pf main
  mkdir -p "$repo/web/dist"
  echo v1 > "$repo/web/dist/index.html"; echo one > "$repo/one.txt"
  $GIT -C "$repo" add -A; $GIT -C "$repo" commit -qm p1; local t1; t1="$($GIT -C "$repo" rev-parse 'HEAD^{tree}')"
  echo v2 > "$repo/web/dist/index.html"; $GIT -C "$repo" commit -qam dist2; local t2; t2="$($GIT -C "$repo" rev-parse 'HEAD^{tree}')"
  echo two > "$repo/two.txt"; $GIT -C "$repo" add -A; $GIT -C "$repo" commit -qm p2; local t3; t3="$($GIT -C "$repo" rev-parse 'HEAD^{tree}')"
  printf 'tree 1 %s\ntree 2 %s\n' "$t1" "$t3" > "$T/prefix.record"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-prefix-check "$repo" "$T/prefix.record" 1 "$t2" > "$T/o" 2>&1 \
    || fail "prefix: dist-only difference did not match ($(cat "$T/o"))"
  RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-prefix-check "$repo" "$T/prefix.record" 2 "$t2" > "$T/o" 2>&1 \
    && fail "prefix: a real tree difference matched"
  # invalidation removes batch markers and batch-written gate files, and nothing else
  mkdir -p "$T/state/merge"
  : > "$T/state/merge/p2.batch"; : > "$T/state/merge/p3.batch"
  printf 'h PASS batch\n' > "$T/state/merge/p2.verified"
  printf 'h PASS reviewer\n' > "$T/state/merge/p3.verified"
  bash "$MERGE" --batch-invalidate-check "$T/state" p2 p3 >/dev/null 2>&1
  [ ! -e "$T/state/merge/p2.batch" ] && [ ! -e "$T/state/merge/p3.batch" ] || fail "invalidate: marker survived"
  [ ! -e "$T/state/merge/p2.verified" ] || fail "invalidate: batch gate file survived"
  [ -e "$T/state/merge/p3.verified" ] || fail "invalidate: a reviewer gate file was removed"
  pass carry-to-land
}

# --- 6. bisect-attributes ----------------------------------------------------------------------
case_bisect_attributes() {
  mk_fixture bisect
  local repo="$T/bisect" h1 h2 h3 clone out
  h1="$(branch_with "$repo" rsi/b1 internal/one/a.go 'package one')"
  h2="$(branch_with "$repo" rsi/b2 internal/two/b.go 'package two // bad')"
  h3="$(branch_with "$repo" rsi/b3 internal/three/c.go 'package three')"
  $GIT -C "$repo" checkout -q main
  clone="$T/bisect-clone"; $GIT clone -q "$T/bisect.git" "$clone"
  out="$(RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-bisect-check "$clone" "$($GIT -C "$clone" rev-parse origin/main)" check "$h1" "$h2" "$h3" 2>&1)"
  [ "$(printf '%s\n' "$out" | grep -c '^CULPRIT')" = 1 ] || fail "bisect: expected one culprit ($out)"
  [ "$(printf '%s\n' "$out" | grep '^CULPRIT' | awk '{print $2}')" = "$h2" ] || fail "bisect: blamed the wrong member ($out)"
  # every singleton and the union pass -> no culprit is claimed
  $GIT -C "$repo" checkout -q -B rsi/b2clean rsi/b2
  echo 'package two' > "$repo/internal/two/b.go"
  $GIT -C "$repo" commit -qam clean; $GIT -C "$repo" push -q origin rsi/b2clean
  local h2c; h2c="$($GIT -C "$repo" rev-parse HEAD)"
  $GIT -C "$clone" fetch -q origin
  out="$(RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-bisect-check "$clone" "$($GIT -C "$clone" rev-parse origin/main)" check "$h1" "$h2c" "$h3" 2>&1)"
  [ "$(printf '%s\n' "$out" | grep -c '^CULPRIT')" = 0 ] || fail "bisect: blamed a member on a green union ($out)"
  printf '%s\n' "$out" | grep -q '^NONATTRIBUTABLE' || fail "bisect: no NONATTRIBUTABLE verdict ($out)"
  pass bisect-attributes
}

# --- 7. kill-switch ----------------------------------------------------------------------------
case_kill_switch() {
  local out rc
  rm -rf "$T/state"; mkdir -p "$T/state/merge"
  row 101 p1 aaaa1111 d1 medium green - internal/foo/a.go > "$T/manifest"
  row 102 p2 bbbb2222 d2 small green - internal/bar/b.go >> "$T/manifest"
  reviewed_pass p1 d1 aaaa1111; reviewed_pass p2 d2 bbbb2222
  out="$(RSI_BATCH_VERIFY=1 bash "$MERGE" --batch-plan-check "$T/manifest" "$T/state" base 2>/dev/null)"; rc=$?
  [ $rc -eq 0 ] || fail "kill-switch: the flag-on control did not batch ($out)"
  out="$(RSI_BATCH_VERIFY=0 bash "$MERGE" --batch-plan-check "$T/manifest" "$T/state" base 2>/dev/null)"; rc=$?
  [ $rc -ne 0 ] || fail "kill-switch: the planner batched with the flag off ($out)"
  [ "$out" = "SINGLE batch-disabled" ] || fail "kill-switch: unexpected flag-off output ($out)"
  # with the flag off no marker is valid, so no gate file can be written from a batch
  local m="$T/state/merge/p1.batch" now
  now=$(date +%s); printf 'batch b\nindex 1\nbase b\nhead h\ndiffkey d\ntree t\nwritten %s\n' "$now" > "$m"
  out="$(RSI_BATCH_VERIFY=0 bash "$MERGE" --batch-marker-check "$m" b 1 h d "$now" 2>&1)"
  [ "$out" = "INVALID batch-disabled" ] || fail "kill-switch: marker readable with the flag off ($out)"
  pass kill-switch
}

for c in only-partial-is-not-a-verdict batch-formation-disjoint union-tree-order marker-validity \
         carry-to-land bisect-attributes kill-switch; do
  want "$c" || continue
  "case_${c//-/_}"
done
exit 0
