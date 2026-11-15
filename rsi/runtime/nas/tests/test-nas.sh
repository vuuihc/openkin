#!/bin/bash
# test-nas.sh — regression tests for the Mac-driven NAS ingest path.
# No NAS, no network, no Claude: ssh/scp/gh are fakes in the temp sandbox, and "the NAS" is a
# temp tree (NAS_REMOTE) that remote commands reach because the fake ssh runs the command string locally.
# Each test targets one review finding. Run: bash rsi/runtime/nas/tests/test-nas.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
NASDIR="$(cd "$HERE/.." && pwd)"
INGEST="$NASDIR/ingest-nas.sh"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $*"; }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
finish() { echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; }

# --- sandbox -------------------------------------------------------------------------------------
sandbox() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/nas-test.XXXXXX")
  mkdir -p "$T/bin" "$T/state/cloud" "$T/state/cloud-briefs" "$T/state/nas" "$T/state/lanes" \
           "$T/nas/work/jobs" "$T/nas/work/logs" "$T/wt"
  : > "$T/gh.log"
  printf 'brief\n' > "$T/state/cloud-briefs/brief.md"

  # fake ssh: -n redirects stdin, otherwise stdin is drained like real ssh; the command string runs locally.
  cat > "$T/bin/ssh" <<'EOS'
#!/bin/bash
export PATH="$(dirname "$0"):$PATH"
n=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2; continue;;
    -n) n=1; shift; continue;;
    -*) shift; continue;;
    *) break;;
  esac
done
shift || true            # host
cmd="$*"
[ "$n" = 1 ] || cat >/dev/null
exec bash -c "$cmd"
EOS

  # fake scp: translates host:path to the temp tree; supports several sources + a destination.
  cat > "$T/bin/scp" <<'EOS'
#!/bin/bash
[ "${FAKE_SCP_FAIL:-0}" = 1 ] && exit 1
a=(); for x in "$@"; do [ "$x" = "-q" ] || a+=("$x"); done
n=${#a[@]}; dst="${a[$((n-1))]}"
case "$dst" in *:*) dst="${dst#*:}";; esac
for i in $(seq 0 $((n-2))); do
  src="${a[$i]}"
  case "$src" in *:*) src="${src#*:}";; esac
  cp "$src" "$dst"
done
EOS

  # fake gh: no PR unless FAKE_PR is set; a list prints "NUMBER<TAB>FAKE_PR_HEAD"; create/edit log.
  cat > "$T/bin/gh" <<'EOS'
#!/bin/bash
case "$*" in
  *"pr list"*) [ -n "${FAKE_PR:-}" ] && printf '%s\t%s\n' "$FAKE_PR" "${FAKE_PR_HEAD:-}"; exit 0;;
  *"pr create"*) echo "$*" >> "${FAKE_GHLOG:?}"; echo "https://example.invalid/pull/$(wc -l < "$FAKE_GHLOG" | tr -d ' ')"; exit 0;;
  *"pr edit"*) echo "$*" >> "${FAKE_GHEDIT:?}"; exit 0;;
esac
exit 0
EOS

  # fake heavy.sh: -ok execs the command it is given; -crash fails before writing anything; -partial
  # writes a truncated log and dies (an interrupted self-check must not read as green).
  printf '#!/bin/bash\nexec "$@"\n' > "$T/bin/heavy-ok"
  printf '#!/bin/bash\nexit 1\n' > "$T/bin/heavy-crash"
  printf '#!/bin/bash\nprintf "== tsc\\n" > "$FAKE_SELFCHECK_LOG"\nexit 137\n' > "$T/bin/heavy-partial"
  chmod +x "$T/bin/"*

  git init -q -b main "$T/ctrl"
  git -C "$T/ctrl" config user.email test@example.com
  git -C "$T/ctrl" config user.name test
  mkdir -p "$T/ctrl/docs"; echo base > "$T/ctrl/docs/base.md"
  git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm base
  git init -q --bare "$T/origin.git"
  git -C "$T/ctrl" remote add origin "$T/origin.git"
  git -C "$T/ctrl" push -q origin main
}

