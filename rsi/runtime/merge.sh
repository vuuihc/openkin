#!/bin/bash
# merge.sh [--dry-run]            dispatcher: starts up to RSI_MERGE_WORKERS (2) per-PR verifiers; returns quickly.
# merge.sh --one <N> <slug> <title>   verifier for one open rsi/* PR (also PRs opened by cloud agents).
# Per PR: sync main into the branch (merge commit, never force-push) → hold rules → independent review (background, no heavy
# lock) IN PARALLEL with gate.sh (serialised machine-wide via the gate lock + heavy.sh) → CI → land under a land lock.
# Rework → delta-only re-review (diff since the last reviewed SHA + prior notes). Failures of gate and review are combined into
# ONE sendback (state/sendback/<slug>.md) that a rework lane picks up. Honours PAUSE and NO_MERGE (verify, never merge).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
MERGE_WORKERS="${RSI_MERGE_WORKERS:-2}"
CODE_RE='^(ui/|internal/|cmd/|scripts/|desktop/|mobile/|web/|go\.mod|go\.sum|\.github/)'   # main changes here invalidate a carried-forward gate
say() { echo "[$(date +%T)] $*"; }
attempts() { cat "$STATE/merge/$1.attempts" 2>/dev/null || echo 0; }
sendback() { # slug item title detail-file
  local slug="$1" item="$2" title="$3" det="$4" a; a=$(( $(attempts "$slug") + 1 )); echo $a > "$STATE/merge/$slug.attempts"
  if [ $a -gt 3 ]; then
    touch "$STATE/merge/$slug.blocked"
    printf -- '- %s PR rsi/%s blocked after %s sendbacks: %s (see %s)\n' "$(date '+%F %H:%M')" "$slug" "$((a-1))" "$title" "$det" >> "$STATE/needs-ceo.md"
    local b=$(( $(cat "$STATE/consec_blocked" 2>/dev/null || echo 0) + 1 )); echo $b > "$STATE/consec_blocked"
    [ $b -ge 2 ] && [ ! -e "$STATE/NO_MERGE" ] && echo "two PRs blocked after their rework rounds ($(date))" > "$STATE/NO_MERGE"
    notify "Kin RSI: PR rsi/$slug blocked" "$title"; return
  fi
  { echo "item: $item"; echo "attempt: $a"; echo "# Sent back by the merge lane: $title"; echo; echo "Branch rsi/$slug. Fix every finding below in one pass, then stop (the merge lane re-gates and re-reviews the delta)."; echo; echo '```'; tail -c 7000 "$det"; echo '```'; } > "$STATE/sendback/$slug.md"
  say "sendback $slug (#$a): $title"; KICK=1
}

