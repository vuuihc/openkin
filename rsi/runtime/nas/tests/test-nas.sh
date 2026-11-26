#!/bin/bash
# test-nas.sh — regression tests for the Mac-driven NAS forward and return paths.
# No NAS, no network, no Claude: ssh/scp/docker/gh are fakes in the temp sandbox, and "the NAS" is a
# temp tree (NAS_REMOTE) that remote commands reach because the fake ssh runs the command string locally.
# The pulse drives bare ssh/scp/docker through PATH, so its sandbox HOME puts the fakes in ~/.local/bin,
# which common.sh keeps on PATH; RSI_CTRL points at a throwaway git repo so no test touches rsi/state.
# Each test targets one review finding. Run: bash rsi/runtime/nas/tests/test-nas.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
NASDIR="$(cd "$HERE/.." && pwd)"
INGEST="$NASDIR/ingest-nas.sh"
PULSE="$NASDIR/pulse-nas.sh"
PASS=0; FAIL=0
SANDBOXES=()

ok()  { PASS=$((PASS+1)); echo "ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $*"; }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
finish() { echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; }
cleanup_sandboxes() { if [ "${#SANDBOXES[@]}" -gt 0 ]; then rm -rf "${SANDBOXES[@]}"; fi; return 0; }
trap cleanup_sandboxes EXIT

# --- sandbox -------------------------------------------------------------------------------------
sandbox() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/nas-test.XXXXXX")
  SANDBOXES+=("$T")
  mkdir -p "$T/bin" "$T/state/cloud" "$T/state/cloud-briefs" "$T/state/nas" "$T/state/lanes" \
           "$T/nas/work/jobs" "$T/nas/work/logs" "$T/wt" "$T/home/.local/bin"
  : > "$T/gh.log"; : > "$T/docker-starts"
  printf 'brief\n' > "$T/state/cloud-briefs/brief.md"

  # fake ssh: -n redirects stdin, otherwise stdin is drained like real ssh; the command string runs locally.
  # The pulse's capacity probe is a python heredoc that reads Linux /proc, so the fake answers it.
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
case "$cmd" in *"/proc/loadavg"*) printf '%s %s\n' "${FAKE_LOAD:-0.10}" "${FAKE_MEM:-12.00}"; exit 0;; esac
exec bash -c "$cmd"
EOS

  # fake scp: translates host:path to the temp tree; supports several sources + a destination.
  cat > "$T/bin/scp" <<'EOS'
#!/bin/bash
[ "${FAKE_SCP_FAIL:-0}" = 1 ] && exit 1
a=(); for x in "$@"; do case "$x" in -q|-O) ;; *) a+=("$x");; esac; done
n=${#a[@]}; dst="${a[$((n-1))]}"
case "$dst" in *:*) dst="${dst#*:}";; esac
for i in $(seq 0 $((n-2))); do
  src="${a[$i]}"
  case "$src" in *:*) src="${src#*:}";; esac
  cp "$src" "$dst"
done
EOS

  # fake docker: inspect reports the container state; exec records the lane start (or fails on demand).
  cat > "$T/bin/docker" <<'EOS'
#!/bin/bash
case "${1:-}" in
  inspect) printf '%s\n' "${FAKE_CONTAINER_UP:-true}"; exit 0;;
  exec)
    [ "${FAKE_START_FAIL:-0}" = 1 ] && exit 1
    printf 'docker %s\n' "$*" >> "${FAKE_STARTS:?}"
    exit 0;;
esac
exit 0
EOS

  # fake gh: no PR unless FAKE_PR is set. Real gh runs `.[0] | "…"` over an empty list and prints
  # "null\tnull" (jq's string form of null), so the fake does too — the seam must not be kinder than gh.
  cat > "$T/bin/gh" <<'EOS'
#!/bin/bash
case "$*" in
  *"pr list"*) if [ -n "${FAKE_PR:-}" ]; then printf '%s\t%s\n' "$FAKE_PR" "${FAKE_PR_HEAD:-}"; else printf 'null\tnull\n'; fi; exit 0;;
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
  printf 'pass\n' > "$T/bin/lanes.py"          # no active local lanes by default
  chmod +x "$T/bin/"*

  git init -q -b main "$T/ctrl"
  git -C "$T/ctrl" config user.email test@example.com
  git -C "$T/ctrl" config user.name test
  mkdir -p "$T/ctrl/docs"; echo base > "$T/ctrl/docs/base.md"
  git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm base
  git init -q --bare "$T/origin.git"
  git -C "$T/ctrl" remote add origin "$T/origin.git"
  git -C "$T/ctrl" push -q origin main

  # The pulse sources common.sh with RSI_CTRL=$T/ctrl, so its state and its helper scripts live there.
  # Stub the budget gate (allow new workers), the ingest half (not under test here) and the PATH fakes.
  mkdir -p "$T/ctrl/rsi/state/cloud" "$T/ctrl/rsi/state/cloud-briefs" "$T/ctrl/rsi/state/nas" \
           "$T/ctrl/rsi/state/lanes" "$T/ctrl/rsi/runtime/nas"
  printf 'brief\n' > "$T/ctrl/rsi/state/cloud-briefs/brief.md"
  printf 'import sys\nsys.exit(0)\n' > "$T/ctrl/rsi/runtime/volc-budget.py"
  printf '#!/bin/bash\nexit 0\n' > "$T/ctrl/rsi/runtime/nas/ingest-nas.sh"
  ln -s "$T/bin/ssh" "$T/home/.local/bin/ssh"
  ln -s "$T/bin/scp" "$T/home/.local/bin/scp"
  ln -s "$T/bin/docker" "$T/home/.local/bin/docker"
}

run_ingest() { # T [extra env...]
  local T="$1"; shift
  env NAS_STATE="$T/state" NAS_CTRL="$T/ctrl" NAS_REMOTE="$T/nas" NAS_WT_ROOT="$T/wt" \
      NAS_SSH="$T/bin/ssh" NAS_SCP="$T/bin/scp" NAS_GH="$T/bin/gh" NAS_LANES_PY="$T/bin/lanes.py" \
      FAKE_GHLOG="$T/gh.log" FAKE_GHEDIT="$T/gh-edit.log" \
      NAS_NO_MERGE=1 NAS_SELFCHECK_CMD=true "$@" bash "$INGEST"
}
run_pulse() { # T [extra env...] — the live pulse has no ssh/scp seams: HOME puts the fakes on common.sh's PATH
  local T="$1"; shift
  env HOME="$T/home" RSI_CTRL="$T/ctrl" NAS_REMOTE="$T/nas" RSI_MAX_OPEN_PRS=0 \
      FAKE_STARTS="$T/docker-starts" "$@" bash "$PULSE"
}
pclaim() { # T SLUG ITEM — an untaken, ready claim in the control tree's state
  printf '{"slug":"%s","item":"%s","brief":"%s","paths":["docs"],"status":"claimed"}\n' \
    "$2" "$3" "$1/ctrl/rsi/state/cloud-briefs/brief.md" > "$1/ctrl/rsi/state/cloud/$2.json"
}
pclaim_as() { # T SLUG ITEM TAKER — a claim already owned by someone else
  printf '{"slug":"%s","item":"%s","brief":"%s","paths":["docs"],"status":"launched","taker":"%s","launched_at":1,"claimed_at":1}\n' \
    "$2" "$3" "$1/ctrl/rsi/state/cloud-briefs/brief.md" "$4" > "$1/ctrl/rsi/state/cloud/$2.json"
}
running_job() { # T SLUG — a remote record the capacity probe counts as running
  mkdir -p "$1/nas/work/jobs/$2"
  printf '{"status":"running","slug":"%s","started_at":%s,"updated_at":%s}\n' \
    "$2" "$(date +%s)" "$(date +%s)" > "$1/nas/work/jobs/$2/status.json"
}
running_job_stale() { # T SLUG — a `running` record left behind by a lane the container recreate killed
  mkdir -p "$1/nas/work/jobs/$2"
  printf '{"status":"running","slug":"%s","started_at":1,"updated_at":1}\n' "$2" > "$1/nas/work/jobs/$2/status.json"
}
fhash() { shasum -a 256 "$1" | awk '{print $1}'; }
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
  local head; head="$(job_record "$T" "$slug" "$item" "rsi/$slug" 1700000000 1700000000)"
  git -C "$T/ctrl" checkout -q main
  echo "$head"
}
jget() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2"; }

