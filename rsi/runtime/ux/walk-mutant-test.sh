#!/bin/bash
# walk-mutant-test.sh — the one-command red proof for the F1 hand-off (R-walk-mutant).
#
#   bash rsi/runtime/ux/walk-mutant-test.sh               # apply the committed mutant, require red, restore
#   bash rsi/runtime/ux/walk-mutant-test.sh --walk-once   # one J3 walk of this tree (mutated or not); 0 green, 1 red, 2 unavailable
#   bash rsi/runtime/ux/walk-mutant-test.sh --print-manifest
#
# Pressing Start on /new must keep the typed message on screen across the route
# to /tasks/:id. Two things carry it: the seeded detail row (applyTaskSnapshot)
# and the in-memory pending bubble (handOffPendingSend). The manifest breaks
# both at once with `if (false)`; --walk-once holds the task-detail GET open for
# 9s and gives the prompt only 6s to appear, so a walk that loses the pair has
# nothing to draw before the detail answers and fails the prompt wait.
#
# Deliberately not wired into ux-gate.sh: the proof builds the UI twice (once
# for the mutant, once restored), which is too heavy for every PR. This is a
# one-command verification to run when the hand-off or the J3 walk changes.
#
# The worktree is derived from this script's own location, so no absolute path
# from the machine that wrote it is ever needed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WT="$(cd "$HERE/../../.." && pwd)"
MANIFEST="$HERE/walk-mutant.json"

usage() { sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
unavailable() { echo "UNAVAILABLE: $*" >&2; exit 2; }

case "${1:-}" in
  --print-manifest)
    [ -f "$MANIFEST" ] || unavailable "no manifest at rsi/runtime/ux/walk-mutant.json"
    cat "$MANIFEST"
    exit 0
    ;;
  --walk-once)
    ;;
  "")
    cd "$WT" || unavailable "cannot enter the worktree root"
    [ -f "$MANIFEST" ] || unavailable "no manifest at rsi/runtime/ux/walk-mutant.json"
    exec python3 scripts/mutants.py rsi/runtime/ux/walk-mutant.json --timeout 1200 --verbose
    ;;
  *)
    usage
    ;;
esac

# --walk-once: build this tree's console, then walk J3 with the detail answer
# held. The build is forced because ux-walk.sh skips it when web/dist/assets
# exists — that would walk a bundle built before (or without) the mutant and
# make every run look green.
cd "$WT" || unavailable "cannot enter the worktree root"
command -v node >/dev/null 2>&1 || unavailable "node is not on PATH"
command -v npm >/dev/null 2>&1 || unavailable "npm is not on PATH"
command -v python3 >/dev/null 2>&1 || unavailable "python3 is not on PATH"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/walk-mutant.XXXXXX")" || unavailable "cannot create a temp dir"
# `npm run build` empties and rewrites the tracked web/dist/index.html (vite's
# outDir), while mutants.py restores only the source file. Keep the committed
# entry and put it back on the way out, or default mode leaves a dirty index
# naming a mutant chunk that is gitignored.
[ -f "$WT/web/dist/index.html" ] && cp "$WT/web/dist/index.html" "$OUT/index.html.bak"
trap '[ -f "$OUT/index.html.bak" ] && cp "$OUT/index.html.bak" "$WT/web/dist/index.html"; rm -rf "$OUT"' EXIT

( cd ui && npm run build ) >"$OUT/build.log" 2>&1 \
  || unavailable "ui build failed: $(tail -c 300 "$OUT/build.log")"

RSI_UX_DELAY_TASKS_MS=9000 RSI_UX_WAIT_MS=6000 \
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J3 >"$OUT/ux-walk.log" 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then
  unavailable "$(cat "$OUT/UNAVAILABLE" 2>/dev/null || tail -c 300 "$OUT/ux-walk.log")"
fi
[ "$rc" -eq 0 ] || unavailable "ux-walk.sh exited $rc: $(tail -c 300 "$OUT/ux-walk.log")"
[ -s "$OUT/walk.json" ] || unavailable "the walker wrote no walk.json"

python3 - "$OUT/walk.json" <<'PY'
import json
import sys

walk = json.load(open(sys.argv[1], encoding="utf-8"))
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J3"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # No working directory or no fake agent: the prompt wait proves nothing on
    # a journey that never pressed Start. Fail closed as "could not run".
    print("UNAVAILABLE: J3 was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

hard = [f for f in walk.get("hardFail", []) if str(f).startswith("J3/")]
sent = [i for i, n in enumerate(names) if n.endswith("-sent")]
replied = [i for i, n in enumerate(names) if n.endswith("-replied")]
print("J3 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J3 hardFail: " + str(f))
if hard:
    print("walk-mutant: J3 red: %d hard failure(s)" % len(hard))
    sys.exit(1)
if not sent or not replied or min(sent) > max(replied):
    print("walk-mutant: J3 red: no -sent screen before a -replied screen")
    sys.exit(1)
print("walk-mutant: J3 green: the sent shot precedes the reply with the detail GET held")
PY
