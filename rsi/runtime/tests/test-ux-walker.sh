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
# The console build is skipped only when web/dist is coherent: an index.html
# from one build can name a chunk that a second build replaced, and the walk
# then serves a blank console (Chromium 404s the entry chunk, every journey
# fails, the gate reds a PR for a reason that is not in the PR: measured
# 2026-11-18/19). The walk can build, so an inconsistent dist must build.
# ux-walker.mutants.json proves the selection, the slot and the dist
# consistency each go red when their line is reverted.
#
# A journey selection that names nothing must not walk nothing: `J9 J11` used
# to walk only J9 (the third positional won alone) and `--journeys J9,J99` used
# to filter the unknown id away and exit 0, so a green run could name a journey
# nobody walked. The selection cases pin the join, the --files meaning and the
# walker's named refusals, all before --base, playwright or Chrome. They also pin
# which changed paths can select a journey at all: generated dist, documentation
# and test files select none, so a UI PR no longer walks all 17 and dies at the
# walk bound, while an unmapped ui surface stays fail-closed to every journey.
#
# Hermetic: bash, python3 and coreutils in temp dirs; npm/go/node are booby
# traps (exit 97), so a seam that fell through to the build or walk path
# cannot pass — except in the build-decision cases, where npm records the
# expected build attempt and go stays a trap. Prints "ok: <case>" per case and
# exits non-zero on the first failure.
#
# The J13 desktop-bridge cases are the one deliberate use of the real node:
# they run walk.mjs --check-spec (spec parsing only — no browser, no daemon,
# no build) through the absolute path captured below, so the exported node
# booby trap still catches a bare call.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
UXWALK="$REPO/rsi/runtime/ux-walk.sh"
MANIFEST="$HERE/ux-walker.mutants.json"
REAL_NODE="$(type -P node || true)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

