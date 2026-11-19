#!/bin/bash
# test-walk-mutant.sh — hermetic contract for the R-walk-mutant red proof.
#
# The proof itself needs a browser and two UI builds, so it is not part of the
# gate. What the gate *can* check without one is that the committed mutants still
# point at the real hand-off pair, the row tap, the mid-run follow-up
# dispatch, the Stop that must cancel the round, the J2 review anchor, the
# rerun that must keep a comment (re-anchored, then 该行已变化), the shell
# that must not remount on a route change, the phone footer that must reopen the
# URL the reader left in each area, the phone's Back that must not reload the
# document, the unchecked PR branch that must not read as still checking, and
# the row menu that must keep its disabled 运行中 line; that the runner prints
# that same manifest; that a walk killed by the watchdog (TERM), a closed
# terminal (HUP) or Ctrl-C (INT) puts the tracked web/dist/index.html back and
# leaves no temp OUT behind; and that the J3 spec carries the mid-run ordering proof
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
SPEC_INDEX="$WT/rsi/runtime/ux/journeys.json"
JOURNEYS_DIR="$WT/rsi/runtime/ux/journeys"
SPECPY="$WT/rsi/runtime/ux/spec.py"
MERGE="$WT/rsi/runtime/merge.sh"

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
if not isinstance(entries, list) or len(entries) != 13:
    raise SystemExit("manifest must be exactly thirteen entries, got %r" % (entries,))
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
# The J10 mutant must drop the remembered URL the footer asks for, not the
# footer's labels or markup: the walk's settings memory proof fails only if the
# tab opens its bare root. The empty `slice` keeps both helpers referenced so
# the mutant build passes noUnusedLocals, and appends the root path.
j10 = next((e for e in entries if e["file"].endswith("PhoneFooter.tsx")), None)
if j10 is None:
    raise SystemExit("no J10 entry for ui/src/components/layout/PhoneFooter.tsx")
if "--walk-once J10" not in j10["test"]:
    raise SystemExit("the J10 entry's `test` does not walk J10 (--walk-once J10)")
if "slice(0, 0)" not in j10["new"] or "phoneTabUrl" not in j10["new"] or "returnListUrl" not in j10["new"]:
    raise SystemExit("the J10 mutant does not throw the remembered URL away while keeping both helpers used")
if "R-f5-tab-state" not in j10["new"]:
    raise SystemExit("the J10 mutant does not name the item it breaks (no R-f5-tab-state marker)")
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
# The J5 mutant must drop the running status line from the row menu, not the
# menu's actions: J5's rename/pin/archive/delete waits would stay green if only
# a render detail changed. `runningNow && false` keeps the tone test referenced
# so the mutant build passes noUnusedLocals while esbuild drops the branch.
rowmenu = next((e for e in entries
                if e["file"] == "ui/src/components/sessions/SessionRow.tsx"), None)
if rowmenu is None:
    raise SystemExit("no J5 entry for ui/src/components/sessions/SessionRow.tsx")
if "runningNow" not in rowmenu["old"] or '"running"' not in rowmenu["old"]:
    raise SystemExit("the J5 mutant does not select the running status item")
if "runningNow && false" not in rowmenu["new"]:
    raise SystemExit("the J5 mutant does not make the running item unreachable "
                     "while keeping the tone test used")
if 'id: "running"' not in rowmenu["new"]:
    raise SystemExit("the J5 mutant removes more than the branch condition")
if "--walk-once J5" not in rowmenu["test"]:
    raise SystemExit("the J5 entry's `test` does not walk J5 (--walk-once J5)")
# The J11 mutant must make the phone's Back a page load: a full document
# navigation throws away the shell and the kept-alive panes, which is the flash
# F4 exists to prevent, and J11's `node` assertion is what names it. The break
# sits on the phone's own Back helper, so J9 (no Back steps) stays green and
# the phone claim has its own proof. Leaving client-side history back reachable
# would let the walk stay green, so `navigate(-1)` must be gone from `new`.
phone = next((e for e in entries if e["file"].endswith("ui/src/lib/phoneBack.ts")
              and "--walk-once J11" in e["test"]), None)
