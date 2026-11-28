#!/bin/bash
# test-pace.sh — pace.py's `unshipped` must be the release gate's number, not a
# clock-minute guess. release-check.sh counts PR subjects between the older
# `state/last_release` marker and origin/main; pace used to count merged.log lines
# newer than the release timestamp, so a PR that landed in the release minute read
# as shipped while the gate still held it (2026-11-18 00:16: gate 1, pace 0).
#
# Hermetic: temp git repos, temp state, fixed identities and dates, no network.
# Prints "PASS <case>" per case; exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
# The default threshold is what this suite proves; a caller's export (the CEO fill runs with
# RSI_RELEASE_MIN=1) must not stand in for it.
unset RSI_RELEASE_MIN
HERE="$(cd "$(dirname "$0")" && pwd)"
PACE="$HERE/../pace.py"
CHECK="$HERE/../release-check.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

# run_case <case> — skip unless RSI_TEST_ONLY names it. red_first.py proves a claim by
# reverting pace.py and running one case, so an earlier red must not stand in for the
# case the claim names.
ONLY="${RSI_TEST_ONLY:-}"; MATCHED=0
run_case() {
  [ -z "$ONLY" ] && return 0
  [ "$1" = "$ONLY" ] && { MATCHED=1; return 0; }
  return 1
}

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

# run_json_tz <tz> <repo> <state> [extra pace args...] — run_json with the caller's
# clock under <tz>, so a case can prove the report does not follow the host clock.
run_json_tz() {
  local tz="$1" repo="$2" state="$3"; shift 3
  LAST="$(TZ="$tz" python3 "$PACE" --json --repo "$repo" --state "$state" "$@" 2>&1)"; RC=$?
  case "$RC" in
    0|3) ;;
    *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC under TZ=$tz" ;;
  esac
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

# jgeti <dotted.path> — jgetp with numeric parts indexing lists, so a case can
# read concurrency.24h.levels.0.n directly.
jgeti() {
  printf '%s' "$LAST" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("<invalid-json>"); raise SystemExit
cur = d
for part in sys.argv[1].split("."):
    try:
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    except (KeyError, IndexError, ValueError):
        print("<missing>"); raise SystemExit
if cur is None:
    print("null")
elif isinstance(cur, (dict, list)):
    print(json.dumps(cur, sort_keys=True))
else:
    print(cur)
' "$1"
}

# eqi <dotted.path> <want> — eq with list indices allowed.
eqi() {
  local got; got="$(jgeti "$1")"
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

# sg_stamp <offset-min> — `YYYY-MM-DD HH:MM` at <offset-min> on the loop's own +08
# clock (rsi/runtime/common.sh:3). stamps() is ambient-TZ, so it cannot describe the
# loop's day; the day-boundary cases below use this and literal strings.
sg_stamp() {
  TZ=Asia/Singapore python3 - "$1" <<'PY'
import sys, time
off = int(sys.argv[1])
print(time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() + off * 60)))
PY
}

# 24. The threshold is the gate's, not a hard-coded 5: with RSI_RELEASE_MIN unset pace
#     reports the gate's default of 1, and over the same docs-only range the gate and pace
#     report the same unshipped count. Runs first so the red-first seam, which reverts
#     pace.py and runs this suite, fails on a line that names this case.
CASE="pace: release_min follows the gate and defaults to 1"
if run_case "$CASE"; then
R="$T/r24"; S="$T/s24"; new_repo "$R"
mkdir -p "$R/docs"; printf 'x\n' > "$R/docs/x.md"; git -C "$R" add docs/x.md
git -C "$R" commit -q -m "docs: x (#801)"
origin_main "$R" HEAD
BASE="$(git -C "$R" rev-parse HEAD~1)"
mkdir -p "$S"; printf 'node=%s\nhub=%s\n' "$BASE" "$BASE" > "$S/last_release"
run_json "$R" "$S"
eq release_min 1
eq unshipped 0
eq commits 1
GATE="$(env RSI_RELEASE_STATE="$S" RSI_REPO="$R" KIN_API=http://127.0.0.1:9 \
  KIN_TOKEN_FILE="$T/no-token" RSI_FETCH_TIMEOUT=2 bash "$CHECK" 2>&1)" || true
