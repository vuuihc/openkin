#!/bin/bash
# scorecard.py: the weekly fold common.sh's scorecard_row() promises, plus the
# hand-counted retro as one command.
#
# The live scorecard is local loop state (rsi/state/scorecard.md), so every case
# builds a mktemp -d fixture whose rows use the exact format scorecard_row()
# writes: `| YYYY-MM-DD HH:MM | item | `worker` | `reviewer` | result | PR | FPY | note |`.
# No network, no model calls.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)"          # rsi/runtime
S="$H/scorecard.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }

[ -f "$S" ] || bad scorecard-py-missing

ts() { # days-ago -> "YYYY-MM-DD HH:MM"
  python3 - "$1" <<'PY'
import datetime, sys
d = float(sys.argv[1])
print((datetime.datetime.now() - datetime.timedelta(days=d)).strftime("%F %H:%M"))
PY
}

row() { # ts item result pr fpy
  printf '| %s | %s | `worker` | `reviewer` | %s | %s | %s | - |\n' "$1" "$2" "$3" "$4" "$5"
}

header() {
  printf '# Scorecard (fixture)\n\n'
  printf '| time (SGT) | item | worker model | reviewer | result | PR | FPY | antibody |\n'
  printf '|---|---|---|---|---|---|---|---|\n'
}

# Three rows inside a 7-day window, one outside it.
fixture_window() { # state-dir
  mkdir -p "$1"
  {
    header
    row "$(ts 0)" R-alpha "MERGED abc1234" "[#1](https://example.com/pull/1)" pass
    row "$(ts 2)" R-beta "MERGED def5678" "[#2](https://example.com/pull/2)" patched
    row "$(ts 3)" R-gamma "PR opened (12m, \$1.2129)" "[#3](https://example.com/pull/3)" pending
    row "$(ts 10)" R-old "MERGED 0ldc0de" "[#9](https://example.com/pull/9)" pass
    printf '\n## Weekly fold\n(empty)\n'
  } > "$1/scorecard.md"
}

# One row per outcome bucket, so every total is distinguishable.
fixture_report() { # state-dir
  mkdir -p "$1"
  {
    header
    row "$(ts 0)" R-alpha "MERGED abc1234" "[#1](https://example.com/pull/1)" pass
    row "$(ts 1)" R-beta "MERGED def5678" "[#2](https://example.com/pull/2)" patched
    row "$(ts 2)" R-gamma "no commits (rc=1, 40m)" "-" failed
    row "$(ts 3)" R-delta "blocked by hold" "-" blocked
    row "$(ts 4)" R-epsilon "PR opened (9m, \$0.5000)" "[#5](https://example.com/pull/5)" pending
    row "$(ts 12)" R-old "MERGED 0ldc0de" "[#9](https://example.com/pull/9)" pass
    printf '\n## Weekly fold\n(empty)\n'
  } > "$1/scorecard.md"
}

block() { # file -> the fold block, markers included
  python3 - "$1" <<'PY'
import sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
b = "<!-- scorecard:fold:begin -->"; e = "<!-- scorecard:fold:end -->"
try:
    i, j = lines.index(b), lines.index(e)
except ValueError:
    sys.exit(1)
if i >= j:
    sys.exit(1)
print("\n".join(lines[i:j + 1]))
PY
}

sha() {
  python3 - "$1" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
}

# --- 1. fold inserts exactly one block above ## Weekly fold ---
F="$T/t1/state"
fixture_window "$F"
cp "$F/scorecard.md" "$T/t1/before.md"
grep '^| 20' "$T/t1/before.md" > "$T/t1/rows.before"
python3 "$S" fold --days 7 --state "$F" || bad fold-exit
grep '^| 20' "$F/scorecard.md" > "$T/t1/rows.after"
cmp -s "$T/t1/rows.before" "$T/t1/rows.after" || { diff -u "$T/t1/rows.before" "$T/t1/rows.after"; bad fold-rewrote-data-rows; }
B="$(block "$F/scorecard.md")" || bad fold-block-missing
[ "$(printf '%s\n' "$B" | grep -c '^### Weekly fold')" -eq 1 ] || bad fold-heading-count
printf '%s\n' "$B" | grep -qF 'rows: 3' || { printf '%s\n' "$B"; bad fold-window-count; }
printf '%s\n' "$B" | grep -qF 'R-old' && bad fold-counted-outside-row
printf '%s\n' "$B" | grep -qF '#9' && bad fold-linked-outside-row
printf '%s\n' "$B" | grep -qF 'R-alpha' && printf '%s\n' "$B" | grep -qF 'R-beta' || bad fold-missing-delivered
printf '%s\n' "$B" | grep -qF 'measured cost: $1.2129' || bad fold-cost-sum
python3 - "$F/scorecard.md" <<'PY' || bad fold-order
import sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
b = lines.index("<!-- scorecard:fold:begin -->")
h = next(i for i, l in enumerate(lines) if l.startswith("## Weekly fold"))
assert b < h, (b, h)
assert lines[h] == "## Weekly fold", lines[h]
assert not any(l.startswith("## ") for l in lines[h + 1:]), lines[h + 1:]
PY
ok fold-inserts-one-block-above-weekly-fold

