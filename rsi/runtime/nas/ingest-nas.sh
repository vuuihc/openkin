#!/bin/bash
# ingest-nas.sh — Mac side. For each finished NAS job: fetch the git bundle, run the full self-check
# (tsc, UI inventory, vitest) under heavy.sh, push rsi/<slug> (normal push, never force), open or update
# the PR, record it like a lane, release the cloud claim, kick merge.sh. Failed jobs release the claim
# so the slice can fall back to a local or box lane.
# Ownership is never assumed: a claim is released only by the run whose launched_at stamp it carries
# (under the scheduler flock), an existing worktree is only fast-forwarded when clean, on-branch and an
# ancestor of the bundle, and the published branch/PR head must already contain the NAS commit.
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
PREP="${NAS_PREP:-$RSI_DIR/runtime/prep-worktree.sh}"
HEAVY="${NAS_HEAVY:-$RSI_DIR/runtime/heavy.sh}"
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

# Is state/cloud/<slug>.json still this NAS run's claim? Read under the scheduler's shared flock, and
# compare the run identity the pulse stamped into job.json (launched_at). A missing claim file means there
# is nothing to own (already released), which is not a conflict.
claim_owned() { # SLUG [JOB_LAUNCHED_AT]
  python3 - "$STATE/lanes" "$STATE/cloud/$1.json" "$1" "${2:-}" <<'PYO' >/dev/null 2>&1
import fcntl,json,os,sys
ldir,f,slug,want=sys.argv[1:5]
if not os.path.exists(f): sys.exit(0)
lock=open(os.path.join(ldir,'.flock'),'w')
fcntl.flock(lock,fcntl.LOCK_SH)
try:
    d=json.load(open(f))
    if (d.get('taker') or '')!='nas' or d.get('slug')!=slug: sys.exit(1)
    if want:
        cur=d.get('launched_at')
        if cur is not None and str(float(cur))!=str(float(want)): sys.exit(1)
finally:
    fcntl.flock(lock,fcntl.LOCK_UN); lock.close()
PYO
}

# Release this run's claim under the same flock the scheduler writes claims with (M3). Never touch a
# claim another executor took over; exit 3 so the caller can say so instead of claiming a release.
release_claim() { # SLUG done|failed [JOB_LAUNCHED_AT]
  python3 - "$STATE/lanes" "$STATE/cloud/$1.json" "$1" "$2" "${3:-}" <<'PYR'
import fcntl,json,os,sys
ldir,f,slug,why,want=sys.argv[1:6]
if not os.path.exists(f): sys.exit(0)
lock=open(os.path.join(ldir,'.flock'),'w'); fcntl.flock(lock,fcntl.LOCK_EX)
try:
    d=json.load(open(f))
    if (d.get('taker') or '')!='nas' or d.get('slug')!=slug:
        print('claim for %s is not ours (taker=%r); left alone' % (slug,(d.get('taker') or '')), file=sys.stderr); sys.exit(3)
    if want:
        cur=d.get('launched_at')
        if cur is not None and str(float(cur))!=str(float(want)):
            print('claim for %s belongs to another NAS run; left alone' % slug, file=sys.stderr); sys.exit(3)
    dest=os.path.join(os.path.dirname(f),'expired'); os.makedirs(dest,exist_ok=True)
    os.replace(f,os.path.join(dest,('done-' if why=='done' else '')+slug+'.json'))
finally:
    fcntl.flock(lock,fcntl.LOCK_UN); lock.close()
PYR
}

