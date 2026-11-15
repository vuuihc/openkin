#!/bin/bash
# merge.sh [--dry-run] — the merge/review lane. One instance at a time; quick no-op when nothing is ready.
# For each open rsi/* PR (oldest first): sync main into the branch (merge, never force-push) → hold rules →
# gate.sh → independent review (different model from the worker) → CI → squash-merge.
# Anything that fails is written to state/sendback/<slug>.md; a worker lane picks it up as a rework.
# Honours PAUSE (exit) and NO_MERGE (verify + report, never merge).
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
[ -e "$STATE/PAUSE" ] && { echo "paused"; exit 0; }
LK="$STATE/.merge.lock"
if ! mkdir "$LK" 2>/dev/null; then
  old="$(cat "$LK/pid" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "merge lane busy (pid $old)"; exit 0; fi
  rm -rf "$LK"; mkdir "$LK" 2>/dev/null || exit 0
fi
echo $$ > "$LK/pid"; trap 'rm -rf "$LK"' EXIT
say() { echo "[$(date +%T)] $*"; }
$GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null

PRS="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json number,headRefName,isDraft,labels,title 2>/dev/null | python3 -c '
import json,sys
for p in sorted(json.load(sys.stdin), key=lambda p:p["number"]):
    h=p["headRefName"]; ls={l["name"] for l in p["labels"]}
    if not h.startswith("rsi/") or h.startswith("rsi/dream-") or h.startswith("rsi/ceo-") or p["isDraft"] or ls & {"hold","needs-ceo"}: continue
    print("%d\t%s\t%s" % (p["number"], h[4:], p["title"]))')"
[ -z "$PRS" ] && { say "no open rsi PRs"; exit 0; }
ACTIVE="$(python3 "$LANES_PY" slugs)"

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
  { echo "item: $item"; echo "attempt: $a"; echo "# Sent back by the merge lane: $title"; echo; echo "Branch rsi/$slug. Fix every finding below in one pass, then stop (the merge lane re-gates and re-reviews)."; echo; echo '```'; tail -c 6000 "$det"; echo '```'; } > "$STATE/sendback/$slug.md"
  say "sendback $slug (#$a): $title"
}
dist_resolve() { # worktree: resolve a lone web/dist/index.html conflict by rebuilding
  local wt="$1" un; un="$($GIT -C "$wt" diff --name-only --diff-filter=U)"
  [ "$un" = "web/dist/index.html" ] || return 1
  $GIT -C "$wt" checkout --ours web/dist/index.html && $GIT -C "$wt" add web/dist/index.html || return 1
  $GIT -C "$wt" commit -q --no-edit || return 1
  ( cd "$wt/ui" && npm run build >/dev/null 2>&1 ) || return 1
  [ -n "$($GIT -C "$wt" status --porcelain -- web/dist/index.html)" ] && $GIT -C "$wt" commit -q -am "chore(web): rebuild dist after merging main"
  return 0
}
gate_lock() { local w=0; while ! mkdir "$STATE/.gate.lock" 2>/dev/null; do old="$(cat "$STATE/.gate.lock/pid" 2>/dev/null)"; [ -n "$old" ] && ! kill -0 "$old" 2>/dev/null && rm -rf "$STATE/.gate.lock" && continue; sleep 20; w=$((w+20)); [ $w -gt 1500 ] && return 1; done; echo $$ > "$STATE/.gate.lock/pid"; }
gate_unlock() { rm -rf "$STATE/.gate.lock"; }

