#!/bin/bash
# merge.sh [--dry-run]            dispatcher: starts up to RSI_MERGE_WORKERS (2) per-PR verifiers; returns quickly.
# merge.sh --one <N> <slug> <title>   verifier for one open rsi/* PR (also PRs opened by cloud agents).
# merge.sh --batch <id> <members-file>  the live batch half (RSI_BATCH_VERIFY=1): ONE union gate for the
#                                 formed members, batch markers, then the ordinary --one per member in
#                                 PR-number order with a prefix-tree proof after each landing.
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
SLOT_YIELD_MIN="${RSI_SLOT_YIELD_MIN:-10}"; case "$SLOT_YIELD_MIN" in ''|*[!0-9]*) SLOT_YIELD_MIN=10 ;; esac
                                                 # a small PR yields the last general slot to a big/medium PR queued this long (0 disables)
REWORK_STALL_MIN="${RSI_REWORK_STALL_MIN:-20}"   # a sendback no lane picks up for this long is escalated, not waited on
unset SB_FIXLIST SB_GATEFAILS
say() { echo "[$(date +%T)] $*"; }
attempts() { cat "$STATE/merge/$1.attempts" 2>/dev/null || echo 0; }
# A sendback that no lane picks up must not be waited on forever. 2026-11-21: #506's rework lane
# died with `push failed` at 07:59 and the sendback stayed put, so a PR whose gate, review and CI
# were all green sat OPEN for ~50 minutes (open_to_merge=59m) until a person reconciled it by hand.
# The branch below runs AFTER the active-lane check, so "no lane holds this slug" is already proven;
# the only missing bound is AGE. After REWORK_STALL_MIN minutes: say the age, write one
# `rework_stalled` line to cycles.log, and leave one needs-ceo line per (slug, sendback file) — a
# fresh sendback on the same slug escalates again, the same one never repeats. A sendback whose
# age cannot be read keeps the old wording and never escalates (fail closed: a phantom stall
# message is worse than a quiet wait).
rework_wait() { # <pr-number> <slug> <state-dir>: prints, and bounds the wait; never a verdict
  local n="$1" slug="$2" state="$3" sb info mtime age marker
  sb="$state/sendback/$slug.md"
  info="$(python3 -c 'import os,sys,time
st=os.stat(sys.argv[1]); print(int(st.st_mtime), int((time.time()-st.st_mtime)//60))' "$sb" 2>/dev/null)"
  # An unreadable or malformed age keeps the old wording: a phantom stall line is worse than a wait.
  [ -n "$info" ] && [ "${info#* }" != "$info" ] || { say "#$n $slug: waiting for rework"; return 0; }
  mtime="${info%% *}"; age="${info##* }"
  case "$mtime$age" in ''|*[!0-9]*) say "#$n $slug: waiting for rework"; return 0 ;; esac
  say "#$n $slug: waiting for rework (${age}m, no lane)"
  [ "$age" -ge "$REWORK_STALL_MIN" ] || return 0
  marker="$state/merge/$slug.rework-stalled"
  [ "$(cat "$marker" 2>/dev/null)" = "$mtime" ] && return 0
  echo "$mtime" > "$marker"
  printf '%s #%s %s rework_stalled age=%sm sendback=%s\n' "$(date '+%F %H:%M')" "$n" "$slug" "$age" "$sb" >> "$state/merge/cycles.log"
  printf -- '- %s [merge lane · auto] PR #%s rsi/%s: the rework note %s has had no lane for %s minutes; the PR stays OPEN and nothing in the loop will pick it up. Dispatch a rework lane for it, or move the note into sendback/done with a reason. reverse: delete this line and %s.\n' \
    "$(date '+%F %H:%M')" "$n" "$slug" "$sb" "$age" "$marker" >> "$state/needs-ceo.md"
  return 0
}
# The machine-wide gate lock: claim by mkdir, reclaim a lock whose pid is dead, otherwise poll
# until max seconds have passed. RSI_GATE_LOCK_POLL shortens only the poll cadence, for the
# hermetic seam (tests/test-gate-lock-timeout.sh); production keeps 15 s and the same max in
# seconds, so the stale-pid reclaim and the wait length behave exactly as before.
mklock() { local d="$1" max="$2" w=0; while ! mkdir "$d" 2>/dev/null; do o="$(cat "$d/pid" 2>/dev/null)"; if [ -n "$o" ] && ! kill -0 "$o" 2>/dev/null; then rm -rf "$d"; continue; fi; sleep "${RSI_GATE_LOCK_POLL:-15}"; w=$((w+15)); [ $w -gt "$max" ] && return 1; done; echo $$ > "$d/pid"; }
# A gate-lock wait is loop contention between verifiers, not a verdict on the branch. #387
# (2026-11-19) waited the full 1800 s and was then sent back as "gate failed: gate lock
# timeout": a rework lane, one of three attempts, and a worker editing code nobody had proved
# wrong. A timeout now skips the cycle (SKIP/0, no sendback, no attempt); the same head timing
# out twice leaves exactly one needs-ceo line, and the per-(slug, head) marker keeps a skip
# storm from writing one every ten minutes.
gate_lock_decision() { # <acquired|timeout> <slug> <sha> <state-dir> -> 0 SKIP / 1 GATE; sets GATE_LOCK_REASON
  local outcome="$1" slug="$2" sha="$3" state="$4" marker n
  if [ "$outcome" != timeout ]; then
    GATE_LOCK_REASON="gate lock acquired on ${sha:0:8}"; return 1
  fi
  marker="$state/merge/$slug.gatelock-timeout.$sha"
  n="$(cat "$marker" 2>/dev/null)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac   # malformed marker: no reminder, never a failed skip
  if [ "$n" -lt 2 ]; then
    echo "$((n + 1))" > "$marker"
    if [ "$n" -eq 1 ]; then
      printf -- '- %s PR rsi/%s: gate lock timed out twice on %s; both cycles skipped, no sendback (loop contention, not the branch)\n' \
        "$(date '+%F %H:%M')" "$slug" "${sha:0:8}" >> "$state/needs-ceo.md"
    fi
  fi
  GATE_LOCK_REASON="gate lock timeout on ${sha:0:8}: another verifier holds it; cycle skipped, no sendback"
  return 0
}
# A gate that starts on a head which then MOVES is a verdict nobody can use: the eight minutes of
# check.sh + review are already spent on a dead SHA, and the verdict either gets dropped silently or
# (worse) turns into a sendback for a branch that already contains the fix. The review-side half of
# this rule is in sendback(); this is the gate-side half (R-merge-gate-head: 2026-11-27 #812 was
# gated on a257d605 while the live head was 67460726, eight minutes of gate and review on a SHA whose
# verdict could not be used). Re-read the head while the gate runs and unwind as a SKIP, the same
# contract gate_lock_decision uses for loop contention: no sendback, no attempt, no PASS line.
# Fail closed on READING: a blank head, a non-oid (a gh warning line) or a failing gh keeps today's
# behaviour, because killing a gate on a bad read is worse than finishing on a head that the
# post-review suppression still catches.
GATE_HEAD_POLL_SECS="${RSI_HEAD_POLL_SECS:-20}"
case "$GATE_HEAD_POLL_SECS" in ''|*[!0-9]*|0) GATE_HEAD_POLL_SECS=20 ;; esac
# The watcher never extends a gate: after this many seconds it stops polling the head and falls back
# to the plain wait, so the gate's own duration (its verifier slot) is exactly today's.
GATE_WATCH_MAX_SECS="${RSI_GATE_WATCH_MAX_SECS:-3600}"
case "$GATE_WATCH_MAX_SECS" in ''|*[!0-9]*|0) GATE_WATCH_MAX_SECS=3600 ;; esac
head_moved_live() { # <pr> <sha> -> prints the live head; 0 only when it is an oid and differs from sha
  local n="$1" sha="$2" live f rc
  [ -n "$n" ] && [ -n "$sha" ] || return 1
  # Bounded, and read through a scratch file rather than a command substitution: a stalled gh must
  # not hold the watcher (and the .gate.lock behind it) forever, and with_timeout's kill cannot
  # unblock $( ) while a surviving child still holds the pipe open (reproduced with a sleeping
  # reader: the watcher stayed blocked past 60 s). Either failure reads as unreadable, which fails
  # open exactly like a failing gh.
  f="$(mktemp "${TMPDIR:-/tmp}/rsi-head.XXXXXX")" || return 1
  with_timeout 15 pr_head "$n" > "$f" 2>/dev/null; rc=$?
  live="$(cat "$f" 2>/dev/null)"; rm -f "$f"
  [ "$rc" -eq 0 ] || return 1
  oid "$live" || return 1
  [ "$live" != "$sha" ] || return 1
  printf '%s\n' "$live"
}
head_moved_skip() { # <pr> <slug> <stale> <live> <state>: one cycles line, at most one operator line per stale head
  local n="$1" slug="$2" stale="$3" live="$4" state="$5" marker
  printf '%s #%s %s head_moved_skip stale=%s live=%s\n' \
    "$(date '+%F %H:%M')" "$n" "$slug" "${stale:0:8}" "${live:0:8}" >> "$state/merge/cycles.log"
  marker="$state/merge/$slug.head-moved.$stale"   # per stale head: a repeat cycle must not spam needs-ceo
  [ -e "$marker" ] && return 0
  : > "$marker"
  printf -- '- %s PR #%s rsi/%s: head moved %s -> %s during the gate; cycle skipped, no verdict, no sendback (re-gate on the new head)\n' \
    "$(date '+%F %H:%M')" "$n" "$slug" "${stale:0:8}" "${live:0:8}" >> "$state/needs-ceo.md"
  return 0
}
# The unwind every gate invocation shares: a killed reviewer's half-written output is discarded,
# never promoted to $PREV; the machine-wide lock is released on every path (a leaked lock costs the
# next PR up to 30 minutes); the skip is recorded once. The caller exits the cycle immediately after.
gate_head_unwind() { # <pr> <slug> <state> <live-head>
  local n="$1" slug="$2" state="$3" live="$4" prev
  prev="$state/merge/$slug.review.txt"   # separate: bash 3.2's `local` cannot expand a same-line sibling
  if [ -n "${REVPID:-}" ]; then rsi_kill_tree "$REVPID"; wait "$REVPID" 2>/dev/null || true; REVPID=""; CHILD=""; fi
  rm -rf "$state/.gate.lock"
  rm -f "$prev.new"
  head_moved_skip "$n" "$slug" "${SHA:-}" "$live" "$state"
  say "#$n $slug: head moved ${SHA:0:8} -> ${live:0:8} during the gate; cycle skipped, no verdict, no sendback"
  return 0
}
# Run the gate while a watcher re-reads the live PR head. 0 = the gate finished (GATE_RC holds its
# exit code); 2 = the head moved (GATE_LIVE_HEAD holds the new oid, the gate's whole process tree was
# killed). The watcher writes the live head BEFORE it kills, so a parent that returns from wait()
# knows the death was a head move and not a gate that finished.
gate_watched() { # <pr> <sha> <state> <slug> <gate-log> <worktree> <cmd...>
  local n="$1" sha="$2" state="$3" slug="$4" gl="$5" wt="$6" marker
  shift 6
  marker="$state/merge/$slug.gate-live-head"; rm -f "$marker"
  GATE_LIVE_HEAD=""
  # The TERM trap keeps a killed gate's exit normal, so bash prints no "Terminated" job line
  # into the verifier log; rsi_kill_tree has already killed the gate's own children.
  ( trap 'exit 143' TERM; if [ -n "$wt" ]; then cd "$wt" || exit 1; fi; "$@" ) > "$gl" 2>&1 &
  local gp=$! wp=""
  # A signal while we wait must not leave the gate or the watcher behind: the caller's cleanup
  # only knows $CHILD (the reviewer), and a synchronous gate used to keep the verifier waiting.
  # Kill both, then restore the script's own exit convention for the rest of the verifier.
  trap 'rsi_kill_tree "$gp" 2>/dev/null; kill "${wp:-}" 2>/dev/null; exit 143' TERM
  trap 'rsi_kill_tree "$gp" 2>/dev/null; kill "${wp:-}" 2>/dev/null; exit 129' HUP
  trap 'rsi_kill_tree "$gp" 2>/dev/null; kill "${wp:-}" 2>/dev/null; exit 130' INT
  (
    sp=""; w=0; live=""
    # A cancelled watcher must not leave its sleep behind for a whole poll interval.
    trap '[ -n "${sp:-}" ] && kill "$sp" 2>/dev/null; exit 0' TERM INT
    while kill -0 "$gp" 2>/dev/null; do
      sleep "$GATE_HEAD_POLL_SECS" & sp=$!; wait "$sp" || exit 0; sp=""
      kill -0 "$gp" 2>/dev/null || exit 0
      w=$((w + GATE_HEAD_POLL_SECS)); [ "$w" -le "$GATE_WATCH_MAX_SECS" ] || exit 0
      live="$(head_moved_live "$n" "$sha")" || continue
      printf '%s\n' "$live" > "$marker" 2>/dev/null || true
      rsi_kill_tree "$gp"
      exit 0
    done
  ) &
  wp=$!
  wait "$gp"; GATE_RC=$?; gp=""   # reaped: a late signal must not chase a reused pid
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  trap 'exit 130' INT
  if [ -s "$marker" ]; then
    # The watcher is mid-kill (it wrote the marker first): give it its bounded finish, then reap it.
    local i=0
    while [ "$i" -lt 30 ] && kill -0 "$wp" 2>/dev/null; do sleep 0.1; i=$((i+1)); done
  fi
  kill "$wp" 2>/dev/null; wait "$wp" 2>/dev/null; wp=""
  local live; live="$(cat "$marker" 2>/dev/null || true)"; rm -f "$marker"
  if oid "$live" && [ "$live" != "$sha" ]; then GATE_LIVE_HEAD="$live"; return 2; fi
  return 0
}
item_id() { # slug body -> the marker's id, else R-<slug>: the one reader and the one fallback rule
  local id
  id="$(printf '%s\n' "$2" | python3 "$RSI_DIR/runtime/item_marker.py")"
  printf '%s\n' "${id:-R-$1}"
}
sendback() { # slug item title detail-file [source] [spec] [cmd]
  local slug="$1" item="$2" title="$3" det="$4" a live src="${5:-unknown}" spec="${6:--}" cmd="${7:--}"
  # A sendback must not outlive its PR: never queue a rework round for a PR that is already
  # MERGED or CLOSED. The write site inside the cycle is the only place the state was not read;
  # lane.sh autofill already archives on sight, but only after the merge lane spent the round.
  # An unreadable state keeps today's behaviour (a rare phantom costs less than a stalled rework).
  pr_finished "$slug" "${N:-}" "${SHA:-}" "$det" && return
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
  local slug="$1" item="$2" title="$3" det="$4" src="${5:-mech}" spec="${6:--}" cmd="${7:--}" m
  # Same guard as sendback(): the mechanical path forwards into a real sendback later, and a
  # closed PR must not even get a mechanical round.
  pr_finished "$slug" "${N:-}" "${SHA:-}" "$det" && return
  m=$(( $(cat "$STATE/merge/$slug.mech" 2>/dev/null || echo 0) + 1 )); echo $m > "$STATE/merge/$slug.mech"
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
# A merge is irreversible; its delivery record must not be lost with it. Two durable records guard
# it. (1) A pre-merge intent, written and checked BEFORE `gh pr merge`, is the record that still
# exists when the append and the pending queue both fail on the same full disk. It stays until the
# row is recorded. (2) `gh pr view` can fail in the seconds right after a merge, and
# record-merged.sh refuses a row with no commit, so retry the metadata a bounded number of times,
# then queue the row on disk. The merged PR is closed, so no later open-PR list can bring it back:
# every dispatcher tick drains both records before reading PRs (2026-11-28 review: a transient SHA
# failure used to archive, release and report success with no row and no retry path, and a queue
# write the disk rejected used to report itself as queued). Each metadata attempt runs under a
# process-tree deadline: three attempts bound the count, not the wait, and a stalled `gh` after the
# merge must not hold the land lock or block dispatch. RSI_RECORD_RETRY_SLEEP=0 and
# RSI_RECORD_METADATA_SECS are the hermetic test seams.
RECORD_RETRY_SLEEP="${RSI_RECORD_RETRY_SLEEP:-2}"
RECORD_METADATA_SECS="${RSI_RECORD_METADATA_SECS:-20}"
case "$RECORD_METADATA_SECS" in ''|*[!0-9]*) RECORD_METADATA_SECS=20 ;; esac
PENDING_DIR() { echo "$STATE/merge/pending-records"; }
RECORD_INTENT_DIR() { echo "$STATE/merge/merge-intents"; }
write_record_file() { # <dir> <pr> <slug> <item> <url> — one file per PR, written atomically
  local d="$1" n="$2" tmp
  mkdir -p "$d" || return 1
  # One file per PR, published by mv: the dispatcher drains concurrently and may never rewrite a
  # row, so a record queued while it works cannot be lost inside a shared-file rewrite.
  tmp="$d/$n.tsv.$$"
  printf '%s\t%s\t%s\t%s\n' "$n" "$3" "$4" "$5" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$d/$n.tsv" || { rm -f "$tmp"; return 1; }
}
persist_merge_intent() { write_record_file "$(RECORD_INTENT_DIR)" "$@"; }
clear_merge_intent() { rm -f "$(RECORD_INTENT_DIR)/$1.tsv"; }
queue_pending_record() { write_record_file "$(PENDING_DIR)" "$@"; }
merged_commit_sha() { # <pr> -> sha8 on stdout; non-zero when the metadata never arrived
  local n="$1" try out rc sha
  for try in 1 2 3; do
    # A timeout is unavailable metadata, not a verdict: the caller queues the row and a later
    # tick retries it.
    out="$(bounded_run "$RECORD_METADATA_SECS" "$GH" pr view "$n" --repo "$GH_REPO" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null)"; rc=$?
    sha="$(printf '%s' "$out" | cut -c1-8)"
    if [ "$rc" -eq 0 ] && [ -n "$sha" ]; then printf '%s\n' "$sha"; return 0; fi
    [ "$try" -lt 3 ] && sleep "$RECORD_RETRY_SLEEP"
  done
  return 1
}
record_delivery() { # <pr> <slug> <item> <url> -> sha8 on stdout; 0 recorded, 1 queued, 2 no recovery record
  local n="$1" slug="$2" item="$3" url="$4" sha
  if sha="$(merged_commit_sha "$n")" && bash "$RSI_DIR/runtime/record-merged.sh" --state "$STATE" \
    --pr "$n" --slug "$slug" --item "$item" --sha "$sha" --url "$url" >/dev/null; then
    printf '%s\n' "$sha"
    return 0
  fi
  # A queued row is a recovery promise; an unchecked queue write would report one that does not
  # exist. 2 is "neither the append nor the queue landed" — the caller keeps the pre-merge intent.
  queue_pending_record "$n" "$slug" "$item" "$url" || return 2
  return 1
}
drain_record_dir() { # <dir> — retry every queued record once; a file leaves only when recorded
  local d="$1" f n slug item url sha
  [ -d "$d" ] || return 0
  for f in "$d"/*.tsv; do
    [ -e "$f" ] || continue
    # A row the recorder could never accept (empty, or no numeric PR) is dropped instead of being
    # retried forever; a valid row stays until the append actually lands.
    IFS=$'\t' read -r n slug item url < "$f" || { rm -f "$f"; continue; }
    case "${n:-}" in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
    [ -n "${slug:-}" ] && [ -n "${item:-}" ] || { rm -f "$f"; continue; }
    case "${url:-}" in https://github.com/*) ;; *) rm -f "$f"; continue ;; esac
    if sha="$(merged_commit_sha "$n")" && bash "$RSI_DIR/runtime/record-merged.sh" --state "$STATE" \
      --pr "$n" --slug "$slug" --item "$item" --sha "$sha" --url "$url" >/dev/null; then
      say "#$n $slug: delivery record recovered"
      rm -f "$f"
      clear_merge_intent "$n"
    fi
  done
  rmdir "$d" 2>/dev/null || true
}
drain_pending_records() { # the pending queue first, then any pre-merge intent the queue never replaced
  drain_record_dir "$(PENDING_DIR)"
  drain_record_dir "$(RECORD_INTENT_DIR)"
}
# The live PR state, keyed by slug: sendback_mech() has no PR number. Empty or unrecognised output
# is unreadable and callers fail open. The override is a test seam, the same shape as lane.sh's.
PR_STATE_CMD="${RSI_PR_STATE_CMD:-}"   # test seam; empty = the real gh call
pr_state() { # <slug> -> prints OPEN|MERGED|CLOSED; non-zero when the state cannot be read
  if [ -n "$PR_STATE_CMD" ]; then bash -c "$PR_STATE_CMD" pr-state "$1"
  else "$GH" pr view "rsi/$1" --repo "$GH_REPO" --json state --jq .state; fi
}
# A sendback must not outlive its PR. A verification can finish minutes after the PR was closed:
# #451 was closed at 06:28Z and a sync rework at 06:29:30Z still produced #453, a third copy of
# the same one-line doc change, taking a gate slot and a lane round. At the write site, MERGED or
# CLOSED archives the failure report and leaves one CEO line instead; no attempt/mech counter is
# bumped and the head-moved suppression does not run. Anything else (including an unreadable
# state) returns 1 and the caller continues exactly as today.
pr_finished() { # <slug> <pr-number|""> <sha> <detail-file> -> 0 finished and archived, 1 continue
  local slug="$1" n="$2" sha="${3:-}" det="$4" pstate sha8=unknown
  pstate="$(pr_state "$slug" 2>/dev/null || true)"
  case "$pstate" in MERGED|CLOSED) ;; *) return 1 ;; esac
  oid "$sha" && sha8="${sha:0:8}"
  archive_sendback "$slug" closed "$sha8"
  mkdir -p "$STATE/sendback/done"
  cp "$det" "$STATE/sendback/done/$slug-closed-$sha8.md" 2>/dev/null || true
  printf -- '- %s %srsi/%s: PR is %s; sendback suppressed (archived sendback/done/%s-closed-%s.md)\n' \
    "$(date '+%F %H:%M')" "${n:+PR #$n }" "$slug" "$pstate" "$slug" "$sha8" >> "$STATE/needs-ceo.md"
  say "$slug: PR $pstate; sendback suppressed (archived sendback/done/$slug-closed-$sha8.md)"
  KICK=1; SB_SUPPRESSED=1
  return 0
}
# The prose claim check (R-latency-fix, 2026-11-20): a PR that changes a prose-assertion path must
# carry a command the gate can run and the output it claims; runtime/claim_check.py owns the rule.
# It runs before the reviewer is launched, so a missing or false claim costs no model call. The
# sendback is mechanical on purpose: it is a missing proof, not a quality finding, and the
# scorecard counts quality sendbacks. A waiver is recorded as claim_check=waived in cycles.log so
# the patrol can watch the rate instead of trusting it.
claim_check_gate() { # <pr-number> <slug> <item> <worktree> <body-file> <changed-files-file> -> 0 pass/NA/waived, 1 sent back
  local n="$1" slug="$2" item="$3" wt="$4" bodyf="$5" pathsf="$6" out rc det
  out="$(python3 "$RSI_DIR/runtime/claim_check.py" "$wt" "$bodyf" "$pathsf" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    det="$STATE/merge/$slug.claim.txt"
    printf '%s\n' "$out" > "$det"
    # Provenance per write_sendback's contract: source=mech-claim, spec="-", cmd=the command the
    # worker must run (so the rework lane can reproduce the check without opening this script).
    sendback_mech "$slug" "$item" "claim check" "$det" "mech-claim" - \
      "python3 rsi/runtime/claim_check.py <worktree> <body-file> <changed-files-file>"
    say "#$n $slug: claim check failed — sent back before the reviewer"
    return 1
  fi
  case "${out%%$'\n'*}" in
    CLAIM_WAIVED:*)
      echo "$(date '+%F %H:%M') #$n $slug claim_check=waived" >> "$STATE/merge/cycles.log"
      say "#$n $slug: claim check waived ($(printf '%s\n' "$out" | head -1))" ;;
    *) say "#$n $slug: claim check ok" ;;
  esac
  return 0
}
# The gap-log close guard (R-gap-log-close-guard): a PR whose diff touches a repo-relative path an
# `## Open` entry in docs/plans/gap-log.md cites must move that entry to `## 已修` in the same PR,
# or state one sentence saying the citation is unrelated. Three fix PRs in two days left their own
# entry under `## Open` and each cost a second docs-only PR (#611, #615, #632), so the refusal is
# mechanical: runtime/gap_log_check.py owns the rule and this runs before the reviewer is paid for.
# A waiver is recorded as gap_log=waived in cycles.log, exactly like claim_check=waived.
gap_log_gate() { # <pr-number> <slug> <item> <worktree> <body-file> <changed-files-file> -> 0 pass/NA/waived, 1 sent back
  local n="$1" slug="$2" item="$3" wt="$4" bodyf="$5" pathsf="$6" out rc det
  out="$(python3 "$RSI_DIR/runtime/gap_log_check.py" "$wt" "$bodyf" "$pathsf" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    det="$STATE/merge/$slug.gap-log.txt"
    printf '%s\n' "$out" > "$det"
    # Provenance per write_sendback's contract: source=mech-gap-log, spec="-", cmd=the command
    # the worker must run (so the rework lane can reproduce the check without opening this script).
    sendback_mech "$slug" "$item" "gap-log close" "$det" "mech-gap-log" - \
      "python3 rsi/runtime/gap_log_check.py <worktree> <body-file> <changed-files-file>"
    say "#$n $slug: gap-log close failed — sent back before the reviewer"
    return 1
  fi
  case "${out%%$'\n'*}" in
    GAP_LOG_WAIVED:*)
      echo "$(date '+%F %H:%M') #$n $slug gap_log=waived" >> "$STATE/merge/cycles.log"
      say "#$n $slug: gap-log close waived ($(printf '%s\n' "$out" | head -1))" ;;
    *) say "#$n $slug: gap-log close ok" ;;
  esac
  return 0
}

# ------------------------------------------------- generated files (pure functions of the tree)
# A merge of origin/main can conflict in files nobody wrote by hand: the embedded console entry,
# the UI inventory baseline, and the story ledger pair (COVERAGE.md, plus PLAN.md's generated
# `状态：` sentence; both come from docs/product/stories/registry.json). Two story-carrying PRs in
# flight conflicted on exactly those two ledger files while registry.json and IA.md auto-merged
# (#467/#468, 2026-11-20), and bouncing one back for that burns one of its three attempts and
# 10-30 minutes of lane time. So resolve them here by regenerating. PLAN.md is only half
# generated: plan_guard_ok() refuses rather than dropping the other side's handwritten prose.
# Anything else — another conflicted path, a failed regeneration, a baseline that would grow, or
# a PLAN.md whose handwritten lines differ — returns 1 and the caller writes the usual sendback.
GEN_DIST=web/dist/index.html
GEN_INV=scripts/ui-inventory-baseline.json
GEN_COVERAGE=docs/product/stories/COVERAGE.md
GEN_PLAN=docs/product/stories/PLAN.md
GEN_STORIES="$GEN_COVERAGE $GEN_PLAN"   # the pair regenerated together (the followup's name)
# Every regenerator is overridable so rsi/runtime/tests/test-merge-gen-resolve.sh can run in a
# temp repo with stubs; the defaults are the commands a person would run.
DIST_BUILD="${RSI_DIST_BUILD_CMD:-npm run build}"
INV_UPDATE="${RSI_INV_UPDATE_CMD:-python3 scripts/check-ui-inventory.py --update}"
INV_CHECK="${RSI_INV_CHECK_CMD:-python3 scripts/check-ui-inventory.py}"
RN_CHECK="${RSI_RN_CHECK_CMD:-cd mobile-rn && npx tsc --noEmit && npx jest --ci && cd .. && python3 scripts/stories.py}"
RN_CHECK_TIMEOUT="${RSI_RN_CHECK_TIMEOUT:-900}"
STORIES_UPDATE="${RSI_STORIES_CMD:-python3 scripts/stories.py --write-coverage}"
# The live PR head, overridable so rsi/runtime/tests/test-loop-sendback-stale.sh can stub it.
PR_HEAD_CMD="${RSI_PR_HEAD_CMD:-}"   # test seam; empty = the real gh call
pr_head() { # <pr-number> -> prints the live head oid, non-zero on failure (an override reads it as $1)
  if [ -n "$PR_HEAD_CMD" ]; then bash -c "$PR_HEAD_CMD" pr-head "$1"
  else "$GH" pr view "$1" --repo "$GH_REPO" --json headRefOid --jq .headRefOid; fi
}
# The PR body for item_id() on the batch path (a bisected sendback has no body in hand). Same seam
# shape as pr_state/pr_head; an unreadable body falls through to item_id's R-<slug> fallback.
PR_BODY_CMD="${RSI_PR_BODY_CMD:-}"   # test seam; empty = the real gh call
pr_body() { # <slug> -> the PR body on stdout (empty when unreadable)
  if [ -n "$PR_BODY_CMD" ]; then bash -c "$PR_BODY_CMD" pr-body "$1" 2>/dev/null
  else "$GH" pr view "rsi/$1" --repo "$GH_REPO" --json body --jq .body 2>/dev/null; fi
}
# A head is an oid and nothing else: a gh warning or a blank line on stdout must read as unreadable.
oid() { case "${1:-}" in ""|*[!0-9a-fA-F]*) return 1 ;; esac; }
# The journey spec the UX gate walked, as a 12-hex revision of the WHOLE spec: the index and
# every per-journey file under rsi/runtime/ux/journeys/, so the sendback header names a revision
# that moves when any journey body moves. That is provenance, not cache invalidation: the UX PASS
# cache already keys on the PR diff plus origin/main:ui, the journey spec and the walker code.
# #251's false red was a walker/spec mismatch: the sendback named neither, so the retro could not
# tell it from a real defect. Never fails: the header line must always be writable, and an empty
# file list prints "-" rather than hashing nothing.
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

# PLAN.md is only half generated: stories.py rewrites the counts span inside the one `状态：`
# sentence — from `状态：` through the closing `）` — and leaves everything else, including the
# sentence's handwritten tail on that line, alone. `checkout --ours` would silently drop
# origin/main's words, so before touching the tree, require the two sides to be identical once
# that exact span is normalised away; every other byte, tails included, compares literally.
# Anything else (a missing side, a delete, a real prose edit) returns 1 and the caller sends back.
plan_guard_ok() { # <worktree> -> 0 identical but for the generated 状态 span; 1 fail closed
  local wt="$1" ours theirs rc
  ours="$(mktemp "${TMPDIR:-/tmp}/rsi-plan-ours.XXXXXX")" || return 1
  theirs="$(mktemp "${TMPDIR:-/tmp}/rsi-plan-theirs.XXXXXX")" || { rm -f "$ours"; return 1; }
  if ! $GIT -C "$wt" show "HEAD:$GEN_PLAN" > "$ours" 2>/dev/null \
     || ! $GIT -C "$wt" show "origin/main:$GEN_PLAN" > "$theirs" 2>/dev/null; then
    rm -f "$ours" "$theirs"; return 1
  fi
  python3 - "$ours" "$theirs" <<'PY'
import re, sys

# The same span scripts/stories.py rewrites (its PLAN_STATUS_RE): the counts and their
# parenthesised breakdown, from `状态：` to the closing `）`. The tail after it is handwritten
# (real PLAN.md has one), so it is compared literally. A `状态：` line this cannot parse is
# likewise compared literally, which refuses rather than dropping a person's words.
PLAN_STATUS_RE = re.compile(
    r"^状态：(?:\d+|[零〇一二两三四五六七八九十百]+)\s*条合同已写，"
    r"(?:\d+|[零〇一二两三四五六七八九十百]+)\s*条已签字"
    r"（[^）\n]*）",
    re.M,
)

def norm(path):
    with open(path, encoding="utf-8") as fh:
        # count=1: rewrite_plan_counts() splices the first match only, so a second status-shaped
        # line is handwritten and must compare literally.
        return PLAN_STATUS_RE.sub("<status>", fh.read(), count=1)

sys.exit(0 if norm(sys.argv[1]) == norm(sys.argv[2]) else 1)
PY
  rc=$?; rm -f "$ours" "$theirs"; return $rc
}

gen_resolve() { # worktree -> 0 resolved and committed; 1 anything else (caller aborts and sends back)
  local wt="$1" un p has_dist=0 has_inv=0 has_cov=0 has_plan=0
  un="$($GIT -C "$wt" diff --name-only --diff-filter=U)" || return 1
  [ -n "$un" ] || return 1
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in
      "$GEN_DIST"|"$GEN_INV"|"$GEN_COVERAGE"|"$GEN_PLAN") ;;
      *) return 1 ;;   # a source conflict is a person's job
    esac
  done <<< "$un"
  echo "$un" | grep -qxF "$GEN_DIST" && has_dist=1
  echo "$un" | grep -qxF "$GEN_INV" && has_inv=1
  echo "$un" | grep -qxF "$GEN_COVERAGE" && has_cov=1
  echo "$un" | grep -qxF "$GEN_PLAN" && has_plan=1
  # The half-generated file is checked BEFORE any `checkout --ours`: a refusal must leave the merge
  # exactly as git left it, so the caller's `git merge --abort` still restores the pre-merge tree.
  if [ $has_plan -eq 1 ]; then plan_guard_ok "$wt" || return 1; fi
  # Take ours as the base, then REGENERATE BEFORE COMMITTING: a failed build, a growing ratchet or
  # a rejected ledger must leave `git merge --abort` possible, and that only restores an
  # uncommitted merge. The regenerated files ride in the merge commit itself, so the tree is clean
  # when this returns.
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
  if [ $has_cov -eq 1 ] || [ $has_plan -eq 1 ]; then
    # Fail closed: --write-coverage exits 1 when the regenerated ledger still has a problem, and
    # that is a sendback, not a merge. It may rewrite PLAN.md's count sentence even when only
    # COVERAGE.md conflicted, so stage the whole pair path-limited or the tree ends up dirty.
    ( cd "$wt" && bash -c "$STORIES_UPDATE" ) >/dev/null 2>&1 || return 1
    $GIT -C "$wt" add -- "$GEN_COVERAGE" "$GEN_PLAN" || return 1
  fi
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    $GIT -C "$wt" add -- "$p" || return 1
  done <<< "$un"
  $GIT -C "$wt" commit -q --no-edit || return 1
}

# ------------------------------------------------- a sync ends merged or aborted, never half-merged
# A verifier killed between `git merge origin/main` and its commit leaves MERGE_HEAD plus unmerged
# paths behind while HEAD is still the pre-merge head. The next gate/review then judges an old head
# over a dirty index, and a later commit from that worktree can sweep another PR's staged files in
# (2026-11-21: PR #506's worktree had `UU web/dist/index.html`, MERGE_HEAD=3c328fa7 and 9 staged
# files byte-identical to #504's head, while the verifier gated the old head 1849750d). So every
# return path of sync_main either commits the merge or aborts it. Abort is the only rollback:
# `git merge --abort` restores the pre-merge tree and keeps the lane's uncommitted work, where
# `reset --hard` would destroy it.
merge_in_progress() { # <worktree> -> 0 when a merge is mid-flight or the index has unmerged entries
  local wt="${1:-}" u
  [ -n "$wt" ] && [ -d "$wt" ] || return 1
  $GIT -C "$wt" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && return 0
  u="$($GIT -C "$wt" ls-files -u 2>/dev/null)" && [ -n "$u" ]
}

abort_merge() { # <worktree> -> 0 when no merge is in progress afterwards; retried once, never `reset --hard`
  local wt="${1:-}" try
  merge_in_progress "$wt" || return 0
  for try in 1 2; do
    $GIT -C "$wt" merge --abort >/dev/null 2>&1
    merge_in_progress "$wt" || return 0
    [ "$try" -eq 1 ] && sleep 1   # an index.lock held by a just-killed child can clear a moment later
  done
  return 1
}

# Surface a worktree this cycle must not report as usable: the detail file carries the raw reason,
# the needs-ceo line makes it visible without opening the log, and the caller returns 2 (skip).
sync_refuse_half() { # <reason>
  printf '%s\n' "$1" > "$STATE/merge/$SLUG.err"
  printf -- '- %s PR rsi/%s: %s (see %s)\n' \
    "$(date '+%F %H:%M')" "$SLUG" "$1" "$STATE/merge/$SLUG.err" >> "$STATE/needs-ceo.md"
  say "#$N $SLUG: $1"
}

sync_main() { # -> 0 ok (pushed if changed), 1 conflict (sendback written), 2 transient failure; never leaves a half-merge
  # Any sync ends a CI-first hold: the head this marker bounded is gone, so a later pending CI
  # starts its own fresh window instead of inheriting an expired one.
  rm -f "$STATE/merge/$SLUG.ci-hold"
  # A merge already in flight is a state this cycle did not verify and must not build on: abort it
  # first (the lane's own work survives), then refuse the cycle instead of reporting over it.
  if merge_in_progress "$WT"; then
    if abort_merge "$WT"; then
      say "#$N $SLUG: a half-finished merge was present; aborted it before syncing"
      printf -- '- %s PR rsi/%s: a merge of origin/main was left half-applied in %s; aborted before sync, cycle skipped\n' \
        "$(date '+%F %H:%M')" "$SLUG" "$WT" >> "$STATE/needs-ceo.md"
    else
      sync_refuse_half "a merge of origin/main is in progress in $WT and git merge --abort failed"
    fi
    return 2
  fi
  if $GIT -C "$WT" merge-base --is-ancestor origin/main HEAD; then
    if [ "$($GIT -C "$WT" rev-parse HEAD)" != "$($GIT -C "$WT" rev-parse "origin/$BR" 2>/dev/null)" ]; then
      with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null || { say "#$N: push of prior local merge failed"; return 2; }
    fi
    return 0
  fi
  say "#$N $SLUG: merging origin/main"
  if ! $GIT -C "$WT" merge -q --no-edit origin/main >/dev/null 2>&1; then
    if gen_resolve "$WT"; then say "#$N: conflict(s) in generated files resolved by regeneration"
    else
      CF="$($GIT -C "$WT" diff --name-only --diff-filter=U)"
      if abort_merge "$WT"; then
        printf 'merge of origin/main conflicts in:\n%s\n' "$CF" > "$STATE/merge/$SLUG.err"
        sendback_mech "$SLUG" "$ITEM" "merge conflict with main" "$STATE/merge/$SLUG.err" "mech" - "$GIT -C $WT merge -q --no-edit origin/main"; return 1
      fi
      # The abort itself could not run: do not promise a usable worktree or queue rework on it.
      sync_refuse_half "merge of origin/main conflicts in: ${CF:-?}; git merge --abort failed, worktree NOT usable"
      return 2
    fi
  fi
  # Post-condition: the merge is committed or aborted before anything calls this worktree usable.
  # A `git merge` that reports success but leaves MERGE_HEAD (or a resolver that returned early on
  # an unmerged index) is aborted here rather than pushed and gated on a stale head.
  if merge_in_progress "$WT"; then
    if abort_merge "$WT"; then
      sync_refuse_half "a merge of origin/main was still in progress after the sync; aborted it, cycle skipped"
    else
      sync_refuse_half "a merge of origin/main is still in progress in $WT and git merge --abort failed"
    fi
    return 2
  fi
  with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null || { say "#$N: push after merge-main failed"; return 2; }
  return 0
}

main_move_verdict() { # <incoming-paths> <pr-changed-paths> — sets MOVE_TAG (CARRY|CARRY-UI|CARRY-RN|CARRY-UI-RN|REGATE)
  # and MOVE_REASON. The one disjoint classifier: origin/main moved under a verified PR. CARRY when
  # every incoming path is disjoint from the PR's own files and packages and from the shared
  # surfaces (a scripts/ path is shared only when the gate runs it or the PR is in scripts/ or ui/),
  # CARRY-UI when a ui leaf moved (alone or beside disjoint Go packages), CARRY-RN when a mobile-rn
  # leaf (not the PR's own file, not the RN toolchain) moved, CARRY-UI-RN when both did, REGATE
  # otherwise. The callers decide what a CARRY
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
    "cmd/", "internal/api/", ".github/", "desktop/", "mobile/", "web/",
)
shared_files = {
    "ui/src/index.css", "ui/src/App.tsx", "ui/src/main.tsx",
    "ui/package.json", "ui/package-lock.json", "go.mod", "go.sum",
}
# scripts/ is different: one script the gate starts is a shared surface, every other script is a
# leaf. Deny-list, not an allow-list, so a new script carries by default and only a gate job makes
# it shared. The completeness pin in rsi/runtime/tests/test-gate-carry.sh
# (test_regates_every_script_the_gate_runs) reads the real scripts/check.sh and each script listed
# here one level down, and fails when a script either names is missing, so a new check job or a
# helper a gate script starts cannot silently widen the carry.
GATE_SCRIPTS = {
    "scripts/check.sh", "scripts/check-openapi.sh", "scripts/check-api-coverage.sh",
    "scripts/install-hub.sh", "scripts/install-hub.test.sh", "scripts/stories.py",
    "scripts/check-ui-inventory.py", "scripts/check-ui-inventory.test.py",
    "scripts/check-removed-surfaces.py", "scripts/check-removed-surfaces.test.py",
    "scripts/ux_spec_refs.py", "scripts/ux_spec_refs_test.py",
    "scripts/ui_inventory.py", "scripts/ui_lint_guard.py", "scripts/ui_lint_guard_test.py",
    "scripts/ui-lint-guard.sh", "scripts/journeys_seed.py", "scripts/journeys_smoke.py",
    "scripts/journeys-smoke.sh", "scripts/journeys_walk_test.py", "scripts/journeys_smoke_test.py",
    "scripts/quality_001_reading_test.py", "scripts/phone-console-startup.mjs",
}
# A PR's Go package is internal/<pkg>/: a sibling file in it can change the package's behaviour.
pr_pkgs = {"/".join(p.split("/")[:2]) + "/" for p in pr_files
           if p.startswith("internal/") and p.count("/") >= 2}
pr_root_files = {p for p in pr_files if "/" not in p}
RN_TOOLCHAIN = {
    "mobile-rn/package.json", "mobile-rn/package-lock.json", "mobile-rn/app.json",
    "mobile-rn/babel.config.js", "mobile-rn/metro.config.js", "mobile-rn/tsconfig.json",
}

carry = []      # incoming paths that justify the carry
need_ui = False  # a ui leaf moved: the build+inventory safety step must still pass
need_rn = False  # an RN leaf moved: the mobile-rn tsc+jest+stories safety step must still pass
for p in incoming:
    if dropped(p):
        continue
    if p in shared_files or p.startswith(shared_dirs):
        print("REGATE\tshared surface moved: %s" % p); sys.exit()
    if p.startswith("scripts/"):
        # A leaf script is disjoint from a backend-only PR, but a gate script changes what every
        # PR's verification means, and a PR in scripts/ or ui/ is the surface the script judges.
        if p in GATE_SCRIPTS:
            print("REGATE\tthe gate runs this script: %s" % p); sys.exit()
        if any(q.startswith(("scripts/", "ui/")) for q in pr_files):
            print("REGATE\tthe PR touches scripts/ or ui/: %s" % p); sys.exit()
        carry.append(p)  # a script leaf is not a ui leaf: no build/inventory safety step
        continue
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
    if p.startswith("mobile-rn/"):
        # The RN toolchain changes how every RN file compiles and runs; any other RN file is a leaf
        # the tsc+jest+stories safety step re-proves on the merged tree (2026-11-26: 48 logged
        # re-gates were one RN PR landing under another).
        if p in RN_TOOLCHAIN or p.startswith("mobile-rn/scripts/"):
            print("REGATE\tRN toolchain moved: %s" % p); sys.exit()
        if p in pr_set:
            print("REGATE\tthe PR's own file moved: %s" % p); sys.exit()
        carry.append(p); need_rn = True
        continue
    if p in pr_root_files:
        print("REGATE\tthe PR's own top-level file moved: %s" % p); sys.exit()
    print("REGATE\tunclassified path moved: %s" % p); sys.exit()

if not carry:
    print("CARRY\tnothing but docs/rsi/generated files moved")
elif need_ui and need_rn:
    print("CARRY-UI-RN\t" + " ".join(carry))
elif need_ui:
    print("CARRY-UI\t" + " ".join(carry))
elif need_rn:
    print("CARRY-RN\t" + " ".join(carry))
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
  local done_steps=""
  case "$MOVE_TAG" in
    CARRY) ;;
    CARRY-UI|CARRY-RN|CARRY-UI-RN)
      case "$MOVE_TAG" in *UI*)
        # Leaf ui paths disjoint from the PR's own files. Prove the merged tree still holds the two
        # things only a build can answer: the inventory ratchet and a dist rebuild that reproduces
        # the committed web/dist/index.html. Any doubt (failed step, changed dist) re-gates.
        if ! { ( cd "$wt" && bash -c "$INV_CHECK" ) >/dev/null 2>&1 \
               && ( cd "$wt/ui" && bash -c "$DIST_BUILD" ) >/dev/null 2>&1 \
               && $GIT -C "$wt" diff --quiet -- web/dist/index.html; }; then
          $GIT -C "$wt" checkout -q -- web/dist/index.html 2>/dev/null || true
          CARRY_REASON="ui safety step failed (inventory/build/dist) after: $MOVE_REASON"
          rm -f "$gatefile"; return 1
        fi
        done_steps="inventory+build green, web/dist/index.html unchanged" ;;
      esac
      case "$MOVE_TAG" in *RN)
        # Leaf mobile-rn paths disjoint from the PR's own files and the RN toolchain. The RN gate is
        # its typecheck, its suite and the story registry; re-run exactly those on the merged tree,
        # bounded, and re-gate on any failure, timeout or missing install.
        if ! ( cd "$wt" && with_timeout "$RN_CHECK_TIMEOUT" bash -c "$RN_CHECK" ) >/dev/null 2>&1; then
          CARRY_REASON="rn safety step failed (tsc/jest/stories) after: $MOVE_REASON"
          rm -f "$gatefile"; return 1
        fi
        done_steps="${done_steps:+$done_steps; }mobile-rn tsc+jest+stories green" ;;
      esac ;;
    *)
      CARRY_REASON="${MOVE_REASON:-carry predicate produced no decision}"
      rm -f "$gatefile"; return 1 ;;
  esac
  CARRY_REASON="$MOVE_REASON${done_steps:+; $done_steps}"
  echo "$newsha PASS $role" > "$gatefile"; return 0
}

# ------------------------------------------------------------------ queue-time carry
pr_diff_hash() { # <worktree> — the review key (step 4's DH): the PR's own diff, dist + lockfile excluded
  $GIT -C "$1" diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16
}

# The UX walk cache (state/merge/<slug>.uxverified) survives a main move only when nothing that can
# change what the walk proves moved. This key digests every ui/ path except the families that
# provably cannot render: test/spec files, __tests__/ and test/ fixtures, mutant manifests and
# markdown. Everything else — package.json, the lockfile, every source and style file — stays in,
# so a path family this cannot positively classify still re-walks (the cache is only worth a walk
# when the walk is provably still about this console). It also digests the walker's own spec and
# code: #644 added J4 to the sessions row while #630's PASS was cached, and a ui/-only key carried
# that PASS over a journey the cached walk never ran.
# The walker-spec family: every path whose movement changes what a cached UX walk proves. The
# carry key digests exactly this set, and the dispatcher's spec-mover hold reads the same list, so
# a PR that moves one of these files is the PR whose merge will re-walk the console. One
# definition, two readers — a second literal list would drift, and #644 (journeys.json) moved the
# spec while #630's walk was being re-derived against the old one.
UX_SPEC_PATHS="rsi/runtime/ux/journeys.json rsi/runtime/ux/journeys rsi/runtime/ux/walk.mjs rsi/runtime/ux/optional-grace.mjs rsi/runtime/ux/walk-log.mjs"
ux_carry_key() { # <worktree> <main-ref> — digest of the console tree and the walker that walked it
  local tree spec
  tree="$($GIT -C "$1" ls-tree -r "$2" -- ui 2>/dev/null)" || { echo unreadable; return 0; }
  spec="$($GIT -C "$1" ls-tree -r "$2" -- $UX_SPEC_PATHS 2>/dev/null)"
  {
    printf '%s\n' "$tree" \
      | grep -vE '(\.(test|spec)\.[^/]+$|/__tests__/|/test/|\.mutants\.json$|\.md$)'
    printf '%s\n' "$spec"
  } | shasum | cut -c1-16
}

ux_carry_verdict() { # <worktree> <main-ref> <uxverified-file> <pr-diff-hash>
  # 0 = CARRY (UX_CARRY_KEY names the tree the cached walk is still evidence for); 1 = REGATE
  # (UX_CARRY_REASON says which half moved). The land block reads this verdict and writes the same
  # UX_CARRY_KEY at its PASS line, so the cached walk can never be keyed by one tree and looked up
  # by another. Any unreadable or disagreeing field re-walks.
  local wt="$1" ref="$2" uxv="$3" dh="$4" rec_dh="" rec_ver="" rec_key=""
  UX_CARRY_KEY="$(ux_carry_key "$wt" "$ref")-$($GIT -C "$wt" rev-parse HEAD:ui/package-lock.json 2>/dev/null || echo none)"
  [ -s "$uxv" ] && { read -r rec_dh rec_ver rec_key _ < "$uxv" 2>/dev/null || true; }
  if [ -z "$rec_dh$rec_ver$rec_key" ]; then
    UX_CARRY_REASON="no completed UX walk recorded for this PR"; return 1
  fi
  if [ "$rec_dh" != "$dh" ]; then
    UX_CARRY_REASON="the PR diff moved (${rec_dh:-none} -> $dh)"; return 1
  fi
  if [ "$rec_ver" != PASS ]; then
    UX_CARRY_REASON="the recorded walk is ${rec_ver:-unreadable}, not PASS"; return 1
  fi
  if [ "$rec_key" != "$UX_CARRY_KEY" ]; then
    UX_CARRY_REASON="the rendered console's inputs moved (${rec_key:-none} -> $UX_CARRY_KEY)"; return 1
  fi
  UX_CARRY_REASON="PR diff and the rendered console's inputs are unchanged"
  return 0
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

# ------------------------------------------------------------------ optimistic batch verification
# RSI_BATCH_VERIFY=1 (default 0) lets the dispatcher pay ONE gate for a set of ready PRs: each
# member's review and CI already passed per PR exactly as today, only the local gate is deferred
# to a union tree. The members then land one by one; after each squash the landed main tree is
# compared with the union's recorded prefix tree. Off = today's path byte for byte.
BATCH_SIZE="${RSI_BATCH_SIZE:-2}"; case "$BATCH_SIZE" in ''|*[!0-9]*|0) BATCH_SIZE=2 ;; esac
[ "$BATCH_SIZE" -gt 3 ] && BATCH_SIZE=3
BATCH_AGE_MAX="${RSI_BATCH_AGE_MAX:-5400}"   # 90 minutes; a marker older than this is never reused
batch_enabled() { [ "${RSI_BATCH_VERIFY:-0}" = 1 ]; }

# Phase 1 never batches a PR that pays the UX walk (the walk's evidence is per PR and phase 2 owns it).
batch_walk_trigger() { # <changed-paths-file> — 0 when this PR triggers the UX walk
  grep -E '^ui/src/.*\.(tsx|css)$' "$1" 2>/dev/null | grep -vqE '\.(test|spec)\.' && return 0
  grep -qE '^(ui/package(-lock)?\.json|ui/tailwind|ui/postcss)' "$1" 2>/dev/null
}
# Shared/high-risk surfaces never join a batch: a change there moves what every member's
# verification means, so the member falls back to single verification.
batch_shared_risk() { # <changed-paths-file>
  grep -qE '^(go\.mod|go\.sum|ui/package(-lock)?\.json|\.github/|scripts/check\.sh|.*migrations?/|internal/auth(/|$)|rsi/runtime/(merge|gate|common)\.sh$)' "$1" 2>/dev/null
}
batch_disjoint() { # <paths-a> <paths-b> — 0 when the only shared path (if any) is web/dist/index.html
  local a b
  a="$(mktemp "${TMPDIR:-/tmp}/rsi-bd-a.XXXXXX")" || return 1
  b="$(mktemp "${TMPDIR:-/tmp}/rsi-bd-b.XXXXXX")" || { rm -f "$a"; return 1; }
  sort -u "$1" > "$a"; sort -u "$2" > "$b"
  # -q on the middle grep would close the pipe and make the final grep read nothing, so the
  # filter would report every pair disjoint; only the last stage is quiet.
  if comm -12 "$a" "$b" | grep -vx 'web/dist/index.html' | grep -q .; then rm -f "$a" "$b"; return 1; fi
  rm -f "$a" "$b"; return 0
}
# A ready snapshot: review PASS for this PR's own diff (a disjoint main move keeps the key), CI
# green on the live head, no hold/draft/blocked/sendback, and no gate PASS already on disk (that
# PR can land on its own and needs no batch). Manifest row fields are tab-separated:
#   number slug head diffkey tier ci flags changed-paths-file
batch_ready() { # <row> <state> — prints an empty string when ready, else the one-word reason
  local row="$1" state="$2" n slug head dh tier ci flags paths
  IFS=$'\t' read -r n slug head dh tier ci flags paths <<< "$row"
  [ -n "$n" ] && [ -n "$slug" ] && [ -n "$head" ] && [ -n "$paths" ] || { echo malformed; return; }
  case ",$flags," in *,draft,*|*,hold,*|*,needs-ceo,*|*,blocked,*|*,sendback,*) echo flagged; return ;; esac
  [ "$ci" = green ] || { echo "ci-$ci"; return; }
  [ -s "$paths" ] || { echo no-paths; return; }
  batch_walk_trigger "$paths" && { echo ux-walk; return; }
  batch_shared_risk "$paths" && { echo shared-risk; return; }
  local gsha gpass grole rdh rver rsha
  [ -s "$state/merge/$slug.verified" ] && { read -r gsha gpass grole _ < "$state/merge/$slug.verified" 2>/dev/null || true; }
  [ "$gpass" = PASS ] && [ "$gsha" = "$head" ] && { echo already-gated; return; }
  [ -s "$state/merge/$slug.reviewed" ] && { read -r rdh rver rsha _ < "$state/merge/$slug.reviewed" 2>/dev/null || true; }
  [ "$rver" = PASS ] && [ "$rdh" = "$dh" ] || { echo review-not-pass; return; }
  echo ""
}
# batch_plan <manifest> <state> <base> — print the batch in PR-number order, or SINGLE <reason>.
# Every pair must pass main_move_verdict with CARRY in both directions and have disjoint changed
# paths; at least one member is non-small. No writes.
batch_plan() {
  local manifest="$1" state="$2" base="$3"
  local rows=() row slug head dh tier flags paths reason order=() n
  batch_enabled || { echo "SINGLE batch-disabled"; return 1; }
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    reason="$(batch_ready "$row" "$state")"
    [ -z "$reason" ] || { say "batch: skip $(printf '%s' "$row" | cut -f2): $reason" >&2; continue; }
    rows+=("$row")
  done < "$manifest"
  [ ${#rows[@]} -ge 2 ] || { echo "SINGLE fewer-than-two-ready"; return 1; }
  # PR number order is the landing order (stable, and the prefix trees are recorded in it).
  local sorted
  sorted="$(printf '%s\n' "${rows[@]}" | sort -t$'\t' -k1,1n)"
  rows=(); while IFS= read -r row; do [ -n "$row" ] && rows+=("$row"); done <<< "$sorted"
  local chosen=()
  for row in "${rows[@]}"; do
    [ ${#chosen[@]} -ge "$BATCH_SIZE" ] && break
    local ok=1 other opaths
    IFS=$'\t' read -r _ _ _ _ _ _ _ paths <<< "$row"
    # bash 3.2 (the macOS /bin/bash this script runs on) treats "${arr[@]}" on an empty array
    # as an unbound variable under `set -u`; the guarded form is the portable spelling.
    for other in ${chosen[@]+"${chosen[@]}"}; do
      IFS=$'\t' read -r _ _ _ _ _ _ _ opaths <<< "$other"
      batch_disjoint "$paths" "$opaths" || { ok=0; break; }
      main_move_verdict "$(cat "$opaths")" "$(cat "$paths")" || true
      [ "$MOVE_TAG" = CARRY ] || { ok=0; break; }
      main_move_verdict "$(cat "$paths")" "$(cat "$opaths")" || true
      [ "$MOVE_TAG" = CARRY ] || { ok=0; break; }
    done
    [ $ok -eq 1 ] && chosen+=("$row")
  done
  [ ${#chosen[@]} -ge 2 ] || { echo "SINGLE not-compatible"; return 1; }
  local have_big=0 c tier2
  for c in "${chosen[@]}"; do
    IFS=$'\t' read -r _ _ _ _ tier2 _ _ _ <<< "$c"
    [ "$tier2" = small ] || have_big=1
  done
  if [ $have_big -eq 0 ]; then
    # Do not pay union overhead for two one-line docs PRs: try to pull in the first compatible
    # non-small candidate without dropping anyone.
    local added=""
    for row in "${rows[@]}"; do
      IFS=$'\t' read -r _ _ _ _ tier2 _ _ paths <<< "$row"
      [ "$tier2" = small ] && continue
      printf '%s\n' "${chosen[@]}" | cut -f2 | grep -qx "$(printf '%s' "$row" | cut -f2)" && continue
      local ok=1 opaths
      for other in "${chosen[@]}"; do
        IFS=$'\t' read -r _ _ _ _ _ _ _ opaths <<< "$other"
        batch_disjoint "$paths" "$opaths" || { ok=0; break; }
        main_move_verdict "$(cat "$opaths")" "$(cat "$paths")"; [ "$MOVE_TAG" = CARRY ] || { ok=0; break; }
        main_move_verdict "$(cat "$paths")" "$(cat "$opaths")"; [ "$MOVE_TAG" = CARRY ] || { ok=0; break; }
      done
      [ $ok -eq 1 ] && { chosen+=("$row"); added=1; break; }
    done
    [ -n "$added" ] || { echo "SINGLE all-small"; return 1; }
  fi
  local id="batch-$(date +%s)-$$" i=0
  echo "BATCH $id $base"
  for row in "${chosen[@]}"; do
    i=$((i+1))
    IFS=$'\t' read -r n slug head dh tier2 _ _ _ <<< "$row"
    # The PR number travels with the member row: the runner re-enters --one (which needs it) and
    # the landing order is the number order.
    printf 'MEMBER %s\t%s\t%s\t%s\t%s\t%s\n' "$i" "$slug" "$head" "$dh" "$tier2" "$n"
  done
  return 0
}
# batch_union <repo> <base> <record> <head>... — merge the frozen heads in order into a throwaway
# branch. Records base, each head and prefix tree, and the union tree. Never pushes. Returns 3 on
# a conflict outside web/dist/index.html (phase 1 never resolves source conflicts).
batch_union() {
  local repo="$1" base="$2" rec="$3"; shift 3
  local br="batch/union-$$" i=0 head conflicts
  $GIT -C "$repo" checkout -q -B "$br" "$base" || return 2
  : > "$rec"
  printf 'base %s\n' "$base" >> "$rec"
  for head in "$@"; do
    i=$((i+1))
    if ! $GIT -C "$repo" merge -q --no-edit "$head" >/dev/null 2>&1; then
      conflicts="$($GIT -C "$repo" diff --name-only --diff-filter=U)"
      if [ -n "$conflicts" ] && ! printf '%s\n' "$conflicts" | grep -vqx 'web/dist/index.html'; then
        $GIT -C "$repo" checkout -q --theirs -- web/dist/index.html 2>/dev/null || true
        $GIT -C "$repo" add -- web/dist/index.html
        $GIT -C "$repo" commit -q --no-edit || { $GIT -C "$repo" merge --abort >/dev/null 2>&1; return 3; }
      else
        $GIT -C "$repo" merge --abort >/dev/null 2>&1
        return 3
      fi
    fi
    printf 'head %s %s\n' "$i" "$head" >> "$rec"
    printf 'tree %s %s\n' "$i" "$($GIT -C "$repo" rev-parse HEAD^{tree})" >> "$rec"
  done
  printf 'union %s\n' "$($GIT -C "$repo" rev-parse HEAD^{tree})" >> "$rec"
  return 0
}
batch_marker_write() { # <marker-file> <batch-id> <index> <base> <head> <diffkey> <union-tree>
  local m="$1"
  {
    echo "batch $2"; echo "index $3"; echo "base $4"; echo "head $5"
    echo "diffkey $6"; echo "tree $7"; echo "written $(date +%s)"
  } > "$m"
}
# A marker is reusable only for the same batch, index, head and diff key, inside the age bound.
# A base move is not checked here: the ordinary queue-time carry re-runs main_move_verdict and
# drops the gate on REGATE, and the land-time prefix-tree compare proves the landed tree.
batch_marker_valid() { # <marker> <batch-id> <index> <head> <diffkey> <now> [max-age] [member-state]
  local m="$1" want_id="$2" want_ix="$3" head="$4" dh="$5" now="$6" max="${7:-$BATCH_AGE_MAX}"
  local member="${8:-}"
  local bid ix base mhead mdh tree written
  batch_enabled || { echo "INVALID batch-disabled"; return 1; }
  [ "$member" = closed ] && { echo "INVALID member-closed"; return 1; }
  [ -s "$m" ] || { echo "INVALID no-marker"; return 1; }
  bid="$(awk '$1=="batch"{print $2}' "$m")"; ix="$(awk '$1=="index"{print $2}' "$m")"
  base="$(awk '$1=="base"{print $2}' "$m")"; mhead="$(awk '$1=="head"{print $2}' "$m")"
  mdh="$(awk '$1=="diffkey"{print $2}' "$m")"; written="$(awk '$1=="written"{print $2}' "$m")"
  [ "$bid" = "$want_id" ] || { echo "INVALID other-batch"; return 1; }
  [ "$ix" = "$want_ix" ] || { echo "INVALID order"; return 1; }
  [ "$mhead" = "$head" ] || { echo "INVALID head-moved"; return 1; }
  [ "$mdh" = "$dh" ] || { echo "INVALID diffkey"; return 1; }
  case "$written" in ''|*[!0-9]*) echo "INVALID malformed"; return 1 ;; esac
  [ $(( now - written )) -le "$max" ] || { echo "INVALID expired"; return 1; }
  echo VALID; return 0
}
# Landing proof: the landed main tree equals the union's prefix tree for this member, ignoring
# web/dist/index.html (the UI build may legitimately rebuild it between members).
batch_prefix_check() { # <repo> <record> <index> <main-tree>
  local want
  want="$(awk -v i="$3" '$1=="tree" && $2==i {print $3}' "$2")"
  [ -n "$want" ] || return 1
  [ "$want" = "$4" ] && return 0
  $GIT -C "$1" diff --quiet "$want" "$4" -- . ':!web/dist/index.html'
}
batch_invalidate() { # <state> <slug>... — drop batch markers and batch-written gate files only
  local state="$1" slug f role; shift
  for slug in "$@"; do
    rm -f "$state/merge/$slug.batch"
    f="$state/merge/$slug.verified"
    [ -s "$f" ] && { role="$(cut -d' ' -f3 "$f")"; [ "$role" = batch ] && rm -f "$f"; }
  done
}
# Bisect (diagnosis only): the union of <heads...> already failed <step>. Split the list, build
# each half's tree and run only that step; recurse to singletons. Prints CULPRIT <head> per
# attributor, or NONATTRIBUTABLE when every singleton passes. Nothing here sends back or lands.
batch_bisect() { # <repo> <base> <step> <head>...
  local repo="$1" base="$2" step="$3"; shift 3
  local out
  out="$(batch_bisect_list "$repo" "$base" "$step" "$@")"
  if [ -z "$out" ]; then echo NONATTRIBUTABLE; else printf '%s\n' "$out"; fi
}
batch_bisect_list() {
  local repo="$1" base="$2" step="$3"; shift 3
  local heads=("$@") n=${#heads[@]} rec rc half left right
  [ $n -eq 0 ] && return 0
  rec="$(mktemp "${TMPDIR:-/tmp}/rsi-batch-rec.XXXXXX")" || return 1
  if batch_union "$repo" "$base" "$rec" "${heads[@]}"; then
    ( cd "$repo" && bash "$RSI_DIR/runtime/gate.sh" --only "$step" "$repo" ) > "$rec.log" 2>&1; rc=$?
    if [ $rc -eq 0 ] && grep -q '^GATE_RESULT=PARTIAL$' "$rec.log"; then rm -f "$rec" "$rec.log"; return 0; fi
    # A filtered run that could not judge (exit 3, ^GATE_RESULT=NO_VERDICT) failed on the machine,
    # not on these members: attribute nobody, and stop this branch instead of recursing into a
    # singleton CULPRIT that batch_run would send back to a worker.
    if grep -q '^GATE_RESULT=NO_VERDICT' "$rec.log" 2>/dev/null; then
      rm -f "$rec" "$rec.log"
      echo "NO_VERDICT $step"
      return 0
    fi
  fi
  rm -f "$rec" "$rec.log"
  if [ $n -eq 1 ]; then echo "CULPRIT ${heads[0]}"; return 0; fi
  half=$(( n / 2 ))
  batch_bisect_list "$repo" "$base" "$step" "${heads[@]:0:$half}"
  batch_bisect_list "$repo" "$base" "$step" "${heads[@]:$half}"
}

# ------------------------------------------------------------------ live batch runner
# `merge.sh --batch <id> <members-file>` is the half the dispatcher starts instead of one --one
# verifier per member: it pays ONE full gate on the union of the frozen heads, writes each
# member's marker (role batch), then re-enters the ordinary --one verifier per member in
# PR-number order so squash/prefix/sendback stay where they already live. After each landing the
# landed main tree must equal the union's recorded prefix tree; every path that cannot prove a
# landing invalidates the rest instead of landing them. Members file = batch_plan's output:
#   BATCH <id> <base>
#   MEMBER <index>\t<slug>\t<head>\t<diffkey>\t<tier>\t<pr-number>
BATCH_REPO="${RSI_BATCH_REPO:-$RSI_CTRL}"     # seam: tests build the union in a temp clone
BATCH_ONE_CMD="${RSI_BATCH_ONE_CMD:-}"        # seam: records the re-entry instead of verifying
BATCH_WT=""; BATCH_BR=""
batch_cleanup() {
  local repo="${BATCH_REPO:-$RSI_CTRL}" s k
  [ -n "$BATCH_WT" ] && [ -d "$BATCH_WT" ] && $GIT -C "$repo" worktree remove --force "$BATCH_WT" >/dev/null 2>&1
  [ -n "$BATCH_BR" ] && $GIT -C "$repo" branch -D "$BATCH_BR" >/dev/null 2>&1
  # Release only claims this process still owns; an --one child removes its own on exit.
  k=0
  while [ $k -lt "${BM_COUNT:-0}" ]; do
    s="$STATE/merge/${BM_SLUG[$k]}.lock"
    [ "$(cat "$s/pid" 2>/dev/null)" = "$$" ] && rm -rf "$s"
    k=$((k+1))
  done
  BATCH_WT=""; BATCH_BR=""
}
batch_members_read() { # <members-file> -> fills BM_*; non-zero when malformed
  BM_BASE=""; BM_COUNT=0
  BM_IX=(); BM_SLUG=(); BM_HEAD=(); BM_DH=(); BM_TIER=(); BM_NUM=()
  local line rest ix slug head dh tier num
  [ -r "$1" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "BATCH "*) rest="${line#BATCH }"; BM_BASE="${rest#* }" ;;
      "MEMBER "*)
        rest="${line#MEMBER }"
        IFS=$'\t' read -r ix slug head dh tier num <<< "$rest"
        [ -n "$ix" ] && [ -n "$slug" ] && [ -n "$head" ] || return 1
        BM_IX[BM_COUNT]="$ix"; BM_SLUG[BM_COUNT]="$slug"; BM_HEAD[BM_COUNT]="$head"
        BM_DH[BM_COUNT]="$dh"; BM_TIER[BM_COUNT]="$tier"; BM_NUM[BM_COUNT]="${num:-0}"
        BM_COUNT=$((BM_COUNT+1)) ;;
    esac
  done < "$1"
  [ "$BM_COUNT" -ge 1 ] || return 1
  [ -n "$BM_BASE" ] || BM_BASE="$($GIT -C "$BATCH_REPO" rev-parse origin/main 2>/dev/null)"
  [ -n "$BM_BASE" ]
}
batch_gate_verdict() { # <log> <rc> -> PASS | NO_VERDICT:<reason> | FAIL:<steps> | PARTIAL | OTHER
  if [ "$2" -eq 0 ] && grep -qx 'GATE_RESULT=PASS' "$1" 2>/dev/null; then echo PASS; return 0; fi
  # The gate refused to judge (exit 3, ENOSPC or another environment failure). That is not a
  # union failure to bisect and send back: its own arm, so a --union batch falls back to the
  # per-PR path instead of billing a member for the machine.
  if grep -q '^GATE_RESULT=NO_VERDICT' "$1" 2>/dev/null; then
    echo "NO_VERDICT:$(grep '^GATE_RESULT=NO_VERDICT' "$1" | head -1 | sed 's/^GATE_RESULT=NO_VERDICT:[[:space:]]*//')"
    return 0
  fi
  if grep -q '^GATE_RESULT=FAIL:' "$1" 2>/dev/null; then
    echo "FAIL:$(grep '^GATE_RESULT=FAIL:' "$1" | head -1 | sed 's/^GATE_RESULT=FAIL:[[:space:]]*//')"
    return 0
  fi
  grep -q '^GATE_RESULT=PARTIAL' "$1" 2>/dev/null && { echo PARTIAL; return 0; }
  echo OTHER
}
# A gate log whose first GATE_RESULT is NO_VERDICT is the machine refusing to judge (gate.sh
# exit 3: a failed probe write, or ENOSPC in a step's own log). The verifier skips the cycle —
# no sendback, no rework attempt — the way gate_lock_decision() skips contention. Prints the
# one-line reason; 0 only for a no-verdict log, so a red test still takes the FAIL path.
gate_no_verdict_reason() { # <log>
  local first
  [ -r "$1" ] || return 1
  first="$(grep '^GATE_RESULT' "$1" 2>/dev/null | head -1)"
  case "$first" in
    'GATE_RESULT=NO_VERDICT'*) printf '%s\n' "${first#GATE_RESULT=NO_VERDICT}" | sed 's/^:[[:space:]]*//'; return 0 ;;
  esac
  return 1
}
# Leave the cycle the way gate_lock_decision() does: say why, write nothing, spend nothing.
gate_no_verdict_skip() { # <pr> <slug> <reason>
  say "#$1 $2: gate could not judge ($3) — retry next cycle, no attempt burned"
  exit 0
}
batch_tree_equal() { # <repo> <tree-a> <tree-b> — the prefix proof's equality (dist is regenerated)
  [ "$2" = "$3" ] && return 0
  [ -n "$2" ] && [ -n "$3" ] || return 1
  $GIT -C "$1" diff --quiet "$2" "$3" -- . ':!web/dist/index.html' 2>/dev/null
}
batch_marker_put() { # <id> <record> <index> <slug> <head> <diffkey>
  local tree
  tree="$(awk -v i="$3" '$1=="tree" && $2==i {print $3}' "$2" 2>/dev/null)"
  [ -n "$tree" ] || return 1
  batch_marker_write "$STATE/merge/$4.batch" "$1" "$3" "$BM_BASE" "$5" "$6" "$tree"
  printf '%s PASS batch\n' "$5" > "$STATE/merge/$4.verified"
}
batch_needs_ceo() { # <id> <reason>
  printf -- '- %s batch %s: %s\n' "$(date '+%F %H:%M')" "$1" "$2" >> "$STATE/needs-ceo.md"
}
batch_one_enter() { # <pr-number> <slug> <head> — the ordinary verifier, or the recording seam
  local n="$1" slug="$2" head="$3" L rc=0
  if [ -n "$BATCH_ONE_CMD" ]; then
    bash -c "$BATCH_ONE_CMD" batch-one "$n" "$slug" "$head"
    return $?
  fi
  # This runner claimed every member's lock before its first gate; a later pass re-claims the
  # one --one released on exit, so a second pass lands a member whose sync deferred the landing.
  L="$STATE/merge/$slug.lock"
  mkdir -p "$L" 2>/dev/null || true
  echo $$ > "$L/pid" 2>/dev/null || true
  /bin/bash "$SELF" --one "$n" "$slug" "" >> "$RUNS/merge-worker-$slug.log" 2>&1 || rc=$?
  return $rc
}
batch_run_gate() { # <id> <worktree> <log> -> prints the verdict; one flake re-run, existing rule
  local id="$1" wt="$2" gl="$3" rc v
  if ! mklock "$STATE/.gate.lock" 1800; then echo LOCK; return 0; fi
  ( cd "$wt" && bash "$RSI_DIR/runtime/gate.sh" "$wt" ) > "$gl" 2>&1; rc=$?
  $GIT -C "$wt" checkout -q -- . 2>/dev/null
  rm -rf "$STATE/.gate.lock"
  v="$(batch_gate_verdict "$gl" "$rc")"
  [ "$v" = PASS ] && { echo PASS; return 0; }
  # A gate that could not judge is not a union failure: no retry, no bisect. Hand it back and
  # let batch_run's fallback re-enter each member, where the per-PR verifier skips the cycle.
  case "$v" in NO_VERDICT*) echo "$v"; return 0 ;; esac
  # The verifier's existing flake rule, once per batch: only failing tests outside the union's own
  # footprint (or known-flaky). A second failure is a real failure.
  if [ ! -e "$STATE/merge/$id.outside-retry" ] && outside_tests_only "$wt" "$gl" "" "$STATE/merge/$id.outside-reason.txt"; then
    touch "$STATE/merge/$id.outside-retry"
    say "batch $id: gate failed only on tests outside the union footprint (or known-flaky); rerunning once" >&2
    if mklock "$STATE/.gate.lock" 1800; then
      ( cd "$wt" && bash "$RSI_DIR/runtime/gate.sh" "$wt" ) > "$gl" 2>&1; rc=$?
      $GIT -C "$wt" checkout -q -- . 2>/dev/null
      rm -rf "$STATE/.gate.lock"
      v="$(batch_gate_verdict "$gl" "$rc")"
    fi
  fi
  echo "$v"
}
batch_land_members() { # <id> <record> — K_* arrays; re-enter --one and prove each landing
  local id="$1" rec="$2" k pass last cur landed_any kk
  last="$($GIT -C "$BATCH_REPO" rev-parse "$BM_BASE^{tree}" 2>/dev/null)"
  pass=1
  # A member whose main sync is carried defers its landing one cycle (the verifier's own rule);
  # a later pass in this runner lands it, so the prefix proof still covers every member that lands.
  while [ $pass -le 3 ]; do
    landed_any=0; k=0
    while [ $k -lt "$K_COUNT" ]; do
      if [ "${K_DONE[$k]:-0}" = 1 ]; then k=$((k+1)); continue; fi
      batch_one_enter "${K_NUM[$k]}" "${K_SLUG[$k]}" "${K_HEAD[$k]}"
      $GIT -C "$BATCH_REPO" fetch -q origin main 2>/dev/null
      cur="$($GIT -C "$BATCH_REPO" rev-parse origin/main^{tree} 2>/dev/null)"
      if [ -z "$cur" ] || batch_tree_equal "$BATCH_REPO" "$last" "$cur"; then
        [ -n "$cur" ] && last="$cur"     # nothing landed (CI pending, hold): the marker stays valid
        k=$((k+1)); continue
      fi
      if batch_prefix_check "$BATCH_REPO" "$rec" "${K_MIX[$k]}" "$cur"; then
        K_DONE[$k]=1; landed_any=1; last="$cur"
        say "batch $id: ${K_SLUG[$k]} landed; main matches union prefix ${K_MIX[$k]}"
      else
        say "batch $id: ${K_SLUG[$k]} landed but main does not match union prefix ${K_MIX[$k]}; stopping"
        batch_needs_ceo "$id" "landed tree for ${K_SLUG[$k]} does not match the gated union prefix ${K_MIX[$k]}; remaining members invalidated and not landed"
        kk=$((k+1))
        while [ $kk -lt "$K_COUNT" ]; do batch_invalidate "$STATE" "${K_SLUG[$kk]}"; kk=$((kk+1)); done
        return 1
      fi
      k=$((k+1))
    done
    [ $landed_any -eq 0 ] && break
    pass=$((pass+1))
  done
  return 0
}
batch_fall_back() { # <id> <reason> [skip-slug] — start today's single verifier for every member but skip-slug
  local id="$1" reason="$2" skip_slug="${3:-}" k=0
  say "batch $id: $reason — falling back to single verification"
  batch_invalidate "$STATE" ${BM_SLUG[@]+"${BM_SLUG[@]}"}
  while [ $k -lt "$BM_COUNT" ]; do
    # A member already sent back for rework is not re-entered: --one does not read the sendback
    # file, so entering it again would spend another gate on the head just rejected.
    [ "${BM_SLUG[$k]}" = "$skip_slug" ] || batch_one_enter "${BM_NUM[$k]}" "${BM_SLUG[$k]}" "${BM_HEAD[$k]}"
    k=$((k+1))
  done
}
batch_run() { # <id> <members-file>
  local id="$1" mf="$2" rec gl v step bout ncul chead cslug item det k ok rec2 gl2 v2
  batch_enabled || { say "batch $1: RSI_BATCH_VERIFY is off"; return 0; }
  batch_members_read "$mf" || { say "batch $1: malformed members file $mf"; return 1; }
  [ "$BM_COUNT" -ge 2 ] || { say "batch $1: fewer than two members"; return 1; }
  mkdir -p "$STATE/merge" "$RUNS" "$STATE/sendback" 2>/dev/null || true
  BATCH_WT="$STATE/merge/$id.work"; BATCH_BR="batch/union-$$"
  trap 'batch_cleanup' EXIT
  # Claim every member before the first gate: the dispatcher's loop skips these slugs, and the
  # claim is what stops a later dispatch cycle from paying a second gate for one of them. A live
  # lock on a member means a single verifier already owns it: abandon the batch rather than race.
  k=0
  while [ $k -lt "$BM_COUNT" ]; do
    L="$STATE/merge/${BM_SLUG[$k]}.lock"
    if [ -d "$L" ] && kill -0 "$(cat "$L/pid" 2>/dev/null || echo 0)" 2>/dev/null; then
      say "batch $id: ${BM_SLUG[$k]} is already being verified; abandoning the batch"
      return 1
    fi
    rm -rf "$L" 2>/dev/null
    mkdir -p "$L" 2>/dev/null && echo $$ > "$L/pid"
    k=$((k+1))
  done
  # The union needs every frozen head locally; fetch only the branch that is missing. A head that
  # is still missing is not ours to verify, and no member lands on a gate that never covered it.
  k=0
  while [ $k -lt "$BM_COUNT" ]; do
    if ! $GIT -C "$BATCH_REPO" cat-file -e "${BM_HEAD[$k]}^{commit}" 2>/dev/null; then
      $GIT -C "$BATCH_REPO" fetch -q origin "+refs/heads/rsi/${BM_SLUG[$k]}:refs/remotes/origin/rsi/${BM_SLUG[$k]}" 2>/dev/null
    fi
    if ! $GIT -C "$BATCH_REPO" cat-file -e "${BM_HEAD[$k]}^{commit}" 2>/dev/null; then
      say "batch $id: head ${BM_HEAD[$k]:0:8} (${BM_SLUG[$k]}) is not available"
      batch_fall_back "$id" "a member head is not available"
      return 1
    fi
    k=$((k+1))
  done
  rec="$STATE/merge/$id.record"
  if ! $GIT -C "$BATCH_REPO" worktree add -q --detach "$BATCH_WT" "$BM_BASE" 2>/dev/null; then
    say "batch $id: cannot create the union worktree"
    batch_fall_back "$id" "union worktree failed"
    return 1
  fi
  if ! batch_union "$BATCH_WT" "$BM_BASE" "$rec" ${BM_HEAD[@]+"${BM_HEAD[@]}"}; then
    say "batch $id: union conflict outside web/dist/index.html (never resolved here)"
    batch_fall_back "$id" "union conflict"
    return 1
  fi
  gl="$RUNS/batch-$id-gate.log"
  say "batch $id: one full gate on the union of $BM_COUNT members"
  v="$(batch_run_gate "$id" "$BATCH_WT" "$gl")"
  case "$v" in
    PASS)
      ok=1; k=0
      while [ $k -lt "$BM_COUNT" ]; do
        batch_marker_put "$id" "$rec" "${BM_IX[$k]}" "${BM_SLUG[$k]}" "${BM_HEAD[$k]}" "${BM_DH[$k]}" || ok=0
        K_SLUG[$k]="${BM_SLUG[$k]}"; K_HEAD[$k]="${BM_HEAD[$k]}"; K_NUM[$k]="${BM_NUM[$k]}"
        K_MIX[$k]="${BM_IX[$k]}"; K_DONE[$k]=0
        k=$((k+1))
      done
      K_COUNT="$BM_COUNT"
      if [ $ok -ne 1 ]; then batch_fall_back "$id" "a marker could not be written"; return 1; fi
      say "batch $id: union PASS; markers written, landing members in PR-number order"
      batch_land_members "$id" "$rec"
      return $?
      ;;
    FAIL:*)
      step="$(printf '%s' "${v#FAIL:}" | awk '{print $1}')"
      [ -n "$step" ] || step=check
      say "batch $id: union gate failed at step '$step'; bisecting"
      bout="$(batch_bisect "$BATCH_WT" "$BM_BASE" "$step" ${BM_HEAD[@]+"${BM_HEAD[@]}"})"
      # A bisect run that could not judge names no member: the machine failed, so no worker is
      # billed for it. Fall back to single verification, where each member's own cycle skips.
      if printf '%s\n' "$bout" | grep -q '^NO_VERDICT'; then
        batch_needs_ceo "$id" "union gate failed at '$step' and a bisect run could not judge (the machine, not a member); all members fall back to single verification"
        batch_fall_back "$id" "no-verdict bisect"
        return 1
      fi
      ncul="$(printf '%s\n' "$bout" | grep -c '^CULPRIT' || true)"
      if [ "${ncul:-0}" -ne 1 ]; then
        batch_needs_ceo "$id" "union gate failed at '$step' but no single member is attributable; all members fall back to single verification"
        batch_fall_back "$id" "non-attributable union failure"
        return 1
      fi
      chead="$(printf '%s\n' "$bout" | awk '/^CULPRIT/{print $2; exit}')"
      cslug=""
      k=0
      while [ $k -lt "$BM_COUNT" ]; do
        [ "${BM_HEAD[$k]}" = "$chead" ] && { cslug="${BM_SLUG[$k]}"; break; }
        k=$((k+1))
      done
      [ -n "$cslug" ] || { batch_fall_back "$id" "bisect named an unknown head"; return 1; }
      det="$STATE/merge/$id.culprit.txt"
      {
        echo "Batch union gate failed: $v"
        echo "Bisect of step '$step' attributes the failure to rsi/$cslug ($chead)."
        echo; echo "## $step log (union gate)"
        echo '```'
        awk -v s="--- $step" '$0==s{f=1} f' "$gl" 2>/dev/null | tail -c 4000
        echo '```'
      } > "$det"
      [ -s "$det" ] || tail -c 4000 "$gl" > "$det"
      batch_invalidate "$STATE" "$cslug"
      item="$(item_id "$cslug" "$(pr_body "$cslug")")"
      sendback "$cslug" "$item" "batch union gate failed: $step" "$det" "batch-gate" - \
        "bash rsi/runtime/gate.sh <union-worktree>"
      # Survivors: rebuild the union without the culprit and pay one more gate. Only a PASS there
      # writes their markers; anything else falls back so no survivor lands on the failed union.
      K_COUNT=0; k=0
      while [ $k -lt "$BM_COUNT" ]; do
        if [ "${BM_SLUG[$k]}" != "$cslug" ]; then
          K_SLUG[K_COUNT]="${BM_SLUG[$k]}"; K_HEAD[K_COUNT]="${BM_HEAD[$k]}"
          K_DH[K_COUNT]="${BM_DH[$k]}"; K_NUM[K_COUNT]="${BM_NUM[$k]}"; K_DONE[K_COUNT]=0
          K_COUNT=$((K_COUNT+1))
        fi
        k=$((k+1))
      done
      [ "$K_COUNT" -ge 1 ] || return 1
      rec2="$STATE/merge/$id.survivors.record"
      if ! batch_union "$BATCH_WT" "$BM_BASE" "$rec2" ${K_HEAD[@]+"${K_HEAD[@]}"}; then
        batch_needs_ceo "$id" "the surviving union conflicts outside web/dist/index.html after $cslug was sent back; survivors fall back to single verification"
        batch_fall_back "$id" "survivor union conflict" "$cslug"
        return 1
      fi
      gl2="$RUNS/batch-$id-gate-survivors.log"
      say "batch $id: one gate on the survivors' union (${K_COUNT} members)"
      v2="$(batch_run_gate "$id" "$BATCH_WT" "$gl2")"
      if [ "$v2" != PASS ]; then
        batch_needs_ceo "$id" "survivors still failed the union gate after $cslug was sent back ($v2); survivors fall back to single verification"
        batch_fall_back "$id" "survivor gate failed" "$cslug"
        return 1
      fi
      ok=1; k=0
      while [ $k -lt "$K_COUNT" ]; do
        batch_marker_put "$id" "$rec2" $((k+1)) "${K_SLUG[$k]}" "${K_HEAD[$k]}" "${K_DH[$k]:-}" || ok=0
        K_MIX[$k]=$((k+1))
        k=$((k+1))
      done
      if [ $ok -ne 1 ]; then batch_fall_back "$id" "a survivor marker could not be written" "$cslug"; return 1; fi
      say "batch $id: survivors' union PASS; markers written"
      batch_land_members "$id" "$rec2"
      return $?
      ;;
    *)
      batch_fall_back "$id" "the union gate produced no verdict ($v)"
      return 1
      ;;
  esac
}