pass() { PASSED=$((PASSED+1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
PASSED=0
# The expected case count is named here, so a case that stops running (a
# deleted block, a stray early return) reds the suite instead of shrinking the
# summary: "31/31" was a literal that kept saying 31 after cases were added.
EXPECTED_CASES=42

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
# Staged before any case runs: heavy.sh creates $CTRL/rsi/state/heavy (line 8)
# and its EXIT trap removes only the slot dir, so the parent survives. Case 1
# below watches for that parent: a live slot dir would be gone by the time the
# seam returns, and could not tell a taking seam from a leak-free one.
cp "$REPO/rsi/runtime/heavy.sh" "$CTRL/rsi/runtime/heavy.sh"
chmod +x "$CTRL/rsi/runtime/heavy.sh"
SEAM="$CTRL/rsi/runtime/ux-walk.sh"

width() { wc -l < "$1" | tr -d ' '; }

# --- 1: the seam answers without building, starting a daemon or making OUT ------
case_name="test_walker_for_is_a_build_free_seam"
( npm ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "$case_name: the npm booby trap is not live"
WT1="$T/wt-build-free"; mkdir -p "$WT1"
OUT1="$T/never-created/out"
# Unset the ambient heavy vars so a seam that reached heavy.sh cannot be
# excused as re-entrant or fail-closed: case 1 must see the invocation itself.
out="$(env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY bash "$SEAM" --walker-for "$WT1" "$OUT1" 2>"$T/seam1.err")"
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
[ ! -d "$CTRL/rsi/state/heavy" ] \
  || fail "test_walker_for_takes_no_slot: the seam reached heavy.sh (its state dir exists)"
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

# --- 6-16: a selection names journeys it can honour, or it refuses --------------
# Two silent under-runs were possible on 2026-11-20: `ux-walk.sh "$PWD" "$OUT"
# J9 J11` read only the third positional and walked J9, and `--journeys
# J9,J99` filtered the unknown id away and exited 0 having walked only J9 (an
# all-unknown list walked nothing at all). Both printed a green result, so a
# screenshot or evidence claim naming a journey nobody ran was indistinguishable
# from a real one. The shell now builds one selection from every positional, and
# the walker refuses an id it cannot honour before --base, playwright or Chrome.
UXDIR="$REPO/rsi/runtime/ux"
select_walk() { # <--journeys LIST | --files PATH>: resolved ids, refusal on stderr
  "$REAL_NODE" "$UXDIR/walk.mjs" --select --spec "$UXDIR/journeys.json" "$@" 2>"$T/select.err"
}

case_name="walk_selects_two"
out="$(select_walk --journeys J9,J11)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
[ "$out" = "$(printf 'J9\nJ11')" ] \
  || fail "$case_name: printed '$(printf '%s' "$out" | tr '\n' ' ')', wanted J9 then J11"
[ ! -s "$T/select.err" ] || fail "$case_name: wrote to stderr: $(cat "$T/select.err")"
pass "$case_name"

case_name="walk_refuses_unknown_journey"
out="$(select_walk --journeys J9,J99)"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2"
[ -z "$out" ] || fail "$case_name: printed ids for a selection it cannot honour: $out"
[ "$(width "$T/select.err")" = 1 ] \
  || fail "$case_name: stderr is not one line: $(cat "$T/select.err")"
grep -q 'J99' "$T/select.err" \
  || fail "$case_name: the refusal does not name J99: $(cat "$T/select.err")"
grep -q 'known:' "$T/select.err" \
  || fail "$case_name: the refusal does not list the known ids: $(cat "$T/select.err")"
grep -q 'J9' "$T/select.err" && grep -q 'J14' "$T/select.err" \
  || fail "$case_name: the known-ids list looks truncated: $(cat "$T/select.err")"
pass "$case_name"

case_name="walk_refuses_empty_selection"
out="$(select_walk --journeys NOPE)"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2"
[ -z "$out" ] || fail "$case_name: printed ids for an unknown-only selection: $out"
# An empty changed-files list resolves to no journey either; walking zero while
# claiming a selection is the same silent under-run.
: > "$T/no-files.txt"
out="$(select_walk --files "$T/no-files.txt")"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: empty --files exited $rc, wanted 2"
[ -z "$out" ] || fail "$case_name: empty --files printed ids: $out"
pass "$case_name"

case_name="walk_select_default_is_all"
out="$(select_walk)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
want="$(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1], encoding="utf-8"))["journeys"]))' \
  "$UXDIR/journeys.json")"
[ "$out" = "$want" ] \
  || fail "$case_name: the default is no longer every journey in spec order: $out"
pass "$case_name"

# --- 13-16: files that cannot change the console select no journey -------------
# A UI PR commits web/dist/index.html (AGENTS.md, "UI conventions") and usually
# docs/product/IA.md. Neither is mapped in journeys.json, whose unmatched
# fallback is every journey, so one UI PR selected all 17 and the walk was killed
# at RSI_WALK_MAX_S with no verdict (measured on a UI PR whose diff carried both
# files: 17 selected, killed at the 1800 s bound at J13, and the 7 journeys the
# sessions row maps were thrown away). The rule mirrors ux-gate.sh's 1b0
# attribution pass: generated, test and documentation paths are not surfaces.
# An unmapped *ui* path stays fail-closed to every journey, and a copy-only
# locales diff keeps the journeys its paths row names — the noise predicate is
# not a second paths table.
#
# The fail-closed case runs first: the suite stops at the first failure, so each
# mutant in ux-walker.mutants.json reds the case it is named for.
case_name="select still walks every journey for an unmapped ui surface"
printf '%s\n' \
  'docs/product/IA.md' \
  'ui/src/components/sessions/ProjectRootsEditor.tsx' \
  'ui/src/components/sessions/SessionList.projectRoots.dom.test.tsx' \
  'ui/src/components/sessions/SessionList.projectRoots.mutants.json' \
  'ui/src/components/sessions/SessionList.tsx' \
  'web/dist/index.html' \
  'ui/src/components/brandnew/Widget.tsx' > "$T/pr626-plus-new.txt"
out="$(select_walk --files "$T/pr626-plus-new.txt")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
got="$(printf '%s\n' "$out" | sort | tr '\n' ' ')"
want="$(python3 -c 'import json,sys; print(" ".join(sorted(json.load(open(sys.argv[1], encoding="utf-8"))["journeys"])) + " ")' \
  "$UXDIR/journeys.json")"
[ "$got" = "$want" ] || fail "$case_name: got '$got', wanted every journey '$want'"
pass "$case_name"

case_name="select ignores generated, docs and test files"
printf '%s\n' \
  'docs/product/IA.md' \
  'ui/src/components/sessions/ProjectRootsEditor.tsx' \
  'ui/src/components/sessions/SessionList.projectRoots.dom.test.tsx' \
  'ui/src/components/sessions/SessionList.projectRoots.mutants.json' \
  'ui/src/components/sessions/SessionList.tsx' \
  'web/dist/index.html' > "$T/pr626.txt"
out="$(select_walk --files "$T/pr626.txt")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
got="$(printf '%s\n' "$out" | sort | tr '\n' ' ')"
[ "$got" = 'J1 J11 J12 J14 J2 J4 J5 J8 ' ] \
  || fail "$case_name: got '$got', wanted the sessions row's 8 journeys"
printf '%s\n' "$out" | grep -qx 'J13' \
  && fail "$case_name: J13 was selected although no file in the list can reach it"
printf '%s\n' "$out" | grep -qx 'J17' \
  && fail "$case_name: J17 was selected although no file in the list can reach it"
pass "$case_name"

case_name="a sessions change walks J4 with the list"
# J4's first step presses a project row's title on /sessions, and that row lives
# in ui/src/components/sessions/SessionList.tsx. Until 2026-11-23 the sessions
# row did not name J4, so #584's rewrite of that step met no walk at all: the PR
# walked J1 J2 J5 J8 J11 J12 J14 (measured, state/shots/delete-pagesb2b2) while
# J4/mac and J4/mac-wide were red on the same branch (86 lines each, the first a
# 3000 ms click timeout). A row that owns a journey must keep naming it, or the
# journey can be retired by an edit no gate walks.
printf 'ui/src/components/sessions/SessionList.tsx\n' > "$T/sessions-only.txt"
out="$(select_walk --files "$T/sessions-only.txt")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
printf '%s\n' "$out" | grep -qx 'J4' \
  || fail "$case_name: a sessions change selected no J4; the project row's own journey is unwalked"
# The phone list keeps its own row, so a mobile-only change must not pay for J4's
# desktop legs the way a sessions change does.
printf 'ui/src/components/mobile/MobileList.tsx\n' > "$T/mobile-only.txt"
out="$(select_walk --files "$T/mobile-only.txt")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
printf '%s\n' "$out" | grep -qx 'J4' \
  && fail "$case_name: a mobile-only change selected J4; the mobile row is meant to stay at 7"
pass "$case_name"

case_name="select keeps a copy-only locales change walking the map's journeys"
printf 'ui/src/i18n/locales/zh.ts\n' > "$T/locales-only.txt"
out="$(select_walk --files "$T/locales-only.txt")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
got="$(printf '%s\n' "$out" | sort | tr '\n' ' ')"
[ "$got" = 'J1 J10 J11 J12 J13 J14 J15 J16 J2 J3 J4 J5 J6 J7 J8 J9 ' ] \
  || fail "$case_name: got '$got', wanted the locales row's J1-J16"
printf '%s\n' "$out" | grep -qx 'J17' \
  && fail "$case_name: J17 came from the no-match fallback, not the locales row"
pass "$case_name"

case_name="select refuses a list of only non-console files"
printf 'docs/product/IA.md\nweb/dist/index.html\n' > "$T/noise-only.txt"
out="$(select_walk --files "$T/noise-only.txt")"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2"
[ -z "$out" ] || fail "$case_name: printed ids for a diff that cannot reach the console: $out"
[ "$(width "$T/select.err")" = 1 ] \
  || fail "$case_name: stderr is not one line: $(cat "$T/select.err")"
grep -q 'cannot change the console' "$T/select.err" \
  || fail "$case_name: the refusal does not name the reason: $(cat "$T/select.err")"
pass "$case_name"

case_name="walk_args_join_positionals"
out="$(bash "$SEAM" --select-args J9 J11 2>"$T/args.err")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/args.err"))"
[ "$out" = "--journeys J9,J11" ] \
  || fail "$case_name: got '$out', wanted every positional joined: --journeys J9,J11"
out="$(bash "$SEAM" --select-args "J9 J11" 2>>"$T/args.err")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: quoted list exited $rc ($(cat "$T/args.err"))"
[ "$out" = "--journeys J9,J11" ] \
  || fail "$case_name: quoted list got '$out', wanted --journeys J9,J11"
out="$(bash "$SEAM" --select-args 2>>"$T/args.err")"; rc=$?
[ $rc -eq 0 ] && [ -z "$out" ] \
  || fail "$case_name: no selection printed something and exited $rc: $out"
grep -q 'booby trap' "$T/args.err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

case_name="walk_args_refuse_two_files"
bash "$SEAM" --select-args @a.txt @b.txt >"$T/args2.out" 2>"$T/args2.err"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2"
[ ! -s "$T/args2.out" ] || fail "$case_name: printed to stdout: $(cat "$T/args2.out")"
[ "$(width "$T/args2.err")" = 1 ] || fail "$case_name: stderr is not one line: $(cat "$T/args2.err")"
grep -q 'usage:' "$T/args2.err" || fail "$case_name: no usage line: $(cat "$T/args2.err")"
grep -q 'booby trap' "$T/args2.err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

case_name="walk_args_single_at_file_unchanged"
out="$(bash "$SEAM" --select-args @a.txt 2>"$T/args3.err")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/args3.err"))"
[ "$out" = "--files a.txt" ] || fail "$case_name: got '$out', wanted --files a.txt"
pass "$case_name"