# ------------------------------------------------------------------ dispatcher
if [ "${1:-}" != "--one" ]; then
  DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
  [ -e "$STATE/PAUSE" ] && { echo "paused"; exit 0; }
  # legacy single-instance lock (pre-pipeline merge.sh still running): do not double-process
  old="$(cat "$STATE/.merge.lock/pid" 2>/dev/null || true)"; [ -n "$old" ] && kill -0 "$old" 2>/dev/null && { echo "legacy merge lane still running (pid $old)"; exit 0; }
  DL="$STATE/.dispatch.lock"
  if ! mkdir "$DL" 2>/dev/null; then o="$(cat "$DL/pid" 2>/dev/null || true)"; if [ -n "$o" ] && kill -0 "$o" 2>/dev/null; then exit 0; fi; rm -rf "$DL"; mkdir "$DL" 2>/dev/null || exit 0; fi
  echo $$ > "$DL/pid"; trap 'rm -rf "$DL"' EXIT
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  PRS="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json number,headRefName,isDraft,labels,title 2>/dev/null | python3 -c '
import json,sys
for p in sorted(json.load(sys.stdin), key=lambda p:p["number"]):
    h=p["headRefName"]; ls={l["name"] for l in p["labels"]}
    if not h.startswith("rsi/") or h.startswith("rsi/dream-") or h.startswith("rsi/ceo-") or p["isDraft"] or ls & {"hold","needs-ceo"}: continue
    print("%d\t%s\t%s" % (p["number"], h[4:], p["title"].replace("\t"," ")))')"
  [ -z "$PRS" ] && { say "no open rsi PRs"; exit 0; }
  ACTIVE="$(python3 "$LANES_PY" slugs)"
  running=0; for l in "$STATE"/merge/*.lock; do [ -d "$l" ] && kill -0 "$(cat "$l/pid" 2>/dev/null || echo 0)" 2>/dev/null && running=$((running+1)); done
  while IFS=$'\t' read -r -u 3 N SLUG TITLE; do
    [ -z "$N" ] && continue
    echo "$ACTIVE" | grep -qx "$SLUG" && { say "#$N $SLUG: lane active, skip"; continue; }
    [ -e "$STATE/sendback/$SLUG.md" ] && { say "#$N $SLUG: waiting for rework"; continue; }
    [ -e "$STATE/merge/$SLUG.blocked" ] && { say "#$N $SLUG: blocked (needs CEO)"; continue; }
    L="$STATE/merge/$SLUG.lock"
    if [ -d "$L" ]; then if kill -0 "$(cat "$L/pid" 2>/dev/null || echo 0)" 2>/dev/null; then continue; fi; rm -rf "$L"; fi
    [ $running -ge "$MERGE_WORKERS" ] && { say "#$N $SLUG: all $MERGE_WORKERS verifier slots busy"; continue; }
    [ $DRY -eq 1 ] && { say "#$N $SLUG: would verify (dry-run)"; running=$((running+1)); continue; }
    mkdir "$L" 2>/dev/null || continue; echo $$ > "$L/pid"   # claimed; the worker rewrites its own pid
    nohup /bin/bash "$SELF" --one "$N" "$SLUG" "$TITLE" >> "$RUNS/merge-worker-$SLUG.log" 2>&1 < /dev/null & echo $! > "$L/pid"; disown 2>/dev/null || true
    say "#$N $SLUG: verifier started (pid $!)"; running=$((running+1)); sleep 1
  done 3<<< "$PRS"
  exit 0
fi

# ------------------------------------------------------------------ per-PR verifier
N="$2"; SLUG="$3"; TITLE="${4:-}"
L="$STATE/merge/$SLUG.lock"; echo $$ > "$L/pid"; T0=$(date +%s)
CHILD=""; KICK=""
cleanup() { [ -n "$CHILD" ] && kill $CHILD 2>/dev/null; rm -rf "$L"
  # a sendback or a merge changes what the lanes should do (fill pulse) and what the next PR needs (re-sync): kick both
  if [ -n "$KICK" ]; then
    nohup /bin/bash "$RSI_DIR/runtime/run.sh" pulse >> "$RUNS/launchd-pulse.log" 2>&1 < /dev/null &
    nohup /bin/bash "$SELF" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null &
  fi; }
trap cleanup EXIT
[ -e "$STATE/PAUSE" ] && exit 0
BR="rsi/$SLUG"; WT="$WT_ROOT/rsi-$SLUG"; PRURL="https://github.com/$GH_REPO/pull/$N"
BODY="$($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null)"
ITEM="$(echo "$BODY" | sed -n 's/.*RSI item: *\([A-Za-z0-9._-]*\).*/\1/p' | head -1)"; ITEM="${ITEM:-R-$SLUG}"
V="$STATE/merge/$SLUG.verified"; RV="$STATE/merge/$SLUG.reviewed"; PREV="$STATE/merge/$SLUG.review.txt"
say "#$N $SLUG ($ITEM) verifier start"

