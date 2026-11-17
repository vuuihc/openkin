#!/bin/bash
# common.sh restores a lost +x bit on rsi/runtime/*.sh.
#
# Why: the live control tree is patched in place, and a temp-file+mv edit drops the mode to
# 644. ux-gate.sh invokes dispatch.sh as a program, so the next UX review died on exit 126
# and came back "unavailable" while the code was fine (2026-11-17, #238). The fixture tree is
# a throwaway copy so this suite never depends on — or mutates — the real runtime dir.
#
#   bash rsi/runtime/tests/test-runtime-modes.sh    # wired in scripts/check.sh
set -u

here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/rsi-runtime-modes.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT INT TERM
mkdir -p "$tmp/rsi/runtime"
cp "$here/common.sh" "$tmp/rsi/runtime/common.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
mode_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null; }

# 1. A 644 runtime script becomes executable, and the heal is logged (silent healing would
#    hide the in-place edit that caused it).
printf '#!/bin/sh\ntrue\n' >"$tmp/rsi/runtime/lost-mode.sh"
chmod 644 "$tmp/rsi/runtime/lost-mode.sh"
out="$( . "$tmp/rsi/runtime/common.sh" 2>&1 )"
[ -x "$tmp/rsi/runtime/lost-mode.sh" ] || fail "common.sh left lost-mode.sh non-executable (mode $(mode_of "$tmp/rsi/runtime/lost-mode.sh"))"
case "$out" in
  *"restored +x on lost-mode.sh"*) ;;
  *) fail "no 'restored +x' line for lost-mode.sh: $out" ;;
esac

# 2. An executable script is left alone — no chmod, no second log line. A loop that touches
#    the mode on every run would churn mtimes for no reason and hide a real drift.
printf '#!/bin/sh\ntrue\n' >"$tmp/rsi/runtime/already-exec.sh"
chmod 755 "$tmp/rsi/runtime/already-exec.sh"
stamp() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
before="$(stamp "$tmp/rsi/runtime/already-exec.sh")"
sleep 1
out="$( . "$tmp/rsi/runtime/common.sh" 2>&1 )"
after="$(stamp "$tmp/rsi/runtime/already-exec.sh")"
[ -x "$tmp/rsi/runtime/already-exec.sh" ] || fail "already-executable script lost +x"
[ "$before" = "$after" ] || fail "common.sh touched the mode/mtime of an executable script"
case "$out" in
  *"restored +x"*) fail "logged a restore when everything was already executable: $out" ;;
esac

# 3. Only *.sh is healed: a data file in the same directory keeps its mode.
printf 'data\n' >"$tmp/rsi/runtime/notes.txt"
chmod 600 "$tmp/rsi/runtime/notes.txt"
( . "$tmp/rsi/runtime/common.sh" ) >/dev/null 2>&1
[ ! -x "$tmp/rsi/runtime/notes.txt" ] || fail "common.sh chmod'ed a non-shell file"

echo "runtime modes ok"