GATE_UNSHIPPED="$(printf '%s\n' "$GATE" | sed -n 's/^unshipped=\([0-9][0-9]*\) .*/\1/p')"
[ "$GATE_UNSHIPPED" = "$(jget unshipped)" ] \
  || { printf '%s\n' "$GATE" >&2; fail "$CASE: gate unshipped=$GATE_UNSHIPPED, pace=$(jget unshipped)"; }
pass "$CASE"
fi

# 1. A PR merged in the same minute as the release is still unshipped: the gate counts
#    commits, not clock minutes. Red before this change (pace said 0).
CASE=t_same_minute_merge_is_unshipped
if run_case "$CASE"; then
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
fi

# 2. The older marker is the baseline by ancestry, not by line order: node at base,
#    hub at head, two visible commits after base.
CASE=t_older_marker_wins
if run_case "$CASE"; then
R="$T/r2"; S="$T/s2"; new_repo "$R"
commit "$R" "feat(a): one (#101)"
commit "$R" "fix(b): two"
origin_main "$R" HEAD
BASE="$(git -C "$R" rev-parse HEAD~2)"
HEAD_SHA="$(git -C "$R" rev-parse HEAD)"
mkdir -p "$S"
printf 'node=%s\nhub=%s\n' "$BASE" "$HEAD_SHA" > "$S/last_release"
run_json "$R" "$S"
eq unshipped 2
eq commits 2
eq unshipped_source git
pass "$CASE"
fi

# 2b. Ancestry decides, not file order (the older marker may be listed second). Every
#     commit here touches a file that is not non-shipped, so all three count — the
#     subject text, including a mid-sentence (#99), no longer decides anything.
CASE=t_ancestry_beats_line_order
if run_case "$CASE"; then
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
eq unshipped 3
eq commits 3
eq unshipped_source git
pass "$CASE"
fi

# 3. No marker: the old merged.log count still answers, and the JSON says so.
CASE=t_no_marker_falls_back_to_merged_log
if run_case "$CASE"; then
R="$T/r3"; S="$T/s3"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf '2026-11-18 00:10 merged #237 a R-a aaaa\n2026-11-18 00:16 merged #238 b R-b bbbb\n' > "$S/merged.log"
run_json "$R" "$S"
eq unshipped 2
eq unshipped_source merged.log
pass "$CASE"
fi

# 4. A marker but no origin/main (fresh or offline checkout): fall back, do not crash.
CASE=t_missing_origin_main_falls_back
if run_case "$CASE"; then
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
fi

# 5. A marker that is not a commit here is treated as absent, not as a baseline.
CASE=t_unreadable_marker_falls_back
if run_case "$CASE"; then
R="$T/r5"; S="$T/s5"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf 'node=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$S/last_release"
printf '2026-11-18 00:16 merged #238 a R-a aaaa\n2026-11-18 00:20 merged #239 b R-b bbbb\n' > "$S/merged.log"
run_json "$R" "$S"
eq unshipped 2
eq unshipped_source merged.log
pass "$CASE"
fi

# 6. pace stays local: the patrol does the fetching, the script does not.
CASE=t_pace_does_not_fetch
if run_case "$CASE"; then
if grep -nE 'fetch|http' "$PACE" >/dev/null; then
  grep -nE 'fetch|http' "$PACE" >&2
  fail "$CASE: pace.py must not fetch or do network I/O"
fi
pass "$CASE"
fi

# 7. The human line keeps its shape for every existing reader.
CASE=t_human_line_shape
if run_case "$CASE"; then
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
fi

# 8. --latency splits open->merge into pre_verify / verify / verify_to_merge.
#    verify=9m ending 10:31, MERGED at 10:51 (open_to_merge=30m): the verifier
#    started at 10:22, so 1m was spent before it and 20m after it.
CASE=latency-splits-three-stages
if run_case "$CASE"; then
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
fi

# 9. Every verify run before MERGED is summed: a re-verified head records 30m at
#    09:00 and 9m at 10:31. verify is 39m, verify_to_merge is the last line's
#    20m, so the residual is 30-39-20 = -29: reported as n_negative, not as a
#    negative stage (the old last-only join reported verify 9m / pre_verify 1m
#    and hid the 30m run).
CASE=latency-sums-every-verify-before-merge
if run_case "$CASE"; then
R="$T/r9"; S="$T/s9"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -90 -25 -20 0)"; E="$(sed -n 1p <<<"$ST")"; Q="$(sed -n 2p <<<"$ST")"
V="$(sed -n 3p <<<"$ST")"; M="$(sed -n 4p <<<"$ST")"
printf '%s #102 demo verify=30m gate=ran review=ran\n%s #102 demo verifier_started queue_wait=3m tier=small\n%s #102 demo verify=9m gate=ran review=ran\n%s #102 demo MERGED open_to_merge=30m\n' \
  "$E" "$Q" "$V" "$M" > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.verify.n 1