# --- build decision: a coherent dist is the only reason to skip the build -------
# A worktree carrying an index.html from one build and an assets/ directory
# from another serves a blank console. npm below is a recorder (exit 0), go a
# booby trap: the expected exit 2 at the go build proves npm ran first, keeps
# the case build-free, and never reaches node/the walker.
npm()  { : > "$NPM_REC"; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { : > "$NODE_REC"; exit 97; }
export -f npm go node

# <worktree> <chunk index.html names> <chunk actually on disk>
mkdist() {
  local wt="$1" named="$2" ondisk="$3"
  mkdir -p "$wt/ui" "$wt/web/dist/assets"
  printf '// chunk\n' > "$wt/web/dist/assets/$ondisk"
  printf '<!doctype html><script type="module" src="/assets/%s"></script>\n' "$named" \
    > "$wt/web/dist/index.html"
}

run_walk() { # <out-base> <worktree> <outdir>; no UX_KIN_BIN, stubs record what ran
  env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY -u UX_KIN_BIN \
    NPM_REC="$NPM_REC" NODE_REC="$NODE_REC" \
    bash "$SEAM" "$2" "$3" > "$1.out" 2>&1
}

case_name="test_stale_index_forces_a_build"
WT8="$T/wt-stale"; mkdist "$WT8" index-MISSING.js index-OTHER.js
OUT8="$T/out-stale"; NPM_REC="$T/stale.npm"; NODE_REC="$T/stale.node"
rm -f "$NPM_REC" "$NODE_REC"
run_walk "$T/stale" "$WT8" "$OUT8"
rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 ($(tail -c 300 "$T/stale.out"))"
[ -f "$NPM_REC" ] \
  || fail "$case_name: npm never ran; a stale index.html skipped the build"
grep -q 'go build failed' "$OUT8/UNAVAILABLE" 2>/dev/null \
  || fail "$case_name: did not stop at the go build ($(cat "$OUT8/UNAVAILABLE" 2>/dev/null))"
[ ! -f "$NODE_REC" ] || fail "$case_name: reached the walker"
pass "$case_name"

case_name="test_consistent_dist_skips_the_build"
WT9="$T/wt-consistent"; mkdist "$WT9" index-OTHER.js index-OTHER.js
OUT9="$T/out-consistent"; NPM_REC="$T/consistent.npm"; NODE_REC="$T/consistent.node"
rm -f "$NPM_REC" "$NODE_REC"
run_walk "$T/consistent" "$WT9" "$OUT9"
rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 at the go build ($(tail -c 300 "$T/consistent.out"))"
[ ! -f "$NPM_REC" ] \
  || fail "$case_name: npm ran although index.html names a chunk that exists"
[ ! -f "$NODE_REC" ] || fail "$case_name: reached the walker"
pass "$case_name"

case_name="test_missing_assets_forces_a_build"
WT10="$T/wt-no-assets"; mkdir -p "$WT10/ui" "$WT10/web/dist"
printf '<!doctype html>\n' > "$WT10/web/dist/index.html"
OUT10="$T/out-no-assets"; NPM_REC="$T/no-assets.npm"; NODE_REC="$T/no-assets.node"
rm -f "$NPM_REC" "$NODE_REC"
run_walk "$T/no-assets" "$WT10" "$OUT10"
rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 at the go build ($(tail -c 300 "$T/no-assets.out"))"
[ -f "$NPM_REC" ] || fail "$case_name: npm never ran without web/dist/assets"
[ ! -f "$NODE_REC" ] || fail "$case_name: reached the walker"
pass "$case_name"

case_name="test_dist_state_seam_is_build_free"
NPM_REC="$T/dist-state.npm"; NODE_REC="$T/dist-state.node"
rm -f "$NPM_REC" "$NODE_REC" "$T/never-dist-state"
out="$(env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY NPM_REC="$NPM_REC" NODE_REC="$NODE_REC" \
  bash "$SEAM" --dist-state "$WT8" "$T/never-dist-state/out" 2>"$T/dist-state.err")"
rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/dist-state.err"))"
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] \
  || fail "$case_name: printed more than one line: $out"
