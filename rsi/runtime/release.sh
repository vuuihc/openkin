#!/bin/bash
# release.sh — roll the merged work on origin/main to the live node and the Hub.
#
# The CEO loop runs this when release-check.sh says GO: at least RSI_RELEASE_MIN merged
# PRs are unshipped and nobody is mid-conversation (MANDATE "Release gate"). Two targets,
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
# Nothing here force-pushes, tags, publishes a dmg, or touches relay/Hub config.
#
# usage: release.sh [--repo DIR] [--node-only|--hub-only] [--dry-run]
#   --repo DIR   the checkout to release (default /Users/vuuihc/Workspace/study/kin-multidevice)
#   --dry-run    print the plan and the release-check verdict, change nothing
#
# Env: RSI_RELEASE_STATE, RSI_RELEASE_MIN (passed to release-check.sh);
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
TIMEOUT="${RSI_HUB_TIMEOUT:-3600}"
NODE=1; HUB=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --node-only) HUB=0; shift ;;
    --hub-only) NODE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "release: unknown argument: $1" >&2; exit 2 ;;
  esac
done
say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
log() { mkdir -p "$STATE"; say "$*" >> "$STATE/releases.log"; }
die() { say "release: $*" >&2; log "ABORT $*"; exit 1; }

git="$(command -v git)" || die "git not found"
mkdir -p "$STATE"

# 1. Gate. Never releasable on a red check: the whole point is that the loop, not a
#    person, remembers the two conditions.
CHK="$(RSI_REPO="$REPO" bash "$HERE/release-check.sh")"; rc=$?
[ $rc -eq 0 ] || { printf '%s\n' "$CHK"; die "release-check says HOLD (see above)"; }
printf '%s\n' "$CHK"
SHA="$($git -C "$REPO" fetch -q origin main && $git -C "$REPO" rev-parse origin/main)"; SHORT="$(printf '%s' "$SHA" | cut -c1-8)"
say "releasing $SHORT to node=$NODE hub=$HUB"
[ "$DRY" = 1 ] && { say "dry run: stopping here"; exit 0; }

# 2. The checkout must be clean and simply behind: this script may update a person's
#    primary checkout, so anything else is their call, never a silent reset.
$git -C "$REPO" fetch -q origin main || die "git fetch failed in $REPO"
dirty="$($git -C "$REPO" status --porcelain)"
[ -z "$dirty" ] || die "checkout is dirty (leave it alone): $(printf '%s' "$dirty" | head -3 | tr '\n' ' ')"
CUR="$($git -C "$REPO" rev-parse --abbrev-ref HEAD)"
[ "$CUR" = main ] || die "checkout is on $CUR, not main"
if ! $git -C "$REPO" merge --ff-only -q origin/main; then
  # Local main has commits of its own (a docs edit, an earlier merge). Integrate them the
  # plain way instead of rewriting anything: a merge commit is allowed, a reset never is.
  [ "$($git -C "$REPO" rev-list --count origin/main..HEAD)" -gt 0 ] || die "main cannot fast-forward to origin/main"
  say "main has $($git -C "$REPO" rev-list --count origin/main..HEAD) local commit(s); merging origin/main"
  if ! $git -C "$REPO" merge --no-edit -q origin/main; then
    $git -C "$REPO" merge --abort 2>/dev/null || true
    die "origin/main conflicts with local main; a person has to resolve that (checkout left as it was)"
  fi
fi

mark() { # mark <target> — record this SHA as released for one target, keeping the other.
  local t="$1" other="" tmp
  [ "$t" = node ] && other="$(sed -n 's/^hub=//p' "$STATE/last_release" 2>/dev/null | head -1)"
  [ "$t" = hub ] && other="$(sed -n 's/^node=//p' "$STATE/last_release" 2>/dev/null | head -1)"
  tmp="$STATE/.last_release.$$"
  { [ "$t" = node ] && echo "node=$SHA" || echo "node=$other"; } > "$tmp"
  { [ "$t" = hub ] && echo "hub=$SHA" || echo "hub=$other"; } >> "$tmp"
  echo "released_at=$(date '+%F %T %z')" >> "$tmp"
  mv "$tmp" "$STATE/last_release"
}

# 3. Node: the console + binary Ethan is looking at. desktop-rebuild.sh owns the
#    sequence (UI embed, ./kin, ~/.kin/node refresh, stop :7777, relaunch Electron).
if [ "$NODE" = 1 ]; then
  NODE_CMD="${RSI_RELEASE_NODE_CMD:-./scripts/desktop-rebuild.sh}"
  say "node: $NODE_CMD"
  ( cd "$REPO" && $NODE_CMD ) >>"$STATE/releases.log" 2>&1 || die "node rebuild failed (see state/releases.log)"
  mark node
  say "node: shipped $SHORT"
fi

# 4. Hub: the NAS container. Built here for linux/amd64 from the same commit, because the
#    repo does not commit the console bundles and the Dockerfile builds them itself.
if [ "$HUB" = 1 ]; then
  command -v docker >/dev/null || die "hub: docker not available on this machine"
  docker info >/dev/null 2>&1 || die "hub: docker daemon is not running (start OrbStack, then release again)"
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  $git -C "$REPO" archive "$SHA" | tar -x -C "$STAGE" || die "hub: could not stage $SHORT"
  say "hub: building $IMAGE for linux/amd64 from $SHORT (emulated, this takes a while)"
  start=$(date +%s)
  if ! timeout "$TIMEOUT" docker build --platform linux/amd64 \
      --build-arg VERSION="dogfood-$SHORT" -t "$IMAGE" "$STAGE" >>"$STATE/releases.log" 2>&1; then
    die "hub: image build failed or timed out (see state/releases.log)"
  fi
  say "hub: built in $(( $(date +%s) - start ))s; rolling it to $HUB_SSH"
  ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$HUB_SSH" \
      "docker tag $IMAGE ${IMAGE}-prev 2>/dev/null || true" || die "hub: cannot reach $HUB_SSH"
  docker save "$IMAGE" | ssh "$HUB_SSH" 'docker load' >>"$STATE/releases.log" 2>&1 || die "hub: image transfer failed"
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

log "RELEASED $SHORT node=$NODE hub=$HUB unshipped_before=$(printf '%s' "$CHK" | sed -n 's/^unshipped=\([0-9]*\).*/\1/p')"
say "done: $SHORT released"
