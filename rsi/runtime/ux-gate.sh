#!/bin/bash
# ux-gate.sh <worktree> <slug> <item> <pr#> <diff-hash> [role]
#   ux-gate.sh --accepts-review <review-file>   exit 0 only when the gate's own review decision
#                                               (grounding + thresholds) accepts the cached text;
#                                               merge.sh asks before reusing a strong-ux cache
# The UX gate of the merge lane (CEO 2026-11-15, after Ethan: "don't ship something that is not even demo-quality"). For a PR that touches
# UI source it (1) walks the affected journeys in the real console at 390/1100(/1280) on a throwaway daemon and saves screenshots,
# (2) has a vision reviewer (Hydrogen first — multimodal; gpt-6.1-sol fallback) score the five rubric
# axes from rsi/roles/ux-reviewer.md, (3) decides. Threshold (recomputed here, the model's own verdict is not trusted): every axis >= 3
# AND mean >= 3.5 AND no walk hard failure. Writes state/merge/<slug>.ux.txt (the sendback body) and state/ux/<slug>/ (scores.json).
# exit 0 PASS | 1 FAIL (sendback body written) | 2 UNAVAILABLE (infra; the PR stays verified but is NOT merged, needs-ceo note)
#   An unavailable outcome starts a cooldown (state/merge/<slug>.uxcooldown, RSI_UX_COOLDOWN_MIN minutes, default 30): later ticks for
#   the same diff exit 2 at once, without walking, dispatching or deleting the last walk's screenshots. A new diff hash retries at once.
#   RSI_UX_COOLDOWN_MIN=0    disable the cooldown (test hook)
#   RSI_UX_WALK_CMD=<cmd>    test hook: run instead of the walker, gets the screenshot dir as $1, must leave walk.json + a .png there
#                            a red run's confirm re-walk passes the journey selector (J2,J9) as an optional $2;
#                            older callers (retry-test.sh) pass only $1 and stay valid
#   RSI_UX_REVIEW_CMD=<cmd>  test hook: run instead of the model, gets the prompt file as $1 and prints the reviewer text
#                            (a non-zero exit without UX_SCORES counts as unavailable, same as a failed dispatch)
#   RSI_UX_STATE=<dir>       state root override for tests; defaults to the worktree's rsi/state. Not RSI_STATE: the loop
#                            already exports that as the controller state, so it cannot serve as a test-local override.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
if [ -n "${RSI_UX_STATE:-}" ]; then STATE="$RSI_UX_STATE"; export RSI_STATE="$STATE"; fi
# 2c. A below-3 axis must be grounded in a finding that names it (CEO 2026-11-19, #383).
# #383 was sent to a rework round on `feedback=2` while its findings said "no regression
# observed" and never named the axis: a lane, an 11-minute walk and a vision review billed to
# an unexplained number. A score is evidence, not a verdict: re-ask the same reviewer once for
# the evidence, and when it still cannot name it, record "no verdict" (unavailable) instead of
# sending the PR back. The axis word inside the machine `UX_SCORES:` line never counts.
# Defined before any state is touched: merge.sh asks the same predicate before it reuses a
# cached strong UX review, so the rule lives here once instead of being restated there.
ungrounded_axes() { # <review-file> -> comma list of axes <3 that no finding line names
  python3 - "$1" <<'PY'
import re, sys
txt = open(sys.argv[1], errors="replace").read()
axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
m = re.findall(r"UX_SCORES:\s*(.+)", txt)
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]):
        sc[k] = int(v)
