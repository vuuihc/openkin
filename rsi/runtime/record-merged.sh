#!/bin/bash
# record-merged.sh — the one writer of $STATE/merged.log.
#
# merged.log is the loop's durable delivery record: lanes.py counts merged_today/merged_last
# from it, pace.py reads it, followups-lint.py indexes `#N` tokens from it and the release
# gate derives its unshipped count from the merge history. Until 2026-11-28 only merge.sh
# appended it, after its own `gh pr merge`; a model that merged its own PR never ran that
# line, so DREAM's docs PR #847 (a39b5e72, merged 07:53) had no row and merged_today read 13
# until a patrol appended one by hand (followup 2219). Both paths call this helper now, and
# recording the same PR twice writes nothing, so a retried merge cannot double count.
#
# Line format (parsed by lanes.py merged_rows(), indexed by followups-lint.py):
#   YYYY-MM-DD HH:MM PR #<N> <slug> <item> merged <first 8 of sha> <url>
#
# Pure append: no network, no gh, never rewrites or reorders existing rows. A record with no
# commit or no GitHub url is refused, because a "delivered" row without evidence is worse
# than a missing one.
set -u

usage() {
  echo "usage: record-merged.sh --state <dir> --pr <N> --slug <slug> --item <item> --sha <sha> --url <url>" >&2
  exit 2
}

STATE=; PR=; SLUG=; ITEM=; SHA=; URL=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) [ "$#" -ge 2 ] || { echo "record-merged: --state needs a value" >&2; exit 2; }; STATE="$2"; shift 2 ;;
    --pr)    [ "$#" -ge 2 ] || { echo "record-merged: --pr needs a value" >&2; exit 2; }; PR="$2"; shift 2 ;;
    --slug)  [ "$#" -ge 2 ] || { echo "record-merged: --slug needs a value" >&2; exit 2; }; SLUG="$2"; shift 2 ;;
    --item)  [ "$#" -ge 2 ] || { echo "record-merged: --item needs a value" >&2; exit 2; }; ITEM="$2"; shift 2 ;;
    --sha)   [ "$#" -ge 2 ] || { echo "record-merged: --sha needs a value" >&2; exit 2; }; SHA="$2"; shift 2 ;;
    --url)   [ "$#" -ge 2 ] || { echo "record-merged: --url needs a value" >&2; exit 2; }; URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "record-merged: unknown argument: $1" >&2; usage ;;
  esac
done

# Every refusal names the flag it is about, so a caller in a run log can be fixed from the
# message alone.
[ -n "$STATE" ] || { echo "record-merged: --state is required" >&2; exit 2; }
[ -d "$STATE" ] || { echo "record-merged: --state is not a directory: $STATE" >&2; exit 2; }
case "$PR" in
  ''|*[!0-9]*) echo "record-merged: --pr must be a pull request number, got '$PR'" >&2; exit 2 ;;
esac
[ -n "$SLUG" ] || { echo "record-merged: --slug is required" >&2; exit 2; }
[ -n "$ITEM" ] || { echo "record-merged: --item is required" >&2; exit 2; }
# The merge lane used to write `?` here whenever `gh pr view` failed. A row with no commit
# proves nothing to any reader, so refuse it instead of recording a delivery nobody can audit.
case "$SHA" in
  ''|'?') echo "record-merged: --sha is required: a merge with no commit is not a delivery record" >&2; exit 2 ;;
esac
case "$URL" in
  https://github.com/*) ;;
  *) echo "record-merged: --url must be a https://github.com/ pull request url, got '$URL'" >&2; exit 2 ;;
esac

LOG="$STATE/merged.log"
# A whole `#N` token, never digits inside another number — the same rule followups-lint.py
# applies to this file. `#90` must not match `#900`, in either direction.
if [ -f "$LOG" ] && LC_ALL=C grep -Eq "(^|[^[:alnum:]_])#${PR}([^[:alnum:]_]|$)" "$LOG"; then
  echo "already recorded #$PR"
  exit 0
fi

SHORT="${SHA:0:8}"
printf '%s PR #%s %s %s merged %s %s\n' "$(date '+%F %H:%M')" "$PR" "$SLUG" "$ITEM" "$SHORT" "$URL" >> "$LOG"
echo "recorded #$PR $SHORT"
