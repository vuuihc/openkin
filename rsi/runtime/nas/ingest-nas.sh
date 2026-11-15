#!/bin/bash
# ingest-nas.sh — Mac side. For each finished NAS job: fetch the git bundle, run the full self-check
# (tsc, UI inventory, vitest) under heavy.sh, push rsi/<slug> (normal push, never force), open or reuse
# the PR, record it like a lane, release the cloud claim, kick merge.sh. Failed jobs release the claim
# so the slice can fall back to a local or box lane.
# Idempotent twice over: handled jobs are marked `ingested`/`held` on the NAS and their run identity is
# recorded in state/nas/acks.txt, so a second pulse does no work and writes no second history/notice.
# Every remote call is bounded (M8); the job list is read on fd 3 so ssh cannot drain it (M3).
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
STATE="${NAS_STATE:-$STATE}"; export RSI_STATE="$STATE"
CTRL="${NAS_CTRL:-$RSI_CTRL}"
NAS_HOST="${NAS_HOST:-nas}"
REMOTE="${NAS_REMOTE:-}"
SSH_BIN="${NAS_SSH:-ssh}"
SCP_BIN="${NAS_SCP:-scp}"
GH_BIN="${NAS_GH:-$GH}"
SSH=("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -n)
SSH_T="${NAS_SSH_TIMEOUT:-90}"
XFER_T="${NAS_XFER_TIMEOUT:-900}"
GH_T="${NAS_GH_TIMEOUT:-180}"
WT_ROOT="${NAS_WT_ROOT:-$WT_ROOT}"
X="$STATE/nas/xfer"; mkdir -p "$X" "$STATE/nas" "$STATE/lanes/history" "$STATE/nas/hold"
KICK=0

if [ -z "$REMOTE" ]; then
  REMOTE="$(with_timeout 30 "${SSH[@]}" "$NAS_HOST" 'printf %s "$HOME/kin-rsi-nas"' 2>/dev/null)" || REMOTE=""
  case "$REMOTE" in /*) ;; *) REMOTE="";; esac
fi
[ -n "$REMOTE" ] || { echo "NAS unreachable; nothing to ingest"; exit 0; }

# A handled run is identified by slug + terminal status + its start/update stamp. Bytes once written,
# an ack line is never re-processed; bare legacy slug lines simply do not match.
acked() { grep -qxF "$1" "$STATE/nas/acks.txt" 2>/dev/null; }
ack() { echo "$1" >> "$STATE/nas/acks.txt"; }

# Mark the remote record consumed so the next pulse's list no longer selects it (M4). Guarded by the
# identity we handled, so a newer rerun of the same slug is never clobbered.
mark_remote() { # slug ident newstatus
  with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "python3 - '$REMOTE/work/jobs/$1/status.json' '$2' '$3' <<'PY'
import json,os,sys,time
p,ident,newst=sys.argv[1:4]
try: d=json.load(open(p))
except Exception: sys.exit(0)
cur=str(int(float(d.get('started_at') or d.get('updated_at') or 0)))
if cur!=ident or d.get('status') not in ('done','failed'): sys.exit(0)
d['status']=newst; d['consumed_at']=time.time()
tmp=p+'.tmp'; json.dump(d,open(tmp,'w')); os.replace(tmp,p)
PY"
}

# Pull finished job artifacts (status, bundle, pr-body, job.json, logs snippet). The remote program is
# passed in the ssh command string, not on stdin, so -n is safe here.
LIST=$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "python3 - <<'PY'
import json,os,glob
root='$REMOTE/work/jobs'
for d in sorted(glob.glob(root+'/*/status.json')):
    try: st=json.load(open(d)).get('status')
    except Exception: continue
    if st in ('done','failed'):
        print(os.path.basename(os.path.dirname(d))+','+st)
PY") || LIST=""
[ -z "${LIST:-}" ] && { echo "no finished NAS jobs"; exit 0; }

selfcheck_mac() { # WT J
  local WT="$1" J="$2"
  if [ -n "${NAS_SELFCHECK_CMD:-}" ]; then   # test seam: a cheap command that stands in for heavy.sh
    with_timeout "${NAS_SELFCHECK_TIMEOUT:-600}" bash -c "$NAS_SELFCHECK_CMD" > "$J/selfcheck.txt" 2>&1
    return $?
  fi
  with_timeout 300 bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT" || return 1
  with_timeout "${NAS_SELFCHECK_TIMEOUT:-3600}" bash "$RSI_DIR/runtime/heavy.sh" bash -c "
    { echo '== tsc'; ( cd \"$WT/ui\" && npx tsc --noEmit ) || echo TSC-FAIL
      echo '== inventory'; ( cd \"$WT\" && python3 scripts/check-ui-inventory.py ) || echo INV-FAIL
      echo '== vitest (full)'; ( cd \"$WT/ui\" && npx vitest run --maxWorkers=2 ) || echo VITEST-FAIL
    } > \"$J/selfcheck.txt\" 2>&1
  "
  ! grep -qE '^(TSC|INV|VITEST)-FAIL' "$J/selfcheck.txt"
}

hold_slug() { # SLUG ITEM J WHY  — visible UI with no shots: keep the branch, do not open a PR
  local SLUG="$1" ITEM="$2" J="$3" WHY="$4"
  mkdir -p "$STATE/nas/hold"
  {
    echo "# $ITEM $SLUG held: $WHY"
    echo "Branch rsi/$SLUG is pushed. Capture 390x844 and 1100x760 before/after into"
    echo "$STATE/shots/$SLUG/ then: gh pr create --repo $GH_REPO --base main --head rsi/$SLUG --title '<title>' --body-file $J/pr-body.md"
  } > "$STATE/nas/hold/$SLUG.md"
  echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG held for screenshots (390x844, 1100x760): see rsi/state/nas/hold/$SLUG.md" >> "$STATE/needs-ceo.md"
  echo "held $SLUG: $WHY"
}

while IFS=, read -r SLUG ST <&3; do
  [ -n "$SLUG" ] || continue
  case "$SLUG" in *[!a-z0-9._-]*|"") echo "skip bad slug $SLUG"; continue;; esac
  J="$X/$SLUG"; mkdir -p "$J"
  with_timeout "$SSH_T" "$SCP_BIN" -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/status.json" "$J/status.json" 2>/dev/null || { echo "no status $SLUG"; continue; }
  IDENT="$(python3 -c "import json;d=json.load(open('$J/status.json'));print(int(float(d.get('started_at') or d.get('updated_at') or 0)))" 2>/dev/null || echo 0)"
  ACK_KEY="$SLUG:$ST:$IDENT"
  if acked "$ACK_KEY"; then
    mark_remote "$SLUG" "$IDENT" ingested      # repair a half-finished previous pass
    continue
  fi
  with_timeout "$SSH_T" "$SCP_BIN" -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/job.json" "$J/job.json" 2>/dev/null || true
  with_timeout "$SSH_T" "$SCP_BIN" -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/pr-body.md" "$J/pr-body.md" 2>/dev/null || true
  ITEM="$(python3 -c "import json,os;print(json.load(open('$J/job.json')).get('item','') if os.path.exists('$J/job.json') else '')")"
  if [ "$ST" = failed ]; then
    NOTE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('note',''))")"
    f="$STATE/cloud/$SLUG.json"; [ -f "$f" ] && mkdir -p "$STATE/cloud/expired" && mv "$f" "$STATE/cloud/expired/$SLUG.json"
    echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim released; slice falls back)" >> "$STATE/needs-ceo.md"
    mark_remote "$SLUG" "$IDENT" ingested
    ack "$ACK_KEY"
    echo "failed $SLUG: $NOTE"; continue
  fi
  [ "$ST" = done ] || continue
  with_timeout "$XFER_T" "$SCP_BIN" -q "$NAS_HOST:$REMOTE/work/jobs/$SLUG/bundle" "$J/bundle" || { echo "no bundle $SLUG"; continue; }
  BR="rsi/$SLUG"; REF="refs/nas/$SLUG"
  with_timeout "$XFER_T" "$GIT" -C "$CTRL" fetch -q origin 2>/dev/null || true
  with_timeout 120 "$GIT" -C "$CTRL" bundle verify "$J/bundle" >/dev/null 2>&1 || { echo "bundle for $SLUG does not verify"; continue; }
  with_timeout 120 "$GIT" -C "$CTRL" fetch -q "$J/bundle" "$BR:$REF" || { echo "bundle fetch failed $SLUG"; continue; }
  WANT="$("$GIT" -C "$CTRL" rev-parse "$REF")"

  # Materialise a worktree and prove it is at the bundle's commit before checking or publishing (M7).
  WT="$WT_ROOT/rsi-$SLUG"
  if [ ! -e "$WT/.git" ]; then                       # linked worktrees use a .git *file*, not a directory
    if [ -e "$WT" ] && [ -n "$(ls -A "$WT" 2>/dev/null)" ]; then
      echo "worktree path $WT exists but is not a git worktree; leaving it alone"; continue
    fi
    with_timeout 120 "$GIT" -C "$CTRL" worktree prune
    with_timeout 120 "$GIT" -C "$CTRL" worktree add -q -B "$BR" "$WT" "$REF" || { echo "worktree add failed $SLUG"; continue; }
  fi
  if ! with_timeout 120 "$GIT" -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "existing path $WT is not a usable worktree; leaving it alone"; continue
  fi
  if ! with_timeout 120 "$GIT" -C "$WT" checkout -q -B "$BR" "$REF"; then
    echo "worktree checkout failed $SLUG"; continue
  fi
  GOT="$("$GIT" -C "$WT" rev-parse HEAD)"
  [ "$GOT" = "$WANT" ] || { echo "worktree HEAD $GOT != bundle $WANT for $SLUG"; continue; }

  # Visible UI without screenshots is held, not published (M9): the worker has no browser, and a
  # "Screenshots: none" line must never stand in for the two required widths.
  BASE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('base','') or '')" 2>/dev/null || true)"
  PRB="$J/pr-body.md"
  VISIBLE=""
  if [ -n "$BASE" ]; then
    VISIBLE="$(with_timeout 60 "$GIT" -C "$WT" diff --name-only "$BASE".."$REF" 2>/dev/null | grep -E '^ui/src/.*\.(tsx|css)$' | grep -vE '\.test\.|/__tests__/' || true)"
  fi
  SHOTS="$STATE/shots/$SLUG"
  PRN="$(with_timeout "$GH_T" "$GH_BIN" pr list --repo "$GH_REPO" --head "$BR" --state open --json number --jq '.[0].number' 2>/dev/null)"
  NEEDS_SHOTS=0
  [ -n "$VISIBLE" ] && NEEDS_SHOTS=1
  [ -s "$PRB" ] && grep -qiE '^screenshots?: *pending' "$PRB" && NEEDS_SHOTS=1
  [ -n "$(ls -A "$SHOTS" 2>/dev/null)" ] && NEEDS_SHOTS=0
  [ -n "$PRN" ] && NEEDS_SHOTS=0        # already published once: never unpublish by holding
  if [ "$NEEDS_SHOTS" = 1 ]; then
    with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
    printf '\nScreenshots: pending Mac capture at 390x844 and 1100x760 (NAS worker has no browser). Visible files: %s\n' "$(echo "$VISIBLE" | tr '\n' ' ')" >> "$PRB"
    hold_slug "$SLUG" "$ITEM" "$J" "visible UI changed and no shots in $SHOTS"
    mark_remote "$SLUG" "$IDENT" held
    ack "$ACK_KEY"
    continue
  fi

  SC="green"
  if selfcheck_mac "$WT" "$J"; then
    echo "self-check green $SLUG"
  else
    SC="FAILING (see selfcheck.txt; merge lane will send back if needed)"
    echo "self-check failing $SLUG; handing over anyway"
  fi
  [ -s "$PRB" ] || printf 'RSI item: %s\n' "$ITEM" > "$PRB"
  grep -q "RSI item:" "$PRB" || printf '\nRSI item: %s\n' "$ITEM" >> "$PRB"
  printf '\nMac self-check after NAS hand-over: %s (tsc, UI inventory ratchet, full vitest).\n' "$SC" >> "$PRB"

  if [ -z "$PRN" ]; then
    with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
    TITLE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('pr_title') or 'chore(rsi): $ITEM $SLUG')")"
    URL="$(with_timeout "$GH_T" "$GH_BIN" pr create --repo "$GH_REPO" --base main --head "$BR" --title "$TITLE" --body-file "$PRB" 2>&1 | tail -1)"
    PRN="$(echo "$URL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"; [ -n "$PRN" ] || { echo "pr create failed $SLUG: $URL"; continue; }
  fi
  python3 - "$STATE/lanes/history/$(date +%Y%m%d-%H%M%S)-$SLUG.json" "$SLUG" "$ITEM" "$PRN" "$STATE/cloud/$SLUG.json" "$SC" <<'PY'
import json,sys,time,os
out,slug,item,pr,cf,sc=sys.argv[1:7]
paths=json.load(open(cf)).get("paths",[]) if os.path.exists(cf) else []
json.dump(dict(lane="nas",slug=slug,item=item,mode="nas",paths=paths,status="done",pr=int(pr),claimed_at=time.time(),finished_at=time.time(),note="nas lane",selfcheck=sc),open(out,"w"))
PY
  python3 "$LANES_PY" cloud-release "$SLUG" >/dev/null 2>&1
  mark_remote "$SLUG" "$IDENT" ingested
  ack "$ACK_KEY"
  with_timeout 60 "$GIT" -C "$CTRL" update-ref -d "$REF" 2>/dev/null
  echo "ingested $ITEM $SLUG -> PR #$PRN ($SC)"
  KICK=1
done 3<<< "$LIST"

sort -u "$STATE/nas/acks.txt" -o "$STATE/nas/acks.txt" 2>/dev/null || true
[ $KICK -eq 1 ] && [ -z "${NAS_NO_MERGE:-}" ] && { nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null; }
true