dist_resolve() { # worktree: resolve a lone web/dist/index.html conflict by rebuilding
  local wt="$1" un; un="$($GIT -C "$wt" diff --name-only --diff-filter=U)"
  [ "$un" = "web/dist/index.html" ] || return 1
  $GIT -C "$wt" checkout --ours web/dist/index.html && $GIT -C "$wt" add web/dist/index.html || return 1
  $GIT -C "$wt" commit -q --no-edit || return 1
  ( cd "$wt/ui" && npm run build >/dev/null 2>&1 ) || return 1
  [ -n "$($GIT -C "$wt" status --porcelain -- web/dist/index.html)" ] && $GIT -C "$wt" commit -q -am "chore(web): rebuild dist after merging main"
  return 0
}
mklock() { local d="$1" max="$2" w=0; while ! mkdir "$d" 2>/dev/null; do o="$(cat "$d/pid" 2>/dev/null)"; if [ -n "$o" ] && ! kill -0 "$o" 2>/dev/null; then rm -rf "$d"; continue; fi; sleep 15; w=$((w+15)); [ $w -gt "$max" ] && return 1; done; echo $$ > "$d/pid"; }
sync_main() { # -> 0 ok (pushed if changed), 1 conflict (sendback written), 2 transient failure
  $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD && return 0
  say "#$N $SLUG: merging origin/main"
  if ! $GIT -C "$WT" merge -q --no-edit origin/main >/dev/null 2>&1; then
    if dist_resolve "$WT"; then say "#$N: web/dist/index.html conflict resolved by rebuild"
    else CF="$($GIT -C "$WT" diff --name-only --diff-filter=U)"; $GIT -C "$WT" merge --abort >/dev/null 2>&1
      printf 'merge of origin/main conflicts in:\n%s\n' "$CF" > "$STATE/merge/$SLUG.err"; sendback "$SLUG" "$ITEM" "merge conflict with main" "$STATE/merge/$SLUG.err"; return 1; fi
  fi
  $GIT -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null || { say "#$N: push after merge-main failed"; return 2; }
  return 0
}
ci_state() { # prints green|pending|fail ; waits (bounded) while pending
  local tries=0 out
  while [ $tries -lt 6 ]; do out="$($GH pr checks "$N" --repo "$GH_REPO" 2>&1)"; echo "$out" | grep -qi 'no checks reported' || break; tries=$((tries+1)); sleep 30; done
  if echo "$out" | grep -qE '\bpending\b|\bqueued\b|in_progress'; then
    say "#$N $SLUG: CI pending, waiting up to 25 min" >&2; with_timeout 1500 $GH pr checks "$N" --repo "$GH_REPO" --watch --interval 30 >/dev/null 2>&1
    out="$($GH pr checks "$N" --repo "$GH_REPO" 2>&1)"
  fi
  printf '%s\n' "$out" > "$STATE/merge/$SLUG.ci.txt"
  echo "$out" | grep -qE '\bpending\b|\bqueued\b|in_progress' && { echo pending; return; }
  # cancel-in-progress leaves a cancelled check next to the replacement run.
  # That must not fail the PR: a real failure is "fail"; a cancelled run with
  # no replacement yet is pending (retry next cycle).
  echo "$out" | grep -qE '\bfail\b' && { echo fail; return; }
  echo "$out" | grep -qiE '\bcancel' && { echo pending; return; }
  echo green
}

$GIT -C "$RSI_CTRL" fetch -q origin main "$BR" 2>/dev/null
[ -e "$WT" ] || $GIT -C "$RSI_CTRL" worktree add -q "$WT" -B "$BR" "origin/$BR" 2>/dev/null || { say "#$N: cannot make worktree"; exit 0; }
[ -n "$($GIT -C "$WT" status --porcelain --untracked-files=no)" ] && { say "#$N $SLUG: worktree has uncommitted tracked edits, skip"; exit 0; }
$GIT -C "$WT" merge -q --ff-only "origin/$BR" >/dev/null 2>&1 || { say "#$N $SLUG: local branch diverged from origin, skip"; exit 0; }

# 1. sync main
sync_main; rc=$?; [ $rc -ne 0 ] && exit 0
bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT" 2>&1 | tail -2
SHA="$($GIT -C "$WT" rev-parse HEAD)"

