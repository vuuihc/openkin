#!/bin/bash
# pulse-nas.sh — Mac-driven unattended NAS fill. Invoked by launchd (every 20 min) and by run.sh pulse.
# 1) Ingest any finished NAS jobs (self-check on the Mac, push, open PR, release claim).
# 2) If a NAS lane is idle, claim a ready cloud brief that nobody has taken (respect `taker`; never steal
#    taker=box or taker=nas), set taker=nas, ship brief + origin/main git bundle over ssh, start nas-lane.sh
#    in the isolated container (agent thinking only).
# Lanes: NAS_MAX_LANES=2, but lane 2 only starts when NAS 1-min load < 3 and MemAvailable > 6 GB.
set -u
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
NAS_HOST="${NAS_HOST:-nas}"
REMOTE="${NAS_REMOTE:-/home/zhushihao/kin-rsi-nas}"
NAS_MAX_LANES="${NAS_MAX_LANES:-2}"
NAS_LOAD_MAX="${NAS_LOAD_MAX:-3}"
NAS_MEM_MIN_GB="${NAS_MEM_MIN_GB:-6}"
HOLD_HOURS="${RSI_NAS_CLAIM_HOURS:-5}"
mkdir -p "$STATE/nas" "$RUNS"

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

# 2. Capacity: is the stack up? What is load/mem? How many lanes are running on the NAS?
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$NAS_HOST" "docker inspect -f '{{.State.Running}}' kin-rsi-nas-worker 2>/dev/null | grep -q true"; then
  log "NAS worker container not running; try $RSI_DIR/runtime/nas/install-nas.sh"
  exit 0
fi

CAP=$(ssh -o BatchMode=yes "$NAS_HOST" "python3 - <<'PY'
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

# Running jobs on the NAS (status=running).
RUNNING=$(ssh -o BatchMode=yes "$NAS_HOST" "python3 - <<'PY'
import json,os,glob
n=0
for d in glob.glob('$REMOTE/work/jobs/*/status.json'):
    try:
        if json.load(open(d)).get('status')=='running': n+=1
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
  if ROW=$(python3 - "$f" "$HOLD_HOURS" <<'PYN'
import json,sys,time
f,hrs=sys.argv[1:3]
d=json.load(open(f))
taker=(d.get("taker") or "").strip()
if taker:
    sys.exit(1)  # already taken (box, nas, or anyone else)
d.update(taker="nas", status="launched", launched_at=time.time(),
         claimed_at=time.time()+float(hrs)*3600-10800)
json.dump(d, open(f,"w"))
print(d["slug"], d["item"], d.get("brief",""), flush=True)
PYN
  ); then
    echo "$ROW" >> "$STATE/nas/claim-this-round.txt"
    PACKED=$((PACKED+1))
  fi
done
CLAIMED=0

while read -r SLUG ITEM BRIEF_REL; do
  [ -n "${SLUG:-}" ] || continue
  [ "$CLAIMED" -ge "$IDLE" ] && break
  case "$SLUG" in *[!a-z0-9._-]*|"") log "skip bad slug $SLUG"; continue;; esac
  BRIEF="$BRIEF_REL"
  [ -f "$BRIEF" ] || BRIEF="$RSI_CTRL/$BRIEF_REL"
  [ -f "$BRIEF" ] || BRIEF="$STATE/cloud-briefs/$SLUG.md"
  [ -f "$BRIEF" ] || { log "brief missing for $SLUG"; continue; }

  # Ship job.json + origin/main bundle.
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null || true
  BUNDLE="$STATE/nas/origin-main-$SLUG.bundle"
  $GIT -C "$RSI_CTRL" bundle create "$BUNDLE" origin/main
  JOBDIR="$STATE/nas/xfer/$SLUG"; mkdir -p "$JOBDIR"
  python3 - "$JOBDIR/job.json" "$ITEM" "$BRIEF" "$STATE/cloud/$SLUG.json" <<'PY'
import json,sys,os
out,item,brief,cf=sys.argv[1:5]
paths=json.load(open(cf)).get("paths",[]) if os.path.exists(cf) else []
json.dump(dict(item=item,paths=paths,brief=open(brief).read()), open(out,"w"))
PY
  ssh -o BatchMode=yes "$NAS_HOST" "mkdir -p '$REMOTE/work/jobs/$SLUG' '$REMOTE/work/logs'"
  scp -q "$JOBDIR/job.json" "$BUNDLE" "$NAS_HOST:$REMOTE/work/jobs/$SLUG/"
  ssh -o BatchMode=yes "$NAS_HOST" "mv -f '$REMOTE/work/jobs/$SLUG/origin-main-$SLUG.bundle' '$REMOTE/work/jobs/$SLUG/origin-main.bundle' 2>/dev/null || mv -f '$REMOTE/work/jobs/$SLUG/'*.bundle '$REMOTE/work/jobs/$SLUG/origin-main.bundle'"
  # Starter status so a crash before nas-lane.sh still looks queued, not stale-running.
  ssh -o BatchMode=yes "$NAS_HOST" "printf '%s\\n' '{\"status\":\"queued\",\"slug\":\"$SLUG\"}' > '$REMOTE/work/jobs/$SLUG/status.json'"

  # Start the lane detached inside the container.
  ssh -o BatchMode=yes "$NAS_HOST" "docker exec -d -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker /bin/bash /opt/rsi/nas-lane.sh $SLUG"
  log "started NAS lane for $ITEM $SLUG (taker=nas)"
  echo "$(date '+%F %H:%M:%S') start $ITEM $SLUG load=$LOAD mem=$MEM" >> "$STATE/nas/starts.log"
  CLAIMED=$((CLAIMED+1))
done < "$STATE/nas/claim-this-round.txt"

[ "$CLAIMED" -eq 0 ] && log "no untaken cloud briefs (taker already set or none ready)"
log "pulse-nas done, started $CLAIMED"
exit 0
