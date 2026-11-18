#!/bin/bash
# pulse-nas.sh — Mac-driven unattended NAS fill. Invoked by launchd (every 20 min) and by run.sh pulse.
# 1) Ingest any finished NAS jobs (self-check on the Mac, push, open PR, release claim).
# 2) If a NAS lane is idle, claim a ready cloud brief that nobody has taken (respect `taker`; never steal
#    taker=box or taker=nas), set taker=nas, ship brief + origin/main git bundle over ssh, start nas-lane.sh
#    in the isolated container (agent thinking only).
# Lanes: NAS_MAX_LANES=2, but lane 2 only starts when NAS 1-min load < 3 and MemAvailable > 6 GB.
set -u
# scp -O: this NAS's SFTP subsystem does not see the same paths as ssh ("dest open ...: No such file"), so the default SFTP-mode scp
# failed every transfer (N3 sat as a dead NAS claim from 16:49). Legacy scp protocol works.
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
NAS_HOST="${NAS_HOST:-nas}"
REMOTE="${NAS_REMOTE:-$(ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$NAS_HOST" 'printf %s "$HOME/kin-rsi-nas"' 2>/dev/null || true)}"
case "$REMOTE" in /*) ;; *) REMOTE="";; esac
NAS_MAX_LANES="${NAS_MAX_LANES:-2}"
NAS_LOAD_MAX="${NAS_LOAD_MAX:-3}"
NAS_MEM_MIN_GB="${NAS_MEM_MIN_GB:-6}"
HOLD_HOURS="${RSI_NAS_CLAIM_HOURS:-5}"
MAX_START_FAILS="${NAS_MAX_START_FAILS:-2}"
mkdir -p "$STATE/nas" "$STATE/lanes" "$RUNS"

[ -e "$STATE/PAUSE" ] && { echo "paused ($STATE/PAUSE)"; exit 0; }

LOCK="$STATE/nas/.pulse.lock"
if mkdir "$LOCK" 2>/dev/null; then
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
else
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then echo "skip: nas pulse already running pid $OLD"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || { echo "skip: could not take nas pulse lock"; exit 0; }
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
fi

log() { echo "[$(date '+%F %H:%M:%S %Z')] $*"; }

# 1. Ingest finished work first so a slot frees before we claim more.
bash "$RSI_DIR/runtime/nas/ingest-nas.sh" || log "ingest-nas exited $?"

# Honour the Volcengine ¥560 worker stop. Ingest/acks already ran above; no new NAS jobs today.
if type rsi_allow_workers >/dev/null 2>&1 && ! rsi_allow_workers; then
  log "volc budget: not starting new NAS jobs until next Asia/Singapore day"
  exit 0
fi
if type rsi_open_pr_backpressure >/dev/null 2>&1 && rsi_open_pr_backpressure; then
  log "open PR backpressure (${RSI_OPEN_RSI_PRS} active rsi PRs >= ${RSI_MAX_OPEN_PRS}, total open ${RSI_OPEN_TOTAL_PRS}): not starting new NAS jobs (rework + merge only)"
  exit 0
fi

# 2. Capacity: is the stack up? What is load/mem? How many lanes are running on the NAS?
[ -n "$REMOTE" ] || { log "NAS unreachable or remote path unresolved"; exit 0; }
if ! ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$NAS_HOST" "docker inspect -f '{{.State.Running}}' kin-rsi-nas-worker 2>/dev/null | grep -q true"; then
  log "NAS worker container not running; try $RSI_DIR/runtime/nas/install-nas.sh"
  exit 0
fi

CAP=$(ssh -n -o BatchMode=yes "$NAS_HOST" "python3 - <<'PY'
import os
load=float(open('/proc/loadavg').read().split()[0])
avail=0.0
for line in open('/proc/meminfo'):
    if line.startswith('MemAvailable:'):
        avail=int(line.split()[1])/1024/1024
        break
print(f'{load:.2f} {avail:.2f}')
PY")
LOAD="${CAP%% *}"; MEM="${CAP##* }"
echo "$(date +%s) load=$LOAD mem_avail_gb=$MEM" >> "$STATE/nas/load.log"
log "NAS load=$LOAD mem_avail=${MEM}G"

ALLOWED=1
awk -v l="$LOAD" -v m="$MEM" -v lmax="$NAS_LOAD_MAX" -v mmin="$NAS_MEM_MIN_GB" 'BEGIN{exit !((l+0)<(lmax+0) && (m+0)>(mmin+0))}' \
  && ALLOWED=$NAS_MAX_LANES || ALLOWED=1
# Even lane 1 stands down if the box is already under severe pressure (load >= 5 or mem < 3 GB).
awk -v l="$LOAD" -v m="$MEM" 'BEGIN{exit !((l+0)>=5 || (m+0)<3)}' && { log "NAS under pressure (load>=5 or mem<3G); not starting new work"; ALLOWED=0; }

# Running jobs on the NAS (status=running). A lane killed by a container recreate leaves `running`
# behind and ingest never consumes it, so a record counts only while its stamp is fresh. The lane
# watchdog kills a worker at 3000 s; two hours is well past that and still frees a leaked slot.
RUNNING=$(ssh -n -o BatchMode=yes "$NAS_HOST" "python3 - <<'PY'
import json,os,glob,sys,time
n=0; now=time.time()
for d in glob.glob('$REMOTE/work/jobs/*/status.json'):
    try:
        j=json.load(open(d))
        if j.get('status')!='running': continue
        try: ts=float(j.get('updated_at') or j.get('started_at') or 0)
        except (TypeError,ValueError): ts=0
        if ts and now-ts <= 7200: n+=1
        else:
            print('skip stale running record %s (age %ds)' % (os.path.basename(os.path.dirname(d)), int(now-ts) if ts else -1), file=sys.stderr)
    except Exception:
        pass