body = "\n".join(l for l in txt.splitlines() if not re.match(r"^\s*[-*_>#]*\s*UX_(SCORES|VERDICT):", l))
print(",".join(a for a in axes if a in sc and sc[a] < 3 and not re.search(r"(?i)\b%s\b" % a, body)))
PY
}
# The gate's own review decision, shared with merge.sh's cached-review reuse: only a review this
# accepts may become a verdict by reuse. Exit 0 accept, 1 reject.
accepts_review() { # <review-file>
  [ -s "$1" ] || return 1
  [ -z "$(ungrounded_axes "$1" 2>/dev/null)" ] || return 1
  python3 - "$1" <<'PY'
import re, sys
axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
txt = open(sys.argv[1], errors="replace").read()
m = re.findall(r"UX_SCORES:\s*(.+)", txt)
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]): sc[k] = int(v)
sys.exit(0 if all(a in sc for a in axes) and all(sc[a] >= 3 for a in axes) and sum(sc[a] for a in axes) / 5 >= 3.5 else 1)
PY
}
if [ "${1:-}" = "--accepts-review" ]; then accepts_review "${2:-}"; exit $?; fi
WT="$1"; SLUG="$2"; ITEM="$3"; N="$4"; DH="$5"; ROLE="${6:-reviewer}"
UXD="$STATE/ux/$SLUG"; SHOTS="$STATE/shots/$SLUG/journeys"; ERR="$STATE/merge/$SLUG.ux.txt"
COOL="$STATE/merge/$SLUG.uxcooldown"; mkdir -p "$STATE/merge"
COOL_MIN="${RSI_UX_COOLDOWN_MIN:-30}"; case "$COOL_MIN" in ''|*[!0-9]*) COOL_MIN=30;; esac
unavailable() { # reason: record it, start the cooldown, exit 2 (never PASS/FAIL, never delete walk evidence)
  local rsn; rsn="$(printf '%s' "$1" | tr '\n' ' ')"   # the marker is one line: <expiry> <hash> <reason>
  printf '%s\n' "$1" > "$UXD/unavailable.txt"
  if [ "$COOL_MIN" -gt 0 ]; then
    printf '%s %s %s\n' "$(( $(date +%s) + COOL_MIN * 60 ))" "$DH" "$rsn" > "$COOL" 2>/dev/null || true
  fi
  exit 2
}
# 0. cooldown from an earlier unavailable run on this exact diff: no walk, no dispatch, no rm -rf of $SHOTS
if [ "$COOL_MIN" -gt 0 ] && [ -s "$COOL" ]; then
  CEXP=""; CDH=""; CRSN=""; read -r CEXP CDH CRSN < "$COOL" 2>/dev/null || true
  if [ "${CDH:-}" = "$DH" ] && [ "${CEXP:-0}" -gt "$(date +%s)" ] 2>/dev/null; then
    mkdir -p "$UXD"
    printf '%s\n' "${CRSN:-cooldown}" > "$UXD/unavailable.txt"
    echo "ux-gate: cooling down until $(date -r "$CEXP" '+%F %H:%M' 2>/dev/null || echo "epoch $CEXP") (${CRSN:-cooldown})"
    exit 2
  fi
fi
rm -rf "$SHOTS"; mkdir -p "$UXD" "$SHOTS"; : > "$ERR"
$GIT -C "$WT" diff --name-only origin/main...HEAD > "$UXD/changed.txt"
# 1. walk (affected journeys only; unmapped paths walk everything)
if [ -n "${RSI_UX_WALK_CMD:-}" ]; then bash -c "$RSI_UX_WALK_CMD" _ "$SHOTS" > "$UXD/walk.out" 2>&1 || true
else bash "$RSI_DIR/runtime/ux-walk.sh" "$WT" "$SHOTS" "@$UXD/changed.txt" > "$UXD/walk.out" 2>&1 || true; fi
if [ -e "$SHOTS/UNAVAILABLE" ]; then unavailable "ux walk unavailable: $(cat "$SHOTS/UNAVAILABLE")"; fi
[ -s "$SHOTS/walk.json" ] || unavailable "walker wrote no walk.json"
HARD="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(d.get("hardFail",[])))' "$SHOTS/walk.json")"
# Known walk artefacts (state/ux-known-artifacts.txt): exact hard-fail lines that are environment
# defects, not this PR's. They are printed and saved, never silently swallowed; an empty or absent
# file leaves the gate exactly as strict as before.
KNOWN="$STATE/ux-known-artifacts.txt"
UX_IGNORED=""
if [ -n "$HARD" ] && [ -s "$KNOWN" ]; then
  UX_IGNORED="$(printf '%s\n' "$HARD" | grep -F -f "$KNOWN" || true)"
  if [ -n "$UX_IGNORED" ]; then
    HARD="$(printf '%s\n' "$HARD" | grep -v -F -f "$KNOWN" || true)"
    printf '%s\n' "$UX_IGNORED" > "$UXD/ignored.txt"
    echo "ux-gate: ignored known walk artefacts ($KNOWN):"
    printf '%s\n' "$UX_IGNORED" | sed 's/^/  - /'
  fi
