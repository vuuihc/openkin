#!/bin/bash
# test-pace.sh — pace.py's `unshipped` must be the release gate's number, not a
# clock-minute guess. release-check.sh counts PR subjects between the older
# `state/last_release` marker and origin/main; pace used to count merged.log lines
# newer than the release timestamp, so a PR that landed in the release minute read
# as shipped while the gate still held it (2026-11-18 00:16: gate 1, pace 0).
#
# Hermetic: temp git repos, temp state, fixed identities and dates, no network.
# Prints "PASS <case>" per case; exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PACE="$HERE/../pace.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export GIT_AUTHOR_DATE="2026-11-18T00:00:00+0000" GIT_COMMITTER_DATE="2026-11-18T00:00:00+0000"

# new_repo <dir> — a main branch with one base commit.
new_repo() {
  local r="$1"
  mkdir -p "$r"
  git -C "$r" init -q -b main
  printf 'base\n' > "$r/base.txt"
  git -C "$r" add base.txt
  git -C "$r" commit -q -m "chore: init"
}

# commit <repo> <subject> — one commit whose subject is exactly <subject>.
commit() {
  local r="$1" subject="$2" n
  n="$(git -C "$r" rev-list --count HEAD)"
  printf '%s\n' "$n" > "$r/f$n.txt"
  git -C "$r" add "f$n.txt"
  git -C "$r" commit -q -m "$subject"
}

# origin_main <repo> <rev> — the local view of origin/main that pace reads.
origin_main() { git -C "$1" update-ref refs/remotes/origin/main "$2"; }

# run_json <repo> <state> [extra pace args...] — LAST holds stdout+stderr.
# Exit 3 is BEHIND on the phase verdict and still carries the JSON; anything
# else means pace could not answer at all.
run_json() {
  local repo="$1" state="$2"; shift 2
  LAST="$(python3 "$PACE" --json --repo "$repo" --state "$state" "$@" 2>&1)"; RC=$?
  case "$RC" in 0|3) ;; *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC";; esac
}

# jget <key> — a JSON field of LAST, or <missing>/<invalid-json>.
jget() {
  printf '%s' "$LAST" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("<invalid-json>"); raise SystemExit
print(d.get(sys.argv[1], "<missing>"))
' "$1"
}

# eq <key> <want> — the field must have exactly this value.
eq() {
  local got; got="$(jget "$1")"
  [ "$got" = "$2" ] || { printf '%s\n' "$LAST" >&2; fail "$CASE: $1=$got, want $2"; }
}

# 1. A PR merged in the same minute as the release is still unshipped: the gate counts
#    commits, not clock minutes. Red before this change (pace said 0).
CASE=t_same_minute_merge_is_unshipped
R="$T/r1"; S="$T/s1"; new_repo "$R"; commit "$R" "feat(x): y (#238)"; origin_main "$R" HEAD
BASE="$(git -C "$R" rev-parse HEAD~1)"
mkdir -p "$S"
printf 'node=%s\nhub=%s\n' "$BASE" "$BASE" > "$S/last_release"
printf '2026-11-18 00:16 RELEASED %s node=ok hub=ok unshipped_before=0\n' "$BASE" > "$S/releases.log"
printf '2026-11-18 00:10 merged #237 old R-old aaaa\n2026-11-18 00:16 merged #238 new R-new bbbb\n' > "$S/merged.log"
run_json "$R" "$S"
eq unshipped 1
eq commits 1
eq unshipped_source git
pass "$CASE"

# 2. The older marker is the baseline by ancestry, not by line order: node at base,
#    hub at head, two commits after base, only one PR subject.
CASE=t_older_marker_wins
R="$T/r2"; S="$T/s2"; new_repo "$R"
commit "$R" "feat(a): one (#101)"
commit "$R" "fix(b): two"
origin_main "$R" HEAD
BASE="$(git -C "$R" rev-parse HEAD~2)"
HEAD_SHA="$(git -C "$R" rev-parse HEAD)"
mkdir -p "$S"
printf 'node=%s\nhub=%s\n' "$BASE" "$HEAD_SHA" > "$S/last_release"
run_json "$R" "$S"
eq unshipped 1
eq commits 2
eq unshipped_source git
pass "$CASE"