eqp latency.24h.verify_runs 2
eqp latency.24h.verify.p50 39
eqp latency.24h.verify.max 39
eqp latency.24h.verify_to_merge.p50 20
eqp latency.24h.n_negative 1
eqp latency.24h.pre_verify.n 0
eqp latency.24h.pre_verify.p50 null
eqp latency.24h.verify_gate_ran.n 2
eqp latency.24h.verify_gate_ran.max 30
eqp latency.24h.queue_wait.n 1
eqp latency.24h.queue_wait.p50 3
eqp latency.24h.queue_wait.with_queue_wait 1
pass "$CASE"
fi

# 9b. Two runs with a non-negative residual: 10m gate=ran ends at -35 and 5m
#     gate=cached at -20, MERGED at 0 with open_to_merge=45m. verify sums to
#     15m, land is 20m, so pre_verify is 10m — not the 20m a last-only join
#     would leave. Each run lands in its own gate bucket.
CASE=latency-two-runs-feed-pre-verify
if run_case "$CASE"; then
R="$T/r9b"; S="$T/s9b"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -35 -20 0)"; V1="$(sed -n 1p <<<"$ST")"; V2="$(sed -n 2p <<<"$ST")"; M="$(sed -n 3p <<<"$ST")"
printf '%s #103 e verify=10m gate=ran review=ran\n%s #103 e verify=5m gate=cached review=cached\n%s #103 e MERGED open_to_merge=45m\n' \
  "$V1" "$V2" "$M" > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.verify.n 1
eqp latency.24h.verify_runs 2
eqp latency.24h.verify.p50 15
eqp latency.24h.verify_to_merge.p50 20
eqp latency.24h.pre_verify.p50 10
eqp latency.24h.n_negative 0
eqp latency.24h.verify_gate_ran.p50 10
eqp latency.24h.verify_gate_cached.p50 5
pass "$CASE"
fi

# 10. A cached gate pass is its own bucket: it must not move the gate=ran p50.
CASE=latency-cached-gate-not-mixed-into-gate-ran
if run_case "$CASE"; then
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
fi

# 11. verify + verify_to_merge larger than open_to_merge is rounding noise or a
#     clock skew, not a stage: count it in n_negative, keep it out of pre_verify,
#     and print `-` instead of a negative p50.
CASE=latency-negative-residual-is-reported
if run_case "$CASE"; then
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
fi

# 12. Empty or malformed cycles.log: every stage is empty (p50 `-`), JSON says
#     n=0, no traceback.
CASE=latency-empty-and-malformed-log
if run_case "$CASE"; then
R="$T/r12"; S="$T/s12"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
: > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.merged_n 0
eqp latency.24h.verify.n 0
# An unparseable date on a MERGED line is the crash latencies() used to take:
# the default path must skip it, not traceback.
printf 'garbage\nnot a date #x\n2026-13-99 99:99 #1 m verify=oops\n2026-13-99 99:99 #1 m MERGED open_to_merge=5m\n2026-11-18 00:00 #2 m MERGED open_to_merge=xm\n' \
  > "$S/merge/cycles.log"
run_json "$R" "$S" --latency
eqp latency.24h.merged_n 0
eqp latency.24h.verify.n 0
eqp latency.24h.verify_runs 0
eqp latency.24h.pre_verify.n 0
eqp latency.7d.pre_verify.p50 null
run_json "$R" "$S"
eq latency_n 0
grep -qi 'traceback' <<<"$LAST" && { printf '%s\n' "$LAST" >&2; fail "$CASE: traceback on default path"; }
LAST="$(python3 "$PACE" --latency --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC";; esac
grep -qi 'traceback' <<<"$LAST" && { printf '%s\n' "$LAST" >&2; fail "$CASE: traceback"; }
grep -qE 'pre_verify.*p50=-' <<<"$LAST" || { printf '%s\n' "$LAST" >&2; fail "$CASE: human stage line"; }
pass "$CASE"
fi