fi
NSHOT="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
[ "$NSHOT" -gt 0 ] || unavailable "walk produced no screenshots"
# 1b. Confirm a red once before it bills a rework round (R-ux-gate-confirm-red, 2026-11-18).
# One hard-fail line from one walk used to convict a UI PR for a whole rework round; #296 was
# billed a 9-minute lane and $0.89 for `J9/mac: scroll-kept ...`, which three independent walks
# of the same tree could not reproduce. A red is now re-walked once, on the same tree, for the
# journeys its failing lines name. Only failures the second walk reproduces survive; the rest
# are recorded as flaked in the sendback and scores.json, so the rework lane and the retro can
# count false reds by source. A green run walks once and never creates $UXD/confirm. A confirm
# that cannot run keeps the first-walk failures: fail closed, never turn a red into "unavailable".
CONF_JSON="$UXD/confirm.json"; CONF_SUMMARY=""
rm -f "$CONF_JSON" "$UXD/confirm.txt" "$UXD/confirm.summary" "$UXD/confirm.hard"   # this attempt's evidence only
# This run's own evidence only: a stale UNAVAILABLE or walk.json from an earlier attempt on the
# same slug must not decide the confirmation.
rm -rf "$UXD/confirm"
if [ -n "$HARD" ]; then
  # A hard fail names its journey two ways: walk.mjs writes `<journey>/<viewport>: ` for a step
  # failure, and `<J<nn>>-<viewport>-<NN>-<step>: ` for a screenshot check such as "blank page"
  # or "horizontal page overflow". Both are localisable, so both select the re-walk; treating the
  # screenshot form as unattributable billed #330 a rework round for two blank-page lines its own
  # confirm walk could not reproduce. Only a line that names no journey at all is kept and skips
  # the confirm: re-walking everything would double the cost for a failure we cannot target.
  JOURNEYS="$(printf '%s\n' "$HARD" | sed -n -e 's#^\([A-Za-z0-9_]*\)/.*#\1#p' -e 's#^\(J[0-9][0-9]*\)-.*#\1#p' | sort -u | paste -sd, -)"
  if [ -n "$JOURNEYS" ]; then
    mkdir -p "$UXD/confirm"
    if [ -n "${RSI_UX_WALK_CMD:-}" ]; then
      bash -c "$RSI_UX_WALK_CMD" _ "$UXD/confirm" "$JOURNEYS" > "$UXD/confirm/walk.out" 2>&1; CRC=$?
    else
      bash "$RSI_DIR/runtime/ux-walk.sh" "$WT" "$UXD/confirm" "$JOURNEYS" > "$UXD/confirm/walk.out" 2>&1; CRC=$?
    fi
    CRSN=""; CHARD=""
    if [ -e "$UXD/confirm/UNAVAILABLE" ]; then CRSN="$(tr '\n' ' ' < "$UXD/confirm/UNAVAILABLE")"
    elif [ "${CRC:-0}" -eq 2 ]; then CRSN="walker exit 2"
    elif [ ! -s "$UXD/confirm/walk.json" ]; then CRSN="no confirm walk.json"
    else
      CHARD="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(d.get("hardFail",[])))' "$UXD/confirm/walk.json")" \
        || { CRSN="confirm walk.json unreadable"; CHARD=""; }
    fi
    # A confirm whose evidence cannot be parsed or decided keeps the first walk's red: an empty
    # CHARD would otherwise record every first-walk failure as flaked and could pass a real one.
    if [ -z "$CRSN" ]; then
      if [ -n "$CHARD" ] && [ -s "$KNOWN" ]; then
        CHARD="$(printf '%s\n' "$CHARD" | grep -v -F -f "$KNOWN" || true)"
      fi
      # Written to a file rather than captured: macOS bash 3.2 lexes quotes inside a heredoc
      # nested in $( ), so a body comment with an apostrophe breaks the parse. A standalone
      # heredoc is literal and keeps the python readable.
      python3 - "$HARD" "$CHARD" "$JOURNEYS" "$UXD/confirm.txt" "$CONF_JSON" "$UXD/confirm.summary" "$UXD/confirm.hard" <<'PY'