# Two real captures at the two required widths (M6). A directory with a text file, or one capture, is not
# evidence: the file must be a PNG/JPEG of some size and its name must carry the width.
shots_ok() { # DIR
  python3 - "$1" <<'PYS' >/dev/null 2>&1
import os,re,sys
d=sys.argv[1]
want={390:False,1100:False}
try: names=sorted(os.listdir(d))
except OSError: sys.exit(1)
for n in names:
    p=os.path.join(d,n)
    try:
        if not os.path.isfile(p) or os.path.getsize(p)<1024: continue
        head=open(p,'rb').read(8)
    except OSError: continue
    if not (head.startswith(b'\x89PNG\r\n\x1a\n') or head.startswith(b'\xff\xd8\xff')): continue
    for w in want:
        if re.search(r'(^|[^0-9])%d([^0-9]|$)'%w, n): want[w]=True
sys.exit(0 if all(want.values()) else 1)
PYS
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
  local WT="$1" J="$2" LOG="$2/selfcheck.txt" RC=0
  if [ -n "${NAS_SELFCHECK_CMD:-}" ]; then   # test seam: a cheap command that stands in for heavy.sh
    with_timeout "${NAS_SELFCHECK_TIMEOUT:-600}" bash -c "$NAS_SELFCHECK_CMD" > "$LOG" 2>&1
    return $?
  fi
  with_timeout 300 bash "$PREP" "$WT" || return 1
  # The check bodies are overridable for tests; the status and completion rules below are not.
  local TSC_C="${NAS_SELFCHECK_TSC:-( cd \"$WT/ui\" && npx tsc --noEmit )}"
  local INV_C="${NAS_SELFCHECK_INV:-( cd \"$WT\" && python3 scripts/check-ui-inventory.py )}"
  local VIT_C="${NAS_SELFCHECK_VITEST:-( cd \"$WT/ui\" && npx vitest run --maxWorkers=2 )}"
  with_timeout "${NAS_SELFCHECK_TIMEOUT:-3600}" bash "$HEAVY" bash -c "
    { echo '== tsc'; $TSC_C || echo TSC-FAIL
      echo '== inventory'; $INV_C || echo INV-FAIL
      echo '== vitest (full)'; $VIT_C || echo VITEST-FAIL
      echo '== selfcheck complete'
    } > \"$LOG\" 2>&1
  "
  RC=$?
  # Green needs all three: the heavy command exited cleanly, every check ran to the end marker, and no
  # check reported a failure (M5). An interrupted or crashed run must never read as green.
  if [ "$RC" -ne 0 ]; then
    echo "self-check did not finish (heavy exit $RC)" >> "$LOG"; return 1
  fi
  grep -qx '== selfcheck complete' "$LOG" || { echo "self-check has no completion marker" >> "$LOG"; return 1; }
  local h
  for h in '== tsc' '== inventory' '== vitest (full)'; do
    grep -qxF "$h" "$LOG" || { echo "self-check never ran $h" >> "$LOG"; return 1; }
  done
  ! grep -qE '^(TSC|INV|VITEST)-FAIL' "$LOG"
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

# The branch moved on (a merge or rework lane committed after the NAS job finished). Publishing would need
# a force push; consuming would lose the NAS commit. Keep both and say so, once (M7).
hold_diverged() { # SLUG ITEM REMOTE_SHA PRN
  local SLUG="$1" ITEM="$2" RSHA="${3:-none}" PRN="${4:-none}" NASHA
  NASHA="$("$GIT" -C "$CTRL" rev-parse "$REF" 2>/dev/null || echo unknown)"
  mkdir -p "$STATE/nas/hold"
  {
    echo "# $ITEM $SLUG held: rsi/$SLUG diverged from the NAS result"
    echo "PR: $PRN. NAS result: $NASHA. Remote branch: $RSHA."
    echo "The remote branch has commits the NAS result does not contain (merge or rework lane), so a normal"
    echo "push cannot publish it. Re-run the slice against the current branch instead of forcing:"
    echo "  git -C $CTRL log --oneline $RSHA..$NASHA"
  } > "$STATE/nas/hold/$SLUG.md"
  echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG held: rsi/$SLUG diverged from the NAS result (remote $RSHA); see rsi/state/nas/hold/$SLUG.md" >> "$STATE/needs-ceo.md"
  echo "held $SLUG: branch diverged (remote $RSHA)"
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
  JOB_LAUNCH="$(python3 -c "import json,os;d=json.load(open('$J/job.json'));print(d.get('launched_at') or '') if os.path.exists('$J/job.json') else ''" 2>/dev/null || true)"
  if [ "$ST" = failed ]; then
    NOTE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('note',''))")"
    if release_claim "$SLUG" failed "$JOB_LAUNCH"; then
      echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim released; slice falls back)" >> "$STATE/needs-ceo.md"
    else
      echo "- $(date '+%F %H:%M') nas job $ITEM $SLUG failed: $NOTE (claim kept by its current owner; not released)" >> "$STATE/needs-ceo.md"
    fi
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

  # Another executor may hold this slug now (a failed start unclaimed it and box claimed it). Never consume
  # or publish a result whose claim is no longer this NAS run's (M3).
  if ! claim_owned "$SLUG" "$JOB_LAUNCH"; then
    echo "claim for $SLUG is no longer this NAS run's; leaving the finished result alone"
    continue
  fi

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
  # An existing worktree may hold a later merge/rework commit or uncommitted edits. Only a clean, on-branch
  # worktree whose HEAD the bundle already contains may be fast-forwarded; never reset anything else (M4).
  CUR_BR="$(with_timeout 60 "$GIT" -C "$WT" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  if [ "$CUR_BR" != "$BR" ]; then
    echo "worktree $WT is on '${CUR_BR:-detached}', not $BR; leaving it alone"; continue
  fi
  if [ -n "$(with_timeout 60 "$GIT" -C "$WT" status --porcelain 2>/dev/null || true)" ]; then
    echo "worktree $WT has uncommitted changes; leaving it alone"; continue
  fi
  if ! with_timeout 60 "$GIT" -C "$WT" merge-base --is-ancestor HEAD "$REF"; then
    echo "worktree $WT has commits the NAS bundle does not contain; leaving it alone"; continue
  fi
  if ! with_timeout 120 "$GIT" -C "$WT" checkout -q -B "$BR" "$REF"; then
    echo "worktree checkout failed $SLUG"; continue
  fi
  GOT="$("$GIT" -C "$WT" rev-parse HEAD)"
  [ "$GOT" = "$WANT" ] || { echo "worktree HEAD $GOT != bundle $WANT for $SLUG"; continue; }

  # Visible UI without the two required captures is held, not published (M6). The base is trusted Git
  # state (origin/main, just fetched), never the worker's optional status.base, and a shots directory only
  # counts when it holds two real images at the required widths.
  PRB="$J/pr-body.md"
  DIFF=""; DIFF_FAILED=0
  if ! DIFF="$(with_timeout 60 "$GIT" -C "$CTRL" diff --name-only "origin/main...$REF" 2>/dev/null)"; then
    DIFF_FAILED=1
  fi
  VISIBLE="$(printf '%s\n' "$DIFF" | grep -E '^ui/src/.*\.(tsx|css)$' | grep -vE '\.test\.|/__tests__/' || true)"
  SHOTS="$STATE/shots/$SLUG"
  PRINFO="$(with_timeout "$GH_T" "$GH_BIN" pr list --repo "$GH_REPO" --head "$BR" --state open --json number,headRefOid --jq '.[0] | "\(.number)\t\(.headRefOid)"' 2>/dev/null)"
  PRN="${PRINFO%%$'\t'*}"; PRHEAD=""
  case "$PRINFO" in *$'\t'*) PRHEAD="${PRINFO#*$'\t'}";; esac
  case "$PRN" in ''|*[!0-9]*) PRN="";; esac
  NEEDS_SHOTS=0; HOLD_WHY=""
  [ "$DIFF_FAILED" = 1 ] && { NEEDS_SHOTS=1; HOLD_WHY="cannot diff the branch against origin/main"; }
  [ -n "$VISIBLE" ] && { NEEDS_SHOTS=1; HOLD_WHY="visible UI changed and no two-width shots in $SHOTS"; }
  [ -s "$PRB" ] && grep -qiE '^screenshots?: *pending' "$PRB" && { NEEDS_SHOTS=1; HOLD_WHY="${HOLD_WHY:-worker reported screenshots pending}"; }
  [ "$NEEDS_SHOTS" = 1 ] && shots_ok "$SHOTS" && NEEDS_SHOTS=0
  [ -n "$PRN" ] && NEEDS_SHOTS=0        # already published once: never unpublish by holding
  if [ "$NEEDS_SHOTS" = 1 ]; then
    with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
    printf '\nScreenshots: pending Mac capture at 390x844 and 1100x760 (NAS worker has no browser). Visible files: %s\n' "$(echo "$VISIBLE" | tr '\n' ' ')" >> "$PRB"
    hold_slug "$SLUG" "$ITEM" "$J" "$HOLD_WHY"
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

  # The PR head must contain this job's commit before the result is consumed, whether the PR already exists
  # or not (M7). Non-fast-forward means a merge/rework lane added commits: hold both sides, discard neither.
  if ! LSOUT="$(with_timeout "$SSH_T" "$GIT" -C "$CTRL" ls-remote origin "refs/heads/$BR" 2>/dev/null)"; then
    echo "cannot read origin/$BR; not publishing $SLUG"; continue
  fi
  REMOTE_SHA="$(printf '%s\n' "$LSOUT" | awk 'NR==1{print $1}')"
  DIVERGED=""
  for H in "$REMOTE_SHA" "$PRHEAD"; do
    [ -n "$H" ] || continue
    with_timeout 60 "$GIT" -C "$CTRL" merge-base --is-ancestor "$H" "$WANT" || DIVERGED="$H"
  done
  if [ -n "$DIVERGED" ]; then
    hold_diverged "$SLUG" "$ITEM" "$REMOTE_SHA" "$PRN"
    mark_remote "$SLUG" "$IDENT" held
    ack "$ACK_KEY"
    continue
  fi
  with_timeout "$XFER_T" "$GIT" -C "$CTRL" push -q origin "$REF:refs/heads/$BR" 2>"$STATE/nas/push.err" || { echo "push failed $SLUG: $(tail -c 200 "$STATE/nas/push.err")"; continue; }
  if [ -z "$PRN" ]; then
    TITLE="$(python3 -c "import json;print(json.load(open('$J/status.json')).get('pr_title') or 'chore(rsi): $ITEM $SLUG')")"
    URL="$(with_timeout "$GH_T" "$GH_BIN" pr create --repo "$GH_REPO" --base main --head "$BR" --title "$TITLE" --body-file "$PRB" 2>&1 | tail -1)"
    PRN="$(echo "$URL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"; [ -n "$PRN" ] || { echo "pr create failed $SLUG: $URL"; continue; }
  else
    with_timeout "$GH_T" "$GH_BIN" pr edit "$PRN" --repo "$GH_REPO" --body-file "$PRB" >/dev/null 2>&1 \
      || echo "branch pushed; could not update the PR #$PRN body for $SLUG"
  fi
  python3 - "$STATE/lanes/history/$(date +%Y%m%d-%H%M%S)-$SLUG.json" "$SLUG" "$ITEM" "$PRN" "$STATE/cloud/$SLUG.json" "$SC" <<'PY'
import json,sys,time,os
out,slug,item,pr,cf,sc=sys.argv[1:7]
paths=json.load(open(cf)).get("paths",[]) if os.path.exists(cf) else []
json.dump(dict(lane="nas",slug=slug,item=item,mode="nas",paths=paths,status="done",pr=int(pr),claimed_at=time.time(),finished_at=time.time(),note="nas lane",selfcheck=sc),open(out,"w"))
PY
  release_claim "$SLUG" done "$JOB_LAUNCH" \
    || echo "claim for $SLUG was not released (another executor owns it now)"
  mark_remote "$SLUG" "$IDENT" ingested
  ack "$ACK_KEY"
  with_timeout 60 "$GIT" -C "$CTRL" update-ref -d "$REF" 2>/dev/null
  echo "ingested $ITEM $SLUG -> PR #$PRN ($SC)"
  KICK=1
done 3<<< "$LIST"

sort -u "$STATE/nas/acks.txt" -o "$STATE/nas/acks.txt" 2>/dev/null || true
[ $KICK -eq 1 ] && [ -z "${NAS_NO_MERGE:-}" ] && { nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null; }
true
