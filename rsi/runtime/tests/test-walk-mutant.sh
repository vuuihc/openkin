#!/bin/bash
# test-walk-mutant.sh — hermetic contract for the R-walk-mutant red proof.
#
# The proof itself needs a browser and two UI builds, so it is not part of the
# gate. What the gate *can* check without one is that the committed mutants still
# point at the real hand-off pair, the row tap, the mid-run follow-up
# dispatch, the Stop that must cancel the round, the J2 review anchor, the
# rerun that must keep a comment (re-anchored, then 该行已变化), the shell
# that must not remount on a route change, and the unchecked PR branch that
# must not read as still checking; that the runner prints
# that same manifest; and that the J3 spec carries the mid-run ordering proof
# (the follow-up on screen before the first answer) and the Stop proof (a held
# round stopped, its control gone, and the queued message accounted for by the
# daemon's discard report) and still satisfies the contract the walk depends
# on. A manifest whose `old` no longer occurs exactly once would make mutants.py
# stop before it ever ran a mutant, silently retiring the proof.
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
import re
import sys

manifest_path, root = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest_path, encoding="utf-8"))
if not isinstance(entries, list) or len(entries) != 8:
    raise SystemExit("manifest must be exactly eight entries, got %r" % (entries,))
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
# The mid-run mutant must drop the follow-up dispatch itself, not a render
# detail: the walk's second message has to vanish from the transcript. The
# guard below is the one snippet that removes the send for a running task
# while keeping every import used under noUnusedLocals. A later entry shares
# the file (Stop), so select by the composer half, not by the path alone.
follow = next((e for e in entries if e["file"].endswith("ui/src/pages/TaskDetailPage.tsx")
               and "onComposer" in e["old"]), None)
if follow is None:
    raise SystemExit("no mid-run entry for ui/src/pages/TaskDetailPage.tsx")
if "if (!isTerminal(task.status)) return;" not in follow["new"]:
    raise SystemExit("the mid-run mutant does not drop the follow-up dispatch "
                     "(no `if (!isTerminal(task.status)) return;`)")
if "J7" in follow["test"]:
    raise SystemExit("the mid-run entry's `test` walks J7; it must walk J3")
# The J2 anchor mutant must drop the anchor, not the words: the walk's
# transcript wait names path, hunk header and quote, so keeping any of them (or
# dropping the body) would make the red proof mean something else. Two entries
# share this file now, so each is selected by what it changes, not by the path.
anchor_entries = [e for e in entries
                  if e["file"].endswith("ui/src/components/workspace/diffCommentAnchor.ts")]
review = next((e for e in anchor_entries if "formatCommentBlock" in e["old"]), None)
if review is None:
    raise SystemExit("no J2 anchor entry for ui/src/components/workspace/diffCommentAnchor.ts")
if "--walk-once J2" not in review["test"]:
    raise SystemExit("the J2 entry's `test` does not walk J2 (--walk-once J2)")
if "comment.hunkHeader" in review["new"] or "comment.quote" in review["new"]:
    raise SystemExit("the J2 mutant keeps the hunk header or quote; "
                     "the walk could only go red for an unrelated reason")
if "comment.text" not in review["new"]:
    raise SystemExit("the J2 mutant drops the comment body too; the failure "
                     "would not be about the anchor")
# The rerun mutant must make a comment whose quoted line disappeared read as
# live: the stale report is dropped (the re-anchor filter keeps only comments
# with a matching line), so the tray keeps its last anchor and the walk's
# stale-badge wait times out. A mutant that removed the comment instead would
# redden the kept-row count, which is a different promise.
rerun = next((e for e in anchor_entries
              if "matchingLines(comment.quote, lineChanges, lines).length > 0" in e["new"]), None)
if rerun is None:
    raise SystemExit("no rerun entry dropping the stale report from reanchorComments")
if "--walk-once J2" not in rerun["test"]:
    raise SystemExit("the rerun entry's `test` does not walk J2 (--walk-once J2)")
