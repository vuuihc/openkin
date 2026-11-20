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

# jgetp <dotted.path> — a nested JSON field of LAST; null prints as `null`,
# a missing path as <missing>.
jgetp() {
  printf '%s' "$LAST" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("<invalid-json>"); raise SystemExit
cur = d
for part in sys.argv[1].split("."):
    if not isinstance(cur, dict) or part not in cur:
        print("<missing>"); raise SystemExit
    cur = cur[part]
if cur is None:
    print("null")
elif isinstance(cur, (dict, list)):
    print(json.dumps(cur, sort_keys=True))
else:
    print(cur)
' "$1"
}

# eqp <dotted.path> <want> — the nested field must have exactly this value.
eqp() {
  local got; got="$(jgetp "$1")"
  [ "$got" = "$2" ] || { printf '%s\n' "$LAST" >&2; fail "$CASE: $1=$got, want $2"; }
}

# stamps <offset-min>... — `YYYY-MM-DD HH:MM` for each offset from one shared
# now, so relative stage gaps are exact even across a minute boundary.
stamps() {
  python3 - "$@" <<'PY'
import sys, datetime
now = datetime.datetime.now()
for a in sys.argv[1:]:
    print((now + datetime.timedelta(minutes=int(a))).strftime("%Y-%m-%d %H:%M"))
PY
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

# 8. --latency splits open->merge into pre_verify / verify / verify_to_merge.
#    verify=9m ending 10:31, MERGED at 10:51 (open_to_merge=30m): the verifier
#    started at 10:22, so 1m was spent before it and 20m after it.
CASE=latency-splits-three-stages
R="$T/r8"; S="$T/s8"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -21 -1)"; V="$(sed -n 1p <<<"$ST")"; M="$(sed -n 2p <<<"$ST")"
printf '%s #101 demo verify=9m gate=ran review=ran\n%s #101 demo MERGED open_to_merge=30m\n' \
  "$V" "$M" > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.merged_n 1
eqp latency.24h.verify.n 1
eqp latency.24h.verify.p50 9
eqp latency.24h.verify_to_merge.p50 20
eqp latency.24h.pre_verify.p50 1
eqp latency.24h.n_negative 0
eqp latency.7d.verify_to_merge.p50 20
pass "$CASE"

# 9. Only the last verify before MERGED may be joined: a re-verified head records
#    30m at 09:00 and 9m at 10:31; using the 09:00 line would make the residual
#    negative. verify_to_merge must be 20, verify 9.
CASE=latency-joins-the-last-verify-before-merge
R="$T/r9"; S="$T/s9"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -90 -25 -20 0)"; E="$(sed -n 1p <<<"$ST")"; Q="$(sed -n 2p <<<"$ST")"
V="$(sed -n 3p <<<"$ST")"; M="$(sed -n 4p <<<"$ST")"
printf '%s #102 demo verify=30m gate=ran review=ran\n%s #102 demo verifier_started queue_wait=3m tier=small\n%s #102 demo verify=9m gate=ran review=ran\n%s #102 demo MERGED open_to_merge=30m\n' \
  "$E" "$Q" "$V" "$M" > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.verify.n 1
eqp latency.24h.verify.p50 9
eqp latency.24h.verify_to_merge.p50 20
eqp latency.24h.pre_verify.p50 1
eqp latency.24h.n_negative 0
eqp latency.24h.queue_wait.n 1
eqp latency.24h.queue_wait.p50 3
eqp latency.24h.queue_wait.with_queue_wait 1
pass "$CASE"

# 10. A cached gate pass is its own bucket: it must not move the gate=ran p50.
CASE=latency-cached-gate-not-mixed-into-gate-ran
R="$T/r10"; S="$T/s10"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -21 -11 -1)"; V1="$(sed -n 1p <<<"$ST")"; V2="$(sed -n 2p <<<"$ST")"; M="$(sed -n 3p <<<"$ST")"
printf '%s #201 a verify=9m gate=ran review=ran\n%s #201 a MERGED open_to_merge=30m\n%s #202 b verify=2m gate=cached review=cached\n%s #202 b MERGED open_to_merge=10m\n' \
  "$V1" "$M" "$V2" "$M" > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.verify_gate_ran.n 1
eqp latency.24h.verify_gate_ran.p50 9
eqp latency.24h.verify_gate_cached.n 1
eqp latency.24h.verify_gate_cached.p50 2
pass "$CASE"

# 11. verify + verify_to_merge larger than open_to_merge is rounding noise or a
#     clock skew, not a stage: count it in n_negative, keep it out of pre_verify,
#     and print `-` instead of a negative p50.
CASE=latency-negative-residual-is-reported
R="$T/r11"; S="$T/s11"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -21 -1)"; V="$(sed -n 1p <<<"$ST")"; M="$(sed -n 2p <<<"$ST")"
printf '%s #301 c verify=9m gate=ran review=ran\n%s #301 c MERGED open_to_merge=5m\n' \
  "$V" "$M" > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.n_negative 1
