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
source "$(cd "$(dirname "$0")" && pwd)/node-stamp.sh"
MERGE_WORKERS="${RSI_MERGE_WORKERS:-2}"          # verifier slots for any PR
SMALL_SLOTS="${RSI_MERGE_SMALL_SLOTS:-1}"        # extra slot only small-safe PRs may use: a 3-line refactor never queues behind two big reviews
unset SB_FIXLIST SB_GATEFAILS
say() { echo "[$(date +%T)] $*"; }
attempts() { cat "$STATE/merge/$1.attempts" 2>/dev/null || echo 0; }
item_id() { # slug body -> the marker's id, else R-<slug>: the one reader and the one fallback rule
  local id
  id="$(printf '%s\n' "$2" | python3 "$RSI_DIR/runtime/item_marker.py")"
  printf '%s\n' "${id:-R-$1}"
}
sendback() { # slug item title detail-file [source] [spec] [cmd]
  local slug="$1" item="$2" title="$3" det="$4" a live src="${5:-unknown}" spec="${6:--}" cmd="${7:--}"
  # A rework lane can push the fix WHILE this lane is still reviewing. Bouncing the PR on the SHA
  # that failed would then hand back a head that already contains the fix, burning one of three
  # attempts and 10-20 min of lane time. If the live head moved past the reviewed SHA, suppress the
  # sendback and let the next cycle re-verify the newer head. Fail closed: an unreadable or
  # malformed head, or an empty SHA (the first sync_main conflict sendback runs before SHA exists),
  # keeps today's behaviour. Suppression loses nothing: the land loop's later sendbacks
  # (sendback_mech's m>5 escalation, CI) simply defer to the next cycle, which re-detects the same
  # failure on the newer head.
  if [ -n "${SHA:-}" ] && [ -n "${N:-}" ] && live="$(pr_head "$N" 2>/dev/null)" && oid "$live" && [ "$live" != "$SHA" ]; then
    mkdir -p "$STATE/sendback/done"
    cp "$det" "$STATE/sendback/done/$slug.stale-${SHA:0:8}.md" 2>/dev/null || true
    printf -- '- %s PR #%s rsi/%s: head moved %s -> %s during review; sendback suppressed (re-review)\n' \
      "$(date '+%F %H:%M')" "$N" "$slug" "${SHA:0:8}" "${live:0:8}" >> "$STATE/needs-ceo.md"
    say "#$N $slug: head moved past reviewed ${SHA:0:8} -> ${live:0:8}; sendback suppressed"
    KICK=1; SB_SUPPRESSED=1; return
  fi
  a=$(( $(attempts "$slug") + 1 )); echo $a > "$STATE/merge/$slug.attempts"
  if [ $a -gt 3 ]; then
    touch "$STATE/merge/$slug.blocked"
    printf -- '- %s PR rsi/%s blocked after %s sendbacks: %s (see %s)\n' "$(date '+%F %H:%M')" "$slug" "$((a-1))" "$title" "$det" >> "$STATE/needs-ceo.md"
    local b=$(( $(cat "$STATE/consec_blocked" 2>/dev/null || echo 0) + 1 )); echo $b > "$STATE/consec_blocked"
    [ $b -ge 2 ] && [ ! -e "$STATE/NO_MERGE" ] && echo "two PRs blocked after their rework rounds ($(date))" > "$STATE/NO_MERGE"
    notify "Kin RSI: PR rsi/$slug blocked" "$title"; return
  fi
  write_sendback "$slug" "$item" "$title" "$det" "$a" targeted "$src" "$spec" "$cmd"
  say "sendback $slug (#$a): $title"; KICK=1
}
write_sendback() { # slug item title detail-file attempt-label kind(targeted|mechanical) [source] [spec] [cmd]
  # Provenance sits right after `kind:` so a retro can sort 18 sendbacks by who caught them
  # without opening each one (retro 2026-11-18 §5.2). Defaults are explicit words, never blank.
  local slug="$1" item="$2" title="$3" det="$4" a="$5" kind="${6:-targeted}"
  local src="${7:-unknown}" spec="${8:--}" cmd="${9:--}"
  {
    echo "item: $item"; echo "attempt: $a"; echo "kind: $kind"
    echo "source: $src"; echo "spec: $spec"; echo "cmd: $cmd"
    echo "# Sent back by the merge lane: $title"; echo
    echo "Branch rsi/$slug. Make MINIMAL, TARGETED edits: fix exactly the items below, do not regenerate or rewrite files, do not touch code the items do not name. Then re-run only the focused checks and stop (the merge lane re-gates and re-reviews the delta)."
    if [ "$kind" = mechanical ]; then echo "This is a MECHANICAL fix (conflict/format/infra), not a quality sendback: resolve it and change nothing else."; fi
    if [ -s "${SB_FIXLIST:-/nonexistent}" ]; then echo; echo "## Fix list (file:line, issue, required change)"; echo; cat "$SB_FIXLIST"; fi
    if [ -s "${SB_GATEFAILS:-/nonexistent}" ]; then echo; echo "## Failing gate lines (exact)"; echo; echo '```'; cat "$SB_GATEFAILS"; echo '```'; fi
    echo; echo "## Raw report"; echo '```'; tail -c 6000 "$det" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null; echo '```'
  } > "$STATE/sendback/$slug.md"
}
sendback_mech() { # slug item title detail-file [source] [spec] [cmd] : mechanical failure (merge conflict, format, infra). Does NOT count as a sendback; capped at 5 then counts.
  local slug="$1" item="$2" title="$3" det="$4" src="${5:-mech}" spec="${6:--}" cmd="${7:--}" m; m=$(( $(cat "$STATE/merge/$slug.mech" 2>/dev/null || echo 0) + 1 )); echo $m > "$STATE/merge/$slug.mech"
  if [ $m -gt 5 ]; then sendback "$slug" "$item" "$title (mechanical x$m)" "$det" "$src" "$spec" "$cmd"; return; fi
  SB_FIXLIST="" SB_GATEFAILS="" write_sendback "$slug" "$item" "$title" "$det" "mech-$m" mechanical "$src" "$spec" "$cmd"
  say "mechanical rework $slug (#$m, not counted as a sendback): $title"; KICK=1
}
# A sendback must not outlive its PR. After a squash merge the branch commits are not in main, so
# `git diff origin/main...rsi/<slug>` stays non-empty and lane.sh autofill used to claim a phantom
# rework round for work already landed (2026-11-19, lane 3: "cancelled: stale sendback"). The
# merge-success block archives the answered file; lane.sh archives too when it sees a terminal PR.
archive_sendback() { # slug reason sha8 — move state/sendback/<slug>.md under done/; no-op if absent
  local slug="$1" reason="$2" sha8="${3:-unknown}"
  [ -e "$STATE/sendback/$slug.md" ] || return 0
  mkdir -p "$STATE/sendback/done"
  mv "$STATE/sendback/$slug.md" "$STATE/sendback/done/$slug-$reason-$sha8.md"
}