# Real image fixtures: correct chunks/CRC and a complete, decompressible pixel stream. CUT drops bytes
# from the end to make a truncated capture.
mkpng() { # PATH W H [CUT]
  python3 - "$@" <<'PY'
import struct,sys,zlib
p,w,h=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
cut=int(sys.argv[4]) if len(sys.argv)>4 else 0
raw=b''.join(b'\0'+b'\0'*(w*4) for _ in range(h))
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
data=(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))
      +chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
open(p,'wb').write(data[:-cut] if cut else data)
PY
}
mkjpeg() { # PATH W H — structurally valid JFIF with a SOF0 frame and EOI
  python3 - "$@" <<'PY'
import struct,sys
p,w,h=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
app=b'\xff\xe0'+struct.pack('>H',16)+b'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'
sof=b'\xff\xc0'+struct.pack('>H',17)+b'\x08'+struct.pack('>HH',h,w)+b'\x03'+b'\x01\x11\x00\x02\x11\x01\x03\x11\x01'
sos=b'\xff\xda'+struct.pack('>H',12)+b'\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00'+b'\0'*1200
open(p,'wb').write(b'\xff\xd8'+app+sof+sos+b'\xff\xd9')
PY
}

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

# --- CG: a prose body the merge gate would send back never becomes a PR (claim gate) -------------
# The NAS ingest is the third entry point for the claim rule. #611 and #618 (2026-11-23) each paid a
# full merge gate plus an independent review for a body-only defect; these cases pin the hold that
# should have caught them before any PR existed.
prose_job() { # T SLUG ITEM PATH — a docs result whose changed path is a prose-assertion path
  local T="$1" slug="$2" item="$3" path="$4"
  git -C "$T/ctrl" checkout -q -B "rsi/$slug" main
  mkdir -p "$T/ctrl/$(dirname "$path")"
  echo "note for $slug" > "$T/ctrl/$path"
  git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm "docs: $slug"
  job_record "$T" "$slug" "$item" "rsi/$slug" 1700000000 1700000000 >/dev/null
  git -C "$T/ctrl" checkout -q main
}

t_claim_gate_holds_missing_check() {
  local T; sandbox; T=$T
  prose_job "$T" s1 R-T-CG-1 docs/plans/s1.md
  printf 'RSI item: R-T-CG-1\n\nSummary\nA sentence with no proof.\n' > "$T/nas/work/jobs/s1/pr-body.md"
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "CG a prose body with no claim check opens no PR" [ ! -s "$T/gh.log" ]
  check "CG no live PR body is edited" [ ! -s "$T/gh-edit.log" ]
  check "CG the hold carries the verdict" grep -q 'CLAIM_FAIL' "$T/state/nas/hold/s1.md"
  check "CG the hold names the body and the publish command" bash -c "grep -q 'pr-body.md' '$T/state/nas/hold/s1.md' && grep -q 'gh pr create' '$T/state/nas/hold/s1.md'"
  check "CG the CEO is told once" [ "$(grep -c 'held for claim check' "$T/state/needs-ceo.md")" = 1 ]
  check "CG the remote job is consumed as held" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = held ]
  check "CG the branch survives on origin" test -n "$(git -C "$T/origin.git" rev-parse --verify -q refs/heads/rsi/s1)"
  run_ingest "$T" > "$T/i2.log" 2>&1
  check "CG a second run repeats nothing" [ "$(grep -c 'held for claim check' "$T/state/needs-ceo.md")" = 1 ]
}

t_claim_gate_publishes_valid_check() {
  local T; sandbox; T=$T
  prose_job "$T" s1 R-T-CG-2 docs/plans/s1.md
  {
    printf 'RSI item: R-T-CG-2\n\nSummary\nA sentence with a source pin.\n\n'
    printf 'Claim check: grep -n "note for s1" docs/plans/s1.md\n'
    printf 'Claim output:\n1:note for s1'
  } > "$T/nas/work/jobs/s1/pr-body.md"       # no trailing newline: the publish-path appends must not join it
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "CG a true claim check passes the gate" grep -q 'claim check ok s1' "$T/i1.log"
  check "CG a true claim check publishes exactly one PR" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
  check "CG no hold is written for a valid claim" [ ! -e "$T/state/nas/hold/s1.md" ]
  check "CG the valid result is consumed as ingested" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = ingested ]
  # The Mac appends its self-check line after the gate; a body whose last line is the claimed output
  # must not swallow it into the claim block, or the merge lane sends back the body the NAS passed.
  check "CG the appended self-check line cannot join the claim block" bash -c \
    "python3 '$NASDIR/../claim_check.py' '$T/wt/rsi-s1' '$T/state/nas/xfer/s1/pr-body.md' '$T/state/nas/xfer/s1/claim-changed.txt' | grep -q '^CLAIM_OK'"
}

t_claim_gate_existing_pr_keeps_body() {
  local T; sandbox; T=$T
  # The open PR's branch already exists on origin at its previous head; the NAS result is one commit on
  # top. Advancing that head under the old body would let merge.sh claim-check a stale body on the new diff.
  git -C "$T/ctrl" push -q origin main:refs/heads/rsi/s2
  local prev; prev="$(git -C "$T/ctrl" rev-parse main)"
  prose_job "$T" s2 R-T-CG-4 docs/plans/s2.md
  printf 'RSI item: R-T-CG-4\n\nSummary\nNo proof.\n' > "$T/nas/work/jobs/s2/pr-body.md"
  run_ingest "$T" FAKE_PR=1 FAKE_PR_HEAD="$prev" > "$T/i1.log" 2>&1
  check "CG an open PR keeps its previous body" [ ! -s "$T/gh-edit.log" ]
  check "CG an open PR keeps its previous head" [ "$(git -C "$T/origin.git" rev-parse refs/heads/rsi/s2)" = "$prev" ]
  check "CG the hold names the open PR and its edit command" grep -q 'gh pr edit 1 --repo' "$T/state/nas/hold/s2.md"
  check "CG the open-PR hold opens no second PR" [ ! -s "$T/gh.log" ]
}

