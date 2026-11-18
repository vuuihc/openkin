#!/bin/bash
# test-ux-walker.sh — the UX walker must come from the same tree as its spec.
#
# ux-walk.sh picks $WT/rsi/runtime/ux/walk.mjs and falls back to the control
# tree. #251 fixed that selection after the gate graded a branch's new spec
# with the control tree's older walker (unknown step op, unsubstituted
# placeholders), wrote a false sendback, and started a phantom rework round.
# This suite pins the fix: --walker-for answers without building, the worktree
# wins, the control tree is the fallback, and one function writes the answer
# for both the seam and the real walk. It also pins the walk's machine-wide
# heavy slot: the walker itself runs under heavy.sh, and RSI_NO_HEAVY makes the
# walk fail closed instead of competing with the gate's build (2026-11-18,
# three walks lost their scroll-restore race next to a parallel build).
# ux-walker.mutants.json proves the selection and the slot each go red when
# their line is reverted.
#
# Hermetic: bash, python3 and coreutils in temp dirs; npm/go/node are booby
# traps (exit 97), so a seam that fell through to the build or walk path
# cannot pass. Prints "ok: <case>" per case and exits non-zero on the first
# failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
UXWALK="$REPO/rsi/runtime/ux-walk.sh"
MANIFEST="$HERE/ux-walker.mutants.json"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# common.sh rewrites PATH, so an exported function is the only stub that
# survives into the child bash.
npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
export -f npm go node

# A temp copy of common.sh + ux-walk.sh under <tmp>/rsi/runtime is a
# self-contained control tree (common.sh derives RSI_CTRL from its own path).
CTRL="$T/ctrl"
mkdir -p "$CTRL/rsi/runtime"
cp "$REPO/rsi/runtime/common.sh" "$CTRL/rsi/runtime/common.sh"
cp "$UXWALK" "$CTRL/rsi/runtime/ux-walk.sh"
chmod +x "$CTRL/rsi/runtime/"*.sh   # no +x heal message from common.sh
# Staged before any case runs: a seam that acquired the heavy slot would create
# $CTRL/rsi/state/heavy/slot1, and case 1 below must be able to see it.
cp "$REPO/rsi/runtime/heavy.sh" "$CTRL/rsi/runtime/heavy.sh"
chmod +x "$CTRL/rsi/runtime/heavy.sh"
SEAM="$CTRL/rsi/runtime/ux-walk.sh"

width() { wc -l < "$1" | tr -d ' '; }

# --- 1: the seam answers without building, starting a daemon or making OUT ------
case_name="test_walker_for_is_a_build_free_seam"
( npm ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "$case_name: the npm booby trap is not live"
WT1="$T/wt-build-free"; mkdir -p "$WT1"
OUT1="$T/never-created/out"
out="$(bash "$SEAM" --walker-for "$WT1" "$OUT1" 2>"$T/seam1.err")"
rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/seam1.err"))"
[ -n "$out" ] || fail "$case_name: printed nothing"
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] \
  || fail "$case_name: printed more than one line: $out"
[ ! -e "$OUT1" ] && [ ! -e "$T/never-created" ] \
  || fail "$case_name: created the output directory"
[ -z "$(ls -A "$WT1")" ] || fail "$case_name: wrote into the worktree: $(ls -A "$WT1")"
grep -q 'booby trap' "$T/seam1.err" && fail "$case_name: reached a build/walk command"
pass "$case_name"
# The seam is the build-free answer a caller uses to inspect a branch; it must
# not take (or wait for) the machine-wide heavy slot either.
[ ! -d "$CTRL/rsi/state/heavy/slot1" ] \
  || fail "test_walker_for_takes_no_slot: the seam took the heavy slot"
pass "test_walker_for_takes_no_slot"

# --- 2: a worktree with its own walker wins (this is the #251 regression) --------
case_name="test_worktree_walker_wins"
WT2="$T/wt-with-walker"; mkdir -p "$WT2/rsi/runtime/ux"
printf '// fixture walker\n' > "$WT2/rsi/runtime/ux/walk.mjs"
out="$(bash "$SEAM" --walker-for "$WT2" 2>"$T/seam2.err")"
rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/seam2.err"))"
[ "$out" = "$WT2/rsi/runtime/ux/walk.mjs" ] \
  || fail "$case_name: got '$out', wanted the worktree's own walker"
[ -f "$out" ] && [ "$out" -ef "$WT2/rsi/runtime/ux/walk.mjs" ] \
  || fail "$case_name: '$out' is not the worktree's walk.mjs"