# 2. hold rules (MANDATE): never auto-merge these
CH="$($GIT -C "$WT" diff --name-only origin/main...HEAD)"
SIZE="$($GIT -C "$WT" diff --numstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | awk '{s+=$1+$2} END{print s+0}')"
HOLD=""
echo "$CH" | grep -qE '^(go\.mod|ui/package\.json|internal/store/.*migrat|.*migrations?/|internal/auth)' && HOLD="touches deps/migrations/auth (MANDATE: needs CEO + ADR)"
# CEO 2026-11-15 (Ethan: Astryx overhaul approved): the Astryx foundation slices F1-F3 may change ui/package.json, but only
# for the programme's packages. Anything else in package.json (or go.mod/migrations/auth) still holds for the CEO.
if [ -n "$HOLD" ] && echo "$ITEM" | grep -qE '^F[123]$' && ! echo "$CH" | grep -qE '^(go\.mod|internal/store/.*migrat|.*migrations?/|internal/auth)'; then
  BAD="$( ( $GIT -C "$WT" diff -U0 origin/main...HEAD -- ui/package.json | python3 -c '
import re,sys
ok=re.compile(r"^(react|react-dom|@types/react|@types/react-dom|tailwindcss|@tailwindcss/.*|postcss|autoprefixer|@astryxdesign/.*|@stylexjs/.*)$")
bad=[]
for l in sys.stdin:
    m=re.match(r"^[+-]\s*\"([^\"]+)\"\s*:\s*\"[^\"]*\",?\s*$", l)
    if m and not l.startswith(("+++","---")) and not ok.match(m.group(1)) and m.group(1) not in ("version","name","description"):
        bad.append(m.group(1))
print(" ".join(sorted(set(bad))))') )"
  [ -z "$BAD" ] && HOLD="" || HOLD="package.json change outside the Astryx programme packages: $BAD"
fi
[ "$SIZE" -gt 1000 ] && HOLD="diff is $SIZE changed lines (>1000): split it"
echo "$CH" | grep -qE '^web/dist/assets/' && HOLD="web/dist/assets in diff"
if [ -n "$HOLD" ]; then
  if [ "${HOLD#diff is}" != "$HOLD" ]; then printf '%s\n' "$HOLD" > "$STATE/merge/$SLUG.err"; sendback "$SLUG" "$ITEM" "$HOLD" "$STATE/merge/$SLUG.err"
  else touch "$STATE/merge/$SLUG.blocked"; printf -- '- %s PR #%s rsi/%s held: %s\n' "$(date '+%F %H:%M')" "$N" "$SLUG" "$HOLD" >> "$STATE/needs-ceo.md"; fi
  exit 0
fi

# 3. MANDATE 5 screenshots (cheap, before spending a gate/review): local shots dir, local PR body file, or the PR body itself (cloud PRs)
if echo "$CH" | grep -qE '^ui/src/.*\.tsx$' && ! echo "$CH" | grep -qE '^ui/src/.*\.(test|spec)\.' ; then
  if [ -z "$(ls "$STATE/shots/$SLUG" 2>/dev/null)" ] && ! echo "$BODY" | grep -qiE 'screenshots?:.*(none|not visible|https?://|!\[)' ; then
    echo "UI .tsx changed but no screenshots in $STATE/shots/$SLUG/ and no 'Screenshots:' line with a link/image or 'none: <reason>' in the PR body (MANDATE 5). Capture 390x844 and 1100x760 before/after, or state why nothing is visible." > "$STATE/merge/$SLUG.err"
    sendback "$SLUG" "$ITEM" "missing screenshots" "$STATE/merge/$SLUG.err"; exit 0
  fi
fi