# 13. Without --latency the output is exactly today's: same known lines, same
#     JSON keys, no latency parsing visible. A state with verify/queue lines and
#     one with only the same MERGED line must render identically (modulo the
#     phase clock), so the flag alone decides the extra output.
CASE=latency-default-output-unchanged
if run_case "$CASE"; then
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
WANT_KEYS="commits,day_tz,last_release_at,last_release_sha,latency_n,merges_24h,merges_7d,merges_today,p50_open_to_merge_m,p90_open_to_merge_m,phase,phase_hours_left,phase_target,release_min,unshipped,unshipped_source,verdict"
[ "$KEYS" = "$WANT_KEYS" ] || { printf '%s\n' "$LAST" >&2; fail "$CASE: JSON keys changed: $KEYS"; }
OUT="$(python3 "$PACE" --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$OUT" >&2; fail "$CASE: pace exited $RC";; esac
OUT0="$(python3 "$PACE" --repo "$R" --state "$S0" 2>&1)"
norm() { sed -E 's/left=[0-9.]+h/left=Hh/' <<<"$1"; }
[ "$(norm "$OUT")" = "$(norm "$OUT0")" ] \
  || { printf '%s\n--- no cycles.log ---\n%s\n' "$OUT" "$OUT0" >&2; fail "$CASE: default output depends on --latency data"; }
WANT_HEAD='merges: 24h=0 7d=0 today=0 (day=+08)
open->merge: p50=30m p90=30m (n=1, 24h)
release: last None at None, unshipped=0/1'
[ "$(printf '%s\n' "$OUT0" | sed -n '1,3p')" = "$WANT_HEAD" ] \
  || { printf '%s\n' "$OUT0" >&2; fail "$CASE: default lines changed"; }
# The phase line comes from the live rsi/GOAL.md, which this test does not
# control (and whose target may have passed), so assert the output's shape
# rather than a phase state: only known line prefixes, and the verdict last.
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
[ "$LINES" -ge 4 ] && [ "$LINES" -le 5 ] \
  || { printf '%s\n' "$OUT" >&2; fail "$CASE: default output has $LINES lines"; }
UNKNOWN="$(printf '%s\n' "$OUT" | grep -vcE '^(merges: |open->merge: |release: |phase: \S+ target=[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} left=-?[0-9.]+h$|pace verdict: )')"
[ "$UNKNOWN" = 0 ] \
  || { printf '%s\n' "$OUT" >&2; fail "$CASE: unknown default line"; }
printf '%s\n' "$OUT" | tail -n 1 | grep -q '^pace verdict: ' \
  || { printf '%s\n' "$OUT" >&2; fail "$CASE: verdict is not the last line"; }
grep -qE 'pre_verify|verify_to_merge|latency by stage' <<<"$OUT" \
  && { printf '%s\n' "$OUT" >&2; fail "$CASE: latency text leaked into default output"; }
pass "$CASE"
fi

# 14. Two 6m gate=ran runs ending the same minute share the whole interval, so
#     each sees one other run: both land at level 2, and the duration table is
#     the pair (p50 6m), not two level-1 singletons.
CASE=concurrency-two-overlapping-runs-bucket-as-2
if run_case "$CASE"; then
R="$T/r14"; S="$T/s14"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
END="$(stamps -6)"
printf '%s #101 a verify=6m gate=ran review=ran\n%s #102 b verify=6m gate=ran review=ran\n' \
  "$END" "$END" > "$S/merge/cycles.log"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.runs 2
eqi concurrency.24h.bucketed 2
eqi concurrency.24h.cached 0
eqi concurrency.24h.levels.0.level 2
eqi concurrency.24h.levels.0.n 2
eqi concurrency.24h.levels.0.p50 6
eqi concurrency.24h.levels.0.tiers.unknown 2
pass "$CASE"
fi

# 15. A 5m gate=ran run alone is level 1; verify=0m lines are not durations even
#     when gate=ran (one is cached, one is ran here), so they count in cached and
#     must not enter the duration bucket. A zero-length interval cannot overlap
#     the solo run, so the level alone would miss a `dur >= 0` regression; the
#     bucketed/n pair pins it.
CASE=concurrency-solo-run-buckets-as-1-and-cached-runs-are-not-bucketed
if run_case "$CASE"; then
R="$T/r15"; S="$T/s15"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -5 -4 -3)"; V="$(sed -n 1p <<<"$ST")"; C="$(sed -n 2p <<<"$ST")"; Z="$(sed -n 3p <<<"$ST")"
printf '%s #201 a verify=5m gate=ran review=ran\n%s #202 b verify=0m gate=cached review=cached\n%s #203 c verify=0m gate=ran review=ran\n' \
  "$V" "$C" "$Z" > "$S/merge/cycles.log"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.runs 3