case "$out" in
  "build: "*) ;;
  *) fail "$case_name: stale dist answered '$out', wanted 'build: <why>'" ;;
esac
case "$out" in
  *index-MISSING.js*) ;;
  *) fail "$case_name: the reason does not name the missing chunk: $out" ;;
esac
[ ! -e "$T/never-dist-state" ] || fail "$case_name: created the output directory"
[ ! -f "$NPM_REC" ] && [ ! -f "$NODE_REC" ] || fail "$case_name: reached npm/node"
grep -q 'booby trap' "$T/dist-state.err" && fail "$case_name: reached a build/walk command"
[ ! -d "$CTRL/rsi/state/heavy" ] || fail "$case_name: reached heavy.sh"
out="$(env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY bash "$SEAM" --dist-state "$WT9" 2>"$T/dist-state2.err")"
[ "$out" = "skip" ] || fail "$case_name: coherent dist answered '$out', wanted skip"
# An index that cannot be read is not consistent: answer build, with the reason.
WT11="$T/wt-no-index"; mkdir -p "$WT11/web/dist/assets"
out="$(env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY bash "$SEAM" --dist-state "$WT11" 2>"$T/dist-state3.err")"
case "$out" in
  "build: "*index.html*) ;;
  *) fail "$case_name: missing index answered '$out', wanted build naming index.html" ;;
esac
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

# --- 7b: the real walk joins every positional, not only the third --------------
# The --select-args seam above calls select_args "$@" after shift, but the walk
# reads its own slice, "${@:3}". Every other real-path case passes two
# positionals at most, where "${3:-}" and "${@:3}" are identical, so reverting
# the walk to "${3:-}" (the original silent under-run: `J9 J11` walked only J9)
# stayed green. This case drives the real walk to the walker and records the
# argv the walker was handed.
case_name="test_real_walk_joins_every_positional"
WT12="$T/wt-join"; mkdir -p "$WT12"
# Case-local record/ready paths: KIN_STUB_READY and REC are exported above, so
# assigning them here would leak an already-existing ready marker into case 8
# and race its stub daemon.
OUT12="$T/out-join"; REC12="$T/walk-join.rec"; READY12="$T/walk-join.ready"
rm -f "$REC12" "$READY12"
node() { printf '%s\n' "$@" > "$REC"; }
export -f node
env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY UX_KIN_BIN="$STUB" REC="$REC12" KIN_STUB_READY="$READY12" \
  bash "$SEAM" "$WT12" "$OUT12" J9 J11 > "$T/walk-join.out" 2>&1
rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($(tail -c 300 "$T/walk-join.out"))"
[ -f "$REC12" ] || fail "$case_name: the walker never ran"
joined=" $(tr '\n' ' ' < "$REC12") "
case "$joined" in
  *" --journeys J9,J11 "*) ;;
  *) fail "$case_name: the walker got '$(tr '\n' ' ' < "$REC12")', wanted --journeys J9,J11" ;;
esac
pass "$case_name"

# --- 8: the daemon is told which claude to run, not merely pointed at it ------
# PATH order stopped being enough on 2026-11-19: with the fake first on PATH the
# throwaway daemon still answered /api/agents with ~/.local/bin/claude (a config
# under the real $HOME outranks PATH for this agent), so journeys_seed.py refused
# every conversation and the walk judged PR #366 against an empty daemon. A stub
# binary records the environment it was started with and exits, which proves the
# pin without a build, a browser or a model call.
case_name="test_fake_agent_is_pinned_for_the_daemon"
WTP="$T/wt-fake-pin"; mkdir -p "$WTP/scripts/journeys_fake_agent"
printf '#!/bin/sh\nexit 1\n' > "$WTP/scripts/journeys_fake_agent/claude"
chmod +x "$WTP/scripts/journeys_fake_agent/claude"
STUB="$T/kin-env-stub"; DUMP="$T/kin-env.txt"; rm -f "$DUMP"
printf '#!/bin/sh\nenv > "%s"\nexit 1\n' "$DUMP" > "$STUB"; chmod +x "$STUB"
OUTP="$T/out-fake-pin"; mkdir -p "$OUTP"
env -u RSI_HEAVY_HELD -u RSI_NO_HEAVY UX_KIN_BIN="$STUB" \
  bash "$SEAM" "$WTP" "$OUTP" >"$T/fake-pin.out" 2>&1
rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 when the stub daemon dies ($(tail -c 300 "$T/fake-pin.out"))"
[ -f "$DUMP" ] || fail "$case_name: the stub daemon never started"
grep -qx "KIN_CLAUDE_BIN=$WTP/scripts/journeys_fake_agent/claude" "$DUMP" \
  || fail "$case_name: the daemon was not told which claude to run (no pin in its environment)"
grep -q "^PATH=$WTP/scripts/journeys_fake_agent:" "$DUMP" \
  || fail "$case_name: the fake is no longer first on the daemon's PATH"
pass "$case_name"

# --- 9: the committed red proof still points at this selection ------------------
# scripts/mutants.py runs this script unmutated, then with entry.old replaced;
# the selection entry must go red in case 2, the slot entry in case 6, the pin
# entry in case 8. This case keeps the manifest from rotting into a pattern that
# no longer occurs (which would silently retire a proof).
case_name="test_mutant_manifest_changes_the_selection"
[ -f "$MANIFEST" ] || fail "$case_name: no rsi/runtime/tests/ux-walker.mutants.json"
python3 - "$MANIFEST" "$REPO" <<'PY' || exit 1
import json
import os
import sys

manifest, repo = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest, encoding="utf-8"))
if not isinstance(entries, list) or not entries:
    raise SystemExit("manifest must be a non-empty list of entries, got %r" % (entries,))
files = {}
for index, entry in enumerate(entries):
    if not isinstance(entry, dict):
        raise SystemExit("entry %d is not an object" % index)
    label = entry.get("label") or "entry %d" % index
    for key in ("label", "file", "old", "new", "test"):
        if not isinstance(entry.get(key), str) or not entry[key]:
            raise SystemExit("%s is missing a non-empty %r" % (label, key))
    target = entry["file"]
    if target not in ("rsi/runtime/ux-walk.sh", "rsi/runtime/ux/walk.mjs"):
        raise SystemExit("%s mutates %r, not the walker or its shell wrapper" % (label, target))
    if entry["old"] == entry["new"]:
        raise SystemExit("%s: `new` is identical to `old`; the mutant changes nothing" % label)
    if target not in files:
        files[target] = open(os.path.join(repo, target), encoding="utf-8").read()
    count = files[target].count(entry["old"])
    if count != 1:
        raise SystemExit("%s: `old` occurs %d times in %s, not once" % (label, count, target))
    if "test-ux-walker.sh" not in entry["test"]:
        raise SystemExit("%s: `test` does not run rsi/runtime/tests/test-ux-walker.sh" % label)
print("manifest ok: %d entries, each changes its file exactly once" % len(entries))
PY
[ $? -eq 0 ] || fail "$case_name: manifest check failed"
pass "$case_name"

# --- J15: the mid-run question leg has a seeded target and a resolver ------------
# No journey walked the question card at all: answer an option, answer the
# Other field, watch the card leave, reload and find the transcript still
# answered. The seed names the conversation and the first card, the resolver
# substitutes both into the spec through the same functions the walk uses, and
# a missing line is a skip — never a walk against an invented id (the J7 rule).
case_name="test_spec_ids_include_j15"
ids="$(python3 "$REPO/rsi/runtime/ux/spec.py" --ids "$REPO/rsi/runtime/ux/journeys.json" 2>"$T/ids.err")"
rc=$?
[ $rc -eq 0 ] || fail "$case_name: spec.py exited $rc ($(cat "$T/ids.err"))"
printf '%s\n' "$ids" | tr ' ' '\n' | grep -qx J15 \
  || fail "$case_name: J15 is not in the resolved ids: $ids"
case " $ids " in *" J14 "*) ;; *) fail "$case_name: the ids lost J14: $ids" ;; esac
pass "$case_name"

case_name="j15_resolver_skips_without_a_seed_line"
printf 'journeys seed: base http://127.0.0.1:1\n' > "$T/seed-no-j15.log"
out="$("$REAL_NODE" "$UXDIR/walk.mjs" --resolve-j15 "$T/seed-no-j15.log" 2>&1)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($out)"
[ "$out" = "J15 skip: no seeded question target" ] \
  || fail "$case_name: got '$out', wanted the skip line"
pass "$case_name"

case_name="j15_resolver_substitutes_the_conversation_and_card"
printf 'j15 target conversation=task-q focus=uq-1\n' > "$T/seed-j15.log"
out="$("$REAL_NODE" "$UXDIR/walk.mjs" --resolve-j15 "$T/seed-j15.log" 2>&1)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc ($out)"
[ "$out" = "J15 /tasks/task-q?focus=uq-1" ] \
  || fail "$case_name: got '$out', wanted the resolved URL"
plan="$("$REAL_NODE" "$UXDIR/walk.mjs" --resolve-j15-plan "$T/seed-j15.log" 2>&1)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: plan exit $rc ($plan)"
printf '%s' "$plan" > "$T/j15-plan.json"
python3 - "$T/j15-plan.json" <<'PY' || exit 1
import json
import sys

plan = json.load(open(sys.argv[1], encoding="utf-8"))
steps = plan.get("steps") or []
text = "\n".join(" ".join(str(part) for part in step) for step in steps)
if "{conversation}" in text or "{focus}" in text:
    raise SystemExit("the plan still carries a placeholder")