# 4. gate and review IN PARALLEL. Review is keyed by the PR's own diff (web/dist/index.html and lockfile excluded), the gate by head SHA.
DH="$($GIT -C "$WT" diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16)"
NEED_GATE=1; [ "$(cut -d' ' -f1 "$V" 2>/dev/null)" = "$SHA" ] && [ "$(cut -d' ' -f2 "$V" 2>/dev/null)" = PASS ] && NEED_GATE=0
NEED_REV=1;  [ "$(cut -d' ' -f1 "$RV" 2>/dev/null)" = "$DH" ] && [ "$(cut -d' ' -f2 "$RV" 2>/dev/null)" = PASS ] && NEED_REV=0
ROLE=reviewer
echo "$CH" | grep -qE '^(internal/(auth|store|permission)|.*(permission|persist))' && ROLE=reviewer-alt
[ "$SIZE" -gt 500 ] && ROLE=reviewer-alt
GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"; REVPID=""
if [ $NEED_REV -eq 1 ]; then
  LASTREV="$(cut -d' ' -f3 "$RV" 2>/dev/null)"   # last reviewed SHA (any verdict)
  RB="$STATE/briefs/$SLUG-review.md"
  {
    echo "You are the independent REVIEWER (read-only) for PR #$N, branch $BR, worktree $WT. The worker was a different model."
    echo "Do NOT run npm/npx/vitest/tsc/go test/builds: the gate runs them in parallel on the same machine (they are disabled for you). Read code and diffs only."
    if [ -n "$LASTREV" ] && $GIT -C "$WT" cat-file -e "$LASTREV^{commit}" 2>/dev/null && [ -s "$PREV" ]; then
      echo "This is a RE-REVIEW after rework. Review ONLY the delta since the last reviewed commit: git diff $LASTREV..HEAD (plus how it interacts with the rest). The full PR diff is git diff origin/main...HEAD if you need context."
      echo; echo "Previous review notes (verify each blocker/major is fixed; flag anything new in the delta):"; tail -c 4000 "$PREV"
    else
      echo "Run: git diff origin/main...HEAD (and read call sites)."
    fi
    echo "Behaviour claimed (PR body): $(echo "$BODY" | head -c 3500)"
    echo; echo "Checklist and grading: $RSI_DIR/roles/reviewer.md ; binding rules: $RSI_DIR/MANDATE.md ; screenshots (if any): $STATE/shots/$SLUG/ or links in the PR body."
    echo "The gate (tests, lint, build, ratchet) is running separately; its verdict is not your job."
    echo; echo "Grade every finding blocker/major/nit. End with exactly one line: VERDICT: PASS (no blocker/major) or VERDICT: FAIL, followed by the blocker/major list."
  } > "$RB"
  say "#$N $SLUG: review by $ROLE (parallel with gate), $([ -n "${LASTREV:-}" ] && echo delta-since-${LASTREV:0:8} || echo full)"
  cp "$PREV" "$PREV.prev" 2>/dev/null
  ( RSI_NO_HEAVY=1 BUDGET_GUARD=8 DISPATCH_MAX_SECS=1800 "$RSI_DIR/runtime/dispatch.sh" "$ROLE" "$WT" "$RB" "merge-$SLUG-review" > "$PREV.new" 2>&1 ) &
  REVPID=$!; CHILD=$REVPID
fi
GATE_OK=1; GATE_NOTE=""
if [ $NEED_GATE -eq 1 ]; then
  say "#$N $SLUG: gate on ${SHA:0:8} ($SIZE lines)"
  if ! mklock "$STATE/.gate.lock" 1800; then GATE_OK=0; GATE_NOTE="gate lock timeout"; say "#$N: gate lock timeout"
  else
    # Workers often build before their last edit: regenerate web/dist/index.html (the only tracked build output) so a stale bundle
    # never bounces a PR. Pushed so CI sees the same file.
    if echo "$CH" | grep -q '^ui/' && [ -d "$WT/ui/node_modules" ]; then
      ( cd "$WT/ui" && npm run build >/dev/null 2>&1 ) && [ -n "$($GIT -C "$WT" status --porcelain -- web/dist/index.html)" ] \
        && $GIT -C "$WT" commit -q -m "chore(web): rebuild dist" -- web/dist/index.html && $GIT -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null
      SHA="$($GIT -C "$WT" rev-parse HEAD)"
    fi
    ( cd "$WT" && bash "$RSI_DIR/runtime/gate.sh" "$WT" ) > "$GL" 2>&1; GRC=$?; rm -rf "$STATE/.gate.lock"
    $GIT -C "$WT" checkout -q -- . 2>/dev/null   # drop build leftovers (tracked files only) in our own rsi worktree
    if [ $GRC -ne 0 ] || ! grep -q '^GATE_RESULT=PASS' "$GL"; then GATE_OK=0; GATE_NOTE="$(grep '^GATE_RESULT' "$GL" | head -1)"; say "#$N $SLUG: gate FAIL: $GATE_NOTE"; fi
  fi