t_claim_gate_no_verdict_holds() {
  local T; sandbox; T=$T
  prose_job "$T" s1 R-T-CG-3 docs/plans/s1.md
  {
    printf 'RSI item: R-T-CG-3\n\n'
    printf 'Claim check: sleep 5\n'
    printf 'Claim output:\nnever printed\n'
  } > "$T/nas/work/jobs/s1/pr-body.md"
  run_ingest "$T" NAS_CLAIM_TIMEOUT=1 > "$T/i1.log" 2>&1
  check "CG an expired claim check opens no PR" [ ! -s "$T/gh.log" ]
  check "CG an expired claim check is a no-verdict hold" grep -q 'NO_VERDICT' "$T/state/nas/hold/s1.md"
  check "CG the expired result is consumed as held" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = held ]
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

# --- T18: a worktree that resolves to the control checkout is refused before any git mutation (M4) -
# Live 2026-11-22 00:40: the control checkout (a symlink into the worktree root) physically pointed
# at a registered lane's worktree directory, checked out on that lane's branch. A NAS result for
# that slug passed every check in sync_worktree (.git present, branch equal, clean, HEAD an
# ancestor of the bundle) and its last line would have run `git merge --ff-only` inside the control
# checkout, swapping the running gate, walker, GOAL.md and live state for a NAS result while every
# status line still read healthy. The guard resolves both paths with Python (macOS has no GNU
# realpath) and refuses before the first git call; a resolution failure fails closed (same shape as
# lane.sh's #563 guard).
case_wt_resolving_to_control_tree_is_refused() {
  local T; sandbox; T=$T
  local head; head="$(job "$T" s1 R-T-18a 0)"
  git -C "$T/ctrl" checkout -q rsi/s1          # control checkout on the lane branch, clean: all four pass
  ln -s "$T/ctrl" "$T/wt/rsi-s1"               # the live topology: the worktree path IS the control tree
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M4 a worktree resolving to the control checkout is refused" grep -q 'resolves to the control checkout' "$T/ingest.log"
  check "M4 the control checkout HEAD is unchanged" [ "$(git -C "$T/ctrl" rev-parse HEAD)" = "$head" ]
  check "M4 the control checkout stays on its branch" [ "$(git -C "$T/ctrl" symbolic-ref --short HEAD)" = rsi/s1 ]
  check "M4 the refused result publishes nothing" [ ! -s "$T/gh.log" ]
  check "M4 the refused result is retried, not acked" bash -c "! grep -q '^s1:done:' '$T/state/nas/acks.txt' 2>/dev/null"
}

# The old CUR_BR != $BR check would refuse this worktree for the wrong reason (detached, not rsi/s2).
# The refusal must be the control-tree one, which pins that the guard runs before the branch check.
case_control_tree_on_another_branch_is_still_refused() {
  local T; sandbox; T=$T
  job "$T" s2 R-T-18b 0 >/dev/null
  git -C "$T/ctrl" checkout -q --detach main
  local before; before="$(git -C "$T/ctrl" rev-parse HEAD)"
  ln -s "$T/ctrl" "$T/wt/rsi-s2"
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M4 the control tree is refused before the branch check" grep -q 'resolves to the control checkout' "$T/ingest.log"
  check "M4 the refusal is not the worktree-branch message" bash -c "! grep -q 'not rsi/s2' '$T/ingest.log'"
  check "M4 a detached control checkout is unchanged" [ "$(git -C "$T/ctrl" rev-parse HEAD)" = "$before" ]
  check "M4 nothing is published from a detached control tree" [ ! -s "$T/gh.log" ]
}

# The negative control: a distinct worktree still fast-forwards and publishes, so the guard is not
# an "always refuse" switch. The worktree starts at main, behind the bundle, so reaching HEAD proves
# the fast-forward actually ran.
case_distinct_worktree_still_syncs() {
  local T; sandbox; T=$T
  local head; head="$(job "$T" s3 R-T-18c 0)"
  git -C "$T/ctrl" worktree add -q -B rsi/s3 "$T/wt/rsi-s3" main
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M4 a distinct worktree is still fast-forwarded" [ "$(git -C "$T/wt/rsi-s3" rev-parse HEAD)" = "$head" ]
  check "M4 a distinct worktree still publishes" grep -q 'ingested R-T-18c s3' "$T/ingest.log"
  check "M4 the published result opens its PR" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
}

# A guard that cannot resolve one side must refuse, not proceed. os.path.realpath does not fail for a
# path that merely does not exist (non-strict default), so the fail-closed branch is exercised through
# the NAS_REALPATH_PY seam: a stub that fails only for the control-checkout argument, leaving the
# worktree side resolvable. The worktree starts at main, behind the bundle, so an unguarded run would
# fast-forward it, which the assertions then see.
case_unresolvable_path_fails_closed() {
  local T; sandbox; T=$T
  job "$T" s4 R-T-18d 0 >/dev/null
  git -C "$T/ctrl" worktree add -q -B rsi/s4 "$T/wt/rsi-s4" main
  local before; before="$(git -C "$T/wt/rsi-s4" rev-parse HEAD)"
  cat > "$T/bin/realpath-ctrl-fails" <<'EOS'
#!/bin/bash
case "${3:-}" in *ctrl*) exit 1;; esac
exec python3 "$@"
EOS
  chmod +x "$T/bin/realpath-ctrl-fails"
  run_ingest "$T" NAS_REALPATH_PY="$T/bin/realpath-ctrl-fails" > "$T/ingest.log" 2>&1
  check "M4 an unresolvable side fails closed" grep -q 'cannot resolve' "$T/ingest.log"
  check "M4 an unresolved worktree is not fast-forwarded" [ "$(git -C "$T/wt/rsi-s4" rev-parse HEAD)" = "$before" ]
  check "M4 nothing is published when resolution fails" [ ! -s "$T/gh.log" ]
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
  mkpng "$T/state/shots/s2/before-390x844.png" 390 844      # one real capture, one text file
  printf 'not an image\n' > "$T/state/shots/s2/after-1100x760.png"
  job "$T" s3 R-T-13c 1 >/dev/null
  mkdir -p "$T/state/shots/s3"
  mkpng "$T/state/shots/s3/before-390x844.png" 390 844       # both sizes, both real
  mkpng "$T/state/shots/s3/after-1100x760.png" 1100 760
  job "$T" s4 R-T-13d 1 >/dev/null
  mkdir -p "$T/state/shots/s4"
  mkpng "$T/state/shots/s4/before-390x844.png" 390 800       # filename lies about its size
  mkpng "$T/state/shots/s4/after-1100x760.png" 1100 760
  job "$T" s5 R-T-13e 1 >/dev/null
  mkdir -p "$T/state/shots/s5"
  mkpng "$T/state/shots/s5/both-390-1100.png" 1100 760       # one file cannot be both widths
  job "$T" s6 R-T-13f 1 >/dev/null
  mkdir -p "$T/state/shots/s6"
  mkpng "$T/state/shots/s6/before-390x844.png" 390 844
  mkpng "$T/state/shots/s6/after-1100x760.png" 1100 760 30   # truncated
  python3 - "$T/state/shots/s6/before-390x844.png" <<'PY'     # corrupt IHDR CRC
