#!/bin/bash
# ingest-nas.sh — Mac side. For each finished NAS job: fetch the git bundle, run the full self-check
# (tsc, UI inventory, vitest) under heavy.sh, push rsi/<slug> (normal push, never force), open or reuse
# the PR, record it like a lane, release the cloud claim, kick merge.sh. Failed jobs release the claim
# so the slice can fall back to a local or box lane. Idempotent.
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
NAS_HOST="${NAS_HOST:-nas}"
REMOTE="${NAS_REMOTE:-/home/zhushihao/kin-rsi-nas}"
X="$STATE/nas/xfer"; mkdir -p "$X" "$STATE/nas" "$STATE/lanes/history"
KICK=0

# Pull finished job artifacts (status, bundle, pr-body, job.json, logs snippet).
LIST=$(ssh -o BatchMode=yes "$NAS_HOST" "python3 - <<'PY'
import json,os,glob
root='$REMOTE/work/jobs'
for d in sorted(glob.glob(root+'/*/status.json')):
    try: st=json.load(open(d)).get('status')
    except Exception: continue
    if st in ('done','failed'):
        print(os.path.basename(os.path.dirname(d))+','+st)
PY")

[ -z "${LIST:-}" ] && { echo "no finished NAS jobs"; exit 0; }

selfcheck_mac() { # WT J
  local WT="$1" J="$2"
  bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT"
  bash "$RSI_DIR/runtime/heavy.sh" bash -c "
    { echo '== tsc'; ( cd \"$WT/ui\" && npx tsc --noEmit ) || echo TSC-FAIL
      echo '== inventory'; ( cd \"$WT\" && python3 scripts/check-ui-inventory.py ) || echo INV-FAIL
      echo '== vitest (full)'; ( cd \"$WT/ui\" && npx vitest run --maxWorkers=2 ) || echo VITEST-FAIL
    } > \"$J/selfcheck.txt\" 2>&1
  "
  ! grep -qE '^(TSC|INV|VITEST)-FAIL' "$J/selfcheck.txt"
}

while IFS=, read -r SLUG ST; do
  [ -n "$SLUG" ] || continue
  case "$SLUG" in *[!a-z0-9._-]*|"") echo "skip bad slug $SLUG"; continue;; esac
  J="$X/$SLUG"; mkdir -p "$J"
  scp -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/status.json" "$J/status.json" 2>/dev/null || { echo "no status $SLUG"; continue; }
  scp -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/job.json" "$J/job.json" 2>/dev/null || true
  scp -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/pr-body.md" "$J/pr-body.md" 2>/dev/null || true
  ITEM="$(python3 -c "import json,os;print(json.load(open('$J/job.json')).get('item','') if os.path.exists('$J/job.json') else '')")"
  if [ "$ST" = failed ]; then
    NOTE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('note',''))")"
    f="$STATE/cloud/$SLUG.json"; [ -f "$f" ] && mkdir -p "$STATE/cloud/expired" && mv "$f" "$STATE/cloud/expired/$SLUG.json"
    echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim released; slice falls back)" >> "$STATE/needs-ceo.md"
    echo "$SLUG" >> "$STATE/nas/acks.txt"; echo "failed $SLUG: $NOTE"; continue
  fi
  [ "$ST" = done ] || continue
  scp -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/bundle" "$J/bundle" || { echo "no bundle $SLUG"; continue; }
  BR="rsi/$SLUG"; REF="refs/nas/$SLUG"
  $GIT -C "$RSI_CTRL" fetch -q origin 2>/dev/null
  $GIT -C "$RSI_CTRL" bundle verify "$J/bundle" >/dev/null 2>&1 || { echo "bundle for $SLUG does not verify"; continue; }
  $GIT -C "$RSI_CTRL" fetch -q "$J/bundle" "$BR:$REF" || { echo "bundle fetch failed $SLUG"; continue; }

  # Materialise a worktree and run the Mac self-check under heavy.sh.
  WT="$WT_ROOT/rsi-$SLUG"
  if [ ! -d "$WT/.git" ]; then
    $GIT -C "$RSI_CTRL" worktree prune
    $GIT -C "$RSI_CTRL" worktree add -q -B "$BR" "$WT" "$REF" || $GIT -C "$RSI_CTRL" worktree add -q "$WT" "$REF"
  else
    $GIT -C "$WT" fetch -q "$RSI_CTRL" "$REF:$BR" 2>/dev/null || $GIT -C "$WT" checkout -q -B "$BR" "$REF"
  fi
  SC="green"
  if selfcheck_mac "$WT" "$J"; then
    echo "self-check green $SLUG"
  else
    SC="FAILING (see selfcheck.txt; merge lane will send back if needed)"
    echo "self-check failing $SLUG; handing over anyway"
  fi
  PRB="$J/pr-body.md"
  [ -s "$PRB" ] || printf 'RSI item: %s\n' "$ITEM" > "$PRB"
  grep -q "RSI item:" "$PRB" || printf '\nRSI item: %s\n' "$ITEM" >> "$PRB"
  printf '\nMac self-check after NAS hand-over: %s (tsc, UI inventory ratchet, full vitest).\n' "$SC" >> "$PRB"

  PRN="$($GH pr list --repo "$GH_REPO" --head "$BR" --state open --json number --jq '.[0].number' 2>/dev/null)"
  if [ -z "$PRN" ]; then
    $GIT -C "$RSI_CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
    TITLE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('pr_title') or 'chore(rsi): $ITEM $SLUG')")"
    URL="$($GH pr create --repo "$GH_REPO" --base main --head "$BR" --title "$TITLE" --body-file "$PRB" 2>&1 | tail -1)"
    PRN="$(echo "$URL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"; [ -n "$PRN" ] || { echo "pr create failed $SLUG: $URL"; continue; }
  fi
  python3 - "$STATE/lanes/history/$(date +%Y%m%d-%H%M%S)-$SLUG.json" "$SLUG" "$ITEM" "$PRN" "$STATE/cloud/$SLUG.json" "$SC" <<'PY'
import json,sys,time,os
out,slug,item,pr,cf,sc=sys.argv[1:7]
paths=json.load(open(cf)).get("paths",[]) if os.path.exists(cf) else []
json.dump(dict(lane="nas",slug=slug,item=item,mode="nas",paths=paths,status="done",pr=int(pr),claimed_at=time.time(),finished_at=time.time(),note="nas lane",selfcheck=sc),open(out,"w"))
PY
  python3 "$LANES_PY" cloud-release "$SLUG" >/dev/null 2>&1
  echo "$SLUG" >> "$STATE/nas/acks.txt"
  $GIT -C "$RSI_CTRL" update-ref -d "$REF" 2>/dev/null
  echo "ingested $ITEM $SLUG -> PR #$PRN ($SC)"
  KICK=1
done <<< "$LIST"

sort -u "$STATE/nas/acks.txt" -o "$STATE/nas/acks.txt" 2>/dev/null || true
[ $KICK -eq 1 ] && { nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null; }
true