import json, re, sys
orig = [l for l in sys.argv[1].splitlines() if l]
conf = [l for l in sys.argv[2].splitlines() if l]
journeys = sys.argv[3]
def journey(line):
    m = re.match(r"^([A-Za-z0-9_]+)/", line) or re.match(r"^(J[0-9]+)-", line)
    return m.group(1) if m else ""
conf_set = set(conf)
reproduced = [l for l in orig if journey(l) and l in conf_set]
flaked = [l for l in orig if journey(l) and l not in conf_set]
unattributed = [l for l in orig if not journey(l)]
# The confirm walk's filtered lines are the surviving hard failures. A NEW line survives too:
# a flaky first red must not hide a real second one. Unattributable first-walk lines stay.
final = conf + unattributed
with open(sys.argv[4], "w") as f:
    f.write("journeys=%s reproduced=%d flaked=%d\n" % (journeys, len(reproduced), len(flaked)))
    for l in flaked:
        f.write(l + "\n")
summary = "walk confirm: re-walked %s once → reproduced=%d flaked=%d" % (journeys, len(reproduced), len(flaked))
if flaked:
    summary += "\nflaked (failed the first walk, not reproduced; not blocking):\n" + "\n".join(flaked)
open(sys.argv[6], "w").write(summary + "\n")
json.dump({"journeys": journeys, "reproduced": len(reproduced), "flaked": len(flaked)}, open(sys.argv[5], "w"))
open(sys.argv[7], "w").write("\n".join(final) + ("\n" if final else ""))
PY
      PYRC=$?
      [ "$PYRC" -eq 0 ] || CRSN="confirm decision failed"
    fi
    if [ -z "$CRSN" ]; then
      HARD="$(cat "$UXD/confirm.hard")"
      CONF_SUMMARY="$(cat "$UXD/confirm.summary")"
    else
      # Never unavailable() from here: the first walk already produced a verdict, and an infra
      # hiccup on the second must not turn a red into "not merged / needs-ceo".
      CONF_SUMMARY="walk confirm: unavailable (${CRSN% }) — first-walk failures kept"
    fi
    printf 'ux-gate: %s\n' "$CONF_SUMMARY"
  fi