import sys
p=sys.argv[1]; d=bytearray(open(p,'rb').read()); d[20]^=0xff; open(p,'wb').write(d)
PY
  job "$T" s7 R-T-13g 1 >/dev/null
  mkdir -p "$T/state/shots/s7"
  mkpng "$T/state/shots/s7/before-390x844.png" 390 844
  mkjpeg "$T/state/shots/s7/after-1100x760.jpg" 1100 760
  run_ingest "$T" > "$T/ingest.log" 2>&1
  check "M6 a worker-supplied base cannot hide a visible change" test -s "$T/state/nas/hold/s1.md"
  check "M6 one capture plus a text file is not enough" test -s "$T/state/nas/hold/s2.md"
  check "M6 a mislabelled size is not evidence" test -s "$T/state/nas/hold/s4.md"
  check "M6 one dual-labelled file is not both widths" test -s "$T/state/nas/hold/s5.md"
  check "M6 a truncated capture is not evidence" test -s "$T/state/nas/hold/s6.md"
  check "M6 held slices open no PR" bash -c "[ \$(wc -l < '$T/gh.log') -eq 2 ]"
  check "M6 two real captures at both widths publish" grep -q 'ingested R-T-13c s3' "$T/ingest.log"
  check "M6 the published branch is on origin" test -n "$(git -C "$T/origin.git" rev-parse --verify -q refs/heads/rsi/s3)"
  check "M6 a real PNG plus a real JPEG publish" grep -q 'ingested R-T-13g s7' "$T/ingest.log"
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
  job_record "$T" s1 R-T-14a rsi/s1 1700000900 1700000900 >/dev/null
  run_ingest "$T" FAKE_PR=1 FAKE_PR_HEAD="$h1" > "$T/i2.log" 2>&1
  check "M7 an existing PR receives the new commit" [ "$(git -C "$T/origin.git" rev-parse refs/heads/rsi/s1)" = "$h2" ]
  check "M7 the reused PR body is refreshed" test -s "$T/gh-edit.log"
  check "M7 the second result is a separate history row" [ "$(ls "$T/state/lanes/history" | wc -l | tr -d ' ')" = 2 ]
  # Two ingests within the same wall-clock second must not collide on the second-stamped filename.
  cat > "$T/bin/fixed-date" <<'EOS'
#!/bin/bash
[ "${1:-}" = "+%Y%m%d-%H%M%S" ] && { echo 20261117-153519; exit 0; }
exec /bin/date "$@"
EOS
  chmod +x "$T/bin/fixed-date"
  echo samesec1 >> "$T/wt/rsi-s1/docs/s1.md"
  git -C "$T/wt/rsi-s1" add -A; git -C "$T/wt/rsi-s1" commit -qm "feat: s1 same second 1"
  local h3; h3="$(git -C "$T/wt/rsi-s1" rev-parse HEAD)"
  job_record "$T" s1 R-T-14a rsi/s1 1700000901 1700000901 >/dev/null
  run_ingest "$T" FAKE_PR=1 FAKE_PR_HEAD="$h2" NAS_DATE="$T/bin/fixed-date" > "$T/i3.log" 2>&1
  echo samesec2 >> "$T/wt/rsi-s1/docs/s1.md"
  git -C "$T/wt/rsi-s1" add -A; git -C "$T/wt/rsi-s1" commit -qm "feat: s1 same second 2"
  job_record "$T" s1 R-T-14a rsi/s1 1700000902 1700000902 >/dev/null
  run_ingest "$T" FAKE_PR=1 FAKE_PR_HEAD="$h3" NAS_DATE="$T/bin/fixed-date" > "$T/i4.log" 2>&1
  check "M7 two ingests in the same second write distinct history rows" [ "$(ls "$T/state/lanes/history"/20261117-153519-s1*.json | wc -l | tr -d ' ')" = 2 ]

  local T2; sandbox; T2=$T
  local a1; a1="$(job "$T2" s1 R-T-14b 0)"
  run_ingest "$T2" > "$T2/i1.log" 2>&1            # PR #1, origin at a1
  git -C "$T2/ctrl" worktree remove --force "$T2/wt/rsi-s1"
  git -C "$T2/ctrl" checkout -q -B rsi/s1 main
  echo rewritten > "$T2/ctrl/docs/other.md"; git -C "$T2/ctrl" add -A; git -C "$T2/ctrl" commit -qm "feat: elsewhere"
  job_record "$T2" s1 R-T-14b rsi/s1 1700001000 1700001000 >/dev/null
  git -C "$T2/ctrl" checkout -q main
  run_ingest "$T2" FAKE_PR=1 FAKE_PR_HEAD="$a1" > "$T2/i2.log" 2>&1
  check "M7 a diverged branch is not overwritten" [ "$(git -C "$T2/origin.git" rev-parse refs/heads/rsi/s1)" = "$a1" ]
  check "M7 divergence opens no second PR" [ "$(wc -l < "$T2/gh.log" | tr -d ' ')" = 1 ]
  check "M7 divergence is held with a note" test -s "$T2/state/nas/hold/s1.md"
  check "M7 the diverged result is consumed, not retried forever" [ "$(jget "$T2/nas/work/jobs/s1/status.json" status)" = held ]
}

# --- T15: an open PR does not receive incoming visible UI without captures (M6b) -----------------
t_existing_pr_shots() {
  local T; sandbox; T=$T
  local h1; h1="$(job "$T" s1 R-T-15a 0)"                   # docs-only first result
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "M6b the docs-only result opens a PR" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
  mkdir -p "$T/wt/rsi-s1/ui/src"; echo "export const y = 2" > "$T/wt/rsi-s1/ui/src/New.tsx"
  git -C "$T/wt/rsi-s1" add -A; git -C "$T/wt/rsi-s1" commit -qm "feat: visible follow-up"
  local h2; h2="$(git -C "$T/wt/rsi-s1" rev-parse HEAD)"
  job_record "$T" s1 R-T-15a rsi/s1 1700001100 1700001100 >/dev/null
  claim_as "$T" s1 R-T-15a nas 1700001100
  run_ingest "$T" FAKE_PR=1 FAKE_PR_HEAD="$h1" > "$T/i2.log" 2>&1
  check "M6b an open PR keeps its previous head" [ "$(git -C "$T/origin.git" rev-parse refs/heads/rsi/s1)" = "$h1" ]
  check "M6b the incoming visible change is held" test -s "$T/state/nas/hold/s1.md"
  check "M6b the hold names the open PR" grep -q 'PR #1' "$T/state/nas/hold/s1.md"
  check "M6b no uncaptured PR body is published" [ ! -s "$T/gh-edit.log" ]
  check "M6b the remote job is consumed as held" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = held ]

  local T2; sandbox; T2=$T
  local g1; g1="$(job "$T2" s2 R-T-15b 0)"
  run_ingest "$T2" > "$T2/i1.log" 2>&1
  mkdir -p "$T2/wt/rsi-s2/ui/src"; echo "export const z = 3" > "$T2/wt/rsi-s2/ui/src/New.tsx"
  git -C "$T2/wt/rsi-s2" add -A; git -C "$T2/wt/rsi-s2" commit -qm "feat: visible follow-up"
  local g2; g2="$(git -C "$T2/wt/rsi-s2" rev-parse HEAD)"
  job_record "$T2" s2 R-T-15b rsi/s2 1700001200 1700001200 >/dev/null
  claim_as "$T2" s2 R-T-15b nas 1700001200
  mkdir -p "$T2/state/shots/s2"
  mkpng "$T2/state/shots/s2/before-390x844.png" 390 844
  mkpng "$T2/state/shots/s2/after-1100x760.png" 1100 760
  run_ingest "$T2" FAKE_PR=1 FAKE_PR_HEAD="$g1" > "$T2/i2.log" 2>&1
  check "M6b the same transition publishes with captures" [ "$(git -C "$T2/origin.git" rev-parse refs/heads/rsi/s2)" = "$g2" ]
  check "M6b the captured PR body is refreshed" test -s "$T2/gh-edit.log"
}

