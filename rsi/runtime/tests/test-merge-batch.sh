#!/bin/bash
# test-merge-batch.sh — optimistic batch verification (R-batch-verify).
#
# When two or more PRs are independently ready (review PASS on their own diff, CI green, no hold),
# the loop may pay ONE gate on a union tree instead of one gate per PR, record per-slug markers,
# land the members in PR-number order, and prove each landing against the union's prefix tree.
# This suite pins the engine (formation, union order, marker validity, carry-to-land, bisect,
# kill switch) AND the live half: merge.sh --batch (union gate once, PARTIAL is not a verdict,
# culprit-only sendback, non-attributable fallback, prefix-mismatch stop) and the dispatcher
# choice (batch on skips the singles; batch off starts exactly today's singles). All hermetic:
# mktemp repos, a scratch bare remote, stubbed gate scripts and a recorded --one, no network,
# no gh, no model.
#
# Exercises merge.sh --batch-plan-check / --batch-union-check / --batch-marker-check /
# --batch-prefix-check / --batch-bisect-check / --batch-invalidate-check / --batch, the
# dispatcher run itself (RSI_PR_LIST_CMD / RSI_START_LOG seams), the existing --queue-carry-check
# (a batch marker must carry exactly like a gate), and gate.sh --only.
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
  # the runner re-enters --one, so each member row carries its PR number
  [ "$(printf '%s\n' "$out" | awk '$1=="MEMBER"{print $7}' | paste -sd, -)" = "101,102" ] \
    || fail "formation: member rows lost their PR numbers ($out)"
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

# --- live-runner helpers ------------------------------------------------------------------------
# The live half is driven through merge.sh --batch with three test seams (RSI_BATCH_REPO,
# RSI_BATCH_ONE_CMD, RSI_PR_*_CMD) and a stub gate.sh/mutants.py-free fixture, so no gh, no model,
# no network. STATE is the copied control tree's state ($T/ctrl/rsi/state) because merge.sh derives
# it from RSI_CTRL (exported above).
LSTATE="$T/ctrl/rsi/state"
reset_ctrl() { # fresh runtime copy + empty state (a case that stubs gate.sh/outside-tests.py)
  rm -rf "$T/ctrl"; mkdir -p "$T/ctrl/rsi"
  cp -R "$RSI/runtime" "$T/ctrl/rsi/runtime"
  mkdir -p "$LSTATE/merge" "$LSTATE/sendback"
  rm -f "$T/gate.mode" "$T/gate.count" "$T/one.log"
}
stub_gate() { # <mode> — full runs count in $T/gate.count; --only is the bisect probe
  printf '%s\n' "$1" > "$T/gate.mode"
  cat > "$T/ctrl/rsi/runtime/gate.sh" <<'SH'
#!/bin/bash
ONLY=0
if [ "${1:-}" = "--only" ]; then ONLY=1; shift 2; fi
wt="$1"
mode="$(cat "$RSI_TEST_GATE_MODE" 2>/dev/null || echo pass)"
[ "$ONLY" -eq 0 ] && [ -n "${RSI_TEST_GATE_COUNT:-}" ] && echo x >> "$RSI_TEST_GATE_COUNT"
bad=0; grep -Rqs bad --include='*.go' "$wt/internal" 2>/dev/null && bad=1
both=0; [ -f "$wt/internal/one/a.go" ] && [ -f "$wt/internal/two/b.go" ] && both=1
case "$mode" in
  pass)    if [ "$ONLY" -eq 1 ]; then echo GATE_RESULT=PARTIAL; else echo GATE_RESULT=PASS; fi; exit 0 ;;
  partial) echo GATE_RESULT=PARTIAL; exit 0 ;;
  bad)     if [ "$bad" -eq 1 ]; then
             if [ "$ONLY" -eq 1 ]; then echo "GATE_RESULT=PARTIAL:check"; else echo "GATE_RESULT=FAIL: check"; fi; exit 1
           fi
           if [ "$ONLY" -eq 1 ]; then echo GATE_RESULT=PARTIAL; else echo GATE_RESULT=PASS; fi; exit 0 ;;
  nonattr) if [ "$both" -eq 1 ]; then
             if [ "$ONLY" -eq 1 ]; then echo "GATE_RESULT=PARTIAL:check"; else echo "GATE_RESULT=FAIL: check"; fi; exit 1
           fi
           if [ "$ONLY" -eq 1 ]; then echo GATE_RESULT=PARTIAL; else echo GATE_RESULT=PASS; fi; exit 0 ;;
  outside) if [ "$ONLY" -eq 1 ]; then echo GATE_RESULT=PARTIAL; exit 0; fi
           if [ "$(wc -l < "$RSI_TEST_GATE_COUNT")" -le 1 ]; then echo "GATE_RESULT=FAIL: check"; exit 1; fi
           echo GATE_RESULT=PASS; exit 0 ;;
  survivorfail)
           if [ "$ONLY" -eq 0 ]; then echo "GATE_RESULT=FAIL: check"; exit 1; fi
           if [ "$bad" -eq 1 ]; then echo "GATE_RESULT=PARTIAL:check"; exit 1; fi
           echo GATE_RESULT=PARTIAL; exit 0 ;;