run_ingest() { # T [extra env...]
  local T="$1"; shift
  env NAS_STATE="$T/state" NAS_CTRL="$T/ctrl" NAS_REMOTE="$T/nas" NAS_WT_ROOT="$T/wt" \
      NAS_SSH="$T/bin/ssh" NAS_SCP="$T/bin/scp" NAS_GH="$T/bin/gh" \
      FAKE_GHLOG="$T/gh.log" FAKE_GHEDIT="$T/gh-edit.log" \
      NAS_NO_MERGE=1 NAS_SELFCHECK_CMD=true "$@" bash "$INGEST"
}
claim_as() { # T SLUG ITEM TAKER LAUNCHED_AT
  printf '{"slug":"%s","item":"%s","brief":"%s","paths":["docs"],"status":"launched","taker":"%s","launched_at":%s,"claimed_at":%s}\n' \
    "$2" "$3" "$1/state/cloud-briefs/brief.md" "$4" "${5:-0}" "${5:-0}" > "$1/state/cloud/$2.json"
}
job_record() { # T SLUG ITEM REF STARTED_AT [LAUNCHED_AT] — write the remote record + bundle for a branch
  local T="$1" slug="$2" item="$3" ref="$4" started="$5" launch="${6:-}"
  local base head jb
  base="$(git -C "$T/ctrl" rev-parse main)"; head="$(git -C "$T/ctrl" rev-parse "$ref")"
  jb="$T/nas/work/jobs/$slug"; mkdir -p "$jb"
  if [ -n "$launch" ]; then
    printf '{"item":"%s","paths":["docs"],"launched_at":%s,"brief":"b"}\n' "$item" "$launch" > "$jb/job.json"
  else
    printf '{"item":"%s","paths":["docs"],"brief":"b"}\n' "$item" > "$jb/job.json"
  fi
  printf '{"status":"done","slug":"%s","started_at":%s,"updated_at":%s,"base":"%s","pr_title":"feat: %s"}\n' \
    "$slug" "$started" "$started" "$base" "$slug" > "$jb/status.json"
  git -C "$T/ctrl" bundle create "$jb/bundle" "main..$ref" >/dev/null
  echo "$head"
}
job_failed() { # T SLUG ITEM NOTE [STARTED_AT] [LAUNCHED_AT]
  local T="$1" slug="$2" item="$3" note="$4" started="${5:-1700000200}" launch="${6:-}"
  local jb="$T/nas/work/jobs/$slug"; mkdir -p "$jb"
  if [ -n "$launch" ]; then
    printf '{"item":"%s","paths":["docs"],"launched_at":%s,"brief":"b"}\n' "$item" "$launch" > "$jb/job.json"
  else
    printf '{"item":"%s","paths":["docs"],"brief":"b"}\n' "$item" > "$jb/job.json"
  fi
  printf '{"status":"failed","slug":"%s","started_at":%s,"updated_at":%s,"note":"%s"}\n' \
    "$slug" "$started" "$started" "$note" > "$jb/status.json"
}
job() { # T SLUG ITEM visible(0|1)
  local T="$1" slug="$2" item="$3" vis="$4"
  git -C "$T/ctrl" checkout -q -B "rsi/$slug" main
  if [ "$vis" = 1 ]; then mkdir -p "$T/ctrl/ui/src"; echo "export const x = 1" > "$T/ctrl/ui/src/Thing.tsx"
  else echo note > "$T/ctrl/docs/$slug.md"; fi
  git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm "feat: $slug"
  local head; head="$(job_record "$T" "$slug" "$item" "rsi/$slug" 1700000000)"
  git -C "$T/ctrl" checkout -q main
  echo "$head"
}
jget() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2"; }