if phone is None:
    raise SystemExit("no J11 entry for ui/src/lib/phoneBack.ts")
if "navigate(-1)" not in phone["old"]:
    raise SystemExit("the J11 mutant does not select the phone's history Back")
if 'window.location.assign("/sessions")' not in phone["new"] or "navigate(-1)" in phone["new"]:
    raise SystemExit("the J11 mutant does not turn the phone's Back into a document load")
if "R-f4-switch-phone" not in phone["new"]:
    raise SystemExit("the J11 mutant does not name the item it breaks (no R-f4-switch-phone marker)")
# The J13 mutant must refuse the PR tab's address in the parser: the tab still
# opens, but `?panel=pr` names no place, so a cold arrival draws no PR surface
# and the walk's selected-tab waits redden while the query bytes stay put.
# Breaking the patcher instead would leave the cold leg green.
panel_exit = next((e for e in entries if e["file"] == "ui/src/lib/workspaceDeepLink.ts"), None)
if panel_exit is None:
    raise SystemExit("no J13 entry for ui/src/lib/workspaceDeepLink.ts")
if '"pr"' not in panel_exit["old"] or '"pr"' in panel_exit["new"]:
    raise SystemExit("the J13 mutant does not refuse the PR panel value in parseWorkspaceLink")
if "--walk-once J13" not in panel_exit["test"]:
    raise SystemExit("the J13 entry's `test` does not walk J13 (--walk-once J13)")
print("manifest ok: %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s and %s, one occurrence of each `old`"
      % (j3["file"], j7["file"], j10["file"], follow["file"], review["file"],
         rerun["file"], stop["file"], shell["file"], pr["file"], rowmenu["file"],
         phone["file"], panel_exit["file"]))
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

# --walk-once builds over the tracked web/dist/index.html and restores the
# committed entry from a trap. Leaving that to the EXIT trap alone makes the
# restore depend on what the shell does when a watchdog's TERM, a closed
# terminal's HUP or a Ctrl-C's INT cuts the build short, so the runner installs
# the same restore on all four traps. The --trap-check seam replays that window
# against a throwaway worktree: back the entry up, install the same restore,
# let the "build" overwrite it, send itself the signal. Each signal must exit
# conventionally (TERM 143, HUP 129, INT 130), restore the sentinel byte for
# byte and remove its temp OUT. The status is read raw, not as `$?`: a shell
# killed by the signal reports negative there, so only a handler that ran can
# produce the positive 128+signal status. The case also pins the --walk-once
# wiring (traps and backup before the build), which the seam cannot see because
# it installs its own. No node, npm or browser is involved, so this runs in the
# hermetic shell job.
case_name="test_walk_mutant_restores_dist_on_term_hup_and_int"
[ -f "$RUNNER" ] || fail "$case_name: rsi/runtime/ux/walk-mutant-test.sh is missing"
trap_root="$(mktemp -d "${TMPDIR:-/tmp}/walk-mutant-trap.XXXXXX")"
run_trap_check() { # <signal>: one throwaway worktree per signal
  local sig="$1" wt="$trap_root/$1"
  mkdir -p "$wt/web/dist" "$wt/tmp"
  # The committed entry the restore must reproduce exactly, and the mutant line
  # the seam writes in its place must not survive the signal.
  printf '%s\n' '<!doctype html>' \
    '<!-- walk-mutant contract: the committed console entry -->' \
    '<script type="module" src="/assets/index-COMMITTED.js"></script>' > "$wt/web/dist/index.html"
  cp "$wt/web/dist/index.html" "$wt/entry.expected"
  # TMPDIR points inside the fixture, so the runner's OUT is findable
  # afterwards: a temp dir left behind is a restore that never ran.
  #
  # Two reasons to launch through python3 (already a runner dependency)
  # rather than `bash ... --trap-check` directly:
  #
  # 1. check.sh starts this suite as an asynchronous child, where bash ignores
  #    SIGINT and an ignored-at-entry signal cannot be trapped. A real Ctrl-C,
  #    a closing terminal and the watchdog all reach the runner with default
  #    dispositions, so the child resets them before exec.
  # 2. `$?` in a shell folds "died from the signal" and "exited 143" into the
  #    same 143. The raw wait status keeps them apart: a negative return code
  #    means no handler ran and the signal killed the shell; the positive
  #    conventional status is only reachable through the restore handler's
  #    `exit`. That is what makes this case able to redden when the signal
  #    traps are missing instead of merely observing that bash died.
  TMPDIR="$wt/tmp" python3 - "$RUNNER" "$wt" "$sig" "$wt/rc" >"$wt/run.log" 2>&1 <<'PY'
import signal
import subprocess
import sys

runner, worktree, sig, rcfile = sys.argv[1:5]

def reset_signals():
    for s in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
        signal.signal(s, signal.SIG_DFL)

rc = subprocess.call(["bash", runner, "--trap-check", worktree, sig],
                     preexec_fn=reset_signals)
open(rcfile, "w").write("%d\n" % rc)
PY
}
for sig in TERM HUP INT; do
  run_trap_check "$sig"