# ------------------------------------------------- generated files (pure functions of the tree)
# A merge of origin/main can conflict in files nobody wrote by hand: the embedded console entry and
# the UI inventory baseline. Bouncing a PR back to a rework lane for those burns one of its three
# attempts and taxes every future Astryx slice, so resolve them here by regenerating. Anything else
# — another conflicted path, a failed regeneration, or a baseline that would grow — returns 1 and
# the caller writes the usual "merge conflict with main" sendback.
GEN_DIST=web/dist/index.html
GEN_INV=scripts/ui-inventory-baseline.json
# Both regenerators are overridable so rsi/runtime/tests/test-merge-gen-resolve.sh can run in a
# temp repo with stubs; the defaults are the commands a person would run.
DIST_BUILD="${RSI_DIST_BUILD_CMD:-npm run build}"
INV_UPDATE="${RSI_INV_UPDATE_CMD:-python3 scripts/check-ui-inventory.py --update}"
INV_CHECK="${RSI_INV_CHECK_CMD:-python3 scripts/check-ui-inventory.py}"
# The live PR head, overridable so rsi/runtime/tests/test-loop-sendback-stale.sh can stub it.
PR_HEAD_CMD="${RSI_PR_HEAD_CMD:-}"   # test seam; empty = the real gh call
pr_head() { # <pr-number> -> prints the live head oid, non-zero on failure (an override reads it as $1)
  if [ -n "$PR_HEAD_CMD" ]; then bash -c "$PR_HEAD_CMD" pr-head "$1"
  else "$GH" pr view "$1" --repo "$GH_REPO" --json headRefOid --jq .headRefOid; fi
}
# A head is an oid and nothing else: a gh warning or a blank line on stdout must read as unreadable.
oid() { case "${1:-}" in ""|*[!0-9a-fA-F]*) return 1 ;; esac; }
# The journey spec the UX gate walked, as a 12-hex revision of the WHOLE spec: the index and
# every per-journey file under rsi/runtime/ux/journeys/, so the sendback header names a revision
# that moves when any journey body moves. That is provenance, not cache invalidation: the UX PASS
# cache already keys on the PR diff plus origin/main:ui. #251's false red was a walker/spec
# mismatch: the sendback named neither, so the retro could not tell it from a real defect. Never
# fails: the header line must always be writable, and an empty file list prints "-" rather than
# hashing nothing.
spec_rev() { # <worktree> -> 12-hex revision of the split spec, or -
  local wt="${1:-}" files rev o ids ok
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    files="$($GIT -C "$wt" ls-tree -r --name-only HEAD -- rsi/runtime/ux/journeys.json rsi/runtime/ux/journeys 2>/dev/null)" || files=""
    if [ -n "$files" ]; then
      ids=""; ok=1
      while IFS= read -r f; do
        o="$($GIT -C "$wt" rev-parse "HEAD:$f" 2>/dev/null)" || { ok=0; break; }
        ids="$ids$o"$'\n'
      done <<< "$(printf '%s\n' "$files" | LC_ALL=C sort)"
      if [ "$ok" -eq 1 ] && [ -n "$ids" ]; then
        rev="$(printf '%s' "$ids" | shasum -a 1 | cut -c1-12)"
        case "$rev" in
          ""|*[!0-9a-f]*) ;;
          *) [ ${#rev} -eq 12 ] && { printf '%s\n' "$rev"; return 0; } ;;
        esac
      fi
    fi
  fi
  printf '%s\n' -
}

ratchet_ok() { # worktree -> 0 when the regenerated inventory did not grow past origin/main's copy
  local wt="$1" base rc; base="$(mktemp)" || return 1
  $GIT -C "$wt" show "origin/main:$GEN_INV" > "$base" 2>/dev/null || { rm -f "$base"; return 1; }
  python3 - "$base" "$wt/$GEN_INV" <<'PY'
import json, sys
# "Counts may only go down" (scripts/check-ui-inventory.py) outranks merge convenience: a merge
# that would raise the ratchet is a sendback, never a commit.
try:
    old = json.load(open(sys.argv[1], encoding="utf-8"))["metrics"]
    new = json.load(open(sys.argv[2], encoding="utf-8"))["metrics"]
except Exception as exc:
    print("inventory baseline unreadable: %s" % exc, file=sys.stderr); sys.exit(1)
grown = []
for key, fields in sorted(new.items()):
    prev = old.get(key) or {}
    for field in ("occurrences", "files"):
        was, now = prev.get(field), fields.get(field)
        if not isinstance(was, int) or not isinstance(now, int):
            grown.append("%s.%s: no integer count to compare" % (key, field))
        elif now > was:
            grown.append("%s.%s: %d -> %d" % (key, field, was, now))
if grown:
    print("inventory ratchet would grow: " + "; ".join(grown), file=sys.stderr); sys.exit(1)
PY
  rc=$?; rm -f "$base"; return $rc
}

gen_resolve() { # worktree -> 0 resolved and committed; 1 anything else (caller aborts and sends back)
  local wt="$1" un p has_dist=0 has_inv=0
  un="$($GIT -C "$wt" diff --name-only --diff-filter=U)" || return 1
  [ -n "$un" ] || return 1
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    [ "$p" = "$GEN_DIST" ] || [ "$p" = "$GEN_INV" ] || return 1   # a source conflict is a person's job
  done <<< "$un"
  echo "$un" | grep -qxF "$GEN_DIST" && has_dist=1
  echo "$un" | grep -qxF "$GEN_INV" && has_inv=1
  # Take ours as the base, then REGENERATE BEFORE COMMITTING: a failed build or a growing ratchet
  # must leave `git merge --abort` possible, and that only restores an uncommitted merge. The
  # regenerated files ride in the merge commit itself, so the tree is clean when this returns.
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    $GIT -C "$wt" checkout --ours -- "$p" || return 1
  done <<< "$un"
  if [ $has_dist -eq 1 ]; then
    # A stale or symlinked ui install made this rebuild die silently behind the old `-d` test.
    # No lockfile (hermetic temp repos) means there is no install to repair.
    [ -f "$wt/ui/package-lock.json" ] && { node_stamp_ensure "$wt/ui" || return 1; }
    ( cd "$wt/ui" && bash -c "$DIST_BUILD" ) >/dev/null 2>&1 || return 1
  fi
  if [ $has_inv -eq 1 ]; then
    ( cd "$wt" && bash -c "$INV_UPDATE" ) >/dev/null 2>&1 || return 1
    ratchet_ok "$wt" || return 1
  fi
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    $GIT -C "$wt" add -- "$p" || return 1
  done <<< "$un"
  $GIT -C "$wt" commit -q --no-edit || return 1
}

main_move_verdict() { # <incoming-paths> <pr-changed-paths> — sets MOVE_TAG (CARRY|CARRY-UI|REGATE)
  # and MOVE_REASON. The one disjoint classifier: origin/main moved under a verified PR. CARRY when
  # every incoming path is disjoint from the PR's own files and packages and from the shared
  # surfaces, CARRY-UI when a ui leaf moved (alone or beside disjoint Go packages), REGATE otherwise. The callers decide what a CARRY
  # means (carry the gate across a merge, or skip the step-1 sync entirely). Bias: every path this
  # cannot positively classify re-gates.
  # A here-document inside $( ) is mis-parsed by the macOS /bin/bash 3.2 this script runs on
  # (it quote-scans the body while looking for the closing paren), so the verdict goes through a
  # temp file, like gate.sh's changed-path listing.
  local dfile tag reason
  MOVE_TAG=""; MOVE_REASON=""
  dfile="$(mktemp "${TMPDIR:-/tmp}/rsi-carry.XXXXXX")" \
    || { MOVE_TAG="REGATE"; MOVE_REASON="cannot create a temp file for the main-move predicate"; return 1; }
  python3 - "$1" "$2" > "$dfile" <<'PY'
import sys

incoming = [p for p in sys.argv[1].splitlines() if p]
pr_files = [p for p in sys.argv[2].splitlines() if p]
pr_set = set(pr_files)

# Never gate-relevant on their own: published docs, loop state, generated outputs.
def dropped(p):
    return (p.startswith("docs/") or p.startswith("rsi/") or p.endswith(".md")
            or p in ("web/dist/index.html", "scripts/ui-inventory-baseline.json"))

# Surfaces many things depend on: a move here can change what any PR's verification means.
shared_dirs = (
    "ui/src/components/ui/", "ui/src/components/layout/", "ui/src/design/",
    "ui/src/lib/", "ui/src/api/", "ui/src/store/", "ui/src/hooks/", "ui/src/i18n/",
    "cmd/", "internal/api/", ".github/", "desktop/", "mobile/", "scripts/", "web/",
)
shared_files = {
    "ui/src/index.css", "ui/src/App.tsx", "ui/src/main.tsx",
    "ui/package.json", "ui/package-lock.json", "go.mod", "go.sum",
}
# A PR's Go package is internal/<pkg>/: a sibling file in it can change the package's behaviour.
pr_pkgs = {"/".join(p.split("/")[:2]) + "/" for p in pr_files
           if p.startswith("internal/") and p.count("/") >= 2}
pr_root_files = {p for p in pr_files if "/" not in p}

carry = []      # incoming paths that justify the carry
need_ui = False  # a ui leaf moved: the build+inventory safety step must still pass
for p in incoming:
    if dropped(p):
        continue
    if p in shared_files or p.startswith(shared_dirs):
        print("REGATE\tshared surface moved: %s" % p); sys.exit()
    if p.startswith(("ui/src/components/", "ui/src/pages/")):
        if p in pr_set:
            print("REGATE\tthe PR's own file moved: %s" % p); sys.exit()
        carry.append(p); need_ui = True
        continue
    if p.startswith("ui/"):
        print("REGATE\tunclassified ui path moved: %s" % p); sys.exit()
    if p.startswith("internal/"):
        if p.count("/") < 2:
            print("REGATE\tinternal root file moved: %s" % p); sys.exit()
        pkg = "/".join(p.split("/")[:2]) + "/"
        if pkg in pr_pkgs:
            print("REGATE\tthe PR's own package moved: %s" % pkg); sys.exit()
        carry.append(p)
        continue
    if p in pr_root_files:
        print("REGATE\tthe PR's own top-level file moved: %s" % p); sys.exit()
    print("REGATE\tunclassified path moved: %s" % p); sys.exit()

if not carry:
    print("CARRY\tnothing but docs/rsi/generated files moved")
elif need_ui:
    print("CARRY-UI\t" + " ".join(carry))
else:
    print("CARRY\t" + " ".join(carry))
PY
  { read -r tag reason; } < "$dfile"
  rm -f "$dfile"
  MOVE_TAG="${tag:-REGATE}"
  MOVE_REASON="${reason:-the main-move predicate produced no decision}"
  return 0
}

carry_forward() { # <worktree> <incoming-paths> <pr-changed-paths> <gate-file> <new-sha> <role>
  # origin/main moved under a verified PR. Carry the verified gate to <new-sha> only when every
  # incoming path is disjoint from the PR's own files and packages and from the shared surfaces;
  # otherwise drop the gate file and let the caller re-gate. Sets CARRY_REASON for the log line.
  # 0 = carried (gate file now names <new-sha>), 1 = needs a fresh gate (gate file removed).
  # Bias: every path this cannot positively classify re-gates. CI still runs on the merged head.
  local wt="$1" incoming="$2" changed="$3" gatefile="$4" newsha="$5" role="$6"
  CARRY_REASON=""
  main_move_verdict "$incoming" "$changed"
  case "$MOVE_TAG" in
    CARRY)
      CARRY_REASON="$MOVE_REASON"
      echo "$newsha PASS $role" > "$gatefile"; return 0 ;;
    CARRY-UI)
      # Leaf ui paths disjoint from the PR's own files. Prove the merged tree still holds the two
      # things only a build can answer: the inventory ratchet and a dist rebuild that reproduces
      # the committed web/dist/index.html. Any doubt (failed step, changed dist) re-gates.
      if ( cd "$wt" && bash -c "$INV_CHECK" ) >/dev/null 2>&1 \
         && ( cd "$wt/ui" && bash -c "$DIST_BUILD" ) >/dev/null 2>&1 \
         && $GIT -C "$wt" diff --quiet -- web/dist/index.html; then
        CARRY_REASON="$MOVE_REASON; inventory+build green, web/dist/index.html unchanged"
        echo "$newsha PASS $role" > "$gatefile"; return 0
      fi
      $GIT -C "$wt" checkout -q -- web/dist/index.html 2>/dev/null || true
      CARRY_REASON="ui safety step failed (inventory/build/dist) after: $MOVE_REASON"
      rm -f "$gatefile"; return 1 ;;
    *)
      CARRY_REASON="${MOVE_REASON:-carry predicate produced no decision}"
      rm -f "$gatefile"; return 1 ;;
  esac
}

# ------------------------------------------------------------------ queue-time carry
pr_diff_hash() { # <worktree> — the review key (step 4's DH): the PR's own diff, dist + lockfile excluded
  $GIT -C "$1" diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16
}

queue_carry() { # <wt> <old-head> <new-sha> <incoming> <pr-changed> <gate-file> <reviewed-file> <role>
  # Step 1 just merged origin/main into a verified PR. Run the same predicate the land-time carry
  # uses: a move that is disjoint from the PR's own files and the shared surfaces keeps the gate
  # instead of paying for a full fresh gate. Sets QUEUE_CARRY_REASON.
  # 0 = carried (gate and review cache now name <new-sha>); 1 = no carry. The gate file is only
  # removed when carry_forward itself decides a re-gate; every earlier refusal leaves it alone so
  # the ordinary NEED_GATE check still sees a gate that may already name the current head.
  local wt="$1" oldhead="$2" newsha="$3" incoming="$4" changed="$5" gatefile="$6" reviewed="$7" role="$8"
  local gsha="" gpass="" grole="" rdh="" rver="" rrole=""
  QUEUE_CARRY_REASON=""
  if [ "$newsha" = "$oldhead" ]; then
    QUEUE_CARRY_REASON="origin/main did not move under the PR"; return 1
  fi
  [ -s "$gatefile" ] && { read -r gsha gpass grole _ < "$gatefile" 2>/dev/null || true; }
  if [ "$gsha" != "$oldhead" ] || [ "$gpass" != PASS ]; then
    QUEUE_CARRY_REASON="the gate names ${gsha:-no head} (${gpass:-no verdict}), not the pre-sync head $oldhead; not a carry candidate"
    return 1
  fi
  # Use the role recorded in the gate file when the caller has none: it is the reviewer that
  # actually passed this tree, and the review cache is keyed by role as well as by diff.
  role="${role:-${grole:-reviewer}}"
  if ! carry_forward "$wt" "$incoming" "$changed" "$gatefile" "$newsha" "$role"; then
    QUEUE_CARRY_REASON="$CARRY_REASON"; return 1
  fi
  QUEUE_CARRY_REASON="$CARRY_REASON"
  # The review is keyed by the PR's own diff, which a disjoint main move does not change. Move its
  # recorded SHA to the merged head so step 4 reuses the PASS; anything other than a PASS for this
  # exact diff is left for the review path to re-decide from DH.
  [ -s "$reviewed" ] && { read -r rdh rver _ rrole _ < "$reviewed" 2>/dev/null || true; }
  if [ "$rver" = PASS ] && [ "$rdh" = "$(pr_diff_hash "$wt")" ]; then
    printf '%s PASS %s %s\n' "$rdh" "$newsha" "${rrole:-$role}" > "$reviewed"
    QUEUE_CARRY_REASON="$QUEUE_CARRY_REASON; review cache moved to $newsha"
  fi
  return 0
}

