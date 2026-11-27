#!/bin/bash
# ingest-nas.sh — Mac side. For each finished NAS job: fetch the git bundle, run the full self-check
# (tsc, UI inventory, vitest) under heavy.sh, push rsi/<slug> (normal push, never force), open or update
# the PR, record it like a lane, release the cloud claim, kick merge.sh. Failed jobs release the claim
# so the slice can fall back to a local or box lane.
# Ownership is never assumed: a claim is released or a result published only when job.json carries a valid
# launched_at and the claim carries the same stamp (under the scheduler flock), an existing worktree is only
# fast-forwarded while the per-slug merge lock is held and cannot discard a newer HEAD, and the published
# branch/PR head must already contain the NAS commit.
# A worktree path that resolves to the control checkout is refused before the first git call, so a replayed
# slug can never fast-forward the running loop's own tree.
# Idempotent twice over: handled jobs are marked `ingested`/`held` on the NAS and their run identity is
# recorded in state/nas/acks.txt, so a second pulse does no work and writes no second history/notice.
# Every remote call is bounded (M8); the job list is read on fd 3 so ssh cannot drain it (M3).
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
STATE="${NAS_STATE:-$STATE}"; export RSI_STATE="$STATE"
CTRL="${NAS_CTRL:-$RSI_CTRL}"
NAS_HOST="${NAS_HOST:-nas}"
REMOTE="${NAS_REMOTE:-}"
SSH_BIN="${NAS_SSH:-ssh}"
SCP_BIN="${NAS_SCP:-scp}"
GH_BIN="${NAS_GH:-$GH}"
DATE_BIN="${NAS_DATE:-date}"
REALPATH_BIN="${NAS_REALPATH_PY:-python3}"   # test seam: stubbing it exercises the fail-closed branch
SSH=("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -n)
SSH_T="${NAS_SSH_TIMEOUT:-90}"
XFER_T="${NAS_XFER_TIMEOUT:-900}"
GH_T="${NAS_GH_TIMEOUT:-180}"
CLAIM_T="${NAS_CLAIM_TIMEOUT:-120}"   # bound on the prose claim check; expiry holds as NO_VERDICT
WT_ROOT="${NAS_WT_ROOT:-$WT_ROOT}"
PREP="${NAS_PREP:-$RSI_DIR/runtime/prep-worktree.sh}"
HEAVY="${NAS_HEAVY:-$RSI_DIR/runtime/heavy.sh}"
X="$STATE/nas/xfer"; mkdir -p "$X" "$STATE/nas" "$STATE/lanes/history" "$STATE/nas/hold"
KICK=0

if [ -z "$REMOTE" ]; then
  REMOTE="$(with_timeout 30 "${SSH[@]}" "$NAS_HOST" 'printf %s "$HOME/kin-rsi-nas"' 2>/dev/null)" || REMOTE=""
  case "$REMOTE" in /*) ;; *) REMOTE="";; esac
fi
[ -n "$REMOTE" ] || { echo "NAS unreachable; nothing to ingest"; exit 0; }

# A handled run is identified by slug + terminal status + its start/update stamp. Bytes once written,
# an ack line is never re-processed; bare legacy slug lines simply do not match.
acked() { grep -qxF "$1" "$STATE/nas/acks.txt" 2>/dev/null; }
ack() { echo "$1" >> "$STATE/nas/acks.txt"; }

# A run identity is a positive finite number from job.json. Missing, malformed or legacy metadata prints
# nothing, and callers must then neither release the claim nor publish the result (M3).
run_ident() { # FILE KEY
  python3 - "$1" "$2" <<'PYI' 2>/dev/null
import json,math,sys
try: v=json.load(open(sys.argv[1])).get(sys.argv[2])
except Exception: sys.exit(1)
if isinstance(v,bool) or v is None: sys.exit(1)
try: f=float(v)
except Exception: sys.exit(1)
if not math.isfinite(f) or f<=0: sys.exit(1)
print(v)
PYI
}

# The merge lane owns a slug's worktree through state/merge/<slug>.lock (a directory holding its pid).
# Ingest takes the same lock for its worktree mutation, so a verifier cannot commit between our checks and
# the fast-forward, and ingest never touches a worktree a live verifier is using (M4).
SLUG_LOCK=""
slug_lock_drop() { [ -n "$SLUG_LOCK" ] && rm -rf "$SLUG_LOCK"; SLUG_LOCK=""; }
trap slug_lock_drop EXIT
slug_lock_take() { # SLUG — 0 taken, 1 owned by a live merge worker
  local L="$STATE/merge/$1.lock" pid n=0
  mkdir -p "$STATE/merge"
  while [ "$n" -lt 5 ]; do
    if mkdir "$L" 2>/dev/null; then echo $$ > "$L/pid"; SLUG_LOCK="$L"; return 0; fi
    pid="$(cat "$L/pid" 2>/dev/null || true)"
    [ -z "$pid" ] && return 1                    # freshly created or unknown owner: not provably stale
    kill -0 "$pid" 2>/dev/null && return 1
    # Reclaim a dead verifier's lock atomically, so two pulses cannot both "reclaim" and take it.
    if mv "$L" "$L.stale.$$" 2>/dev/null; then rm -rf "$L.stale.$$"; fi
    n=$((n+1))
  done
  return 1
}

# A local lane owns the same worktree through lanes.py's active slug list.
lane_active() { python3 "${NAS_LANES_PY:-$LANES_PY}" slugs 2>/dev/null | grep -qxF "$1"; }

# Mark the remote record consumed so the next pulse's list no longer selects it (M4). Guarded by the
# identity we handled, so a newer rerun of the same slug is never clobbered.
mark_remote() { # slug ident newstatus
  with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "python3 - '$REMOTE/work/jobs/$1/status.json' '$2' '$3' <<'PY'
import json,os,sys,time
p,ident,newst=sys.argv[1:4]
try: d=json.load(open(p))
except Exception: sys.exit(0)
cur=str(int(float(d.get('started_at') or d.get('updated_at') or 0)))
if cur!=ident or d.get('status') not in ('done','failed'): sys.exit(0)
d['status']=newst; d['consumed_at']=time.time()
tmp=p+'.tmp'; json.dump(d,open(tmp,'w')); os.replace(tmp,p)
PY"
}

# Is state/cloud/<slug>.json still this NAS run's claim? Read under the scheduler's shared flock, and
# require the exact run identity the pulse stamped into job.json (launched_at); a missing/legacy stamp on
# either side is not ownership. A missing claim file means there is nothing to own (already released),
# which is not a conflict.
claim_owned() { # SLUG JOB_LAUNCHED_AT
  [ -n "${2:-}" ] || return 1
  python3 - "$STATE/lanes" "$STATE/cloud/$1.json" "$1" "$2" <<'PYO' >/dev/null 2>&1
import fcntl,json,os,sys
ldir,f,slug,want=sys.argv[1:5]
if not os.path.exists(f): sys.exit(0)
lock=open(os.path.join(ldir,'.flock'),'w')
fcntl.flock(lock,fcntl.LOCK_SH)
try:
    d=json.load(open(f))
    if (d.get('taker') or '')!='nas' or d.get('slug')!=slug: sys.exit(1)
    try:
        if str(float(d['launched_at']))!=str(float(want)): sys.exit(1)
    except Exception: sys.exit(1)
finally:
    fcntl.flock(lock,fcntl.LOCK_UN); lock.close()
PYO
}

# Release this run's claim under the same flock the scheduler writes claims with (M3). Never touch a
# claim another executor took over, and never release without a valid matching identity; exit 3 so the
# caller can say so instead of claiming a release.
release_claim() { # SLUG done|failed JOB_LAUNCHED_AT
  [ -n "${3:-}" ] || { echo "claim for $1 has no run identity; left alone" >&2; return 3; }
  python3 - "$STATE/lanes" "$STATE/cloud/$1.json" "$1" "$2" "$3" <<'PYR'
import fcntl,json,os,sys
ldir,f,slug,why,want=sys.argv[1:6]
if not os.path.exists(f): sys.exit(0)
lock=open(os.path.join(ldir,'.flock'),'w'); fcntl.flock(lock,fcntl.LOCK_EX)
try:
    d=json.load(open(f))
    if (d.get('taker') or '')!='nas' or d.get('slug')!=slug:
        print('claim for %s is not ours (taker=%r); left alone' % (slug,(d.get('taker') or '')), file=sys.stderr); sys.exit(3)
    try:
        if str(float(d['launched_at']))!=str(float(want)):
            print('claim for %s belongs to another NAS run; left alone' % slug, file=sys.stderr); sys.exit(3)
    except Exception:
        print('claim for %s has no run identity; left alone' % slug, file=sys.stderr); sys.exit(3)
    dest=os.path.join(os.path.dirname(f),'expired'); os.makedirs(dest,exist_ok=True)
    os.replace(f,os.path.join(dest,('done-' if why=='done' else '')+slug+'.json'))
finally:
    fcntl.flock(lock,fcntl.LOCK_UN); lock.close()
PYR
}

# Two distinct, decodable captures at the two required sizes (M6): 390x844 and 1100x760. A filename is not
# evidence. PNGs are chunk-checked (CRC), IDAT-decompressed and size-checked; JPEGs are walked to a real
# SOF frame and must reach EOI. Truncated, corrupt, wrong-size or single-file evidence all fail.
shots_ok() { # DIR
  python3 - "$1" <<'PYS' >/dev/null 2>&1
import os,struct,sys,zlib
d=sys.argv[1]
want={390:(390,844),1100:(1100,760)}
PNG=b'\x89PNG\r\n\x1a\n'
def png_size(data):
    if not data.startswith(PNG): return None
    pos=8; w=h=ct=im=None; idat=[]; first=True
    while pos+12<=len(data):
        ln=struct.unpack('>I',data[pos:pos+4])[0]; typ=data[pos+4:pos+8]
        if pos+12+ln>len(data): return None
        body=data[pos+8:pos+8+ln]
        if zlib.crc32(typ+body)&0xffffffff!=struct.unpack('>I',data[pos+8+ln:pos+12+ln])[0]: return None
        if first and typ!=b'IHDR': return None
        first=False
        if typ==b'IHDR':
            if ln!=13: return None
            w,h,bd,ct,cm,fm,im=struct.unpack('>IIBBBBB',body)
            if bd not in (8,16) or ct not in (0,2,3,4,6) or im not in (0,1): return None
        elif typ==b'IDAT': idat.append(body)
        elif typ==b'IEND':
            if w is None or not idat: return None
            try: raw=zlib.decompress(b''.join(idat))
            except zlib.error: return None
            ch={0:1,2:3,3:1,4:2,6:4}[ct]
            if im==0 and len(raw)!=h*(1+(w*ch*bd+7)//8): return None   # truncated pixel stream
            return (w,h)
        pos+=12+ln
    return None
def jpeg_size(data):
    if not data.startswith(b'\xff\xd8\xff'): return None
    i=2; dims=None
    while i+2<=len(data):
        if data[i]!=0xff: return None
        m=data[i+1]
        if m==0xff: i+=1; continue
        if m==0xd9: return dims
        if m==0xd8 or 0xd0<=m<=0xd7 or m==0x01: i+=2; continue
        if i+4>len(data): return None
        ln=struct.unpack('>H',data[i+2:i+4])[0]
        if ln<2 or i+2+ln>len(data): return None
        if m==0xda: return dims if b'\xff\xd9' in data[i:] else None   # entropy data must reach EOI
        if m in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf) and ln>=7:
            h,w=struct.unpack('>HH',data[i+5:i+9]); dims=(w,h)
        i+=2+ln
    return None
found={}
try: names=sorted(os.listdir(d))
except OSError: sys.exit(1)
for n in names:
    p=os.path.join(d,n)
    try:
        if not os.path.isfile(p) or os.path.getsize(p)<1024: continue
        data=open(p,'rb').read()
    except OSError: continue
    dims=png_size(data) or jpeg_size(data)
    if not dims: continue
    for w,wh in want.items():
        if dims==wh and w not in found: found[w]=p
sys.exit(0 if set(found)==set(want) and len(set(found.values()))==2 else 1)
PYS
}

# Pull finished job artifacts (status, bundle, pr-body, job.json, logs snippet). The remote program is
# passed in the ssh command string, not on stdin, so -n is safe here.
LIST=$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "python3 - <<'PY'
import json,os,glob
root='$REMOTE/work/jobs'
for d in sorted(glob.glob(root+'/*/status.json')):
    try: st=json.load(open(d)).get('status')
    except Exception: continue
    if st in ('done','failed'):
        print(os.path.basename(os.path.dirname(d))+','+st)
PY") || LIST=""
[ -z "${LIST:-}" ] && { echo "no finished NAS jobs"; exit 0; }

selfcheck_mac() { # WT J
  local WT="$1" J="$2" LOG="$2/selfcheck.txt" RC=0
  if [ -n "${NAS_SELFCHECK_CMD:-}" ]; then   # test seam: a cheap command that stands in for heavy.sh
    with_timeout "${NAS_SELFCHECK_TIMEOUT:-600}" bash -c "$NAS_SELFCHECK_CMD" > "$LOG" 2>&1
    return $?
  fi
  with_timeout 300 bash "$PREP" "$WT" || return 1
  # The check bodies are overridable for tests; the status and completion rules below are not.
  local TSC_C="${NAS_SELFCHECK_TSC:-( cd \"$WT/ui\" && npx tsc --noEmit )}"
  local INV_C="${NAS_SELFCHECK_INV:-( cd \"$WT\" && python3 scripts/check-ui-inventory.py )}"
  local VIT_C="${NAS_SELFCHECK_VITEST:-( cd \"$WT/ui\" && npx vitest run --maxWorkers=2 )}"
  # The mobile-rn arm (R-producer-checks): tsc+jest on the RN tree, required exactly when the
  # job's changed paths can reach it — mobile-rn/** itself, or ui/src/** which mobile-rn imports
  # (#778 merged with an RN tsc failure this ui-only self-check could not see; only CI caught
  # it). An unreadable diff runs the section anyway (fail closed); the ui install $PREP did
  # already covers the ui/src imports mobile-rn's tsconfig compiles.
  local RN_PATHS RN_REQ=""
  if RN_PATHS="$(with_timeout 60 "$GIT" -C "$WT" diff --name-only origin/main...HEAD 2>/dev/null)"; then
    printf '%s\n' "$RN_PATHS" | grep -qE '^(mobile-rn/|ui/src/)' && RN_REQ=1
  else
    RN_REQ=1
  fi
  local RN_C="${NAS_SELFCHECK_RN:-( cd \"$WT/mobile-rn\" && npm install --no-audit --no-fund --no-package-lock && npx tsc --noEmit && npx jest --ci )}"
  SELFCHECK_RN_NOTE="mobile-rn skipped (no mobile-rn/ or ui/src path changed)"
  [ -n "$RN_REQ" ] && SELFCHECK_RN_NOTE="mobile-rn tsc+jest"
  with_timeout "${NAS_SELFCHECK_TIMEOUT:-3600}" bash "$HEAVY" bash -c "
    { echo '== tsc'; $TSC_C || echo TSC-FAIL
      echo '== inventory'; $INV_C || echo INV-FAIL
      echo '== vitest (full)'; $VIT_C || echo VITEST-FAIL
      if [ -n \"$RN_REQ\" ]; then echo '== mobile-rn'; $RN_C || echo RN-FAIL; fi
      echo '== selfcheck complete'
    } > \"$LOG\" 2>&1
  "
  RC=$?
  # Green needs all three: the heavy command exited cleanly, every check ran to the end marker, and no
  # check reported a failure (M5). An interrupted or crashed run must never read as green.
  if [ "$RC" -ne 0 ]; then
    echo "self-check did not finish (heavy exit $RC)" >> "$LOG"; return 1
  fi
  grep -qx '== selfcheck complete' "$LOG" || { echo "self-check has no completion marker" >> "$LOG"; return 1; }
  local h
  local HDRS=( '== tsc' '== inventory' '== vitest (full)' )
  [ -n "$RN_REQ" ] && HDRS+=( '== mobile-rn' )
  for h in "${HDRS[@]}"; do
    grep -qxF "$h" "$LOG" || { echo "self-check never ran $h" >> "$LOG"; return 1; }
  done
  ! grep -qE '^(TSC|INV|VITEST|RN)-FAIL' "$LOG"
}

hold_slug() { # SLUG ITEM J WHY [PRN] — visible UI with no shots: never publish the visible change
  local SLUG="$1" ITEM="$2" J="$3" WHY="$4" PRN="${5:-}"
  mkdir -p "$STATE/nas/hold"
  {
    echo "# $ITEM $SLUG held: $WHY"
    if [ -n "$PRN" ]; then
      echo "PR #$PRN stays at its previous head: pushing this result would add visible UI with no captures."
      echo "NAS result: $(with_timeout 30 "$GIT" -C "$CTRL" rev-parse "$REF" 2>/dev/null || echo unknown) in refs/nas/$SLUG."
      echo "Capture 390x844 and 1100x760 before/after into $STATE/shots/$SLUG/, then publish the result:"
      echo "  git -C $CTRL push origin refs/nas/$SLUG:refs/heads/rsi/$SLUG"
      echo "  gh pr edit $PRN --repo $GH_REPO --body-file $J/pr-body.md"
    else
      echo "Branch rsi/$SLUG is pushed. Capture 390x844 and 1100x760 before/after into"
      echo "$STATE/shots/$SLUG/ then: gh pr create --repo $GH_REPO --base main --head rsi/$SLUG --title '<title>' --body-file $J/pr-body.md"
    fi
  } > "$STATE/nas/hold/$SLUG.md"
  echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG held for screenshots (390x844, 1100x760): see rsi/state/nas/hold/$SLUG.md" >> "$STATE/needs-ceo.md"
  echo "held $SLUG: $WHY"
}

# A prose body that fails the merge gate's claim rule is held before any PR exists. Same shape as
# hold_slug: a new branch is pushed so the result survives for the local rework, an open PR keeps its
# previous head, and no `gh pr create` / `gh pr edit` ever sees a body that would be sent back. The
# phrase in needs-ceo.md is distinct from the screenshots hold so the two causes are counted apart.
hold_claim() { # SLUG ITEM J WHY [PRN] [VERDICT] [PUSH_NOTE]
  local SLUG="$1" ITEM="$2" J="$3" WHY="$4" PRN="${5:-}" VERDICT="${6:-}" PUSH_NOTE="${7:-}"
  mkdir -p "$STATE/nas/hold"
  {
    echo "# $ITEM $SLUG held: $WHY"
    echo "The body was not published: neither 'gh pr create' nor 'gh pr edit' ran. Body under test:"
    echo "$J/pr-body.md."
    if [ -n "$PRN" ]; then
      echo "PR #$PRN keeps its previous head and the branch was not pushed: the merge lane would"
      echo "claim-check the previous body against this commit's diff and could merge rejected prose."
    elif [ -z "$PUSH_NOTE" ]; then
      echo "The branch was pushed so the result survives for the local rework."
    fi
    if [ -n "$VERDICT" ]; then
      echo "Verdict:"
      printf '%s\n' "$VERDICT"
    fi
    [ -n "$PUSH_NOTE" ] && echo "Branch push: $PUSH_NOTE"
    echo "If the body is the cause, name one command at column 0 as 'Claim check:' and paste its real"
    echo "output under 'Claim output:' (or 'Claim check: none: <why no command can prove it>')."
    echo "Then publish the result:"
    echo "  git -C $CTRL push origin refs/nas/$SLUG:refs/heads/rsi/$SLUG"
    if [ -n "$PRN" ]; then
      echo "  gh pr edit $PRN --repo $GH_REPO --body-file $J/pr-body.md"
    else
      echo "  gh pr create --repo $GH_REPO --base main --head rsi/$SLUG --title '<title>' --body-file $J/pr-body.md"
    fi
  } > "$STATE/nas/hold/$SLUG.md"
  echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG held for claim check ($WHY): see rsi/state/nas/hold/$SLUG.md" >> "$STATE/needs-ceo.md"
  echo "held $SLUG for claim check: $WHY"
}

# The merge lane's 1000-line cap at the NAS gate (R-producer-checks). Same shape as hold_claim:
# an oversize result is held before publishing rather than pushed into a guaranteed hold-size
# sendback, and the branch is pushed only so the work survives for the local rework. The waiver
# is the same file merge.sh honours, so a CEO-waived slice is never stopped twice.
hold_oversize() { # SLUG ITEM J SIZE [PRN] [PUSH_NOTE]
  local SLUG="$1" ITEM="$2" J="$3" SIZE="$4" PRN="${5:-}" PUSH_NOTE="${6:-}"
  mkdir -p "$STATE/nas/hold"
  {
    echo "# $ITEM $SLUG held: oversize ($SIZE changed lines >1000)"
    echo "merge.sh holds any PR over 1000 changed lines without a CEO waiver"
    echo "($STATE/merge/$SLUG.size-ok), so this result was not published."
    if [ -z "$PRN" ] && [ -z "$PUSH_NOTE" ]; then
      echo "The branch was pushed so the result survives for the local rework."
    fi
    [ -n "$PUSH_NOTE" ] && echo "Branch push: $PUSH_NOTE"
    echo "Split the slice: deliver the smallest green first slice and re-queue the rest, or have"
    echo "the CEO touch the waiver file. Then publish the result:"
    echo "  git -C $CTRL push origin refs/nas/$SLUG:refs/heads/rsi/$SLUG"
    if [ -n "$PRN" ]; then
      echo "  gh pr edit $PRN --repo $GH_REPO --body-file $J/pr-body.md"
    else
      echo "  gh pr create --repo $GH_REPO --base main --head rsi/$SLUG --title '<title>' --body-file $J/pr-body.md"
    fi
  } > "$STATE/nas/hold/$SLUG.md"
  echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG held: oversize ($SIZE>1000); see rsi/state/nas/hold/$SLUG.md" >> "$STATE/needs-ceo.md"
  echo "held $SLUG: oversize ($SIZE>1000)"
}

# The prose claim rule, before the self-check and before any publish (R-nas-claim-gate). The live
# lane (lane.sh) and the merge gate (merge.sh) already run runtime/claim_check.py; the NAS ingest
# was the only entry point that could hand the merge lane a body with no claim at all — measured
# 2026-11-23: #611 and #618 each cost a full gate plus an independent review for a body-only
# defect (Watch 87: a guard in one entry point is not a guard for the other). It is the same rule
# and the lane's exact changed-file computation. Fail closed on everything that is not a verdict:
# a diff that cannot be read, a check that outlives its bound (124 -> NO_VERDICT), or any non-zero
# rc holds the job instead of publishing. Sets CLAIM_WHY / CLAIM_OUT for the hold writer; returns
# 0 to publish, 1 to hold.
CLAIM_WHY=""; CLAIM_OUT=""
claim_gate() { # SLUG J PRB WT REF
  local SLUG="$1" J="$2" PRB="$3" WT="$4" REF="$5"
  local RAW="$J/claim-changed.raw" LIST="$J/claim-changed.txt" RC
  CLAIM_WHY=""; CLAIM_OUT=""
  if ! with_timeout 60 "$GIT" -C "$CTRL" -c core.fileMode=false diff --no-renames --raw \
      "origin/main...$REF" > "$RAW" 2>/dev/null; then
    CLAIM_WHY="cannot diff the branch for the claim check"
    return 1
  fi
  # lane.sh's exact computation: renames off, mode-only entries skipped, the path after the raw
  # header's tab. A different list here could hold a PR the merge gate would pass, or pass one it
  # would send back.
  awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}' "$RAW" > "$LIST"
  CLAIM_OUT="$(bounded_run "$CLAIM_T" python3 "$RSI_DIR/runtime/claim_check.py" "$WT" "$PRB" "$LIST" 2>&1)"
  RC=$?
  case "$RC" in
    0) echo "claim check ok $SLUG"; return 0 ;;
    124) CLAIM_WHY="NO_VERDICT: the claim check did not finish within ${CLAIM_T}s" ;;
    *) CLAIM_WHY="the claim check exited $RC" ;;
  esac
  return 1
}