if "reanchorComments" not in rerun["new"] and "R-p3-rerun-comment" not in rerun["new"]:
    raise SystemExit("the rerun mutant does not say which report it drops (no R-p3-rerun-comment marker)")
if "setDiffComments" in rerun["new"] or "deleteComment" in rerun["new"]:
    raise SystemExit("the rerun mutant deletes the comment instead of dropping its stale report; "
                     "the walk must catch a live-looking row, not a missing one")
# The Stop mutant must remove the cancel call itself, not a render detail: the
# walk presses Stop and requires the control to leave the screen, so an onStop
# that returns before cancelTask is the honest break of that proof.
stop = next((e for e in entries if e["file"].endswith("ui/src/pages/TaskDetailPage.tsx")
             and "function onStop()" in e["old"]), None)
if stop is None:
    raise SystemExit("no Stop entry for ui/src/pages/TaskDetailPage.tsx")
if "R-midrun-stop" not in stop["new"] or not re.search(r"function onStop\(\).*?return;\s*\n\s*// R-midrun-stop", stop["new"], re.S):
    raise SystemExit("the Stop mutant does not return before cancelTask (no guarded onStop)")
if "cancelTask" in stop["new"]:
    raise SystemExit("the Stop mutant leaves cancelTask reachable; it must remove the cancel")
if "J7" in stop["test"]:
    raise SystemExit("the Stop entry's `test` walks J7; it must walk J3")
# The J9 mutant must remount the shell on every route change: that is the
# page-load flash F4 exists to prevent, and the `node` assertion is what
# proves it. A mutant elsewhere in App.tsx would redden the switch for an
# unrelated reason.
shell = next((e for e in entries if e["file"] == "ui/src/App.tsx"), None)
if shell is None:
    raise SystemExit("no J9 entry for ui/src/App.tsx")
if "key={location.pathname}" not in shell["new"]:
    raise SystemExit("the J9 mutant does not key AppShell on the pathname")
if "--walk-once J9" not in shell["test"]:
    raise SystemExit("the J9 entry's `test` does not walk J9 (--walk-once J9)")
# The PR panel mutant must make an unchecked branch read as still checking:
# the honest unobserved line is replaced by the spinner, so the walk's wait
# for that line times out. A mutant that hid the tab or the Refresh control
# would redden a different promise.
pr = next((e for e in entries
           if e["file"] == "ui/src/components/pr/PullRequestPanel.tsx"), None)
if pr is None:
    raise SystemExit("no PR panel entry for ui/src/components/pr/PullRequestPanel.tsx")
if "busy ? (" not in pr["old"] or "unobservedLabel(tr)" not in pr["old"]:
    raise SystemExit("the PR panel mutant does not replace the unobserved branch")
if "true ? (" not in pr["new"]:
    raise SystemExit("the PR panel mutant does not render the checking line "
                     "in place of the unobserved one")
if "unobservedLabel(tr)" not in pr["new"]:
    raise SystemExit("the PR panel mutant drops the unobserved line instead "
                     "of merely hiding it")
if "--walk-once J2" not in pr["test"]:
    raise SystemExit("the PR panel entry's `test` does not walk J2 (--walk-once J2)")
print("manifest ok: %s, %s, %s, %s, %s, %s, %s and %s, one occurrence of each `old`"
      % (j3["file"], j7["file"], follow["file"], review["file"], rerun["file"],
         stop["file"], shell["file"], pr["file"]))
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

# The mid-run follow-up is the F2 lost-message path: a second message typed
# while the first round runs, sent with the queue action, and proved on screen
# *before* the first answer. Each clause is a separate way for the proof to
# quietly disappear (no second fill, reusing Start, a bare `text=` wait that is
# green off the header title, or the count moved after the reply).
case_name="test_j3_spec_carries_the_midrun_followup"
python3 - "$WT/rsi/runtime/ux/journeys.json" <<'PY' || fail "$case_name: the J3 spec lost the mid-run follow-up"
import json
import sys