# --- T16: a missing or mismatched run identity releases and publishes nothing (M3) ---------------
t_claim_identity() {
  local T; sandbox; T=$T
  claim_as "$T" noident R-T-16a nas 1700001300
  job_failed "$T" noident R-T-16a "worker died" 1700001300              # job.json has no launched_at
  claim_as "$T" notransfer R-T-16b nas 1700001400
  job_failed "$T" notransfer R-T-16b "worker died" 1700001400
  rm "$T/nas/work/jobs/notransfer/job.json"                             # transfer failed
  printf '{"slug":"nostamp","item":"R-T-16c","brief":"b","paths":["docs"],"status":"launched","taker":"nas"}\n' \
    > "$T/state/cloud/nostamp.json"
  job_failed "$T" nostamp R-T-16c "worker died" 1700001500 1700001500   # claim has no stamp
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "M3 a missing job identity does not release" test -e "$T/state/cloud/noident.json"
  check "M3 a failed job-metadata transfer does not release" test -e "$T/state/cloud/notransfer.json"
  check "M3 a claim without a stamp is not released" test -e "$T/state/cloud/nostamp.json"
  check "M3 the missing-identity reason is reported" grep -q 'R-T-16a noident failed:.*no valid run identity' "$T/state/needs-ceo.md"
  check "M3 the missing-transfer reason is reported" grep -q 'notransfer failed:.*no valid run identity' "$T/state/needs-ceo.md"
  check "M3 a foreign-stamp release is reported" grep -q 'R-T-16c nostamp failed:.*claim kept by its current owner' "$T/state/needs-ceo.md"

  # A finished result with no job metadata is never published.
  local T2; sandbox; T2=$T
  claim_as "$T2" late R-T-16d nas 1700001600
  git -C "$T2/ctrl" checkout -q -B rsi/late main; echo note > "$T2/ctrl/docs/late.md"
  git -C "$T2/ctrl" add -A; git -C "$T2/ctrl" commit -qm "feat: late"
  job_record "$T2" late R-T-16d rsi/late 1700001600 1700001600 >/dev/null
  rm "$T2/nas/work/jobs/late/job.json"
  git -C "$T2/ctrl" checkout -q main
  run_ingest "$T2" > "$T2/i2.log" 2>&1
  check "M3 a finished result without identity is not published" [ -z "$(git -C "$T2/origin.git" rev-parse --verify -q refs/heads/rsi/late)" ]
  check "M3 it is reported, not silently dropped" grep -q 'no valid run identity for late' "$T2/i2.log"
  check "M3 its claim is untouched" test -e "$T2/state/cloud/late.json"
}

# --- T17: the worktree mutation is owned and never resets a newer branch (M4) --------------------
t_worktree_lock() {
  local T; sandbox; T=$T
  job "$T" s1 R-T-17a 0 >/dev/null
  mkdir -p "$T/state/merge/s1.lock"
  sleep 300 & local pid=$!; echo "$pid" > "$T/state/merge/s1.lock/pid"
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "M4 a live merge worker owns the worktree" grep -q 'merge worker owns s1' "$T/i1.log"
  check "M4 nothing is published while the merge lock is live" [ ! -s "$T/gh.log" ]
  check "M4 the locked job is retried, not acked" bash -c "! grep -q '^s1:done:' '$T/state/nas/acks.txt' 2>/dev/null"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -rf "$T/state/merge/s1.lock"
  run_ingest "$T" > "$T/i2.log" 2>&1
  check "M4 the retry publishes after the lock clears" grep -q 'ingested R-T-17a s1' "$T/i2.log"

  local T2; sandbox; T2=$T
  job "$T2" s2 R-T-17b 0 >/dev/null
  mkdir -p "$T2/state/merge/s2.lock"; echo 999999 > "$T2/state/merge/s2.lock/pid"
  run_ingest "$T2" > "$T2/i1.log" 2>&1
  check "M4 a stale merge lock is reclaimed" grep -q 'ingested R-T-17b s2' "$T2/i1.log"

  local T3; sandbox; T3=$T
  job "$T3" s3 R-T-17c 0 >/dev/null
  git -C "$T3/ctrl" checkout -q -B rsi/s3 main
  echo later > "$T3/ctrl/docs/later.md"; git -C "$T3/ctrl" add -A; git -C "$T3/ctrl" commit -qm "fix: later"
  local later; later="$(git -C "$T3/ctrl" rev-parse rsi/s3)"
  git -C "$T3/ctrl" checkout -q main
  run_ingest "$T3" > "$T3/i1.log" 2>&1
  check "M4 an existing branch is never re-pointed" [ "$(git -C "$T3/ctrl" rev-parse rsi/s3)" = "$later" ]
  check "M4 the later branch is reported" grep -q 'branch rsi/s3 has commits the NAS bundle does not contain' "$T3/i1.log"
  check "M4 the later branch publishes nothing" [ ! -s "$T3/gh.log" ]

  local T4; sandbox; T4=$T
  job "$T4" s4 R-T-17d 0 >/dev/null
  printf 'print("s4")\n' > "$T4/bin/lanes-s4.py"
  run_ingest "$T4" NAS_LANES_PY="$T4/bin/lanes-s4.py" > "$T4/i1.log" 2>&1
  check "M4 an active local lane keeps its worktree" grep -q 'local lane is active on s4' "$T4/i1.log"
  check "M4 the active lane's slug publishes nothing" [ ! -s "$T4/gh.log" ]

  local T5; sandbox; T5=$T
  job "$T5" s5 R-T-17e 0 >/dev/null
  mkdir -p "$T5/state/merge/s5.lock"                 # no pid yet: cannot be proven stale
  run_ingest "$T5" > "$T5/i1.log" 2>&1
  check "M4 a lock without a pid is not stolen" grep -q 'merge worker owns s5' "$T5/i1.log"
  check "M4 the pid-less lock publishes nothing" [ ! -s "$T5/gh.log" ]
}