# ------------------------------------------------------------------ re-verification accounting
reverify_reason() { # <prior-gate-sha> <prior-diff-key> <current-diff-key> <prior-reachable> <incoming> <carry-reason> [current-head]
  # Accounting only (retro 2026-11-20 §5.2): WHY a gate that already ran is paid for again. Writes
  # nothing and is read by no gate decision, lock or verdict — the gate-start line in step 4
  # appends its one word to state/merge/cycles.log, so a week of data says whether re-verification
  # is bought by shared surfaces moving or by rework, instead of tightening the carry rules on
  # intuition. <prior-reachable> is 1 only when the prior gate head is a proven ancestor of the
  # current head. Prints exactly one word:
  #   first-gate      no prior gate head: the denominator, not a re-verification
  #   land-sync       the head moved under an unchanged diff with no incoming paths: a main sync bought it
  #   rework          the PR's own code changed, the branch was rewritten, or nothing else moved
  #   shared-surface  main moved a surface every PR depends on, so every PR re-gates
  #   main-moved      main moved a path this PR does not verify, yet the gate ran again
  # An unknown current head (a six-argument caller) falls through to rework, never to land-sync.
  local prior_sha="$1" prior_key="$2" cur_key="$3" reachable="$4" incoming="$5" reason="$6" cur_head="${7:-}"
  if [ -z "$prior_sha" ]; then echo first-gate; return 0; fi
  # An empty prior key is not evidence: a missing review cache must fall through, not claim rework.
  if [ -n "$prior_key" ] && [ "$prior_key" != "$cur_key" ]; then echo rework; return 0; fi
  if [ "$reachable" = 0 ]; then echo rework; return 0; fi
  if [ -n "$incoming" ]; then
    case "$reason" in
      *"shared surface moved"*|*"the gate runs this script"*|*"the PR touches scripts/ or ui/"*)
        echo shared-surface ;;
      *) echo main-moved ;;
    esac
    return 0
  fi
  # The branch head moved under an unchanged PR diff and no path came in: the land loop merged
  # origin/main into the branch during a CI hold, so the gate is bought by that sync, not rework.
  # Only a known, unchanged key and a known, different head prove it; anything less fails closed.
  if [ -n "$prior_key" ] && [ "$prior_key" = "$cur_key" ] \
     && [ -n "$cur_head" ] && [ "$cur_head" != "$prior_sha" ]; then
    echo land-sync
    return 0
  fi
  echo rework
}