# --- T2: ingest twice does the work once (M4) -----------------------------------------------------
t_ingest_twice() {
  local T; sandbox; T=$T
  job "$T" s1 R-T-2 0 >/dev/null
  run_ingest "$T" > "$T/ingest1.log" 2>&1
  check "M4 first ingest opens a PR" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
  check "M4 first ingest writes one history row" [ "$(ls "$T/state/lanes/history" | wc -l | tr -d ' ')" = 1 ]
  check "M4 remote job marked ingested" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = ingested ]
  check "M4 run identity acked" grep -q '^s1:done:1700000000$' "$T/state/nas/acks.txt"
  run_ingest "$T" > "$T/ingest2.log" 2>&1
  check "M4 second ingest does no work" grep -q 'no finished NAS jobs' "$T/ingest2.log"
  check "M4 second ingest writes no history" [ "$(ls "$T/state/lanes/history" | wc -l | tr -d ' ')" = 1 ]
  check "M4 second ingest opens no PR" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
  # Even if the remote record is re-listed with the same identity, the ack stops a repeat.
  printf '{"status":"done","slug":"s1","started_at":1700000000,"updated_at":1700000000,"base":"%s","pr_title":"feat: s1"}\n' \
    "$(git -C "$T/ctrl" rev-parse main)" > "$T/nas/work/jobs/s1/status.json"
  run_ingest "$T" > "$T/ingest3.log" 2>&1
  check "M4 acked identity is never re-ingested" [ "$(ls "$T/state/lanes/history" | wc -l | tr -d ' ')" = 1 ]
}

# --- T6: existing linked worktree is reused and verified; a failed add stops publishing (M7) -----
t_worktree_recovery() {
  local T; sandbox; T=$T
  local head; head="$(job "$T" s1 R-T-6 0)"
  git -C "$T/ctrl" worktree add -q -B rsi/s1 "$T/wt/rsi-s1" main
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M7 existing linked worktree is reused" [ "$(git -C "$T/wt/rsi-s1" rev-parse HEAD)" = "$head" ]
  check "M7 reuse still opens the PR" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
  # A worktree that cannot be created must stop before push/PR.
  local T2; sandbox; T2=$T
  job "$T2" s2 R-T-6 0 >/dev/null
  : > "$T2/blocked"                       # a regular file where the parent dir must be
  run_ingest "$T2" NAS_WT_ROOT="$T2/blocked" > "$T2/ingest2.log" 2>&1
  check "M7 failed worktree add is reported" grep -q 'worktree add failed' "$T2/ingest2.log"
  check "M7 failed worktree add publishes nothing" [ ! -s "$T2/gh.log" ]
}

# --- T7: visible UI without shots is held, not published (M9) ------------------------------------
t_screenshot_hold() {
  local T; sandbox; T=$T
  job "$T" s1 R-T-7 1 >/dev/null
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M9 visible UI with no shots opens no PR" [ ! -s "$T/gh.log" ]
  check "M9 branch is still pushed" test -n "$(git -C "$T/origin.git" rev-parse --verify -q refs/heads/rsi/s1)"
  check "M9 hold instructions written" test -s "$T/state/nas/hold/s1.md"
  check "M9 remote job marked held" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = held ]
  check "M9 CEO is told once" [ "$(grep -c 'held for screenshots' "$T/state/needs-ceo.md")" = 1 ]
  run_ingest "$T" > "$T/ingest2.log" 2>&1
  check "M9 a second run repeats nothing" [ "$(grep -c 'held for screenshots' "$T/state/needs-ceo.md")" = 1 ]
}