done
for sig in TERM HUP INT; do
  wt="$trap_root/$sig"
  case "$sig" in
    TERM) want=143 ;;
    HUP) want=129 ;;
    INT) want=130 ;;
  esac
  [ -s "$wt/rc" ] || {
    cat "$wt/run.log" >&2
    rm -rf "$trap_root"
    fail "$case_name: $sig produced no status (the launcher wrote no rc)"
  }
  rc="$(cat "$wt/rc")"
  if [ "$rc" -ne "$want" ]; then
    cat "$wt/run.log" >&2
    rm -rf "$trap_root"
    fail "$case_name: $sig exited $rc, want $want (a negative status means the shell died of the signal: the signal handler did not run)"
  fi
  if ! cmp -s "$wt/web/dist/index.html" "$wt/entry.expected"; then
    echo "--- web/dist/index.html after $sig ---" >&2
    cat "$wt/web/dist/index.html" >&2
    rm -rf "$trap_root"
    fail "$case_name: $sig left the mutant entry in web/dist/index.html"
  fi
  # TMPDIR is the fixture's own empty dir, so anything left in it is OUT. Not a
  # name match: the runner owns the mktemp prefix, and a renamed prefix would
  # make a prefix assertion pass while the temp dir leaked.
  leftovers="$(find "$wt/tmp" -mindepth 1 -print)"
  if [ -n "$leftovers" ]; then
    rm -rf "$trap_root"
    fail "$case_name: $sig left its temp OUT behind: $leftovers"
  fi
done
# The seam proves the restore handler; it installs its own traps and takes its
# own backup, so it cannot see whether --walk-once is wired to them. Assert the
# normal build path too: both calls before the build, inside the post-dispatch
# block. Deleting either from --walk-once would otherwise leave this suite
# green while a real watchdog TERM during a build restores nothing.
if ! python3 - "$RUNNER" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
try:
    start = text.index('cd "$WT" || unavailable "cannot enter the worktree root"')
    build = text.index('( cd ui && npm run build )', start)
except ValueError:
    raise SystemExit("cannot find the --walk-once build block in the runner")
block = text[start:build]
# Exact call lines, not substrings: the prose above the calls names both
# helpers, so a substring check would stay green after the calls were deleted.
calls = [line.strip() for line in block.splitlines()]
missing = [call for call in ("trap_restore_dist", "backup_dist") if call not in calls]
if missing:
    raise SystemExit("--walk-once no longer prepares the restore before the build: missing "
                     + ", ".join(missing))
print("--walk-once wiring ok: traps and backup installed before the build")
PY
then
  rm -rf "$trap_root"
  fail "$case_name: the --walk-once build path is not wired to the restore"
fi
rm -rf "$trap_root"
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$WT/rsi/runtime/ux/spec.py" <<'PY' || fail "$case_name: the J3 spec lost the mid-run follow-up"
import json
import subprocess
import sys

spec = json.loads(subprocess.check_output([sys.executable, sys.argv[2], "--resolve", sys.argv[1]]))
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" "$WT/rsi/runtime/ux/spec.py" <<'PY' || exit 1
import json
import subprocess
import sys