prior_gate_capture() { # <pr> <verified-file> <reviewed-file> <gate-head-file>
  # What the last cycle left behind, for the gate-start accounting line. The verified/reviewed PASS
  # lines are written only on a combined gate+review PASS, so a gate that FAILED (or passed while
  # the review failed) leaves none: fall back to the gate-head marker the gate-start block writes.
  # The marker is keyed by PR number so a reused slug cannot inherit a dead PR's head. Prints
  # "<prior-gate-sha> <prior-diff-key>"; either field may be empty (a true first gate).
  local n="$1" sha key
  sha="$(cut -d' ' -f1 "$2" 2>/dev/null)"
  key="$(cut -d' ' -f1 "$3" 2>/dev/null)"
  if [ "$(cut -d' ' -f1 "$4" 2>/dev/null)" = "$n" ]; then
    [ -n "$sha" ] || sha="$(cut -d' ' -f2 "$4" 2>/dev/null)"
    [ -n "$key" ] || key="$(cut -d' ' -f3 "$4" 2>/dev/null)"
  fi
  printf '%s %s\n' "$sha" "$key"
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
      CARRY|CARRY-UI|CARRY-RN|CARRY-UI-RN)
        ci_hold_window "$marker" || return 1
        CI_FIRST_KIND="hold-disjoint"
        CI_FIRST_REASON="main's new commits touch no path this PR verifies ($MOVE_TAG)"
        return 0 ;;
    esac
  fi
  CI_FIRST_REASON="CI is ${cis:-unknown} on ${hd:0:8}: the land path needs the main sync"
  return 1
}