# --- T10: release only touches a claim this NAS run still owns (M3) -----------------------------
t_release_ownership() {
  local T; sandbox; T=$T
  claim_as "$T" boxed R-T-10a box 1700000300
  job_failed "$T" boxed R-T-10a "container start failed" 1700000300
  claim_as "$T" moved R-T-10b nas 1700000300
  job_failed "$T" moved R-T-10b "worker died" 1700000400 1700000400   # claim stamp moved on: a newer NAS run
  claim_as "$T" ours R-T-10c nas 1700000500
  job_failed "$T" ours R-T-10c "worker died" 1700000500 1700000500
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M3 another executor's claim is untouched" [ "$(jget "$T/state/cloud/boxed.json" taker)" = box ]
  check "M3 another NAS run's claim is untouched" [ "$(jget "$T/state/cloud/moved.json" taker)" = nas ]
  check "M3 its own failed claim is released" test ! -e "$T/state/cloud/ours.json"
  check "M3 the released claim is archived" test -e "$T/state/cloud/expired/ours.json"
  check "M3 the notice does not claim a foreign release" grep -q 'claim kept by its current owner' "$T/state/needs-ceo.md"
  check "M3 all three terminal records are consumed" python3 -c "
import sys
for s in ('boxed','moved','ours'):
    import json; d=json.load(open('$T/nas/work/jobs/%s/status.json'%s))
    assert d['status']=='ingested', (s,d['status'])
"
  # A finished result whose claim box now owns is never published.
  local T2; sandbox; T2=$T
  claim_as "$T2" late R-T-10d box 1700000600
  git -C "$T2/ctrl" checkout -q -B rsi/late main; echo note > "$T2/ctrl/docs/late.md"
  git -C "$T2/ctrl" add -A; git -C "$T2/ctrl" commit -qm "feat: late"
  job_record "$T2" late R-T-10d rsi/late 1700000600 1700000600 >/dev/null
  git -C "$T2/ctrl" checkout -q main
  run_ingest "$T2" > "$T2/ingest.log" 2>&1
  check "M3 a finished result on another executor's claim is not published" [ ! -s "$T2/gh.log" ]
  check "M3 it is reported, not silently dropped" grep -q "no longer this NAS run's" "$T2/ingest.log"
  check "M3 the foreign claim is still there" [ "$(jget "$T2/state/cloud/late.json" taker)" = box ]
}

# --- T11: an existing worktree is only fast-forwarded when it is clean and unchanged (M4) --------
t_worktree_ownership() {
  local T; sandbox; T=$T
  job "$T" s1 R-T-11 0 >/dev/null
  git -C "$T/ctrl" worktree add -q -B rsi/s1 "$T/wt/rsi-s1" rsi/s1
  echo later > "$T/wt/rsi-s1/docs/later.md"
  git -C "$T/wt/rsi-s1" add -A; git -C "$T/wt/rsi-s1" commit -qm "fix: rework commit"
  local later; later="$(git -C "$T/wt/rsi-s1" rev-parse HEAD)"
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "M4 commits added after the NAS result are not reset" [ "$(git -C "$T/wt/rsi-s1" rev-parse HEAD)" = "$later" ]
  check "M4 a diverged worktree publishes nothing" [ ! -s "$T/gh.log" ]
  check "M4 the divergence is reported" grep -q 'commits the NAS bundle does not contain' "$T/i1.log"

  local T2; sandbox; T2=$T
  job "$T2" s2 R-T-11b 0 >/dev/null
  git -C "$T2/ctrl" worktree add -q -B rsi/s2 "$T2/wt/rsi-s2" rsi/s2
  echo dirty >> "$T2/wt/rsi-s2/docs/s2.md"
  run_ingest "$T2" > "$T2/i2.log" 2>&1
  check "M4 uncommitted edits survive" grep -q dirty "$T2/wt/rsi-s2/docs/s2.md"
  check "M4 a dirty worktree publishes nothing" [ ! -s "$T2/gh.log" ]
  check "M4 the dirty worktree is reported" grep -q 'uncommitted changes' "$T2/i2.log"
}