# The branch moved on (a merge or rework lane committed after the NAS job finished). Publishing would need
# a force push; consuming would lose the NAS commit. Keep both and say so, once (M7).
hold_diverged() { # SLUG ITEM REMOTE_SHA PRN
  local SLUG="$1" ITEM="$2" RSHA="${3:-none}" PRN="${4:-none}" NASHA
  NASHA="$("$GIT" -C "$CTRL" rev-parse "$REF" 2>/dev/null || echo unknown)"
  mkdir -p "$STATE/nas/hold"
  {
    echo "# $ITEM $SLUG held: rsi/$SLUG diverged from the NAS result"
    echo "PR: $PRN. NAS result: $NASHA. Remote branch: $RSHA."
    echo "The remote branch has commits the NAS result does not contain (merge or rework lane), so a normal"
    echo "push cannot publish it. Re-run the slice against the current branch instead of forcing:"
    echo "  git -C $CTRL log --oneline $RSHA..$NASHA"
  } > "$STATE/nas/hold/$SLUG.md"
  echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG held: rsi/$SLUG diverged from the NAS result (remote $RSHA); see rsi/state/nas/hold/$SLUG.md" >> "$STATE/needs-ceo.md"
  echo "held $SLUG: branch diverged (remote $RSHA)"
}

