#!/bin/bash
# walk-mutant-test.sh — the one-command red proof for the walk contracts (R-walk-mutant, R-walk-tap-j7).
#
#   bash rsi/runtime/ux/walk-mutant-test.sh                    # apply every committed mutant, require red, restore
#   bash rsi/runtime/ux/walk-mutant-test.sh --walk-once [J3|J5|J7|J2|J8|J9|J10|J11] # one walk pass of this tree (J3 = hand-off + mid-run walks); 0 green, 1 red, 2 unavailable
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
# Three: a held round must be stoppable, and the message queued behind it must
# be accounted for. The manifest's fourth entry removes the cancel call; the
# walk presses Stop, requires the control to leave the screen and reads the
# daemon's own discard report ("1 queued prompt(s) discarded with the canceled
# task"). A Stop that does nothing leaves the control up and the report absent,
# so the walk reddens on the gone, not on a screenshot.
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
# J2: the review loop — comment a changed line, save it into the tray, send
# the tray as one follow-up — must arrive in the transcript WITH its anchor.
# The manifest drops the hunk header and quoted line from
# formatDiffCommentsMessage; the walk's transcript wait then times out and
# --walk-once J2 prints red. The same mutant also reddens
# diffCommentAnchor.test.ts, which is expected: --walk-once only runs the walk.
#
# J8: the same loop with a thumb. The phone journey taps the changed line's
# glyph (no Alt+C), taps the tray's Send (no Meta+Enter), and must read the
# sheet, the one-row tray and the anchored follow-up at 390. --walk-once J8
# builds the UI, walks only J8 at the phone viewport, and reuses the J2 read:
# sheet -> tray -> sent in order, count = 1, notes.md + @@ in the transcript,
# and the tray gone afterwards.
#
# J9: F4's switch proof. The manifest keys <AppShell> on the pathname, so every
# route change remounts the shell and throws away the keep-alive panes. The
# journey tags the shell, scrolls the transcript, types an unsent draft, walks
# to another conversation and both area roots, then reads all three back; the
# `node` assertion names the replaced element. --walk-once J9 builds the UI,
# walks only J9 at the mac viewport, and requires the switch-back notes to
# carry the same-shell line, the scroll-kept line and the draft's value line.
#
# J5: the row menu a person manages a conversation with. The walk opens the
# seeded running row's menu by its id (any other row has no 运行中 line) and
# asserts rename, pin, archive and delete in both languages, plus exactly one
# disabled 运行中 / Running line. The manifest drops that status item from the
# menu (`runningNow && false`, which keeps the tone test used for tsc); the
# walk's count then reads 0 and --walk-once J5 prints red. Without the walk
# half, a renamed action or a pressable status line would ship green.
#
# J11: the same F4 proof on the phone. The manifest turns the phone's Back into
# a document load (`window.location.assign`), which throws away the shell and
# the kept-alive panes — the page-load flash F4 exists to prevent. The journey
# leaves the conversation with the phone's Back, opens another, comes back,
# then leaves again, walks the footer's routines and sessions entries, and
# reopens the conversation; the `node` assertion names the replaced shell, and
# the `scroll-kept` and `value` assertions name the lost position and draft.
# --walk-once J11 builds the UI, walks only J11 at 390, and requires the
# switch-back and switch-area-back notes to carry the same-shell line and both
# draft/scroll reads. J9 has no Back step, so this mutant is J11's own.
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
      J3|J5|J7|J2|J8|J9|J10|J11) ;;
      *) unavailable "unknown journey $JOURNEY; --walk-once takes J3 (default), J5, J7, J2, J8, J9, J10 or J11" ;;
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