spec = json.load(open(sys.argv[1], encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]
REPLY = "Fake reply from the journey fake agent."

def at(pred, start=0):
    for i in range(start, len(steps)):
        if isinstance(steps[i], list) and pred(steps[i]):
            return i
    return -1

start = at(lambda st: st[0] == "send" and ("开始" in str(st[1]) or "Start" in str(st[1])))
assert start >= 0, "J3 has no Start send"
prompt = next((str(st[2]) for st in steps
               if st[0] == "fill" and "textarea" in str(st[1])), "")
fill = at(lambda st: st[0] == "fill" and "textarea" in str(st[1])
          and str(st[2]).strip() not in ("", prompt), start + 1)
assert fill >= 0, "no second fill after Start (the mid-run follow-up)"
follow = str(steps[fill][2])
assert follow.strip(), "the mid-run follow-up is empty"
send = at(lambda st: st[0] == "send"
          and "开始" not in str(st[1]) and "Start" not in str(st[1])
          and "打断" not in str(st[1]) and "nterrupt" not in str(st[1]), fill + 1)
assert send >= 0, "no queue Send after the follow-up (the only send is Start)"
wait = at(lambda st: st[0] == "wait" and str(st[1]).startswith("css=")
          and "[role=region]" in str(st[1]) and follow in str(st[1]), send + 1)
assert wait >= 0, "no transcript-scoped css= wait naming the follow-up"
count = at(lambda st: st[0] == "count" and str(st[1]).startswith("text=")
           and REPLY in str(st[1]) and str(st[2]) == "0", send + 1)
assert count >= 0, "no count of the reply = 0 before it lands"
reply = at(lambda st: st[0] == "wait" and str(st[1]).startswith("text=")
           and REPLY in str(st[1]), send + 1)
assert reply >= 0, "no reply wait"
assert count < reply, "the reply count must come before the reply wait"
timeout = steps[reply][2] if len(steps[reply]) > 2 else None
try:
    timeout_ms = float(timeout)
except (TypeError, ValueError):
    timeout_ms = 0
assert timeout_ms >= 20000, \
    "the reply wait must carry a per-step timeout >= 20000ms, got %r" % (timeout,)
print("J3 mid-run ok: %r typed, queue-sent, waited for in the transcript, reply counted 0 first"
      % follow)
PY
pass "$case_name"

case_name="test_j3_spec_rejects_a_midrun_walk_without_the_ordering_proof"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
spec_tmp="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec-mutant.XXXXXX")"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" <<'PY' || exit 1
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]
REPLY = "Fake reply from the journey fake agent."
kept, dropped = [], 0
for st in steps:
    if st[0] == "count" and REPLY in str(st[1]) and str(st[2]) == "0":
        dropped += 1
        continue
    kept.append(st)
if dropped != 1:
    raise SystemExit("expected one reply count of 0, dropped %d" % dropped)
spec["journeys"]["J3"]["steps"] = kept
json.dump(spec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec --spec "$spec_tmp" ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 1 ] || ! grep -q "counts the fake agent's reply as 0" "$log"; then
  cat "$log" >&2
  rm -f "$log" "$spec_tmp"
  fail "$case_name: --check-spec exited $rc without rejecting a mid-run walk with no ordering proof"
fi
rm -f "$log" "$spec_tmp"
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

# The Stop proof is the other half of the round: a held round is stopped, the
# Stop control leaves the screen, the stopped toast is read, and the message
# queued behind it is accounted for by the daemon's discard report. Each
# clause below is a separate way for that proof to disappear while the walk
# stays green (no Stop press, no gone, a silent discard, the shot moved before
# the report, or a "stopped" round that never had a queued message in it).
case_name="test_j3_spec_carries_the_stop_and_discard_proof"
python3 - "$WT/rsi/runtime/ux/journeys.json" <<'PY' || fail "$case_name: the J3 spec lost the Stop proof"
import json
import sys

