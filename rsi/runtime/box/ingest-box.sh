#!/bin/bash
# ingest-box.sh [out.tgz] — Mac side, last step of a box sync. For each finished box job: push rsi/<slug> from its git bundle (normal push, never force),
# open the PR (or reuse the open one) with the box-written body, record it like a local lane (state/lanes/history, so the slice shows in flight/in review),
# release the cloud claim, queue the slug in acks.txt for the next pack, then kick the merge lane. A failed box job releases the claim as expired
# so the slice falls back to a local lane. Idempotent.
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
X="$STATE/box/xfer"; F="${1:-$X/out.tgz}"; [ -f "$F" ] || { echo "no $F"; exit 0; }
T="$(mktemp -d)"; tar xzf "$F" -C "$T" || { echo "bad tarball"; exit 1; }; KICK=0
for d in "$T"/jobs/*/; do [ -f "$d/status.json" ] || continue; SLUG="$(basename "$d")"
  case "$SLUG" in *[!a-z0-9._-]*|"") echo "skip bad slug"; continue;; esac
  ST="$(python3 -c "import json;print(json.load(open('$d/status.json')).get('status'))")"
  ITEM="$(python3 -c "import json;print(json.load(open('$d/job.json'))['item'])")"
  if [ "$ST" = failed ]; then
    NOTE="$(python3 -c "import json;print(json.load(open('$d/status.json')).get('note',''))")"
    f="$STATE/cloud/$SLUG.json"; [ -f "$f" ] && mkdir -p "$STATE/cloud/expired" && mv "$f" "$STATE/cloud/expired/$SLUG.json"
    echo "- $(date '+%F %H:%M') box job $ITEM $SLUG failed: $NOTE (claim released; slice falls back to a local lane)" >> "$STATE/needs-ceo.md"
    echo "$SLUG" >> "$STATE/box/acks.txt"; echo "failed $SLUG: $NOTE"; continue
  fi
  [ "$ST" = done ] || continue
  BR="rsi/$SLUG"; REF="refs/box/$SLUG"
  $GIT -C "$RSI_CTRL" fetch -q origin 2>/dev/null
  $GIT -C "$RSI_CTRL" bundle verify "$d/bundle" >/dev/null 2>&1 || { echo "bundle for $SLUG does not verify (base missing?)"; continue; }
  $GIT -C "$RSI_CTRL" fetch -q "$d/bundle" "$BR:$REF" || { echo "bundle fetch failed $SLUG"; continue; }
  PRN="$($GH pr list --repo "$GH_REPO" --head "$BR" --state open --json number --jq '.[0].number' 2>/dev/null)"
  if [ -z "$PRN" ]; then
    $GIT -C "$RSI_CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/box/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/box/push.err")"; continue; }
    TITLE="$(python3 -c "import json;print(json.load(open('$d/status.json')).get('pr_title') or 'chore(rsi): $ITEM $SLUG')")"
    URL="$($GH pr create --repo "$GH_REPO" --base main --head "$BR" --title "$TITLE" --body-file "$d/pr-body.md" 2>&1 | tail -1)"
    PRN="$(echo "$URL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"; [ -n "$PRN" ] || { echo "pr create failed $SLUG: $URL"; continue; }
  fi
  mkdir -p "$STATE/lanes/history"
  python3 - "$STATE/lanes/history/$(date +%Y%m%d-%H%M%S)-$SLUG.json" "$SLUG" "$ITEM" "$PRN" "$STATE/cloud/$SLUG.json" <<'PY'
import json,sys,time,os
out,slug,item,pr,cf=sys.argv[1:6]
paths=json.load(open(cf)).get("paths",[]) if os.path.exists(cf) else []
json.dump(dict(lane="box",slug=slug,item=item,mode="box",paths=paths,status="done",pr=int(pr),claimed_at=time.time(),finished_at=time.time(),note="box lane"),open(out,"w"))
PY
  python3 "$LANES_PY" cloud-release "$SLUG" >/dev/null 2>&1
  echo "$SLUG" >> "$STATE/box/acks.txt"; $GIT -C "$RSI_CTRL" update-ref -d "$REF" 2>/dev/null
  echo "ingested $ITEM $SLUG -> PR #$PRN"; KICK=1
done
rm -rf "$T"; sort -u "$STATE/box/acks.txt" -o "$STATE/box/acks.txt" 2>/dev/null
[ $KICK -eq 1 ] && { nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null; }
true