esac
exit 1
SH
  chmod +x "$T/ctrl/rsi/runtime/gate.sh"
  printf 'import sys\nsys.exit(1)\n' > "$T/ctrl/rsi/runtime/outside-tests.py"
}
mk_runner_fixture() { # <name> — RF_REPO/RF_CLONE/RF_LAND/RF_BASE/RF_H1/RF_H2
  local n="$1"
  mk_fixture "$n"
  RF_REPO="$T/$n"
  RF_H1="$(branch_with "$RF_REPO" rsi/p1 internal/one/a.go 'package one')"
  RF_H2="$(branch_with "$RF_REPO" rsi/p2 internal/two/b.go 'package two // bad')"
  $GIT -C "$RF_REPO" checkout -q main
  RF_CLONE="$T/$n-runner"; $GIT clone -q "$T/$n.git" "$RF_CLONE"
  RF_LAND="$T/$n-land"; $GIT clone -q "$T/$n.git" "$RF_LAND"
  RF_BASE="$($GIT -C "$RF_CLONE" rev-parse origin/main)"
}
mk_one_stub() { # <land 0|1> <stray 0|1> — records "<n> <slug>", optionally lands it into origin/main
  local land="$1" stray="$2"
  cat > "$T/one-stub.sh" <<SH
#!/bin/bash
n="\$1"; slug="\$2"; head="\$3"
printf '%s %s\n' "\$n" "\$slug" >> "$T/one.log"
[ "$land" = 1 ] || exit 0
$GIT -C "$RF_LAND" checkout -q main || exit 1
$GIT -C "$RF_LAND" pull -q origin main || exit 1
$GIT -C "$RF_LAND" merge -q --no-edit "\$head" || exit 1
if [ "$stray" = 1 ] && [ "\$slug" = p1 ]; then
  echo stray > "$RF_LAND/stray.txt"; $GIT -C "$RF_LAND" add -A; $GIT -C "$RF_LAND" commit -qm stray || exit 1
fi
$GIT -C "$RF_LAND" push -q origin main
SH
  chmod +x "$T/one-stub.sh"
  export RSI_BATCH_ONE_CMD="bash $T/one-stub.sh \"\$1\" \"\$2\" \"\$3\""
}
run_batch() { # <id> <members-file>
  RSI_BATCH_VERIFY="${RSI_BATCH_VERIFY:-1}" RSI_BATCH_REPO="$RF_CLONE" \
    RSI_PR_STATE_CMD='echo OPEN' RSI_PR_BODY_CMD='printf "RSI item: R-%s\n" "$2"' \
    bash "$MERGE" --batch "$1" "$2"
}
write_members() { # <file> <id> <base> <h1> <h2>
  printf 'BATCH %s %s\nMEMBER 1\tp1\t%s\td1\tmedium\t101\nMEMBER 2\tp2\t%s\td2\tsmall\t102\n' \
    "$2" "$3" "$4" "$5" > "$1"
}