# ------------------------------------------------------------------ CEO approval marker
# Only the CEO writes state/merge/<slug>.ceo-ok (same ownership rule as *.size-ok). One line, four
# fields in this order, recording the owner's approval of THIS PR so clearing the hold leaves a
# durable record of what was approved, where and when:
#   source=thread <id> · quote "<the owner's words>" · <YYYY-MM-DDTHH:MM±HH:MM> · pr <number>
# Every field must be present and non-empty; a placeholder source, a missing quote/time and a marker
# for another PR are all invalid, so the hold stays exactly as it was.
ceo_ok_last_field() { # <marker-file> -> the marker's last `·` field, trimmed
  local line
  line="$(sed -n '1p' "$1" | tr -d '\r' | sed -E 's/[[:space:]]+$//')"
  line="${line##*·}"
  printf '%s\n' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}
# MANDATE red line: dependencies, migrations, auth, and permission-boundary middleware.
# The two internal/api files are named explicitly: a broad internal/api/ prefix would also
# match the router, and ordinary page changes there must keep the normal gate.
redline_paths_core() { grep -qE '^(go\.mod|internal/store/.*migrat|.*migrations?/|internal/auth|internal/api/cors\.go$|internal/api/secure\.go$)' "$@"; }
redline_paths() { grep -qE '^ui/package\.json' "$@" || redline_paths_core "$@"; }

