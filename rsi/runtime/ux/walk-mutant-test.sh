#!/bin/bash
# walk-mutant-test.sh — the one-command red proof for the walk contracts (R-walk-mutant, R-walk-tap-j7).
#
#   bash rsi/runtime/ux/walk-mutant-test.sh                    # apply every committed mutant, require red, restore
#   bash rsi/runtime/ux/walk-mutant-test.sh --walk-once [J3|J7] # one walk pass of this tree (J3 = hand-off + mid-run walks); 0 green, 1 red, 2 unavailable
#   bash rsi/runtime/ux/walk-mutant-test.sh --print-manifest
#
# J3 has two contracts. One: pressing Start on /new must keep the typed message
# on screen across the route to /tasks/:id. Two things carry it: the seeded
# detail row (applyTaskSnapshot) and the in-memory pending bubble
# (handOffPendingSend). The manifest breaks both at once with `if (false)`;
# --walk-once holds the task-detail GET open for 9s and gives the prompt only 6s
# to appear, so a walk that loses the pair has nothing to draw before the detail
# answers and fails the prompt wait.
# Two: a second message typed while that round is still open must be queued and
# read on screen BEFORE the first answer (the mid-run follow-up, F2's
# lost-message path). The manifest's third entry drops that dispatch; the walk
# then fails on the follow-up wait, not on the first prompt wait. The fake
# holds the round for 10s (RSI_FAKE_SLOW_SECS) so the queue window exists.
#
# J3 therefore runs as two walks, because the two proofs pull apart: holding
# the detail GET is what proves the hand-off (walk 2), but it also keeps
# `detail.loaded` false, and the composer is disabled until it flips — at the
# held answer, 9s in, while the fake clamps its own hold at 10s. So walk 1 has
# no held GET (composer usable at once, full mid-run proof) and walk 2 holds the
# GET 9s with a 6s prompt budget and a spec cut at the `sent` shot.
#
# J7: the row that reopens the seeded conversation after Back is tapped, not
# focused and pressed. The manifest renders the decision card over the phone
# tab root again (the pre-#252 layout); the card intercepts the tap, the row
# click times out, and the walk prints J7 red. --walk-once J7 builds the UI,
# walks only J7 at both viewports, and requires a back-list shot before a
# back-card shot.
#
# Deliberately not wired into ux-gate.sh: the proof builds the UI twice (once
# for the mutant, once restored), which is too heavy for every PR. This is a
# one-command verification to run when a journey or its walk changes.
#
# The worktree is derived from this script's own location, so no absolute path
# from the machine that wrote it is ever needed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WT="$(cd "$HERE/../../.." && pwd)"
MANIFEST="$HERE/walk-mutant.json"
JOURNEY="J3"

usage() { sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
unavailable() { echo "UNAVAILABLE: $*" >&2; exit 2; }

case "${1:-}" in
  --print-manifest)
    [ -f "$MANIFEST" ] || unavailable "no manifest at rsi/runtime/ux/walk-mutant.json"
    cat "$MANIFEST"
    exit 0
    ;;
  --walk-once)
    JOURNEY="${2:-J3}"
    case "$JOURNEY" in
      J3|J7) ;;
      *) unavailable "unknown journey $JOURNEY; --walk-once takes J3 (default) or J7" ;;
    esac
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

# --walk-once: build this tree's console, then walk one journey. The build is
# forced because ux-walk.sh skips it when web/dist/assets exists — that would
# walk a bundle built before (or without) the mutant and make every run look
# green.
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

if [ "$JOURNEY" = "J7" ]; then
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J7 >"$OUT/ux-walk.log" 2>&1
  rc=$?
  if [ "$rc" -eq 2 ]; then
    unavailable "$(cat "$OUT/UNAVAILABLE" 2>/dev/null || tail -c 300 "$OUT/ux-walk.log")"
  fi
  [ "$rc" -eq 0 ] || unavailable "ux-walk.sh exited $rc: $(tail -c 300 "$OUT/ux-walk.log")"
  [ -s "$OUT/walk.json" ] || unavailable "the walker wrote no walk.json"

  python3 - "$OUT/walk.json" <<'PY'
