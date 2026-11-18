#!/bin/bash
# box-lane supervisor: keeps the gateway (litellm) alive and runs queued jobs (<= MAX_LANES at once).
# Start: nohup setsid ./supervisor.sh >> logs/supervisor.log 2>&1 &     Stop: touch STOP (or kill the process group).
BL=/workspace/box-lane; cd $BL; export TZ=Asia/Singapore
MAX_LANES="${BOX_MAX_LANES:-3}"; MIN_AVAIL_MB="${BOX_MIN_AVAIL_MB:-2500}"
echo $$ > supervisor.pid
log() { echo "[$(date '+%F %T')] $*"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
PROXY_PID=""
ensure_services() {
  if ! curl -s -m 5 -o /dev/null http://127.0.0.1:3425/health/liveliness; then
    alive "$PROXY_PID" && kill "$PROXY_PID" 2>/dev/null; pkill -f 'litellm --config' 2>/dev/null; sleep 1
    nohup ./start-proxy.sh >> logs/proxy.log 2>&1 & PROXY_PID=$!; log "gateway (re)started pid $PROXY_PID"; sleep 20
  fi
}
jf() { python3 -c "import json,sys;d=json.load(open('$BL/jobs/$1/status.json'));print(d.get('$2',''))" 2>/dev/null; }
mem_ok() { [ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -ge "$MIN_AVAIL_MB" ]; }
while [ ! -e STOP ]; do
  ensure_services
  running=0
  for d in jobs/*/; do s="$(basename "$d")"; [ -f "$d/status.json" ] || continue
    stt="$(jf "$s" status)"
    if [ "$stt" = running ]; then
      if alive "$(cat "$d/pid" 2>/dev/null)"; then running=$((running+1)); else
        python3 - "$d/status.json" <<'PY'
import json,sys,time; p=sys.argv[1]; d=json.load(open(p)); d.update(status="failed",note="lane process vanished (box restart?)",updated_at=time.time()); json.dump(d,open(p,"w"))
PY
        log "job $s: lane process vanished -> failed"; fi
    fi
    if [ "$stt" = acked ] && [ -d "/workspace/wt/rsi-$s" ]; then git -C /workspace/openkin-box worktree remove --force "/workspace/wt/rsi-$s" 2>/dev/null; log "cleaned worktree $s"; fi
  done
  for d in jobs/*/; do s="$(basename "$d")"; [ -f "$d/status.json" ] || continue
    [ "$running" -ge "$MAX_LANES" ] && break
    [ "$(jf "$s" status)" = queued ] || continue
    mem_ok || { log "low memory, not starting $s"; break; }
    nohup ./box-lane.sh "$s" >/dev/null 2>&1 & echo $! > "$d/pid"; running=$((running+1)); log "started job $s pid $!"; sleep 5
  done
  sleep 15
done
log "STOP seen, exiting (children keep running)"