queue_carry_step() { # <wt> <old-head> <incoming> <new-sha> <pr-changed> <gate-file> <reviewed-file> [role]
  # The one call site step 1 and --queue-carry-check share, so the seam proves the wiring rather
  # than a parallel copy of it. The role defaults to the gate file's field 3.
  queue_carry "$1" "$2" "$4" "$3" "$5" "$6" "$7" "${8:-$(cut -d' ' -f3 "$6" 2>/dev/null | head -1)}"
}

# ------------------------------------------------------------------ CI-first hold
CI_HOLD_MAX_SECS=2700   # 45 min: a hold may defer the step-1 sync at most this long
ci_hold_window() { # <marker-file> -> 0 when a hold may continue (fresh marker, or one just written)
  # The one expiry clock both holds share: a PR can never be held away from main for more than
  # CI_HOLD_MAX_SECS, whichever reason (pending CI or a disjoint main move) opened the window.
  # 1 = unusable or expired marker; CI_FIRST_REASON then carries the fail-open detail.
  local marker="$1" now at age
  now="$(date +%s)"
  if [ -s "$marker" ]; then
    at="$(tr -dc '0-9' < "$marker" 2>/dev/null)"
    [ -n "$at" ] || { CI_FIRST_REASON="the hold marker is unreadable: failing open to the sync"; return 1; }
    age=$(( now - at ))
    if [ "$age" -ge "$CI_HOLD_MAX_SECS" ]; then
      CI_FIRST_REASON="the hold expired after ${age}s (max ${CI_HOLD_MAX_SECS}s): syncing and re-gating"
      return 1
    fi
  else
    date +%s > "$marker" 2>/dev/null \
      || { CI_FIRST_REASON="cannot write the hold marker: failing open to the sync"; return 1; }
  fi
  return 0
}
ci_first_decision() { # <wt> <branch> <gate-file> <reviewed-file> <ci-state> <marker-file> [incoming-paths] [pr-changed-paths]
  # The one call site step 1 and --ci-first-check share. Step 1 merges origin/main into the branch
  # on EVERY verifier start; while CI is still running on a head whose gate and review are already
  # cached, that merge moves the head, cancels the in-flight CI run and buys a fresh gate for
  # nothing — one PR paid four full gates and took 90 minutes to merge this way.
  # A green CI with both caches valid is held the same way when main moved only paths this PR does
  # not verify (main_move_verdict says CARRY/CARRY-UI): the gate and review are keyed to the PR's
  # own diff, which such a move does not change, so merging would only cancel a green run.
  # 0 = HOLD (skip sync_main; the marker is written on the first hold so the window ages out),
  # 1 = SYNC (today's behaviour). Sets CI_FIRST_REASON and CI_FIRST_KIND (hold-ci|hold-disjoint|
  # sync) for the caller's one additive log line.
  # Bias: every unknown (unreadable head, missing cache, failed CI probe, unparsable marker,
  # missing/empty path lists) syncs; holding is only ever justified by positive evidence.
  local wt="$1" br="$2" gatefile="$3" reviewed="$4" cis="$5" marker="$6"
  local incoming="${7:-}" changed="${8:-}"
  local hd remote gsha="" gpass="" rdh="" rver=""
  CI_FIRST_REASON=""; CI_FIRST_KIND="sync"
  hd="$($GIT -C "$wt" rev-parse HEAD 2>/dev/null)" || hd=""
  remote="$($GIT -C "$wt" rev-parse "origin/$br" 2>/dev/null)" || remote=""
  [ -n "$hd" ] || { CI_FIRST_REASON="cannot read HEAD in the worktree"; return 1; }
  [ -s "$gatefile" ] && { read -r gsha gpass _ < "$gatefile" 2>/dev/null || true; }
  if [ "$gsha" != "$hd" ] || [ "$gpass" != PASS ]; then
    CI_FIRST_REASON="no cached gate PASS for ${hd:0:8} (gate names ${gsha:0:8} ${gpass:-none})"
    return 1
  fi
  [ -s "$reviewed" ] && { read -r rdh rver _ < "$reviewed" 2>/dev/null || true; }
  if [ "$rver" != PASS ] || [ "$rdh" != "$(pr_diff_hash "$wt")" ]; then
    CI_FIRST_REASON="no cached review PASS for this diff (review names ${rdh:-none} ${rver:-none})"
    return 1
  fi
  if [ "$hd" != "$remote" ]; then
    CI_FIRST_REASON="the local head ${hd:0:8} is not origin/$br (${remote:0:8}): rework not pushed yet"
    return 1
  fi
  if [ "$cis" = pending ]; then
    ci_hold_window "$marker" || return 1
    CI_FIRST_KIND="hold-ci"
    CI_FIRST_REASON="CI pending on ${hd:0:8}"
    return 0
  fi
  if [ "$cis" = green ] && [ -n "$incoming" ] && [ -n "$changed" ]; then
    main_move_verdict "$incoming" "$changed"
    case "$MOVE_TAG" in
      CARRY|CARRY-UI)
        ci_hold_window "$marker" || return 1
        CI_FIRST_KIND="hold-disjoint"
        CI_FIRST_REASON="main's new commits touch no path this PR verifies ($MOVE_TAG)"
        return 0 ;;
    esac
  fi
  CI_FIRST_REASON="CI is ${cis:-unknown} on ${hd:0:8}: the land path needs the main sync"
  return 1
}

# ------------------------------------------------------------------ dispatcher
if [ "${1:-}" != "--one" ]; then
  [ "${1:-}" = "--resolve-generated" ] && { gen_resolve "${2:?worktree required}"; exit $?; }
  # Hermetic seam for rsi/runtime/tests/test-gate-carry.sh: the queue-time carry step 1 applies
  # after sync_main, with lists of paths on disk. No locks, fetch, gate, review, merge or dispatch.
  if [ "${1:-}" = "--queue-carry-check" ]; then
    QWT="${2:?worktree required}"; QOLD="${3:?pre-sync head required}"; QNEW="${4:?merged head required}"
    QIN="${5:?incoming list required}"; QCH="${6:?pr changed list required}"
    QGATE="${7:?gate file required}"; QREV="${8:?reviewed file required}"; QROLE="${9:-}"
    if queue_carry_step "$QWT" "$QOLD" "$(cat "$QIN")" "$QNEW" "$(cat "$QCH")" "$QGATE" "$QREV" "$QROLE"; then
      echo "CARRY $QUEUE_CARRY_REASON"; exit 0
    fi
    echo "REGATE $QUEUE_CARRY_REASON"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-verifier-ci-hold.sh: run the same ci_first_decision()
  # step 1 calls, with the non-waiting CI read passed in. No lock, fetch, gate, review or dispatch.
  if [ "${1:-}" = "--ci-first-check" ]; then
    [ $# -ge 7 ] || {
      echo "usage: merge.sh --ci-first-check <worktree> <branch> <gate-file> <reviewed-file> <ci-state> <marker-file> [incoming-paths file] [pr-changed-paths file]" >&2
      exit 2
    }
    CF_IN=""; CF_CH=""
    [ -n "${8:-}" ] && [ -r "$8" ] && CF_IN="$(cat "$8" 2>/dev/null)"
    [ -n "${9:-}" ] && [ -r "$9" ] && CF_CH="$(cat "$9" 2>/dev/null)"
    if ci_first_decision "$2" "$3" "$4" "$5" "$6" "$7" "$CF_IN" "$CF_CH"; then
      echo "HOLD $CI_FIRST_REASON"; exit 0
    fi
    echo "SYNC $CI_FIRST_REASON"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-gate-carry.sh: run the same carry_forward() the land
  # loop calls, with lists of paths on disk. No gate, no review, no relaunch.
  if [ "${1:-}" = "--carry-check" ]; then
    CWT="${2:?worktree required}"; CIN="${3:?incoming list required}"; CCH="${4:?pr changed list required}"
    CGATE="${5:?gate file required}"; CSHA="${6:?merged head required}"; CROLE="${7:-reviewer}"
    if carry_forward "$CWT" "$(cat "$CIN")" "$(cat "$CCH")" "$CGATE" "$CSHA" "$CROLE"; then
      echo "CARRY $CARRY_REASON"; exit 0
    fi
    echo "REGATE $CARRY_REASON"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-loop-sendback-stale.sh: run the same sendback() the
  # land loop calls with a stubbed PR head. No lock, fetch, gate, review, merge or dispatch.
  if [ "${1:-}" = "--stale-check" ]; then
    SLUG="${2:?slug required}"; ITEM="${3:?item required}"; N="${4:?pr required}"
    SHA="${5-}"; DET="${6:?detail file required}"
    sendback "$SLUG" "$ITEM" "stale-check" "$DET" "test" - "bash rsi/runtime/tests/test-loop-sendback-stale.sh"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-sendback-provenance.sh: run the same sendback_mech()
  # the sync_main conflict path calls, so its forwarding into write_sendback is proven end to end.
  if [ "${1:-}" = "--mech-check" ]; then
    sendback_mech "${2:?slug required}" "${3:?item required}" "${4:?title required}" \
      "${5:?detail file required}" "${6:-}" "${7:-}" "${8:-}"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-sendback-provenance.sh: write one sendback through
  # the same write_sendback() the land loop uses, provenance lines included. No state, no gh.
  if [ "${1:-}" = "--sendback-check" ]; then
    write_sendback "${2:?slug required}" "${3:?item required}" "${4:?title required}" \
      "${5:?detail file required}" "${6:?attempt required}" "${7:?kind required}" \
      "${8:-}" "${9:-}" "${10:-}"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-sendback-provenance.sh: the same spec_rev() the UX
  # gate sendback calls, against a temp repo. No state, no gh.
  if [ "${1:-}" = "--spec-rev" ]; then
    spec_rev "${2:?worktree required}"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-loop-sendback-stale.sh: read the item id from a body
  # file exactly as the verifier does, including the R-<slug> fallback. No state, no gh.
  if [ "${1:-}" = "--item-check" ]; then
    item_id "${2:?slug required}" "$(cat "${3:?body file required}")"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-loop-sendback-stale.sh: archive a landed PR's
  # sendback through the same archive_sendback() the merge-success block calls. No lock, gh or network.
  if [ "${1:-}" = "--archive-check" ]; then
    archive_sendback "${2:?slug required}" merged "${3:?sha8 required}"
    exit 0
  fi
  DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
  [ -e "$STATE/PAUSE" ] && { echo "paused"; exit 0; }
  # legacy single-instance lock (pre-pipeline merge.sh still running): do not double-process
  old="$(cat "$STATE/.merge.lock/pid" 2>/dev/null || true)"; [ -n "$old" ] && kill -0 "$old" 2>/dev/null && { echo "legacy merge lane still running (pid $old)"; exit 0; }
  DL="$STATE/.dispatch.lock"
  if ! mkdir "$DL" 2>/dev/null; then o="$(cat "$DL/pid" 2>/dev/null || true)"; if [ -n "$o" ] && kill -0 "$o" 2>/dev/null; then exit 0; fi; rm -rf "$DL"; mkdir "$DL" 2>/dev/null || exit 0; fi
  echo $$ > "$DL/pid"; trap 'rm -rf "$DL"' EXIT
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  # `files` makes the GraphQL query heavy and it occasionally fails/times out: retry once, then fall back to a light query (tier unknown = large).
  PRJ="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json number,headRefName,isDraft,labels,title,files,body 2>/dev/null)"
  echo "$PRJ" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 || { sleep 3; PRJ="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json number,headRefName,isDraft,labels,title,files,body 2>/dev/null)"; }
  echo "$PRJ" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 || PRJ="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json number,headRefName,isDraft,labels,title,body 2>/dev/null)"
  PRS="$(printf '%s' "$PRJ" | STATE="$STATE" RSI_DIR="$RSI_DIR" TIERPY="$RSI_DIR/runtime/review-tier.py" python3 -c '
