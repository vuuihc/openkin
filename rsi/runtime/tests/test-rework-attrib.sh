#!/bin/bash
# test-rework-attrib.sh — the rework ledger must count rounds the way the notes record them.
#
# 2026-11-21: to choose the next process guard the CEO grepped 18 sendback notes by hand, using
# `find -newermt` in the machine's local clock while the notes' timestamps are written in +08 —
# a 13-hour window reported as 24 hours, and a rework rate of 0.26 that is actually 0.66. The
# reading that decides which guard to build next cannot be hand arithmetic over free-form notes.
#
# rework-attrib.py reads what merge.sh already writes: the note header (`item:`, `attempt:`,
# `kind:`, `source:`) names who caught a round, the `## Fix list` table gives paths and
# severities, `state/merged.log` gives the denominator. A round is one distinct
# (item, attempt); a `*.stale-<sha>.md` file is a withheld sendback, never a round.
#
# Hermetic: mktemp state, fixture notes, no network, no repo writes. Prints "PASS <case>" per
# case. Set RSI_TEST_ONLY=<case> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
TOOL="$RSI/runtime/rework-attrib.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
S="$T/state"
NOW="2026-11-21T09:30:00"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

reset() { rm -rf "$S"; mkdir -p "$S/sendback/done"; : > "$S/merged.log"; }

# ago <file> <minutes> — backdate by minutes (utime, so no BSD/GNU `touch -d` split)
ago() {
  python3 -c 'import os,sys,time; t=time.time()-float(sys.argv[2])*60; os.utime(sys.argv[1],(t,t))' "$1" "$2"
}

# note <name> <minutes-ago> <item> <attempt> <source> [table rows...] — a note as merge.sh writes it
note() {
  local name="$1" age="$2" item="$3" attempt="$4" src="$5"; shift 5
  local f="$S/sendback/done/$name"
  {
    printf 'item: %s\nattempt: %s\nkind: targeted\nsource: %s\nspec: -\ncmd: bash gate.sh\n\n' \
      "$item" "$attempt" "$src"
    printf '# Sent back by the merge lane: independent review FAIL\n\n## Fix list\n\n'
    printf '| # | file:line | severity | issue | required change |\n|---|---|---|---|---|\n'
    local i=0
    for row in "$@"; do
      i=$((i + 1))
      printf '| %s | %s |\n' "$i" "$row"
    done
  } > "$f"
  ago "$f" "$age"
}

# merged <count> <minutes-ago-first> — merged.log lines, newest last, spread by a minute
merged() {
  local n="$1" age="$2" i
  for i in $(seq 1 "$n"); do
    python3 - "$S/merged.log" "$((age + n - i))" "$i" <<'PY'
import sys, datetime, pathlib
p, minutes, n = sys.argv[1], int(sys.argv[2]), sys.argv[3]
t = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes))
t = t.astimezone(datetime.timezone(datetime.timedelta(hours=8)))
line = f"{t:%Y-%m-%d %H:%M} PR #{500 + int(n)} slug item merged {'a' * 8} https://example.invalid/pr\n"
with open(p, "a", encoding="utf-8") as fh:
    fh.write(line)
PY
  done
}

run() {
  out="$(python3 "$TOOL" --state "$S" --now "$NOW" "$@" 2>&1)"; rc=$?
  printf '%s' "$out" > "$T/out.txt"
}

# --- 1. a round is one (item, attempt): a copied note is not a second round ---------------------
case_rounds_are_item_attempt_pairs() {
  want rounds-are-item-attempt-pairs || return 0
  reset; merged 4 3000
  note a.md 600 R-one 1 gate 'ui/src/a.test.tsx:12 | major | wrong assertion | fix it'
  note b.md 500 R-one 2 review 'ui/src/b.tsx:40 | major | missing test | add it'
  note c.md 400 R-one 2 review 'ui/src/b.tsx:40 | major | missing test | add it'   # CEO reconcile copy
  run --json
  [ "$rc" -eq 0 ] || fail "rounds: rc=$rc ($out)"
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["rounds"] == 2, f"want 2 rounds (1 + 2), got {d['rounds']}"
assert d["merges"] == 4, f"want 4 merges, got {d['merges']}"
PY
  pass rounds-are-item-attempt-pairs
}

# --- 2. a withheld sendback is not a round ------------------------------------------------------
case_stale_is_withheld_not_a_round() {
  want stale-is-withheld-not-a-round || return 0
  reset; merged 2 1000
  note a.md 600 R-one 1 review 'ui/src/a.tsx:12 | major | x | y'
  note b.stale-abc1234.md 500 R-one 1 review 'ui/src/a.tsx:12 | major | x | y'
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["rounds"] == 1, f"want 1 round, got {d['rounds']}"
assert d["stale"] == 1, f"want stale=1, got {d['stale']}"
PY
  pass stale-is-withheld-not-a-round
}

# --- 3. the header's source wins over the title prose -------------------------------------------
case_source_header_wins() {
  want source-header-wins || return 0
  reset; merged 2 1000
  note a.md 600 R-ux 1 ux-gate 'ui/src/x.tsx:9 | major | overlap | move it'
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["by_catcher"] == {"ux-gate": 1}, f"got {d['by_catcher']}"
assert d["shapes"][0]["shape"] == "ux-gate·ui", f"got {d['shapes']}"
PY
  pass source-header-wins
}