eqi concurrency.24h.bucketed 1
eqi concurrency.24h.cached 2
eqi concurrency.24h.levels.0.level 1
eqi concurrency.24h.levels.0.n 1
eqi concurrency.24h.levels.0.p50 5
eqi concurrency.24h.levels.0.max 5
pass "$CASE"
fi

# 16. Overlap is the whole interval, not the start minute. A ran 10:00-10:20
#     (20m, ends -10); B ran 10:19-10:25 (6m, ends -9). B starts inside A's
#     interval but not at A's start minute, so an implementation that compares
#     only starts reports two level-1 runs.
CASE=concurrency-overlap-uses-the-whole-interval-not-just-the-start
if run_case "$CASE"; then
R="$T/r16"; S="$T/s16"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -10 -9)"; A="$(sed -n 1p <<<"$ST")"; B="$(sed -n 2p <<<"$ST")"
printf '%s #301 a verify=20m gate=ran review=ran\n%s #302 b verify=6m gate=ran review=ran\n' \
  "$A" "$B" > "$S/merge/cycles.log"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.levels.0.level 2
eqi concurrency.24h.levels.0.n 2
eqi concurrency.24h.levels.0.p50 6
eqi concurrency.24h.levels.0.p90 20
pass "$CASE"
fi

# 17. Tier comes from the latest verifier_started at or before the verify line,
#     not the first one. One PR starts small at -30 and large at -10; the run
#     ending -25 is small, the run ending -6 is large. Pairing with the first
#     start would report two small runs.
CASE=concurrency-tiers-come-from-the-latest-start-per-pr
if run_case "$CASE"; then
R="$T/r17"; S="$T/s17"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -30 -25 -10 -6)"
S1="$(sed -n 1p <<<"$ST")"; V1="$(sed -n 2p <<<"$ST")"
S2="$(sed -n 3p <<<"$ST")"; V2="$(sed -n 4p <<<"$ST")"
printf '%s #401 a verifier_started queue_wait=0m tier=small\n%s #401 a verify=5m gate=ran review=ran\n%s #401 a verifier_started queue_wait=0m tier=large\n%s #401 a verify=4m gate=ran review=ran\n' \
  "$S1" "$V1" "$S2" "$V2" > "$S/merge/cycles.log"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.levels.0.level 1
eqi concurrency.24h.levels.0.n 2
eqi concurrency.24h.levels.0.tiers.small 1
eqi concurrency.24h.levels.0.tiers.large 1
eqi concurrency.24h.levels.0.tiers.unknown 0
pass "$CASE"
fi

# 18. No readable cycles.log (missing, then a directory where the file should
#     be): zero runs and an empty level list, never a made-up bucket and never
#     a traceback.
CASE=concurrency-missing-log-reports-zero-not-a-number
if run_case "$CASE"; then
R="$T/r18"; S="$T/s18"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.runs 0
eqi concurrency.24h.bucketed 0
eqi concurrency.24h.cached 0
eqi concurrency.24h.levels '[]'
eqi concurrency.7d.levels '[]'
rmdir "$S/merge"; mkdir -p "$S/merge/cycles.log"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.runs 0
eqi concurrency.24h.levels '[]'
LAST="$(python3 "$PACE" --concurrency --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$LAST" >&2; fail "$CASE: pace exited $RC";; esac
grep -q '^concurrency by verifier overlap, 24h (runs=0 bucketed=0 cached=0;' <<<"$LAST" \
  || { printf '%s\n' "$LAST" >&2; fail "$CASE: empty-window header"; }
grep -qi 'traceback' <<<"$LAST" \
  && { printf '%s\n' "$LAST" >&2; fail "$CASE: traceback"; }
pass "$CASE"
fi

