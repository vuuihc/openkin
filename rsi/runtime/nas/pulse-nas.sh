#!/bin/bash
# pulse-nas.sh — Mac-driven unattended NAS fill. Invoked by launchd (every 20 min) and by run.sh pulse.
# 1) Probe the NAS with a bounded ssh. 2) Ingest any finished NAS jobs (self-check on the Mac, push, open
#    PR, release claim). 3) Reconcile remote job records with real worker processes. 4) If a NAS lane is
#    idle, claim a ready cloud brief that nobody has taken (respect `taker`; never steal taker=box or
#    taker=nas), set taker=nas under the scheduler's shared flock, ship brief + origin/main git bundle
#    over ssh, start nas-lane.sh in the isolated container (agent thinking only).
# Lanes: NAS_MAX_LANES=2, but lane 2 only starts when NAS 1-min load < 3 and MemAvailable > 6 GB.
# Every remote call is bounded: a hung ssh dies with the pulse instead of holding the lock forever.
# The pulse lock is owned (a skipped pulse never removes it) and failed worker discovery stops the pulse
# before it can read "no live processes" as "every running job is dead".
set -u
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
STATE="${NAS_STATE:-$STATE}"; export RSI_STATE="$STATE"
CTRL="${NAS_CTRL:-$RSI_CTRL}"
NAS_HOST="${NAS_HOST:-nas}"
NAS_MAX_LANES="${NAS_MAX_LANES:-2}"
NAS_LOAD_MAX="${NAS_LOAD_MAX:-3}"
NAS_MEM_MIN_GB="${NAS_MEM_MIN_GB:-6}"
HOLD_HOURS="${RSI_NAS_CLAIM_HOURS:-5}"
MAX_JOB_SECS="${NAS_JOB_MAX_SECS:-3900}"     # nas-lane.sh kills its worker at 3000s; past this it is abandoned
MAX_START_FAILS="${NAS_MAX_START_FAILS:-2}"
SSH_BIN="${NAS_SSH:-ssh}"
SCP_BIN="${NAS_SCP:-scp}"
# -n keeps ssh/scp from draining the claim list we are looping over (M3).
SSH=("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -n)
SSH_T="${NAS_SSH_TIMEOUT:-90}"
XFER_T="${NAS_XFER_TIMEOUT:-600}"
INGEST_T="${NAS_INGEST_TIMEOUT:-3600}"
PULSE_MAX_SECS="${NAS_PULSE_MAX_SECS:-7200}"
mkdir -p "$STATE/nas" "$STATE/lanes" "$RUNS"

log() { echo "[$(date '+%F %H:%M:%S %Z')] $*"; }
[ -e "$STATE/PAUSE" ] && { echo "paused ($STATE/PAUSE)"; exit 0; }

LOCK="$STATE/nas/.pulse.lock"
HAVE_LOCK=0
# Only ever remove a lock this pulse still owns (M1): a skipped second pulse must not delete the running
# pulse's lock, or a third pulse would start ingestion alongside it.
cleanup() {
  [ "$HAVE_LOCK" = 1 ] || return 0
  [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ] || return 0
  rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
take_lock() {
  mkdir "$LOCK" 2>/dev/null || return 1
  echo $$ > "$LOCK/pid"; date +%s > "$LOCK/started"
  return 0
}
if ! take_lock; then
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  STARTED="$(cat "$LOCK/started" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo 0)"
  AGE=$(( $(date +%s) - ${STARTED:-0} ))
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null && [ "$AGE" -lt "$PULSE_MAX_SECS" ]; then
    echo "skip: nas pulse already running pid $OLD (${AGE}s)"; exit 0
  fi
  if [ -z "$OLD" ] && [ "$AGE" -lt 60 ]; then
    echo "skip: another pulse is taking the nas pulse lock"; exit 0
  fi
  # A pulse older than the bound is wedged; only reclaim our own script, never an unrelated pid.
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null && ps -o command= -p "$OLD" 2>/dev/null | grep -q 'pulse-nas\.sh'; then
    log "reclaiming wedged nas pulse pid $OLD (${AGE}s >= ${PULSE_MAX_SECS}s)"
    kill -TERM "$OLD" 2>/dev/null || true; sleep 2; kill -KILL "$OLD" 2>/dev/null || true
  fi
  # Reclaim only the exact stale lock we inspected; if someone else already replaced it, leave theirs (M1).
  [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$OLD" ] && rm -rf "$LOCK"
  take_lock || { echo "skip: could not take nas pulse lock"; exit 0; }
fi
HAVE_LOCK=1

# 0. Bounded reachability probe before anything else. On failure, do nothing remote this round.
REMOTE="${NAS_REMOTE:-}"
if [ -z "$REMOTE" ]; then
  REMOTE="$(with_timeout 30 "${SSH[@]}" "$NAS_HOST" 'printf %s "$HOME/kin-rsi-nas"' 2>/dev/null)" || REMOTE=""
  case "$REMOTE" in /*) ;; *) REMOTE="";; esac
fi
if [ -z "$REMOTE" ] || ! with_timeout 30 "${SSH[@]}" "$NAS_HOST" true 2>/dev/null; then
  log "NAS unreachable (bounded probe); skipping this pulse"
  exit 0
fi

# 1. Ingest finished work first so a slot frees before we claim more.
with_timeout "$INGEST_T" bash "$RSI_DIR/runtime/nas/ingest-nas.sh" || log "ingest-nas exited $? (bounded ${INGEST_T}s)"

# 2. Capacity: is the stack up? What is load/mem? How many lanes are really running?
if ! with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "docker inspect -f '{{.State.Running}}' kin-rsi-nas-worker 2>/dev/null | grep -q true"; then
  log "NAS worker container not running; the container stack is a follow-up slice (runtime/nas/README.md)"
  exit 0
fi

CAP=$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "python3 - <<'PY'
import os
load=float(open('/proc/loadavg').read().split()[0])
avail=0.0
for line in open('/proc/meminfo'):
    if line.startswith('MemAvailable:'):
        avail=int(line.split()[1])/1024/1024
        break
print(f'{load:.2f} {avail:.2f}')
PY") || CAP=""
if [ -z "$CAP" ]; then log "capacity probe failed; not starting new work"; exit 0; fi
LOAD="${CAP%% *}"; MEM="${CAP##* }"
echo "$(date +%s) load=$LOAD mem_avail_gb=$MEM" >> "$STATE/nas/load.log"
log "NAS load=$LOAD mem_avail=${MEM}G"

ALLOWED=1
awk -v l="$LOAD" -v m="$MEM" -v lmax="$NAS_LOAD_MAX" -v mmin="$NAS_MEM_MIN_GB" 'BEGIN{exit !((l+0)<(lmax+0) && (m+0)>(mmin+0))}' \
  && ALLOWED=$NAS_MAX_LANES || ALLOWED=1
# Even lane 1 stands down if the box is already under severe pressure (load >= 5 or mem < 3 GB).
awk -v l="$LOAD" -v m="$MEM" 'BEGIN{exit !((l+0)>=5 || (m+0)<3)}' && { log "NAS under pressure (load>=5 or mem<3G); not starting new work"; ALLOWED=0; }

# Reconcile persisted job records with the container's real processes (M6). A running record whose
# nas-lane.sh process is gone, or any queued/running record older than MAX_JOB_SECS, is marked failed
# so it is ingested (claim released, one notice) instead of occupying a slot forever.
SCAN='docker exec kin-rsi-nas-worker sh -c '"'"'for d in /proc/[0-9]*; do c=$(tr "\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *nas-lane.sh*) echo "$c";; esac; done'"'"''
# Discovery must succeed before it can be trusted (M2): a failed ssh/docker used to leave ALIVE empty,
# which reconciliation read as "every running worker is dead" and replaced live jobs.
if ! SCAN_OUT="$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "$SCAN" 2>/dev/null)"; then
  log "worker process discovery failed (ssh/docker); not reconciling and not starting new work"
  exit 0
fi
ALIVE="$(printf '%s\n' "$SCAN_OUT" | sed -n 's#.*nas-lane\.sh \([a-z0-9._-]*\).*#\1#p' | sort -u | tr '\n' ' ')"
RUNNING=$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "ALIVE='$ALIVE' MAXJOB='$MAX_JOB_SECS' ROOT='$REMOTE' python3 - <<'PY'
import json,os,glob,time,sys
root=os.environ['ROOT']; alive=set(os.environ.get('ALIVE','').split()); mx=int(os.environ['MAXJOB'])
now=time.time(); live=0; dead=[]
for p in sorted(glob.glob(os.path.join(root,'work','jobs','*','status.json'))):
    slug=os.path.basename(os.path.dirname(p))
    try: d=json.load(open(p))
    except Exception: continue
    st=d.get('status')
    if st not in ('queued','running'): continue
    since=float(d.get('started_at') or d.get('updated_at') or 0)
    if st=='running' and slug not in alive:
        d.update(status='failed', note='worker process gone (container restart or OOM)', finished_at=now, updated_at=now)
    elif now-since > mx:
        d.update(status='failed', note='abandoned after %ds with no result'%mx, finished_at=now, updated_at=now)
    else:
        live+=1; continue
    tmp=p+'.tmp'; json.dump(d,open(tmp,'w')); os.replace(tmp,p); dead.append(slug)
print(live)
if dead: print('reconciled failed: '+','.join(dead), file=sys.stderr)
PY") || RUNNING=""
if [ -z "$RUNNING" ]; then log "job record reconcile failed; not starting new work"; exit 0; fi
IDLE=$(( ALLOWED - RUNNING ))
log "allowed=$ALLOWED running=$RUNNING idle_slots=$IDLE"
[ "$IDLE" -gt 0 ] || { log "no idle NAS slot"; exit 0; }

# 3. Claim ready cloud briefs with no taker (never steal box/nas). The ownership transition happens
#    under the same state/lanes/.flock that lanes.py uses, and is written by atomic replacement, so a
#    concurrent scheduler never reads a truncated claim (M5).
: > "$STATE/nas/claim-this-round.txt"
PACKED=0
for f in "$STATE"/cloud/*.json; do
  [ -f "$f" ] || continue
  [ "$PACKED" -ge "$IDLE" ] && break
  if ROW=$(python3 - "$STATE/lanes" "$f" "$HOLD_HOURS" "$MAX_START_FAILS" <<'PYN'
import fcntl,json,os,sys,time
ldir,f,hrs,maxf=sys.argv[1:5]
lock=open(os.path.join(ldir,'.flock'),'w')
fcntl.flock(lock,fcntl.LOCK_EX)
try:
    d=json.load(open(f))
    if (d.get('taker') or '').strip(): sys.exit(1)          # already taken (box, nas, or anyone else)
    if int(d.get('nas_start_failures') or 0) >= int(maxf):
        print('blocked after repeated start failures: %s' % d.get('slug'), file=sys.stderr); sys.exit(3)
    d.update(taker='nas', status='launched', launched_at=time.time(),
             claimed_at=time.time()+float(hrs)*3600-10800)
    tmp=f+'.tmp'
    json.dump(d,open(tmp,'w')); os.replace(tmp,f)
finally:
    fcntl.flock(lock,fcntl.LOCK_UN); lock.close()
print(d['slug'], d['item'], d.get('brief',''), sep='\t')
PYN
  ); then
    echo "$ROW" >> "$STATE/nas/claim-this-round.txt"
    PACKED=$((PACKED+1))
  fi
done
CLAIMED=0

# Put a claimed cloud brief back for someone else after a start failure (never clobber a new owner).
unclaim() { # slug reason
  python3 - "$STATE/lanes" "$STATE/cloud/$1.json" "$1" "$2" <<'PYU' >/dev/null 2>&1 || true
import fcntl,json,os,sys,time
ldir,f,slug,why=sys.argv[1:5]
if not os.path.exists(f): sys.exit(0)
lock=open(os.path.join(ldir,'.flock'),'w'); fcntl.flock(lock,fcntl.LOCK_EX)
try:
    d=json.load(open(f))
    if (d.get('taker') or '')!='nas' or d.get('slug')!=slug: sys.exit(0)
    for k in ('taker','status','launched_at','claimed_at'): d.pop(k,None)
    d['nas_start_failures']=int(d.get('nas_start_failures') or 0)+1
    d['nas_last_start_error']=why; d['nas_last_start_at']=time.time()
    tmp=f+'.tmp'; json.dump(d,open(tmp,'w')); os.replace(tmp,f)
finally:
    fcntl.flock(lock,fcntl.LOCK_UN); lock.close()
PYU
}

# Claims are read on fd 3; remote commands get -n and never share this descriptor (M3).
exec 3< "$STATE/nas/claim-this-round.txt"
while IFS=$'\t' read -r SLUG ITEM BRIEF_REL <&3; do
  [ -n "${SLUG:-}" ] || continue
  [ "$CLAIMED" -ge "$IDLE" ] && break
  case "$SLUG" in *[!a-z0-9._-]*|"") log "skip bad slug $SLUG"; unclaim "${SLUG:-bad}" "bad slug"; continue;; esac
  BRIEF="$BRIEF_REL"
  [ -f "$BRIEF" ] || BRIEF="$CTRL/$BRIEF_REL"
  [ -f "$BRIEF" ] || BRIEF="$STATE/cloud-briefs/$SLUG.md"
  [ -f "$BRIEF" ] || { log "brief missing for $SLUG"; unclaim "$SLUG" "brief missing"; continue; }

  # Ship job.json + origin/main bundle.
  with_timeout "$XFER_T" "$GIT" -C "$CTRL" fetch -q origin main 2>/dev/null || log "origin fetch failed; using existing origin/main for $SLUG"
  BUNDLE="$STATE/nas/origin-main-$SLUG.bundle"
  if ! with_timeout "$XFER_T" "$GIT" -C "$CTRL" bundle create "$BUNDLE" origin/main; then
    log "bundle create failed for $SLUG"; unclaim "$SLUG" "bundle create failed"; continue
  fi
  JOBDIR="$STATE/nas/xfer/$SLUG"; mkdir -p "$JOBDIR"
  python3 - "$JOBDIR/job.json" "$ITEM" "$BRIEF" "$STATE/cloud/$SLUG.json" <<'PY' || { log "job.json failed for $SLUG"; unclaim "$SLUG" "job.json failed"; continue; }
import json,sys,os
out,item,brief,cf=sys.argv[1:5]
d=json.load(open(cf)) if os.path.exists(cf) else {}
# launched_at is this run's identity: ingest only releases a claim whose stamp still matches (M3).
json.dump(dict(item=item,paths=d.get("paths",[]),launched_at=d.get("launched_at"),brief=open(brief).read()), open(out,"w"))
PY

  if ! with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "mkdir -p '$REMOTE/work/jobs/$SLUG' '$REMOTE/work/logs'"; then
    log "remote mkdir failed for $SLUG"; unclaim "$SLUG" "remote mkdir failed"; continue
  fi
  if ! with_timeout "$XFER_T" "$SCP_BIN" -q "$JOBDIR/job.json" "$BUNDLE" "$NAS_HOST:$REMOTE/work/jobs/$SLUG/"; then
    log "scp failed for $SLUG"; unclaim "$SLUG" "scp failed"; continue
  fi
  if ! with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "mv -f '$REMOTE/work/jobs/$SLUG/origin-main-$SLUG.bundle' '$REMOTE/work/jobs/$SLUG/origin-main.bundle' 2>/dev/null || mv -f '$REMOTE/work/jobs/$SLUG/'*.bundle '$REMOTE/work/jobs/$SLUG/origin-main.bundle'"; then
    log "bundle move failed for $SLUG"; unclaim "$SLUG" "bundle move failed"; continue
  fi
  # Starter status so a crash before nas-lane.sh still looks queued, not stale-running.
  with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "printf '%s\\n' '{\"status\":\"queued\",\"slug\":\"$SLUG\",\"updated_at\":$(date +%s)}' > '$REMOTE/work/jobs/$SLUG/status.json'"

  # Start the lane detached inside the container.
  if ! with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "docker exec -d -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker /bin/bash /opt/rsi/nas-lane.sh $SLUG"; then
    log "container start failed for $SLUG"
    with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "printf '%s\\n' '{\"status\":\"failed\",\"slug\":\"$SLUG\",\"note\":\"container start failed (docker exec)\",\"updated_at\":$(date +%s)}' > '$REMOTE/work/jobs/$SLUG/status.json'"
    unclaim "$SLUG" "container start failed"; continue
  fi
  rm -f "$BUNDLE"
  log "started NAS lane for $ITEM $SLUG (taker=nas)"
  echo "$(date '+%F %H:%M:%S') start $ITEM $SLUG load=$LOAD mem=$MEM" >> "$STATE/nas/starts.log"
  CLAIMED=$((CLAIMED+1))
done
exec 3<&-

[ "$CLAIMED" -eq 0 ] && log "no untaken cloud briefs (taker already set or none ready)"
log "pulse-nas done, started $CLAIMED"
exit 0