if [ "$JOURNEY" = "J5" ]; then
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J5 >"$OUT/ux-walk.log" 2>&1
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
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J5"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # No seeded running conversation: a menu opened on a settled row has no
    # 运行中 line, so the walk proves nothing. Fail closed as "could not run".
    print("UNAVAILABLE: J5 was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

# Step failures are `J5/…`; screenshot lint is `J5-<vp>-…`. Both are J5's.
hard = [f for f in walk.get("hardFail", [])
        if str(f).startswith("J5/") or str(f).startswith("J5-")]
print("J5 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J5 hardFail: " + str(f))
if hard:
    print("walk-mutant: J5 red: %d hard failure(s)" % len(hard))
    sys.exit(1)

# The photograph is only evidence if the walk read the menu. At both widths the
# row-actions shot's notes must carry the rename wait and a count of exactly
# one disabled 运行中 / Running line; the mutant leaves that count at 0.
unread = []
for vp in ("phone", "mac"):
    mine = [s for s in screens
            if str(s.get("name", "")).startswith("J5-%s-" % vp)
            and str(s.get("name", "")).endswith("-row-actions")]
    if not mine:
        unread.append(vp + " (no row-actions shot)")
        continue
    notes = [str(n) for n in mine[-1].get("notes", [])]
    if not any(n.startswith("waited for css=") and ("改名" in n or "Rename" in n) for n in notes):
        unread.append(vp + " (rename item never read)")
    if not any(n.startswith("count ") and ("运行中" in n or "Running" in n) and n.endswith("= 1") for n in notes):
        unread.append(vp + " (disabled running line never counted)")
if unread:
    print("walk-mutant: J5 red: " + "; ".join(unread))
    sys.exit(1)
print("walk-mutant: J5 green: the running row's menu shows rename, pin, archive, delete "
      "and one disabled 运行中 line at both viewports")
PY
  exit $?
fi

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

if [ "$JOURNEY" = "J9" ]; then
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J9 >"$OUT/ux-walk.log" 2>&1
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
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J9"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # No seeded conversation: a switch between two empty pages proves nothing.
    # Fail closed as "could not run".
    print("UNAVAILABLE: J9 was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

# Step failures are `J9/…`; screenshot lint is `J9-<vp>-…`. Both are J9's.
hard = [f for f in walk.get("hardFail", [])
        if str(f).startswith("J9/") or str(f).startswith("J9-")]
print("J9 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J9 hardFail: " + str(f))
if hard:
    print("walk-mutant: J9 red: %d hard failure(s)" % len(hard))
    sys.exit(1)

# The return shot is the evidence. Its notes are the journey's whole log, so
# they must carry the shell's element identity, the transcript position read
# back, and the composer's draft: a shot of the right pane taken without
# reading any of them proves only that the route works.
back = [s for s in screens if str(s.get("name", "")).endswith("-switch-back")]
if not back:
    print("walk-mutant: J9 red: no switch-back shot")
    sys.exit(1)
notes = [str(n) for n in back[-1].get("notes", [])]
same_shell = any(n.startswith("node ") and " is the same element " in n for n in notes)
scroll_kept = any(n.startswith("scroll-kept ") for n in notes)
draft_kept = any(n.startswith("value textarea is ") and "F4 draft [seed]" in n for n in notes)
missing = []
if not same_shell:
    missing.append("the same shell node")
if not scroll_kept:
    missing.append("the scroll position")
if not draft_kept:
    missing.append("the composer draft")
if missing:
    print("walk-mutant: J9 red: the switch-back screen never read " + ", ".join(missing))
    sys.exit(1)
print("walk-mutant: J9 green: the shell, the scroll and the draft survived the switch")
PY
  exit $?
fi

if [ "$JOURNEY" = "J10" ]; then
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J10 >"$OUT/ux-walk.log" 2>&1
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
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J10"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # No seeded notification target: there is no card to answer, so the walk
    # proves nothing. Fail closed as "could not run".
    print("UNAVAILABLE: J10 was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

# Step failures are `J10/…`; screenshot lint is `J10-<vp>-…`. Both are J10's.
hard = [f for f in walk.get("hardFail", [])
        if str(f).startswith("J10/") or str(f).startswith("J10-")]
print("J10 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J10 hardFail: " + str(f))
if hard:
    print("walk-mutant: J10 red: %d hard failure(s)" % len(hard))
    sys.exit(1)

# The round's shape, in order: land on the card, approve it, come back to the
# remembered settings tab, read the routines root, then the return shot.
expected = ["f5-deep-link", "f5-approved", "f5-tab-settings-remembered",
            "f5-tab-routines", "f5-approved-card-stayed-gone"]
positions = []
for shot in expected:
    hit = next((i for i, name in enumerate(names) if name.endswith("-" + shot)), None)
    if hit is None:
        print("walk-mutant: J10 red: no %s shot" % shot)
        sys.exit(1)
    positions.append(hit)
if positions != sorted(positions):
    print("walk-mutant: J10 red: the shots are out of order: " + ", ".join(expected))
    sys.exit(1)

# The notes are the journey's log. The remembered settings read is what the
# mutant removes; the final gone and the zero count are the answered card. A
# shot of the right screen without these proves only that the route works.
def notes_of(shot):
    mine = [s for s in screens if str(s.get("name", "")).endswith("-" + shot)]
    return [str(n) for n in mine[-1].get("notes", [])] if mine else []

remembered = [n for n in notes_of("f5-tab-settings-remembered")
              if n.startswith("search ") and "tab=agents" in n and "matches" in n]
final = notes_of("f5-approved-card-stayed-gone")
gone = [n for n in final if n.startswith("gone ") and ("批准" in n or "Approve" in n)]
zeroed = [n for n in final if n.startswith("count ") and n.endswith("= 0")]
missing = []
if not remembered:
    missing.append("the remembered settings tab")
if not gone:
    missing.append("the final gone of the approve control")
if not zeroed:
    missing.append("the zero count of the approve control")
if missing:
    print("walk-mutant: J10 red: the walk never read " + ", ".join(missing))
    sys.exit(1)
print("walk-mutant: J10 green: the deep-linked card was approved, every footer entry kept its place, and the card stayed gone")
PY
  exit $?
fi

if [ "$JOURNEY" = "J11" ]; then
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" J11 >"$OUT/ux-walk.log" 2>&1
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
screens = [s for s in walk.get("screens", []) if s.get("journey") == "J11"]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # No seeded conversation, or no fake agent: a switch between two empty
    # pages proves nothing. Fail closed as "could not run".
    print("UNAVAILABLE: J11 was skipped (" + ", ".join(skips[:2]) + ")")
    sys.exit(2)

# Step failures are `J11/…`; screenshot lint is `J11-<vp>-…`. Both are J11's.
hard = [f for f in walk.get("hardFail", [])
        if str(f).startswith("J11/") or str(f).startswith("J11-")]
print("J11 screens: " + (", ".join(names) or "none"))
for f in hard:
    print("J11 hardFail: " + str(f))
if hard:
    print("walk-mutant: J11 red: %d hard failure(s)" % len(hard))
    sys.exit(1)

# The return shot is the evidence. Its notes are the journey's whole log, so
# they must carry the shell's element identity, the transcript position read
# back and the composer's draft: a shot of the right pane taken without
# reading any of them proves only that the route works.
back = [s for s in screens if str(s.get("name", "")).endswith("-switch-back")]
if not back:
    print("walk-mutant: J11 red: no switch-back shot")
    sys.exit(1)
notes = [str(n) for n in back[-1].get("notes", [])]
missing = []
if not any(n.startswith("node ") and " is the same element " in n for n in notes):
    missing.append("the same shell node")
if not any(n.startswith("scroll-kept ") for n in notes):
    missing.append("the scroll position")
if not any(n.startswith("value textarea is ") and "F4 draft [seed]" in n for n in notes):
    missing.append("the composer draft")
if missing:
    print("walk-mutant: J11 red: the switch-back screen never read " + ", ".join(missing))
    sys.exit(1)

# The area round is the stronger claim: the pane was off screen while the
# reader was in Routines, so the return must read the draft and the position a
# second time. The notes are cumulative, so the second read is counted.
area = [s for s in screens if str(s.get("name", "")).endswith("-switch-area-back")]
if not area:
    print("walk-mutant: J11 red: no switch-area-back shot")
    sys.exit(1)
area_notes = [str(n) for n in area[-1].get("notes", [])]
kept = [n for n in area_notes if n.startswith("scroll-kept ")]
drafts = [n for n in area_notes if n.startswith("value textarea is ") and "F4 draft [seed]" in n]
again = []
if len(kept) < 2:
    again.append("the scroll position a second time")
if len(drafts) < 2:
    again.append("the draft a second time")
if again:
    print("walk-mutant: J11 red: the area round never read " + ", ".join(again))
    sys.exit(1)
print("walk-mutant: J11 green: the shell, the scroll and the draft survived "
      "the chat switch and the area round at 390")
PY
  exit $?
fi

# The review loop's proof, shared by J2 (Mac, both widths, keyboard entry) and
# J8 (phone, glyph tap). One reader, so a later edit cannot let the phone walk
# pass on a weaker check than the Mac one. $1 journey, $2 the entry shot name
# (J2's box / J8's sheet), $3.. the viewports that must each show the loop.
read_review_walk() {
  python3 - "$OUT/walk.json" "$@" <<'PY'
import json
import re
import sys

walk = json.load(open(sys.argv[1], encoding="utf-8"))
journey, entry_shot = sys.argv[2], sys.argv[3]
viewports = sys.argv[4:]
screens = [s for s in walk.get("screens", []) if s.get("journey") == journey]
names = [str(s.get("name", "")) for s in screens]
skips = [n for n in names if "-skipped-" in n]
if skips:
    # No seeded conversation or diff: the review loop proves nothing on a page
    # that never had a changed line. Fail closed as "could not run".
    print("UNAVAILABLE: %s was skipped (%s)" % (journey, ", ".join(skips[:2])))
    sys.exit(2)

# The walker writes two hardFail shapes: step failures as `<journey>/<vp>: …`
# and screenshot-lint failures as `<journey>-<vp>-<n>-<shot>: …`. Both are this
# journey's: a phone overflow at 390 is exactly what J8 exists to catch, and a
# filter that only took the first shape would print green over it.
hard = [f for f in walk.get("hardFail", [])
        if str(f).startswith(journey + "/") or str(f).startswith(journey + "-")]
print("%s screens: %s" % (journey, ", ".join(names) or "none"))
for f in hard:
    print("%s hardFail: %s" % (journey, f))
if hard:
    print("walk-mutant: %s red: %d hard failure(s)" % (journey, len(hard)))
    sys.exit(1)

# Per viewport, the review loop in the order a person runs it: the box/sheet
# open, the tray holding the saved comment, then the sent follow-up.
shots = {}
for i, name in enumerate(names):
    m = re.match(r"^%s-(.+?)-\d+-(.+)$" % re.escape(journey), name)
    if m:
        shots.setdefault(m.group(1), []).append((i, m.group(2)))
missing = []
for vp in viewports:
    seq = shots.get(vp, [])
    entry = [i for i, shot in seq if shot == entry_shot]
    tray = [i for i, shot in seq if shot == "diff-comment-tray"]
    sent = [i for i, shot in seq if shot == "diff-comment-sent"]
    if not entry or not tray or not sent or not (min(entry) < min(tray) < min(sent)):
        missing.append(vp)
if missing:
    print("walk-mutant: %s red: no %s -> diff-comment-tray -> diff-comment-sent order at %s"
          % (journey, entry_shot, ", ".join(missing)))
    sys.exit(1)

# The screenshots are only evidence if the walk actually read the loop: one
# saved row, the anchor in the transcript, and an emptied tray after the send.
unread = []
for vp in viewports:
    mine = [s for s in screens if s["name"].startswith("%s-%s-" % (journey, vp)) and s["name"].endswith("-diff-comment-sent")]
    notes = mine[-1].get("notes", []) if mine else []
    counted = any(str(n).startswith("count ") and str(n).endswith("= 1") for n in notes)
    anchored = any(str(n).startswith("waited for css=[role=region]") and "notes.md" in str(n) and "@@" in str(n) for n in notes)
    emptied = any(str(n).startswith("gone ") and ("改动评论" in str(n) or "Diff comments" in str(n)) for n in notes)
    if not (counted and anchored and emptied):
        unread.append(vp)
if unread:
    print("walk-mutant: %s red: the tray row, anchored transcript or emptied tray was not read at %s"
          % (journey, ", ".join(unread)))
    sys.exit(1)
print("walk-mutant: %s green: comment -> tray -> anchored follow-up -> empty tray at %s"
      % (journey, "the phone width" if viewports == ["phone"] else "both viewports"))
PY
}

if [ "$JOURNEY" = "J2" ] || [ "$JOURNEY" = "J8" ]; then
  bash rsi/runtime/ux-walk.sh "$WT" "$OUT" "$JOURNEY" >"$OUT/ux-walk.log" 2>&1
  rc=$?
  if [ "$rc" -eq 2 ]; then
    unavailable "$(cat "$OUT/UNAVAILABLE" 2>/dev/null || tail -c 300 "$OUT/ux-walk.log")"
  fi
  [ "$rc" -eq 0 ] || unavailable "ux-walk.sh exited $rc: $(tail -c 300 "$OUT/ux-walk.log")"
  [ -s "$OUT/walk.json" ] || unavailable "the walker wrote no walk.json"

  if [ "$JOURNEY" = "J8" ]; then
    read_review_walk J8 diff-comment-sheet phone
  else
    read_review_walk J2 diff-comment-box mac mac-wide
  fi
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

# The stop half is a second walk contract: a held round is stopped, the Stop
# control leaves the screen, and the daemon's discard report names the message
# queued behind it. Without these steps the Stop mutant would look red for no
# reason, so say "could not run", not "red".
python3 - "$WT/rsi/runtime/ux/journeys.json" <<'PY' || unavailable "the J3 spec carries no Stop proof (no stopped shot / discard report wait)"
import json
import sys

steps = json.load(open(sys.argv[1], encoding="utf-8"))["journeys"]["J3"]["steps"]
if not any(st[0] == "shot" and st[1] == "stopped" for st in steps):
    raise SystemExit("no J3 stopped shot")
if not any(st[0] == "wait" and "queued prompt(s) discarded with the canceled task" in str(st[1]) for st in steps):
    raise SystemExit("no J3 discard report wait")
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
# round was still open) -> replied (the first answer finally landed) ->
# stopped (a later held round was stopped and the screen says what became of
# the message queued behind it).
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
    stopped = [i for i, shot in seq if shot == "stopped"]
    if not sent or not queued or not replied or not stopped or not (min(sent) < min(queued) < min(replied) < min(stopped)):
        missing.append(vp)
if missing:
    print("walk-mutant: J3 red: no sent -> midrun-queued -> replied -> stopped order at " + ", ".join(missing))
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

# The stopped screen is only evidence if the walk read, from the page it
# photographed, the control leaving, the stopped toast and the daemon's own
# discard report. A shot of a transcript taken after Stop proves nothing on
# its own, and a report line nobody read is exactly the silent drop this
# contract exists to catch.
unread = []
for vp in ("phone", "mac"):
    mine = [s for s in screens if s["name"].startswith(f"J3-{vp}-") and s["name"].endswith("-stopped")]
    notes = [str(n) for n in (mine[-1].get("notes", []) if mine else [])]
    if not any(n.startswith("gone ") and "停止" in n for n in notes):
        unread.append(vp + " (Stop control still on screen)")
    if not any(n.startswith("waited for css=") and ("已停止当前轮次" in n or "Stopped current round" in n) for n in notes):
        unread.append(vp + " (stopped toast)")
    if not any(n.startswith("waited for text=") and "queued prompt(s) discarded with the canceled task" in n for n in notes):
        unread.append(vp + " (discard report)")
if unread:
    print("walk-mutant: J3 red: the stopped screen never read the " + ", ".join(unread))
    sys.exit(1)
print("walk-mutant: J3 mid-run green: sent -> midrun-queued -> replied -> stopped at both viewports, "
      "queued guide read, Stop gone, stopped toast and discard report read")
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