fi
REV_OK=1; REV_NOTE=""
if [ -n "$REVPID" ]; then
  wait "$REVPID"; CHILD=""
  cp "$PREV.new" "$PREV"; rm -f "$PREV.new"
  VERD="$(grep -oE 'VERDICT: *(PASS|FAIL)' "$PREV" | tail -1 | grep -oE 'PASS|FAIL')"
  if [ -z "$VERD" ]; then
    # Reviewer infra (empty log / no VERDICT): retry next cycle. Do not send back or cache this SHA as reviewed
    # (a cached NONE would make the next pass a delta-since-HEAD empty review).
    say "#$N $SLUG: review NO VERDICT (reviewer infra) — retry next cycle, not a sendback"
    if [ -s "$PREV.prev" ]; then mv "$PREV.prev" "$PREV"; else rm -f "$PREV"; fi
    [ $GATE_OK -eq 0 ] || exit 0
  else
    echo "$DH $VERD $SHA $ROLE" > "$RV"
    if [ "$VERD" != PASS ]; then REV_OK=0; REV_NOTE="independent review FAIL"; say "#$N $SLUG: review FAIL"; fi
  fi
fi
RMODEL="$([ $ROLE = reviewer ] && echo "$M_DIRECTOR" || echo "$M_ALT")"
if [ $GATE_OK -eq 0 ] || [ $REV_OK -eq 0 ]; then
  C="$STATE/merge/$SLUG.combined.txt"; : > "$C"; TITLEBAD=""
  [ $GATE_OK -eq 0 ] && { echo "=== GATE FAILED: $GATE_NOTE ===" >> "$C"; tail -c 3500 "$GL" >> "$C" 2>/dev/null; echo >> "$C"; TITLEBAD="gate failed: $GATE_NOTE"; }
  [ $REV_OK -eq 0 ] && { echo "=== INDEPENDENT REVIEW: $REV_NOTE ===" >> "$C"; tail -c 3500 "$PREV" >> "$C"; echo >> "$C"; TITLEBAD="${TITLEBAD:+$TITLEBAD; }$REV_NOTE"; }
  sendback "$SLUG" "$ITEM" "$TITLEBAD" "$C"
  scorecard_row "$ITEM $SLUG" "$M_WORKER" "$RMODEL" "$TITLEBAD" "[#$N]($PRURL)" "patched" "see ${GL##*/}"
  exit 0
fi
[ $NEED_GATE -eq 1 ] && echo "$SHA PASS $ROLE" > "$V"
[ $NEED_GATE -eq 1 ] || [ $NEED_REV -eq 1 ] && $GH pr comment "$N" --repo "$GH_REPO" --body "RSI merge lane: gate PASS and independent review ($ROLE$([ $NEED_REV -eq 0 ] && echo ", carried over: PR diff unchanged")) VERDICT: PASS on ${SHA:0:8}. Gate log: ${GL##*/}." >/dev/null 2>&1
VERIFIED_AT=$(date +%s); echo "$(date '+%F %H:%M') #$N $SLUG verify=$(( (VERIFIED_AT - T0) / 60 ))m gate=$([ $NEED_GATE -eq 1 ] && echo ran || echo cached) review=$([ $NEED_REV -eq 1 ] && echo ran || echo cached)" >> "$STATE/merge/cycles.log"

