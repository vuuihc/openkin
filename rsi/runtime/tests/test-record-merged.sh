#!/bin/bash
# test-record-merged.sh — a delivered PR is recorded in $STATE/merged.log exactly once.
#
# Measured 2026-11-28 07:58 (followup 2219): DREAM merged its docs PR #847 (a39b5e72) at
# 07:53 and merged.log never got a row; the CEO patrol appended one by hand to restore
# merged_today=14. merge.sh was the only writer, and DREAM ran `gh pr merge` itself, so the
# one line that counts deliveries was skipped. record-merged.sh is now the one writer both
# paths call; a second record for the same PR is a no-op, so a retried merge cannot double
# count. lanes.py merged_rows() parses the format and followups-lint.py indexes `#N` from it:
#
#   YYYY-MM-DD HH:MM PR #N <slug> <item> merged <first 8 of sha> <url>
#
# Hermetic: mktemp state dirs, a fake gh that fails if called, no network, no real
# rsi/state. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case id> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
RECORDER="$RUNTIME/record-merged.sh"
MERGE="$RUNTIME/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
rc=0; O=""; E=""
ok() { echo "PASS record-merged: $*"; }
bad() { echo "FAIL record-merged: $*" >&2; exit 1; }
run_case() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }

# --- stubs -----------------------------------------------------------------------------------
# The recorder is a pure append: it must never reach the network or gh. A gh on PATH that
# fails loudly turns any call into a named failure instead of a silent real request.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'SH'
#!/bin/sh
echo "gh was called by record-merged.sh" >&2
exit 1
SH
chmod +x "$T/bin/gh"

# record <state> [args...] — run the recorder, capture rc (never abort) and stdout/stderr.
record() {
  local st="$1"; shift
  PATH="$T/bin:$PATH" bash "$RECORDER" --state "$st" "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# lines <file> — line count, 0 when the file does not exist yet.
lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
# url <pr> — a GitHub pull request url for a fake repo.
url() { printf 'https://github.com/example/repo/pull/%s' "$1"; }
# gh_flaky — a stub for the $GH the merge lane calls: prints nothing for the first $GH_FAIL_FIRST
# calls (a transient metadata failure), then $GH_SHA, counting calls in the file $GH_CALLS.
cat > "$T/bin/gh-flaky" <<'SH'
#!/bin/sh
c="${GH_CALLS:?}"; n="$(cat "$c" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$c"
[ "$n" -le "${GH_FAIL_FIRST:-0}" ] && exit 0
printf '%s\n' "${GH_SHA:-abc1234def0000}"
SH
chmod +x "$T/bin/gh-flaky"

# gh-hang — a metadata call that never answers, plus a child that must not survive the deadline.
# Both pids are appended to $GH_PIDS so the case can prove the whole tree was killed.
cat > "$T/bin/gh-hang" <<'SH'
#!/bin/sh
sleep 300 &
c=$!
printf '%s\n%s\n' "$$" "$c" >> "${GH_PIDS:?}"
wait "$c"
SH
chmod +x "$T/bin/gh-hang"

# --- one-line --------------------------------------------------------------------------------
# A PR merged outside the merge lane (a model running its own `gh pr merge`) records exactly
# one row, in the format lanes.py parses: date, time, `PR #N`, slug, item, `merged`, sha8, url.
if run_case one-line; then
  ST="$T/s1"; mkdir -p "$ST"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "one-line: recorder exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 1 ] \
    || bad "one-line: expected exactly 1 line, got $(lines "$ST/merged.log"): $(cat "$ST/merged.log" 2>/dev/null)"
  LC_ALL=C grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} PR #900 dream-2026-11-28 R-dream-2026-11-28 merged abc1234d https://github\.com/' "$ST/merged.log" \
    || bad "one-line: row does not match the merge.sh format: $(cat "$ST/merged.log")"
  ok "an externally merged PR appends exactly one line"
fi