src, dst, specpy = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", src]))
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" "$WT/rsi/runtime/ux/spec.py" <<'PY' || exit 1
import json
import subprocess
import sys

src, dst, specpy = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", src]))
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" "$WT/rsi/runtime/ux/spec.py" <<'PY' || exit 1
import json
import subprocess
import sys

src, dst, specpy = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", src]))
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$WT/rsi/runtime/ux/spec.py" <<'PY' || fail "$case_name: the J3 spec lost the Stop proof"
import json
import subprocess
import sys

spec = json.loads(subprocess.check_output([sys.executable, sys.argv[2], "--resolve", sys.argv[1]]))
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" "$WT/rsi/runtime/ux/spec.py" <<'PY' || exit 1
import json
import subprocess
import sys

src, dst, specpy = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", src]))
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
python3 - "$WT/rsi/runtime/ux/journeys.json" "$spec_tmp" "$WT/rsi/runtime/ux/spec.py" <<'PY' || exit 1
import json
import subprocess
import sys

src, dst, specpy = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", src]))
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

# --- the journey spec is an index, one file per journey ---------------------
# Two walk PRs that each add a leg used to conflict in one 287-line JSON and
# the second waited for the first (measured 2026-11-18, six idle fills). The
# loader lands first; the bodies move one slice at a time. The reader is the
# contract: an index entry names a file relative to the index, the body
# resolves verbatim, inline bodies (the real spec, the smoke fixture, the
# reduced mutant specs) pass through, and a missing body is loud rather than a
# skipped journey.

tmpbase="${TMPDIR:-/tmp}"; tmpbase="${tmpbase%/}"

write_split_fixture() { # <dir> -> index with one on-disk body and two inline bodies
  local dir="$1"
  mkdir -p "$dir/journeys"
  cat > "$dir/journeys.json" <<'JSON'
{
  "_doc": "fixture index: one body on disk, two inline",
  "viewports": {"phone": "390x844"},
  "journeys": {
    "J1": "journeys/J1.json",
    "J2": {"title": "inline body", "steps": [["goto", "/inline"]]},
    "J10": {"title": "inline body: natural order, not lexical", "steps": [["goto", "/ten"]]}
  },
  "paths": [["ui/src/", ["J1"]]]
}
JSON
  cat > "$dir/journeys/J1.json" <<'JSON'
{"title": "on disk", "steps": [["goto", "/disk"]]}
JSON
}

case_name="test_spec_split_index_resolves_and_inline_bodies_pass_through"
[ -f "$SPECPY" ] || fail "$case_name: $SPECPY is missing"
tmp="$(mktemp -d "$tmpbase/walk-mutant-spec-split.XXXXXX")"
write_split_fixture "$tmp"
ids="$(python3 "$SPECPY" --ids "$tmp/journeys.json" 2>&1)" || fail "$case_name: --ids exited non-zero: $ids"
# J10 last: lexical order would print "J1 J10 J2", natural order "J1 J2 J10".
[ "$ids" = "J1 J2 J10" ] || { rm -rf "$tmp"; fail "$case_name: --ids printed '$ids'"; }
python3 - "$tmp/journeys.json" "$SPECPY" <<'PY' || { rm -rf "$tmp"; fail "$case_name: the index did not resolve one body per journey"; }
import json
import os
import subprocess
import sys

index_path, specpy = sys.argv[1], sys.argv[2]
index = json.load(open(index_path, encoding="utf-8"))
resolved = json.loads(subprocess.check_output(
    [sys.executable, specpy, "--resolve", index_path]))
assert list(resolved["journeys"]) == ["J1", "J2", "J10"], "resolve lost or added a journey"
on_disk = json.load(open(os.path.join(os.path.dirname(index_path), "journeys", "J1.json"),
                         encoding="utf-8"))
assert resolved["journeys"]["J1"] == on_disk, "J1 did not resolve verbatim"
assert resolved["journeys"]["J2"] == index["journeys"]["J2"], "the inline body changed"
assert resolved["journeys"]["J10"] == index["journeys"]["J10"], "the inline J10 body changed"
assert resolved.get("viewports") == index.get("viewports"), "viewports changed"
assert resolved.get("paths") == index.get("paths"), "paths changed"
print("split ok: one body per journey, inline pass-through")
PY
rm -rf "$tmp"
pass "$case_name"