pass "$case_name"

# --- 3: a worktree without one falls back to the control tree -------------------
case_name="test_control_tree_fallback"
WT3="$T/wt-without-walker"; mkdir -p "$WT3"
out="$(bash "$SEAM" --walker-for "$WT3" 2>"$T/seam3.err")"
rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/seam3.err"))"
[ "$out" = "$CTRL/rsi/runtime/ux/walk.mjs" ] \
  || fail "$case_name: got '$out', wanted the control tree's walker"
pass "$case_name"

# --- 4: one writer — the seam and the real walk share walker_for -----------------
case_name="test_seam_and_walk_share_one_selector"
python3 - "$UXWALK" <<'PY' || exit 1
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
body = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
defs = re.findall(r"(?m)^walker_for\(\)\s*\{", body)
if len(defs) != 1:
    raise SystemExit("walker_for is defined %d times, not once" % len(defs))
calls = re.findall(r'(?m)(?<!^)walker_for "\$', body)
if len(calls) != 2:
    raise SystemExit("walker_for is called %d times, wanted the seam and the real walk"
                     % len(calls))
tests = re.findall(r"\[ -f [^\]]*walk\.mjs[^\]]*\]", body)
if len(tests) != 1:
    raise SystemExit("the walker selection is tested %d times, not once" % len(tests))
for duplicated in ('WALKER="$WT/rsi/runtime/ux/walk.mjs"', '$WT/rsi/runtime/ux/walk.mjs'):
    if duplicated in body:
        raise SystemExit("the real walk re-implements the selection: %s" % duplicated)
print("one writer: walker_for defined once, used by the seam and the walk")
PY
[ $? -eq 0 ] || fail "$case_name: the seam and the real walk do not share the selector"
pass "$case_name"

# --- 5: --walker-for without a worktree is a usage error, never a build ---------
case_name="test_walker_for_requires_a_worktree"
bash "$SEAM" --walker-for >"$T/seam5.out" 2>"$T/seam5.err"
rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2"
[ ! -s "$T/seam5.out" ] || fail "$case_name: printed to stdout: $(cat "$T/seam5.out")"
[ "$(width "$T/seam5.err")" = 1 ] || fail "$case_name: stderr is not one line: $(cat "$T/seam5.err")"
grep -q 'usage:' "$T/seam5.err" || fail "$case_name: no usage line: $(cat "$T/seam5.err")"
grep -q '<worktree>' "$T/seam5.err" || fail "$case_name: usage does not name the worktree"
grep -q 'booby trap' "$T/seam5.err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

# --- 6+7: the walk itself holds the machine-wide heavy slot ---------------------
# The walk is the heaviest single step in the gate (Chromium plus a live daemon
# for 5-10 minutes); under a parallel build the transcript loses its
# scroll-restore race (2026-11-18: J9/mac at 3471, J11/phone at 4983). The
# walker therefore runs through heavy.sh, and RSI_NO_HEAVY fails closed instead
# of walking next to the gate's own build.

# Stub daemon: writes the token ux-walk.sh reads, then sleeps until the walk's
# trap kills it. The ready marker lets the curl stub wait for that token rather
# than guessing a sleep, so a fast machine cannot read an empty token.
STUB="$T/stub-kin"
cat > "$STUB" <<'SH'
#!/bin/bash
mkdir -p "$KIN_STATE_DIR"
printf 'test-token\n' > "$KIN_STATE_DIR/token"
: > "$KIN_STUB_READY"
exec sleep 30
SH
chmod +x "$STUB"

# The health probe: wait briefly for the stub's token, then answer 200.
curl() {
  local i
  for i in $(seq 1 40); do [ -e "$KIN_STUB_READY" ] && break; sleep 0.05; done
  return 0
}
# Recording walker: report whether the heavy slot was held and its slot dir
# existed at the moment the walker ran.
node() {
  printf 'held=%s slot=%s\n' "${RSI_HEAVY_HELD:-none}" \
    "$([ -d "$CTRL/rsi/state/heavy/slot1" ] && echo yes || echo no)" > "$REC"
  exit 0
}
export CTRL REC KIN_STUB_READY
export -f curl node