if ["goto", "/tasks/task-q?focus=uq-1"] not in steps:
    raise SystemExit("the plan has no resolved deep link")
if not any(step[0] == "gone" and "user-question-card" in str(step[1]) for step in steps):
    raise SystemExit("the plan never proves the card left")
if len([step for step in steps if step[0] == "goto" and step[1] == "/tasks/task-q"]) != 1:
    raise SystemExit("the plan does not reload the conversation exactly once")
PY
pass "$case_name"

# --- 10-13: J13's undrawable-file leg is walked, and only J13 gets a bridge ----
# The shipped "Open in…" control renders only behind Electron's
# `window.kinDesktop` (ui/src/components/workspace/OpenInMenu.tsx), and the
# walker is a plain browser. J13 therefore declares a journey-scoped
# `desktopBridge`; the walker installs it as an init script, deterministic and
# with no OS call. These cases pin the committed spec, the contract that
# refuses a spec without the leg or without the declaration, and that the
# bridge cannot leak into a journey that must stay a browser. Every fixture is
# a copy of the tree's own index and journey files, so all the other journeys'
# contracts still run against their real bodies.
[ -n "$REAL_NODE" ] || fail "the walker's --check-spec cases need node on PATH; none found"
UX="$REPO/rsi/runtime/ux"
spec_fixture() { # <dir>: the index plus every journey body, relative paths intact
  mkdir -p "$1"
  cp "$UX/journeys.json" "$1/journeys.json"
  cp -R "$UX/journeys" "$1/journeys"
}
check_spec() { # <spec>: the walker's spec contract, no browser and no daemon
  "$REAL_NODE" "$UX/walk.mjs" --check-spec --spec "$1" 2>&1
}

case_name="j13-binary-leg-present"
out="$(python3 - "$UX/journeys/J13.json" <<'PY' 2>&1
import json
import sys

journey = json.load(open(sys.argv[1], encoding="utf-8"))
steps = journey.get("steps") or []
text = lambda step: " ".join(str(part) for part in step)  # noqa: E731
gotos = [st for st in steps if st and st[0] == "goto" and "file=report.pdf" in text(st)]
if not gotos:
    raise SystemExit("J13 has no goto naming file=report.pdf")
trigger = [st for st in steps if st and st[0] == "click" and "aria-haspopup" in text(st)]
if not trigger:
    raise SystemExit("J13 never presses the open-in trigger")
menu = [st for st in steps if st and st[0] in ("wait", "count") and "role=menu" in text(st) and "menuitem" in text(st)]
if not menu:
    raise SystemExit("J13 never waits for a row inside the open-in menu")
apps = ((journey.get("desktopBridge") or {}).get("apps") or [])
if not apps:
    raise SystemExit("J13 declares no desktopBridge apps")
print("leg present: %d goto(s), %d trigger press(es), %d menu read(s), %d app(s)" % (len(gotos), len(trigger), len(menu), len(apps)))
PY
)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: the committed J13 spec is missing the leg: $out"
pass "$case_name"

case_name="j13-contract-refuses-without-leg"
V2="$T/spec-no-leg"; spec_fixture "$V2"
python3 - "$V2/journeys/J13.json" <<'PY' || exit 1
import json
import sys

path = sys.argv[1]
journey = json.load(open(path, encoding="utf-8"))
# The whole leg: its goto, the open-in press, the menu reads and the Escape.
marks = ("report.pdf", "aria-haspopup", "role=menu", "menuitem", "Escape")
journey["steps"] = [st for st in journey["steps"] if not any(m in " ".join(str(p) for p in st) for m in marks)]
json.dump(journey, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ $? -eq 0 ] || fail "$case_name: could not write the stripped fixture"
out="$(check_spec "$V2/journeys.json")"; rc=$?
[ $rc -ne 0 ] || fail "$case_name: --check-spec passed a J13 whose binary leg was stripped"
case "$out" in
  *report.pdf*) ;;
  *) fail "$case_name: the refusal does not name the missing leg: $out" ;;
esac
pass "$case_name"

case_name="desktop-bridge-scoped-to-j13"
V3="$T/spec-bridge-leak"; spec_fixture "$V3"
python3 - "$V3/journeys/J13.json" "$V3/journeys/J14.json" <<'PY' || exit 1
import json
import sys

j13_path, j14_path = sys.argv[1], sys.argv[2]
j13 = json.load(open(j13_path, encoding="utf-8"))
bridge = j13.pop("desktopBridge")
json.dump(j13, open(j13_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
j14 = json.load(open(j14_path, encoding="utf-8"))
j14["desktopBridge"] = bridge
json.dump(j14, open(j14_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ $? -eq 0 ] || fail "$case_name: could not write the leaked fixture"
out="$(check_spec "$V3/journeys.json")"; rc=$?
[ $rc -ne 0 ] || fail "$case_name: --check-spec passed a spec that moved the bridge onto J14"
case "$out" in
  *"J14 declares desktopBridge"*) ;;
  *) fail "$case_name: the refusal does not name the leaking journey: $out" ;;
esac
pass "$case_name"

case_name="bridge-not-installed-by-default"
V4="$T/spec-no-bridge"; spec_fixture "$V4"
python3 - "$V4/journeys/J13.json" <<'PY' || exit 1
import json
import sys

path = sys.argv[1]
journey = json.load(open(path, encoding="utf-8"))
journey.pop("desktopBridge", None)
json.dump(journey, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ $? -eq 0 ] || fail "$case_name: could not write the bridge-less fixture"
out="$(check_spec "$V4/journeys.json")"; rc=$?
[ $rc -ne 0 ] || fail "$case_name: --check-spec passed a J13 with no desktopBridge; the bridge could silently disappear"
case "$out" in
  *J13*desktopBridge*) ;;
  *) fail "$case_name: the refusal does not say J13 needs the bridge: $out" ;;
