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
# Honour the Volcengine ¥560 worker stop: do not claim new box jobs; still pack acks.txt so ingest can continue.
ALLOW_NEW=1
if type rsi_allow_workers >/dev/null 2>&1 && ! rsi_allow_workers; then
  echo "volc budget: not packing new box jobs until next Asia/Singapore day (acks still sent)"
  ALLOW_NEW=0
fi
if [ "$ALLOW_NEW" -eq 1 ] && type rsi_open_pr_backpressure >/dev/null 2>&1 && rsi_open_pr_backpressure; then
  echo "open PR backpressure (${RSI_OPEN_RSI_PRS} >= ${RSI_MAX_OPEN_PRS}): not packing new box jobs (acks still sent)"
  ALLOW_NEW=0
fi
if [ "$ALLOW_NEW" -eq 1 ]; then
# Capacity: the box runs BOX_MAX_LANES (3) jobs; only pack what its free slots can take so the rest stays untaken for the NAS (2 lanes).
BOX_MAX="${RSI_BOX_MAX:-3}"
ONBOX=$(python3 - "$STATE/cloud" <<'PY'
import json,glob,sys
print(sum(1 for f in glob.glob(sys.argv[1]+"/*.json") if (json.load(open(f)).get("taker") or "")=="box"))
PY
)
for f in "$STATE"/cloud/*.json; do [ -e "$f" ] || continue
  [ $((ONBOX + N)) -ge "$BOX_MAX" ] && break
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
fi
[ -s "$STATE/box/acks.txt" ] && cp "$STATE/box/acks.txt" "$T/acks.txt"
if [ "$N" -eq 0 ] && [ ! -s "$T/acks.txt" ]; then echo "nothing to send"; rm -f "$X/in.tgz"; rm -rf "$T"; exit 0; fi
COPYFILE_DISABLE=1 tar czf "$X/in.tgz" -C "$T" . && echo "wrote $X/in.tgz ($N new job(s))"; rm -rf "$T"