# 19. The flag is additive. No flag and --latency keep exactly their old JSON
#     keys and human lines; --concurrency adds one JSON key and one text block
#     after the verdict, and does not change a line above it. The two runs here
#     do not overlap (A ends -20, B starts -9), so both are level 1; the
#     touching-endpoint rule is pinned by case 20.
CASE=concurrency-flag-leaves-default-and-latency-output-alone
if run_case "$CASE"; then
R="$T/r19"; S="$T/s19"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -20 -5 -1)"
V1="$(sed -n 1p <<<"$ST")"; V2="$(sed -n 2p <<<"$ST")"; M="$(sed -n 3p <<<"$ST")"
printf '%s #501 a verify=15m gate=ran review=ran\n%s #502 b verify=4m gate=ran review=ran\n%s #501 a MERGED open_to_merge=25m\n' \
  "$V1" "$V2" "$M" > "$S/merge/cycles.log"
keys() { printf '%s' "$LAST" | python3 -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin))))'; }
run_json "$R" "$S"
KEYS_N="$(keys)"
eq concurrency '<missing>'
eqp latency '<missing>'
OUT_N="$(python3 "$PACE" --repo "$R" --state "$S" 2>&1)"
run_json "$R" "$S" --latency
KEYS_L="$(keys)"
eq concurrency '<missing>'
eqp latency.24h.merged_n 1
OUT_L="$(python3 "$PACE" --latency --repo "$R" --state "$S" 2>&1)"
run_json "$R" "$S" --concurrency
KEYS_C="$(keys)"
eqp latency '<missing>'
EXPECT_L="$(python3 -c 'import sys; print(",".join(sorted(set(sys.argv[1].split(",")) | {"latency"})))' "$KEYS_N")"
EXPECT_C="$(python3 -c 'import sys; print(",".join(sorted(set(sys.argv[1].split(",")) | {"concurrency"})))' "$KEYS_N")"
[ "$KEYS_L" = "$EXPECT_L" ] || { printf '%s\n' "$LAST" >&2; fail "$CASE: --latency JSON keys: $KEYS_L"; }
[ "$KEYS_C" = "$EXPECT_C" ] || { printf '%s\n' "$LAST" >&2; fail "$CASE: --concurrency JSON keys: $KEYS_C"; }
eqi concurrency.24h.runs 2
eqi concurrency.24h.levels.0.level 1
OUT_C="$(python3 "$PACE" --concurrency --repo "$R" --state "$S" 2>&1)"
norm() { sed -E 's/left=[0-9.]+h/left=Hh/' <<<"$1"; }
N="$(printf '%s\n' "$OUT_N" | wc -l | tr -d ' ')"
[ "$(norm "$(printf '%s\n' "$OUT_C" | sed -n "1,${N}p")")" = "$(norm "$OUT_N")" ] \
  || { printf '%s\n--- with flag ---\n%s\n' "$OUT_N" "$OUT_C" >&2; fail "$CASE: --concurrency moved the default lines"; }
[ "$(norm "$(printf '%s\n' "$OUT_L" | sed -n "1,${N}p")")" = "$(norm "$OUT_N")" ] \
  || { printf '%s\n--- latency ---\n%s\n' "$OUT_N" "$OUT_L" >&2; fail "$CASE: --latency moved the default lines"; }
grep -q 'concurrency by verifier overlap' <<<"$OUT_N$OUT_L" \
  && { printf '%s\n' "$OUT_L" >&2; fail "$CASE: concurrency text leaked into no-flag/--latency output"; }
grep -q '^concurrency by verifier overlap, 24h (runs=2 bucketed=2 cached=0;' <<<"$OUT_C" \
  || { printf '%s\n' "$OUT_C" >&2; fail "$CASE: concurrency header"; }
grep -q '^  level 1  n=2 p50=4m p90=15m max=15m tiers=small:0 medium:0 large:0 unknown:2$' <<<"$OUT_C" \
  || { printf '%s\n' "$OUT_C" >&2; fail "$CASE: concurrency level line"; }
pass "$CASE"
fi

# 20. Runs whose intervals merely touch do not overlap: A 5m ending -5 spans
#     [-10,-5], B 3m ending -2 spans [-5,-2]; minute -5 is both A's end and B's
#     start. An inclusive comparison (start2 <= end and end2 >= start) makes
#     both overlap and buckets them at level 2.
CASE=concurrency-touching-endpoints-do-not-overlap
if run_case "$CASE"; then
R="$T/r20"; S="$T/s20"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S/merge"
ST="$(stamps -5 -2)"; A="$(sed -n 1p <<<"$ST")"; B="$(sed -n 2p <<<"$ST")"
printf '%s #601 a verify=5m gate=ran review=ran\n%s #602 b verify=3m gate=ran review=ran\n' \
  "$A" "$B" > "$S/merge/cycles.log"