import json,sys,os,subprocess
sys.path.insert(0, os.path.join(os.environ["RSI_DIR"], "runtime"))
from item_marker import parse_item
st=os.environ["STATE"]; rows=[]
for p in json.load(sys.stdin):
    h=p["headRefName"]; ls={l["name"] for l in p["labels"]}
    if not h.startswith("rsi/") or h.startswith("rsi/dream-") or h.startswith("rsi/ceo-") or p["isDraft"] or ls & {"hold","needs-ceo"}: continue
    slug=h[4:]; item=parse_item(p.get("body") or "")
    try: att=int(open("%s/merge/%s.attempts" % (st,slug)).read().strip() or 0)
    except Exception: att=0
    tier="large"
    try:
        if "files" not in p: raise ValueError("no files")
        out=subprocess.run(["python3",os.environ["TIERPY"],"--title",p["title"],"--item",item,"--attempts",str(att),"--gh-json","-"],input=json.dumps(p.get("files") or []),capture_output=True,text=True,timeout=20).stdout.split()
        tier=out[0] if out else "large"
    except Exception: pass
    rows.append((0 if tier=="small" else 1, p["number"], slug, p["title"].replace("\t"," "), tier))
for _,n,slug,title,tier in sorted(rows):   # small-safe first, then PR number
    print("%d\t%s\t%s\t%s" % (n,slug,title,tier))')"
  [ -z "$PRS" ] && { say "no open rsi PRs"; exit 0; }
  ACTIVE="$(python3 "$LANES_PY" slugs)"
  running=0; running_big=0
  for l in "$STATE"/merge/*.lock; do
    [ -d "$l" ] && kill -0 "$(cat "$l/pid" 2>/dev/null || echo 0)" 2>/dev/null || continue
    running=$((running+1)); rs="$(basename "$l" .lock)"; [ "$(cat "$STATE/merge/$rs.tier" 2>/dev/null)" = small ] || running_big=$((running_big+1))
  done
  while IFS=$'\t' read -r -u 3 N SLUG TITLE TIER; do
    [ -z "$N" ] && continue
    echo "$ACTIVE" | grep -qx "$SLUG" && { say "#$N $SLUG: lane active, skip"; continue; }
    [ -e "$STATE/sendback/$SLUG.md" ] && { say "#$N $SLUG: waiting for rework"; continue; }
    [ -e "$STATE/merge/$SLUG.blocked" ] && { say "#$N $SLUG: blocked (needs CEO)"; continue; }
    L="$STATE/merge/$SLUG.lock"
    if [ -d "$L" ]; then if kill -0 "$(cat "$L/pid" 2>/dev/null || echo 0)" 2>/dev/null; then continue; fi; rm -rf "$L"; fi
    # sol (ChatGPT allowance) exhausted: large-tier reviews need it and would only loop on 429. Wait for it;
    # small/medium (DeepSeek) PRs are unaffected. If a strong review for some head SHA is already on disk, start
    # the verifier anyway — it will reuse that verdict when HEAD is unchanged, and hold internally if HEAD moved.
    if [ "$TIER" = large ] && [ "$(awk '{print $2}' "$STATE/merge/$SLUG.reviewed" 2>/dev/null)" != PASS ] && [ ! -s "$STATE/merge/$SLUG.strong" ] && python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1; then
      say "#$N $SLUG [large]: waiting for a strong reviewer (Hydrogen/sol quota)"; continue; fi
    [ -e "$STATE/merge/$SLUG.queued_at" ] || date +%s > "$STATE/merge/$SLUG.queued_at"   # first time it was eligible: queue-wait metric
    # Slot policy: MERGE_WORKERS general slots + SMALL_SLOTS reserved. big/medium PRs use the general slots; small-safe PRs may use any
    # free slot but never the last one a big PR could take (small concurrency <= MERGE_WORKERS + SMALL_SLOTS - 1), so neither starves.
    if [ "$TIER" = small ]; then [ $((running - running_big)) -ge $((MERGE_WORKERS + SMALL_SLOTS - 1)) ] || [ $running -ge $((MERGE_WORKERS + SMALL_SLOTS)) ] && { say "#$N $SLUG [small]: small slots busy"; continue; }
    else [ $running_big -ge "$MERGE_WORKERS" ] || [ $running -ge $((MERGE_WORKERS + SMALL_SLOTS)) ] && { say "#$N $SLUG [$TIER]: all $MERGE_WORKERS general verifier slots busy"; continue; }; fi
    [ $DRY -eq 1 ] && { say "#$N $SLUG: would verify (dry-run)"; running=$((running+1)); continue; }
    mkdir "$L" 2>/dev/null || continue; echo $$ > "$L/pid"   # claimed; the worker rewrites its own pid
    echo "$TIER" > "$STATE/merge/$SLUG.tier"; [ "$TIER" = small ] || running_big=$((running_big+1))
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
ITEM="$(item_id "$SLUG" "$BODY")"
V="$STATE/merge/$SLUG.verified"; RV="$STATE/merge/$SLUG.reviewed"; PREV="$STATE/merge/$SLUG.review.txt"
QW=""; if [ -s "$STATE/merge/$SLUG.queued_at" ]; then QW=" queue_wait=$(( (T0 - $(cat "$STATE/merge/$SLUG.queued_at")) / 60 ))m"; rm -f "$STATE/merge/$SLUG.queued_at"; fi
say "#$N $SLUG ($ITEM) verifier start$QW"; [ -n "$QW" ] && echo "$(date '+%F %H:%M') #$N $SLUG verifier_started$QW tier=$(cat "$STATE/merge/$SLUG.tier" 2>/dev/null || echo ?)" >> "$STATE/merge/cycles.log"

mklock() { local d="$1" max="$2" w=0; while ! mkdir "$d" 2>/dev/null; do o="$(cat "$d/pid" 2>/dev/null)"; if [ -n "$o" ] && ! kill -0 "$o" 2>/dev/null; then rm -rf "$d"; continue; fi; sleep 15; w=$((w+15)); [ $w -gt "$max" ] && return 1; done; echo $$ > "$d/pid"; }
sync_main() { # -> 0 ok (pushed if changed), 1 conflict (sendback written), 2 transient failure
  # Any sync ends a CI-first hold: the head this marker bounded is gone, so a later pending CI
  # starts its own fresh window instead of inheriting an expired one.
  rm -f "$STATE/merge/$SLUG.ci-hold"
  if $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD; then
    if [ "$($GIT -C "$WT" rev-parse HEAD)" != "$($GIT -C "$WT" rev-parse "origin/$BR" 2>/dev/null)" ]; then
      with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null || { say "#$N: push of prior local merge failed"; return 2; }
    fi
    return 0
  fi
  say "#$N $SLUG: merging origin/main"
  if ! $GIT -C "$WT" merge -q --no-edit origin/main >/dev/null 2>&1; then
    if gen_resolve "$WT"; then say "#$N: conflict(s) in generated files resolved by regeneration"
    else CF="$($GIT -C "$WT" diff --name-only --diff-filter=U)"; $GIT -C "$WT" merge --abort >/dev/null 2>&1
      printf 'merge of origin/main conflicts in:\n%s\n' "$CF" > "$STATE/merge/$SLUG.err"
      sendback_mech "$SLUG" "$ITEM" "merge conflict with main" "$STATE/merge/$SLUG.err" "mech" - "$GIT -C $WT merge -q --no-edit origin/main"; return 1; fi
  fi
  with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null || { say "#$N: push after merge-main failed"; return 2; }
  return 0
}
check_buckets() { # gh's `pr checks --json name,bucket,link` on stdin -> space-separated buckets
  python3 -c 'import json,sys
try: print(" ".join(c.get("bucket","") for c in json.load(sys.stdin)))
except Exception: pass' 2>/dev/null
}
ci_probe_once() { # one NON-waiting CI read: prints green|pending|fail, nothing when the read failed
  # Step 1's hold decision needs only to know whether CI is still running; it must never pay
  # ci_state's 25-minute pending wait (that wait belongs to the land loop, after verification).
  # Empty output is the fail-open signal: ci_first_decision then syncs as before.
  local out buckets
  out="$($GH pr checks "$N" --repo "$GH_REPO" --json name,bucket,link 2>&1)"
  echo "$out" | grep -qi 'no checks reported' && { echo green; return 0; }
  buckets="$(printf '%s' "$out" | check_buckets)"
  [ -n "$buckets" ] || return 0
  case " $buckets " in
    *" fail "*) echo fail ;;
    *" pending "*) echo pending ;;
    *" pass "*) echo green ;;
    *" cancel "*) echo pending ;;
    *) echo green ;;
  esac
}
ci_state() { # prints green|pending|fail ; waits (bounded) while pending
  local tries=0 out buckets
  while [ $tries -lt 6 ]; do
    out="$($GH pr checks "$N" --repo "$GH_REPO" --json name,bucket,link 2>&1)"
    echo "$out" | grep -qi 'no checks reported' && break
    [ -n "$(printf '%s' "$out" | check_buckets)" ] && break
    tries=$((tries+1)); sleep 30
  done
  printf '%s\n' "$out" > "$STATE/merge/$SLUG.ci.txt"
  # No checks keeps the old behaviour: the gate and review already ran.
  echo "$out" | grep -qi 'no checks reported' && { echo green; return; }
  buckets="$(printf '%s' "$out" | check_buckets)"
  case " $buckets " in
    *" pending "*)
      say "#$N $SLUG: CI pending, waiting up to 25 min" >&2
      with_timeout 1500 $GH pr checks "$N" --repo "$GH_REPO" --watch --interval 30 >/dev/null 2>&1
      out="$($GH pr checks "$N" --repo "$GH_REPO" --json name,bucket,link 2>&1)"
      printf '%s\n' "$out" > "$STATE/merge/$SLUG.ci.txt"
      buckets="$(printf '%s' "$out" | check_buckets)" ;;
  esac
  # cancel-in-progress leaves a cancelled check next to the replacement run.
  # Ignore cancelled entries whenever a real verdict exists: a cancelled run
  # next to a passing replacement is green, not pending forever. A cancelled
  # run with no replacement yet is still pending (retry next cycle), and a
  # real failure is always fail.
  case " $buckets " in
    *" fail "*) echo fail ;;
    *" pending "*) echo pending ;;
    *" pass "*) echo green ;;
    *" cancel "*) echo pending ;;
    *) echo green ;;
  esac
}

# A gate or CI failure is mechanical when every failing test is outside the PR's
# touched packages, or is a known-flaky name (runtime/flaky-tests.txt): rerun
# once and do not count it as a quality sendback. Rework lanes cannot fix tests
# they were not allowed to touch, so we also do not kick a worker.
outside_tests_only() { # worktree log [summary] — writes $STATE/merge/$SLUG.outside-reason.txt
  local wt="$1" log="$2" sum="${3:-}" reason="$STATE/merge/$SLUG.outside-reason.txt"
  if python3 "$RSI_DIR/runtime/outside-tests.py" --worktree "$wt" --log "$log" ${sum:+--summary "$sum"} > "$reason" 2>&1; then
    return 0
  fi
  return 1
}
fetch_ci_failed_log() { # outfile
  local out="$1" run
  run=$(grep -oE 'actions/runs/[0-9]+' "$STATE/merge/$SLUG.ci.txt" 2>/dev/null | head -1 | awk -F/ '{print $3}')
  [ -n "$run" ] || run=$($GH pr checks "$N" --repo "$GH_REPO" --json link 2>/dev/null | grep -oE 'actions/runs/[0-9]+' | head -1 | awk -F/ '{print $3}')
  [ -n "$run" ] || return 1
  $GH run view "$run" --repo "$GH_REPO" --log-failed > "$out" 2>/dev/null || return 1
  [ -s "$out" ]
}
rerun_failed_ci() {
  local run
  run=$(grep -oE 'actions/runs/[0-9]+' "$STATE/merge/$SLUG.ci.txt" 2>/dev/null | head -1 | awk -F/ '{print $3}')
  [ -n "$run" ] || run=$($GH pr checks "$N" --repo "$GH_REPO" --json link 2>/dev/null | grep -oE 'actions/runs/[0-9]+' | head -1 | awk -F/ '{print $3}')
  [ -n "$run" ] || return 1
  $GH run rerun "$run" --failed --repo "$GH_REPO"
}

$GIT -C "$RSI_CTRL" fetch -q origin main "$BR" 2>/dev/null
if [ ! -e "$WT" ]; then
  $GIT -C "$RSI_CTRL" worktree add -q "$WT" -B "$BR" "origin/$BR" 2>/dev/null \
    || $GIT -C "$RSI_CTRL" worktree prune -q 2>/dev/null \
    || true
  if [ ! -e "$WT" ]; then
    EXISTING="$($GIT -C "$RSI_CTRL" worktree list --porcelain | awk -v b="refs/heads/$BR" '
      $1=="worktree"{w=$2} $1=="branch" && $2==b {print w; exit}')"
    if [ -n "$EXISTING" ] && [ "$EXISTING" != "$WT" ]; then
      $GIT -C "$RSI_CTRL" worktree move "$EXISTING" "$WT" 2>/dev/null || true
    fi
  fi
  [ -e "$WT" ] || { say "#$N: cannot make worktree"; exit 0; }
fi
[ -n "$($GIT -C "$WT" status --porcelain --untracked-files=no)" ] && { say "#$N $SLUG: worktree has uncommitted tracked edits, skip"; exit 0; }
$GIT -C "$WT" merge -q --ff-only "origin/$BR" >/dev/null 2>&1 || { say "#$N $SLUG: local branch diverged from origin, skip"; exit 0; }

# 1. sync main — unless CI is still running on a head whose gate and review are already cached.
# Merging origin/main now would move the head, cancel that in-flight CI run and buy a fresh gate
# for nothing (GitHub cancels the superseded run, so the wait never converges). The hold rules
# below still read origin/main...HEAD, the PR's own diff, which skipping the sync does not change.
# A green CI is held the same way when main moved only paths this PR does not verify: the gate and
# review are keyed to the PR's own diff, so the merge would only cancel a green run for nothing.
OLDHEAD="$($GIT -C "$WT" rev-parse HEAD)"
OLDBASE="$($GIT -C "$WT" merge-base HEAD origin/main)"
# Both path lists are needed by the skip decision, and both are stable across a sync: CH is the
# PR's own three-dot diff, QUEUE_INCOMING is main's move since the pre-sync merge base.
CH="$($GIT -C "$WT" -c core.fileMode=false diff --no-renames --raw origin/main...HEAD | awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}')"
QUEUE_INCOMING="$($GIT -C "$WT" diff --name-only "$OLDBASE" origin/main 2>/dev/null)"
ci_first_decision "$WT" "$BR" "$V" "$RV" "$(ci_probe_once)" "$STATE/merge/$SLUG.ci-hold" "$QUEUE_INCOMING" "$CH"
CI_FIRST_RC=$?
# The measurement line: the next retro compares skip vs sync per verifier start.
echo "$(date '+%F %H:%M') #$N $SLUG sync_decision=$CI_FIRST_KIND" >> "$STATE/merge/cycles.log"
if [ $CI_FIRST_RC -eq 0 ]; then
  say "#$N $SLUG: $CI_FIRST_REASON — holding the main sync (cached gate+review); sync deferred"
else
  say "#$N $SLUG: $CI_FIRST_REASON — syncing main"
  sync_main; rc=$?; [ $rc -ne 0 ] && exit 0
fi
bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT" 2>&1 | tail -2
SHA="$($GIT -C "$WT" rev-parse HEAD)"

# 2. hold rules (MANDATE): never auto-merge these
# A main move that is disjoint from the PR's own files and the shared surfaces does not invalidate
# the gate: carry it to the merged head instead of paying for a full fresh gate. carry_forward owns
# the predicate and removes the gate on a re-gate; NEED_GATE below then sees the carried head and
# skips the gate body, while CI still reports on that head before the land loop merges.
if queue_carry_step "$WT" "$OLDHEAD" "$QUEUE_INCOMING" "$SHA" "$CH" "$V" "$RV"; then
  QUEUE_CARRIED=1
  say "#$N $SLUG: gate carried across the main move to ${SHA:0:8} ($QUEUE_CARRY_REASON)"
elif [ "$OLDHEAD" != "$SHA" ]; then
  say "#$N $SLUG: queue-time carry declined: $QUEUE_CARRY_REASON"
fi
SIZE="$($GIT -C "$WT" diff --numstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | awk '{s+=$1+$2} END{print s+0}')"
# CEO 2026-11-16 EMPTY-DELIVERY: a PR whose tree equals main delivers nothing; never merge it.
if [ "$SIZE" = 0 ] && $GIT -C "$WT" diff --quiet origin/main HEAD; then
  say "#$N $SLUG: EMPTY delivery (tree == origin/main), not merging"
  python3 "$LANES_PY" cloud-release "$SLUG" >/dev/null 2>&1 || true
  [ -e "$STATE/merge/$SLUG.empty" ] || printf -- '- %s PR #%s rsi/%s is empty (tree == main); not merged — close it\n' "$(date '+%F %H:%M')" "$N" "$SLUG" >> "$STATE/needs-ceo.md"
  echo "$N" > "$STATE/merge/$SLUG.empty"; exit 0
fi
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
if [ "$SIZE" -gt 1000 ]; then
  if [ -f "$STATE/merge/$SLUG.size-ok" ]; then
    say "#$N $SLUG: CEO size waiver ($SIZE lines; $STATE/merge/$SLUG.size-ok)"
  else
    HOLD="diff is $SIZE changed lines (>1000): split it"
  fi
fi
echo "$CH" | grep -qE '^web/dist/assets/' && HOLD="web/dist/assets in diff"
if [ -n "$HOLD" ]; then
  if [ "${HOLD#diff is}" != "$HOLD" ]; then printf '%s\n' "$HOLD" > "$STATE/merge/$SLUG.err"; sendback "$SLUG" "$ITEM" "$HOLD" "$STATE/merge/$SLUG.err" "hold-size" - -
  else touch "$STATE/merge/$SLUG.blocked"; printf -- '- %s PR #%s rsi/%s held: %s\n' "$(date '+%F %H:%M')" "$N" "$SLUG" "$HOLD" >> "$STATE/needs-ceo.md"; fi
  exit 0
fi

# 3. MANDATE 5 screenshots (cheap, before spending a gate/review): local shots dir, local PR body file, or the PR body itself (cloud PRs)
if echo "$CH" | grep -qE '^ui/src/.*\.tsx$' && ! echo "$CH" | grep -qE '^ui/src/.*\.(test|spec)\.' ; then
  if [ -z "$(ls "$STATE/shots/$SLUG" 2>/dev/null)" ] && ! echo "$BODY" | grep -qiE 'screenshots?:.*(none|not visible|https?://|!\[)' ; then
    echo "UI .tsx changed but no screenshots in $STATE/shots/$SLUG/ and no 'Screenshots:' line with a link/image or 'none: <reason>' in the PR body (MANDATE 5). Capture 390x844 and 1100x760 before/after, or state why nothing is visible." > "$STATE/merge/$SLUG.err"
    sendback "$SLUG" "$ITEM" "missing screenshots" "$STATE/merge/$SLUG.err" "hold-screenshots" - -; exit 0
  fi
fi

# 4. gate and review IN PARALLEL. Review is keyed by the PR's own diff (web/dist/index.html and lockfile excluded), the gate by head SHA.
DH="$(pr_diff_hash "$WT")"
# MANDATE 2: the reviewer must be a different model from the worker. Workers run on $M_WORKER
# (DeepSeek), so use the role that is a different family (reviewer-alt = gpt-6.1-sol). Selecting
# the DeepSeek 'reviewer' here would put the worker's own model on its review.
ROLE=reviewer-alt
[ "$M_WORKER" = "$M_ALT" ] && ROLE=reviewer
NEED_GATE=1; [ "$(cut -d' ' -f1 "$V" 2>/dev/null)" = "$SHA" ] && [ "$(cut -d' ' -f2 "$V" 2>/dev/null)" = PASS ] && NEED_GATE=0
# Tiered review (CEO 2026-11-15, runtime/review-tier.py): small = ONE DeepSeek-max review (escalation signals other than rework>=2 off;
# `VERDICT: UNSURE` -> sol once); medium = DeepSeek with the normal signals; large (risky paths, >500 lines, F/S/N/Q3a, deps, rework>=2) = sol.
# Build, tests, UX gate, CI and the hold rules are the same for every tier.
TIER_LINE="$($GIT -C "$WT" diff --numstat origin/main...HEAD | python3 "$RSI_DIR/runtime/review-tier.py" --title "$TITLE" --item "$ITEM" --attempts "$(attempts "$SLUG")" --numstat - 2>/dev/null)"
TIER="$(echo "$TIER_LINE" | awk '{print $1}')"; ROLE="$(echo "$TIER_LINE" | awk '{print $2}')"; TIER="${TIER:-large}"; ROLE="${ROLE:-reviewer-alt}"
[ -e "$STATE/merge/$SLUG.force-alt" ] && ROLE=reviewer-alt          # DeepSeek returned no verdict twice: use the standing second reviewer
[ "$M_WORKER" = "$M_ALT" ] && ROLE=reviewer                         # MANDATE 2: never review on the worker's own model
echo "$TIER" > "$STATE/merge/$SLUG.tier"; say "#$N $SLUG: review tier=$TIER role=$ROLE ($TIER_LINE)"
REVTIER_ENV=""; [ "$TIER" = small ] && [ "$ROLE" = reviewer ] && REVTIER_ENV=small
# A cached PASS only carries over when the same (different-family) role recorded it.
NEED_REV=1;  [ "$(cut -d' ' -f1 "$RV" 2>/dev/null)" = "$DH" ] && [ "$(cut -d' ' -f2 "$RV" 2>/dev/null)" = PASS ] && [ "$(cut -d' ' -f4 "$RV" 2>/dev/null)" = "$ROLE" ] && NEED_REV=0
GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"; REVPID=""
REV_OK=1; REV_NOTE=""; REV_REUSED=0
# At most one strong-model review per PR per head SHA: reuse the cached verdict/fix-list, never re-run.
if [ $NEED_REV -eq 1 ] && [ -s "$STATE/merge/$SLUG.strong" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong")" = "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong.txt" ]; then
  SVERD="$(awk '{print $2}' "$STATE/merge/$SLUG.strong")"
  say "#$N $SLUG: reuse strong-model review for ${SHA:0:8} (verdict=$SVERD) — head unchanged, not re-run"
  cp "$STATE/merge/$SLUG.strong.txt" "$PREV"
  echo "$DH $SVERD $SHA $ROLE" > "$RV"
  NEED_REV=0; REV_REUSED=1
  if [ "$SVERD" != PASS ]; then REV_OK=0; REV_NOTE="independent review FAIL (reused)"; fi
fi
# Large-tier (or force-alt) needs a strong reviewer and has no reusable verdict: hold only when Hydrogen and sol are both unavailable.
if [ $NEED_REV -eq 1 ] && [ "$ROLE" = reviewer-alt ] && python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1; then
  say "#$N $SLUG: holding review, no strong reviewer available (Hydrogen/sol limited) (no retry)"
  exit 0
fi
if [ $NEED_REV -eq 1 ]; then
  LASTREV="$(cut -d' ' -f3 "$RV" 2>/dev/null)"   # last reviewed SHA (any verdict)
  RB="$STATE/briefs/$SLUG-review.md"
  {
    echo "You are the independent REVIEWER (read-only) for PR #$N, branch $BR, worktree $WT. The worker was a different model."
    echo "Do NOT run npm/npx/vitest/tsc/go test/builds: the gate runs them in parallel on the same machine (they are disabled for you). Read code and diffs only."
    if [ -n "$LASTREV" ] && $GIT -C "$WT" cat-file -e "$LASTREV^{commit}" 2>/dev/null && [ -s "$PREV" ]; then
      echo "This is a RE-REVIEW after rework. Review ONLY the delta since the last reviewed commit: git diff $LASTREV..HEAD (plus how it interacts with the rest). The full PR diff is git diff origin/main...HEAD if you need context."
      echo; echo "Previous review notes (verify each blocker/major is fixed; flag anything new in the delta):"; tail -c 4000 "$PREV" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null
    else
      echo "The PR diff is attached for you (git diff origin/main...HEAD). Do not run shell/git commands if you are on agy — headless mode will deny them and return an empty review. Read the attached diff and call sites."
    fi
    echo "Behaviour claimed (PR body): $(echo "$BODY" | head -c 3500 | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
    SHOT_LIST="$(ls -1 "$STATE/shots/$SLUG" 2>/dev/null | tr '\n' ' ')"
    echo; echo "Checklist and grading: $RSI_DIR/roles/reviewer.md ; binding rules: $RSI_DIR/MANDATE.md ; screenshots (if any): $STATE/shots/$SLUG/ or links in the PR body."
    echo "RSI state directory: $STATE (e.g. $STATE/merged.log, $STATE/ux/). NEVER run find on ~ or /Users."
    [ -n "$SHOT_LIST" ] && echo "Existing files in $STATE/shots/$SLUG/: $SHOT_LIST"
    echo "The gate (tests, lint, build, ratchet) is running separately; its verdict is not your job."
    if [ "$TIER" = small ]; then echo; echo "This is a SMALL-SAFE slice (pure refactor/extract or tiny diff; tests added only). You are the only reviewer, so check hard that behaviour, props, handlers, keyboard, a11y names, i18n and test strength are preserved. If you genuinely cannot decide, say so instead of guessing: end with VERDICT: UNSURE and why."; fi
    echo; echo "Grade every finding blocker/major/nit. Before the verdict, if there is any blocker/major, print a block that starts with a line exactly 'FIXLIST:' and then one line per blocker/major: '- path:line | blocker or major | the issue | the smallest change that fixes it'. The worker applies that list as minimal edits, so be exact (real file and line in the PR head)."
    echo "End with exactly one line: VERDICT: PASS (no blocker/major) or VERDICT: FAIL, followed by the blocker/major list."
  } > "$RB"
  say "#$N $SLUG: review by $ROLE (parallel with gate), $([ -n "${LASTREV:-}" ] && echo delta-since-${LASTREV:0:8} || echo full)"
  cp "$PREV" "$PREV.prev" 2>/dev/null
  ( RSI_ITEM="$ITEM" RSI_REVIEW_TIER="$REVTIER_ENV" RSI_NO_HEAVY=1 BUDGET_GUARD=8 DISPATCH_MAX_SECS=1800 "$RSI_DIR/runtime/dispatch.sh" "$ROLE" "$WT" "$RB" "merge-$SLUG-review" > "$PREV.new" 2>&1 ) &
  REVPID=$!; CHILD=$REVPID
fi
GATE_OK=1; GATE_NOTE=""; GATE_OUTSIDE=0
if [ $NEED_GATE -eq 1 ]; then
  say "#$N $SLUG: gate on ${SHA:0:8} ($SIZE lines)"
  if ! mklock "$STATE/.gate.lock" 1800; then GATE_OK=0; GATE_NOTE="gate lock timeout"; say "#$N: gate lock timeout"
  else
    # Workers often build before their last edit: regenerate web/dist/index.html (the only tracked build output) so a stale bundle
    # never bounces a PR. Pushed so CI sees the same file. The install is repaired first: behind a `-d` test a stale or symlinked
    # tree made this build die silently, leaving the dist stale so gate.sh then failed the PR for a second, unrelated reason.
    BUILT_SHA=""
    if echo "$CH" | grep -q '^ui/'; then
      node_stamp_ensure "$WT/ui" || say "#$N $SLUG: ui install repair failed; dist rebuild may be incomplete"
      if ( cd "$WT/ui" && npm run build >/dev/null 2>&1 ); then
        if [ -n "$($GIT -C "$WT" status --porcelain -- web/dist/index.html)" ]; then
          $GIT -C "$WT" commit -q -m "chore(web): rebuild dist" -- web/dist/index.html && with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null
        fi
        SHA="$($GIT -C "$WT" rev-parse HEAD)"
        [ -z "$($GIT -C "$WT" status --porcelain -- web/dist/index.html)" ] && BUILT_SHA="$SHA"
      else
        SHA="$($GIT -C "$WT" rev-parse HEAD)"
      fi
    fi
    ( cd "$WT" && RSI_DIST_BUILT_SHA="$BUILT_SHA" bash "$RSI_DIR/runtime/gate.sh" "$WT" ) > "$GL" 2>&1; GRC=$?; rm -rf "$STATE/.gate.lock"
    $GIT -C "$WT" checkout -q -- . 2>/dev/null   # drop build leftovers (tracked files only) in our own rsi worktree
    # Mechanical failure (format only): format the changed files, commit, push, re-gate ONCE. Not a sendback, not a rework round.
    if [ $GRC -ne 0 ] && [ "$(grep '^GATE_RESULT' "$GL" | head -1 | sed 's/.*FAIL: *//; s/ *$//')" = prettier ] && [ ! -e "$STATE/merge/$SLUG.autoformatted.$SHA" ]; then
      touch "$STATE/merge/$SLUG.autoformatted.$SHA"; say "#$N $SLUG: gate failed on prettier only -> auto-format, push, re-gate (mechanical)"
      if bash "$RSI_DIR/runtime/format-changed.sh" --write --commit --check "$WT" >> "$GL.fmt" 2>&1 && with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null; then
        SHA="$($GIT -C "$WT" rev-parse HEAD)"; GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"
        if mklock "$STATE/.gate.lock" 1800; then
          ( cd "$WT" && bash "$RSI_DIR/runtime/gate.sh" "$WT" ) > "$GL" 2>&1; GRC=$?; rm -rf "$STATE/.gate.lock"; $GIT -C "$WT" checkout -q -- . 2>/dev/null
        else GRC=1; fi
      fi
    fi
    GATE_OUTSIDE=0
    if [ $GRC -ne 0 ] || ! grep -q '^GATE_RESULT=PASS' "$GL"; then
      if outside_tests_only "$WT" "$GL" && [ ! -e "$STATE/merge/$SLUG.gate-outside-retry.$SHA" ]; then
        touch "$STATE/merge/$SLUG.gate-outside-retry.$SHA"
        say "#$N $SLUG: gate failed only on tests outside the PR footprint (or known-flaky): $(tr -d '\n' < "$STATE/merge/$SLUG.outside-reason.txt"); rerunning gate once"
        GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"
        if mklock "$STATE/.gate.lock" 1800; then
          ( cd "$WT" && bash "$RSI_DIR/runtime/gate.sh" "$WT" ) > "$GL" 2>&1; GRC=$?; rm -rf "$STATE/.gate.lock"; $GIT -C "$WT" checkout -q -- . 2>/dev/null
        else GRC=1; fi
      fi
    fi
    if [ $GRC -ne 0 ] || ! grep -q '^GATE_RESULT=PASS' "$GL"; then
      GATE_OK=0; GATE_NOTE="$(grep '^GATE_RESULT' "$GL" | head -1)"
      outside_tests_only "$WT" "$GL" && GATE_OUTSIDE=1
      say "#$N $SLUG: gate FAIL: $GATE_NOTE$([ $GATE_OUTSIDE -eq 1 ] && echo ' (outside-footprint or known-flaky tests)')"
    fi
  fi