# --- 8. live-runner-gates-union-once ------------------------------------------------------------
case_live_runner_gates_union_once() {
  reset_ctrl; stub_gate pass; mk_runner_fixture once; mk_one_stub 1 0
  local mf="$T/once.members" out rc
  write_members "$mf" b-once "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(run_batch b-once "$mf" 2>&1)"; rc=$?
  [ $rc -eq 0 ] || fail "live-once: rc=$rc ($out)"
  [ "$(wc -l < "$T/gate.count" | tr -d ' ')" = 1 ] || fail "live-once: expected 1 full gate, got $(wc -l < "$T/gate.count") ($out)"
  grep -qx "head $RF_H1" "$LSTATE/merge/p1.batch" || fail "live-once: p1 marker missing or wrong head ($out)"
  grep -qx "head $RF_H2" "$LSTATE/merge/p2.batch" || fail "live-once: p2 marker missing or wrong head ($out)"
  [ "$(cut -d' ' -f1,2,3 "$LSTATE/merge/p1.verified")" = "$RF_H1 PASS batch" ] || fail "live-once: p1 gate file is not a batch PASS"
  [ "$(cut -d' ' -f1,2,3 "$LSTATE/merge/p2.verified")" = "$RF_H2 PASS batch" ] || fail "live-once: p2 gate file is not a batch PASS"
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1,102 p2," ] || fail "live-once: members did not land in PR-number order ($(cat "$T/one.log"))"
  pass live-runner-gates-union-once
}

# --- 9. live-runner-partial-is-not-a-verdict -----------------------------------------------------
case_live_runner_partial_is_not_a_verdict() {
  reset_ctrl; stub_gate partial; mk_runner_fixture partial; mk_one_stub 0 0
  local mf="$T/partial.members" out rc
  write_members "$mf" b-partial "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(run_batch b-partial "$mf" 2>&1)"; rc=$?
  [ $rc -ne 0 ] || fail "partial: PARTIAL was accepted as a verdict ($out)"
  [ ! -e "$LSTATE/merge/p1.batch" ] && [ ! -e "$LSTATE/merge/p2.batch" ] || fail "partial: a marker was written"
  [ ! -e "$LSTATE/merge/p1.verified" ] && [ ! -e "$LSTATE/merge/p2.verified" ] || fail "partial: a gate file was written"
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1,102 p2," ] || fail "partial: members did not fall back to single verification ($(cat "$T/one.log"))"
  [ "$($GIT -C "$RF_LAND" rev-parse origin/main)" = "$RF_BASE" ] || fail "partial: main moved"
  pass live-runner-partial-is-not-a-verdict
}

# --- 10. live-runner-fail-bisects-and-sends-back-culprit -----------------------------------------
case_live_runner_fail_bisects_and_sends_back_culprit() {
  reset_ctrl; stub_gate bad; mk_runner_fixture bad; mk_one_stub 1 0
  local mf="$T/bad.members" out rc
  write_members "$mf" b-bad "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(run_batch b-bad "$mf" 2>&1)"; rc=$?
  [ -e "$LSTATE/sendback/p2.md" ] || fail "bisect: the culprit got no sendback ($out)"
  grep -q "batch union gate failed: check" "$LSTATE/sendback/p2.md" || fail "bisect: sendback does not name the failed step"
  [ ! -e "$LSTATE/sendback/p1.md" ] || fail "bisect: an innocent member was sent back"
  [ ! -e "$LSTATE/merge/p2.batch" ] || fail "bisect: the culprit got a marker"
  grep -qx "head $RF_H1" "$LSTATE/merge/p1.batch" || fail "bisect: survivor marker missing ($out)"
  [ "$(wc -l < "$T/gate.count" | tr -d ' ')" = 2 ] || fail "bisect: survivors were not re-gated exactly once (full runs: $(wc -l < "$T/gate.count"))"
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1," ] || fail "bisect: only the survivor should land ($(cat "$T/one.log"))"
  pass live-runner-fail-bisects-and-sends-back-culprit
}

# --- 11. live-runner-nonattributable-falls-back-and-records --------------------------------------
case_live_runner_nonattributable_falls_back_and_records() {
  reset_ctrl; stub_gate nonattr; mk_runner_fixture nonattr; mk_one_stub 0 0
  local mf="$T/nonattr.members" out rc lines
  write_members "$mf" b-nonattr "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(run_batch b-nonattr "$mf" 2>&1)"; rc=$?
  [ $rc -ne 0 ] || fail "nonattr: rc=0"
  [ ! -e "$LSTATE/merge/p1.batch" ] && [ ! -e "$LSTATE/merge/p2.batch" ] || fail "nonattr: a marker survived"
  lines="$(grep -c 'batch b-nonattr:' "$LSTATE/needs-ceo.md" 2>/dev/null || true)"
  [ "${lines:-0}" = 1 ] || fail "nonattr: expected one needs-ceo line, got ${lines:-0} ($(cat "$LSTATE/needs-ceo.md" 2>/dev/null))"
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1,102 p2," ] || fail "nonattr: members did not fall back to single verification ($(cat "$T/one.log"))"
  pass live-runner-nonattributable-falls-back-and-records
}