case_name="test_spec_split_missing_file_is_loud"
tmp="$(mktemp -d "$tmpbase/walk-mutant-spec-split.XXXXXX")"
write_split_fixture "$tmp"
missing="$tmp/journeys/J1.json"
rm -f "$missing"
for mode in --ids --resolve; do
  err="$(python3 "$SPECPY" "$mode" "$tmp/journeys.json" 2>&1 >/dev/null)"
  rc=$?
  if [ "$rc" -ne 2 ] || [ -z "$err" ]; then
    rm -rf "$tmp"
    fail "$case_name: $mode exited $rc (want 2 with stderr) for a missing J1: $err"
  fi
  case "$err" in *J1*) ;; *) rm -rf "$tmp"; fail "$case_name: $mode stderr does not name J1: $err" ;; esac
  case "$err" in *"$missing"*) ;; *) rm -rf "$tmp"; fail "$case_name: $mode stderr does not name $missing: $err" ;; esac
done
rm -rf "$tmp"
pass "$case_name"

case_name="test_spec_split_walk_check_spec_passes"
command -v node >/dev/null 2>&1 || fail "$case_name: node is not on PATH"
log="$(mktemp "${TMPDIR:-/tmp}/walk-mutant-spec.XXXXXX")"
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  cat "$log" >&2
  rm -f "$log"
  fail "$case_name: --check-spec exited $rc against the real inline spec"
fi
# And once with a body on disk: the walker's loader, not only spec.py, must
# resolve an index entry relative to the index. Bodies the real index already
# names are carried over too, so this case keeps working as more journeys move.
tmp="$(mktemp -d "$tmpbase/walk-mutant-spec-split.XXXXXX")"
python3 - "$SPEC_INDEX" "$tmp" "$SPECPY" <<'PY' || { rm -rf "$tmp"; rm -f "$log"; fail "$case_name: cannot build the moved-J1 fixture"; }
import json
import os
import shutil
import subprocess
import sys

src, out, specpy = sys.argv[1], sys.argv[2], sys.argv[3]
# Read the shipped J1 through the loader: it may already be a body file, and
# this fixture must not carry a second reader that assumes an inline copy.
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", src]))
os.makedirs(os.path.join(out, "journeys"), exist_ok=True)
bodies = os.path.join(os.path.dirname(os.path.abspath(src)), "journeys")
if os.path.isdir(bodies):
    for name in sorted(os.listdir(bodies)):
        if name.endswith(".json"):
            shutil.copyfile(os.path.join(bodies, name),
                            os.path.join(out, "journeys", name))
body = spec["journeys"]["J1"]
with open(os.path.join(out, "journeys", "J1.json"), "w", encoding="utf-8") as fh:
    json.dump(body, fh, ensure_ascii=False)
index = json.load(open(src, encoding="utf-8"))
index["journeys"] = dict(index["journeys"])
index["journeys"]["J1"] = "journeys/J1.json"
with open(os.path.join(out, "journeys.json"), "w", encoding="utf-8") as fh:
    json.dump(index, fh, ensure_ascii=False)
PY
( cd "$WT" && node rsi/runtime/ux/walk.mjs --check-spec --spec "$tmp/journeys.json" ) >"$log" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  cat "$log" >&2
  rm -rf "$tmp"
  rm -f "$log"
  fail "$case_name: --check-spec exited $rc with J1 resolved from journeys/J1.json"
fi
rm -rf "$tmp"
rm -f "$log"
pass "$case_name"

# The UX-gate header names the spec revision, so a per-journey edit must move
# it: the header must name the spec the gate actually walked, not just the index.
case_name="test_spec_split_spec_rev_tracks_a_journey_edit"
tmp="$(mktemp -d "$tmpbase/walk-mutant-spec-rev.XXXXXX")"
mkdir -p "$tmp/rsi/runtime/ux"
write_split_fixture "$tmp/rsi/runtime/ux"
commit_tmp() { ( cd "$tmp" && git add -A && git -c user.email=owner@example.com -c user.name=walk-mutant \
  -c commit.gpgsign=false commit -qm "$1" ); }