spec = json.load(open(sys.argv[1], encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]
DISCARD = "queued prompt(s) discarded with the canceled task"

def at(pred, start=0):
    for i in range(start, len(steps)):
        if isinstance(steps[i], list) and pred(steps[i]):
            return i
    return -1

def stop_control(sel):
    return "aria-label" in str(sel) and ("停止" in str(sel) or "Stop" in str(sel))

replied = at(lambda st: st[0] == "shot" and st[1] == "replied")
assert replied >= 0, "J3 takes no replied shot"
click = at(lambda st: st[0] == "click" and stop_control(st[1]), replied + 1)
assert click >= 0, "no Stop click after the reply"
gone = at(lambda st: st[0] == "gone" and stop_control(st[1]), click + 1)
assert gone >= 0, "no gone on the Stop control after the click"
toast = at(lambda st: st[0] == "wait" and str(st[1]).startswith("css=") and "role=status" in str(st[1])
           and ("已停止当前轮次" in str(st[1]) or "Stopped current round" in str(st[1])), click + 1)
assert toast >= 0, "no wait for the stopped toast"
discard = at(lambda st: st[0] == "wait" and DISCARD in str(st[1]), click + 1)
assert discard >= 0, "no wait for the discard report"
assert "1 queued prompt(s)" in str(steps[discard][1]), \
    "the discard report wait names no count: %r" % (steps[discard][1],)
stopped = at(lambda st: st[0] == "shot" and st[1] == "stopped", discard + 1)
assert stopped >= 0, "no stopped shot after the discard report"
held = at(lambda st: st[0] == "fill" and "textarea" in str(st[1])
          and "[seed] slow" in str(st[2]), replied + 1)
assert held >= 0 and held < click, "the stopped round is not held open by a second [seed] slow prompt"
follow = at(lambda st: st[0] == "fill" and "textarea" in str(st[1])
            and str(st[2]).strip() and "[seed] slow" not in str(st[2]), held + 1)
assert follow >= 0 and follow < click, "no follow-up queued into the round that is stopped"
text = str(steps[follow][2])
send = at(lambda st: st[0] == "send" and "开始" not in str(st[1]) and "Start" not in str(st[1])
          and "打断" not in str(st[1]) and "nterrupt" not in str(st[1]), follow + 1)
assert send >= 0 and send < click, "the stopped round's follow-up is never queue-sent"
seen = at(lambda st: st[0] == "wait" and str(st[1]).startswith("css=")
          and "[role=region]" in str(st[1]) and text in str(st[1]), send + 1)
assert seen >= 0 and seen < click, "the stopped round's follow-up is never read in the transcript"
guide = at(lambda st: st[0] == "wait" and ("已排队：本轮结束后回答" in str(st[1])
           or "Queued — answered when the current round ends" in str(st[1])), send + 1)
assert guide >= 0 and guide < click, "no queued guide before Stop"
print("J3 stop ok: held round stopped, Stop gone, toast + discard report read, "
      "and the queued follow-up accounted for")
PY
pass "$case_name"

case_name="test_j3_spec_rejects_a_stop_without_the_control_leaving"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
spec_tmp="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec-mutant.XXXXXX")"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" <<'PY' || exit 1
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
steps = spec["journeys"]["J3"]["steps"]

def stop_control(sel):
    return "aria-label" in str(sel) and ("停止" in str(sel) or "Stop" in str(sel))

click = next((i for i, st in enumerate(steps) if st[0] == "click" and stop_control(st[1])), -1)
if click < 0:
    raise SystemExit("J3 has no Stop click to break")
gone = next((i for i in range(click + 1, len(steps))
             if steps[i][0] == "gone" and stop_control(steps[i][1])), -1)
if gone < 0:
    raise SystemExit("no gone on the Stop control after the click")
del steps[gone]
json.dump(spec, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec --spec "$spec_tmp" ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 1 ] || ! grep -q "never proves the Stop control left the screen" "$log"; then
  cat "$log" >&2
  rm -f "$log" "$spec_tmp"
  fail "$case_name: --check-spec exited $rc without rejecting a Stop that never leaves the screen"
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

echo "walk-mutant contract: 10/10 cases passed"