# --- 12. live-runner-prefix-mismatch-stops-the-batch ---------------------------------------------
case_live_runner_prefix_mismatch_stops_the_batch() {
  reset_ctrl; stub_gate pass; mk_runner_fixture mismatch; mk_one_stub 1 1
  local mf="$T/mismatch.members" out rc
  write_members "$mf" b-mismatch "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(run_batch b-mismatch "$mf" 2>&1)"; rc=$?
  [ $rc -ne 0 ] || fail "mismatch: the batch continued past a landed tree that is not the gated prefix ($out)"
  [ ! -e "$LSTATE/merge/p2.batch" ] && [ ! -e "$LSTATE/merge/p2.verified" ] || fail "mismatch: the remaining member kept its marker"
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1," ] || fail "mismatch: a further --one started after the mismatch ($(cat "$T/one.log"))"
  grep -q 'batch b-mismatch:' "$LSTATE/needs-ceo.md" 2>/dev/null || fail "mismatch: no needs-ceo line"
  pass live-runner-prefix-mismatch-stops-the-batch
}

# --- 12b. live-runner-outside-retry-keeps-the-verdict -------------------------------------------
case_live_runner_outside_retry_keeps_the_verdict() {
  reset_ctrl; stub_gate outside
  # Outside-the-footprint failure only: the verifier's one flake rerun is allowed, and the second
  # run passes. Its log line must not ride in the captured verdict ($v) as a prefix to PASS.
  # outside_tests_only is defined below merge.sh's early --batch dispatch, so the child shell gets
  # the predicate from BASH_ENV rather than from the file's own later definition.
  printf 'outside_tests_only() { return 0; }\n' > "$T/outside-env.sh"
  mk_runner_fixture outside; mk_one_stub 1 0
  local mf="$T/outside.members" out rc
  write_members "$mf" b-outside "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(BASH_ENV="$T/outside-env.sh" run_batch b-outside "$mf" 2>&1)"; rc=$?
  [ $rc -eq 0 ] || fail "outside-retry: a passing rerun was read as no verdict ($out)"
  [ "$(wc -l < "$T/gate.count" | tr -d ' ')" = 2 ] || fail "outside-retry: expected the one flake rerun, full runs: $(wc -l < "$T/gate.count") ($out)"
  grep -qx "head $RF_H1" "$LSTATE/merge/p1.batch" || fail "outside-retry: p1 marker missing ($out)"
  grep -qx "head $RF_H2" "$LSTATE/merge/p2.batch" || fail "outside-retry: p2 marker missing ($out)"
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1,102 p2," ] || fail "outside-retry: members did not land ($(cat "$T/one.log"); $out)"
  pass live-runner-outside-retry-keeps-the-verdict
}

# --- 12c. live-runner-survivor-fallback-skips-the-culprit ----------------------------------------
case_live_runner_survivor_fallback_skips_the_culprit() {
  reset_ctrl; stub_gate survivorfail; mk_runner_fixture surv; mk_one_stub 0 0
  local mf="$T/surv.members" out rc
  write_members "$mf" b-surv "$RF_BASE" "$RF_H1" "$RF_H2"
  export RSI_TEST_GATE_MODE="$T/gate.mode" RSI_TEST_GATE_COUNT="$T/gate.count"
  out="$(run_batch b-surv "$mf" 2>&1)"; rc=$?
  [ $rc -ne 0 ] || fail "survivor-fallback: the batch claimed success ($out)"
  [ -e "$LSTATE/sendback/p2.md" ] || fail "survivor-fallback: the culprit got no sendback ($out)"
  # p2 was sent back on the union gate; the survivor fallback must not spend another --one on it.
  [ "$(tr '\n' ',' < "$T/one.log")" = "101 p1," ] || fail "survivor-fallback: the sent-back culprit was re-entered ($(cat "$T/one.log"); $out)"
  [ "$(wc -l < "$T/gate.count" | tr -d ' ')" = 2 ] || fail "survivor-fallback: expected union + survivors gates, got $(wc -l < "$T/gate.count") ($out)"
  pass live-runner-survivor-fallback-skips-the-culprit
}