eqp latency.24h.pre_verify.n 0
eqp latency.24h.pre_verify.p50 null
eqp latency.24h.verify.p50 9
LAST="$(python3 "$PACE" --latency --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC";; esac
grep -qE 'pre_verify.*p50=-' <<<"$LAST" || { printf '%s\n' "$LAST" >&2; fail "$CASE: empty pre_verify not '-'"; }
pass "$CASE"

# 12. Empty or malformed cycles.log: every stage is empty (p50 `-`), JSON says
#     n=0, no traceback.
CASE=latency-empty-and-malformed-log
R="$T/r12"; S="$T/s12"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
: > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.merged_n 0
eqp latency.24h.verify.n 0
printf 'garbage\nnot a date #x\n2026-13-99 99:99 #1 m verify=oops\n2026-11-18 00:00 #2 m MERGED open_to_merge=xm\n' \
  > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.merged_n 0
eqp latency.24h.verify.n 0
eqp latency.24h.pre_verify.n 0
eqp latency.7d.pre_verify.p50 null
LAST="$(python3 "$PACE" --latency --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC";; esac
grep -qi 'traceback' <<<"$LAST" && { printf '%s\n' "$LAST" >&2; fail "$CASE: traceback"; }
grep -qE 'pre_verify.*p50=-' <<<"$LAST" || { printf '%s\n' "$LAST" >&2; fail "$CASE: human stage line"; }
pass "$CASE"

# 13. Without --latency the output is exactly today's: same five lines, same
#     JSON keys, no latency parsing visible. A state with verify/queue lines and
#     one with only the same MERGED line must render identically (modulo the
#     phase clock), so the flag alone decides the extra output.
CASE=latency-default-output-unchanged
R="$T/r13"; S="$T/s13"; S0="$T/s13-nolat"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge" "$S0/merge"
ST="$(stamps -21 -1)"; V="$(sed -n 1p <<<"$ST")"; M="$(sed -n 2p <<<"$ST")"
printf '%s #401 d verify=9m gate=ran review=ran\n%s #401 d MERGED open_to_merge=30m\n' \
  "$V" "$M" > "$S/merge/cycles.log"
# Same MERGED line, no verify/queue lines: the legacy open->merge line must not move.
printf '%s #401 d MERGED open_to_merge=30m\n' "$M" > "$S0/merge/cycles.log"
run_json "$R" "$S"
eq latency '<missing>'
KEYS="$(printf '%s' "$LAST" | python3 -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin))))')"
WANT_KEYS="commits,last_release_at,last_release_sha,latency_n,merges_24h,merges_7d,merges_today,p50_open_to_merge_m,p90_open_to_merge_m,phase,phase_hours_left,phase_target,release_min,unshipped,unshipped_source,verdict"
[ "$KEYS" = "$WANT_KEYS" ] || { printf '%s\n' "$LAST" >&2; fail "$CASE: JSON keys changed: $KEYS"; }
OUT="$(python3 "$PACE" --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$OUT" >&2; fail "$CASE: pace exited $RC";; esac
OUT0="$(python3 "$PACE" --repo "$R" --state "$S0" 2>&1)"
norm() { sed -E 's/left=[0-9.]+h/left=Hh/' <<<"$1"; }
[ "$(norm "$OUT")" = "$(norm "$OUT0")" ] \
  || { printf '%s\n--- no cycles.log ---\n%s\n' "$OUT" "$OUT0" >&2; fail "$CASE: default output depends on --latency data"; }
WANT_HEAD='merges: 24h=0 7d=0 today=0
open->merge: p50=30m p90=30m (n=1, 24h)
release: last None at None, unshipped=0/5'
[ "$(printf '%s\n' "$OUT0" | sed -n '1,3p')" = "$WANT_HEAD" ] \
  || { printf '%s\n' "$OUT0" >&2; fail "$CASE: default lines changed"; }
[ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = 5 ] \
  || { printf '%s\n' "$OUT" >&2; fail "$CASE: default output grew a line"; }
printf '%s\n' "$OUT0" | sed -n '4p' | grep -qE '^phase: \S+ target=[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} left=[0-9.]+h$' \
  || { printf '%s\n' "$OUT0" >&2; fail "$CASE: phase line shape"; }
printf '%s\n' "$OUT0" | sed -n '5p' | grep -q '^pace verdict: BEHIND (0 merges/24h vs min 20)$' \
  || { printf '%s\n' "$OUT0" >&2; fail "$CASE: verdict line changed"; }
grep -qE 'pre_verify|verify_to_merge|latency by stage' <<<"$OUT" \
  && { printf '%s\n' "$OUT" >&2; fail "$CASE: latency text leaked into default output"; }
pass "$CASE"

echo "all cases passed"
