#!/bin/bash
# box-pack.sh — Mac side, step 1 of a box sync. Packs every cloud claim nobody has taken yet (state/cloud/*.json without "taker")
# into state/box/xfer/in.tgz (job.json = {item, paths, brief text}) plus acks.txt (slugs already ingested), and marks those claims taker=box
# so no other cloud launcher double-takes them. The claim is heart-beaten (claimed_at pushed into the future) so the 3 h TTL does not fall
# back to a local lane while the box works. Never contains secrets: briefs are public-repo-only by contract.
# Sync cycle (run by an agent that has Mac + box tools; the box has no inbound route and no GitHub write access):
#   Mac: box-pack.sh -> CopyToBox xfer/in.tgz to /workspace/box-lane/xfer/in.tgz -> box: box-inbox.sh ; box: box-outbox.sh
#   -> CopyFromBox /workspace/box-lane/xfer/out.tgz to Mac xfer/out.tgz -> Mac: ingest-box.sh
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
X="$STATE/box/xfer"; mkdir -p "$X" "$STATE/box"; T="$(mktemp -d)"; mkdir -p "$T/jobs"; N=0
HOLD_FUTURE="${RSI_BOX_CLAIM_HOURS:-5}"
for f in "$STATE"/cloud/*.json; do [ -e "$f" ] || continue
  python3 - "$f" "$T" "$RSI_CTRL" "$HOLD_FUTURE" <<'PY' && N=$((N+1))
import json,sys,os,time
f,T,ctrl,hrs=sys.argv[1:5]; d=json.load(open(f))
if d.get("taker"): sys.exit(1)
b=d["brief"]; b=b if os.path.isabs(b) else os.path.join(ctrl,b)
brief=open(b).read()
os.makedirs(f"{T}/jobs/{d['slug']}",exist_ok=True)
json.dump(dict(item=d["item"],paths=d["paths"],brief=brief),open(f"{T}/jobs/{d['slug']}/job.json","w"))
d.update(taker="box",status="launched",launched_at=time.time(),claimed_at=time.time()+float(hrs)*3600-10800)
json.dump(d,open(f,"w"))
print("packed",d["item"],d["slug"])
PY
done
[ -s "$STATE/box/acks.txt" ] && cp "$STATE/box/acks.txt" "$T/acks.txt"
if [ "$N" -eq 0 ] && [ ! -s "$T/acks.txt" ]; then echo "nothing to send"; rm -f "$X/in.tgz"; rm -rf "$T"; exit 0; fi
COPYFILE_DISABLE=1 tar czf "$X/in.tgz" -C "$T" . && echo "wrote $X/in.tgz ($N new job(s))"; rm -rf "$T"