fi
# 2. vision review
BASELINE="$STATE/shots/baseline"   # walk of the installed build before the programme (empty daemon); refresh with ux-walk.sh on current main
APPROVED_PROTO="$STATE/ux-proto/final"
BODY="$($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null | head -c 3000 | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
PR_SHOTS="$(ls "$STATE/shots/$SLUG"/*.png 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
PF="$STATE/briefs/$SLUG-ux-review.md"; mkdir -p "$STATE/briefs"
{
  echo "You are the UX REVIEWER (read-only) for PR #$N (item $ITEM, branch rsi/$SLUG, worktree $WT). The worker was a different model."
  echo "Follow $RSI_DIR/roles/ux-reviewer.md and the rubric in $RSI_DIR/UX-RUBRIC.md EXACTLY. Do not run builds or tests."
  echo "Evidence you MUST open with the Read tool (images are viewable): the walk screenshots in $SHOTS (names are <journey>-<viewport>-<n>-<step>.png; the matching .aria.txt is the accessibility tree), and $SHOTS/walk.json (objective lint per screen: small tap targets, search boxes, overflow, console errors)."
  [ -n "$PR_SHOTS" ] && echo "PR feature screenshots captured at 390x844 and 1100x760 (MUST also open with the Read tool, especially when a sub-surface such as workspace diffs or filtered states is not seeded in the generic journey walk): $PR_SHOTS"
  echo "Compare against: the BEFORE screenshots in $BASELINE (same names where they exist; the installed build before this programme) and the target prototype in $APPROVED_PROTO (the clickable shell Ethan approved; the product should converge on it, not on the old UI)."
  echo "Look at the attached diff only to explain what you see (do not run git/shell; the diff is provided). What the PR claims: $BODY"
  [ -n "$HARD" ] && { echo; echo "Walk hard failures (each is an automatic reject unless you can show it is a walker artefact):"; echo "$HARD"; }
  [ -n "$UX_IGNORED" ] && { echo; echo "Known walk artefacts ignored for this run (pre-existing fixture gap, not a defect of this PR; still report it as 'not verifiable: needs seed data'):"; echo "$UX_IGNORED"; }
  echo "Note: a throwaway daemon may be EMPTY (see $SHOTS/seed.log); then judge empty/loading states and structure, and say 'not verifiable: needs seed data' for what you cannot see. Never invent what the screen shows."
  echo
  echo "Output format (last lines, exactly): "
  echo "UX_SCORES: clarity=N density=N consistency=N feedback=N keyboard=N      (integers 1-5; 3 = acceptable, 5 = as good as T3 Code)"
  echo "UX_VERDICT: PASS or FAIL"
  echo "Before those lines list concrete findings: screen name, what is wrong, how it affects which journey, the fix. Quote screenshot names."
  echo "For every axis you score below 3, write a finding line that STARTS with the axis name (e.g. \`feedback: after-wait-390.png ...\`) and names the screenshot plus what is missing. That line becomes the rework instruction; a below-3 score with no such line is not a verdict."
} > "$PF"
UXR="$UXD/review.txt"
SHA="$(git -C "$WT" rev-parse HEAD 2>/dev/null || true)"
UROLE="ux-reviewer"; [ "$ROLE" = "reviewer-alt" ] && UROLE="ux-reviewer-alt"
run_review() { # <prompt-file> <out-file> [fresh] -> DRC; fresh=1 never reuses the cached strong UX review
  if [ -n "${RSI_UX_REVIEW_CMD:-}" ]; then bash -c "$RSI_UX_REVIEW_CMD" _ "$1" > "$2" 2>&1; DRC=$?
  elif [ "${3:-}" != fresh ] && [ -n "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong-ux")" = "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux.txt" ]; then
    echo "ux-gate: reuse strong UX review for ${SHA:0:8} (verdict=$(awk '{print $2}' "$STATE/merge/$SLUG.strong-ux"))"
    cp "$STATE/merge/$SLUG.strong-ux.txt" "$2"; DRC=0
  elif python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1; then
    unavailable "ux reviewer held: no strong reviewer available (Hydrogen/sol limited)"
  else
    # A fresh pass must be a real second opinion. dispatch.sh's escalate --check reuses the
    # strong-ux cache the first call just wrote for this same SHA (dispatch.sh:354-377), so the
    # reviewer would never be called again and every ungrounded score would end as unavailable
    # without a real re-ask. Drop it first; the re-ask's stamp_review rewrites it.
    [ "${3:-}" = fresh ] && rm -f "$STATE/merge/$SLUG.strong-ux" "$STATE/merge/$SLUG.strong-ux.txt"
    RSI_ITEM="$ITEM" RSI_NO_HEAVY=1 BUDGET_GUARD=8 DISPATCH_MAX_SECS=1500 "$RSI_DIR/runtime/dispatch.sh" "$UROLE" "$WT" "$1" "merge-$SLUG-ux" > "$2" 2>&1; DRC=$?
    [ "${DRC:-0}" -eq 3 ] && unavailable "ux reviewer held: no strong reviewer available (dispatch hold)"
  fi
  return "${DRC:-0}"
}
run_review "$PF" "$UXR"; DRC=$?
[ "${DRC:-0}" -ne 0 ] && ! grep -qE 'UX_SCORES:' "$UXR" 2>/dev/null && unavailable "ux reviewer unavailable: dispatch exit $DRC"
# 2c. Grounding is decided by `ungrounded_axes` (defined above with `accepts_review`, before any
# state is touched, because merge.sh shares it for cached-review reuse): `GAPS` is the axes < 3
# that no finding line names.
GAPS="$(ungrounded_axes "$UXR" 2>/dev/null || true)"
UX_REASKED=0; export UX_REASKED
if [ -n "$GAPS" ]; then
  echo "ux-gate: reviewer scored $GAPS below 3 without naming it in a finding — re-asking once"
  UXR2="$UXD/review.2.txt"; rm -f "$UXR2"
  { cat "$PF"; echo; echo "--- second pass ---"; \
    echo "Your previous answer scored $GAPS below 3, but its findings never name that axis. Re-answer this review."; \
    echo "For every axis you score below 3, write one finding line that STARTS with the axis name, names the screenshot file, and says what is missing or wrong. If you cannot point at the evidence, raise the score to 3."; \
    echo "Keep the last two lines exactly UX_SCORES: ... and UX_VERDICT: ..."; echo; echo "Your previous answer:"; cat "$UXR"; } > "$PF.2"
  run_review "$PF.2" "$UXR2" fresh || true
  if grep -qE 'UX_SCORES:' "$UXR2" 2>/dev/null; then cp "$UXR2" "$UXR"; UX_REASKED=1; export UX_REASKED; fi
  GAPS="$(ungrounded_axes "$UXR" 2>/dev/null || true)"
  if [ -n "$GAPS" ]; then
    [ "$UX_REASKED" = 1 ] \
      && unavailable "reviewer scored $GAPS below 3 without naming the evidence (asked twice); no verdict" \
      || unavailable "reviewer scored $GAPS below 3 and the re-ask produced no review; no verdict"
  fi
