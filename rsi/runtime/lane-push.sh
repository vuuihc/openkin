# shellcheck shell=bash
# lane-push.sh — push a lane's branch, surviving a transient git transport failure.
#
# 2026-11-15 18:46 (#84) and 2026-11-24 21:09 (#693): a lane finished its round, passed every
# check and committed — and one TLS blip on `git push` made lane.sh record failed and throw the
# finished work away; each time a person found the commit, pushed the branch and opened the PR
# by hand.
#
# The trap in that incident: the server may have accepted the push before the connection died,
# so the remote head can already equal local HEAD while git reports failure. A blind retry
# pushes the same commit again and a later failure hides that the branch landed, so every failed
# attempt looks at the remote head before pushing again — the twin of lane-pr.sh's
# look-before-create.
#
# Sourced by lane.sh and the suite; no top-level side effects.

# _push_bounded <secs> <cmd...>
# Runs one network-bound git call under common.sh's with_timeout, so a stalled transport cannot
# wedge the lane with its lock and slot held. lane-push.sh is also sourced by helper-only suites
# that never load common.sh; there the direct call is the only option.
_push_bounded() {
  local s="$1"; shift
  if declare -F with_timeout >/dev/null 2>&1; then
    with_timeout "$s" "$@"
  else
    "$@"
  fi
}

# git_push_retry <git> <worktree> <branch> <errfile>
# Pushes <branch> from <worktree>, retrying a failed attempt up to RSI_PUSH_RETRY_ATTEMPTS
# (default 3) times with RSI_PUSH_RETRY_SLEEP seconds (default 5) between attempts; 0 means no
# sleep. The push and the remote-head read each run under RSI_PUSH_TIMEOUT_SECS (default 120) via
# `with_timeout` when common.sh is loaded; a timed-out call (a signal-death rc) is a failed
# attempt like any other. After a failed attempt the remote head is compared with local HEAD: equal means the
# push landed, and 0 is returned without pushing again. <errfile> is truncated at the start of
# the call and receives the current attempt's stderr. Every diagnostic goes to stderr; nothing
# is printed on stdout. Returns 1 after the last failed attempt. Sets RSI_PUSH_ATTEMPTS_USED to
# the effective attempt count so the caller's note can name it.
git_push_retry() {
  local git="$1" wt="$2" br="$3" errfile="$4"
  local attempts="${RSI_PUSH_RETRY_ATTEMPTS:-3}" sleep_s="${RSI_PUSH_RETRY_SLEEP:-5}"
  local push_timeout="${RSI_PUSH_TIMEOUT_SECS:-120}"
  local i last="" remote local_sha push_rc
  case "$attempts" in ''|*[!0-9]*) attempts=3 ;; esac
  [ "$attempts" -ge 1 ] 2>/dev/null || attempts=1
  case "$sleep_s" in ''|*[!0-9]*) sleep_s=5 ;; esac
  case "$push_timeout" in ''|*[!0-9]*) push_timeout=120 ;; esac
  [ "$push_timeout" -ge 1 ] 2>/dev/null || push_timeout=120
  RSI_PUSH_ATTEMPTS_USED="$attempts"
  : > "$errfile"

  for ((i = 1; i <= attempts; i++)); do
    _push_bounded "$push_timeout" "$git" -C "$wt" push -q -u origin "$br" 2>"$errfile"
    push_rc=$?
    [ "$push_rc" -eq 0 ] && return 0
    last="$(tail -c 300 "$errfile" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')"
    printf 'git_push_retry: attempt %s/%s failed (rc=%s): %s\n' "$i" "$attempts" "$push_rc" "${last:-no output}" >&2
    # push can fail after the server actually accepted the commit (EOF on the response).
    # Look at the remote head before pushing again, so a landed push is not repeated.
    remote="$(_push_bounded "$push_timeout" "$git" -C "$wt" ls-remote --heads origin "refs/heads/$br" 2>/dev/null | awk 'NR == 1 { print $1 }')"
    local_sha="$("$git" -C "$wt" rev-parse HEAD 2>/dev/null)"
    if [ -n "$remote" ] && [ -n "$local_sha" ] && [ "$remote" = "$local_sha" ]; then
      printf 'git_push_retry: remote %s already at %s; not pushing again\n' "$br" "$remote" >&2
      return 0
    fi
    if [ "$i" -lt "$attempts" ] && [ "$sleep_s" -gt 0 ]; then sleep "$sleep_s"; fi
  done
  printf 'git_push_retry: failed after %s attempt(s): %s\n' "$attempts" "${last:-no output}" >&2
  return 1
}

# unpushed_note <branch> <sha> <worktree>
# One line naming the branch, the commit and the exact command a person (or the next fill) can
# run without reconstructing it. Printed by lane.sh and written to lanes/<n>.push.txt.
unpushed_note() {
  printf 'branch %s at %s is committed and unpushed; recovery: git -C %s push -u origin %s\n' \
    "$1" "$2" "$3" "$1"
}