# --- 4. a note older than the header format still lands in the right bucket ---------------------
case_old_note_uses_title_and_prose() {
  want old-note-uses-title-and-prose || return 0
  reset; merged 2 1000
  cat > "$S/sendback/done/old.md" <<'MD'
# Sent back by the merge lane: gate failed: GATE_RESULT=FAIL: test

Go test failed in internal/task after the change.
MD
  ago "$S/sendback/done/old.md" 500
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["rounds"] == 1, f"got {d['rounds']}"
assert d["by_catcher"].get("gate") == 1, f"got {d['by_catcher']}"
assert d["by_family"].get("go") == 1, f"want family go from the prose, got {d['by_family']}"
PY
  pass old-note-uses-title-and-prose
}

# --- 5. the fix list decides family and severities ----------------------------------------------
case_fixlist_family_and_severity() {
  want fixlist-family-and-severity || return 0
  reset; merged 2 1000
  note a.md 600 R-mix 1 review \
    'ui/src/a.tsx:1 | blocker | breaks | fix' \
    'ui/src/b.tsx:2 | major | x | y' \
    'internal/api/c.go:3 | major | z | w'
  run --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["severity"] == {"blocker": 1, "major": 2}, f"got {d['severity']}"
assert d["by_family"] == {"ui": 1}, f"one round, its modal family=ui: {d['by_family']}"
assert d["shapes"][0]["blocker"] == 1 and d["shapes"][0]["major"] == 2, f"got {d['shapes'][0]}"
PY
  pass fixlist-family-and-severity
}

# --- 6. the window is a knob and the clock can be pinned ----------------------------------------
case_window_and_clock() {
  want window-and-clock || return 0
  reset; merged 3 100
  note fresh.md 60 R-new 1 review 'ui/src/a.tsx:1 | major | x | y'
  note old.md 6000 R-old 1 review 'ui/src/a.tsx:1 | major | x | y'     # ~4 days
  run --days 1 --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["rounds"] == 1, f"want only the fresh round, got {d['rounds']}"
assert d["days"] == 1, f"got days={d['days']}"
PY
  run --days 7 --json
  python3 - "$T/out.txt" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["rounds"] == 2, f"want both rounds in 7d, got {d['rounds']}"
PY
  pass window-and-clock
}

# --- 7. the status line is one line and carries the 24h direction -------------------------------
case_status_line() {
  want status-line || return 0
  reset; merged 4 600
  note a.md 60 R-a 1 review 'ui/src/a.tsx:1 | major | x | y'
  run --status
  [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] || fail "status: want one line ($out)"
  printf '%s' "$out" | grep -q 'rework 7d: 1 rounds / 4 merges (0.25)' || fail "status: wrong head ($out)"
  printf '%s' "$out" | grep -q 'top review·ui 1 (100%)' || fail "status: no top shape ($out)"
  run
  grep -q 'last 24h: 1 rounds / 4 merges' "$S/rework-attrib.md" || fail "md: no 24h line ($(sed -n '1,8p' "$S/rework-attrib.md"))"
  [ -s "$S/rework-attrib.json" ] || fail "md: no machine copy"
  pass status-line
}

# --- 8. an empty window is a number, not a crash -----------------------------------------------
case_empty_window() {
  want empty-window || return 0
  reset
  run --status
  [ "$rc" -eq 0 ] || fail "empty: rc=$rc ($out)"
  printf '%s' "$out" | grep -q 'no shapes' || fail "empty: want 'no shapes' ($out)"
  pass empty-window
}

# --- 9. it is wired: patrol prints it, fill reads it, check.sh runs this ------------------------
case_wired() {
  want wired || return 0
  grep -q 'rework-attrib.py' "$RSI/runtime/run.sh" || fail "wired: run.sh --status does not print the line"
  grep -q 'Then `{{STATE}}/rework-attrib.md`' "$RSI/runtime/prompts/fill.md" \
    || fail "wired: fill.md does not read the ledger in its read list"
  grep -q 'A mechanism row is derived from the rework ledger' "$RSI/runtime/prompts/fill.md" \
    || fail "wired: fill.md has no rule tying a mechanism row to the ledger"
  grep -q 'test-rework-attrib.sh' "$RSI/../scripts/check.sh" || fail "wired: scripts/check.sh does not run this suite"
  # And it actually renders: a throwaway control tree (its own runtime copy + state) prints the line.
  local ctrl="$T/ctrl"
  mkdir -p "$ctrl/rsi"; cp -R "$RSI/runtime" "$ctrl/rsi/runtime"
  mkdir -p "$ctrl/rsi/state/sendback/done"
  printf 'item: R-x\nattempt: 1\nkind: targeted\nsource: review\n\n| 1 | ui/src/a.tsx:1 | major | x | y |\n' \
    > "$ctrl/rsi/state/sendback/done/a.md"
  printf '2026-11-21 08:00 PR #1 s i merged aaaaaaaa u\n' > "$ctrl/rsi/state/merged.log"
  out="$(RSI_CTRL="$ctrl" bash "$ctrl/rsi/runtime/run.sh" --status 2>/dev/null | grep '^rework ')"
  printf '%s' "$out" | grep -q '^rework 7d: 1 rounds / 1 merges (1.00)' || fail "wired: run.sh printed '$out'"
  pass wired
}

for c in rounds-are-item-attempt-pairs stale-is-withheld-not-a-round source-header-wins \
         old-note-uses-title-and-prose fixlist-family-and-severity window-and-clock \
         status-line empty-window wired; do
  "case_${c//-/_}"
done
echo "PASS all"
