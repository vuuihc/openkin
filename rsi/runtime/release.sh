#!/bin/bash
# release.sh — roll the merged work on origin/main to the live node and the Hub.
#
# The CEO loop runs this when release-check.sh says GO: at least RSI_RELEASE_MIN user-visible
# merged PRs are unshipped and nobody is mid-conversation (MANDATE "Release gate"). Two targets,
# in this order because the node is what Ethan is looking at:
#
#   node — fast-forward the checkout to origin/main, then ./scripts/desktop-rebuild.sh
#          (console embed + kin binary + ~/.kin/node refresh + Electron relaunch).
#   hub  — build the Hub image off-NAS for linux/amd64 from the same commit, keep the
#          running image as openkin:dogfood-prev, load the new one on the NAS and
#          `docker compose -f docker-compose.dogfood.yml up -d`; wait for healthy.
#
# Each target records its own SHA in state/last_release, so a release that shipped the
# node but failed on the Hub is retried by the next one instead of counted as shipped.
# A marker write is read back and compared before the run calls that target shipped, and
# when both targets run in one invocation the second refuses a stale first value.
# One release runs at a time: state/.release.lock holds the pid of the live invocation, so
# two patrol rounds that both passed the gate cannot restart the node twice.
# Nothing here force-pushes, tags, publishes a dmg, or touches relay/Hub config.
#
# Waiting for the machine slot: the gate holds on `heavy:` whenever a verification build or
# UX walk owns the machine-wide slot, and the rebuild's own npm/go build takes no slot — so
# starting next to one is the memory condition behind the 2026-11-18/19 false reds. That
# hold is right, but the patrol only looks once per round, so a release used to be skipped
# for a walk that ended two minutes later (2026-11-22: 6 unshipped held from 20:15 to
# 21:2x). `heavy:` is therefore the one HOLD this script waits out: it re-runs the full
# gate every RSI_RELEASE_STEP (default 20s) for up to RSI_RELEASE_WAIT (default 600s) and
# ships at the first GO. Every other HOLD — a session in flight, a merge landing, too few
# unshipped — still aborts immediately, and a wait that runs out aborts with the last gate
# output. Each wait is one GATE_WAIT line in state/releases.log, so the cost is measurable.
#
# usage: release.sh [--repo DIR] [--node-only|--hub-only] [--dry-run]
#   --repo DIR   the checkout to release (default /Users/vuuihc/Workspace/study/kin-multidevice)
#   --dry-run    print the plan and the release-check verdict, change nothing
#
# Env: RSI_RELEASE_STATE, RSI_RELEASE_MIN (user-visible threshold passed to release-check.sh, default 1);
#      RSI_HUB_SSH (ssh host alias, default nas), RSI_HUB_DIR (default /volume1/docker/openkin),
#      RSI_HUB_COMPOSE (default docker-compose.dogfood.yml), RSI_HUB_IMAGE (default openkin:dogfood),
#      RSI_HUB_TIMEOUT (build+roll seconds, default 3600).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CTRL="$(cd "$HERE/../.." && pwd)"
STATE="${RSI_RELEASE_STATE:-$CTRL/rsi/state}"
REPO="${RSI_RELEASE_REPO:-/Users/vuuihc/Workspace/study/kin-multidevice}"
HUB_SSH="${RSI_HUB_SSH:-nas}"
HUB_DIR="${RSI_HUB_DIR:-/volume1/docker/openkin}"
HUB_COMPOSE="${RSI_HUB_COMPOSE:-docker-compose.dogfood.yml}"
IMAGE="${RSI_HUB_IMAGE:-openkin:dogfood}"
KIN_API="${KIN_API:-http://127.0.0.1:7777}"
TIMEOUT="${RSI_HUB_TIMEOUT:-3600}"
CHK_CMD="${RSI_RELEASE_CHECK:-$HERE/release-check.sh}"
WAIT="${RSI_RELEASE_WAIT:-600}"
STEP="${RSI_RELEASE_STEP:-20}"
case "$WAIT" in ''|*[!0-9]*) WAIT=600 ;; esac
case "$STEP" in ''|*[!0-9]*|0) STEP=20 ;; esac
NODE=1; HUB=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || die "--repo needs a directory"; REPO="$2"; shift 2 ;;
    --node-only) HUB=0; shift ;;
    --hub-only) NODE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "release: unknown argument: $1" >&2; exit 2 ;;
  esac