# --- P1: a claim someone else owns is never touched (pulse) ----------------------------------------
t_pulse_skips_taken() {
  local T; sandbox; T=$T
  pclaim_as "$T" boxed R-P-1a box
  pclaim_as "$T" ours R-P-1b nas
  local box_hash nas_hash
  box_hash="$(fhash "$T/ctrl/rsi/state/cloud/boxed.json")"
  nas_hash="$(fhash "$T/ctrl/rsi/state/cloud/ours.json")"
  run_pulse "$T" > "$T/p.log" 2>&1
  check "P1 a box claim is byte-identical" [ "$(fhash "$T/ctrl/rsi/state/cloud/boxed.json")" = "$box_hash" ]
  check "P1 another NAS claim is byte-identical" [ "$(fhash "$T/ctrl/rsi/state/cloud/ours.json")" = "$nas_hash" ]
  check "P1 no lane starts for a taken claim" [ ! -s "$T/docker-starts" ]
  check "P1 the pulse reports no untaken briefs" grep -q 'no untaken cloud briefs' "$T/p.log"
}

# --- P2: one untaken claim becomes exactly one lane start (pulse) ---------------------------------
t_pulse_starts_once() {
  local T; sandbox; T=$T
  pclaim "$T" s1 R-P-2a
  run_pulse "$T" > "$T/p1.log" 2>&1
  check "P2 exactly one docker exec starts the lane" [ "$(grep -c 'nas-lane\.sh s1' "$T/docker-starts")" = 1 ]
  check "P2 the start names the container and the lane script" grep -q 'docker exec .*kin-rsi-nas-worker /bin/bash /opt/rsi/nas-lane\.sh s1' "$T/docker-starts"
  check "P2 the claim is owned by nas" [ "$(jget "$T/ctrl/rsi/state/cloud/s1.json" taker)" = nas ]
  check "P2 the claim is marked launched" [ "$(jget "$T/ctrl/rsi/state/cloud/s1.json" status)" = launched ]
  check "P2 launched_at is a number" python3 -c "import json,sys;d=json.load(open(sys.argv[1]));assert isinstance(d['launched_at'],(int,float))" "$T/ctrl/rsi/state/cloud/s1.json"
  check "P2 the shipped brief is on the NAS" test -s "$T/nas/work/jobs/s1/job.json"
  check "P2 the origin/main bundle is on the NAS" test -s "$T/nas/work/jobs/s1/origin-main.bundle"
  check "P2 the starter status is queued" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = queued ]
  check "P2 one starts.log row is written" [ "$(wc -l < "$T/ctrl/rsi/state/nas/starts.log" | tr -d ' ')" = 1 ]
  run_pulse "$T" > "$T/p2.log" 2>&1
  check "P2 a second pulse does not start the same claim again" [ "$(grep -c 'nas-lane\.sh s1' "$T/docker-starts")" = 1 ]
  check "P2 a second pulse writes no second start row" [ "$(wc -l < "$T/ctrl/rsi/state/nas/starts.log" | tr -d ' ')" = 1 ]
}

# --- P3: a container that is down stops the pulse before any claim (pulse) -------------------------
t_pulse_container_down() {
  local T; sandbox; T=$T
  pclaim "$T" s1 R-P-3a
  local before; before="$(fhash "$T/ctrl/rsi/state/cloud/s1.json")"
  run_pulse "$T" FAKE_CONTAINER_UP=false > "$T/p.log" 2>&1; local rc=$?
  check "P3 the pulse exits 0" [ "$rc" = 0 ]
  check "P3 nothing is claimed" [ "$(fhash "$T/ctrl/rsi/state/cloud/s1.json")" = "$before" ]
  check "P3 no lane starts" [ ! -s "$T/docker-starts" ]
  check "P3 the log names the container" grep -q 'container not running' "$T/p.log"
}

# --- P4: capacity stands the pulse down under load or with every slot busy (pulse) ----------------
t_pulse_capacity() {
  local T; sandbox; T=$T
  pclaim "$T" s1 R-P-4a
  running_job "$T" r1; running_job "$T" r2
  run_pulse "$T" NAS_MAX_LANES=2 > "$T/p1.log" 2>&1
  check "P4 two running jobs fill both lanes" grep -q 'allowed=2 running=2 idle_slots=0' "$T/p1.log"
  check "P4 no lane starts when every slot is busy" [ ! -s "$T/docker-starts" ]
  check "P4 the claim is left for a later pulse" [ -z "$(jget "$T/ctrl/rsi/state/cloud/s1.json" taker)" ]

  local T2; sandbox; T2=$T
  pclaim "$T2" s2 R-P-4b
  run_pulse "$T2" NAS_MAX_LANES=2 FAKE_LOAD=5.00 > "$T2/p2.log" 2>&1
  check "P4 load 5 stands the pulse down even with idle slots" grep -q 'under pressure' "$T2/p2.log"
  check "P4 no lane starts under pressure" [ ! -s "$T2/docker-starts" ]
  check "P4 the claim is left under pressure" [ -z "$(jget "$T2/ctrl/rsi/state/cloud/s2.json" taker)" ]

  local T3; sandbox; T3=$T
  pclaim "$T3" s3 R-P-4c
  running_job "$T3" fresh
  running_job_stale "$T3" stale
  run_pulse "$T3" NAS_MAX_LANES=2 > "$T3/p3.log" 2>&1
  check "P4 a stale running record does not consume a lane" grep -q 'allowed=2 running=1 idle_slots=1' "$T3/p3.log"
  check "P4 the stale record is logged" grep -q 'skip stale running record stale' "$T3/p3.log"
  check "P4 the freed slot starts a lane" [ "$(grep -c 'nas-lane\.sh s3' "$T3/docker-starts")" = 1 ]
}

# --- P5: a live pulse lock is owned by its pid, not deleted by a second pulse (pulse) ------------
t_pulse_lock_ownership() {
  local T; sandbox; T=$T
  pclaim "$T" s1 R-P-5a
  mkdir -p "$T/ctrl/rsi/state/nas/.pulse.lock"
  sleep 300 & local pid=$!
  echo "$pid" > "$T/ctrl/rsi/state/nas/.pulse.lock/pid"
  run_pulse "$T" > "$T/p.log" 2>&1; local rc=$?
  check "P5 the second pulse exits 0" [ "$rc" = 0 ]
  check "P5 it reports the running owner" grep -q "already running pid $pid" "$T/p.log"
  check "P5 the live lock is left in place" [ "$(cat "$T/ctrl/rsi/state/nas/.pulse.lock/pid")" = "$pid" ]
  check "P5 nothing is claimed while another pulse runs" [ -z "$(jget "$T/ctrl/rsi/state/cloud/s1.json" taker)" ]
  check "P5 no lane starts" [ ! -s "$T/docker-starts" ]
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  rm -rf "$T/ctrl/rsi/state/nas/.pulse.lock"
}