case_name="test_walk_holds_the_machine_wide_slot"
WT6="$T/wt-walk"; mkdir -p "$WT6"
OUT6="$T/out-walk"; REC="$T/walk6.rec"; KIN_STUB_READY="$T/walk6.ready"
rm -f "$REC" "$KIN_STUB_READY"
env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY UX_KIN_BIN="$STUB" REC="$REC" KIN_STUB_READY="$KIN_STUB_READY" \
  bash "$SEAM" "$WT6" "$OUT6" > "$T/walk6.out" 2>&1
rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(tail -c 300 "$T/walk6.out"))"
[ -f "$REC" ] || fail "$case_name: the walker never ran"
got="$(cat "$REC")"
[ "$got" = "held=1 slot=yes" ] \
  || fail "$case_name: walker ran with '$got', wanted 'held=1 slot=yes' (it runs outside heavy.sh)"
[ ! -d "$CTRL/rsi/state/heavy/slot1" ] \
  || fail "$case_name: the heavy slot leaked after the walk"
pass "$case_name"

# RSI_NO_HEAVY=1 means "read code, do not build/test" (reviewers). A walk under
# it would compete with the gate's own build, so it must be unavailable (exit 2
# plus UNAVAILABLE), never green.
case_name="test_walk_refuses_to_run_without_the_slot"
WT7="$T/wt-nowalk"; mkdir -p "$WT7"
OUT7="$T/out-nowalk"; REC="$T/walk7.rec"; KIN_STUB_READY="$T/walk7.ready"
rm -f "$REC" "$KIN_STUB_READY"
env -u RSI_HEAVY_HELD RSI_NO_HEAVY=1 UX_KIN_BIN="$STUB" REC="$REC" KIN_STUB_READY="$KIN_STUB_READY" \
  bash "$SEAM" "$WT7" "$OUT7" > "$T/walk7.out" 2>&1
rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 ($(tail -c 300 "$T/walk7.out"))"
[ -f "$OUT7/UNAVAILABLE" ] || fail "$case_name: no UNAVAILABLE file"
grep -qi 'heavy slot\|machine-wide' "$OUT7/UNAVAILABLE" \
  || fail "$case_name: UNAVAILABLE does not name the heavy slot: $(cat "$OUT7/UNAVAILABLE")"
[ ! -f "$REC" ] || fail "$case_name: the walker ran under RSI_NO_HEAVY: $(cat "$REC")"
[ ! -d "$CTRL/rsi/state/heavy/slot1" ] \
  || fail "$case_name: a heavy slot was taken under RSI_NO_HEAVY"
pass "$case_name"

# --- 8: the committed red proof still points at this selection ------------------
# scripts/mutants.py runs this script unmutated, then with entry.old replaced;
# the selection entry must go red in case 2, the slot entry in case 6. This
# case keeps the manifest from rotting into a pattern that no longer occurs
# (which would silently retire a proof).
case_name="test_mutant_manifest_changes_the_selection"
[ -f "$MANIFEST" ] || fail "$case_name: no rsi/runtime/tests/ux-walker.mutants.json"
python3 - "$MANIFEST" "$UXWALK" <<'PY' || exit 1
import json
import sys

manifest, walk_sh = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest, encoding="utf-8"))
if not isinstance(entries, list) or not entries:
    raise SystemExit("manifest must be a non-empty list of entries, got %r" % (entries,))
text = open(walk_sh, encoding="utf-8").read()
for index, entry in enumerate(entries):
    if not isinstance(entry, dict):
        raise SystemExit("entry %d is not an object" % index)
    label = entry.get("label") or "entry %d" % index
    for key in ("label", "file", "old", "new", "test"):
        if not isinstance(entry.get(key), str) or not entry[key]:
            raise SystemExit("%s is missing a non-empty %r" % (label, key))
    if entry["file"] != "rsi/runtime/ux-walk.sh":
        raise SystemExit("%s mutates %r, not ux-walk.sh" % (label, entry["file"]))
    if entry["old"] == entry["new"]:
        raise SystemExit("%s: `new` is identical to `old`; the mutant changes nothing" % label)
    count = text.count(entry["old"])
    if count != 1:
        raise SystemExit("%s: `old` occurs %d times in ux-walk.sh, not once" % (label, count))
    if "test-ux-walker.sh" not in entry["test"]:
        raise SystemExit("%s: `test` does not run rsi/runtime/tests/test-ux-walker.sh" % label)
print("manifest ok: %d entries, each changes ux-walk.sh exactly once" % len(entries))
PY
[ $? -eq 0 ] || fail "$case_name: manifest check failed"
pass "$case_name"

echo "ux-walker contract: 9/9 cases passed"