# --- second-is-a-noop ------------------------------------------------------------------------
# A retried merge (the lane re-runs after a crash, or two paths both record) must not count
# the same PR twice: exit 0, say so, write nothing.
if run_case second-is-a-noop; then
  ST="$T/s2"; mkdir -p "$ST"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "second-is-a-noop: first record exited $rc ($E)"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "second-is-a-noop: second record exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 1 ] \
    || bad "second-is-a-noop: a second record appended a line ($(lines "$ST/merged.log") rows)"
  grep -q 'already recorded #900' <<<"$O" \
    || bad "second-is-a-noop: expected 'already recorded #900' on stdout, got: $O"
  ok "a second record for the same PR writes nothing"
fi

# --- whole-token -----------------------------------------------------------------------------
# Only a whole `#N` token is a hit (the rule followups-lint.py applies to this file): an
# existing #90 must not swallow #900, and an existing #900 must not swallow #90. A substring
# match fails one of the two directions whichever way it is written.
if run_case whole-token; then
  ST="$T/s3"; mkdir -p "$ST"
  printf '2026-11-27 09:00 PR #90 old-slug R-old merged deadbeef %s\n' "$(url 90)" >> "$ST/merged.log"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "whole-token: recording #900 exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 2 ] \
    || bad "whole-token: #900 was swallowed by the existing #90 row"
  ST="$T/s3b"; mkdir -p "$ST"
  printf '2026-11-27 09:01 PR #900 new-slug R-new merged deadbeef %s\n' "$(url 900)" >> "$ST/merged.log"
  record "$ST" --pr 90 --slug old-slug --item R-old --sha deadbeef01 --url "$(url 90)"
  [ "$rc" -eq 0 ] || bad "whole-token: recording #90 exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 2 ] \
    || bad "whole-token: #90 matched inside the existing #900 row (a substring match)"
  ok "#90 does not swallow #900"
fi

# --- no-commit-refused -----------------------------------------------------------------------
# A "delivered" row without a commit and a GitHub url is not evidence; the old writer recorded
# `?` when `gh pr view` failed. Every refusal exits non-zero, names the flag, and writes nothing.
if run_case no-commit-refused; then
  ST="$T/s4"; mkdir -p "$ST"
  record "$ST" --pr 901 --slug s --item R-x --sha "" --url "$(url 901)"
  [ "$rc" -ne 0 ] || bad "no-commit-refused: an empty --sha was accepted"
  grep -q -- '--sha' <<<"$E" || bad "no-commit-refused: the refusal does not name --sha: $E"
  record "$ST" --pr 901 --slug s --item R-x --sha '?' --url "$(url 901)"
  [ "$rc" -ne 0 ] || bad "no-commit-refused: a '?' sha was accepted"
  record "$ST" --pr 902 --slug s --item R-x --sha abc1234def --url 'https://example.com/pull/902'
  [ "$rc" -ne 0 ] || bad "no-commit-refused: a non-GitHub url was accepted"
  grep -q -- '--url' <<<"$E" || bad "no-commit-refused: the refusal does not name --url: $E"
  [ "$(lines "$ST/merged.log")" = 0 ] \
    || bad "no-commit-refused: a refused record wrote a line: $(cat "$ST/merged.log")"
  ok "a record with no commit is refused"
fi

# --- unwritable-log --------------------------------------------------------------------------
# A failed append must not print "recorded": with only `set -u` the printf failure fell through to
# a success message and exit 0, so a full disk or a read-only log claimed a delivery it never wrote.
if run_case unwritable-log; then
  ST="$T/s4b"; mkdir -p "$ST/merged.log"
  record "$ST" --pr 903 --slug s --item R-x --sha abc1234def --url "$(url 903)"
  [ "$rc" -ne 0 ] || bad "unwritable-log: a failed append exited 0 ($O)"
  case "$O" in *recorded*) bad "unwritable-log: a failed append still printed 'recorded': $O" ;; esac
  grep -q 'append to' <<<"$E" || bad "unwritable-log: the failure does not name the append: $E"
  ok "a failed append is an error, not a recorded delivery"
fi