# --- P6: a start that fails returns the brief instead of burning the slot for 5 h (pulse) --------
# Before this PR the live pulse ignored docker exec's status: the claim stayed taker=nas with no
# worker and only expired after RSI_NAS_CLAIM_HOURS (5 h). The release below is dd141408's behaviour,
# restored under the same state/lanes flock and bounded by NAS_MAX_START_FAILS.
t_pulse_start_failure() {
  local T; sandbox; T=$T
  pclaim "$T" s1 R-P-6a
  run_pulse "$T" FAKE_START_FAIL=1 > "$T/p1.log" 2>&1
  check "P6 a failed start records no lane start" [ ! -s "$T/docker-starts" ]
  check "P6 a failed start releases the claim" [ -z "$(jget "$T/ctrl/rsi/state/cloud/s1.json" taker)" ]
  check "P6 a failed start counts the failure" [ "$(jget "$T/ctrl/rsi/state/cloud/s1.json" nas_start_failures)" = 1 ]
  check "P6 the failure reason is kept on the claim" grep -q 'container start failed' "$T/ctrl/rsi/state/cloud/s1.json"
  check "P6 the remote job is marked failed" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = failed ]
  check "P6 the remote note names the cause" grep -q 'container start failed' "$T/nas/work/jobs/s1/status.json"
  check "P6 a failed start writes no starts.log row" [ ! -s "$T/ctrl/rsi/state/nas/starts.log" ]
  run_pulse "$T" FAKE_START_FAIL=1 > "$T/p2.log" 2>&1
  check "P6 a second failed start counts again" [ "$(jget "$T/ctrl/rsi/state/cloud/s1.json" nas_start_failures)" = 2 ]
  run_pulse "$T" > "$T/p3.log" 2>&1
  check "P6 a brief blocked after repeated failures is not retried" [ ! -s "$T/docker-starts" ]
  check "P6 the block is logged" grep -q 'blocked after repeated start failures: s1' "$T/p3.log"
}

# --- P6b: a failed ship never starts the lane and hands the brief back (pulse) --------------------
# Without job.json on the NAS, ingest can never see this run finish, so the claim would sit taker=nas
# for the whole 5 h hold. The ship (mkdir + scp + bundle rename + starter status) is checked before
# the docker exec.
t_pulse_ship_failure() {
  local T; sandbox; T=$T
  pclaim "$T" s1 R-P-6b
  run_pulse "$T" FAKE_SCP_FAIL=1 > "$T/p1.log" 2>&1
  check "P6b a failed ship starts no lane" [ ! -s "$T/docker-starts" ]
  check "P6b a failed ship releases the claim" [ -z "$(jget "$T/ctrl/rsi/state/cloud/s1.json" taker)" ]
  check "P6b a failed ship counts the failure" [ "$(jget "$T/ctrl/rsi/state/cloud/s1.json" nas_start_failures)" = 1 ]
  check "P6b the failure reason is kept on the claim" grep -q 'ship failed' "$T/ctrl/rsi/state/cloud/s1.json"
  check "P6b the failure is logged" grep -q 'ship failed for s1' "$T/p1.log"
  check "P6b no job.json is left on the NAS" test ! -e "$T/nas/work/jobs/s1/job.json"
  check "P6b a failed ship writes no starts.log row" [ ! -s "$T/ctrl/rsi/state/nas/starts.log" ]
}

# --- T16: no open PR is a fresh publish, never a divergence (the "null" PR-list answer) --------------
t_no_pr_is_not_divergence() {
  local T; sandbox; T=$T
  job "$T" s1 R-T-16a 0 >/dev/null
  run_ingest "$T" > "$T/i1.log" 2>&1
  check "T16 a fresh slug with no open PR publishes" grep -q 'ingested R-T-16a s1' "$T/i1.log"
  check "T16 the fresh branch reaches origin" test -n "$(git -C "$T/origin.git" rev-parse --verify -q refs/heads/rsi/s1)"
  check "T16 a fresh PR is opened" [ "$(wc -l < "$T/gh.log" | tr -d ' ')" = 1 ]
  check "T16 no divergence hold is written" [ ! -e "$T/state/nas/hold/s1.md" ]
  check "T16 the result is consumed as ingested" [ "$(jget "$T/nas/work/jobs/s1/status.json" status)" = ingested ]

  local T2; sandbox; T2=$T
  job "$T2" s1 R-T-16b 0 >/dev/null
  run_ingest "$T2" FAKE_PR=null FAKE_PR_HEAD=null > "$T2/i1.log" 2>&1
  check "T16 a 'null' PR id is not a branch head" grep -q 'ingested R-T-16b s1' "$T2/i1.log"
  check "T16 a 'null' answer writes no hold" [ ! -e "$T2/state/nas/hold/s1.md" ]
  check "T16 no git error about a null object" bash -c "! grep -q 'Not a valid object name' '$T2/i1.log'"
}

# --- NAS base: the shipped bundle is the only source of the base ---------------------------------
# pulse-nas.sh bundles `origin/main`, so the bundle's head ref is refs/remotes/origin/main; the
# long-lived bare repo keeps that same ref from earlier jobs and nothing in the shipped flow
# refreshes it. nas-base.sh applies the bundle by the head ref it carries and prints the base to
# build on; with no bundle the fallback is the repo's refs/heads/main, never an origin/main the
# repo happened to keep. A bundle from an older producer whose head is refs/heads/main still applies.
nas_seed() { # T SLUG — bare repo main=OLD, stale refs/remotes/origin/main=OLD; prints "OLD NEW"
  local T="$1" slug="$2" old new
  git init -q --bare "$T/work/openkin.git"
  mkdir -p "$T/work/jobs/$slug" "$T/work/wt" "$T/work/logs"
  printf '{"item":"R-NAS-BASE","paths":["docs"],"brief":"b"}\n' > "$T/work/jobs/$slug/job.json"
  printf '{"status":"queued","slug":"%s"}\n' "$slug" > "$T/work/jobs/$slug/status.json"
  git -C "$T/ctrl" checkout -q main
  # The lane refuses to hand over without the sweep script; the sandbox repo is not the real tree,
  # so it carries a stub. The sweep itself is not under test here.
  mkdir -p "$T/ctrl/rsi/runtime"
  printf '#!/bin/bash\nexit 0\n' > "$T/ctrl/rsi/runtime/commit-leftovers.sh"
  echo old >> "$T/ctrl/docs/base.md"; git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm old
  old="$(git -C "$T/ctrl" rev-parse main)"
  git --git-dir="$T/work/openkin.git" fetch -q "$T/ctrl" main:refs/heads/main
  git --git-dir="$T/work/openkin.git" update-ref refs/remotes/origin/main "$old"
  echo new >> "$T/ctrl/docs/base.md"; git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm new
  new="$(git -C "$T/ctrl" rev-parse main)"
  printf '%s %s\n' "$old" "$new"
}
nas_base() { # T SLUG — run the lane's base picker against the bare repo, print the picked ref
  bash "$NASDIR/nas-side/nas-base.sh" "$1/work/openkin.git" "$1/work/jobs/$2"
}

case_stale_origin_main_does_not_win_over_the_shipped_bundle() {
  local T; sandbox; T=$T
  local old new; read -r old new <<<"$(nas_seed "$T" s1)"
  git -C "$T/ctrl" update-ref refs/remotes/origin/main main
  git -C "$T/ctrl" bundle create "$T/work/jobs/s1/origin-main.bundle" refs/remotes/origin/main >/dev/null
  local out; out="$(nas_base "$T" s1)"
  check "NAS base: the shipped bundle head wins over a stale origin/main" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse "$out")" = "$new" ]
  check "NAS base: the picked base is not the stale commit" \
    bash -c "[ \"\$(git --git-dir='$T/work/openkin.git' rev-parse '$out')\" != '$old' ]"
}