# 2b. Ancestry decides, not file order (the older marker may be listed second), and
#     only a subject that *ends* in (#N) is a PR: mention it mid-sentence and it is
#     just another commit.
CASE=t_ancestry_beats_line_order
R="$T/r2b"; S="$T/s2b"; new_repo "$R"
commit "$R" "feat(a): one (#101)"
commit "$R" "fix(b): two"
commit "$R" "docs(c): see (#99) later"
origin_main "$R" HEAD
BASE="$(git -C "$R" rev-parse HEAD~3)"
HEAD_SHA="$(git -C "$R" rev-parse HEAD)"
mkdir -p "$S"
printf 'node=%s\nhub=%s\n' "$HEAD_SHA" "$BASE" > "$S/last_release"
run_json "$R" "$S"
eq unshipped 1
eq commits 3
eq unshipped_source git
pass "$CASE"

# 3. No marker: the old merged.log count still answers, and the JSON says so.
CASE=t_no_marker_falls_back_to_merged_log
R="$T/r3"; S="$T/s3"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf '2026-11-18 00:10 merged #237 a R-a aaaa\n2026-11-18 00:16 merged #238 b R-b bbbb\n' > "$S/merged.log"
run_json "$R" "$S"
eq unshipped 2
eq unshipped_source merged.log
pass "$CASE"

# 4. A marker but no origin/main (fresh or offline checkout): fall back, do not crash.
CASE=t_missing_origin_main_falls_back
R="$T/r4"; S="$T/s4"; new_repo "$R"; commit "$R" "feat(c): three (#303)"
BASE="$(git -C "$R" rev-parse HEAD~1)"
mkdir -p "$S"
printf 'node=%s\nhub=%s\n' "$BASE" "$BASE" > "$S/last_release"
printf '2026-11-18 00:10 RELEASED %s node=ok hub=ok\n' "$BASE" > "$S/releases.log"
printf '2026-11-18 00:16 merged #238 a R-a aaaa\n2026-11-18 00:20 merged #239 b R-b bbbb\n2026-11-18 00:24 merged #240 c R-c cccc\n' > "$S/merged.log"
run_json "$R" "$S"
eq unshipped 3
eq unshipped_source merged.log
pass "$CASE"

# 5. A marker that is not a commit here is treated as absent, not as a baseline.
CASE=t_unreadable_marker_falls_back
R="$T/r5"; S="$T/s5"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf 'node=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$S/last_release"
printf '2026-11-18 00:16 merged #238 a R-a aaaa\n2026-11-18 00:20 merged #239 b R-b bbbb\n' > "$S/merged.log"
run_json "$R" "$S"
eq unshipped 2
eq unshipped_source merged.log
pass "$CASE"

# 6. pace stays local: the patrol does the fetching, the script does not.
CASE=t_pace_does_not_fetch
if grep -nE 'fetch|http' "$PACE" >/dev/null; then
  grep -nE 'fetch|http' "$PACE" >&2
  fail "$CASE: pace.py must not fetch or do network I/O"
fi
pass "$CASE"

# 7. The human line keeps its shape for every existing reader.
CASE=t_human_line_shape
R="$T/r7"; S="$T/s7"; new_repo "$R"; commit "$R" "feat(x): y (#238)"; origin_main "$R" HEAD
BASE="$(git -C "$R" rev-parse HEAD~1)"
mkdir -p "$S"; printf 'node=%s\nhub=%s\n' "$BASE" "$BASE" > "$S/last_release"
LAST="$(python3 "$PACE" --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC";; esac
grep -qE '^release: last .* unshipped=[0-9]+/[0-9]+' <<<"$LAST" \
  || { printf '%s\n' "$LAST" >&2; fail "$CASE: release line shape"; }
grep -qE '^pace verdict: ' <<<"$LAST" \
  || { printf '%s\n' "$LAST" >&2; fail "$CASE: verdict line missing"; }
pass "$CASE"

echo "all cases passed"
