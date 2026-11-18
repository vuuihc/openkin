#!/bin/bash
# box-outbox.sh [out.tgz]  — pack finished jobs (done/failed, not yet acked) for the Mac: status.json, bundle, pr-body.md, selfcheck.txt, job.json
BL=/workspace/box-lane; cd $BL; O="${1:-xfer/out.tgz}"; L=""
for d in jobs/*/; do s="$(basename "$d")"; st="$(python3 -c "import json;print(json.load(open('$d/status.json')).get('status'))" 2>/dev/null)"
  case "$st" in done|failed) L="$L $d";; esac
done
[ -z "$L" ] && { echo "nothing finished"; rm -f "$O"; exit 0; }
FILES=""; for d in $L; do for f in status.json job.json bundle pr-body.md selfcheck.txt; do [ -f "$d$f" ] && FILES="$FILES $d$f"; done; done
tar czf "$O" $FILES && echo "packed: $(echo $L | tr -d '/' | sed 's/jobs//g') -> $O ($(du -h "$O" | cut -f1))"