# 4b. UX gate (CEO 2026-11-15; Ethan: a redesign must not end up demo-grade). Two parts, both before landing:
#   (a) a slice with `"gate": "ux-approved"` (S1-S3, the visible shell) is verified but NOT merged until state/ux-proto/APPROVED exists;
#   (b) any PR that touches UI source gets a journey walk of the real console (screenshots 390/1100/1280) + a vision review scored on
#       UX-RUBRIC.md (clarity, density, consistency, feedback, keyboard). Reject (sendback) below threshold; infra trouble never bounces a PR:
#       it stays verified, is NOT merged, and is listed in needs-ceo.md. RSI_UX_GATE=off disables (emergency only; log it in DECISIONS).
if ! python3 "$RSI_DIR/runtime/slices.py" gate-ok "$ITEM" >/dev/null 2>&1; then
  say "#$N $SLUG ($ITEM): verified, waiting for state/ux-proto/APPROVED (UX approval gate) -> not merging"; exit 0
fi
UI_TOUCH=0
echo "$CH" | grep -E '^ui/src/.*\.(tsx|css)$' | grep -vqE '\.(test|spec)\.' && UI_TOUCH=1
echo "$CH" | grep -qE '^(ui/package(-lock)?\.json|ui/tailwind|ui/postcss)' && UI_TOUCH=1
if [ $UI_TOUCH -eq 1 ] && [ "${RSI_UX_GATE:-on}" != off ]; then
  UXV="$STATE/merge/$SLUG.uxverified"
  MAINUI="$($GIT -C "$WT" rev-parse origin/main:ui 2>/dev/null || $GIT -C "$WT" rev-parse origin/main)-$($GIT -C "$WT" rev-parse HEAD:ui/package-lock.json 2>/dev/null || echo none)"
  if [ "$(cut -d' ' -f1 "$UXV" 2>/dev/null)" = "$DH" ] && [ "$(cut -d' ' -f2 "$UXV" 2>/dev/null)" = PASS ] && [ "$(cut -d' ' -f3 "$UXV" 2>/dev/null)" = "$MAINUI" ]; then
    say "#$N $SLUG: UX gate carried over (PR diff and origin/main:ui unchanged)"
  else
    say "#$N $SLUG: UX gate (journey walk + vision review)"
    bash "$RSI_DIR/runtime/ux-gate.sh" "$WT" "$SLUG" "$ITEM" "$N" "$DH" "$ROLE"; urc=$?
    SC="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join("%s=%s"%kv for kv in d["scores"].items()), "mean=%s"%d["mean"])' "$STATE/ux/$SLUG/scores.json" 2>/dev/null)"
    if [ $urc -eq 0 ]; then
      echo "$DH PASS $MAINUI" > "$UXV"
      $GH pr comment "$N" --repo "$GH_REPO" --body "RSI UX gate: PASS on ${SHA:0:8} ($SC). Journey screenshots are kept on the CEO machine (rsi/state/shots/$SLUG/journeys/). Rubric: rsi/UX-RUBRIC.md." >/dev/null 2>&1
    elif [ $urc -eq 1 ]; then
      say "#$N $SLUG: UX gate FAIL ($SC)"; sendback "$SLUG" "$ITEM" "UX gate failed ($SC)" "$STATE/merge/$SLUG.ux.txt"
      scorecard_row "$ITEM $SLUG" "$M_WORKER" "$RMODEL (ux)" "UX FAIL $SC" "[#$N]($PRURL)" "patched" "see state/ux/$SLUG"; exit 0
    else
      [ -e "$STATE/merge/$SLUG.uxunavail.$DH" ] || { touch "$STATE/merge/$SLUG.uxunavail.$DH"
      printf -- '- %s PR #%s rsi/%s: UX gate could not run (%s); verified, NOT merged. Fix the walker/daemon or set RSI_UX_GATE=off and record it in DECISIONS.\n' "$(date '+%F %H:%M')" "$N" "$SLUG" "$(cat "$STATE/ux/$SLUG/unavailable.txt" 2>/dev/null | head -c 160)" >> "$STATE/needs-ceo.md"; }
      say "#$N $SLUG: UX gate unavailable -> not merging"; exit 0
    fi
  fi