# --- 13. dispatcher-forms-batch-and-skips-singles ------------------------------------------------
mk_dispatcher_fixture() { # reviewed PASS for p1/p2 + the PR list JSON the seam serves
  reset_ctrl
  printf 'd1 PASS h1 reviewer\n' > "$LSTATE/merge/p1.reviewed"
  printf 'd2 PASS h2 reviewer\n' > "$LSTATE/merge/p2.reviewed"
  cat > "$T/pr.json" <<'JSON'
[
 {"number":101,"headRefName":"rsi/p1","isDraft":false,"labels":[],"title":"feat: one","body":"RSI item: R-p1",
  "headRefOid":"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
  "statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}],
  "files":[{"path":"internal/one/a.go","additions":450,"deletions":0}]},
 {"number":102,"headRefName":"rsi/p2","isDraft":false,"labels":[],"title":"feat: two","body":"RSI item: R-p2",
  "headRefOid":"bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
  "statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}],
  "files":[{"path":"internal/two/b.go","additions":10,"deletions":0}]}
]
JSON
}
run_dispatch() { # <start-log> <batch 0|1>
  RSI_PR_LIST_CMD="cat $T/pr.json" RSI_START_LOG="$1" RSI_BATCH_VERIFY="$2" \
    RSI_PR_STATE_CMD='echo OPEN' bash "$MERGE" > "$T/dispatch.out" 2>&1
}
case_dispatcher_forms_batch_and_skips_singles() {
  mk_dispatcher_fixture
  local log="$T/start-batch.log"
  : > "$log"
  run_dispatch "$log" 1
  [ "$(grep -c '^batch ' "$log")" = 1 ] || fail "dispatch: no batch runner started ($(cat "$log"); $(tail -20 "$T/dispatch.out"))"
  [ "$(grep -c '^one ' "$log")" = 0 ] || fail "dispatch: singles started for batched slugs ($(cat "$log"))"
  grep -q '^batch batch-[0-9]*-[0-9]* p1 p2$' "$log" || fail "dispatch: unexpected batch start line ($(cat "$log"))"
  local members; members="$(ls "$LSTATE/merge"/batch-*.members 2>/dev/null | head -1)"
  [ -n "$members" ] || fail "dispatch: no members file"
  [ "$(grep -c '^MEMBER ' "$members")" = 2 ] || fail "dispatch: members file is not a 2-member plan ($(cat "$members"))"
  pass dispatcher-forms-batch-and-skips-singles
}

# --- 14. batch-off-is-today ----------------------------------------------------------------------
case_batch_off_is_today() {
  mk_dispatcher_fixture
  local log="$T/start-off.log"
  : > "$log"
  run_dispatch "$log" 0
  # Today's path, unchanged: dispatch_rows orders small-safe first, then longest-waiting, then
  # PR number, and the loop starts one --one verifier per eligible PR. No batch is formed and
  # none is recorded.
  [ "$(cat "$log")" = "one 102 p2
one 101 p1" ] || fail "off: start lines differ from today's singles ($(cat "$log"))"
  if ls "$LSTATE/merge"/batch-*.members >/dev/null 2>&1; then fail "off: a members file was written"; fi
  ! grep -q 'batch' "$T/dispatch.out" || fail "off: the batch path ran with the switch off"
  pass batch-off-is-today
}

for c in only-partial-is-not-a-verdict batch-formation-disjoint union-tree-order marker-validity \
         carry-to-land bisect-attributes kill-switch \
         live-runner-gates-union-once live-runner-partial-is-not-a-verdict \
         live-runner-fail-bisects-and-sends-back-culprit \
         live-runner-nonattributable-falls-back-and-records \
         live-runner-prefix-mismatch-stops-the-batch \
         live-runner-outside-retry-keeps-the-verdict \
         live-runner-survivor-fallback-skips-the-culprit \
         dispatcher-forms-batch-and-skips-singles batch-off-is-today; do
  want "$c" || continue
  "case_${c//-/_}"
done
exit 0