case_bundle_apply_updates_origin_main() {
  local T; sandbox; T=$T
  local old new; read -r old new <<<"$(nas_seed "$T" s1)"
  git -C "$T/ctrl" update-ref refs/remotes/origin/main main
  git -C "$T/ctrl" bundle create "$T/work/jobs/s1/origin-main.bundle" refs/remotes/origin/main >/dev/null
  nas_base "$T" s1 >/dev/null
  check "NAS base: the apply moves refs/remotes/origin/main to the bundle head" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse refs/remotes/origin/main)" = "$new" ]
  check "NAS base: the apply does not leave the repo's main in charge" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse refs/heads/main)" = "$old" ]
}

# A worker-side `git fetch origin` in a linked worktree advances the bare repo's
# refs/remotes/origin/main past the head the Mac shipped, so the apply must rewind it: a plain
# (non-force) refspec rejects that non-fast-forward and every lane then fails on the base pick.
case_force_apply_rewinds_a_ref_ahead_of_the_bundle() {
  local T; sandbox; T=$T
  local old new; read -r old new <<<"$(nas_seed "$T" s1)"
  git -C "$T/ctrl" update-ref refs/remotes/origin/main main
  git -C "$T/ctrl" bundle create "$T/work/jobs/s1/origin-main.bundle" refs/remotes/origin/main >/dev/null
  echo later >> "$T/ctrl/docs/base.md"; git -C "$T/ctrl" add -A; git -C "$T/ctrl" commit -qm later
  local ahead; ahead="$(git -C "$T/ctrl" rev-parse main)"
  git --git-dir="$T/work/openkin.git" fetch -q "$T/ctrl" main   # objects only; refs stay put
  git --git-dir="$T/work/openkin.git" update-ref refs/remotes/origin/main "$ahead"
  check "NAS base: the fixture leaves origin/main ahead of the shipped head" \
    bash -c "[ \"\$(git --git-dir='$T/work/openkin.git' rev-parse refs/remotes/origin/main)\" = '$ahead' ] && [ '$ahead' != '$new' ]"
  local out; out="$(nas_base "$T" s1)"
  check "NAS base: the bundle is force-applied over a ref ahead of it" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse "$out")" = "$new" ]
  check "NAS base: the ref ahead of the bundle is rewound to the bundle head" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse refs/remotes/origin/main)" = "$new" ]
}

case_no_bundle_falls_back_to_repo_main() {
  local T; sandbox; T=$T
  local old new; read -r old new <<<"$(nas_seed "$T" s1)"
  git --git-dir="$T/work/openkin.git" fetch -q "$T/ctrl" main   # objects only; refs stay put
  git --git-dir="$T/work/openkin.git" update-ref refs/remotes/origin/main "$new"   # stale, newer
  local out; out="$(nas_base "$T" s1)"
  check "NAS base: with no bundle the base is refs/heads/main" [ "$out" = refs/heads/main ]
  check "NAS base: with no bundle the repo's main is the base" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse "$out")" = "$old" ]
  check "NAS base: with no bundle the stale origin/main still does not win" \
    bash -c "[ \"\$(git --git-dir='$T/work/openkin.git' rev-parse '$out')\" != '$new' ]"
}

case_bundle_head_under_refs_heads_main_still_applies() {
  local T; sandbox; T=$T
  local old new; read -r old new <<<"$(nas_seed "$T" s1)"
  git -C "$T/ctrl" bundle create "$T/work/jobs/s1/origin-main.bundle" main >/dev/null
  git bundle list-heads "$T/work/jobs/s1/origin-main.bundle" | grep -q ' refs/heads/main$' \
    || bad "NAS base: fixture bundle head is refs/heads/main"
  local out; out="$(nas_base "$T" s1)"
  check "NAS base: an older producer's refs/heads/main bundle is the base" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse "$out")" = "$new" ]
  check "NAS base: the older bundle updates refs/heads/main" \
    [ "$(git --git-dir="$T/work/openkin.git" rev-parse refs/heads/main)" = "$new" ]
}

case_recorded_base_is_the_picked_base() {
  local T; sandbox; T=$T
  local old new; read -r old new <<<"$(nas_seed "$T" s1)"
  git -C "$T/ctrl" update-ref refs/remotes/origin/main main
  git -C "$T/ctrl" bundle create "$T/work/jobs/s1/origin-main.bundle" refs/remotes/origin/main >/dev/null
  mkdir -p "$T/bl"
  : > "$T/bl/claude-env.sh"
  ln -s "$NASDIR/nas-side/nas-base.sh" "$T/bl/nas-base.sh"
  cat > "$T/bin/claude" <<'EOS'
#!/bin/bash
printf 'RSI item: R-NAS-BASE\n\nBody.\n' > "${FAKE_LANE_J:?}/pr-body.md"
echo worker > docs/worker.md
git add -A >/dev/null 2>&1
git commit -qm "feat: worker change"
exit 0
EOS
  chmod +x "$T/bin/claude"
  env NAS_LANE_BL="$T/bl" NAS_LANE_WORK="$T/work" FAKE_LANE_J="$T/work/jobs/s1" \
      PATH="$T/bin:$PATH" bash "$NASDIR/nas-side/nas-lane.sh" s1 >/dev/null 2>&1
  local base created
  base="$(jget "$T/work/jobs/s1/status.json" base)"
  created="$(git -C "$T/work/wt/rsi-s1" rev-parse HEAD~1 2>/dev/null)"
  check "NAS base: the lane recorded a base" [ -n "$base" ]
  check "NAS base: status.base is the commit the worktree was created from" [ "$base" = "$created" ]
  check "NAS base: the worktree was created from the shipped bundle head" [ "$created" = "$new" ]
  check "NAS base: the recorded base is not the stale origin/main" [ "$created" != "$old" ]
}

if [ "${1:-}" = "--sandbox" ]; then sandbox; echo "$T"; SANDBOXES=(); exit 0; fi
if [ -n "${1:-}" ]; then "$1"; finish; exit $?; fi    # test-nas.sh <function> — one test (mutant runs)

t_ingest_twice
t_worktree_recovery
t_screenshot_hold
t_claim_gate_holds_missing_check
t_claim_gate_publishes_valid_check
t_claim_gate_existing_pr_keeps_body
t_claim_gate_no_verdict_holds
t_release_ownership
t_worktree_ownership
case_wt_resolving_to_control_tree_is_refused
case_control_tree_on_another_branch_is_still_refused
case_distinct_worktree_still_syncs
case_unresolvable_path_fails_closed
t_selfcheck_completion
t_shot_validation
t_existing_pr
t_existing_pr_shots
t_no_pr_is_not_divergence
t_claim_identity
t_worktree_lock
t_pulse_skips_taken
t_pulse_starts_once
t_pulse_container_down
t_pulse_capacity
t_pulse_lock_ownership
t_pulse_start_failure
t_pulse_ship_failure
case_stale_origin_main_does_not_win_over_the_shipped_bundle
case_bundle_apply_updates_origin_main
case_force_apply_rewinds_a_ref_ahead_of_the_bundle
case_no_bundle_falls_back_to_repo_main
case_bundle_head_under_refs_heads_main_still_applies
case_recorded_base_is_the_picked_base
finish