ceo_ok_verdict() { # <marker-file> <changed-paths-file> <pr> -> 0 clear, 1 hold, 2 not applicable
  # 2 = no deps/migrations/auth path changed; the marker never clears any other hold.
  local marker="$1" changed="$2" pr="$3" line src last
  CEO_OK_REASON=""
  [ -r "$changed" ] || return 2
  redline_paths "$changed" || return 2
  if [ ! -s "$marker" ]; then
    CEO_OK_REASON="no owner approval marker at $marker"
    return 1
  fi
  line="$(sed -n '1p' "$marker" | tr -d '\r' | sed -E 's/[[:space:]]+$//')"
  # 1. source= must name something real (not empty, not a TODO/unknown/<id> placeholder).
  case "$line" in
    source=*) src="${line#source=}"; src="${src%%·*}"; src="$(printf '%s' "$src" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')" ;;
    *) src="" ;;
  esac
  case " $src " in
    *" TODO "*|*" unknown "*|*" Unknown "*) src="" ;;
  esac
  case "$src" in *"<"*) src="" ;; esac
  if [ -z "$src" ]; then
    CEO_OK_REASON="the marker has no usable source= (missing, TODO, unknown or placeholder)"
    return 1
  fi
  # 2. quote="..." must carry the owner's own words.
  if ! printf '%s\n' "$line" | grep -qE 'quote[[:space:]]*=?"[^"]+"'; then
    CEO_OK_REASON="the marker has no quoted owner statement"
    return 1
  fi
  # 3. an ISO-8601 timestamp, offset optional.
  if [[ ! "$line" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2} ]]; then
    CEO_OK_REASON="the marker has no ISO-8601 timestamp"
    return 1
  fi
  # 4. the last field is `pr <N>`, and N is the PR being merged: a stale marker must not approve a
  #    later PR that reuses the slug.
  last="$(ceo_ok_last_field "$marker")"
  [ "$last" = "pr $pr" ] || { CEO_OK_REASON="the marker does not approve PR #$pr (last field: ${last:-none})"; return 1; }
  CEO_OK_REASON="source=$src quote=\"$(printf '%s\n' "$line" | sed -E 's/.*quote[[:space:]]*=?"([^"]+)".*/\1/')\""
  return 0
}

# Step 2's hold decision, kept apart from the worktree diff so the decision site itself is testable.
# 0 hold, 1 clear, 2 ui/package.json-only exemption for the Astryx F1-F3 slices; sets
# REDLINE_REASON. The marker branch prints the same line the inline block used to.
redline_hold_decision() { # <changed-paths-file> <slug> <item> <pr> -> 0 hold, 1 clear, 2 package-exemption
  local chf="$1" slug="$2" item="$3" pr="$4"
  REDLINE_REASON=""
  # A list that cannot be read (failed state write, concurrent cleanup) proves nothing: hold.
  [ -r "$chf" ] || { REDLINE_REASON="changed-path list unreadable: holding (fail closed)"; return 0; }
  redline_paths "$chf" || { REDLINE_REASON="no dependency, migration, auth or permission-boundary path changed"; return 1; }
  # Only the CEO writes state/merge/<slug>.ceo-ok (same ownership rule as *.size-ok): the owner's
  # approval of this exact PR, quoted. A valid marker clears this one hold; the gate and the
  # independent review still run, and a missing/invalid marker leaves today's hold intact.
  if ceo_ok_verdict "$STATE/merge/$slug.ceo-ok" "$chf" "$pr"; then
    REDLINE_REASON="CEO approval marker clears the deps/migrations/auth hold ($CEO_OK_REASON)"
    say "#$pr $slug: $REDLINE_REASON"
    return 1
  fi
  if printf '%s\n' "$item" | grep -qE '^F[123]$' && ! redline_paths_core "$chf"; then
    REDLINE_REASON="ui/package.json only: Astryx programme slice $item"
    return 2
  fi
  REDLINE_REASON="touches deps/migrations/auth or permission-boundary middleware (MANDATE: needs CEO + ADR)"
  return 0
}

# The same marker also releases the dispatcher's holds, not just the verifier's path check. A held PR
# writes <slug>.blocked and the dispatcher used to skip it forever, so the "next cycle merges" claim
# was false; the needs-ceo/hold labels are the same hold one step earlier (MANDATE red line 4).
# Both skips now consult this one rule, bound to the PR: the marker's last field must be `pr <N>`, so
# a stale marker on a reused slug cannot release a label (the verifier never re-validates the marker
# for a red-line PR with no deps/migrations/auth path). A .blocked written after the marker is a new
# hold — a re-block or a different hold — and outranks the approval; only an older block yields.
ceo_ok_clears_hold() { # <slug> <pr> -> 0 when the marker approves that exact PR
  local m="$STATE/merge/$1.ceo-ok"
  [ -s "$m" ] && [ -n "${2:-}" ] || return 1
  [ "$(ceo_ok_last_field "$m")" = "pr $2" ]
}
ceo_hold_skip() { # <slug> <labels-csv> <pr> -> 0 and a reason on stdout when the dispatcher must skip
  local slug="$1" ls=" $(printf '%s' "${2:-}" | tr ',' ' ') " pr="${3:-}" l
  for l in $ls; do case "$l" in hold|needs-ceo) ceo_ok_clears_hold "$slug" "$pr" || { echo "labelled hold (needs CEO)"; return 0; } ;; esac; done
  if [ -e "$STATE/merge/$slug.blocked" ] && { ! ceo_ok_clears_hold "$slug" "$pr" || ! [ "$STATE/merge/$slug.ceo-ok" -nt "$STATE/merge/$slug.blocked" ]; }; then
    echo "blocked (needs CEO)"; return 0
  fi
  return 1
}

