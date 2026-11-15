#!/bin/bash
# node-stamp-test.sh — R-node-stamp: the one predicate for "this install matches its lockfile",
# and the three call sites that must repair before they compile.
#
#   bash rsi/runtime/tests/node-stamp-test.sh
#
# Self-contained: no network, no real npm (a stub is substituted through RSI_NPM), no model,
# no Chrome, no daemon. One `ok "name"` line per case; exits non-zero if any case fails.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RT="$(cd "$HERE/.." && pwd)"
fail=0
ok() { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

T="$(mktemp -d "${TMPDIR:-/tmp}/node-stamp-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT

if [ ! -f "$RT/node-stamp.sh" ]; then
  bad "rsi/runtime/node-stamp.sh is missing: the predicate every repair depends on does not exist"
  echo "node-stamp-test: FAILED"
  exit 1
fi
# shellcheck source=../node-stamp.sh
. "$RT/node-stamp.sh"

sha() { shasum -a 256 "$1/package-lock.json" | cut -d' ' -f1; }
fixture() { # <pkg-dir> — a package dir with a lockfile and an install directory
  mkdir -p "$1/node_modules/.bin"
  printf '{"name":"fixture","lockfileVersion":3}\n' > "$1/package-lock.json"
}
listing() { ( cd "$1" && find node_modules | sort | shasum -a 256 | cut -d' ' -f1 ); }

# --- the predicate -------------------------------------------------------------------------
mkdir -p "$T/absent"
printf '{"name":"fixture","lockfileVersion":3}\n' > "$T/absent/package-lock.json"
out="$(node_stamp_state "$T/absent")"
if [ "$out" = absent ]; then ok "absent when node_modules is missing"; else bad "absent when node_modules is missing (got '$out')"; fi

# A link to a perfectly valid install is still not ours: installing through it writes into
# another worktree, and reading it compiles against a tree this one does not own.
fixture "$T/donor2"
node_stamp_mark "$T/donor2"
mkdir -p "$T/link2"
printf '{"name":"fixture","lockfileVersion":3}\n' > "$T/link2/package-lock.json"
ln -s "$T/donor2/node_modules" "$T/link2/node_modules"
out="$(node_stamp_state "$T/link2")"
if [ "$out" = symlink ]; then ok "a symlink is never fresh"; else bad "a symlink is never fresh (got '$out')"; fi

fixture "$T/nomark3"
out="$(node_stamp_state "$T/nomark3")"
if [ "$out" = stale ]; then ok "a missing marker is stale"; else bad "a missing marker is stale (got '$out')"; fi

# One dependency bump rewrites package-lock.json; every install made before it is stale at once.
fixture "$T/moved4"
node_stamp_mark "$T/moved4"
before="$(node_stamp_state "$T/moved4")"
printf '{"name":"fixture","lockfileVersion":3,"packages":{"x":{}}}\n' > "$T/moved4/package-lock.json"
out="$(node_stamp_state "$T/moved4")"
if [ "$before" = fresh ] && [ "$out" = stale ]; then ok "a marker that no longer matches the lockfile is stale"; else bad "a marker that no longer matches the lockfile is stale (before '$before', after '$out')"; fi

fixture "$T/fresh5"
node_stamp_mark "$T/fresh5"
out="$(node_stamp_state "$T/fresh5")"
if [ "$out" = fresh ]; then ok "a matching marker is fresh"; else bad "a matching marker is fresh (got '$out')"; fi

fixture "$T/garbage"
printf 'not-a-sha\n' > "$T/garbage/node_modules/.kin-lock-sha"
out="$(node_stamp_state "$T/garbage")"
if [ "$out" = stale ]; then ok "garbage in the marker is stale"; else bad "garbage in the marker is stale (got '$out')"; fi

# The marker is the only write path; it must refuse a link rather than stamp another tree's install.
fixture "$T/donor9"
node_stamp_mark "$T/donor9"
mkdir -p "$T/marklink9"
printf '{"name":"fixture","lockfileVersion":3}\n' > "$T/marklink9/package-lock.json"
ln -s "$T/donor9/node_modules" "$T/marklink9/node_modules"
donor9_before="$(sha "$T/donor9")"
if ! node_stamp_mark "$T/marklink9" && [ "$(sha "$T/donor9")" = "$donor9_before" ]; then
  ok "mark refuses to write through a symlink"
else
  bad "mark refuses to write through a symlink"
fi

# --- the repair call sites -----------------------------------------------------------------
# A stub stands in for `npm ci`: it records its argv and performs the install in the current
# package dir, exactly where a real npm would run.
STUB="$T/npm-stub.sh"
cat > "$STUB" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$NODE_STAMP_STUB_LOG"
mkdir -p node_modules/.bin
shasum -a 256 package-lock.json | cut -d' ' -f1 > node_modules/.kin-lock-sha
STUB
chmod +x "$STUB"

# prep: a symlinked tree becomes a private install, and the old link target is not touched.
H6="$T/home6"; C6="$T/ctrl6"; WT6="$H6/.kin/worktrees/rsi-t"
mkdir -p "$WT6/ui" "$C6/rsi"
printf '{"name":"ui","lockfileVersion":3}\n' > "$WT6/ui/package-lock.json"
fixture "$T/donor6"
node_stamp_mark "$T/donor6"
ln -s "$T/donor6/node_modules" "$WT6/ui/node_modules"
donor_listing="$(listing "$T/donor6")"
donor_sha="$(sha "$T/donor6")"
LOG6="$T/npm6.log"
HOME="$H6" RSI_CTRL="$C6" RSI_NPM="$STUB" NODE_STAMP_STUB_LOG="$LOG6" \
  bash "$RT/prep-worktree.sh" "$WT6" > "$T/prep6.out" 2>&1
rc6=$?
calls6=0
[ -f "$LOG6" ] && calls6="$(wc -l < "$LOG6" | tr -d ' ')"
if [ $rc6 -eq 0 ] && [ ! -L "$WT6/ui/node_modules" ] && [ -d "$WT6/ui/node_modules" ] &&
  [ "$calls6" = 1 ] && grep -q '^ci' "$LOG6" 2>/dev/null &&
  [ "$(node_stamp_state "$WT6/ui")" = fresh ] &&
  [ "$(listing "$T/donor6")" = "$donor_listing" ] && [ "$(sha "$T/donor6")" = "$donor_sha" ]; then
  ok "prep replaces a symlink with a private install"
else
  bad "prep replaces a symlink with a private install (rc=$rc6 npm-calls=$calls6 state=$(node_stamp_state "$WT6/ui") donor-intact=$([ "$(listing "$T/donor6")" = "$donor_listing" ] && echo yes || echo no))"
fi

# prep: a fresh tree costs nothing — no install, no clone, no stamp rewrite.
H7="$T/home7"; C7="$T/ctrl7"; WT7="$H7/.kin/worktrees/rsi-t"
mkdir -p "$WT7/ui" "$C7/rsi"
printf '{"name":"ui","lockfileVersion":3}\n' > "$WT7/ui/package-lock.json"
mkdir -p "$WT7/ui/node_modules/.bin"
node_stamp_mark "$WT7/ui"
LOG7="$T/npm7.log"
HOME="$H7" RSI_CTRL="$C7" RSI_NPM="$STUB" NODE_STAMP_STUB_LOG="$LOG7" \
  bash "$RT/prep-worktree.sh" "$WT7" > "$T/prep7.out" 2>&1
rc7=$?
if [ $rc7 -eq 0 ] && [ ! -e "$LOG7" ] && [ "$(node_stamp_state "$WT7/ui")" = fresh ]; then
  ok "prep leaves a fresh tree alone"
else
  bad "prep leaves a fresh tree alone (rc=$rc7 npm-log=$([ -e "$LOG7" ] && echo present || echo absent) state=$(node_stamp_state "$WT7/ui"))"
fi

# The gate must repair before the first console compile, and the old `-d` test must be gone:
# `-d` followed a symlink and accepted a pre-lockfile install, so the repair never ran and
# tsc/vitest/build failed on a tree that was not the PR's fault.
repair="$(grep -n 'step node-stamp' "$RT/gate.sh" | head -1 | cut -d: -f1)"
check="$(grep -n 'step check ./scripts/check.sh' "$RT/gate.sh" | head -1 | cut -d: -f1)"
if [ -n "$repair" ] && [ -n "$check" ] && [ "$repair" -lt "$check" ] &&
  grep -q 'node_stamp_ensure ui' "$RT/gate.sh" &&
  ! grep -q -- '-d ui/node_modules' "$RT/gate.sh"; then
  ok "the gate repairs before the first compile"
else
  bad "the gate repairs before the first compile (repair line '${repair:-none}', step check line '${check:-none}', -d test survives: $(grep -c -- '-d ui/node_modules' "$RT/gate.sh"))"
fi

# merge.sh rebuilds web/dist/index.html in two places; each build used to sit behind a `-d`
# test, so a stale tree left the dist stale and the gate then failed the PR for stale-dist.
if grep -q 'node_stamp_ensure "$WT/ui"' "$RT/merge.sh" && grep -q 'node_stamp_ensure "$wt/ui"' "$RT/merge.sh" &&
  ! grep -q -- '-d "$WT/ui/node_modules"' "$RT/merge.sh"; then
  ok "merge repairs before both of its dist builds"
else
  bad "merge repairs before both of its dist builds"
fi

# --- syntax --------------------------------------------------------------------------------
syntax_bad=""
for f in "$RT/node-stamp.sh" "$RT/prep-worktree.sh" "$RT/gate.sh" "$RT/merge.sh" "$HERE/node-stamp-test.sh"; do
  bash -n "$f" || syntax_bad="$syntax_bad ${f##*/}"
done
if [ -z "$syntax_bad" ]; then ok "bash -n clean on every touched script"; else bad "bash -n failed:$syntax_bad"; fi

echo
if [ $fail -eq 0 ]; then echo "node-stamp-test: PASSED"; else echo "node-stamp-test: FAILED"; fi
exit $fail