done
say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
log() { mkdir -p "$STATE"; say "$*" >> "$STATE/releases.log"; }
die() { say "release: $*" >&2; log "ABORT $*"; exit 1; }

with_timeout() { # secs cmd...   (macOS has no `timeout`; same helper as runtime/common.sh)
  local s="$1"; shift
  "$@" & local p=$!
  ( sp=""
    trap '[ -n "${sp:-}" ] && kill "$sp" 2>/dev/null; exit 0' TERM INT
    sleep "$s" & sp=$!; wait "$sp" || exit 0
    kill -TERM "$p" 2>/dev/null
    sleep 5 & sp=$!; wait "$sp" || exit 0
    kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$p"; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

git="$(command -v git)" || die "git not found"
mkdir -p "$STATE"

# 0. One release at a time. Two patrol rounds can pass the same gate seconds apart; without
#    this lock the second restarts the node while the first is still building or rolling the
#    Hub, and both write state/last_release (2026-11-21: overlapping CEO rounds, 18:10 and
#    18:55). A held pid means a live release: refuse, change nothing, exit 0 so a patrol
#    reports a skip rather than a failure. A pid that no longer exists is a crash leftover
#    and is cleared. A dry run changes nothing and takes no lock.
LOCK="$STATE/.release.lock"
release_lock_release() {
  [ -d "$LOCK" ] || return 0
  [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
  return 0
}
if [ "$DRY" = 0 ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    held="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$held" ] && kill -0 "$held" 2>/dev/null; then
      say "release: another release is running (pid $held); nothing shipped"
      log "SKIP another release is running (pid $held)"
      exit 0
    fi
    say "release: clearing a stale release lock (pid ${held:-unknown})"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || die "cannot take $LOCK; nothing shipped"
  fi
  printf '%s\n' "$$" > "$LOCK/pid"
  trap release_lock_release EXIT
fi

# The release record and its snapshot. Nothing but mark() may write it; a long agent turn
# that reads it at its start and writes it back at its end loses any release that landed in
# between (2026-11-23 07:02). Compare against the snapshot before each phase and before
# every mark(), so a foreign write stops the run instead of being carried forward.
MARKER="$STATE/last_release"
MARKER_SEEN="$(cat "$MARKER" 2>/dev/null)"

require_marker_unchanged() { # <phase>
  local now; now="$(cat "$MARKER" 2>/dev/null)"
  [ "$now" = "$MARKER_SEEN" ] && return 0
  die "$1: $MARKER changed under this run (was: $(printf '%s' "$MARKER_SEEN" | tr '\n' ';'); now: $(printf '%s' "$now" | tr '\n' ';')); a concurrent writer (a fill turn?) rewrote the release record; refusing to ship on it"
}

# 1. Gate. Never releasable on a red check: the whole point is that the loop, not a
#    person, remembers the two conditions.
deadline=$(( $(date +%s) + WAIT ))
waits=0
while :; do
  CHK="$(RSI_REPO="$REPO" bash "$CHK_CMD")"; rc=$?
  [ $rc -eq 0 ] && break
  case "$CHK" in
    *reason=heavy:*)
      left=$(( deadline - $(date +%s) ))
      # A dry run reports, it does not wait: the patrol asks for a verdict here.
      if [ "$DRY" = 1 ] || [ "$left" -le 0 ]; then
        printf '%s\n' "$CHK"
        [ "$waits" -gt 0 ] && log "GATE_WAIT gave up after ${waits} checks"
        die "release-check says HOLD (see above)"
      fi
      rsn="$(printf '%s' "$CHK" | sed -n 's/^reason=//p')"
      waits=$((waits + 1))
      say "gate: waiting for the machine slot (${left}s left): $rsn"
      log "GATE_WAIT $rsn"
      [ "$STEP" -lt "$left" ] && nap="$STEP" || nap="$left"
      sleep "$nap"
      ;;
    *)
      printf '%s\n' "$CHK"
      [ "$waits" -gt 0 ] && log "GATE_WAIT ended after ${waits} checks: $(printf '%s' "$CHK" | sed -n 's/^reason=//p')"
      die "release-check says HOLD (see above)"
      ;;
  esac
done
printf '%s\n' "$CHK"
[ "$waits" -gt 0 ] && say "gate: the slot freed after $waits wait(s); releasing"
# The gate also reports how many non-merge commits sit on the released checkout's local
# main and nowhere on origin/main: they ship with this release, unreviewed. Report them,
# never gate on them (MANDATE allows an owner's local commits to ride a release); the
# number goes on the durable RELEASED record so a patrol can see what actually shipped.
LOCAL_MAIN_ONLY="$(printf '%s' "$CHK" | sed -n 's/^local_main_only=//p' | head -1)"
case "$LOCAL_MAIN_ONLY" in ''|*[!0-9]*) LOCAL_MAIN_ONLY=unknown ;; esac
case "$LOCAL_MAIN_ONLY" in
  unknown) : ;;
  *) [ "$LOCAL_MAIN_ONLY" -gt 0 ] && say "warning: $LOCAL_MAIN_ONLY commit(s) are on the local main only and are being shipped unreviewed" ;;