# Resolve a path to its physical spelling (macOS has no GNU realpath). Prints nothing and returns
# nonzero when the resolution cannot be made, so callers can fail closed instead of comparing guesses.
real_path() { "$REALPATH_BIN" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null; }

# Materialise the lane worktree and prove it is at the bundle's commit (M4/M7). Runs under the per-slug
# merge lock and fast-forwards with `merge --ff-only`, which cannot discard a HEAD that advanced after
# our checks; a clean branch with no commits of its own (every tip commit already in origin/main) is
# re-attached to the bundle instead. Prints why it refused and returns 1 to leave it alone.
sync_worktree() { # SLUG WT BR REF EXPECT
  local SLUG="$1" WT="$2" BR="$3" REF="$4" EXPECT="$5" CUR_BR CUR GOT WT_REAL CTRL_REAL OWN
  # --- control-tree guard -----------------------------------------------------------------------
  # The control checkout can itself resolve into the worktree root: on 2026-11-22 the control
  # checkout was a symlink that physically pointed at a registered lane's worktree directory, with
  # its HEAD on that lane's branch. For that slug every check below passes — .git present, branch
  # equal, clean, HEAD an ancestor of the bundle — and the final `merge --ff-only` would then run
  # inside the control checkout, swapping the running gate, walker, GOAL.md and live state for the
  # NAS result while every status line still read healthy (same family as 2026-11-20, when one stale
  # line held the control tree 17 commits behind main).
  # Resolve both paths and refuse before the first git call. A resolution failure fails closed;
  # distinct paths, including a worktree that does not exist yet, still sync.
  WT_REAL="$(real_path "$WT")" || WT_REAL=""
  CTRL_REAL="$(real_path "$CTRL")" || CTRL_REAL=""
  if [ -z "$WT_REAL" ] || [ -z "$CTRL_REAL" ]; then
    echo "control-tree guard: cannot resolve worktree $WT or control checkout $CTRL; refusing to sync"; return 1
  fi
  if [ "$WT_REAL" = "$CTRL_REAL" ]; then
    echo "control-tree guard: worktree $WT resolves to the control checkout $CTRL ($CTRL_REAL); refusing to sync"; return 1
  fi
  if lane_active "$SLUG"; then
    echo "a local lane is active on $SLUG; leaving its worktree alone"; return 1
  fi
  if ! slug_lock_take "$SLUG"; then
    echo "a merge worker owns $SLUG; leaving its worktree alone"; return 1
  fi
  if [ ! -e "$WT/.git" ]; then                       # linked worktrees use a .git *file*, not a directory
    if [ -e "$WT" ] && [ -n "$(ls -A "$WT" 2>/dev/null)" ]; then
      echo "worktree path $WT exists but is not a git worktree; leaving it alone"; slug_lock_drop; return 1
    fi
    with_timeout 120 "$GIT" -C "$CTRL" worktree prune
    if "$GIT" -C "$CTRL" show-ref --verify --quiet "refs/heads/$BR"; then
      # An existing branch may already carry merge/rework commits: only check it out when the bundle
      # contains them. `worktree add -B` would silently re-point the branch; never use it here.
      if ! with_timeout 60 "$GIT" -C "$CTRL" merge-base --is-ancestor "refs/heads/$BR" "$REF"; then
        echo "branch $BR has commits the NAS bundle does not contain; leaving it alone"; slug_lock_drop; return 1
      fi
      with_timeout 120 "$GIT" -C "$CTRL" worktree add -q "$WT" "$BR" || { echo "worktree add failed $SLUG"; slug_lock_drop; return 1; }
    else
      # `-b` fails if the branch appeared meanwhile, rather than resetting it.
      with_timeout 120 "$GIT" -C "$CTRL" worktree add -q -b "$BR" "$WT" "$REF" || { echo "worktree add failed $SLUG"; slug_lock_drop; return 1; }
    fi
  fi
  if ! with_timeout 120 "$GIT" -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "existing path $WT is not a usable worktree; leaving it alone"; slug_lock_drop; return 1
  fi
  CUR_BR="$(with_timeout 60 "$GIT" -C "$WT" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  if [ "$CUR_BR" != "$BR" ]; then
    echo "worktree $WT is on '${CUR_BR:-detached}', not $BR; leaving it alone"; slug_lock_drop; return 1
  fi
  if [ -n "$(with_timeout 60 "$GIT" -C "$WT" status --porcelain 2>/dev/null || true)" ]; then
    echo "worktree $WT has uncommitted changes; leaving it alone"; slug_lock_drop; return 1
  fi
  if ! with_timeout 60 "$GIT" -C "$WT" merge-base --is-ancestor HEAD "$REF"; then
    # The worktree is clean and on the right branch, but HEAD is not in the bundle's history. On
    # 2026-11-27 that held a finished job 48 passes in a row: the lane branch merely stood at a
    # newer main than the bundle's base, so it had no work of its own to lose. Only overwrite when
    # that is provable — `origin/main..HEAD` counts zero commits, so every commit of the old tip is
    # already on origin/main — and then re-attach the branch to the bundle with `checkout -B`.
    # Leaving the worktree detached would strand the next rework lane (it commits on HEAD, but
    # lane-push pushes the branch ref) and every later NAS pass ("on 'detached'"). A worktree that
    # really carries unpublished commits keeps today's refusal, verbatim, and is never touched.
    OWN="$(with_timeout 60 "$GIT" -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || true)"
    if [ "$OWN" != 0 ]; then
      echo "worktree $WT has commits the NAS bundle does not contain; leaving it alone"; slug_lock_drop; return 1
    fi
    with_timeout 120 "$GIT" -C "$WT" checkout -q -B "$BR" "$REF" >/dev/null 2>&1 \
      || { echo "worktree $WT could not be moved to the NAS bundle; leaving it alone"; slug_lock_drop; return 1; }
    echo "worktree $WT had no commits of its own; materialised the NAS bundle at $EXPECT"
  elif ! with_timeout 120 "$GIT" -C "$WT" merge --ff-only -q "$REF" >/dev/null 2>&1; then
    echo "worktree $WT could not be fast-forwarded safely; leaving it alone"; slug_lock_drop; return 1
  fi
  GOT="$(with_timeout 60 "$GIT" -C "$WT" rev-parse HEAD)"
  if [ "$GOT" != "$EXPECT" ]; then
    echo "worktree HEAD $GOT != bundle $EXPECT for $SLUG"; slug_lock_drop; return 1
  fi
  slug_lock_drop
  return 0
}

