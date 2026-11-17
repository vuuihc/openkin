#!/bin/bash
# test-walk-mutant.sh — hermetic contract for the R-walk-mutant red proof.
#
# The proof itself needs a browser and two UI builds, so it is not part of the
# gate. What the gate *can* check without one is that the committed mutant still
# points at the real hand-off pair, that the runner prints that same manifest,
# and that the J3 spec still satisfies the contract the walk depends on. A
# manifest whose `old` no longer occurs exactly once would make mutants.py stop
# before it ever ran a mutant, silently retiring the proof.
#
# No browser, no npm, no daemon: python3 stdlib and node only.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WT="$(cd "$HERE/../../.." && pwd)"
MANIFEST="$WT/rsi/runtime/ux/walk-mutant.json"
RUNNER="$WT/rsi/runtime/ux/walk-mutant-test.sh"
WALKER="$WT/rsi/runtime/ux/walk.mjs"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

case_name="test_walk_mutant_manifest_points_at_the_handoff_pair_and_the_row_tap"
[ -f "$MANIFEST" ] || fail "$case_name: no rsi/runtime/ux/walk-mutant.json"
[ -f "$RUNNER" ] || fail "$case_name: rsi/runtime/ux/walk-mutant-test.sh is missing"
python3 - "$MANIFEST" "$WT" <<'PY' || exit 1
import json
import sys

manifest_path, root = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest_path, encoding="utf-8"))
if not isinstance(entries, list) or len(entries) != 2:
    raise SystemExit("manifest must be exactly two entries, got %r" % (entries,))
for entry in entries:
    for key in ("label", "file", "old", "new", "test"):
        if not isinstance(entry.get(key), str) or not entry[key]:
            raise SystemExit("entry %r is missing a non-empty %r"
                             % (entry.get("label"), key))
    if entry["old"] == entry["new"]:
        raise SystemExit("`new` is identical to `old`; the mutant changes nothing")
    path = root + "/" + entry["file"]
    text = open(path, encoding="utf-8").read()
    count = text.count(entry["old"])
    if count != 1:
        raise SystemExit("`old` occurs %d times in %s, not once"
                         % (count, entry["file"]))
    if "rsi/runtime/ux/walk-mutant-test.sh" not in entry["test"]:
        raise SystemExit("`test` does not name rsi/runtime/ux/walk-mutant-test.sh")
    if "--walk-once" not in entry["test"]:
        raise SystemExit("`test` does not run the runner's --walk-once")
j3 = next((e for e in entries if e["file"].endswith("NewChatPage.tsx")), None)
if j3 is None:
    raise SystemExit("no J3 entry for ui/src/pages/NewChatPage.tsx")
if "if (false)" not in j3["new"]:
    raise SystemExit("the hand-off mutant does not put the calls behind `if (false)`")
j7 = next((e for e in entries if e["file"].endswith("FloatingApproval.tsx")), None)
if j7 is None:
    raise SystemExit("no J7 entry for ui/src/components/cards/FloatingApproval.tsx")
if "--walk-once J7" not in j7["test"]:
    raise SystemExit("the J7 entry's `test` does not walk J7 (--walk-once J7)")
print("manifest ok: %s and %s, one occurrence of each `old`"
      % (j3["file"], j7["file"]))
PY
[ $? -eq 0 ] || fail "$case_name: manifest check failed"
pass "$case_name"

case_name="test_walk_mutant_print_manifest_matches_the_committed_json"
printed="$(bash "$RUNNER" --print-manifest)" || fail "$case_name: --print-manifest exited non-zero"
python3 - "$MANIFEST" "$printed" <<'PY' || exit 1
import json
import sys

committed = json.load(open(sys.argv[1], encoding="utf-8"))
printed = json.loads(sys.argv[2])
if printed != committed:
    raise SystemExit("--print-manifest differs from the committed manifest")