esac
SHA="$($git -C "$REPO" fetch -q origin main && $git -C "$REPO" rev-parse origin/main)"
# A failed fetch must stop here, before a single thing is rebuilt. Without this guard the
# script logged an empty SHA, rebuilt and restarted the live node, and only then aborted at
# the Hub with `git archive ""` — a half release plus a `node=` line with no SHA in
# state/last_release (2026-11-18 19:51, a transient github.com SSL error).
case "$SHA" in ''|*[!0-9a-f]*) die "git fetch origin main failed in $REPO; nothing shipped";; esac
[ "${#SHA}" -eq 40 ] || die "origin/main is not a full SHA ('$SHA') in $REPO; nothing shipped"
SHORT="$(printf '%s' "$SHA" | cut -c1-8)"
say "releasing $SHORT to node=$NODE hub=$HUB"
[ "$DRY" = 1 ] && { say "dry run: stopping here"; exit 0; }

# 2. The checkout must be clean and simply behind: this script may update a person's
#    primary checkout, so anything else is their call, never a silent reset.
$git -C "$REPO" fetch -q origin main || die "git fetch failed in $REPO"
dirty="$($git -C "$REPO" status --porcelain)"
[ -z "$dirty" ] || die "checkout is dirty (leave it alone): $(printf '%s' "$dirty" | head -3 | tr '\n' ' ')"
CUR="$($git -C "$REPO" rev-parse --abbrev-ref HEAD)"
[ "$CUR" = main ] || die "checkout is on $CUR, not main"
if $git -C "$REPO" merge-base --is-ancestor origin/main HEAD; then
  :   # already contains origin/main (an earlier release merged it)
elif ! $git -C "$REPO" merge --ff-only -q origin/main; then
  # Local main has commits of its own (a docs edit, an earlier merge). Integrate them the
  # plain way instead of rewriting anything: a merge commit is allowed, a reset never is.
  [ "$($git -C "$REPO" rev-list --count origin/main..HEAD)" -gt 0 ] || die "main cannot fast-forward to origin/main"
  say "main has $($git -C "$REPO" rev-list --count origin/main..HEAD) local commit(s); merging origin/main"
  # A local commit can be *already upstream* — the same patch landed as a PR — and still
  # conflict textually, because upstream later touched the same lines. Nothing local is
  # lost by taking upstream's side there, so an unattended release can decide that alone;
  # but it must prove the merged tree really is origin/main before shipping it. `git
  # cherry` marks a commit whose patch is absent upstream with `+`; no `+` line means every
  # local non-merge commit is redundant. `cherry` ignores merge commits, so content that
  # lives only in a local merge resolution is invisible here; the staged-tree proof below
  # still has to pass before anything is committed. A failing or empty cherry is "cannot
  # prove it" and keeps the plain merge.
  cherry_rc=0
  local_only="$($git -C "$REPO" cherry origin/main HEAD 2>/dev/null)" || cherry_rc=$?
  if [ "$cherry_rc" = 0 ] && [ -n "$local_only" ] && ! printf '%s\n' "$local_only" | grep -q '^+'; then
    say "main's local commits are already upstream; merging origin/main taking upstream on conflict"
    # Merge without committing: the proof runs against the staged tree and a failed proof
    # aborts the merge. Committing first would leave the unproven merge on local main, and
    # the next release would see origin/main as an ancestor (the branch above), skip
    # integration and ship that tree to the node and the Hub.
    if ! $git -C "$REPO" merge --no-edit -q --no-commit -X theirs origin/main; then
      conflicts="$($git -C "$REPO" diff --name-only --diff-filter=U 2>/dev/null | head -3 | tr '\n' ' ')"
      $git -C "$REPO" merge --abort 2>/dev/null || true
      die "origin/main conflicts with local main; a person has to resolve that${conflicts:+ (conflicting: ${conflicts% })} (checkout left as it was)"
    fi
    if ! $git -C "$REPO" diff --quiet --cached origin/main; then
      differs="$($git -C "$REPO" diff --name-only --cached origin/main 2>/dev/null | head -3 | tr '\n' ' ')"
      $git -C "$REPO" merge --abort 2>/dev/null || true
      die "merged tree differs from origin/main${differs:+ (differs: ${differs% })}; a person has to resolve that (checkout left as it was)"
    fi
    if ! $git -C "$REPO" commit --no-edit -q; then
      $git -C "$REPO" merge --abort 2>/dev/null || true
      die "could not commit the merge of origin/main (checkout left as it was)"
    fi
  elif ! $git -C "$REPO" merge --no-edit -q origin/main; then
    conflicts="$($git -C "$REPO" diff --name-only --diff-filter=U 2>/dev/null | head -3 | tr '\n' ' ')"
    $git -C "$REPO" merge --abort 2>/dev/null || true
    die "origin/main conflicts with local main; a person has to resolve that${conflicts:+ (conflicting: ${conflicts% })} (checkout left as it was)"
  fi