print(n)
PY")
RUNNING="${RUNNING:-0}"
IDLE=$(( ALLOWED - RUNNING ))
log "allowed=$ALLOWED running=$RUNNING idle_slots=$IDLE"
[ "$IDLE" -gt 0 ] || { log "no idle NAS slot"; exit 0; }

# 3. Claim ready cloud briefs with no taker (never steal box/nas). Prefer those over anything else.
: > "$STATE/nas/claim-this-round.txt"
PACKED=0
for f in "$STATE"/cloud/*.json; do
  [ -f "$f" ] || continue
  [ "$PACKED" -ge "$IDLE" ] && break
  if ROW=$(python3 - "$f" "$HOLD_HOURS" "$RSI_CTRL" "$STATE" "$MAX_START_FAILS" <<'PYN'
import json,os,sys,time
f,hrs,ctrl,state,maxf=sys.argv[1:6]
d=json.load(open(f))
taker=(d.get("taker") or "").strip()
if taker:
    sys.exit(1)  # already taken (box, nas, or anyone else)
if int(d.get("nas_start_failures") or 0) >= int(maxf):
    print("blocked after repeated start failures: %s" % d.get("slug"), file=sys.stderr)
    sys.exit(3)
slug=d["slug"]
brief_rel=d.get("brief","")
cand=[brief_rel, os.path.join(ctrl,brief_rel), os.path.join(state,"cloud-briefs",slug+".md")]
brief=next((c for c in cand if c and os.path.isfile(c)), "")
if not brief:
    sys.exit(2)
now=time.time()
d.update(taker="nas", status="launched", launched_at=now,
         claimed_at=now, expires_at=now+float(hrs)*3600)
json.dump(d, open(f,"w"))
print(slug, d["item"], brief, flush=True)
PYN
  ); then
    echo "$ROW" >> "$STATE/nas/claim-this-round.txt"
    PACKED=$((PACKED+1))
  fi
done
CLAIMED=0

# Put a claimed cloud brief back after a start failure (never clobber a new owner). The ownership
# transition takes the same state/lanes/.flock the scheduler uses, so a concurrent claim is never
# read or written half-way. A brief that keeps failing to start stops being retried.
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

while read -r -u 3 SLUG ITEM BRIEF; do
  [ -n "${SLUG:-}" ] || continue
  [ "$CLAIMED" -ge "$IDLE" ] && break
  case "$SLUG" in *[!a-z0-9._-]*|"") log "skip bad slug $SLUG"; continue;; esac
  [ -f "$BRIEF" ] || { log "brief missing for $SLUG"; continue; }

  # Ship job.json + origin/main bundle.
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null || true
  BUNDLE="$STATE/nas/origin-main-$SLUG.bundle"
  $GIT -C "$RSI_CTRL" bundle create "$BUNDLE" origin/main
  JOBDIR="$STATE/nas/xfer/$SLUG"; mkdir -p "$JOBDIR"
  python3 - "$JOBDIR/job.json" "$ITEM" "$BRIEF" "$STATE/cloud/$SLUG.json" <<'PY'
import json,sys,os
out,item,brief,cf=sys.argv[1:5]
meta=json.load(open(cf)) if os.path.exists(cf) else {}
paths=meta.get("paths",[])
launched_at=meta.get("launched_at")
payload=dict(item=item,paths=paths,brief=open(brief).read())
if launched_at is not None:
    payload["launched_at"]=launched_at
json.dump(payload, open(out,"w"))
PY
  # A ship that fails leaves no job.json on the NAS, so ingest never sees a result and the claim burns
  # the 5 h hold — the same slot leak as a failed start. Hand the brief back before the exec.
  if ! { ssh -n -o BatchMode=yes "$NAS_HOST" "mkdir -p '$REMOTE/work/jobs/$SLUG' '$REMOTE/work/logs'" &&
         scp -O -q "$JOBDIR/job.json" "$BUNDLE" "$NAS_HOST:$REMOTE/work/jobs/$SLUG/" &&
         ssh -n -o BatchMode=yes "$NAS_HOST" "mv -f '$REMOTE/work/jobs/$SLUG/origin-main-$SLUG.bundle' '$REMOTE/work/jobs/$SLUG/origin-main.bundle' 2>/dev/null || mv -f '$REMOTE/work/jobs/$SLUG/'*.bundle '$REMOTE/work/jobs/$SLUG/origin-main.bundle'" &&
         ssh -n -o BatchMode=yes "$NAS_HOST" "printf '%s\\n' '{\"status\":\"queued\",\"slug\":\"$SLUG\"}' > '$REMOTE/work/jobs/$SLUG/status.json'"; }; then
    log "ship failed for $SLUG"
    unclaim "$SLUG" "ship failed"
    continue
  fi

  # Start the lane detached inside the container. A start that fails must not burn the slot: mark the
  # record failed, hand the brief back, and stop retrying it after MAX_START_FAILS.
  if ! ssh -n -o BatchMode=yes "$NAS_HOST" "docker exec -d -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker /bin/bash /opt/rsi/nas-lane.sh $SLUG"; then
    log "container start failed for $SLUG"
    ssh -n -o BatchMode=yes "$NAS_HOST" "printf '%s\\n' '{\"status\":\"failed\",\"slug\":\"$SLUG\",\"note\":\"container start failed (docker exec)\",\"updated_at\":$(date +%s)}' > '$REMOTE/work/jobs/$SLUG/status.json'"
    unclaim "$SLUG" "container start failed"
    continue
  fi
  log "started NAS lane for $ITEM $SLUG (taker=nas)"
  echo "$(date '+%F %H:%M:%S') start $ITEM $SLUG load=$LOAD mem=$MEM" >> "$STATE/nas/starts.log"
  CLAIMED=$((CLAIMED+1))
done 3< "$STATE/nas/claim-this-round.txt"

[ "$CLAIMED" -eq 0 ] && log "no untaken cloud briefs (taker already set or none ready)"
log "pulse-nas done, started $CLAIMED"
exit 0