# A UX walk that could not run writes <slug>.uxcooldown = <expiry_epoch> <dh> <reason> (merge.sh's
# gate bound and ux-gate.sh both). Nothing read it back, so the next dispatch started the same
# verifier again: the gate cache hit, the walk was unavailable again, and a general slot was spent
# every cycle on a PR that could not merge. Rest the row iff the cooldown is live AND names the
# diff the review cache holds. Every other shape — no .reviewed, an empty DH, a malformed line, a
# different DH — means the cooldown was written for a diff that no longer exists, so verify it:
# stranding a PR costs more than one wasted slot. Fail open.
#
# R-uxcooldown-hold adds one more reason to rest, for a cooldown that has EXPIRED on the same diff:
# while an open PR changes the walker spec (UX_SPEC_PATHS, the family ux_carry_key() digests), the
# walk this row would pay for is about to be re-derived against a different spec. #630 spent a
# 30-minute first walk and a 25-minute confirm walk re-proving J4 on the one heavy slot while #644
# (journeys.json) queued 33 minutes behind it, because the cooldown expired before #644 landed.
# The hold is bounded by RSI_UX_HOLD_MAX_MIN (default 180 minutes, 0 disables), never rests a PR
# against itself, and needs a readable `files` list — the light gh fallback has none, so it fails
# open to a verify.
UX_HOLD_MAX_MIN="${RSI_UX_HOLD_MAX_MIN:-180}"
case "$UX_HOLD_MAX_MIN" in ''|*[!0-9]*) UX_HOLD_MAX_MIN=180 ;; esac
UX_SPEC_MOVERS="${UX_SPEC_MOVERS:-}"   # per pass: one `<n>\t<slug>` line per open walker-spec PR
UX_COOLDOWN_MSG=""
ux_cooldown_skip() { # <slug> -> 0 and UX_COOLDOWN_MSG when the dispatcher must rest this PR
  local slug="$1" f exp dh reason revdh now hhmm mover
  f="$STATE/merge/$slug.uxcooldown"
  [ -s "$f" ] || return 1
  exp=""; dh=""; reason=""
  read -r exp dh reason < "$f" 2>/dev/null || true
  case "$exp" in ''|*[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  revdh="$(cut -d' ' -f1 "$STATE/merge/$slug.reviewed" 2>/dev/null)"
  # Both reasons rest only a marker that names the diff the review cache holds.
  [ -n "$dh" ] && [ "$dh" = "$revdh" ] || return 1
  if [ "$exp" -gt "$now" ]; then
    hhmm="$(date -r "$exp" +%H:%M 2>/dev/null || date -d "@$exp" +%H:%M 2>/dev/null || echo "epoch $exp")"
    UX_COOLDOWN_MSG="UX cooldown until $hhmm (dh ${dh:0:8}), skip"
    return 0
  fi
  # Expired on this diff: rest it while another open PR is about to move the walker spec, inside
  # the bound. UX_SPEC_MOVERS is sorted by PR number, so the first line that is not this PR is the
  # mover the message names; the rest still hold it.
  [ "$UX_HOLD_MAX_MIN" -gt 0 ] || return 1
  [ $((now - exp)) -lt $((UX_HOLD_MAX_MIN * 60)) ] || return 1
  mover="$(printf '%s\n' "$UX_SPEC_MOVERS" | awk -F'\t' -v s="$slug" '$1 ~ /^[0-9]+$/ && $2 != "" && $2 != s' | sort -n | head -1)"
  [ -n "$mover" ] || return 1
  UX_COOLDOWN_MSG="UX cooldown held for #${mover%%$'\t'*} ${mover#*$'\t'} (walker spec moves), skip"
  return 0
}

# Open, non-draft rsi/* PRs in this pass whose files touch the walker-spec family. Computed once
# per pass from the same `gh pr list` payload the dispatcher already fetched, so the loop, the
# batch path and the yield candidate set read one set. A payload without `files` (the light
# fallback query) or an unreadable one yields no movers: the hold stays off and every row verifies
# as today.
ux_spec_movers() { # <pr-json> -> one `<n>\t<slug>` line per mover, lowest number first
  printf '%s' "${1:-[]}" | UX_SPEC_PATHS="$UX_SPEC_PATHS" python3 -c '
import json, os, sys
spec = [p for p in os.environ.get("UX_SPEC_PATHS", "").split() if p]
try:
    prs = json.load(sys.stdin)
except Exception:
    prs = []
if not isinstance(prs, list): prs = []
movers = set()
for p in prs:
    if not isinstance(p, dict): continue
    n = p.get("number"); h = p.get("headRefName") or ""
    if not isinstance(n, int) or not h.startswith("rsi/") or p.get("isDraft"): continue
    files = p.get("files")
    if not isinstance(files, list): continue
    for f in files:
        path = f.get("path") if isinstance(f, dict) else f
        if isinstance(path, str) and any(path == s or path.startswith(s + "/") for s in spec):
            movers.add((n, h[4:])); break
for n, slug in sorted(movers):
    print("%d\t%s" % (n, slug))
'
}

# gh `pr list` JSON (number,headRefName,isDraft,labels,title,files,body) -> TSV rows for the dispatcher
# loop: number, slug, title, tier, labels. needs-ceo/hold is a CEO hold, not a permanent exclusion, so
# the labels travel with the row and ceo_hold_skip() applies it (a marker naming this PR releases it).
# The head/draft rule is rsi/runtime/pr_select.py, shared with common.sh's backpressure counter. The
# default therefore passes no labels — the hold rule fires one step later — while
# --candidate-labels applies it here, which is what the selection seam means by a candidate.
dispatch_rows() {
  STATE="$STATE" RSI_DIR="$RSI_DIR" TIERPY="$RSI_DIR/runtime/review-tier.py" \
    PR_SELECT_LABELS="${1:-}" python3 -c '
import json,sys,os,subprocess
sys.path.insert(0, os.path.join(os.environ["RSI_DIR"], "runtime"))
from item_marker import parse_item
from pr_select import is_candidate
st=os.environ["STATE"]; rows=[]
labels_here = os.environ.get("PR_SELECT_LABELS") == "--candidate-labels"
for p in json.load(sys.stdin):
    h=p["headRefName"]
    if not is_candidate(h, p["isDraft"], p["labels"] if labels_here else ()): continue
    slug=h[4:]; item=parse_item(p.get("body") or "")
    try: att=int(open("%s/merge/%s.attempts" % (st,slug)).read().strip() or 0)
    except Exception: att=0
    tier="large"
    try:
        if "files" not in p: raise ValueError("no files")
        out=subprocess.run(["python3",os.environ["TIERPY"],"--title",p["title"],"--item",item,"--attempts",str(att),"--gh-json","-"],input=json.dumps(p.get("files") or []),capture_output=True,text=True,timeout=20).stdout.split()
        tier=out[0] if out else "large"
    except Exception: pass
    try: queued=int(open("%s/merge/%s.queued_at" % (st,slug)).read().strip())
    except Exception: queued=sys.maxsize   # never queued: after waiting PRs, then by number
    rows.append((0 if tier=="small" else 1, queued, p["number"], slug, p["title"].replace("\t"," "), tier, ",".join(sorted(l["name"] for l in p["labels"]))))
for _,_,n,slug,title,tier,labs in sorted(rows):   # small-safe first, then longest-waiting, then PR number
    print("%d\t%s\t%s\t%s\t%s" % (n,slug,title,tier,labs))'
}

# ------------------------------------------------------------------ verifier slot picker
# One predicate, two callers: the dispatcher loop and --slot-select-check. MERGE_WORKERS general
# slots plus SMALL_SLOTS reserved. big/medium PRs use the general slots; small-safe PRs may use any
# free slot but never the last one a big PR could take, so neither starves. On top of that, a small
# that is about to take the LAST free general slot yields it to a big/medium PR that has already
# waited SLOT_YIELD_MIN minutes — but only when that big can actually start, so the reserved slot
# never sits idle. 2026-11-21: a docs typo fix arrived while #5xx waited 12m for the last slot,
# took it, and the big PR then queued behind a 20-30m verifier it had already outwaited.

# Slugs of the big/medium rows in a TSV row stream that this pass would actually try to start. A
# stale queued_at left by a PR that has since merged or closed must not make the reserved slot
# idle, so the yield only considers PRs that are still rows in this pass — and only rows the loop
# reaches slot_claim() for: an active lane, a pending sendback, a CEO hold or a large PR whose
# strong reviewer is unavailable still keeps its old .queued_at but never starts, so yielding to it
# would idle the reserved slot for as long as the hold or the sol-quota outage lasts. The predicates
# below are the loop's own, in its order, so the candidate set cannot drift from what it will start.
SLOT_ACTIVE=""; SLOT_BIG_ROWS=""
slot_big_rows() { # rows on stdin; SLOT_ACTIVE = this pass's lane slugs
  local n slug _title tier labels
  while IFS=$'\t' read -r n slug _title tier labels; do
    [ -z "$n" ] && continue
    [ "$tier" = small ] && continue
    printf '%s\n' "$SLOT_ACTIVE" | grep -qx "$slug" && continue
    [ -e "$STATE/sendback/$slug.md" ] && continue
    ceo_hold_skip "$slug" "$labels" "$n" >/dev/null && continue
    ux_cooldown_skip "$slug" && continue
    if [ "$tier" = large ] && [ "$(awk '{print $2}' "$STATE/merge/$slug.reviewed" 2>/dev/null)" != PASS ] \
       && [ ! -s "$STATE/merge/$slug.strong" ] \
       && python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1 < /dev/null; then continue; fi
    printf '%s\n' "$slug"
  done
}

# Count the live verifier locks and how many of them are big/medium (an absent .tier is a big).
slot_running() {
  local l rs; running=0; running_big=0
  for l in "$STATE"/merge/*.lock; do
    [ -d "$l" ] && kill -0 "$(cat "$l/pid" 2>/dev/null || echo 0)" 2>/dev/null || continue
    running=$((running+1)); rs="$(basename "$l" .lock)"
    [ "$(cat "$STATE/merge/$rs.tier" 2>/dev/null)" = small ] || running_big=$((running_big+1))
  done
}

# The oldest candidate big/medium PR that has waited SLOT_YIELD_MIN minutes and is not already
# running. Nothing on disk records a queued PR's tier until its verifier starts, so an absent
# .tier is a big — the dispatcher's own unknown = large default.
slot_waiting_big() { # -> 0 and SLOT_YIELD_SLUG/SLOT_YIELD_AGE when such a PR is waiting
  local f slug ts now best="" best_ts="" since
  now="$(date +%s)"
  for f in "$STATE"/merge/*.queued_at; do
    [ -f "$f" ] || continue
    slug="$(basename "$f" .queued_at)"
    printf '%s\n' "$SLOT_BIG_ROWS" | grep -qxF "$slug" || continue
    [ "$(cat "$STATE/merge/$slug.tier" 2>/dev/null)" = small ] && continue
    [ -d "$STATE/merge/$slug.lock" ] && kill -0 "$(cat "$STATE/merge/$slug.lock/pid" 2>/dev/null || echo 0)" 2>/dev/null && continue
    ts="$(cat "$f" 2>/dev/null)"; case "$ts" in ''|*[!0-9]*) continue ;; esac
    since=$(( (now - ts) / 60 ))
    [ "$since" -ge "$SLOT_YIELD_MIN" ] || continue
    if [ -z "$best" ] || [ "$ts" -lt "$best_ts" ]; then best="$slug"; best_ts="$ts"; fi
  done
  [ -n "$best" ] || return 1
  SLOT_YIELD_SLUG="$best"; SLOT_YIELD_AGE=$(( (now - best_ts) / 60 ))
}

# True when a small PR must give up the last free general slot: exactly one slot is left, a
# big/medium PR can start under the general-slot rule, and such a PR has waited long enough.
slot_yield_to_big() {
  SLOT_YIELD_SLUG=""; SLOT_YIELD_AGE=0
  [ "$SLOT_YIELD_MIN" -gt 0 ] || return 1
  [ "$running" -eq $((MERGE_WORKERS + SMALL_SLOTS - 1)) ] || return 1
  [ "$running_big" -lt "$MERGE_WORKERS" ] || return 1
  slot_waiting_big
}

# 0 = start, 1 = wait; sets SLOT_MSG to the dispatcher's one-line reason.
slot_claim() { # <tier>
  local tier="$1"; SLOT_MSG=""
  if [ "$tier" = small ]; then
    if [ $((running - running_big)) -ge $((MERGE_WORKERS + SMALL_SLOTS - 1)) ] || [ $running -ge $((MERGE_WORKERS + SMALL_SLOTS)) ]; then
      SLOT_MSG="[small]: small slots busy"; return 1
    fi
    if slot_yield_to_big; then
      SLOT_MSG="[small]: yields the last general slot to $SLOT_YIELD_SLUG (queued ${SLOT_YIELD_AGE}m)"; return 1
    fi
  else
    if [ "$running_big" -ge "$MERGE_WORKERS" ] || [ "$running" -ge $((MERGE_WORKERS + SMALL_SLOTS)) ]; then
      SLOT_MSG="[$tier]: all $MERGE_WORKERS general verifier slots busy"; return 1
    fi
  fi
  return 0
}

# ------------------------------------------------------------------ dispatcher: form one batch
# Called once before the per-PR start loop when RSI_BATCH_VERIFY=1. Every skip below is the loop's
# own rule (active lane, pending sendback, CEO hold, live lock); batch_plan then applies the
# formation rules (review PASS for its own diff, green CI, disjoint paths, no UX walk/shared risk,
# one non-small member). On success the members' locks are claimed here and BATCH_SLUGS names them,
# so the loop starts one `--batch` runner instead of one verifier per member. Off = never called.
BATCH_SLUGS=""; BATCH_ID=""
dispatch_try_batch() { # <pr-json> -> 0 and BATCH_SLUGS/BATCH_ID when a batch was started
  local prjson="$1" base mf pathsdir rows plan id members slugs s labels tier dh n slug head ci pf
  local t
  BATCH_SLUGS=""; BATCH_ID=""
  base="$($GIT -C "$RSI_CTRL" rev-parse origin/main 2>/dev/null || echo unknown)"
  mf="$STATE/merge/batch-manifest.$$"; pathsdir="$STATE/merge/batch-paths.$$"
  rows="$STATE/merge/batch-rows.$$"
  mkdir -p "$pathsdir" 2>/dev/null || return 1
  : > "$mf"
  python3 - "$prjson" "$pathsdir" <<'PY' > "$rows" 2>/dev/null || { rm -rf "$pathsdir" "$mf" "$rows"; return 1; }
import json, os, sys
prs = json.loads(sys.argv[1] or "[]")
outdir = sys.argv[2]
def ci(roll):
    state = "green"
    for c in roll or []:
        if "conclusion" in c or c.get("__typename") == "CheckRun":
            st = (c.get("status") or "").upper(); con = (c.get("conclusion") or "").upper()
            if st and st != "COMPLETED": state = "fail" if state == "fail" else "pending"
            elif con in ("FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"): state = "fail"
            elif con in ("CANCELLED",): state = "fail" if state == "fail" else "pending"
            elif con not in ("SUCCESS", "NEUTRAL", "SKIPPED", "STALE"): state = "fail" if state == "fail" else "pending"
        else:
            st = (c.get("state") or "").upper()
            if st in ("FAILURE", "ERROR"): state = "fail"
            elif st not in ("SUCCESS", "NEUTRAL"): state = "fail" if state == "fail" else "pending"
    return state
for p in prs:
    h = p.get("headRefName") or ""
    if not h.startswith("rsi/") or p.get("isDraft"): continue
    head = p.get("headRefOid") or ""
    if not head: continue
    pf = os.path.join(outdir, str(p["number"]) + ".paths")
    with open(pf, "w") as f:
        for x in p.get("files") or []:
            path = x.get("path") if isinstance(x, dict) else x
            if path: f.write(path + "\n")
    print("%s\t%s\t%s\t%s\t%s" % (p["number"], h[4:], head, ci(p.get("statusCheckRollup")), pf))
PY
  while IFS=$'\t' read -r n slug head ci pf; do
    [ -n "$n" ] || continue
    echo "$ACTIVE" | grep -qx "$slug" && continue
    [ -e "$STATE/sendback/$slug.md" ] && continue
    labels="$(printf '%s\n' "$PRS" | awk -F'\t' -v n="$n" '$1==n{print $5; exit}')"
    ceo_hold_skip "$slug" "$labels" "$n" >/dev/null && continue
    ux_cooldown_skip "$slug" && continue
    L="$STATE/merge/$slug.lock"
    if [ -d "$L" ] && kill -0 "$(cat "$L/pid" 2>/dev/null || echo 0)" 2>/dev/null; then continue; fi
    tier="$(printf '%s\n' "$PRS" | awk -F'\t' -v n="$n" '$1==n{print $4; exit}')"
    dh="$(cut -d' ' -f1 "$STATE/merge/$slug.reviewed" 2>/dev/null)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t-\t%s\n' "$n" "$slug" "$head" "$dh" "$tier" "$ci" "$pf" >> "$mf"
  done < "$rows"
  plan="$(batch_plan "$mf" "$STATE" "$base")" || { rm -rf "$pathsdir" "$mf" "$rows"; return 1; }
  id="$(printf '%s\n' "$plan" | awk '$1=="BATCH"{print $2; exit}')"
  slugs="$(printf '%s\n' "$plan" | awk '$1=="MEMBER"{print $3}' | paste -sd' ' -)"
  [ -n "$id" ] && [ -n "$slugs" ] || { rm -rf "$pathsdir" "$mf" "$rows"; return 1; }
  # BATCH_SLUGS makes the loop skip these PRs; the runner claims their locks before its first
  # gate, so a later dispatch cycle cannot pay a second gate for a member either.
  for s in $slugs; do
    t="$(printf '%s\n' "$plan" | awk -v s="$s" '$1=="MEMBER" && $3==s {print $6; exit}')"
    echo "${t:-medium}" > "$STATE/merge/$s.tier"
  done
  members="$STATE/merge/$id.members"
  printf '%s\n' "$plan" > "$members"
  if [ -n "${RSI_START_LOG:-}" ]; then
    echo "batch $id $slugs" >> "$RSI_START_LOG"
  else
    nohup /bin/bash "$SELF" --batch "$id" "$members" >> "$RUNS/merge-batch-$id.log" 2>&1 < /dev/null & disown 2>/dev/null || true
  fi
  say "batch $id: verifier started for $slugs"
  BATCH_SLUGS="$slugs"; BATCH_ID="$id"
  rm -rf "$pathsdir" "$mf" "$rows"
  return 0
}

# The CI-red short-circuit (step 3b). `gh pr checks` reports buckets computed from the head's
# statusCheckRollup; bucket=fail is a COMPLETED check whose conclusion is FAILURE. That verdict
# already decided what step 6's land loop reads, so the gate and the review must not run first —
# before this check, a PR whose CI went red during the gate still paid for both (#778's RN tsc
# failure sat red through a full gate and a strong review). Pending/cancelled/skipped are not
# verdicts; an unreadable checks list fails open to the gate exactly as before. The failing
# check names land in <slug>.ci.txt as the sendback's report file. Top-level (before the
# dispatcher `if`): the --one worker path and the --ci-early-red-check seam share this one
# function, so it must exist in both branches of the dispatcher.
ci_early_red() { # <pr> <slug> <ci-txt> -> 0 when a completed FAILURE exists on the PR head
  local n="$1" slug="$2" cif="$3" out fails
  out="$($GH pr checks "$n" --repo "$GH_REPO" --json name,bucket,link 2>&1)"
  echo "$out" | grep -qi 'no checks reported' && return 1
  fails="$(printf '%s\n' "$out" | python3 -c 'import json,sys
try: checks=json.load(sys.stdin)
except Exception: sys.exit(1)
print(" ".join(c.get("name","?") for c in checks if c.get("bucket")=="fail"))' 2>/dev/null)"
  [ -n "$fails" ] || return 1
  printf '%s\nfailing checks: %s\n' "$out" "$fails" > "$cif"
}

# ------------------------------------------------------------------ dispatcher
if [ "${1:-}" != "--one" ]; then
  [ "${1:-}" = "--resolve-generated" ] && { gen_resolve "${2:?worktree required}"; exit $?; }
  # Hermetic seam for rsi/runtime/tests/test-merge-sync-abort.sh: run exactly the sync_main() the
  # per-PR verifier runs, with the same TERM/HUP/INT handling. No lock, fetch, gh, gate, review or
  # dispatch; the worktree and its origin are temp repos and the dist build is stubbed.
  if [ "${1:-}" = "--sync-main" ]; then
    [ $# -ge 2 ] || { echo "usage: merge.sh --sync-main <worktree> [slug] [pr-number] [item]" >&2; exit 2; }
    WT="$2"; SLUG="${3:-test}"; N="${4:-0}"; ITEM="${5:-R-$SLUG}"; BR="rsi/$SLUG"
    trap 'abort_merge "${WT:-}" >/dev/null 2>&1 || true' EXIT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    trap 'exit 130' INT
    sync_main
    exit $?
  fi
  # Hermetic seam for rsi/runtime/tests/test-merge-ceo-ok.sh: the dispatcher's row filter on PR JSON
  # on stdin, so a needs-ceo/hold row is proven to reach the loop with its labels for ceo_hold_skip().
  if [ "${1:-}" = "--dispatch-rows-check" ]; then dispatch_rows; exit $?; fi
  # Hermetic seam for rsi/runtime/tests/test-merge-pr-select.sh: the merge lane's PR selection —
  # the same dispatch_rows() the loop calls — over gh `pr list` JSON on stdin, with the
  # needs-ceo/hold labels applied because a held PR is not a candidate. No gh, fetch or state write.
  if [ "${1:-}" = "--pr-select-check" ]; then dispatch_rows --candidate-labels; exit $?; fi
  # Hermetic seam for rsi/runtime/tests/test-merge-slot-priority.sh: the dispatcher's verifier
  # slot picker over the same TSV rows on stdin, the same live locks, .tier/.queued_at files and
  # yield candidates (the loop's pre-slot skips), and the same slot_claim() the loop calls. Prints
  # one START/SKIP line per row and simulates a start in memory. No gh, git, lane or dispatch call,
  # and no lock or .tier write. The spec-mover hold reads UX_SPEC_MOVERS from the environment:
  # this seam has no gh payload, so that is its test hook.
  if [ "${1:-}" = "--slot-select-check" ]; then
    SLOT_ROWS="$(cat)"
    SLOT_ACTIVE="$(python3 "$LANES_PY" slugs 2>/dev/null || true)"
    SLOT_BIG_ROWS="$(printf '%s\n' "$SLOT_ROWS" | slot_big_rows)"
    slot_running
    while IFS=$'\t' read -r n slug _title tier _labels; do
      [ -z "$n" ] && continue
      if slot_claim "$tier"; then
        printf 'START\t%s\t%s\n' "$n" "$slug"
        running=$((running+1)); [ "$tier" = small ] || running_big=$((running_big+1))
      else
        printf 'SKIP\t%s\t%s\t%s\n' "$n" "$slug" "$SLOT_MSG"
      fi
    done <<< "$SLOT_ROWS"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-claim-check.sh: the prose claim check on a throwaway
  # worktree and two files on disk, the same script the verifier runs. No state, lock, gh or model;
  # the exit code is the check's own (0 pass/not-applicable/waived, 1 failed).
  if [ "${1:-}" = "--claim-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --claim-check <worktree> <body-file> <changed-files-file>" >&2; exit 2; }
    python3 "$RSI_DIR/runtime/claim_check.py" "$2" "$3" "$4"; exit $?
  fi
  # Hermetic seam for rsi/runtime/tests/test-claim-check.sh: the same claim_check_gate() the
  # verifier calls, sendback included, against a temp control tree whose PR state stub says OPEN.
  # No lock, fetch, gate, review or dispatch.
  if [ "${1:-}" = "--claim-gate-check" ]; then
    [ $# -ge 7 ] || { echo "usage: merge.sh --claim-gate-check <pr-number> <slug> <item> <worktree> <body-file> <changed-files-file>" >&2; exit 2; }
    claim_check_gate "$2" "$3" "$4" "$5" "$6" "$7"; exit $?
  fi
  # Hermetic seam for rsi/runtime/tests/test-gap-log-guard.sh: the gap-log close rule on a
  # throwaway worktree and two files on disk, the same script the verifier runs. No state, lock,
  # gh or model; the exit code is the check's own (0 pass/not-applicable/waived, 1 failed).
  if [ "${1:-}" = "--gap-log-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --gap-log-check <worktree> <body-file> <changed-files-file>" >&2; exit 2; }
    python3 "$RSI_DIR/runtime/gap_log_check.py" "$2" "$3" "$4"; exit $?
  fi
  # Hermetic seam for rsi/runtime/tests/test-gap-log-guard.sh: the same gap_log_gate() the
  # verifier calls, sendback included, against a temp control tree whose PR state stub says OPEN.
  # No lock, fetch, gate, review or dispatch.
  if [ "${1:-}" = "--gap-log-gate-check" ]; then
    [ $# -ge 7 ] || { echo "usage: merge.sh --gap-log-gate-check <pr-number> <slug> <item> <worktree> <body-file> <changed-files-file>" >&2; exit 2; }
    gap_log_gate "$2" "$3" "$4" "$5" "$6" "$7"; exit $?
  fi
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
  # Hermetic seam for rsi/runtime/tests/test-gate-carry.sh: the pure re-verification classifier the
  # gate-start accounting line writes. No state, no lock, no gate, no dispatch — one word out.
  if [ "${1:-}" = "--reverify-reason-check" ]; then
    if [ $# -lt 7 ] || [ $# -gt 8 ]; then
      echo "usage: merge.sh --reverify-reason-check <prior-gate-sha> <prior-diff-key> <current-diff-key> <prior-reachable> <incoming> <carry-reason> [current-head]" >&2
      exit 2
    fi
    reverify_reason "$2" "$3" "$4" "$5" "$6" "$7" "${8:-}"; exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-gate-carry.sh: the same prior_gate_capture() step 1
  # reads the accounting inputs with, over files on disk. No state, lock, gate, review or dispatch.
  if [ "${1:-}" = "--prior-gate-check" ]; then
    [ $# -ge 5 ] || {
      echo "usage: merge.sh --prior-gate-check <pr> <verified-file> <reviewed-file> <gate-head-file>" >&2
      exit 2
    }
    prior_gate_capture "$2" "$3" "$4" "$5"; exit 0
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
  # Hermetic seam for rsi/runtime/tests/test-ci-early-red.sh: the same ci_early_red() step 3b
  # calls, with the checks read stubbed through RSI_GH. No lock, fetch, gate, review or dispatch.
  if [ "${1:-}" = "--ci-early-red-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --ci-early-red-check <pr> <slug> <ci-txt>" >&2; exit 2; }
    if ci_early_red "$2" "$3" "$4"; then echo "RED"; exit 0; fi
    echo "PROCEED"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-gate-lock-timeout.sh: the same mklock() and
  # gate_lock_decision() the gate body calls, against a state dir whose .gate.lock may be held
  # by a live pid or left stale by a dead one. No gh, fetch, gate, review or dispatch; the max
  # wait defaults to 0 so a held lock gives up on the first poll instead of waiting 1800 s.
  if [ "${1:-}" = "--gate-lock-check" ]; then
    [ $# -ge 4 ] && [ -n "$4" ] || { echo "usage: merge.sh --gate-lock-check <slug> <sha> <state-dir> [max-wait]" >&2; exit 2; }
    GLSLUG="$2"; GLSHA="$3"; GLSTATE="$4"
    if mklock "$GLSTATE/.gate.lock" "${5:-0}"; then
      rm -rf "$GLSTATE/.gate.lock"
      gate_lock_decision acquired "$GLSLUG" "$GLSHA" "$GLSTATE"; GLRC=$?
    else
      gate_lock_decision timeout "$GLSLUG" "$GLSHA" "$GLSTATE"; GLRC=$?
    fi
    [ $GLRC -eq 0 ] && { echo "SKIP $GATE_LOCK_REASON"; exit 0; }
    echo "GATE $GATE_LOCK_REASON"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-merge-gate-head.sh: the same gate_watched() and
  # gate_head_unwind() the gate body runs, over a stub gate command and a stubbed PR head
  # (RSI_PR_HEAD_CMD), with RSI_HEAD_POLL_SECS shortened. No lock acquisition, fetch, review,
  # dispatch or real gate.
  if [ "${1:-}" = "--gate-head-check" ]; then
    [ $# -ge 7 ] || { echo "usage: merge.sh --gate-head-check <pr> <sha> <state-dir> <slug> <gate-log> <gate-cmd...>" >&2; exit 2; }
    GHN="$2"; SHA="$3"; GHSTATE="$4"; GHSLUG="$5"; GHGL="$6"; shift 6
    REVPID="${RSI_TEST_REV_PID:-}"; [ -n "$REVPID" ] && CHILD="$REVPID"
    if gate_watched "$GHN" "$SHA" "$GHSTATE" "$GHSLUG" "$GHGL" "" "$@"; then
      echo "GATE $GATE_RC"; exit 0
    fi
    gate_head_unwind "$GHN" "$GHSLUG" "$GHSTATE" "$GATE_LIVE_HEAD"
    echo "SKIP $GATE_LIVE_HEAD"; exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-gate-no-verdict.sh: the same skip decision the
  # verifier applies to a gate log the gate refused to judge. No lock, fetch, gate, gh or review.
  if [ "${1:-}" = "--no-verdict-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --no-verdict-check <pr> <slug> <gate-log>" >&2; exit 2; }
    if NVR="$(gate_no_verdict_reason "$4")"; then
      echo "SKIP $NVR"
      gate_no_verdict_skip "$2" "$3" "$NVR"
    fi
    echo "JUDGE"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-merge-ceo-ok.sh: run the same ceo_ok_verdict() the hold
  # block calls, against a marker file, a changed-path list and a PR number. No lock, fetch, gh.
  if [ "${1:-}" = "--ceo-ok-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --ceo-ok-check <marker-file> <changed-paths-file> <pr-number>" >&2; exit 2; }
    ceo_ok_verdict "$2" "$3" "$4"; rc=$?
    case $rc in
      0) echo "CLEAR $CEO_OK_REASON"; exit 0 ;;
      1) echo "HOLD $CEO_OK_REASON"; exit 1 ;;
      *) echo "NOHOLD no deps/migrations/auth or permission-boundary path changed"; exit 0 ;;
    esac
  fi
  # Hermetic seam for rsi/runtime/tests/test-merge-ceo-ok.sh: run the same redline_hold_decision()
  # the step-2 hold block calls, against a changed-path list and a slug's marker. No lock, fetch,
  # gate, review, merge or dispatch; the decision's say line is dropped so the verdict is one line.
  if [ "${1:-}" = "--redline-hold-check" ]; then
    [ $# -ge 5 ] || { echo "usage: merge.sh --redline-hold-check <changed-paths-file> <slug> <item> <pr-number>" >&2; exit 2; }
    redline_hold_decision "$2" "$3" "$4" "$5" >/dev/null; rc=$?
    case $rc in
      0) echo "HOLD $REDLINE_REASON"; exit 1 ;;
      1) echo "CLEAR $REDLINE_REASON"; exit 0 ;;
      *) echo "EXEMPT $REDLINE_REASON"; exit 3 ;;
    esac
  fi
  # Hermetic seam for rsi/runtime/tests/test-merge-ceo-ok.sh: the dispatcher's CEO-hold skip — the
  # same ceo_hold_skip() the PR loop calls, so the exemption is proven at the call site's function.
  if [ "${1:-}" = "--ceo-hold-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --ceo-hold-check <slug> <labels-csv> <pr-number>" >&2; exit 2; }
    if r="$(ceo_hold_skip "$2" "${3:-}" "$4")"; then echo "SKIP $r"; exit 1; fi
    echo "ALLOW"; exit 0
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
  # Hermetic seam for rsi/runtime/tests/test-ux-carry-key.sh: print the carry key and the verdict
  # the UX-gate block reads, over temp repos on disk. No gh, fetch, gate, walk, review or dispatch.
  if [ "${1:-}" = "--ux-carry-key-check" ]; then
    # usage: merge.sh --ux-carry-key-check <worktree> <main-ref> [<uxverified-file> <pr-diff-hash>]
    [ $# -ge 3 ] || { echo "usage: merge.sh --ux-carry-key-check <worktree> <main-ref> [<uxverified-file> <pr-diff-hash>]" >&2; exit 2; }
    echo "KEY $(ux_carry_key "$2" "$3")"
    if ux_carry_verdict "$2" "$3" "${4:-}" "${5:-}"; then echo "CARRY $UX_CARRY_KEY"; exit 0; fi
    echo "REGATE $UX_CARRY_REASON"; exit 1
  fi
  # Hermetic seam for rsi/runtime/tests/test-loop-sendback-stale.sh: run the same sendback() the
  # land loop calls with a stubbed PR head. No lock, fetch, gate, review, merge or dispatch.
  if [ "${1:-}" = "--stale-check" ]; then
    SLUG="${2:?slug required}"; ITEM="${3:?item required}"; N="${4:?pr required}"
    SHA="${5-}"; DET="${6:?detail file required}"
    sendback "$SLUG" "$ITEM" "stale-check" "$DET" "test" - "bash rsi/runtime/tests/test-loop-sendback-stale.sh"
    exit 0
  fi
  # Hermetic seam for rsi/runtime/tests/test-loop-sendback-stale.sh: the same sendback() the land
  # loop calls, with the PR state stubbed. Sits before the PAUSE check like --stale-check.
  if [ "${1:-}" = "--closed-check" ]; then
    SLUG="${2:?slug required}"; ITEM="${3:?item required}"; N="${4-}"
    SHA="${5-}"; DET="${6:?detail file required}"
    sendback "$SLUG" "$ITEM" "closed-check" "$DET" "test" - "bash rsi/runtime/tests/test-loop-sendback-stale.sh"
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
  # Hermetic seam for rsi/runtime/tests/test-gate-no-verdict.sh: the one classifier a gate log
  # goes through in a --union batch, so a NO_VERDICT log is never read as FAIL. No gate, gh or lock.
  if [ "${1:-}" = "--batch-verdict-check" ]; then
    [ $# -ge 3 ] || { echo "usage: merge.sh --batch-verdict-check <log> <rc>" >&2; exit 2; }
    batch_gate_verdict "$2" "$3"; exit 0
  fi
  # Hermetic seams for rsi/runtime/tests/test-merge-batch.sh: the batch planner, union builder,
  # marker validity, prefix-tree proof and bisect, each callable alone. No gh, lock or dispatch.
  if [ "${1:-}" = "--batch-plan-check" ]; then
    [ $# -ge 4 ] || { echo "usage: merge.sh --batch-plan-check <manifest> <state> <base>" >&2; exit 2; }
    batch_plan "$2" "$3" "$4"; exit $?
  fi
  if [ "${1:-}" = "--batch-union-check" ]; then
    [ $# -ge 5 ] || { echo "usage: merge.sh --batch-union-check <repo> <base> <record> <head>..." >&2; exit 2; }
    BR="$2" BBASE="$3" BREC="$4"; shift 4
    batch_union "$BR" "$BBASE" "$BREC" "$@"; rc=$?
    [ $rc -eq 0 ] && echo "UNION $(awk '$1=="union"{print $2}' "$BREC")"
    exit $rc
  fi
  if [ "${1:-}" = "--batch-marker-check" ]; then
    [ $# -ge 7 ] || { echo "usage: merge.sh --batch-marker-check <marker> <batch> <index> <head> <diffkey> <now> [max-age] [member-state]" >&2; exit 2; }
    batch_marker_valid "$2" "$3" "$4" "$5" "$6" "$7" "${8:-}" "${9:-}"; exit $?
  fi
  if [ "${1:-}" = "--batch-prefix-check" ]; then
    [ $# -ge 5 ] || { echo "usage: merge.sh --batch-prefix-check <repo> <record> <index> <main-tree>" >&2; exit 2; }
    if batch_prefix_check "$2" "$3" "$4" "$5"; then echo PREFIX-OK; exit 0; else echo PREFIX-MISMATCH; exit 1; fi
  fi
  if [ "${1:-}" = "--batch-bisect-check" ]; then
    [ $# -ge 5 ] || { echo "usage: merge.sh --batch-bisect-check <repo> <base> <step> <head>..." >&2; exit 2; }
    BR="$2" BBASE="$3" BSTEP="$4"; shift 4
    batch_bisect "$BR" "$BBASE" "$BSTEP" "$@"; exit 0
  fi
  if [ "${1:-}" = "--batch-invalidate-check" ]; then
    [ $# -ge 3 ] || { echo "usage: merge.sh --batch-invalidate-check <state> <slug>..." >&2; exit 2; }
    BSTATE="$2"; shift 2
    batch_invalidate "$BSTATE" "$@"; exit 0
  fi
  # The live half: one full gate on the union of the members file, then ordered re-entry into
  # --one with a prefix-tree proof per landing. No dispatch lock; the gate lock is taken inside.
  if [ "${1:-}" = "--batch" ]; then
    [ $# -ge 3 ] || { echo "usage: merge.sh --batch <id> <members-file>" >&2; exit 2; }
    batch_run "$2" "$3"; exit $?
  fi
  # Hermetic seam for rsi/runtime/tests/test-record-merged.sh: the merge-success delivery record —
  # bounded metadata attempts under a process-tree deadline, then one durable pending row — with
  # RSI_GH stubbed. No worktree, gate, lock or dispatch. Exit 2 means neither the append nor the
  # queue landed, so the caller must keep (or drain) the pre-merge intent instead of promising a
  # retry that has no file behind it.
  if [ "${1:-}" = "--record-merged-check" ]; then
    [ $# -ge 6 ] || { echo "usage: merge.sh --record-merged-check <state> <pr> <slug> <item> <url>" >&2; exit 2; }
    STATE="$2"
    MSHA="$(record_delivery "$3" "$4" "$5" "$6")"; rrc=$?
    case "$rrc" in
      0) echo "RECORDED $MSHA"; exit 0 ;;
      1) echo "PENDING"; exit 0 ;;
      *) echo "UNPERSISTED"; exit 2 ;;
    esac
  fi
  DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
  [ -e "$STATE/PAUSE" ] && { echo "paused"; exit 0; }
  # legacy single-instance lock (pre-pipeline merge.sh still running): do not double-process
  old="$(cat "$STATE/.merge.lock/pid" 2>/dev/null || true)"; [ -n "$old" ] && kill -0 "$old" 2>/dev/null && { echo "legacy merge lane still running (pid $old)"; exit 0; }
  DL="$STATE/.dispatch.lock"
  if ! mkdir "$DL" 2>/dev/null; then o="$(cat "$DL/pid" 2>/dev/null || true)"; if [ -n "$o" ] && kill -0 "$o" 2>/dev/null; then exit 0; fi; rm -rf "$DL"; mkdir "$DL" 2>/dev/null || exit 0; fi
  echo $$ > "$DL/pid"; trap 'rm -rf "$DL"' EXIT
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  # A delivery record queued by an earlier merge (commit metadata unavailable then) is retried
  # before the open-PR list: the merged PR is closed, so nothing else in the tick brings it back.
  drain_pending_records
  # `files` makes the GraphQL query heavy and it occasionally fails/times out: retry once, then fall back to a light query (tier unknown = large).
  # With the batch switch on, the same call also carries the head and CI rollup the formation reads.
  PRFIELDS="number,headRefName,isDraft,labels,title,files,body"
  batch_enabled && PRFIELDS="$PRFIELDS,headRefOid,statusCheckRollup"
  # Test seam (rsi/runtime/tests/test-merge-batch.sh): the dispatcher's own loop, driven by fixture
  # JSON, with the start below recorded instead of launched. Unset = the real gh call.
  if [ -n "${RSI_PR_LIST_CMD:-}" ]; then
    PRJ="$(bash -c "$RSI_PR_LIST_CMD" pr-list 2>/dev/null)"
  else
    PRJ="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json "$PRFIELDS" 2>/dev/null)"
    echo "$PRJ" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 || { sleep 3; PRJ="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json "$PRFIELDS" 2>/dev/null)"; }
    echo "$PRJ" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 || PRJ="$($GH pr list --repo "$GH_REPO" --state open --limit 50 --json number,headRefName,isDraft,labels,title,body 2>/dev/null)"
  fi
  PRS="$(printf '%s' "$PRJ" | dispatch_rows)"
  UNSEEN="$(printf '%s' "$PRJ" | python3 "$RSI_DIR/runtime/unseen-pr.py" --rows "$PRS" --state "$STATE" 2>/dev/null || true)"
  [ -n "$UNSEEN" ] && while IFS= read -r l; do [ -n "$l" ] && say "$l"; done <<< "$UNSEEN"
  [ -z "$PRS" ] && { say "no open rsi PRs"; exit 0; }
  ACTIVE="$(python3 "$LANES_PY" slugs)"
  # The walker-spec movers, once per pass, from the same payload the loop and the batch read. Set
  # before both so the loop, the batch path and the yield candidate set cannot disagree.
  UX_SPEC_MOVERS="$(ux_spec_movers "$PRJ")"
  # One gate for ready disjoint PRs (RSI_BATCH_VERIFY=1): form and start the batch runner before
  # the loop claims slots, so the batched slugs are started once, by the runner, not as singles.
  { batch_enabled && [ $DRY -eq 0 ]; } && dispatch_try_batch "$PRJ"
  SLOT_ACTIVE="$ACTIVE"
  SLOT_BIG_ROWS="$(printf '%s\n' "$PRS" | slot_big_rows)"
  slot_running
  while IFS=$'\t' read -r -u 3 N SLUG TITLE TIER LABELS; do
    [ -z "$N" ] && continue
    if [ -n "$BATCH_SLUGS" ] && printf ' %s ' "$BATCH_SLUGS" | grep -q " $SLUG "; then say "#$N $SLUG: in batch $BATCH_ID, skip"; continue; fi
    echo "$ACTIVE" | grep -qx "$SLUG" && { say "#$N $SLUG: lane active, skip"; continue; }
    [ -e "$STATE/sendback/$SLUG.md" ] && { rework_wait "$N" "$SLUG" "$STATE"; continue; }
    if r="$(ceo_hold_skip "$SLUG" "$LABELS" "$N")"; then say "#$N $SLUG: $r"; continue; fi
    # Rest a PR whose UX walk is cooling down on this same diff: it cannot merge this cycle, and
    # starting it again would only burn a general slot. A changed diff falls through; a cooldown
    # that expired recently also rests while an open PR moves the walker spec (the hold). The
    # .queued_at write below is skipped so a rested PR accrues no wait.
    if ux_cooldown_skip "$SLUG"; then say "#$N $SLUG: $UX_COOLDOWN_MSG"; continue; fi
    L="$STATE/merge/$SLUG.lock"
    if [ -d "$L" ]; then if kill -0 "$(cat "$L/pid" 2>/dev/null || echo 0)" 2>/dev/null; then continue; fi; rm -rf "$L"; fi
    # sol (ChatGPT allowance) exhausted: large-tier reviews need it and would only loop on 429. Wait for it;
    # small/medium (DeepSeek) PRs are unaffected. If a strong review for some head SHA is already on disk, start
    # the verifier anyway — it will reuse that verdict when HEAD is unchanged, and hold internally if HEAD moved.
    if [ "$TIER" = large ] && [ "$(awk '{print $2}' "$STATE/merge/$SLUG.reviewed" 2>/dev/null)" != PASS ] && [ ! -s "$STATE/merge/$SLUG.strong" ] && python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1; then
      say "#$N $SLUG [large]: waiting for a strong reviewer (Hydrogen/sol quota)"; continue; fi
    [ -e "$STATE/merge/$SLUG.queued_at" ] || date +%s > "$STATE/merge/$SLUG.queued_at"   # first time it was eligible: queue-wait metric
    # The slot picker is slot_claim(), shared with --slot-select-check so the seam and the live
    # picker cannot disagree. SLOT_MSG carries the one-line reason.
    if ! slot_claim "$TIER"; then say "#$N $SLUG $SLOT_MSG"; continue; fi
    [ $DRY -eq 1 ] && { say "#$N $SLUG: would verify (dry-run)"; running=$((running+1)); continue; }
    mkdir "$L" 2>/dev/null || continue; echo $$ > "$L/pid"   # claimed; the worker rewrites its own pid
    echo "$TIER" > "$STATE/merge/$SLUG.tier"; [ "$TIER" = small ] || running_big=$((running_big+1))
    if [ -n "${RSI_START_LOG:-}" ]; then
      echo "one $N $SLUG" >> "$RSI_START_LOG"; SPID=$$
    else
      nohup /bin/bash "$SELF" --one "$N" "$SLUG" "$TITLE" >> "$RUNS/merge-worker-$SLUG.log" 2>&1 < /dev/null & SPID=$!; disown 2>/dev/null || true
    fi
    echo "$SPID" > "$L/pid"
    say "#$N $SLUG: verifier started (pid $SPID)"; running=$((running+1)); sleep 1
  done 3<<< "$PRS"
  exit 0
fi

# ------------------------------------------------------------------ per-PR verifier
N="$2"; SLUG="$3"; TITLE="${4:-}"
L="$STATE/merge/$SLUG.lock"; echo $$ > "$L/pid"; T0=$(date +%s)
CHILD=""; KICK=""
cleanup() { [ -n "$CHILD" ] && kill $CHILD 2>/dev/null
  # A verifier that exits — the TERM/HUP/INT traps below, or any other path — must not leave the
  # worktree mid-merge: abort before the lock is released, so the next gate/review never reads an
  # old HEAD over a dirty index. Abort only (never reset --hard): the lane's uncommitted work stays.
  if ! abort_merge "${WT:-}"; then
    printf -- '- %s PR rsi/%s: verifier exited with a merge still in progress in %s and git merge --abort failed\n' \
      "$(date '+%F %H:%M')" "$SLUG" "${WT:-?}" >> "$STATE/needs-ceo.md" 2>/dev/null || true
  fi
  rm -rf "$L"
  # a sendback or a merge changes what the lanes should do (fill pulse) and what the next PR needs (re-sync): kick both
  if [ -n "$KICK" ]; then
    nohup /bin/bash "$RSI_DIR/runtime/run.sh" pulse >> "$RUNS/launchd-pulse.log" 2>&1 < /dev/null &
    nohup /bin/bash "$SELF" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null &
  fi; }
trap cleanup EXIT
# A signal mid-sync exits through the EXIT trap, which aborts the in-flight merge before the lock
# is released. Without this a killed verifier left MERGE_HEAD and the sync's staged files behind.
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
[ -e "$STATE/PAUSE" ] && exit 0
BR="rsi/$SLUG"; WT="$WT_ROOT/rsi-$SLUG"; PRURL="https://github.com/$GH_REPO/pull/$N"
BODY="$($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null)"; BODY_RC=$?
ITEM="$(item_id "$SLUG" "$BODY")"
V="$STATE/merge/$SLUG.verified"; RV="$STATE/merge/$SLUG.reviewed"; PREV="$STATE/merge/$SLUG.review.txt"
QW=""; if [ -s "$STATE/merge/$SLUG.queued_at" ]; then QW=" queue_wait=$(( (T0 - $(cat "$STATE/merge/$SLUG.queued_at")) / 60 ))m"; rm -f "$STATE/merge/$SLUG.queued_at"; fi
say "#$N $SLUG ($ITEM) verifier start$QW"; [ -n "$QW" ] && echo "$(date '+%F %H:%M') #$N $SLUG verifier_started$QW tier=$(cat "$STATE/merge/$SLUG.tier" 2>/dev/null || echo ?)" >> "$STATE/merge/cycles.log"

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
outside_tests_only() { # worktree log [summary] [reason-file] — writes the reason file
  local wt="$1" log="$2" sum="${3:-}" reason="${4:-$STATE/merge/$SLUG.outside-reason.txt}"
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
# The prior cycle's gate head and review key, captured before queue_carry_step rewrites or removes
# them: the gate-start accounting line needs what the last cycle left behind to say why this head
# has no PASS. The PASS lines exist only after a combined gate+review PASS, so a gate that FAILED
# (or passed while the review failed) leaves none: prior_gate_capture falls back to the gate-head
# marker the gate-start block writes. Empty is normal (a true first gate).
PRIOR_CAPTURE="$(prior_gate_capture "$N" "$V" "$RV" "$STATE/merge/$SLUG.gate-head")"
PRIOR_GATE_SHA="${PRIOR_CAPTURE%% *}"; PRIOR_DIFF_KEY="${PRIOR_CAPTURE#* }"
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
# Was the prior gate head an ancestor of this head? 1 only when proven, so a rewritten branch or an
# unknown/unreadable sha stays 0 and is never mistaken for a carry candidate.
PRIOR_REACHABLE=0
[ -n "$PRIOR_GATE_SHA" ] && $GIT -C "$WT" merge-base --is-ancestor "$PRIOR_GATE_SHA" "$SHA" 2>/dev/null && PRIOR_REACHABLE=1

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
# The one formula producers and this lane share (runtime/diff-size.sh): lane.sh and ingest-nas.sh
# stop the same oversized diff before it ever costs a gate slot or a sendback round.
SIZE="$(GIT="$GIT" bash "$RSI_DIR/runtime/diff-size.sh" "$WT")"
# CEO 2026-11-16 EMPTY-DELIVERY: a PR whose tree equals main delivers nothing; never merge it.
if [ "$SIZE" = 0 ] && $GIT -C "$WT" diff --quiet origin/main HEAD; then
  say "#$N $SLUG: EMPTY delivery (tree == origin/main), not merging"
  python3 "$LANES_PY" cloud-release "$SLUG" >/dev/null 2>&1 || true
  [ -e "$STATE/merge/$SLUG.empty" ] || printf -- '- %s PR #%s rsi/%s is empty (tree == main); not merged — close it\n' "$(date '+%F %H:%M')" "$N" "$SLUG" >> "$STATE/needs-ceo.md"
  echo "$N" > "$STATE/merge/$SLUG.empty"; exit 0
fi
HOLD=""
CHF="$STATE/merge/$SLUG.changed-paths"
printf '%s\n' "$CH" > "$CHF"
redline_hold_decision "$CHF" "$SLUG" "$ITEM" "$N"; RL=$?
rm -f "$CHF"
case $RL in
  0) HOLD="$REDLINE_REASON" ;;
  # CEO 2026-11-15 (Ethan: Astryx overhaul approved): the Astryx foundation slices F1-F3 may change
  # ui/package.json, but only for the programme's packages. Anything else in package.json (or
  # go.mod/migrations/auth) still holds for the CEO.
  2) BAD="$( ( $GIT -C "$WT" diff -U0 origin/main...HEAD -- ui/package.json | python3 -c '
import re,sys
ok=re.compile(r"^(react|react-dom|@types/react|@types/react-dom|tailwindcss|@tailwindcss/.*|postcss|autoprefixer|@astryxdesign/.*|@stylexjs/.*)$")
bad=[]
for l in sys.stdin:
    m=re.match(r"^[+-]\s*\"([^\"]+)\"\s*:\s*\"[^\"]*\",?\s*$", l)
    if m and not l.startswith(("+++","---")) and not ok.match(m.group(1)) and m.group(1) not in ("version","name","description"):
        bad.append(m.group(1))
print(" ".join(sorted(set(bad))))') )"
  [ -z "$BAD" ] && HOLD="" || HOLD="package.json change outside the Astryx programme packages: $BAD"
  ;;
esac
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

# 3. MANDATE 5 screenshots (cheap, before spending a gate/review): one predicate for ui/src and
# the phone client, fed the changed paths, the PR body and the local shots dir. An RN-only
# screen change is obliged too, and may not waive itself as "not visible"
# (rn-approval-dock, 2026-11-28).
SHOT_PATHS="$STATE/merge/$SLUG.shot-paths"; SHOT_BODY="$STATE/merge/$SLUG.shot-body"
printf '%s\n' "$CH" > "$SHOT_PATHS"; printf '%s\n' "$BODY" > "$SHOT_BODY"
SHOT_VERDICT="$(bash "$RSI_DIR/runtime/screenshots-obligation.sh" "$SHOT_PATHS" "$SHOT_BODY" "$STATE/shots/$SLUG" 2>&1)"; SHOT_RC=$?
rm -f "$SHOT_PATHS" "$SHOT_BODY"
if [ "$SHOT_RC" -ne 0 ]; then
  printf '%s\n' "${SHOT_VERDICT#SHOTS_FAIL: }" > "$STATE/merge/$SLUG.err"
  sendback "$SLUG" "$ITEM" "missing screenshots" "$STATE/merge/$SLUG.err" "hold-screenshots" - -; exit 0
fi
# 3b. CI already concluded red on this head: send back before paying for a serialised gate and a
# strong review — the verdict step 6 reads is already decided. ci_early_red fails open on a
# pending/cancelled/unreadable rollup, so only a completed FAILURE reaches the sendback.
if ci_early_red "$N" "$SLUG" "$STATE/merge/$SLUG.ci.txt"; then
  say "#$N $SLUG: CI already red on ${SHA:0:8} — sending back before the gate and review run"
  sendback "$SLUG" "$ITEM" "CI failed" "$STATE/merge/$SLUG.ci.txt" "ci" - "gh pr checks $N --repo $GH_REPO"
  exit 0
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
# The prose claim check, before the reviewer is paid for (R-latency-fix). CH was taken at step 1
# from origin/main...HEAD, so it is the PR's own diff, and BODY is the live PR body the check
# reads. A cached review (NEED_REV=0) skips this on purpose: a rework's re-review is not asked to
# re-prove a sentence the gate already ran on this diff.
if [ $NEED_REV -eq 1 ]; then
  if [ "$BODY_RC" -eq 0 ]; then
    CLAIM_BODY="$STATE/merge/$SLUG.body"; CLAIM_PATHS="$STATE/merge/$SLUG.changed"
    printf '%s\n' "$BODY" > "$CLAIM_BODY"; printf '%s\n' "$CH" > "$CLAIM_PATHS"
    claim_check_gate "$N" "$SLUG" "$ITEM" "$WT" "$CLAIM_BODY" "$CLAIM_PATHS"; CLAIM_RC=$?
    if [ $CLAIM_RC -eq 0 ]; then
      # The gap-log close guard (R-gap-log-close-guard), the same rule shape as the claim check:
      # a PR that touches a path an ## Open gap-log entry cites closes the entry in this same PR
      # or waives the citation in one sentence, before the reviewer is paid for.
      gap_log_gate "$N" "$SLUG" "$ITEM" "$WT" "$CLAIM_BODY" "$CLAIM_PATHS"; CLAIM_RC=$?
    fi
    rm -f "$CLAIM_BODY" "$CLAIM_PATHS"
    [ $CLAIM_RC -ne 0 ] && exit 0
  else
    # An unreadable body is not evidence of a missing claim: a transient gh failure would
    # otherwise bounce a prose PR mechanically. Fail open; the next cycle re-reads the body.
    say "#$N $SLUG: claim check skipped (PR body unreadable); the next cycle re-reads it"
  fi
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
  # The retrospective's accounting line (2026-11-20 §5.2): record WHY this gate is paid for, before
  # the lock, so a FAIL or a lock timeout still counts. Deliberately not folded into the verify=
  # line at the bottom: that one is never written on a FAIL and would bias the data to cheap passes.
  RR="$(reverify_reason "$PRIOR_GATE_SHA" "$PRIOR_DIFF_KEY" "$DH" "$PRIOR_REACHABLE" "$QUEUE_INCOMING" "${QUEUE_CARRY_REASON:-}" "$SHA")"
  echo "$(date '+%F %H:%M') #$N $SLUG reverify_reason=$RR" >> "$STATE/merge/cycles.log"
  # The head and diff key this gate is about to run on: a FAIL writes no verified/reviewed PASS line,
  # so the next cycle's accounting reads them from here (prior_gate_capture).
  printf '%s %s %s\n' "$N" "$SHA" "$DH" > "$STATE/merge/$SLUG.gate-head"
  say "#$N $SLUG: gate on ${SHA:0:8} ($SIZE lines)"
  if mklock "$STATE/.gate.lock" 1800; then
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
    if gate_watched "$N" "$SHA" "$STATE" "$SLUG" "$GL" "$WT" env RSI_DIST_BUILT_SHA="$BUILT_SHA" bash "$RSI_DIR/runtime/gate.sh" "$WT"; then
      GRC=$GATE_RC; rm -rf "$STATE/.gate.lock"
      $GIT -C "$WT" checkout -q -- . 2>/dev/null   # drop build leftovers (tracked files only) in our own rsi worktree
    else
      # The PR head moved while the gate ran: the gate's verdict would be about a SHA nobody can
      # merge. Kill the tree (gate_watched did), drop the leftovers, skip the cycle.
      $GIT -C "$WT" checkout -q -- . 2>/dev/null
      gate_head_unwind "$N" "$SLUG" "$STATE" "$GATE_LIVE_HEAD"; exit 0
    fi
    # Mechanical failure (format only): format the changed files, commit, push, re-gate ONCE. Not a sendback, not a rework round.
    if [ $GRC -ne 0 ] && [ "$(grep '^GATE_RESULT' "$GL" | head -1 | sed 's/.*FAIL: *//; s/ *$//')" = prettier ] && [ ! -e "$STATE/merge/$SLUG.autoformatted.$SHA" ]; then
      touch "$STATE/merge/$SLUG.autoformatted.$SHA"; say "#$N $SLUG: gate failed on prettier only -> auto-format, push, re-gate (mechanical)"
      if bash "$RSI_DIR/runtime/format-changed.sh" --write --commit --check "$WT" >> "$GL.fmt" 2>&1 && with_timeout 120 "$GIT" -C "$WT" push -q origin "HEAD:$BR" 2>/dev/null; then
        SHA="$($GIT -C "$WT" rev-parse HEAD)"; GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"
        if mklock "$STATE/.gate.lock" 1800; then
          if gate_watched "$N" "$SHA" "$STATE" "$SLUG" "$GL" "$WT" bash "$RSI_DIR/runtime/gate.sh" "$WT"; then
            GRC=$GATE_RC; rm -rf "$STATE/.gate.lock"; $GIT -C "$WT" checkout -q -- . 2>/dev/null
          else
            $GIT -C "$WT" checkout -q -- . 2>/dev/null
            gate_head_unwind "$N" "$SLUG" "$STATE" "$GATE_LIVE_HEAD"; exit 0
          fi
        else
          gate_lock_decision timeout "$SLUG" "$SHA" "$STATE"
          say "#$N $SLUG: $GATE_LOCK_REASON (re-gate after auto-format); skipping this cycle"
          exit 0
        fi
      fi
    fi
    GATE_OUTSIDE=0
    if [ $GRC -ne 0 ] || ! grep -q '^GATE_RESULT=PASS' "$GL"; then
      if outside_tests_only "$WT" "$GL" && [ ! -e "$STATE/merge/$SLUG.gate-outside-retry.$SHA" ]; then
        say "#$N $SLUG: gate failed only on tests outside the PR footprint (or known-flaky): $(tr -d '\n' < "$STATE/merge/$SLUG.outside-reason.txt"); rerunning gate once"
        GL="$RUNS/gate-merge-$SLUG-$(date +%H%M%S).log"
        if mklock "$STATE/.gate.lock" 1800; then
          # Consumed only when the retry really runs: a lock-timeout skip keeps it for the next cycle.
          touch "$STATE/merge/$SLUG.gate-outside-retry.$SHA"
          if gate_watched "$N" "$SHA" "$STATE" "$SLUG" "$GL" "$WT" bash "$RSI_DIR/runtime/gate.sh" "$WT"; then
            GRC=$GATE_RC; rm -rf "$STATE/.gate.lock"; $GIT -C "$WT" checkout -q -- . 2>/dev/null
          else
            $GIT -C "$WT" checkout -q -- . 2>/dev/null
            gate_head_unwind "$N" "$SLUG" "$STATE" "$GATE_LIVE_HEAD"; exit 0
          fi
        else
          gate_lock_decision timeout "$SLUG" "$SHA" "$STATE"
          say "#$N $SLUG: $GATE_LOCK_REASON (outside-footprint re-gate); skipping this cycle"
          exit 0
        fi
      fi
    fi
    if [ $GRC -ne 0 ] || ! grep -q '^GATE_RESULT=PASS' "$GL"; then
      # The machine could not run the gate (exit 3: failed probe write / ENOSPC in a step log).
      # Not a verdict on the branch: retry next cycle, no sendback, no rework attempt burned.
      if NVR="$(gate_no_verdict_reason "$GL")"; then
        gate_no_verdict_skip "$N" "$SLUG" "$NVR"
      fi
      GATE_OK=0; GATE_NOTE="$(grep '^GATE_RESULT' "$GL" | head -1)"
      outside_tests_only "$WT" "$GL" && GATE_OUTSIDE=1
      say "#$N $SLUG: gate FAIL: $GATE_NOTE$([ $GATE_OUTSIDE -eq 1 ] && echo ' (outside-footprint or known-flaky tests)')"
    fi
  else
    gate_lock_decision timeout "$SLUG" "$SHA" "$STATE"
    say "#$N $SLUG: $GATE_LOCK_REASON"
    exit 0
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
  if ux_carry_verdict "$WT" origin/main "$UXV" "$DH"; then
    say "#$N $SLUG: UX gate carried over ($UX_CARRY_REASON: $UX_CARRY_KEY)"
  else
    say "#$N $SLUG: UX gate re-walks ($UX_CARRY_REASON)"
    # Reuse a strong UX review for this same head SHA (do not re-call Hydrogen/sol), but only
    # when the gate's own decision accepts the cached text: reusing an ungrounded below-threshold
    # score is #383 again (its FAIL sends the PR back, its PASS merges it) one tick after the gate
    # said "no verdict". On any failure fall through to ux-gate.sh, which re-walks and re-asks.
    if [ -s "$STATE/merge/$SLUG.strong-ux" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong-ux")" = "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux.txt" ] \
       && bash "$RSI_DIR/runtime/ux-gate.sh" --accepts-review "$STATE/merge/$SLUG.strong-ux.txt"; then
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
    [ -s "$STATE/merge/$SLUG.strong-ux.txt" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong-ux")" = "$SHA" ] \
      && say "#$N $SLUG: cached strong UX review for ${SHA:0:8} fails the UX gate's own decision (grounding/threshold) — running the gate"
    say "#$N $SLUG: UX gate (journey walk + vision review)"
    # Outer backstop, not a walk bound, and it must enclose the whole composition:
    # each walk can spend RSI_HEAVY_WAIT_MAX queueing for the heavy slot and then
    # RSI_WALK_MAX_S in the walker, ux-gate re-walks a red once (confirm) and a
    # one-sample variant once more (second sample), the vision review is dispatched
    # up to twice (first ask + one grounding re-ask) at DISPATCH_MAX_SECS=1500 each
    # (ux-gate.sh), and the pre-walk UI/go build, seed and daemon boot add ~900s.
    # With the default bounds:
    # 3 x (1800 + 2700) + 2 x 1500 + 900 = 17400s. A numeric RSI_UX_GATE_MAX_S
    # still wins; a malformed one falls back to the same derived default.
    HEAVY_WAIT_MAX="${RSI_HEAVY_WAIT_MAX:-1800}"; case "$HEAVY_WAIT_MAX" in ''|*[!0-9]*) HEAVY_WAIT_MAX=1800;; esac
    WALK_MAX_S="${RSI_WALK_MAX_S:-2700}"; case "$WALK_MAX_S" in ''|*[!0-9]*) WALK_MAX_S=2700;; esac
    GATE_DEFAULT=$(( 3 * (HEAVY_WAIT_MAX + WALK_MAX_S) + 2 * 1500 + 900 ))
    GATE_MAX="${RSI_UX_GATE_MAX_S:-$GATE_DEFAULT}"; case "$GATE_MAX" in ''|*[!0-9]*) GATE_MAX=$GATE_DEFAULT;; esac
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
      echo "$DH PASS $UX_CARRY_KEY" > "$UXV"
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
    # The merge is irreversible and its record can still fail (stale metadata, full disk): the
    # intent written here is the recovery record that survives both, so a write that cannot land
    # stops the merge instead of leaving a merged PR with no row and no retry path.
    if ! persist_merge_intent "$N" "$SLUG" "$ITEM" "$PRURL"; then
      say "#$N $SLUG: cannot persist the pre-merge recovery record in $(RECORD_INTENT_DIR); not merging"
      rm -rf "$STATE/.land.lock"; exit 0
    fi
    MERGED_OK=0
    if $GH pr merge "$N" --repo "$GH_REPO" --squash >/dev/null 2>"$STATE/merge/$SLUG.merge.err"; then
      MERGED_OK=1
    else
      MSTATE="$(bounded_run "$RECORD_METADATA_SECS" "$GH" pr view "$N" --repo "$GH_REPO" --json state --jq .state 2>/dev/null || true)"
      case "$MSTATE" in
        MERGED) say "#$N $SLUG: gh pr merge exited non-zero after GitHub completed merge — recording merge"; MERGED_OK=1 ;;
        # Positively not merged: the intent is not a delivery record. An unreadable state keeps it,
        # because the merge may have landed while the read failed.
        OPEN|CLOSED) clear_merge_intent "$N" ;;
      esac
    fi
    if [ $MERGED_OK -eq 1 ]; then
      # One writer, shared with any path that merges a PR itself (record-merged.sh): it keeps the
      # exact format this echo wrote, refuses a row with no commit/url, and makes a re-record a no-op.
      # A refusal cannot un-merge the PR, so the row is queued and retried by the next tick instead;
      # if the queue write also fails, the pre-merge intent stays and that tick drains it.
      MSHA="$(record_delivery "$N" "$SLUG" "$ITEM" "$PRURL")"; RRC=$?
      if [ "$RRC" -eq 0 ]; then
        say "#$N $SLUG: MERGED ($MSHA)"
        clear_merge_intent "$N"
      elif [ "$RRC" -eq 1 ]; then
        MSHA=""
        say "#$N $SLUG: MERGED (delivery record pending; the next dispatcher tick retries it)"
      else
        MSHA=""
        say "#$N $SLUG: MERGED (delivery record NOT persisted: neither merged.log nor the pending queue accepted it; the pre-merge intent $(RECORD_INTENT_DIR)/$N.tsv is the recovery record)"
      fi
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