while IFS=, read -r SLUG ST <&3; do
  [ -n "$SLUG" ] || continue
  case "$SLUG" in *[!a-z0-9._-]*|"") echo "skip bad slug $SLUG"; continue;; esac
  J="$X/$SLUG"; mkdir -p "$J"
  # Use -O (legacy scp protocol): UGOS Pro's SFTP subsystem cannot resolve ssh paths (see pulse-nas.sh).
  with_timeout "$SSH_T" "$SCP_BIN" -O -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/status.json" "$J/status.json" 2>/dev/null || { echo "no status $SLUG"; continue; }
  IDENT="$(python3 -c "import json;d=json.load(open('$J/status.json'));print(int(float(d.get('started_at') or d.get('updated_at') or 0)))" 2>/dev/null || echo 0)"
  ACK_KEY="$SLUG:$ST:$IDENT"
  if acked "$ACK_KEY"; then
    mark_remote "$SLUG" "$IDENT" ingested      # repair a half-finished previous pass
    continue
  fi
  with_timeout "$SSH_T" "$SCP_BIN" -O -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/job.json" "$J/job.json" 2>/dev/null || true
  with_timeout "$SSH_T" "$SCP_BIN" -O -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/pr-body.md" "$J/pr-body.md" 2>/dev/null || true
  ITEM="$(python3 -c "import json,os;print(json.load(open('$J/job.json')).get('item','') if os.path.exists('$J/job.json') else '')")"
  JOB_LAUNCH="$([ -s "$J/job.json" ] && run_ident "$J/job.json" launched_at || true)"
  if [ "$ST" = failed ]; then
    NOTE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('note',''))")"
    if [ -z "$JOB_LAUNCH" ]; then
      echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim not released: job.json has no valid run identity)" >> "$STATE/needs-ceo.md"
    elif release_claim "$SLUG" failed "$JOB_LAUNCH"; then
      echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim released; slice falls back)" >> "$STATE/needs-ceo.md"
    else
      echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim kept by its current owner; not released)" >> "$STATE/needs-ceo.md"
    fi
    mark_remote "$SLUG" "$IDENT" ingested
    ack "$ACK_KEY"
    echo "failed $SLUG: $NOTE"; continue
  fi
  [ "$ST" = done ] || continue
  # No valid identity means we cannot prove this result or its claim is ours. Leave both alone; a repaired
  # job.json can be ingested by the next pulse, and a permanently malformed one never publishes (M3).
  if [ -z "$JOB_LAUNCH" ]; then
    echo "no valid run identity for $SLUG (job.json missing or malformed); leaving the finished result alone"
    continue
  fi
  with_timeout "$XFER_T" "$SCP_BIN" -O -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/bundle" "$J/bundle" || { echo "no bundle $SLUG"; continue; }
  BR="rsi/$SLUG"; REF="refs/nas/$SLUG"
  with_timeout "$XFER_T" "$GIT" -C "$CTRL" fetch -q origin 2>/dev/null || true
  with_timeout 120 "$GIT" -C "$CTRL" bundle verify "$J/bundle" >/dev/null 2>&1 || { echo "bundle for $SLUG does not verify"; continue; }
  with_timeout 120 "$GIT" -C "$CTRL" fetch -q "$J/bundle" "$BR:$REF" || { echo "bundle fetch failed $SLUG"; continue; }
  WANT="$("$GIT" -C "$CTRL" rev-parse "$REF")"

  # Another executor may hold this slug now (a failed start unclaimed it and box claimed it). Never consume
  # or publish a result whose claim is no longer this NAS run's (M3).
  if ! claim_owned "$SLUG" "$JOB_LAUNCH"; then
    echo "claim for $SLUG is no longer this NAS run's; leaving the finished result alone"
    continue
  fi

  # Materialise a worktree and prove it is at the bundle's commit before checking or publishing (M4/M7).
  WT="$WT_ROOT/rsi-$SLUG"
  sync_worktree "$SLUG" "$WT" "$BR" "$REF" "$WANT" || continue

  # Visible UI without the two required captures is held, not published (M6). The base is trusted Git
  # state (origin/main, just fetched), never the worker's optional status.base, and a shots directory only
  # counts when it holds two real images at the required widths.
  PRB="$J/pr-body.md"
  DIFF=""; DIFF_FAILED=0
  if ! DIFF="$(with_timeout 60 "$GIT" -C "$CTRL" diff --name-only "origin/main...$REF" 2>/dev/null)"; then
    DIFF_FAILED=1
  fi
  VISIBLE="$(printf '%s\n' "$DIFF" | grep -E '^ui/src/.*\.(tsx|css)$' | grep -vE '\.test\.|/__tests__/' || true)"
  SHOTS="$STATE/shots/$SLUG"
  # `.[0] // empty` matters: with no open PR, `.[0] | "…"` prints "null\tnull" (the string form of the
  # null object), and that literal once reached `merge-base --is-ancestor null` below, so every fresh NAS
  # result was held as "branch diverged" and never published. Absent means absent; it is not a rev.
  PRINFO="$(with_timeout "$GH_T" "$GH_BIN" pr list --repo "$GH_REPO" --head "$BR" --state open --json number,headRefOid --jq '.[0] // empty | "\(.number)\t\(.headRefOid)"' 2>/dev/null)"
  PRN="${PRINFO%%$'\t'*}"; PRHEAD=""
  case "$PRINFO" in *$'\t'*) PRHEAD="${PRINFO#*$'\t'}";; esac
  case "$PRN" in ''|*[!0-9]*) PRN="";; esac
  # Defence in depth: only a hex object name may be fed to git (a degraded `gh` must not fake a divergence).
  case "$PRHEAD" in ''|*[!0-9a-f]*) PRHEAD="";; esac
  NEEDS_SHOTS=0; HOLD_WHY=""
  [ "$DIFF_FAILED" = 1 ] && { NEEDS_SHOTS=1; HOLD_WHY="cannot diff the branch against origin/main"; }
  [ -n "$VISIBLE" ] && { NEEDS_SHOTS=1; HOLD_WHY="visible UI changed and no two-width shots in $SHOTS"; }
  [ -s "$PRB" ] && grep -qiE '^screenshots?: *pending' "$PRB" && { NEEDS_SHOTS=1; HOLD_WHY="${HOLD_WHY:-worker reported screenshots pending}"; }
  [ "$NEEDS_SHOTS" = 1 ] && shots_ok "$SHOTS" && NEEDS_SHOTS=0
  # Enforcement applies to incoming changes whether or not a PR already exists (M6b). An open PR keeps its
  # previous head: pushing this result would publish visible UI with no captures and hand it to merge.
  if [ "$NEEDS_SHOTS" = 1 ]; then
    printf '\nScreenshots: pending Mac capture at 390x844 and 1100x760 (NAS worker has no browser). Visible files: %s\n' "$(echo "$VISIBLE" | tr '\n' ' ')" >> "$PRB"
    if [ -z "$PRN" ]; then
      with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
      hold_slug "$SLUG" "$ITEM" "$J" "$HOLD_WHY"
    else
      hold_slug "$SLUG" "$ITEM" "$J" "$HOLD_WHY" "$PRN"
    fi
    mark_remote "$SLUG" "$IDENT" held
    ack "$ACK_KEY"
    continue
  fi

  # Prose claim rule: never publish a body the merge lane would send back (R-nas-claim-gate). A new
  # branch is pushed so the work survives for the local rework. An already-open PR keeps its previous
  # head: merge.sh claim-checks the live body against the head's diff, so pushing this commit under the
  # previous body would let it merge prose this gate just rejected.
  if ! claim_gate "$SLUG" "$J" "$PRB" "$WT" "$REF"; then
    PUSH_NOTE=""
    if [ -z "$PRN" ]; then
      with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" \
        || PUSH_NOTE="branch push failed: $(tail -c 200 "$STATE/nas/push.err")"
    fi
    hold_claim "$SLUG" "$ITEM" "$J" "$CLAIM_WHY" "$PRN" "$CLAIM_OUT" "$PUSH_NOTE"
    mark_remote "$SLUG" "$IDENT" held
    ack "$ACK_KEY"
    continue
  fi

  # The merge lane's 1000-line cap, held before the heavy self-check: an oversize NAS result is
  # sent back by merge.sh as hold-size anyway, so publishing it buys a sendback round and nothing
  # else. The waiver is the same file merge.sh honours; the branch is pushed so the work survives.
  NAS_SIZE="$(GIT="$GIT" bash "$RSI_DIR/runtime/diff-size.sh" "$WT" 2>/dev/null || echo 0)"
  case "$NAS_SIZE" in ''|*[!0-9]*) NAS_SIZE=0;; esac
  if [ "$NAS_SIZE" -gt 1000 ] && [ ! -f "$STATE/merge/$SLUG.size-ok" ]; then
    PUSH_NOTE=""
    if [ -z "$PRN" ]; then
      with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" \
        || PUSH_NOTE="branch push failed: $(tail -c 200 "$STATE/nas/push.err")"
    fi
    hold_oversize "$SLUG" "$ITEM" "$J" "$NAS_SIZE" "$PRN" "$PUSH_NOTE"
    mark_remote "$SLUG" "$IDENT" held
    ack "$ACK_KEY"
    continue
  fi

  SC="green"
  if selfcheck_mac "$WT" "$J"; then
    echo "self-check green $SLUG"
  else
    SC="FAILING (see selfcheck.txt; merge lane will send back if needed)"
    echo "self-check failing $SLUG; handing over anyway"
  fi
  [ -s "$PRB" ] || printf 'RSI item: %s\n' "$ITEM" > "$PRB"
  # A body may end mid-line inside its Claim output block. Every append therefore starts with a
  # blank line: claim_check.py reads the non-blank lines after `Claim output:` as claimed output,
  # and an appended Mac line that joined that block would fail the merge lane on the very body the
  # NAS gate just passed (found by the pre-landing review).
  grep -q "RSI item:" "$PRB" || printf '\n\nRSI item: %s\n' "$ITEM" >> "$PRB"
  printf '\n\nMac self-check after NAS hand-over: %s (tsc, UI inventory ratchet, full vitest; %s).\n' "$SC" "${SELFCHECK_RN_NOTE:-mobile-rn skipped (no mobile-rn/ or ui/src path changed)}" >> "$PRB"

  # Ownership must still hold at the moment of publishing, not only before the self-check (M3).
  if ! claim_owned "$SLUG" "$JOB_LAUNCH"; then
    echo "claim for $SLUG changed hands during the self-check; not publishing"
    continue
  fi
  # The PR head must contain this job's commit before the result is consumed, whether the PR already exists
  # or not (M7). Non-fast-forward means a merge/rework lane added commits: hold both sides, discard neither.
  if ! LSOUT="$(with_timeout "$SSH_T" "$GIT" -C "$CTRL" ls-remote origin "refs/heads/$BR" 2>/dev/null)"; then
    echo "cannot read origin/$BR; not publishing $SLUG"; continue
  fi
  REMOTE_SHA="$(printf '%s\n' "$LSOUT" | awk 'NR==1{print $1}')"
  DIVERGED=""
  for H in "$REMOTE_SHA" "$PRHEAD"; do
    [ -n "$H" ] || continue
    with_timeout 60 "$GIT" -C "$CTRL" merge-base --is-ancestor "$H" "$WANT" || DIVERGED="$H"
  done
  if [ -n "$DIVERGED" ]; then
    hold_diverged "$SLUG" "$ITEM" "$REMOTE_SHA" "$PRN"
    mark_remote "$SLUG" "$IDENT" held
    ack "$ACK_KEY"
    continue
  fi
  with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
  if [ -z "$PRN" ]; then
    TITLE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('pr_title') or 'chore(rsi): $ITEM $SLUG')")"
    URL="$(with_timeout "$GH_T" "$GH_BIN" pr create --repo "$GH_REPO" --base main --head "$BR" --title "$TITLE" --body-file "$PRB" 2>&1 | tail -1)"
    PRN="$(echo "$URL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"; [ -n "$PRN" ] || { echo "pr create failed $SLUG: $URL"; continue; }
  else
    with_timeout "$GH_T" "$GH_BIN" pr edit "$PRN" --repo "$GH_REPO" --body-file "$PRB" >/dev/null 2>&1 \
      || echo "branch pushed; could not update the PR #$PRN body for $SLUG"
  fi
  HIST_TS="$("$DATE_BIN" +%Y%m%d-%H%M%S)"
  HIST_OUT="$STATE/lanes/history/$HIST_TS-$SLUG.json"
  HIST_N=1
  while [ -e "$HIST_OUT" ]; do
    HIST_N=$((HIST_N + 1))
    HIST_OUT="$STATE/lanes/history/$HIST_TS-$SLUG-$HIST_N.json"
  done   # two results in one second are two rows
  python3 - "$HIST_OUT" "$SLUG" "$ITEM" "$PRN" "$STATE/cloud/$SLUG.json" "$SC" <<'PY'
import json,sys,time,os
out,slug,item,pr,cf,sc=sys.argv[1:7]
paths=json.load(open(cf)).get("paths",[]) if os.path.exists(cf) else []
json.dump(dict(lane="nas",slug=slug,item=item,mode="nas",paths=paths,status="done",pr=int(pr),claimed_at=time.time(),finished_at=time.time(),note="nas lane",selfcheck=sc),open(out,"w"))
PY
  release_claim "$SLUG" done "$JOB_LAUNCH" \
    || echo "claim for $SLUG was not released (another executor owns it now)"
  mark_remote "$SLUG" "$IDENT" ingested
  ack "$ACK_KEY"
  with_timeout 60 "$GIT" -C "$CTRL" update-ref -d "$REF" 2>/dev/null
  echo "ingested $ITEM $SLUG -> PR #$PRN ($SC)"
  KICK=1
done 3<<< "$LIST"

sort -u "$STATE/nas/acks.txt" -o "$STATE/nas/acks.txt" 2>/dev/null || true
[ $KICK -eq 1 ] && [ -z "${NAS_NO_MERGE:-}" ] && { nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null; }
true
