#!/bin/bash
# diff-size.sh <worktree> [base] — print the PR's changed-line count exactly the way merge.sh
# measures it: added+deleted on the three-dot diff, excluding web/dist/index.html (regenerated)
# and *package-lock.json. The producers (lane.sh, ingest-nas.sh) and the merge lane share this
# one formula so a PR over the 1000-line cap is stopped at the cheapest point — before this
# script existed only merge.sh measured, so producers shipped oversize diffs straight into a
# guaranteed hold-size sendback.
# GIT may be overridden by callers that carry a stubbed git (merge.sh's own $GIT seam).
set -u
WT="${1:?usage: diff-size.sh <worktree> [base]}"
BASE="${2:-origin/main}"
"${GIT:-git}" -C "$WT" diff --numstat "$BASE...HEAD" -- . ':!web/dist/index.html' ':!*package-lock.json' | awk '{s+=$1+$2} END{print s+0}'