git -C "$tmp" init -q || { rm -rf "$tmp"; fail "$case_name: git init failed"; }
commit_tmp one || { rm -rf "$tmp"; fail "$case_name: first commit failed"; }
rev1="$(RSI_CTRL="$WT" bash "$MERGE" --spec-rev "$tmp" 2>&1)"
case "$rev1" in
  ""|*[!0-9a-f]*) rm -rf "$tmp"; fail "$case_name: spec-rev printed '$rev1', not lowercase hex" ;;
esac
[ ${#rev1} -eq 12 ] || { rm -rf "$tmp"; fail "$case_name: spec-rev printed '$rev1', not 12 hex"; }
python3 - "$tmp/rsi/runtime/ux/journeys/J1.json" <<'PY' || { rm -rf "$tmp"; fail "$case_name: cannot edit J1"; }
import json
import sys

path = sys.argv[1]
body = json.load(open(path, encoding="utf-8"))
body["_probe"] = "spec-rev tracks a per-journey edit"
json.dump(body, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
commit_tmp two || { rm -rf "$tmp"; fail "$case_name: second commit failed"; }
rev2="$(RSI_CTRL="$WT" bash "$MERGE" --spec-rev "$tmp" 2>&1)"
[ "$rev1" != "$rev2" ] || { rm -rf "$tmp"; fail "$case_name: a J1 edit did not move spec-rev ($rev1)"; }
empty="$(mktemp -d "$tmpbase/walk-mutant-spec-rev-empty.XXXXXX")"
git -C "$empty" init -q
git -C "$empty" -c user.email=owner@example.com -c user.name=walk-mutant \
  -c commit.gpgsign=false commit -q --allow-empty -m empty
dash="$(RSI_CTRL="$WT" bash "$MERGE" --spec-rev "$empty" 2>&1)"
[ "$dash" = "-" ] || { rm -rf "$tmp" "$empty"; fail "$case_name: spec-rev without journeys.json printed '$dash', want -"; }
rm -rf "$tmp" "$empty"
pass "$case_name"

# The fixtures above prove the loader; this case pins the shipped index, so a
# body move cannot be faked by a stale inline copy or a body that drifted from
# it. Every string entry must be exactly `journeys/<id>.json` and resolve
# verbatim with a title and steps; J4 and J8 are still inline objects and stay
# out of the moved set until their own slices. J2 gains legs, so the step count
# is deliberately not asserted.
case_name="test_spec_real_index_moved_bodies_resolve"
[ -f "$SPECPY" ] || fail "$case_name: $SPECPY is missing"
python3 - "$SPEC_INDEX" "$SPECPY" "$JOURNEYS_DIR" <<'PY' || fail "$case_name: a moved journey body is still inline, missing on disk or drifted from the index"
import json
import os
import subprocess
import sys

index_path, specpy, journeys_dir = sys.argv[1], sys.argv[2], sys.argv[3]
index = json.load(open(index_path, encoding="utf-8"))
journeys = index.get("journeys") or {}
MOVED = ["J1", "J2", "J3", "J5", "J6", "J7", "J9", "J10", "J11", "J12"]
for jid in MOVED:
    entry = journeys.get(jid)
    assert entry == "journeys/%s.json" % jid, \
        "%s is still inline in the index (or names another path): %r" % (jid, entry)
resolved = json.loads(subprocess.check_output(
    [sys.executable, specpy, "--resolve", index_path]))
moved = []
for jid, entry in journeys.items():
    if not isinstance(entry, str):
        continue
    body_path = os.path.join(journeys_dir, os.path.basename(entry))
    body = json.load(open(body_path, encoding="utf-8"))
    steps = body.get("steps")
    assert isinstance(steps, list) and steps, "%s has no steps" % body_path
    title = body.get("title")
    assert isinstance(title, str) and title.strip(), "%s has no title" % body_path
    assert resolved["journeys"][jid] == body, \
        "the resolved %s is not the body file %s" % (jid, body_path)
    moved.append(jid)
j2 = json.load(open(os.path.join(journeys_dir, "J2.json"), encoding="utf-8"))
assert j2["title"].startswith("Mac: search last week's chat"), \
    "J2.json title drifted: %r" % (j2.get("title"),)
assert j2.get("viewports") == ["mac", "mac-wide"], \
    "J2.json viewports drifted: %r" % (j2.get("viewports"),)
assert resolved.get("viewports") == index.get("viewports"), "top-level viewports changed"
assert resolved.get("paths") == index.get("paths"), "top-level paths changed"
print("real index ok: %s resolve verbatim from their own files"
      % " ".join(sorted(moved, key=lambda jid: int(jid[1:]))))
PY
pass "$case_name"

# A newly moved body must be loud when its file disappears, not a skipped
# journey: the real index is copied with only J9's body removed.
case_name="test_spec_real_index_missing_moved_body_names_the_path"
tmp="$(mktemp -d "$tmpbase/walk-mutant-missing.XXXXXX")"
mkdir -p "$tmp/journeys"
cp "$SPEC_INDEX" "$tmp/journeys.json"
cp "$JOURNEYS_DIR"/*.json "$tmp/journeys/"
rm -f "$tmp/journeys/J9.json"
err="$(python3 "$SPECPY" --ids "$tmp/journeys.json" 2>&1 >/dev/null)"
rc=$?
if [ "$rc" -ne 2 ] || [ -z "$err" ]; then
  rm -rf "$tmp"
  fail "$case_name: --ids exited $rc (want 2 with stderr) for a missing J9: $err"
fi
case "$err" in *J9*) ;; *) rm -rf "$tmp"; fail "$case_name: --ids stderr does not name J9: $err" ;; esac
case "$err" in *"$tmp/journeys/J9.json"*) ;; *) rm -rf "$tmp"; fail "$case_name: --ids stderr does not name $tmp/journeys/J9.json: $err" ;; esac
rm -rf "$tmp"
pass "$case_name"

# Each PR proof belongs to its own leg. A later PR search or selected tab
# cannot make up for one deleted from the cold arrival, reload or Forward.
case_name="test_j13_spec_rejects_missing_pr_address_proofs"
python3 - "$SPEC_INDEX" "$SPECPY" "$WALKER" <<'PYTEST' || fail "$case_name: a missing PR proof was accepted"
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

index, specpy, walker = sys.argv[1:]
spec = json.loads(subprocess.check_output([sys.executable, specpy, "--resolve", index]))
steps = spec["journeys"]["J13"]["steps"]
cold = next(i for i, st in enumerate(steps) if st == ["goto", "/tasks/{conversation}?panel=pr"])
forward = next(i for i, st in enumerate(steps) if st[0] == "history-forward")
sheet = next(i for i, st in enumerate(steps) if st == ["click", "/^Pull [Rr]equest$/"])
cases = {
    "cold address read": cold + 1,
    "cold selected tab": cold + 2,
    "refresh load": cold + 4,
    "refresh address read": cold + 5,
    "refresh selected tab": cold + 6,
    "cold Back": cold + 8,
    "Forward": forward,
    "Forward address read": forward + 1,
    "Forward selected tab": forward + 2,
    "action-sheet PR press": sheet,
    "action-sheet address read": sheet + 1,
    "action-sheet selected tab": sheet + 2,
}
with tempfile.TemporaryDirectory(prefix="j13-pr-contract-") as tmp:
    target = Path(tmp) / "spec.json"
    for label, pos in cases.items():
        mutant = copy.deepcopy(spec)
        del mutant["journeys"]["J13"]["steps"][pos]
        target.write_text(json.dumps(mutant))
        result = subprocess.run(["node", walker, "--check-spec", "--spec", str(target)],
                                capture_output=True, text=True)
        assert result.returncode != 0, label + " deletion passed"
        assert "J13" in result.stdout + result.stderr, label + " failed for another reason"
print("J13 PR contract rejects all twelve deleted address or surface proofs")
PYTEST
pass "$case_name"

echo "walk-mutant contract: 18/18 cases passed"