fi
if [ -n "$REVPID" ]; then
  wait "$REVPID"; wait_rc=$?; CHILD=""
  # dispatch exit 3 = held (sol limited / Carbon disabled): not an error, not a sendback, not a no-verdict retry storm.
  cp "$PREV.new" "$PREV" 2>/dev/null; rm -f "$PREV.new"
  REV_HELD=0
  if [ "${wait_rc:-0}" -eq 3 ] || { grep -q '\[hold strong review:' "$PREV" 2>/dev/null && ! grep -qE 'VERDICT: *(PASS|FAIL)' "$PREV"; }; then
    REV_HELD=1
    say "#$N $SLUG: strong review held (model unavailable) — retry when quota returns, not a sendback, not an error"
    if [ -s "$PREV.prev" ]; then mv "$PREV.prev" "$PREV"; else rm -f "$PREV"; fi
    [ $GATE_OK -eq 0 ] || exit 0
    VERD=""
  else
  VERD="$(grep -oE 'VERDICT: *(PASS|FAIL|UNSURE)' "$PREV" 2>/dev/null | tail -1 | grep -oE 'PASS|FAIL|UNSURE')"
  if [ "$ROLE" = reviewer ] && [ -n "$VERD" ]; then
    python3 "$RSI_DIR/runtime/escalate.py" --save-deepseek --slug "$SLUG" --sha "$SHA" --verdict "$VERD" --file "$PREV" >/dev/null 2>&1 || true
  fi
  if [ "$VERD" = UNSURE ] && [ "$ROLE" = reviewer ]; then
    if python3 "$RSI_DIR/runtime/escalate.py" --sol-limited >/dev/null 2>&1; then
      # Small tier: proceed DeepSeek-only (do not call sol). Large/medium that need sol: hold.
      if [ "$TIER" = small ]; then
        say "#$N $SLUG: DeepSeek UNSURE, sol limited; small tier stays DeepSeek-only (retry next cycle, not a sendback)"
        if [ -s "$PREV.prev" ]; then mv "$PREV.prev" "$PREV"; else rm -f "$PREV"; fi
        [ $GATE_OK -eq 0 ] || exit 0
        VERD=""
      else
        say "#$N $SLUG: DeepSeek UNSURE, holding for gpt-6.1-sol quota — not a sendback"
        [ $GATE_OK -eq 0 ] || exit 0
        VERD=""
      fi
    else
      # DeepSeek said it cannot decide: ask the standing second reviewer (sol) once, on the same brief.
      say "#$N $SLUG: DeepSeek review UNSURE -> second reviewer (reviewer-alt) once"; cp "$PREV" "$PREV.unsure"
      ROLE=reviewer-alt; REVTIER_ENV=""
      ( RSI_ITEM="$ITEM" RSI_NO_HEAVY=1 BUDGET_GUARD=8 DISPATCH_MAX_SECS=1800 "$RSI_DIR/runtime/dispatch.sh" reviewer-alt "$WT" "$RB" "merge-$SLUG-review" > "$PREV" 2>&1 )
      d_rc=$?
      if [ $d_rc -eq 3 ] || (grep -q '\[hold strong review:' "$PREV" 2>/dev/null && ! grep -qE 'VERDICT: *(PASS|FAIL)' "$PREV"); then
        say "#$N $SLUG: sol hold after UNSURE — retry when quota returns"
        [ $GATE_OK -eq 0 ] || exit 0
        VERD=""
      else
        VERD="$(grep -oE 'VERDICT: *(PASS|FAIL)' "$PREV" | tail -1 | grep -oE 'PASS|FAIL')"
      fi
    fi
  fi
  fi   # not REV_HELD
  if [ "${REV_HELD:-0}" -eq 1 ]; then
    : # gate failed (otherwise we already exited); skip no-verdict accounting and do not force-alt
  elif [ -z "$VERD" ]; then
    # two no-verdicts in a row from the cheap reviewer: switch this PR to the standing second reviewer
    # (not on a hold: that would start a retry storm as soon as quota returns, or immediately if sol is still limited)
    nv=$(( $(cat "$STATE/merge/$SLUG.noverdict" 2>/dev/null || echo 0) + 1 )); echo $nv > "$STATE/merge/$SLUG.noverdict"
    if [ $nv -ge 2 ] && [ "$ROLE" = reviewer ] && ! python3 "$RSI_DIR/runtime/escalate.py" --sol-limited >/dev/null 2>&1; then
      touch "$STATE/merge/$SLUG.force-alt"
    fi
    # Reviewer infra (empty log / no VERDICT): retry next cycle. Do not send back or cache this SHA as reviewed
    # (a cached NONE would make the next pass a delta-since-HEAD empty review).
    say "#$N $SLUG: review NO VERDICT (reviewer infra) — retry next cycle, not a sendback"
    if [ -s "$PREV.prev" ]; then mv "$PREV.prev" "$PREV"; else rm -f "$PREV"; fi
    [ $GATE_OK -eq 0 ] || exit 0
  else
    rm -f "$STATE/merge/$SLUG.noverdict"
    DH="$($GIT -C "$WT" diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16)"   # a mechanical format commit may have landed meanwhile
    echo "$DH $VERD $SHA $ROLE" > "$RV"
    if [ "$ROLE" = reviewer-alt ] || grep -qE 'codex/gpt-6.1-sol|agy/gemini|kimi-k3' "$STATE/merge/$SLUG.review-model" 2>/dev/null; then
      python3 "$RSI_DIR/runtime/escalate.py" --save-strong --slug "$SLUG" --sha "$SHA" --verdict "$VERD" --model "$(tr -d '\n' < "$STATE/merge/$SLUG.review-model" 2>/dev/null)" --file "$PREV" --role "$ROLE" >/dev/null 2>&1 || true
    fi
    if [ "$VERD" != PASS ]; then REV_OK=0; REV_NOTE="independent review FAIL"; say "#$N $SLUG: review FAIL"; fi
  fi