fi

# 5. NO_MERGE honours
if [ -e "$STATE/NO_MERGE" ]; then say "#$N $SLUG: verified, NO_MERGE set -> not merging"; exit 0; fi

# 6. CI, then land under the land lock (serialised); if main moved while we verified: sync, carry the gate forward only when
#    the incoming main changes touch no code paths, otherwise hand back for a fresh gate (review stays valid: same PR diff).
for round in 1 2 3; do
  CIS="$(ci_state)"
  [ "$CIS" = pending ] && { say "#$N $SLUG: CI still pending, retry next cycle"; exit 0; }
  [ "$CIS" = fail ] && { sendback "$SLUG" "$ITEM" "CI failed" "$STATE/merge/$SLUG.ci.txt"; exit 0; }
  mklock "$STATE/.land.lock" 900 || { say "#$N: land lock timeout"; exit 0; }
  $GIT -C "$WT" fetch -q origin main 2>/dev/null
  if $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD; then
    if $GH pr merge "$N" --repo "$GH_REPO" --squash >/dev/null 2>"$STATE/merge/$SLUG.merge.err"; then
      MSHA="$($GH pr view "$N" --repo "$GH_REPO" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null | cut -c1-8)"
      say "#$N $SLUG: MERGED ($MSHA)"
      echo "$(date '+%F %H:%M') PR #$N $SLUG $ITEM merged ${MSHA:-?} $PRURL" >> "$STATE/merged.log"
      CREATED="$($GH pr view "$N" --repo "$GH_REPO" --json createdAt --jq .createdAt 2>/dev/null)"
      python3 - "$CREATED" "$N" "$SLUG" >> "$STATE/merge/cycles.log" <<'PY'
import sys, datetime
c, n, s = sys.argv[1:4]
try:
    t = datetime.datetime.fromisoformat(c.replace("Z", "+00:00")); m = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 60
    print("%s #%s %s MERGED open_to_merge=%.0fm" % (datetime.datetime.now().strftime("%F %H:%M"), n, s, m))
except Exception: pass
PY
      KICK=1; echo 0 > "$STATE/consec_blocked"; python3 "$LANES_PY" cloud-release "$SLUG" >/dev/null 2>&1
      FPY=pass; [ "$(attempts "$SLUG")" -gt 0 ] && FPY=patched
      scorecard_row "$ITEM $SLUG" "$M_WORKER" "$RMODEL" "MERGED $MSHA" "[#$N]($PRURL)" "$FPY" "-"
      rm -rf "$STATE/.land.lock"; break
    else say "#$N $SLUG: merge command failed: $(tail -c 200 "$STATE/merge/$SLUG.merge.err")"; rm -rf "$STATE/.land.lock"; exit 0; fi
  fi
  # main moved: sync under the land lock
  OLDHEAD="$($GIT -C "$WT" rev-parse HEAD)"; OLDBASE="$($GIT -C "$WT" merge-base HEAD origin/main)"
  sync_main; rc=$?; if [ $rc -ne 0 ]; then rm -rf "$STATE/.land.lock"; exit 0; fi
  INCOMING="$($GIT -C "$WT" diff --name-only "$OLDBASE" origin/main 2>/dev/null)"
  NEWSHA="$($GIT -C "$WT" rev-parse HEAD)"
  rm -rf "$STATE/.land.lock"
  if echo "$INCOMING" | grep -qE "$CODE_RE"; then
    say "#$N $SLUG: main moved with code changes ($(echo "$INCOMING" | grep -cE "$CODE_RE") files); needs a fresh gate"; rm -f "$V"
    nohup /bin/bash "$SELF" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null || true
    exit 0
  fi
  say "#$N $SLUG: main moved only in non-code paths; gate carried forward to ${NEWSHA:0:8}"; echo "$NEWSHA PASS $ROLE" > "$V"; SHA="$NEWSHA"
done

exit 0