run_json "$R" "$S" --concurrency
eqi concurrency.24h.runs 2
eqi concurrency.24h.bucketed 2
eqi concurrency.24h.levels.0.level 1
eqi concurrency.24h.levels.0.n 2
pass "$CASE"
fi

# --- The loop's day is +08 (rsi/runtime/common.sh:3). Every stamp pace.py compares
# against — merged.log, merge/cycles.log, GOAL.md's phase target — is written in +08, so
# `today`, the 24h edge and the phase clock must be the same report on any host. Brief
# measurement, 2026-11-23 11:44 +08: 28 merges today under +08, 42 under EST (13 h behind,
# so the EST run reported the +08 yesterday as today).

# 21. A merge stamped at the current +08 minute is "today" on every host: the same
#     fixture read under two host TZs must produce the same report. phase_hours_left is
#     the one field that moves between the two invocations (it is measured from the live
#     GOAL.md target), so it is compared for closeness, not equality; a marker missing from
#     both runs (the loop's normal closed-phase state) is not a difference either.
CASE=t_today_is_the_plus08_day_under_any_host_tz
if run_case "$CASE"; then
R="$T/r21"; S="$T/s21"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf '%s merged #701 tz R-tz aaaa\n' "$(sg_stamp 0)" > "$S/merged.log"
# A second row 25 h back on the +08 clock: outside the 24 h window on the loop's day, but
# only 12 h back to a New York clock, so a host-clock NOW pulls it in and merges_24h moves
# even at +08 hours where `today` happens to agree. This keeps the case red without a live
# `<!-- phase: -->` line in GOAL.md.
printf '%s merged #704 tz R-tz bbbb\n' "$(sg_stamp -1500)" >> "$S/merged.log"
run_json_tz America/New_York "$R" "$S"
eq merges_today 1
eq merges_24h 1
EST_JSON="$LAST"
run_json_tz Asia/Singapore "$R" "$S"
eq merges_today 1
SG_JSON="$LAST"
SAME="$(python3 - "$EST_JSON" "$SG_JSON" <<'PY'
import json, sys
a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pa = a.pop("phase_hours_left", None)
pb = b.pop("phase_hours_left", None)
if a != b:
    print("objects differ: %r vs %r" % (a, b)); raise SystemExit
if (pa is None) != (pb is None) or (pa is not None and abs(pa - pb) > 0.5):
    print("phase clock differs: %r vs %r" % (pa, pb)); raise SystemExit
print("same")
PY
)"
[ "$SAME" = same ] || fail "$CASE: $SAME"
pass "$CASE"
fi

# 22. The 42-vs-28 shape: a merge 26 h before the +08 now is neither today nor inside the
#     24 h window on the loop's clock, and a host clock 13 h behind must not pull it back
#     into either.
CASE=t_plus08_yesterday_is_not_today
if run_case "$CASE"; then
R="$T/r22"; S="$T/s22"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf '%s merged #702 tz R-tz aaaa\n' "$(sg_stamp -1560)" > "$S/merged.log"
for CALLER_TZ in America/New_York Asia/Singapore; do
  run_json_tz "$CALLER_TZ" "$R" "$S"
  eq merges_today 0
  eq merges_24h 0
done
pass "$CASE"
fi

# 23. The boundary is named where a person reads it: the default `merges:` line and the
#     --json object both say +08, even when the caller's shell says otherwise.
CASE=t_output_names_the_day_boundary
if run_case "$CASE"; then
R="$T/r23"; S="$T/s23"; new_repo "$R"; origin_main "$R" HEAD
mkdir -p "$S"
printf '%s merged #703 tz R-tz aaaa\n' "$(sg_stamp 0)" > "$S/merged.log"
run_json_tz UTC "$R" "$S"
eq day_tz +08
eq merges_today 1
OUT="$(TZ=UTC python3 "$PACE" --repo "$R" --state "$S" 2>&1)"; RC=$?
case "$RC" in 0|3) ;; *) printf '%s\n' "$OUT" >&2; fail "$CASE: pace exited $RC";; esac
grep -qE '^merges: 24h=1 7d=1 today=1 \(day=\+08\)$' <<<"$OUT" \
  || { printf '%s\n' "$OUT" >&2; fail "$CASE: default merges line does not name +08"; }
pass "$CASE"
fi

[ -z "$ONLY" ] || [ "$MATCHED" = 1 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo "all cases passed"