# --- record-retries --------------------------------------------------------------------------
# The merge lane's own success path (merge.sh --record-merged-check): the metadata fails twice and
# arrives on the third try, so the row is written in the same process and the sha is reported.
if run_case record-retries; then
  ST="$T/s5"; mkdir -p "$ST/merge"; : > "$T/gh-calls-retry"
  O="$(RSI_GH="$T/bin/gh-flaky" GH_CALLS="$T/gh-calls-retry" GH_FAIL_FIRST=2 \
    RSI_RECORD_RETRY_SLEEP=0 bash "$MERGE" --record-merged-check "$ST" 905 s R-x "$(url 905)" 2>"$T/err")"
  rc=$?
  [ "$rc" -eq 0 ] || bad "record-retries: seam exited $rc ($O; $(cat "$T/err"))"
  [ "$O" = "RECORDED abc1234d" ] || bad "record-retries: want RECORDED abc1234d, got: $O"
  [ "$(lines "$ST/merged.log")" = 1 ] || bad "record-retries: no row after the metadata arrived"
  [ "$(cat "$T/gh-calls-retry")" = 3 ] \
    || bad "record-retries: want 3 metadata attempts, got $(cat "$T/gh-calls-retry")"
  ok "a transient metadata failure is retried and still records"
fi

# --- record-deferred -------------------------------------------------------------------------
# The metadata never arrives: the merge still happened, so the row is queued on disk (one row per
# PR) instead of being dropped, and the retry loop is bounded at three attempts.
if run_case record-deferred; then
  ST="$T/s6"; mkdir -p "$ST/merge"; : > "$T/gh-calls-defer"
  O="$(RSI_GH="$T/bin/gh-flaky" GH_CALLS="$T/gh-calls-defer" GH_FAIL_FIRST=9 \
    RSI_RECORD_RETRY_SLEEP=0 bash "$MERGE" --record-merged-check "$ST" 906 s R-x "$(url 906)" 2>"$T/err")"
  rc=$?
  [ "$rc" -eq 0 ] || bad "record-deferred: seam exited $rc ($O; $(cat "$T/err"))"
  [ "$O" = "PENDING" ] || bad "record-deferred: want PENDING, got: $O"
  [ "$(lines "$ST/merged.log")" = 0 ] || bad "record-deferred: a row was written without a commit"
  [ "$(ls -1 "$ST/merge/pending-records" 2>/dev/null | wc -l | tr -d ' ')" = 1 ] \
    || bad "record-deferred: want exactly one durable pending record: $(ls -A "$ST/merge/pending-records" 2>/dev/null)"
  LC_ALL=C grep -q "^906	" "$ST/merge/pending-records/906.tsv" \
    || bad "record-deferred: pending record does not name PR 906: $(cat "$ST/merge/pending-records/906.tsv" 2>/dev/null)"
  [ "$(cat "$T/gh-calls-defer")" = 3 ] \
    || bad "record-deferred: want 3 bounded attempts, got $(cat "$T/gh-calls-defer")"
  ok "a metadata failure queues a durable record instead of dropping it"
fi

# --- pending-drained -------------------------------------------------------------------------
# The recovery path: the next dispatcher tick retries the queued row before reading open PRs (the
# merged PR is closed, so no open-PR list would ever bring it back). Runs merge.sh's dispatcher
# path hermetically, with the runtime copied under a temp RSI_CTRL and an empty PR list.
if run_case pending-drained; then
  CTRL="$T/drain-ctrl"; mkdir -p "$CTRL/rsi/state/merge/pending-records" "$CTRL/rsi/runtime"
  cp -R "$RUNTIME/." "$CTRL/rsi/runtime/"
  ST="$CTRL/rsi/state"
  printf '906\ts\tR-x\t%s\n' "$(url 906)" > "$ST/merge/pending-records/906.tsv"
  : > "$T/gh-calls-drain"
  O="$(RSI_CTRL="$CTRL" RSI_GH="$T/bin/gh-flaky" GH_CALLS="$T/gh-calls-drain" GH_FAIL_FIRST=0 \
    RSI_PR_LIST_CMD='echo []' bash "$MERGE" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || bad "pending-drained: dispatcher exited $rc ($O)"
  grep -q 'delivery record recovered' <<<"$O" \
    || bad "pending-drained: the recovery is not reported ($O)"
  [ "$(lines "$ST/merged.log")" = 1 ] \
    || bad "pending-drained: the queued row was not recorded: $(cat "$ST/merged.log" 2>/dev/null)"
  LC_ALL=C grep -Eq 'PR #906 s R-x merged abc1234d https://github\.com/' "$ST/merged.log" \
    || bad "pending-drained: row does not match the merged.log format: $(cat "$ST/merged.log")"
  [ -z "$(ls -A "$ST/merge/pending-records" 2>/dev/null)" ] \
    || bad "pending-drained: the recorded row is still queued: $(ls -A "$ST/merge/pending-records")"
  ok "the next dispatcher tick recovers a deferred record"