fi
# A non-mechanical gate failure is diagnosed by DeepSeek-max first (the parallel review, if it was DeepSeek).
# Escalate later only when that diagnosis explicitly cannot find the cause.
if [ $GATE_OK -eq 0 ] && [ "${REV_REUSED:-0}" -eq 0 ]; then
  case "$GATE_NOTE" in
    *prettier*|*dirty-tree*|*dirty-after-build*|*format*|*inventory*|*conflict*) ;;
    *)
      if [ "${ROLE:-}" = reviewer ] && [ -s "$PREV" ] && { grep -qE 'VERDICT: *UNSURE' "$PREV" || grep -qiE "could not diagnose|cannot diagnose|unable to (find|determine|identify) the (root )?cause|DEEPSEEK_DIAGNOSIS: *(UNKNOWN|UNDIAGNOSED|FAILED|CANNOT)" "$PREV"; }; then
        echo "$SHA ${VERD:-UNSURE} cannot-diagnose" > "$STATE/merge/$SLUG.deepseek-undiagnosed"
        say "#$N $SLUG: DeepSeek could not diagnose $GATE_NOTE after a real attempt"
      fi
      ;;
  esac
fi
RMODEL="$(tr -d "\n" < "$STATE/merge/$SLUG.review-model" 2>/dev/null || true)"; RMODEL="${RMODEL:-$([ $ROLE = reviewer ] && echo "$M_DIRECTOR" || echo "$M_CODEX")}"
if [ $GATE_OK -eq 0 ] || [ $REV_OK -eq 0 ]; then
  if [ $GATE_OK -eq 0 ] && [ $REV_OK -eq 1 ] && [ "${GATE_OUTSIDE:-0}" -eq 1 ]; then
    say "#$N $SLUG: gate still failing only on tests outside the PR footprint (or known-flaky) after one rerun — mechanical, not a quality sendback, not kicking a rework lane"
    exit 0
  fi
  C="$STATE/merge/$SLUG.combined.txt"; : > "$C"; TITLEBAD=""
  [ $GATE_OK -eq 0 ] && { echo "=== GATE FAILED: $GATE_NOTE ===" >> "$C"; tail -c 3500 "$GL" 2>/dev/null | iconv -f UTF-8 -t UTF-8 -c >> "$C"; echo >> "$C"; TITLEBAD="gate failed: $GATE_NOTE"; }
  [ $REV_OK -eq 0 ] && { echo "=== INDEPENDENT REVIEW: $REV_NOTE ===" >> "$C"; tail -c 3500 "$PREV" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null >> "$C"; echo >> "$C"; TITLEBAD="${TITLEBAD:+$TITLEBAD; }$REV_NOTE"; }
  # Targeted rework: a line-level fix list from the reviewer's FIXLIST block (or the file:line findings of its prose) and the exact failing gate lines.
  SB_FIXLIST="$STATE/merge/$SLUG.fixlist.md"; SB_GATEFAILS="$STATE/merge/$SLUG.gatefails.txt"; rm -f "$SB_FIXLIST" "$SB_GATEFAILS"
  [ $REV_OK -eq 0 ] && python3 "$RSI_DIR/runtime/fixlist.py" "$PREV" > "$SB_FIXLIST" 2>/dev/null
  [ $GATE_OK -eq 0 ] && grep -E 'error TS[0-9]+|^ *(FAIL|✗|×) |AssertionError|^FAIL:|Error:|not ok|--- FAIL' "$GL" 2>/dev/null | head -30 > "$SB_GATEFAILS"
  export SB_FIXLIST SB_GATEFAILS
  sendback "$SLUG" "$ITEM" "$TITLEBAD" "$C" "gate+review" - "bash $RSI_DIR/runtime/gate.sh $WT"
  [ -z "${SB_SUPPRESSED:-}" ] && scorecard_row "$ITEM $SLUG" "$M_WORKER" "$RMODEL" "$TITLEBAD" "[#$N]($PRURL)" "patched" "see ${GL##*/}"
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
    # Reuse a strong UX review for this same head SHA (do not re-call Hydrogen/sol).
    if [ -s "$STATE/merge/$SLUG.strong-ux" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong-ux")" = "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux.txt" ]; then
      say "#$N $SLUG: reuse strong UX review for ${SHA:0:8} (verdict=$(awk '{print $2}' "$STATE/merge/$SLUG.strong-ux")) — head unchanged"
      mkdir -p "$STATE/ux/$SLUG"
      cp "$STATE/merge/$SLUG.strong-ux.txt" "$STATE/ux/$SLUG/review.txt"
      cp "$STATE/merge/$SLUG.strong-ux.txt" "$STATE/merge/$SLUG.ux.txt"
      urc=1; [ "$(awk '{print $2}' "$STATE/merge/$SLUG.strong-ux")" = PASS ] && urc=0
    elif python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1; then
      say "#$N $SLUG: holding UX vision review, no strong reviewer available (Hydrogen/sol) — not an error, not a sendback"
      urc=2
      mkdir -p "$STATE/ux/$SLUG"
      echo "ux reviewer held: no strong reviewer available" > "$STATE/ux/$SLUG/unavailable.txt"
    else
    say "#$N $SLUG: UX gate (journey walk + vision review)"
    # Outer backstop, not the walk bound: ux-gate re-walks a red once (confirm),
    # and that second walk has the same RSI_WALK_MAX_S ceiling, so the default
    # leaves room for both (2 x 1800s) plus the vision dispatch.
    GATE_MAX="${RSI_UX_GATE_MAX_S:-5400}"; case "$GATE_MAX" in ''|*[!0-9]*) GATE_MAX=5400;; esac
    # This attempt's evidence only: ux-gate clears confirm.json below its first walk, so an
    # earlier attempt on the same slug would otherwise leave it readable to the 124 branch if
    # this attempt expires during build/seed/walk, and the sendback would carry a past tree's red.
    rm -f "$STATE/ux/$SLUG/confirm.json" "$STATE/ux/$SLUG/confirm.hard"
    bounded_run "$GATE_MAX" bash "$RSI_DIR/runtime/ux-gate.sh" "$WT" "$SLUG" "$ITEM" "$N" "$DH" "$ROLE"; urc=$?
    if [ "$urc" -eq 124 ]; then
      # The first walk's evidence is $SHOTS/walk.json (ux-gate.sh), not $STATE/ux.
      # A confirm that finished has already applied ux-gate's own policy: lines it
      # could not reproduce are cleared from confirm.hard, so an empty file means
      # the red flaked (no verdict), not "no evidence". A confirm that could not
      # run leaves confirm.json absent and keeps the first walk's lines (fail closed).
      if [ -e "$STATE/ux/$SLUG/confirm.json" ]; then
        RED="$(cat "$STATE/ux/$SLUG/confirm.hard" 2>/dev/null || true)"
      else
        RED="$(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).get("hardFail",[])))' "$STATE/shots/$SLUG/journeys/walk.json" 2>/dev/null || true)"
      fi
      # Same relaxation ux-gate applies: known environment artefacts never convict a PR.
      KNOWN="$STATE/ux-known-artifacts.txt"
      if [ -n "$RED" ] && [ -s "$KNOWN" ]; then
        RED="$(printf '%s\n' "$RED" | grep -v -F -f "$KNOWN" || true)"
      fi
      if [ -n "$RED" ]; then
        # ux-gate's own policy: a confirm that cannot run keeps the first walk's
        # red (fail closed). Expiring inside the gate must not turn a red into
        # "unavailable", which would leave the PR verified but never landed.
        say "#$N $SLUG: UX gate exceeded ${GATE_MAX}s; keeping the walk red (fail closed)"
        mkdir -p "$STATE/ux/$SLUG"
        { echo "ux gate exceeded ${GATE_MAX}s before a verdict (walk red preserved)."
          echo "First-walk failures kept (fail closed):"
          printf '%s\n' "$RED"; } > "$STATE/ux/$SLUG/ux.txt" 2>/dev/null || true
        cp "$STATE/ux/$SLUG/ux.txt" "$STATE/merge/$SLUG.ux.txt" 2>/dev/null || true
        urc=1
      else
        # No first-walk evidence: a hang here is infra, not the PR — unavailable
        # plus cooldown, never a sendback, never a merge.
        say "#$N $SLUG: UX gate exceeded ${GATE_MAX}s -> unavailable (not merging)"
        mkdir -p "$STATE/ux/$SLUG"
        echo "ux gate exceeded ${GATE_MAX}s (merge.sh bound; no verdict)" > "$STATE/ux/$SLUG/unavailable.txt"
        COOL_MIN="${RSI_UX_COOLDOWN_MIN:-30}"; case "$COOL_MIN" in ''|*[!0-9]*) COOL_MIN=30;; esac
        [ "$COOL_MIN" -gt 0 ] && printf '%s %s %s\n' "$(( $(date +%s) + COOL_MIN * 60 ))" "$DH" "ux gate exceeded ${GATE_MAX}s" > "$STATE/merge/$SLUG.uxcooldown"
        urc=2
      fi
    fi
    fi
    SC="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join("%s=%s"%kv for kv in d["scores"].items()), "mean=%s"%d["mean"])' "$STATE/ux/$SLUG/scores.json" 2>/dev/null)"
    if [ $urc -eq 0 ]; then
      echo "$DH PASS $MAINUI" > "$UXV"
      $GH pr comment "$N" --repo "$GH_REPO" --body "RSI UX gate: PASS on ${SHA:0:8} ($SC). Journey screenshots are kept on the CEO machine (rsi/state/shots/$SLUG/journeys/). Rubric: rsi/UX-RUBRIC.md." >/dev/null 2>&1
    elif [ $urc -eq 1 ]; then
      say "#$N $SLUG: UX gate FAIL ($SC)"; sendback "$SLUG" "$ITEM" "UX gate failed ($SC)" "$STATE/merge/$SLUG.ux.txt" "ux-gate" "$(spec_rev "$WT")" "bash $RSI_DIR/runtime/ux-gate.sh $WT $SLUG $ITEM $N $DH $ROLE"
      [ -z "${SB_SUPPRESSED:-}" ] && scorecard_row "$ITEM $SLUG" "$M_WORKER" "$RMODEL (ux)" "UX FAIL $SC" "[#$N]($PRURL)" "patched" "see state/ux/$SLUG"; exit 0
    else
      [ -e "$STATE/merge/$SLUG.uxunavail.$DH" ] || { touch "$STATE/merge/$SLUG.uxunavail.$DH"
      printf -- '- %s PR #%s rsi/%s: UX gate could not run (%s); verified, NOT merged. Fix the walker/daemon or set RSI_UX_GATE=off and record it in DECISIONS.\n' "$(date '+%F %H:%M')" "$N" "$SLUG" "$(cat "$STATE/ux/$SLUG/unavailable.txt" 2>/dev/null | head -c 160)" >> "$STATE/needs-ceo.md"; }
      say "#$N $SLUG: UX gate unavailable -> not merging"; exit 0
    fi
  fi
