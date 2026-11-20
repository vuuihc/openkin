#!/bin/bash
# test-smoke-assets.sh — the smoke gate must check the console entry chunk, not
# whichever /assets/*.js the document happens to name first.
#
# #482 injected boot-guard.js ahead of the entry chunk in <head>. scripts/smoke.sh
# then took `grep -oE ... | head -1`, which is /assets/boot-guard.js: with the
# 1.9 MB /assets/index-<hash>.js missing, the guard still answered 200 and the
# gate stayed green while a person got an empty shell. scripts/smoke-assets.sh
# owns the document parsing so this suite can pin it with text fixtures, no
# daemon and no build:
#
#   A. guard + entry, entry duplicated -> both paths once; the entry is found
#   B. guard only                     -> no entry: strict smoke must refuse
#   C. entry only                     -> the entry is found
#   D. the tracked web/dist/index.html -> an entry is found (the direct
#      regression for the `head -1` tree)
#
# Hermetic: reads fixtures and the tracked document; starts no daemon, runs no
# build. Prints "ok: <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
LIB="$REPO/scripts/smoke-assets.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# On a tree without the library this suite is red, not silently skipped: that
# is the state the gate exists to catch.
# shellcheck source=../../../scripts/smoke-assets.sh
# shellcheck disable=SC1090
source "$LIB" || fail "scripts/smoke-assets.sh is missing or unreadable"

# fixture <name> <script src>... — a built-console document naming these
# module scripts in order, with an inline style and a stylesheet around them so
# the extraction cannot pass by reading the whole document as one path.
fixture() {
  local name="$1" dir="$T/$1.html"; shift
  {
    printf '<!doctype html><html><head><style>.kin-boot{position:fixed}</style>\n'
    local src
    for src in "$@"; do
      printf '<script type="module" crossorigin src="%s"></script>\n' "$src"
    done
    printf '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">\n'
    printf '</head><body><div id="root"></div></body></html>\n'
  } > "$dir"
  printf '%s\n' "$dir"
}

# lines <text> — the non-empty lines of <text>, sorted, for order-free compare.
lines() {
  printf '%s\n' "$1" | grep -v '^$' | sort
}

# A. guard + entry, with the guard named twice.
a="$(fixture a /assets/boot-guard.js /assets/index-abc.js /assets/boot-guard.js)"
scripts="$(console_scripts "$(cat "$a")")"
want="/assets/boot-guard.js
/assets/index-abc.js"
[ "$(lines "$scripts")" = "$(lines "$want")" ] ||
  fail "A: console_scripts = [$scripts], want [$want]"
pass "A: console_scripts names the guard and the entry exactly once each"

entry="$(console_entry "$(cat "$a")")" || fail "A: console_entry exited nonzero with an entry present"
[ "$entry" = "/assets/index-abc.js" ] ||
  fail "A: console_entry = [$entry], want [/assets/index-abc.js]"
pass "A: console_entry finds /assets/index-abc.js"

# B. Only the guard. smoke.sh's strict block must fail on an empty entry even
# though the guard itself would answer 200.
b="$(fixture b /assets/boot-guard.js)"
entry="$(console_entry "$(cat "$b")")"; rc=$?
[ "$rc" -ne 0 ] || fail "B: console_entry exited 0 with no entry (strict smoke would pass)"
[ -z "$entry" ] || fail "B: console_entry = [$entry], want empty"
pass "B: guard alone yields no entry, so strict smoke fails"

# C. Only the entry.
c="$(fixture c /assets/index-abc.js)"
entry="$(console_entry "$(cat "$c")")" || fail "C: console_entry exited nonzero with only an entry"
[ "$entry" = "/assets/index-abc.js" ] ||
  fail "C: console_entry = [$entry], want [/assets/index-abc.js]"
pass "C: an entry-only document passes"

# D. The real document. This is the tree where `head -1` picked the guard, so a
# regression in either the build or the extraction shows up here.
dist="$REPO/web/dist/index.html"
[ -f "$dist" ] || fail "D: web/dist/index.html is missing"
entry="$(console_entry "$(cat "$dist")")" || fail "D: the tracked console document names no entry chunk"
case "$entry" in
  /assets/index-*.js) ;;
  *) fail "D: console_entry = [$entry], want /assets/index-*.js" ;;
esac
scripts="$(console_scripts "$(cat "$dist")")"
printf '%s\n' "$scripts" | grep -qxF "$entry" ||
  fail "D: console_scripts does not include the entry [$entry]: [$scripts]"
pass "D: tracked web/dist/index.html names an entry ($entry) and console_scripts lists it"

echo "test-smoke-assets: ALL-PASS"