while IFS=$'\t' read -r -u 3 N SLUG TITLE; do
  [ -z "$N" ] && continue
  echo "$ACTIVE" | grep -qx "$SLUG" && { say "#$N $SLUG: lane active, skip"; continue; }
  [ -e "$STATE/sendback/$SLUG.md" ] && { say "#$N $SLUG: waiting for rework"; continue; }
  [ -e "$STATE/merge/$SLUG.blocked" ] && { say "#$N $SLUG: blocked (needs CEO)"; continue; }
  BR="rsi/$SLUG"; WT="$WT_ROOT/rsi-$SLUG"
  ITEM="$($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null | sed -n 's/.*RSI item: *\([A-Za-z0-9._-]*\).*/\1/p' | head -1)"; ITEM="${ITEM:-R-$SLUG}"
  $GIT -C "$RSI_CTRL" fetch -q origin "$BR" 2>/dev/null
  [ -e "$WT" ] || $GIT -C "$RSI_CTRL" worktree add -q "$WT" -B "$BR" "origin/$BR" 2>/dev/null || { say "#$N: cannot make worktree"; continue; }
  [ -n "$($GIT -C "$WT" status --porcelain --untracked-files=no)" ] && { say "#$N $SLUG: worktree has uncommitted tracked edits, skip"; continue; }
  $GIT -C "$WT" merge -q --ff-only "origin/$BR" >/dev/null 2>&1 || { say "#$N $SLUG: local branch diverged from origin, skip"; continue; }
  [ $DRY -eq 1 ] && { say "#$N $SLUG ($ITEM): would verify (dry-run)"; continue; }

  # 1. sync main (merge commit; the squash-merge flattens it)
  if ! $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD; then
    say "#$N $SLUG: merging origin/main"
    if ! $GIT -C "$WT" merge -q --no-edit origin/main >/dev/null 2>&1; then
      if dist_resolve "$WT"; then say "#$N: web/dist/index.html conflict resolved by rebuild"
      else
        CF="$($GIT -C "$WT" diff --name-only --diff-filter=U)"; $GIT -C "$WT" merge --abort >/dev/null 2>&1
        printf 'merge of origin/main conflicts in:\n%s\n' "$CF" > "$STATE/merge/$SLUG.err"; sendback "$SLUG" "$ITEM" "merge conflict with main" "$STATE/merge/$SLUG.err"; continue
      fi
    fi
    $GIT -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null || { say "#$N: push after merge-main failed"; continue; }
  fi
  SHA="$($GIT -C "$WT" rev-parse HEAD)"; V="$STATE/merge/$SLUG.verified"

  # 2. hold rules (MANDATE): never auto-merge these
  CH="$($GIT -C "$WT" diff --name-only origin/main...HEAD)"
  SIZE="$($GIT -C "$WT" diff --numstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | awk '{s+=$1+$2} END{print s+0}')"
  HOLD=""
  echo "$CH" | grep -qE '^(go\.mod|ui/package\.json|internal/store/.*migrat|.*migrations?/|internal/auth)' && HOLD="touches deps/migrations/auth (MANDATE: needs CEO + ADR)"
  [ "$SIZE" -gt 900 ] && HOLD="diff is $SIZE changed lines (>900): split it"
  echo "$CH" | grep -qE '^web/dist/assets/' && HOLD="web/dist/assets in diff"
  if [ -n "$HOLD" ]; then
    if [ "${HOLD#diff is}" != "$HOLD" ]; then printf '%s\n' "$HOLD" > "$STATE/merge/$SLUG.err"; sendback "$SLUG" "$ITEM" "$HOLD" "$STATE/merge/$SLUG.err"
    else touch "$STATE/merge/$SLUG.blocked"; printf -- '- %s PR #%s rsi/%s held: %s\n' "$(date '+%F %H:%M')" "$N" "$SLUG" "$HOLD" >> "$STATE/needs-ceo.md"; fi
    continue
  fi

  # 3. gate + review, cached per head SHA
  if [ "$(cut -d' ' -f1 "$V" 2>/dev/null)" != "$SHA" ] || [ "$(cut -d' ' -f2 "$V" 2>/dev/null)" != "PASS" ]; then
    say "#$N $SLUG: gate on ${SHA:0:8} ($SIZE lines)"
    GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"
    gate_lock || { say "#$N: gate lock timeout"; continue; }
    # Workers often build before their last edit: regenerate web/dist/index.html (the only tracked build output) so a stale
    # bundle is never a reason to bounce a PR. Pushed so CI sees the same file.
    if echo "$CH" | grep -q '^ui/' && [ -d "$WT/ui/node_modules" ]; then
      ( cd "$WT/ui" && npm run build >/dev/null 2>&1 ) && [ -n "$($GIT -C "$WT" status --porcelain -- web/dist/index.html)" ] \
        && $GIT -C "$WT" commit -q -m "chore(web): rebuild dist" -- web/dist/index.html && $GIT -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null
      SHA="$($GIT -C "$WT" rev-parse HEAD)"
    fi
    ( cd "$WT" && bash "$RSI_DIR/runtime/gate.sh" "$WT" ) > "$GL" 2>&1; GRC=$?; gate_unlock
    $GIT -C "$WT" checkout -q -- . 2>/dev/null   # drop build leftovers in our own rsi worktree (tracked files only)
    if [ $GRC -ne 0 ] || ! grep -q '^GATE_RESULT=PASS' "$GL"; then
      say "#$N $SLUG: gate FAIL: $(grep '^GATE_RESULT' "$GL")"; sendback "$SLUG" "$ITEM" "gate failed: $(grep '^GATE_RESULT' "$GL" | head -1)" "$GL"
      scorecard_row "$ITEM $SLUG" "$M_WORKER" "-" "gate FAIL ($(grep '^GATE_RESULT' "$GL" | head -1))" "[#$N](https://github.com/$GH_REPO/pull/$N)" "patched" "see $GL"; continue
    fi
    if echo "$CH" | grep -qE '^ui/src/.*\.tsx$' && ! echo "$CH" | grep -qE '^ui/src/.*\.(test|spec)\.' ; then
      if [ -z "$(ls "$STATE/shots/$SLUG" 2>/dev/null)" ] && ! grep -qiE 'screenshots?:.*(none|not visible)' "$STATE/lanes/$SLUG.pr-body.md" 2>/dev/null; then
        echo "UI .tsx changed but no screenshots in $STATE/shots/$SLUG/ and no 'Screenshots: none: <reason>' in the PR body (MANDATE 5). Capture 390x844 and 1100x760 before/after, or state why nothing is visible." > "$STATE/merge/$SLUG.err"
        sendback "$SLUG" "$ITEM" "missing screenshots" "$STATE/merge/$SLUG.err"; continue
      fi
    fi
    ROLE=reviewer
    echo "$CH" | grep -qE '^(internal/(auth|store|permission)|.*(permission|persist))' && ROLE=reviewer-alt
    [ "$SIZE" -gt 500 ] && ROLE=reviewer-alt
    RB="$STATE/briefs/$SLUG-review.md"; PREV="$STATE/merge/$SLUG.review.txt"
    {
      echo "You are the independent REVIEWER (read-only) for PR #$N, branch $BR, worktree $WT. The worker was a different model."
      echo "Run: git diff origin/main...HEAD (and read call sites). Behaviour claimed is in the PR body: $($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null | head -c 3500)"
      echo; echo "Checklist and grading: $RSI_DIR/roles/reviewer.md ; binding rules: $RSI_DIR/MANDATE.md ; $(wc -l < "$STATE/shots/$SLUG" 2>/dev/null || echo 0) screenshot entries under $STATE/shots/$SLUG/."
      echo "Gate output (already PASS): $GL"
      [ -s "$PREV" ] && { echo; echo "Previous review findings (verify only that they were fixed, plus anything new in the delta):"; tail -c 3500 "$PREV"; }
      echo; echo "Grade every finding blocker/major/nit. End with exactly one line: VERDICT: PASS (no blocker/major) or VERDICT: FAIL, followed by the blocker/major list."
    } > "$RB"
    say "#$N $SLUG: review by $ROLE"
    BUDGET_GUARD=8 DISPATCH_MAX_SECS=1800 "$RSI_DIR/runtime/dispatch.sh" "$ROLE" "$WT" "$RB" "merge-$SLUG-review" > "$PREV" 2>&1
    VERD="$(grep -oE 'VERDICT: *(PASS|FAIL)' "$PREV" | tail -1 | grep -oE 'PASS|FAIL')"
    if [ "$VERD" != PASS ]; then
      say "#$N $SLUG: review ${VERD:-NO VERDICT}"; sendback "$SLUG" "$ITEM" "independent review ${VERD:-gave no verdict}" "$PREV"
      scorecard_row "$ITEM $SLUG" "$M_WORKER" "$([ $ROLE = reviewer ] && echo "$M_DIRECTOR" || echo "$M_ALT")" "review ${VERD:-none}" "[#$N](https://github.com/$GH_REPO/pull/$N)" "patched" "see $PREV"; continue
    fi
    echo "$SHA PASS $ROLE" > "$V"
    $GH pr comment "$N" --repo "$GH_REPO" --body "RSI merge lane: gate PASS and independent review ($ROLE) VERDICT: PASS on ${SHA:0:8}. Gate log: ${GL##*/}." >/dev/null 2>&1
  else say "#$N $SLUG: gate+review already PASS for ${SHA:0:8}"; fi

  # 4. NO_MERGE honours
  if [ -e "$STATE/NO_MERGE" ]; then say "#$N $SLUG: verified, NO_MERGE set -> not merging"; continue; fi

  # 5. CI (bounded)
  tries=0; CIOUT=""
  while [ $tries -lt 6 ]; do CIOUT="$($GH pr checks "$N" --repo "$GH_REPO" 2>&1)"; echo "$CIOUT" | grep -qi 'no checks reported' || break; tries=$((tries+1)); sleep 30; done
  if echo "$CIOUT" | grep -qE '\bpending\b|\bqueued\b|in_progress'; then
    say "#$N $SLUG: CI pending, waiting up to 25 min"; with_timeout 1500 $GH pr checks "$N" --repo "$GH_REPO" --watch --interval 30 >/dev/null 2>&1
    CIOUT="$($GH pr checks "$N" --repo "$GH_REPO" 2>&1)"
  fi
  if echo "$CIOUT" | grep -qE '\bpending\b|\bqueued\b|in_progress'; then say "#$N $SLUG: CI still pending, retry next cycle"; continue; fi
  if echo "$CIOUT" | grep -qE '\bfail\b|cancel'; then printf '%s\n' "$CIOUT" > "$STATE/merge/$SLUG.err"; sendback "$SLUG" "$ITEM" "CI failed" "$STATE/merge/$SLUG.err"; continue; fi

  # 6. land (squash, never --delete-branch). Re-check main has not moved under us.
  $GIT -C "$WT" fetch -q origin main 2>/dev/null
  $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD || { say "#$N $SLUG: main moved during review; next cycle re-syncs"; continue; }
  if $GH pr merge "$N" --repo "$GH_REPO" --squash >/dev/null 2>"$STATE/merge/$SLUG.merge.err"; then
    MSHA="$($GH pr view "$N" --repo "$GH_REPO" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null | cut -c1-8)"
    say "#$N $SLUG: MERGED ($MSHA)"
    echo "$(date '+%F %H:%M') PR #$N $SLUG $ITEM merged ${MSHA:-?} https://github.com/$GH_REPO/pull/$N" >> "$STATE/merged.log"
    echo 0 > "$STATE/consec_blocked"
    FPY=pass; [ "$(attempts "$SLUG")" -gt 0 ] && FPY=patched
    scorecard_row "$ITEM $SLUG" "$M_WORKER" "$(cut -d' ' -f3 "$V" | sed "s#reviewer-alt#$M_ALT#; s#^reviewer\$#$M_DIRECTOR#")" "MERGED $MSHA" "[#$N](https://github.com/$GH_REPO/pull/$N)" "$FPY" "-"
    $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  else say "#$N $SLUG: merge command failed: $(tail -c 200 "$STATE/merge/$SLUG.merge.err")"; fi
done 3<<< "$PRS"

# something merged or got sent back -> let the fill pulse reassign lanes
nohup /bin/bash "$RSI_DIR/runtime/run.sh" pulse >> "$RUNS/launchd-pulse.log" 2>&1 < /dev/null & disown 2>/dev/null || true
exit 0