PY
[ $? -eq 0 ] || fail "$case_name: printed manifest does not match"
pass "$case_name"

case_name="test_j3_spec_still_passes_the_contract"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  cat "$log" >&2
  rm -f "$log"
  fail "$case_name: --check-spec exited $rc"
fi
rm -f "$log"
pass "$case_name"

case_name="test_j3_spec_rejects_a_title_only_prompt_wait"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
spec_tmp="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec-mutant.XXXXXX")"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" <<'PY' || exit 1
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]
prompt = next(st[2] for st in steps if st[0] == "fill" and "textarea" in str(st[1]))
hit = 0
for st in steps:
    if st[0] == "wait" and str(st[1]).startswith("css=") and "[role=" in str(st[1]) and prompt in str(st[1]):
        st[1] = "text=" + prompt
        hit += 1
if hit != 1:
    raise SystemExit("expected one transcript prompt wait, rewrote %d" % hit)
json.dump(spec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec --spec "$spec_tmp" ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 1 ] || ! grep -q "inside the transcript" "$log"; then
  cat "$log" >&2
  rm -f "$log" "$spec_tmp"
  fail "$case_name: --check-spec exited $rc without rejecting a text= prompt wait"
fi
rm -f "$log" "$spec_tmp"
pass "$case_name"

# A `text=` wait is also rejected by the `^css=` half of the rule, so it cannot
# see the transcript-scoping half. A `css=body:has-text(...)` wait satisfies
# `^css=` and names the prompt, and is green the moment the `[role=region]`
# clause is dropped: this case owns that half.
case_name="test_j3_spec_rejects_a_prompt_wait_outside_the_transcript"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
spec_tmp="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec-mutant.XXXXXX")"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" <<'PY' || exit 1
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]
prompt = next(st[2] for st in steps if st[0] == "fill" and "textarea" in str(st[1]))
hit = 0
for st in steps:
    if st[0] == "wait" and str(st[1]).startswith("css=") and "[role=" in str(st[1]) and prompt in str(st[1]):
        st[1] = 'css=body:has-text("%s")' % prompt
        hit += 1
if hit != 1:
    raise SystemExit("expected one transcript prompt wait, rewrote %d" % hit)
json.dump(spec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec --spec "$spec_tmp" ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 1 ] || ! grep -q "inside the transcript" "$log"; then
  cat "$log" >&2
  rm -f "$log" "$spec_tmp"
  fail "$case_name: --check-spec exited $rc without rejecting an unscoped css= prompt wait"
fi
rm -f "$log" "$spec_tmp"
pass "$case_name"

case_name="test_j7_spec_rejects_a_keyboard_reopen_instead_of_a_tap"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
spec_tmp="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec-mutant.XXXXXX")"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" <<'PY' || exit 1
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
steps = spec["journeys"]["J7"]["steps"]
row = '[data-session-row="{conversation}"]'
hit = 0
for i, st in enumerate(steps):
    if st[0] == "click" and row in str(st[1]):
        steps[i:i + 1] = [["focus", row], ["key", "Enter"]]
        hit += 1
if hit != 1:
    raise SystemExit("expected one row tap after Back, rewrote %d" % hit)
json.dump(spec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec --spec "$spec_tmp" ) >"$log" 2>&1
rc=$?
# Both sentences, not just the tap one: removing the click alone would already
# fail with the click-required error, so a grep for "must tap the row" keeps
# this case green even if the focus+Enter rejection itself is deleted.
if [ "$rc" -ne 1 ] || ! grep -q "must tap the row" "$log" \
   || ! grep -q "reopens the row with focus+Enter" "$log"; then
  cat "$log" >&2
  rm -f "$log" "$spec_tmp"
  fail "$case_name: --check-spec exited $rc without rejecting a focus+Enter reopen"
fi
rm -f "$log" "$spec_tmp"
pass "$case_name"

echo "walk-mutant contract: 6/6 cases passed"