fi
# 3. decide (recomputed from the numbers; the model's own verdict only matters as a tie to the text)
python3 - "$UXR" "$UXD/scores.json" "$ERR" "$SHOTS" "$HARD" "$CONF_JSON" "$CONF_SUMMARY" <<'PY'
import os, re, sys, json
txt = open(sys.argv[1], errors="replace").read(); out, err, shots, hard = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
conf_json, conf_summary = sys.argv[6], sys.argv[7]
m = re.findall(r"UX_SCORES:\s*(.+)", txt); axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]): sc[k] = int(v)
vm = re.findall(r"UX_VERDICT:\s*(PASS|FAIL)", txt); verdict = vm[-1] if vm else "NONE"
ok = all(a in sc for a in axes)
mean = sum(sc[a] for a in axes) / 5 if ok else 0
reasons = []
if not ok: reasons.append("reviewer gave no complete UX_SCORES line (need clarity, density, consistency, feedback, keyboard)")
else:
    low = [a for a in axes if sc[a] < 3]
    if low: reasons.append("axis below 3: " + ", ".join("%s=%d" % (a, sc[a]) for a in low))
    if mean < 3.5: reasons.append("mean %.1f < 3.5" % mean)
if hard.strip(): reasons.append("walk hard failures:\n" + hard)
if verdict == "FAIL" and not reasons: reasons.append("reviewer verdict FAIL (see findings)")
doc = {"scores": sc, "mean": round(mean, 2), "verdict": verdict, "pass": not reasons, "reasons": reasons,
       "reasked": os.environ.get("UX_REASKED") == "1"}
try:
    doc["walk_confirm"] = json.load(open(conf_json))
except Exception:
    pass
json.dump(doc, open(out, "w"), indent=1)
if reasons:
    conf = ("\n" + conf_summary.rstrip() + "\n") if conf_summary.strip() else ""
    with open(err, "w") as f:
        f.write("=== UX GATE FAILED ===\n" + "\n".join(reasons) + "\n" + conf + "\nScreenshots: " + shots + "\nReviewer findings (tail):\n" + txt[-5000:])
    sys.exit(1)
PY
rc=$?
rm -f "$COOL"   # a complete outcome (PASS or FAIL) ends the cooldown; only unavailable keeps it
[ $rc -eq 0 ] && exit 0
exit 1