import json
import re
import sys

walk = json.load(open(sys.argv[1], encoding="utf-8"))
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J7"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # The seed produced no notification target: the tap proves nothing on a
    # list that never had the row. Fail closed as "could not run".
    print("UNAVAILABLE: J7 was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

# Per-shot lint failures (blank page, horizontal overflow) are named after
# the shot (`J7-phone-02-back-list: ...`), not `J7/`; both forms are J7's.
hard = [f for f in walk.get("hardFail", [])
        if str(f).startswith("J7/") or str(f).startswith("J7-")]
print("J7 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J7 hardFail: " + str(f))
if hard:
    print("walk-mutant: J7 red: %d hard failure(s)" % len(hard))
    sys.exit(1)
# Per viewport, the list shot must precede the card shot: the last half of the
# journey is the only place the row tap happens, and walking it backwards
# would prove nothing.
shots = {}
for i, name in enumerate(names):
    m = re.match(r"^J7-([^-]+)-\d+-(.+)$", name)
    if m:
        shots.setdefault(m.group(1), []).append((i, m.group(2)))
missing = []
for vp in ("phone", "mac"):
    seq = shots.get(vp, [])
    back_list = [i for i, shot in seq if shot == "back-list"]
    back_card = [i for i, shot in seq if shot == "back-card"]
    if not back_list or not back_card or min(back_card) < min(back_list):
        missing.append(vp)
if missing:
    print("walk-mutant: J7 red: no back-list shot before a back-card shot at " + ", ".join(missing))
    sys.exit(1)
print("walk-mutant: J7 green: the row tap lands on the named card after Back")
PY
  exit $?
fi

# Without the mid-run steps the walk proves the hand-off only, and the mid-run
# mutant would look red for no reason. Say "could not run", not "red".
python3 - "$WT/rsi/runtime/ux/journeys.json" <<'PY' || unavailable "the J3 spec carries no mid-run follow-up (no midrun-queued shot)"
import json
import sys

steps = json.load(open(sys.argv[1], encoding="utf-8"))["journeys"]["J3"]["steps"]
if not any(st[0] == "shot" and st[1] == "midrun-queued" for st in steps):
    raise SystemExit("no J3 midrun-queued shot")
PY

# Walk 1, the mid-run proof: no held detail GET, so the composer is usable as
# soon as the page mounts; the fake holds the round for 10s, which is the
# window to type the follow-up, queue it, read it and see the answer is not
# there yet.
RSI_UX_WAIT_MS=6000 RSI_FAKE_SLOW_SECS=10 \
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J3 >"$OUT/ux-walk.log" 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then
  unavailable "$(cat "$OUT/UNAVAILABLE" 2>/dev/null || tail -c 300 "$OUT/ux-walk.log")"
fi
[ "$rc" -eq 0 ] || unavailable "ux-walk.sh exited $rc: $(tail -c 300 "$OUT/ux-walk.log")"
[ -s "$OUT/walk.json" ] || unavailable "the walker wrote no walk.json"

python3 - "$OUT/walk.json" <<'PY'
import json
import re
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
print("J3 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J3 hardFail: " + str(f))
if hard:
    print("walk-mutant: J3 red: %d hard failure(s)" % len(hard))
    sys.exit(1)

# Per viewport, the order is the proof: sent (the first message is on the
# transcript) -> midrun-queued (the second one was queued and read while the
# round was still open) -> replied (the first answer finally landed).
shots = {}
for i, name in enumerate(names):
    m = re.match(r"^J3-([^-]+)-\d+-(.+)$", name)
    if m:
        shots.setdefault(m.group(1), []).append((i, m.group(2)))
missing = []
for vp in ("phone", "mac"):
    seq = shots.get(vp, [])
    sent = [i for i, shot in seq if shot == "sent"]
    queued = [i for i, shot in seq if shot == "midrun-queued"]
    replied = [i for i, shot in seq if shot == "replied"]
    if not sent or not queued or not replied or not (min(sent) < min(queued) < min(replied)):
        missing.append(vp)
if missing:
    print("walk-mutant: J3 red: no sent -> midrun-queued -> replied order at " + ", ".join(missing))
    sys.exit(1)

# The mid-run screen is only evidence if the walk actually saw the composer's
# honest queued copy; a shot of a transcript with no queued read proves nothing.
unread = []
for vp in ("phone", "mac"):
    mine = [s for s in screens if s["name"].startswith(f"J3-{vp}-") and s["name"].endswith("-midrun-queued")]
    notes = mine[-1].get("notes", []) if mine else []
    if not any(str(n).startswith("waited for css=[role=status]") and ("已排队" in str(n) or "Queued" in str(n)) for n in notes):
        unread.append(vp)
if unread:
    print("walk-mutant: J3 red: the queued guide was never read at " + ", ".join(unread))
    sys.exit(1)
print("walk-mutant: J3 mid-run green: sent -> midrun-queued -> replied at both viewports, queued guide read")
PY
midrun_rc=$?
# A red mid-run verdict is the verdict: without this the script would run the
# hand-off walk next and exit with *its* status, letting a dropped follow-up
# survive as long as the hand-off stayed green (mutants.py caught exactly that).
[ "$midrun_rc" -eq 0 ] || exit "$midrun_rc"

# Walk 2, the hand-off proof, unchanged from R-walk-mutant: hold the task-detail
# GET for 9s and give the prompt wait only 6s, so the message can only be on
# screen because it crossed the route in memory. The composer stays disabled
# until that held answer flips detail.loaded, so this walk's spec stops at the
# `sent` shot; the mid-run steps are walk 1's, and the fake still holds the
# round so the sent shot cannot race the answer.
mkdir -p "$OUT/handoff"
python3 - "$WT/rsi/runtime/ux/journeys.json" "$OUT/handoff-spec.json" <<'PY' || unavailable "cannot cut the J3 spec down to its hand-off half"
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]
cut = next((i for i, st in enumerate(steps) if st[0] == "shot" and st[1] == "sent"), -1)
if cut < 0:
    raise SystemExit("the J3 spec has no sent shot")