fi

# The integration above can bring a newer origin/main than the SHA captured before it. The
# node builds HEAD and the Hub archives a commit, so from here on record and ship HEAD.
PRE_SHA="$SHA"
SHA="$($git -C "$REPO" rev-parse HEAD)"
case "$SHA" in ''|*[!0-9a-f]*) die "cannot read the shipped commit in $REPO; nothing shipped";; esac
[ "${#SHA}" -eq 40 ] || die "HEAD is not a full SHA ('$SHA') in $REPO; nothing shipped"
SHORT="$(printf '%s' "$SHA" | cut -c1-8)"
[ "$SHA" = "$PRE_SHA" ] || say "origin/main moved mid-release; shipping $SHORT (pre-flight ${PRE_SHA:0:8})"

# mark <target> — record this SHA as released for one target, keeping the other, and prove
# the record landed. A write this script cannot see is not a release: on 2026-11-20 a run
# printed `node: shipped <sha>` while the file still held the previous SHA, and the Hub
# phase then copied that stale value forward as if it were this run's.
mark() {
  local t="$1" peer other="" tmp want got
  case "$t" in
    node) peer=hub ;;
    hub)  peer=node ;;
    *) die "mark: unknown target '$t'" ;;
  esac
  # A record this run cannot account for is not ours to overwrite: if it changed since the
  # last snapshot (the node build is long enough for a fill turn to land), stop before
  # writing, leaving the foreign line and the old SHAs exactly as they are.
  require_marker_unchanged "$t"
  other="$(sed -n "s/^$peer=//p" "$MARKER" 2>/dev/null | tail -1)"
  # One release ships one commit: SHA is HEAD after integration, so both targets must end
  # up at it. If the peer already holds something else while both phases run, something
  # else wrote the file (or the last write did not land). Refuse before writing so the
  # file is left exactly as we found it, and print what it says.
  if [ "$NODE" = 1 ] && [ "$HUB" = 1 ] && [ "$t" = hub ] && [ "$other" != "$SHA" ]; then
    die "$t: $MARKER says $peer=${other:-<missing>}, not $SHA that this run shipped; refusing to carry a stale value (file: $(tr '\n' ';' <"$MARKER" 2>/dev/null))"
  fi
  tmp="$STATE/.last_release.$$"
  : > "$tmp" || die "$t: cannot write $tmp"
  { [ "$t" = node ] && echo "node=$SHA" || { [ -n "$other" ] && echo "node=$other"; }; } >> "$tmp"
  { [ "$t" = hub ] && echo "hub=$SHA" || { [ -n "$other" ] && echo "hub=$other"; }; } >> "$tmp"
  echo "released_at=$(date '+%F %T %z')" >> "$tmp"
  # Keep every key another writer left (a note, a gate reading from a hand-run check): this
  # script owns node=, hub= and released_at=, not the whole file. Duplicates of the three
  # owned keys are dropped, so the record holds one line per key and the values just written.
  sed -n '/^node=/d;/^hub=/d;/^released_at=/d;p' "$MARKER" 2>/dev/null >> "$tmp"
  want="$(cat "$tmp")"
  mv "$tmp" "$MARKER" || die "$t: could not move $tmp into $MARKER"
  # Read the file back and compare it with what we just wrote. A rename that does not land
  # (or a concurrent writer) must stop the release, not be reported as shipped.
  got="$(cat "$MARKER" 2>/dev/null)"
  [ "$got" = "$want" ] \
    || die "$t: marker write did not land in $MARKER (expected $t=$SHA; file says: $(printf '%s' "$got" | tr '\n' ';'))"
  # This run's own write is the baseline for the next phase: the Hub compare must not treat
  # the node line this run just wrote as a foreign change.
  MARKER_SEEN="$got"
}