esac
# The requirement is J13's alone: the tree's own spec passes, and no other
# journey body declares a bridge. A journey without the option is a browser.
out="$(check_spec "$UX/journeys.json")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: the tree's own spec fails --check-spec: $out"
out="$(python3 - "$UX/journeys" <<'PY' 2>&1
import glob
import json
import os
import sys

root = sys.argv[1]
declared = sorted(
    os.path.basename(path)[:-5]
    for path in glob.glob(os.path.join(root, "*.json"))
    if "desktopBridge" in json.load(open(path, encoding="utf-8"))
)
if declared != ["J13"]:
    raise SystemExit("desktopBridge is declared by %s, wanted only J13" % (declared or "nobody"))
print("bridge scoped to J13")
PY
)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: $out"
pass "$case_name"

# --- 30-31: J3's hand-off sampler is not optional -------------------------
# The F1 sentence is about what the screen does *during* the route change, and
# the only evidence is a frame sampler started before Start and read before the
# `sent` shot. These cases pin the contract that refuses a J3 which never
# starts it, and one whose assert sits after the shot the mutant runner cuts
# at. Without them the sampler could be deleted and every gate would still
# pass: the message, the waiting row and the reply would all be photographed.
case_name="j3-contract-refuses-without-handoff-sampler"
V5="$T/spec-no-handoff-sampler"; spec_fixture "$V5"
python3 - "$V5/journeys/J3.json" <<'PY' || exit 1
import json
import sys

path = sys.argv[1]
journey = json.load(open(path, encoding="utf-8"))
journey["steps"] = [st for st in journey["steps"]
                    if not (isinstance(st, list) and st and st[0] in ("sample", "steady"))]
json.dump(journey, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ $? -eq 0 ] || fail "$case_name: could not write the stripped fixture"
out="$(check_spec "$V5/journeys.json")"; rc=$?
[ $rc -ne 0 ] || fail "$case_name: --check-spec passed a J3 with its hand-off sampler stripped"
case "$out" in
  *sample*Start*) ;;
  *) fail "$case_name: the refusal does not name the sampler started before Start: $out" ;;
esac
out="$(check_spec "$UX/journeys.json")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: the tree's own spec fails --check-spec: $out"
pass "$case_name"

case_name="j3-contract-refuses-handoff-sampler-after-the-cut"
V6="$T/spec-sampler-after-cut"; spec_fixture "$V6"
python3 - "$V6/journeys/J3.json" <<'PY' || exit 1
import json
import sys

path = sys.argv[1]
journey = json.load(open(path, encoding="utf-8"))
steps = journey["steps"]
steady = next((i for i, st in enumerate(steps)
               if isinstance(st, list) and st and st[0] == "steady"), None)
if steady is None:
    raise SystemExit("the tree's J3 has no steady step to move")
step = steps.pop(steady)
sent = next((i for i, st in enumerate(steps)
             if isinstance(st, list) and st[:2] == ["shot", "sent"]), None)
if sent is None:
    raise SystemExit("the tree's J3 has no sent shot")
steps.insert(sent + 1, step)
json.dump(journey, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ $? -eq 0 ] || fail "$case_name: could not write the moved fixture"
out="$(check_spec "$V6/journeys.json")"; rc=$?
[ $rc -ne 0 ] || fail "$case_name: --check-spec passed a J3 whose steady step sits after the sent shot"
case "$out" in
  *steady*sent*) ;;
  *) fail "$case_name: the refusal does not name the steady step and the sent shot: $out" ;;
esac
out="$(check_spec "$UX/journeys.json")"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: the tree's own spec fails --check-spec: $out"
pass "$case_name"

# --- a selected journey with no seeded target is "no verdict", never a pass ----
# When the seed produced no target for a selected journey (a pending approval,
# a running conversation, a notification card, a question), the walker used to
# record a synthetic `viewport: 'n/a'` screen and keep going, so walk.json's
# hardFail stayed empty and ux-gate.sh read a UX PASS whose evidence named a
# journey nobody walked. The verdict is now refused before Chrome: one
# UNAVAILABLE line per unwalked journey naming the journey and its reason, exit
# 2, so ux-gate.sh's UNAVAILABLE branch turns the walk into "no verdict".
# --seed-verdict is the build-free seam; the real-path case proves the same
# decision runs above the playwright require and the browser launch.
[ -n "$REAL_NODE" ] || fail "the seed-verdict cases need node on PATH; none found"
write_full_seed() { # <dir>: every seeded journey target the readers accept
  mkdir -p "$1"
  cat > "$1/seed.log" <<'SEED'
j1 targets approve conversation=task-approve focus=appr-1 deny conversation=task-deny focus=appr-2
j4 target project=proj-1
j5 target conversation=task-running title=Running
j7 target conversation=task-notify focus=appr-3 title=Notify
j15 target conversation=task-question focus=uq-1
SEED
}
seed_verdict() { # <out dir> [selection args...]
  local dir="$1"; shift
  "$REAL_NODE" "$UXDIR/walk.mjs" --seed-verdict --spec "$UXDIR/journeys.json" --out "$dir" "$@" 2>&1
}

