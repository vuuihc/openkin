#!/bin/bash
# common.sh restores a lost +x bit on a runtime script that git records as executable.
#
# Why: the live control tree is patched in place, and a temp-file+mv edit drops the mode to
# 644. ux-gate.sh invokes dispatch.sh as a program, so the next UX review died on exit 126
# and came back "unavailable" while the code was fine (2026-11-17, #238). Only files git
# records as 100755 are healed — rsi/runtime/tests/*.sh and three top-level scripts are
# tracked 644 on purpose, and chmod-ing them would leave a mode-only modification that
# run.sh's control-tree fast-forward and gate.sh's "build left uncommitted changes" read as
# operator edits. The fixture is a throwaway git repo, so this suite never depends on — or
# mutates — the real runtime dir.
#
#   bash rsi/runtime/tests/test-runtime-modes.sh    # wired in scripts/check.sh
set -u
unset RSI_CTRL

here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/rsi-runtime-modes.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT INT TERM
repo="$tmp/repo"
mkdir -p "$repo/rsi/runtime"
cp "$here/common.sh" "$repo/rsi/runtime/common.sh"
git -C "$repo" init -q

fail() { echo "FAIL: $*" >&2; exit 1; }
mode_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null; }
stamp() { stat -f %c "$1" 2>/dev/null || stat -c %Z "$1" 2>/dev/null; }   # ctime: chmod bumps it, mtime does not

# 1. Tracked 100755, disk 644 (exactly what the in-place hotfix left behind): healed, logged.
printf '#!/bin/sh\ntrue\n' >"$repo/rsi/runtime/lost-mode.sh"
git -C "$repo" add rsi/runtime/lost-mode.sh
git -C "$repo" update-index --chmod=+x rsi/runtime/lost-mode.sh
chmod 644 "$repo/rsi/runtime/lost-mode.sh"
out="$( . "$repo/rsi/runtime/common.sh" 2>&1 )"
[ -x "$repo/rsi/runtime/lost-mode.sh" ] || fail "common.sh left lost-mode.sh non-executable (mode $(mode_of "$repo/rsi/runtime/lost-mode.sh"))"
case "$out" in
  *"restored +x on lost-mode.sh"*) ;;
  *) fail "no 'restored +x' line for lost-mode.sh: $out" ;;
esac

# 2. Tracked 100755, disk 755: left alone — no chmod, no second log line. A heal that rewrites
#    the mode on every run would churn metadata for no reason and hide a real drift.
printf '#!/bin/sh\ntrue\n' >"$repo/rsi/runtime/already-exec.sh"
git -C "$repo" add rsi/runtime/already-exec.sh
git -C "$repo" update-index --chmod=+x rsi/runtime/already-exec.sh
chmod 755 "$repo/rsi/runtime/already-exec.sh"
before="$(stamp "$repo/rsi/runtime/already-exec.sh")"
sleep 1
out="$( . "$repo/rsi/runtime/common.sh" 2>&1 )"
after="$(stamp "$repo/rsi/runtime/already-exec.sh")"
[ -x "$repo/rsi/runtime/already-exec.sh" ] || fail "already-executable script lost +x"
[ "$before" = "$after" ] || fail "common.sh changed the metadata of an executable script (a redundant chmod)"
case "$out" in
  *"restored +x"*) fail "logged a restore when everything was already executable: $out" ;;
esac

# 3. Tracked 644 on purpose (test suites and release.sh/node-stamp.sh are run via `bash`):
#    not healed. Healing them would leave mode-only dirt that the loop's dirty-tree guards
#    read as operator edits.
printf '#!/bin/sh\ntrue\n' >"$repo/rsi/runtime/tracked-not-exec.sh"
git -C "$repo" add rsi/runtime/tracked-not-exec.sh
chmod 644 "$repo/rsi/runtime/tracked-not-exec.sh"
out="$( . "$repo/rsi/runtime/common.sh" 2>&1 )"
[ "$(mode_of "$repo/rsi/runtime/tracked-not-exec.sh")" = 644 ] || fail "common.sh chmod-ed a script git records as 644"
case "$out" in
  *"tracked-not-exec.sh"*) fail "logged a restore for a 644-tracked script: $out" ;;
esac

# 4. A data file in the same directory keeps its mode.
printf 'data\n' >"$repo/rsi/runtime/notes.txt"
git -C "$repo" add rsi/runtime/notes.txt
chmod 600 "$repo/rsi/runtime/notes.txt"
( . "$repo/rsi/runtime/common.sh" ) >/dev/null 2>&1
[ "$(mode_of "$repo/rsi/runtime/notes.txt")" = 600 ] || fail "common.sh chmod-ed a non-shell file"

echo "runtime modes ok"