fi

# --- queue-unwritable ------------------------------------------------------------------------
# The queue write's result used to be discarded: a disk that rejected both merged.log and the
# pending file still printed the ordinary "pending" status, the caller released the PR, and no
# file existed for the next tick. The seam must report UNPERSISTED (exit 2), distinct from a
# successfully queued PENDING (exit 0).
if run_case queue-unwritable; then
  ST="$T/s6b"; mkdir -p "$ST/merge"
  : > "$ST/merge/pending-records"          # a file where the queue needs a directory
  : > "$T/gh-calls-unwritable"
  O="$(RSI_GH="$T/bin/gh-flaky" GH_CALLS="$T/gh-calls-unwritable" GH_FAIL_FIRST=9 \
    RSI_RECORD_RETRY_SLEEP=0 bash "$MERGE" --record-merged-check "$ST" 908 s R-x "$(url 908)" 2>"$T/err")"
  rc=$?
  [ "$rc" -eq 2 ] || bad "queue-unwritable: want exit 2 (no recovery record), got $rc ($O; $(cat "$T/err"))"
  [ "$O" = "UNPERSISTED" ] || bad "queue-unwritable: want UNPERSISTED, got: $O"
  [ "$(lines "$ST/merged.log")" = 0 ] || bad "queue-unwritable: a row was written without a commit"
  [ -f "$ST/merge/pending-records" ] || bad "queue-unwritable: the case lost its unwritable queue path"
  ok "a rejected queue write is reported as not persisted, not as queued"
fi

# --- metadata-hangs --------------------------------------------------------------------------
# A stalled `gh pr view` used to run without a deadline: three attempts bound the count, not the
# wait, so the merge-success record (holding the land lock) and the recovery drain (before open PRs
# are read) could block forever. The deadline must kill the attempt's whole tree and the hung
# attempt must count as unavailable metadata. The case runs the seam in the background with its own
# watchdog so a missing deadline is a named failure, not a hung suite.
if run_case metadata-hangs; then
  ST="$T/s6c"; mkdir -p "$ST/merge"
  PIDS="$T/hang-pids"; : > "$PIDS"
  RSI_GH="$T/bin/gh-hang" GH_PIDS="$PIDS" RSI_RECORD_METADATA_SECS=1 RSI_RECORD_RETRY_SLEEP=0 \
    bash "$MERGE" --record-merged-check "$ST" 907 s R-x "$(url 907)" >"$T/out" 2>"$T/err" &
  hp=$!
  deadline=$((SECONDS + 25)); timed_out=0
  while kill -0 "$hp" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || { timed_out=1; break; }
    sleep 0.2
  done
  if [ "$timed_out" = 1 ]; then
    kill -KILL "$hp" 2>/dev/null || true
    while IFS= read -r p; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done < "$PIDS"
    bad "metadata-hangs: a metadata attempt outlived its deadline (no process-tree timeout)"
  fi
  wait "$hp"; rc=$?
  O="$(cat "$T/out")"
  [ "$rc" -eq 0 ] || bad "metadata-hangs: seam exited $rc ($O; $(cat "$T/err"))"
  [ "$O" = "PENDING" ] || bad "metadata-hangs: a timed-out attempt must read as unavailable metadata, got: $O"
  [ "$(lines "$ST/merged.log")" = 0 ] || bad "metadata-hangs: a row was written with no commit"
  [ -s "$PIDS" ] || bad "metadata-hangs: the hung metadata command never ran"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    kill -0 "$p" 2>/dev/null && bad "metadata-hangs: pid $p from the hung metadata call survived the deadline"
  done < "$PIDS"
  ok "a hung metadata call is killed with its tree and treated as unavailable"
fi