# The gate read the record that was on disk before the integration. If a fill turn wrote it
# back after that read, the GO describes a different file: stop before the rebuild, not after
# both targets shipped (2026-11-23 07:02).
require_marker_unchanged "node"

# 3. Node: the console + binary Ethan is looking at. desktop-rebuild.sh owns the
#    sequence (UI embed, ./kin, ~/.kin/node refresh, stop :7777, relaunch Electron).
if [ "$NODE" = 1 ]; then
  NODE_CMD="${RSI_RELEASE_NODE_CMD:-./scripts/desktop-rebuild.sh}"
  say "node: $NODE_CMD"
  # desktop-rebuild.sh ends by launching Electron and would hold this script open until
  # the desktop app exits; ask it to detach so the release can record its marker.
  ( cd "$REPO" && KIN_REBUILD_DETACH=1 $NODE_CMD ) >>"$STATE/releases.log" 2>&1 || die "node rebuild failed (see state/releases.log)"
  for i in $(seq 1 45); do
    curl -fs -o /dev/null -m 3 "$KIN_API/api/health" 2>/dev/null && break
    [ "$i" = 45 ] && die "node did not answer /api/health after 90s (see state/releases.log)"
    sleep 2
  done
  mark node
  say "node: shipped $SHORT"
fi

# 4. Hub: the NAS container. Built here for linux/amd64 from the same commit, because the
#    repo does not commit the console bundles and the Dockerfile builds them itself.
if [ "$HUB" = 1 ]; then
  # The snapshot now holds this run's node write; a change here is another writer, and the
  # Hub phase must not carry it forward.
  require_marker_unchanged "hub"
  command -v docker >/dev/null || die "hub: docker not available on this machine"
  docker info >/dev/null 2>&1 || die "hub: docker daemon is not running (start OrbStack, then release again)"
  STAGE="$(mktemp -d)"
  trap 'release_lock_release; rm -rf "$STAGE"' EXIT
  ( set -o pipefail; $git -C "$REPO" archive "$SHA" | tar -x -C "$STAGE" ) || die "hub: could not stage $SHORT"
  say "hub: building $IMAGE for linux/amd64 from $SHORT (emulated, this takes a while)"
  start=$(date +%s)
  if ! with_timeout "$TIMEOUT" docker build --platform linux/amd64 \
      --build-arg VERSION="dogfood-$SHORT" -t "$IMAGE" "$STAGE" >>"$STATE/releases.log" 2>&1; then
    die "hub: image build failed or timed out (see state/releases.log)"
  fi
  say "hub: built in $(( $(date +%s) - start ))s; rolling it to $HUB_SSH"
  ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$HUB_SSH" \
      "docker tag $IMAGE ${IMAGE}-prev 2>/dev/null || true" || die "hub: cannot reach $HUB_SSH"
  ( set -o pipefail; docker save "$IMAGE" | ssh "$HUB_SSH" 'docker load' ) >>"$STATE/releases.log" 2>&1 || die "hub: image transfer failed"
  ssh -n -o BatchMode=yes "$HUB_SSH" \
      "cd $HUB_DIR && docker compose -f $HUB_COMPOSE up -d" >>"$STATE/releases.log" 2>&1 || die "hub: compose up failed"
  for i in $(seq 1 30); do
    st="$(ssh -n -o BatchMode=yes "$HUB_SSH" "docker ps --filter name=openkin-hub --format '{{.Status}}'" 2>/dev/null | head -1)"
    case "$st" in *healthy*) say "hub: healthy ($st)"; break ;; esac
    [ "$i" = 30 ] && die "hub: container not healthy after 5 min ($st); previous image is ${IMAGE}-prev"
    sleep 10
  done
  mark hub
  say "hub: shipped $SHORT"
fi

log "RELEASED $SHORT node=$NODE hub=$HUB unshipped_before=$(printf '%s' "$CHK" | sed -n 's/^unshipped=\([0-9]*\).*/\1/p') local_main_only=$LOCAL_MAIN_ONLY"
say "done: $SHORT released local_main_only=$LOCAL_MAIN_ONLY"
