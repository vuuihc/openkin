#!/bin/bash
# test-utf8-truncation.sh — reviewer prompts must never be cut mid-character.
#
# `head -c N` slices bytes. A PR body or diff with CJK text can split a 3-byte
# character at the cut, and a prompt carrying invalid UTF-8 makes every tool
# call in the reviewer session fail ("HookArgsCommon.last_user_input contains
# invalid UTF-8"). The reviewer is then lost: the strong model falls back and
# every fallback returns a blocked sentinel, so a rework lane gets dispatched
# for a PR nobody actually reviewed. PR #238 hit this on 2026-11-17 23:21 (a
# 4997-byte mixed English/Chinese body cut at byte 3000); PR #208 hit it at
# 17:28 the same day.
#
# The fix at every prompt-truncation site is to keep only complete characters:
#   head -c N ... | iconv -f UTF-8 -t UTF-8 -c
# `iconv -c` discards the split character. On macOS it still exits 1 when it
# discarded something, which is harmless at the three call sites: none of them
# runs under `set -e`, so only the (valid) output matters.
#
# Case 1 is the control: it proves the fixture really does reproduce the bug and
# must keep passing after the fix. Case 4 is the source guard that keeps every
# truncation site sanitizing.
#
# Hermetic: python3 + iconv only, no network, no repo state. Prints
# "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
valid_utf8() { iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; }
nbytes() { wc -c < "$1" | tr -d ' '; }

# --- 1. the fixture reproduces the bug ---------------------------------------------------------
# 2999 ASCII bytes, then a 3-byte character: byte 3000 is that character's first byte alone.
python3 -c 'import sys; sys.stdout.write("a"*2999 + "默认设置")' > "$T/body.bin"
[ "$(nbytes "$T/body.bin")" -eq 3011 ] || fail "fixture-body: expected 3011 bytes, got $(nbytes "$T/body.bin")"
if head -c 3000 "$T/body.bin" | valid_utf8; then
  fail "fixture-splits-codepoint: head -c 3000 stayed valid UTF-8, so the fixture cannot reproduce the bug"
fi
pass "fixture-splits-codepoint"

# --- 2. the sanitized body is valid and still bounded ------------------------------------------
head -c 3000 "$T/body.bin" | iconv -f UTF-8 -t UTF-8 -c > "$T/body.cut" 2>/dev/null
valid_utf8 < "$T/body.cut" || fail "sanitized-body: iconv -c output is not valid UTF-8"
BODY_N="$(nbytes "$T/body.cut")"
[ "$BODY_N" -le 3000 ] || fail "sanitized-body: $BODY_N bytes exceeds the 3000-byte bound"
[ "$BODY_N" -eq 2999 ] || fail "sanitized-body: expected the 2999 complete bytes, got $BODY_N"
pass "sanitized-body-is-valid-utf8"

# --- 3. the same at the 250k diff boundary -----------------------------------------------------
python3 -c 'import sys; sys.stdout.write("a"*249999 + "默认" + "b"*100)' > "$T/diff.bin"
[ "$(nbytes "$T/diff.bin")" -gt 250000 ] || fail "fixture-diff: not larger than the 250000-byte limit"
if head -c 250000 "$T/diff.bin" | valid_utf8; then
  fail "fixture-splits-diff: head -c 250000 stayed valid UTF-8, so the fixture cannot reproduce the bug"
fi
pass "fixture-splits-diff-at-250k"

head -c 250000 "$T/diff.bin" | iconv -f UTF-8 -t UTF-8 -c > "$T/diff.cut" 2>/dev/null
valid_utf8 < "$T/diff.cut" || fail "sanitized-250k-diff: iconv -c output is not valid UTF-8"
DIFF_N="$(nbytes "$T/diff.cut")"
[ "$DIFF_N" -le 250000 ] || fail "sanitized-250k-diff: $DIFF_N bytes exceeds the 250000-byte bound"
[ "$DIFF_N" -eq 249999 ] || fail "sanitized-250k-diff: expected the 249999 complete bytes, got $DIFF_N"
pass "sanitized-250k-diff-is-valid-utf8"

# --- 4. every prompt truncation sanitizes ------------------------------------------------------
# Plain grep (BRE), where `|`, `(` and `)` are literal; each pattern is a substring of the real line.
guard() { # <file> <what> <pattern>
  local f="$ROOT/$1"
  [ -f "$f" ] || fail "every-prompt-truncation-sanitizes: missing $1"
  grep -q "$3" "$f" || fail "every-prompt-truncation-sanitizes: $1 truncates the $2 without iconv -c (want: $3)"
  echo "  ok $1: $2"
}
guard rsi/runtime/ux-gate.sh  "PR body for the UX reviewer" 'head -c 3000 | iconv -f UTF-8 -t UTF-8 -c'
guard rsi/runtime/merge.sh    "PR body for the reviewer"    'head -c 3500 | iconv -f UTF-8 -t UTF-8 -c'
guard rsi/runtime/dispatch.sh "diff over 250000 bytes"      'head -c 250000 .* | iconv -f UTF-8 -t UTF-8 -c'
pass "every-prompt-truncation-sanitizes"

echo "test-utf8-truncation: ALL-PASS"