# --- intent-drained --------------------------------------------------------------------------
# When the append and the queue both fail, the pre-merge intent is the only recovery record left.
# The next dispatcher tick records it before reading open PRs and removes it, like a pending row.
if run_case intent-drained; then
  CTRL="$T/intent-ctrl"; mkdir -p "$CTRL/rsi/state/merge/merge-intents" "$CTRL/rsi/runtime"
  cp -R "$RUNTIME/." "$CTRL/rsi/runtime/"
  ST="$CTRL/rsi/state"
  printf '909\ts\tR-x\t%s\n' "$(url 909)" > "$ST/merge/merge-intents/909.tsv"
  : > "$T/gh-calls-intent"
  O="$(RSI_CTRL="$CTRL" RSI_GH="$T/bin/gh-flaky" GH_CALLS="$T/gh-calls-intent" GH_FAIL_FIRST=0 \
    RSI_PR_LIST_CMD='echo []' bash "$MERGE" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || bad "intent-drained: dispatcher exited $rc ($O)"
  grep -q 'delivery record recovered' <<<"$O" \
    || bad "intent-drained: the intent recovery is not reported ($O)"
  [ "$(lines "$ST/merged.log")" = 1 ] \
    || bad "intent-drained: the intent was not recorded: $(cat "$ST/merged.log" 2>/dev/null)"
  LC_ALL=C grep -Eq 'PR #909 s R-x merged abc1234d https://github\.com/' "$ST/merged.log" \
    || bad "intent-drained: row does not match the merged.log format: $(cat "$ST/merged.log")"
  [ ! -e "$ST/merge/merge-intents/909.tsv" ] \
    || bad "intent-drained: the recorded intent is still on disk"
  ok "the next dispatcher tick recovers a pre-merge intent"
fi

# --- intent-before-merge ---------------------------------------------------------------------
# The intent is only a recovery record if it exists before the irreversible command: assert the
# persist-and-check call sits above `gh pr merge`, and that a recorded row is what clears it.
if run_case intent-before-merge; then
  intent_line="$(grep -n 'persist_merge_intent "\$N" "\$SLUG" "\$ITEM" "\$PRURL"' "$MERGE" | head -1 | cut -d: -f1)"
  merge_line="$(grep -n 'pr merge "\$N"' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$intent_line" ] || bad "intent-before-merge: the merge-success path does not persist a pre-merge intent"
  [ -n "$merge_line" ] || bad "intent-before-merge: merge.sh no longer names the merge command"
  [ "$intent_line" -lt "$merge_line" ] \
    || bad "intent-before-merge: the intent is written at line $intent_line, after the merge at $merge_line"
  grep -qF 'if ! persist_merge_intent' "$MERGE" \
    || bad "intent-before-merge: the intent write is not checked, so a failed persist still merges"
  grep -qF 'clear_merge_intent "$N"' "$MERGE" \
    || bad "intent-before-merge: nothing clears the intent after the row is recorded"
  ok "the pre-merge intent is persisted, checked and cleared"
fi

# --- merge-sh-wiring -------------------------------------------------------------------------
# One writer, not two: merge.sh names the helper and no longer appends merged.log itself. The
# assertion requires the executable invocation and the merge-success call, never a mention: a bare
# grep for the filename passed on a comment after the invocation was deleted (review, 2026-11-28).
if run_case merge-sh-wiring; then
  grep -qF 'bash "$RSI_DIR/runtime/record-merged.sh" --state "$STATE"' "$MERGE" \
    || bad "merge-sh-wiring: merge.sh does not invoke record-merged.sh"
  grep -qF 'record_delivery "$N" "$SLUG" "$ITEM" "$PRURL"' "$MERGE" \
    || bad "merge-sh-wiring: the merge-success block does not record through record_delivery"
  if grep -Eq '>>[[:space:]]*"\$STATE/merged\.log"' "$MERGE"; then
    bad "merge-sh-wiring: merge.sh still appends merged.log itself"
  fi
  ok "merge.sh records through the same helper"
fi

[ -z "$ONLY" ] || grep -qx "$ONLY" <<<"one-line
second-is-a-noop
whole-token
no-commit-refused
unwritable-log
record-retries
record-deferred
queue-unwritable
metadata-hangs
pending-drained
intent-drained
intent-before-merge
merge-sh-wiring" || bad "RSI_TEST_ONLY='$ONLY' matched no case"

echo "test-record-merged: ALL-PASS"