case_name="seed-verdict-refuses-a-selected-journey-with-no-target"
SV1="$T/sv-no-j1"; mkdir -p "$SV1"
printf 'j5 target conversation=task-running title=Running\n' > "$SV1/seed.log"
out="$(seed_verdict "$SV1" --journeys J1)"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 ($out)"
[ -f "$SV1/UNAVAILABLE" ] || fail "$case_name: wrote no UNAVAILABLE"
grep -q 'J1' "$SV1/UNAVAILABLE" || fail "$case_name: UNAVAILABLE does not name J1: $(cat "$SV1/UNAVAILABLE")"
grep -q 'no seeded approval targets' "$SV1/UNAVAILABLE" \
  || fail "$case_name: UNAVAILABLE does not give the reader's reason: $(cat "$SV1/UNAVAILABLE")"
pass "$case_name"

case_name="seed-verdict-writes-one-line-per-unwalked-journey"
SV2="$T/sv-no-j1-j15"; mkdir -p "$SV2"
printf 'j5 target conversation=task-running title=Running\n' > "$SV2/seed.log"
out="$(seed_verdict "$SV2" --journeys J1,J15)"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 ($out)"
[ "$(grep -c '^selected journey ' "$SV2/UNAVAILABLE")" = 2 ] \
  || fail "$case_name: want one line per journey: $(cat "$SV2/UNAVAILABLE")"
grep -q '^selected journey J1 was never walked: ' "$SV2/UNAVAILABLE" \
  || fail "$case_name: the J1 line does not name J1"
grep -q '^selected journey J15 was never walked: ' "$SV2/UNAVAILABLE" \
  || fail "$case_name: the J15 line does not name J15"
grep '^selected journey J1 ' "$SV2/UNAVAILABLE" | grep -q J15 \
  && fail "$case_name: the J1 line names J15 too"
pass "$case_name"

case_name="seed-verdict-passes-a-complete-seed"
SV3="$T/sv-complete"; write_full_seed "$SV3"
out="$(seed_verdict "$SV3" --journeys J1,J4,J5,J7,J10,J13,J15)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc, wanted 0 ($out)"
case "$out" in
  *'seed-verdict: every selected journey target is present'*) ;;
  *) fail "$case_name: no green verdict line: $out" ;;
esac
[ ! -e "$SV3/UNAVAILABLE" ] || fail "$case_name: wrote UNAVAILABLE for a complete seed"
pass "$case_name"

case_name="seed-verdict-ignores-unselected-journeys"
SV4="$T/sv-unselected"; mkdir -p "$SV4"
printf 'j5 target conversation=task-running title=Running\n' > "$SV4/seed.log"
out="$(seed_verdict "$SV4" --journeys J9)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: exit $rc, wanted 0; an unselected journey was counted ($out)"
[ ! -e "$SV4/UNAVAILABLE" ] || fail "$case_name: refused an unselected journey's missing target"
pass "$case_name"

case_name="seed-verdict-runs-before-chrome"
SV5="$T/sv-before-chrome"; mkdir -p "$SV5"
printf 'j5 target conversation=task-running title=Running\n' > "$SV5/seed.log"
out="$("$REAL_NODE" "$UXDIR/walk.mjs" --spec "$UXDIR/journeys.json" --out "$SV5" --journeys J1 --base http://127.0.0.1:1 2>&1)"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 ($out)"
[ -f "$SV5/UNAVAILABLE" ] || fail "$case_name: wrote no UNAVAILABLE"
grep -q 'J1' "$SV5/UNAVAILABLE" || fail "$case_name: UNAVAILABLE does not name J1"
case "$out" in
  *'playwright-core missing'*|*'chrome launch failed'*)
    fail "$case_name: the verdict ran below the browser: $out" ;;
esac
pass "$case_name"

case_name="seed-verdict-keeps-j10-j13-on-j7-target"
SV6="$T/sv-notify-present"; write_full_seed "$SV6"
out="$(seed_verdict "$SV6" --journeys J7,J10,J13)"; rc=$?
[ $rc -eq 0 ] || fail "$case_name: a present J7 target did not cover J10/J13: $out"
[ ! -e "$SV6/UNAVAILABLE" ] || fail "$case_name: wrote UNAVAILABLE with the notification target present"
SV7="$T/sv-notify-missing"; mkdir -p "$SV7"
printf 'j5 target conversation=task-running title=Running\n' > "$SV7/seed.log"
out="$(seed_verdict "$SV7" --journeys J7,J10,J13)"; rc=$?
[ $rc -eq 2 ] || fail "$case_name: exit $rc, wanted 2 with no notification target ($out)"
[ "$(grep -c '^selected journey ' "$SV7/UNAVAILABLE")" = 3 ] \
  || fail "$case_name: J7, J10 and J13 each need a line: $(cat "$SV7/UNAVAILABLE")"
for j in J7 J10 J13; do
  grep -q "^selected journey $j was never walked: no seeded notification target$" "$SV7/UNAVAILABLE" \
    || fail "$case_name: the $j line is missing or wrong: $(cat "$SV7/UNAVAILABLE")"
done
pass "$case_name"

[ "$PASSED" -eq "$EXPECTED_CASES" ] \
  || fail "only $PASSED of $EXPECTED_CASES cases ran; a case was skipped or the count is stale"
echo "ux-walker contract: $PASSED/$EXPECTED_CASES cases passed"
