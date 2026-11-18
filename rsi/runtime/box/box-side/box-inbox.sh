#!/bin/bash
# box-inbox.sh [in.tgz]  — unpack jobs sent by the Mac (jobs/<slug>/job.json) as queued; apply acks.txt (slugs the Mac already ingested).
BL=/workspace/box-lane; cd $BL; F="${1:-xfer/in.tgz}"; T="$(mktemp -d)"
tar xzf "$F" -C "$T" || { echo "bad tarball"; exit 1; }
for d in "$T"/jobs/*/; do [ -f "$d/job.json" ] || continue; s="$(basename "$d")"
  case "$s" in *[!a-z0-9._-]*|"") echo "skip bad slug $s"; continue;; esac
  if [ -e jobs/$s/status.json ]; then echo "exists $s"; continue; fi
  mkdir -p jobs/$s && cp "$d/job.json" jobs/$s/job.json
  python3 -c "import json,time;json.dump(dict(status='queued',queued_at=time.time(),updated_at=time.time()),open('jobs/$s/status.json','w'))"; echo "queued $s"
done
[ -f "$T/acks.txt" ] && while read -r s; do [ -f jobs/$s/status.json ] && python3 - jobs/$s/status.json <<'PY'
import json,sys,time; p=sys.argv[1]; d=json.load(open(p)); d.update(status="acked",updated_at=time.time()); json.dump(d,open(p,"w"))
PY
done < "$T/acks.txt"
rm -rf "$T"; true