spec["journeys"]["J3"]["steps"] = steps[:cut + 1]
json.dump(spec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
RSI_UX_SPEC="$OUT/handoff-spec.json" RSI_UX_DELAY_TASKS_MS=9000 RSI_UX_WAIT_MS=6000 RSI_FAKE_SLOW_SECS=10 \
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT/handoff" J3 >"$OUT/handoff-ux-walk.log" 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then
  unavailable "$(cat "$OUT/handoff/UNAVAILABLE" 2>/dev/null || tail -c 300 "$OUT/handoff-ux-walk.log")"
fi
[ "$rc" -eq 0 ] || unavailable "hand-off ux-walk.sh exited $rc: $(tail -c 300 "$OUT/handoff-ux-walk.log")"
[ -s "$OUT/handoff/walk.json" ] || unavailable "the hand-off walker wrote no walk.json"

python3 - "$OUT/handoff/walk.json" <<'PY'
import json
import re
import sys

walk = json.load(open(sys.argv[1], encoding="utf-8"))
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J3"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    print("UNAVAILABLE: the hand-off J3 walk was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

hard = [f for f in walk.get("hardFail", []) if str(f).startswith("J3/")]
print("J3 hand-off screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J3 hand-off hardFail: " + str(f))
if hard:
    print("walk-mutant: J3 hand-off red: %d hard failure(s)" % len(hard))
    sys.exit(1)
missing = []
for vp in ("phone", "mac"):
    mine = [s for s in screens if s["name"].startswith(f"J3-{vp}-")]
    sent = [s for s in mine if s["name"].endswith("-sent")]
    if not sent or not re.match(r"^/tasks/[^/]+", sent[-1].get("url", "")):
        missing.append(vp)
        continue
    notes = sent[-1].get("notes", [])
    if not any(str(n).startswith("waited for css=[role=region]") and "Draft: " in str(n) for n in notes):
        missing.append(vp)
if missing:
    print("walk-mutant: J3 hand-off red: no sent screen with the transcript prompt read before the held detail answer at " + ", ".join(missing))
    sys.exit(1)
print("walk-mutant: J3 hand-off green: the prompt crossed the route with the detail GET held")
PY