fi

# 5. NO_MERGE honours
if [ -e "$STATE/NO_MERGE" ]; then say "#$N $SLUG: verified, NO_MERGE set -> not merging"; exit 0; fi

# A queue-time carry moved the gate to the merged head this process pushed in step 1; CI cannot
# have reported on that head yet and ci_state reads an empty check list as green, so continuing
# into the land loop could squash-merge it before CI ever ran. Exit for the same reason the
# land-time carry does: the carried gate and DH-keyed review cache make the next dispatch cycle
# (launchd, 600s) cheap, and it lands only after CI reported.
if [ "${QUEUE_CARRIED:-0}" = 1 ]; then
  say "#$N $SLUG: gate carried to ${SHA:0:8}; landing deferred one cycle so CI reports on the merged head first"
  exit 0
fi

# 6. CI, then land under the land lock (serialised); if main moved while we verified: sync, carry the gate forward only when
#    the incoming main changes touch no code paths, otherwise hand back for a fresh gate (review stays valid: same PR diff).
for round in 1 2 3; do
  CIS="$(ci_state)"
  [ "$CIS" = pending ] && { say "#$N $SLUG: CI still pending, retry next cycle"; exit 0; }
  [ "$CIS" = fail ] && {
    CLOG="$STATE/merge/$SLUG.ci-log.txt"
    if fetch_ci_failed_log "$CLOG" && outside_tests_only "$WT" "$CLOG" "$STATE/merge/$SLUG.ci.txt"; then
      if [ ! -e "$STATE/merge/$SLUG.ci-outside-retry.$SHA" ]; then
        touch "$STATE/merge/$SLUG.ci-outside-retry.$SHA"
        if rerun_failed_ci; then
          say "#$N $SLUG: CI failed only on tests outside the PR footprint (or known-flaky): $(tr -d '\n' < "$STATE/merge/$SLUG.outside-reason.txt"); reran the failed jobs once — not a quality sendback"
        else
          say "#$N $SLUG: CI failed only on tests outside the PR footprint (or known-flaky) but could not rerun the jobs; retry next cycle — not a quality sendback"
        fi
        exit 0
      fi
      say "#$N $SLUG: CI still failing only on tests outside the PR footprint (or known-flaky) after one rerun — mechanical, not a quality sendback, not kicking a rework lane"
      exit 0
    fi
    sendback "$SLUG" "$ITEM" "CI failed" "$STATE/merge/$SLUG.ci.txt" "ci" - "gh pr checks $N --repo $GH_REPO"; exit 0
  }
  mklock "$STATE/.land.lock" 900 || { say "#$N: land lock timeout"; exit 0; }
  $GIT -C "$WT" fetch -q origin main 2>/dev/null
  if $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD; then
    MERGED_OK=0
    if $GH pr merge "$N" --repo "$GH_REPO" --squash >/dev/null 2>"$STATE/merge/$SLUG.merge.err"; then
      MERGED_OK=1
    elif [ "$($GH pr view "$N" --repo "$GH_REPO" --json state --jq .state 2>/dev/null)" = MERGED ]; then
      say "#$N $SLUG: gh pr merge exited non-zero after GitHub completed merge — recording merge"
      MERGED_OK=1
    fi
    if [ $MERGED_OK -eq 1 ]; then
      MSHA="$($GH pr view "$N" --repo "$GH_REPO" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null | cut -c1-8)"
      say "#$N $SLUG: MERGED ($MSHA)"
      echo "$(date '+%F %H:%M') PR #$N $SLUG $ITEM merged ${MSHA:-?} $PRURL" >> "$STATE/merged.log"
      archive_sendback "$SLUG" merged "${MSHA:-unknown}"
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
  # A step-1 hold means main is not an ancestor, so a held start usually reaches this merge in the
  # same run. Record it next to the step-1 line: sync_decision=hold-* alone cannot tell a real skip
  # (no land-sync line) from a merge the hold only deferred to here.
  echo "$(date '+%F %H:%M') #$N $SLUG sync_decision=land-sync after=$CI_FIRST_KIND" >> "$STATE/merge/cycles.log"
  sync_main; rc=$?; if [ $rc -ne 0 ]; then rm -rf "$STATE/.land.lock"; exit 0; fi
  INCOMING="$($GIT -C "$WT" diff --name-only "$OLDBASE" origin/main 2>/dev/null)"
  NEWSHA="$($GIT -C "$WT" rev-parse HEAD)"
  rm -rf "$STATE/.land.lock"
  if carry_forward "$WT" "$INCOMING" "$CH" "$V" "$NEWSHA" "$ROLE"; then
    # Exit instead of continuing into ci_state: seconds after sync_main pushed the carried head there
    # are no checks yet, and ci_state reads an empty check list as green, so the same process could
    # squash-merge the carried head before CI ever ran. The carried gate file and the DH-keyed review
    # cache make the next dispatch cycle (launchd, 600s) cheap, and it lands only after CI reported.
    say "#$N $SLUG: gate carried forward to ${NEWSHA:0:8} ($CARRY_REASON); landing deferred one cycle so CI reports on the merged head first"
    SHA="$NEWSHA"; exit 0
  fi
  say "#$N $SLUG: main moved with code changes ($(echo "$INCOMING" | grep -c .) files); needs a fresh gate: $CARRY_REASON"
  nohup /bin/bash "$SELF" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null || true
  exit 0
done

exit 0