# --- 2. a second fold replaces the block instead of stacking ---
F="$T/t2/state"
fixture_window "$F"
python3 "$S" fold --days 7 --state "$F" || bad fold-idempotent-first
python3 "$S" fold --days 7 --state "$F" || bad fold-idempotent-second
[ "$(grep -cF '<!-- scorecard:fold:begin -->' "$F/scorecard.md")" -eq 1 ] || bad fold-idempotent-begin-count
[ "$(grep -cF '<!-- scorecard:fold:end -->' "$F/scorecard.md")" -eq 1 ] || bad fold-idempotent-end-count
block "$F/scorecard.md" | grep -q '^### Weekly fold' || bad fold-idempotent-block
ok fold-is-idempotent

# --- 3. report --week counts FPY outcomes and names every item ---
F="$T/t3/state"
fixture_report "$F"
OUT="$(python3 "$S" report --week --state "$F")" || bad report-exit
for want in 'rows: 5' 'merged: 1' 'patched: 1' 'rework: 1' 'blocked: 1' 'pending: 1'; do
  printf '%s\n' "$OUT" | grep -qF "$want" || { printf '%s\n' "$OUT"; bad "report-total-$want"; }
done
check_item() { # item pr fpy
  local line
  line="$(printf '%s\n' "$OUT" | grep -F -- "- $1:")" || { printf '%s\n' "$OUT"; bad "report-missing-item-$1"; }
  printf '%s\n' "$line" | grep -qF "$2" || { printf '%s\n' "$line"; bad "report-missing-pr-$1"; }
  printf '%s\n' "$line" | grep -qF "$3" || { printf '%s\n' "$line"; bad "report-missing-fpy-$1"; }
}
check_item R-alpha '[#1](https://example.com/pull/1)' pass
check_item R-beta '[#2](https://example.com/pull/2)' patched
check_item R-gamma '-' failed
check_item R-delta '-' blocked
check_item R-epsilon '[#5](https://example.com/pull/5)' pending
printf '%s\n' "$OUT" | grep -qF 'R-old' && bad report-counted-outside-row
[ "$(printf '%s\n' "$OUT" | grep -c '^- R-')" -eq 5 ] || bad report-item-count
ok report-week-counts-by-fpy

# --- 4. --dry-run prints the block and leaves the file byte-identical ---
F="$T/t4/state"
fixture_window "$F"
BEFORE="$(sha "$F/scorecard.md")"
OUT="$(python3 "$S" fold --days 7 --dry-run --state "$F")" || bad fold-dry-run-exit
AFTER="$(sha "$F/scorecard.md")"
[ "$BEFORE" = "$AFTER" ] || bad fold-dry-run-changed-file
printf '%s\n' "$OUT" | grep -qF '### Weekly fold' || { printf '%s\n' "$OUT"; bad fold-dry-run-no-block; }
printf '%s\n' "$OUT" | grep -qF 'rows: 3' || { printf '%s\n' "$OUT"; bad fold-dry-run-wrong-count; }
ok fold-dry-run-changes-nothing

# --- 5. a malformed row warns once and is skipped, not fatal ---
F="$T/t5/state"
mkdir -p "$F"
{
  header
  row "$(ts 0)" R-ok "MERGED abc1234" "[#1](https://example.com/pull/1)" pass
  printf '| %s | R-bad | `worker` | only four cells |\n' "$(ts 0)"
  printf '\n## Weekly fold\n(empty)\n'
} > "$F/scorecard.md"
ERR="$T/t5.err"
python3 "$S" fold --days 7 --state "$F" 2>"$ERR" || { cat "$ERR"; bad malformed-row-fatal; }
[ "$(grep -ci 'warning' "$ERR")" -eq 1 ] || { cat "$ERR"; bad malformed-row-warning-count; }
B="$(block "$F/scorecard.md")" || bad malformed-row-no-fold
printf '%s\n' "$B" | grep -qF 'rows: 1' || { printf '%s\n' "$B"; bad malformed-row-counted; }
printf '%s\n' "$B" | grep -qF 'R-ok' || bad malformed-row-lost-good-row
ok malformed-row-is-skipped-not-fatal

# --- 6. RSI_STATE is honoured when --state is absent ---
F="$T/t6/state"
fixture_window "$F"
( cd "$T/t6" && RSI_STATE="$F" python3 "$S" fold --days 7 ) || bad rsi-state-seam-exit
block "$F/scorecard.md" | grep -qF 'rows: 3' || bad rsi-state-seam-block
ok rsi-state-env-is-honoured

echo ALL-PASS
