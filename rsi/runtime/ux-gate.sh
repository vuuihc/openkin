#!/bin/bash
# ux-gate.sh <worktree> <slug> <item> <pr#> <diff-hash> [role]
# The UX gate of the merge lane (CEO 2026-11-15, after Ethan: "don't ship something that is not even demo-quality"). For a PR that touches
# UI source it (1) walks the affected journeys in the real console at 390/1100(/1280) on a throwaway daemon and saves screenshots,
# (2) has a vision reviewer on a different model (Kimi k3.1 pro, or gpt-6.1-sol via claude -p for big diffs) score the five rubric
# axes from rsi/roles/ux-reviewer.md, (3) decides. Threshold (recomputed here, the model's own verdict is not trusted): every axis >= 3
# AND mean >= 3.5 AND no walk hard failure. Writes state/merge/<slug>.ux.txt (the sendback body) and state/ux/<slug>/ (scores.json).
# exit 0 PASS | 1 FAIL (sendback body written) | 2 UNAVAILABLE (infra; the PR stays verified but is NOT merged, needs-ceo note)
#   An unavailable outcome starts a cooldown (state/merge/<slug>.uxcooldown, RSI_UX_COOLDOWN_MIN minutes, default 30): later ticks for
#   the same diff exit 2 at once, without walking, dispatching or deleting the last walk's screenshots. A new diff hash retries at once.
#   RSI_UX_COOLDOWN_MIN=0    disable the cooldown (test hook)
#   RSI_UX_WALK_CMD=<cmd>    test hook: run instead of the walker, gets the screenshot dir as $1, must leave walk.json + a .png there
#   RSI_UX_REVIEW_CMD=<cmd>  test hook: run instead of the model, gets the prompt file as $1 and prints the reviewer text
#                            (a non-zero exit without UX_SCORES counts as unavailable, same as a failed dispatch)
#   RSI_UX_STATE=<dir>       state root override for tests; defaults to the worktree's rsi/state. Not RSI_STATE: the loop
#                            already exports that as the controller state, so it cannot serve as a test-local override.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
if [ -n "${RSI_UX_STATE:-}" ]; then STATE="$RSI_UX_STATE"; export RSI_STATE="$STATE"; fi
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
NSHOT="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
[ "$NSHOT" -gt 0 ] || unavailable "walk produced no screenshots"
# 2. vision review
BASELINE="$STATE/shots/baseline"   # walk of the installed build before the programme (empty daemon); refresh with ux-walk.sh on current main
APPROVED_PROTO="$STATE/ux-proto/final"
BODY="$($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null | head -c 3000)"
PF="$STATE/briefs/$SLUG-ux-review.md"; mkdir -p "$STATE/briefs"
{
  echo "You are the UX REVIEWER (read-only) for PR #$N (item $ITEM, branch rsi/$SLUG, worktree $WT). The worker was a different model."
  echo "Follow $RSI_DIR/roles/ux-reviewer.md and the rubric in $RSI_DIR/UX-RUBRIC.md EXACTLY. Do not run builds or tests."
  echo "Evidence you MUST open with the Read tool (images are viewable): the walk screenshots in $SHOTS (names are <journey>-<viewport>-<n>-<step>.png; the matching .aria.txt is the accessibility tree), and $SHOTS/walk.json (objective lint per screen: small tap targets, search boxes, overflow, console errors)."
  echo "Compare against: the BEFORE screenshots in $BASELINE (same names where they exist; the installed build before this programme) and the target prototype in $APPROVED_PROTO (the clickable shell Ethan approved; the product should converge on it, not on the old UI)."
  echo "Look at the diff only to explain what you see: git diff origin/main...HEAD. What the PR claims: $BODY"
  [ -n "$HARD" ] && { echo; echo "Walk hard failures (each is an automatic reject unless you can show it is a walker artefact):"; echo "$HARD"; }
  echo "Note: a throwaway daemon may be EMPTY (see $SHOTS/seed.log); then judge empty/loading states and structure, and say 'not verifiable: needs seed data' for what you cannot see. Never invent what the screen shows."
  echo
  echo "Output format (last lines, exactly): "
  echo "UX_SCORES: clarity=N density=N consistency=N feedback=N keyboard=N      (integers 1-5; 3 = acceptable, 5 = as good as T3 Code)"
  echo "UX_VERDICT: PASS or FAIL"
  echo "Before those lines list concrete findings: screen name, what is wrong, how it affects which journey, the fix. Quote screenshot names."
} > "$PF"
UXR="$UXD/review.txt"
SHA="$(git -C "$WT" rev-parse HEAD 2>/dev/null || true)"
if [ -n "${RSI_UX_REVIEW_CMD:-}" ]; then bash -c "$RSI_UX_REVIEW_CMD" _ "$PF" > "$UXR" 2>&1; DRC=$?
elif [ -n "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong-ux")" = "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux.txt" ]; then
  echo "ux-gate: reuse strong UX review for ${SHA:0:8} (verdict=$(awk '{print $2}' "$STATE/merge/$SLUG.strong-ux"))"
  cp "$STATE/merge/$SLUG.strong-ux.txt" "$UXR"; DRC=0
elif python3 "$RSI_DIR/runtime/escalate.py" --sol-limited >/dev/null 2>&1 && [ "${RSI_CARBON_ENABLED:-0}" != 1 ]; then
  unavailable "ux reviewer held: gpt-6.1-sol rate-limited until $(date -r "$(cat "$STATE/sol-limited-until")" '+%H:%M' 2>/dev/null || echo later)"
else
  UROLE="ux-reviewer"; [ "$ROLE" = "reviewer-alt" ] && UROLE="ux-reviewer-alt"
  RSI_NO_HEAVY=1 BUDGET_GUARD=8 DISPATCH_MAX_SECS=1500 "$RSI_DIR/runtime/dispatch.sh" "$UROLE" "$WT" "$PF" "merge-$SLUG-ux" > "$UXR" 2>&1; DRC=$?
  if [ "${DRC:-0}" -eq 3 ]; then
    unavailable "ux reviewer held: gpt-6.1-sol rate-limited (dispatch hold)"
  fi
fi
[ "${DRC:-0}" -ne 0 ] && ! grep -qE 'UX_SCORES:' "$UXR" 2>/dev/null && unavailable "ux reviewer unavailable: dispatch exit $DRC"
# 3. decide (recomputed from the numbers; the model's own verdict only matters as a tie to the text)
python3 - "$UXR" "$UXD/scores.json" "$ERR" "$SHOTS" "$HARD" <<'PY'
import re, sys, json
txt = open(sys.argv[1], errors="replace").read(); out, err, shots, hard = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
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
json.dump({"scores": sc, "mean": round(mean, 2), "verdict": verdict, "pass": not reasons, "reasons": reasons}, open(out, "w"), indent=1)
if reasons:
    with open(err, "w") as f:
        f.write("=== UX GATE FAILED ===\n" + "\n".join(reasons) + "\n\nScreenshots: " + shots + "\nReviewer findings (tail):\n" + txt[-5000:])
    sys.exit(1)
PY
rc=$?
rm -f "$COOL"   # a complete outcome (PASS or FAIL) ends the cooldown; only unavailable keeps it
[ $rc -eq 0 ] && exit 0
exit 1