# --- T12: a self-check is green only when it ran to completion (M5) -----------------------------
t_selfcheck_completion() {
  local T; sandbox; T=$T
  job "$T" s1 R-T-12a 0 >/dev/null
  run_ingest "$T" NAS_SELFCHECK_CMD= NAS_HEAVY="$T/bin/heavy-crash" > "$T/i1.log" 2>&1
  check "M5 a crashed heavy run is not green" grep -q 'self-check failing' "$T/i1.log"
  check "M5 the failure is recorded" grep -q 'self-check did not finish' "$T/state/nas/xfer/s1/selfcheck.txt"

  local T2; sandbox; T2=$T
  job "$T2" s2 R-T-12b 0 >/dev/null
  run_ingest "$T2" NAS_SELFCHECK_CMD= NAS_HEAVY="$T2/bin/heavy-partial" \
    FAKE_SELFCHECK_LOG="$T2/state/nas/xfer/s2/selfcheck.txt" > "$T2/i2.log" 2>&1
  check "M5 an interrupted self-check is not green" grep -q 'self-check failing' "$T2/i2.log"
  check "M5 the truncated log has no completion marker" bash -c "! grep -q 'selfcheck complete' '$T2/state/nas/xfer/s2/selfcheck.txt'"

  local T3; sandbox; T3=$T
  job "$T3" s3 R-T-12c 0 >/dev/null
  run_ingest "$T3" NAS_SELFCHECK_CMD= NAS_HEAVY="$T3/bin/heavy-ok" \
    NAS_SELFCHECK_TSC=false NAS_SELFCHECK_INV=true NAS_SELFCHECK_VITEST=true > "$T3/i3.log" 2>&1
  check "M5 a failing check is not green" grep -q 'self-check failing' "$T3/i3.log"
  check "M5 the failing check is named" grep -qx 'TSC-FAIL' "$T3/state/nas/xfer/s3/selfcheck.txt"

  local T4; sandbox; T4=$T
  job "$T4" s4 R-T-12d 0 >/dev/null
  run_ingest "$T4" NAS_SELFCHECK_CMD= NAS_HEAVY="$T4/bin/heavy-ok" \
    NAS_SELFCHECK_TSC=true NAS_SELFCHECK_INV=true NAS_SELFCHECK_VITEST=true > "$T4/i4.log" 2>&1
  check "M5 a completed self-check is green" grep -q 'self-check green' "$T4/i4.log"
  check "M5 the log carries the completion marker" grep -qx '== selfcheck complete' "$T4/state/nas/xfer/s4/selfcheck.txt"
  check "M5 the history row says green" grep -q '"selfcheck": "green"' "$T4/state/lanes/history"/*.json
}

# --- T13: visible UI needs two real captures; the worker's base is not trusted (M6) -------------
t_shot_validation() {
  local T; sandbox; T=$T
  local head; head="$(job "$T" s1 R-T-13a 1)"
  python3 - "$T/nas/work/jobs/s1/status.json" "$head" <<'PY'   # worker claims a base that hides its change
import json,sys
p,b=sys.argv[1:3]; d=json.load(open(p)); d['base']=b; json.dump(d,open(p,'w'))
PY
  job "$T" s2 R-T-13b 1 >/dev/null
  mkdir -p "$T/state/shots/s2"
  python3 - "$T/state/shots/s2" <<'PY'                        # one real capture, one text file
import sys,os
open(os.path.join(sys.argv[1],'before-390x844.png'),'wb').write(b'\x89PNG\r\n\x1a\n'+b'\0'*4096)
open(os.path.join(sys.argv[1],'after-1100x760.png'),'w').write('not an image')
PY
  job "$T" s3 R-T-13c 1 >/dev/null
  mkdir -p "$T/state/shots/s3"
  python3 - "$T/state/shots/s3" <<'PY'                        # both widths, both real
import sys,os
for n in ('before-390x844.png','after-1100x760.png'):
    open(os.path.join(sys.argv[1],n),'wb').write(b'\x89PNG\r\n\x1a\n'+b'\0'*4096)
PY
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M6 a worker-supplied base cannot hide a visible change" test -s "$T/state/nas/hold/s1.md"
  check "M6 one capture plus a text file is not enough" test -s "$T/state/nas/hold/s2.md"
  check "M6 held slices open no PR" bash -c "[ \$(wc -l < '$T/gh.log') -eq 1 ]"
  check "M6 two real captures at both widths publish" grep -q 'ingested R-T-13c s3' "$T/ingest.log"
  check "M6 the published branch is on origin" test -n "$(git -C "$T/origin.git" rev-parse --verify -q refs/heads/rsi/s3)"
}

# --- T14: an existing PR receives the new result, and divergence is held, not discarded (M7) -----
t_existing_pr() {
  local T; sandbox; T=$T
  local h1; h1="$(job "$T" s1 R-T-14a 0)"
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "M7 first ingest publishes its commit" [ "$(git -C "$T/origin.git" rev-parse refs/heads/rsi/s1)" = "$h1" ]

  # A later NAS run of the same slice, committed on top of the published branch in its own worktree.
  echo more >> "$T/wt/rsi-s1/docs/s1.md"
  git -C "$T/wt/rsi-s1" add -A; git -C "$T/wt/rsi-s1" commit -qm "feat: s1 more"
  local h2; h2="$(git -C "$T/wt/rsi-s1" rev-parse HEAD)"
  job_record "$T" s1 R-T-14a rsi/s1 1700000900 >/dev/null
  run_ingest "$T" FAKE_PR=1 FAKE_PR_HEAD="$h1" > "$T/i2.log" 2>&1
  check "M7 an existing PR receives the new commit" [ "$(git -C "$T/origin.git" rev-parse refs/heads/rsi/s1)" = "$h2" ]
  check "M7 the reused PR body is refreshed" test -s "$T/gh-edit.log"
  check "M7 the second result is a separate history row" [ "$(ls "$T/state/lanes/history" | wc -l | tr -d ' ')" = 2 ]

  local T2; sandbox; T2=$T
  local a1; a1="$(job "$T2" s1 R-T-14b 0)"
  run_ingest "$T2" > "$T2/i1.log" 2>&1            # PR #1, origin at a1
  git -C "$T2/ctrl" worktree remove --force "$T2/wt/rsi-s1"
  git -C "$T2/ctrl" checkout -q -B rsi/s1 main
  echo rewritten > "$T2/ctrl/docs/other.md"; git -C "$T2/ctrl" add -A; git -C "$T2/ctrl" commit -qm "feat: elsewhere"
  job_record "$T2" s1 R-T-14b rsi/s1 1700001000 >/dev/null
  git -C "$T2/ctrl" checkout -q main
  run_ingest "$T2" FAKE_PR=1 FAKE_PR_HEAD="$a1" > "$T2/i2.log" 2>&1
  check "M7 a diverged branch is not overwritten" [ "$(git -C "$T2/origin.git" rev-parse refs/heads/rsi/s1)" = "$a1" ]
  check "M7 divergence opens no second PR" [ "$(wc -l < "$T2/gh.log" | tr -d ' ')" = 1 ]
  check "M7 divergence is held with a note" test -s "$T2/state/nas/hold/s1.md"
  check "M7 the diverged result is consumed, not retried forever" [ "$(jget "$T2/nas/work/jobs/s1/status.json" status)" = held ]
}

if [ "${1:-}" = "--sandbox" ]; then sandbox; echo "$T"; exit 0; fi
if [ -n "${1:-}" ]; then "$1"; finish; exit $?; fi    # test-nas.sh <function> — one test (mutant runs)

t_ingest_twice
t_worktree_recovery
t_screenshot_hold
t_release_ownership
t_worktree_ownership
t_selfcheck_completion
t_shot_validation
t_existing_pr
finish
