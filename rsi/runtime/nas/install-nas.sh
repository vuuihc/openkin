#!/bin/bash
# install-nas.sh — Mac side. Create the NAS work root (volume1, not the UGOS overlay), copy compose +
# nas-side scripts, clone a bare origin/main, build and start the isolated compose stack.
# Secrets: this script never reads a credential out of another container. The worker needs an *enabled
# magpie gateway/caller key* in <root>/secrets/magpie.key (mode 600), provisioned once with approval;
# the browser UI key is not a gateway key and is never copied here (M2).
# Root: the NAS path is resolved from the NAS user's $HOME at install time and written to the compose
# .env, so no account path is committed (M1). Override with NAS_REMOTE=/abs/path.
#
# Revert: ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'  (data stays until you rm -rf the root)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
NAS_HOST="${NAS_HOST:-nas}"
SSH_BIN="${NAS_SSH:-ssh}"
SCP_BIN="${NAS_SCP:-scp}"
SSH=("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -n)
SSH_IO=("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
SSH_T="${NAS_SSH_TIMEOUT:-120}"
XFER_T="${NAS_XFER_TIMEOUT:-900}"
HERE="$(cd "$(dirname "$0")" && pwd)"

REMOTE="${NAS_REMOTE:-}"
if [ -z "$REMOTE" ]; then
  REMOTE="$(with_timeout 30 "${SSH[@]}" "$NAS_HOST" 'printf %s "$HOME/kin-rsi-nas"')"
fi
case "$REMOTE" in /*) ;; *) echo "could not resolve an absolute NAS root (got '$REMOTE')"; exit 1;; esac
echo "NAS root: $REMOTE"

with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "mkdir -p '$REMOTE'/{compose,nas-side,secrets,work/{jobs,wt,logs,home/.claude}}"

# Copy scripts and compose (no secrets). UGOS rsync/scp reject some home paths; tar-over-ssh works.
COPYFILE_DISABLE=1 tar czf - -C "$HERE/compose" . | with_timeout "$XFER_T" "${SSH_IO[@]}" "$NAS_HOST" "tar xzf - -C '$REMOTE/compose'"
COPYFILE_DISABLE=1 tar czf - -C "$HERE/nas-side" . | with_timeout "$XFER_T" "${SSH_IO[@]}" "$NAS_HOST" "tar xzf - -C '$REMOTE/nas-side'"
# Compose interpolates KIN_RSI_NAS_ROOT from this file; it is generated here, never committed.
with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "printf 'KIN_RSI_NAS_ROOT=%s\n' '$REMOTE' > '$REMOTE/compose/.env' && chmod 600 '$REMOTE/compose/.env'"
# settings for the container home
with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "cp '$REMOTE/compose/claude-settings.json' '$REMOTE/work/home/.claude/settings.json'"

# The worker authenticates to magpie as a remote caller. Check for a provisioned caller key; never
# seed it from MAGPIE_WEB_KEY (that is the browser UI credential and cannot authenticate gateway calls).
KEY_STATE="$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "python3 - '$REMOTE/secrets/magpie.key' <<'PY'
import os,sys
p=sys.argv[1]
if os.path.exists(p) and os.path.getsize(p)>0:
    os.chmod(p,0o600); print('present bytes', os.path.getsize(p))
else:
    print('missing')
PY")"
case "$KEY_STATE" in
  present*) echo "magpie caller key: $KEY_STATE" ;;
  *)
    echo "WARNING: $REMOTE/secrets/magpie.key is missing."
    echo "The stack will build and start, but every worker and the smoke test will fail until a caller key exists."
    echo "Provision one with approval (this is a magpie config change; magpie routing/providers are untouched):"
    echo "  ssh $NAS_HOST 'docker exec magpie magpie gateway-key add kin-rsi-nas'"
    echo "  then write the printed sk-magpie-key-... into $REMOTE/secrets/magpie.key (mode 600)."
    ;;
esac

# Bare clone of the public repo (read-only). GitHub TLS from the NAS is flaky; fall back to a Mac-side bundle.
if ! with_timeout "$XFER_T" "${SSH[@]}" "$NAS_HOST" "if [ -d '$REMOTE/work/openkin.git' ] && git --git-dir='$REMOTE/work/openkin.git' rev-parse --verify refs/heads/main >/dev/null 2>&1; then git -c http.version=HTTP/1.1 --git-dir='$REMOTE/work/openkin.git' fetch origin main || true; echo HAVE_BARE; else git -c http.version=HTTP/1.1 clone --bare https://github.com/vuuihc/openkin.git '$REMOTE/work/openkin.git'; fi"; then
  echo "NAS git clone/fetch failed; shipping origin/main bundle from this Mac"
  BUNDLE="$(mktemp /tmp/openkin-origin-main.XXXXXX.bundle)"
  with_timeout "$XFER_T" "$GIT" -C "$RSI_CTRL" bundle create "$BUNDLE" origin/main
  COPYFILE_DISABLE=1 tar czf - -C "$(dirname "$BUNDLE")" "$(basename "$BUNDLE")" | with_timeout "$XFER_T" "${SSH_IO[@]}" "$NAS_HOST" "tar xzf - -C /tmp"
  with_timeout "$XFER_T" "${SSH[@]}" "$NAS_HOST" "
    set -e
    mkdir -p '$REMOTE/work'
    if [ ! -d '$REMOTE/work/openkin.git' ]; then git clone --bare /tmp/$(basename "$BUNDLE") '$REMOTE/work/openkin.git'; else git --git-dir='$REMOTE/work/openkin.git' fetch /tmp/$(basename "$BUNDLE") +origin/main:main; fi
    git --git-dir='$REMOTE/work/openkin.git' remote remove origin 2>/dev/null || true
    git --git-dir='$REMOTE/work/openkin.git' remote add origin https://github.com/vuuihc/openkin.git
    rm -f /tmp/$(basename "$BUNDLE")
  "
  rm -f "$BUNDLE"
fi
with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "chmod 700 '$REMOTE/secrets'; chmod -R u+rwX '$REMOTE/work' '$REMOTE/nas-side' || true; find '$REMOTE/compose' '$REMOTE/nas-side' -name '._*' -delete || true; chmod 600 '$REMOTE/secrets/magpie.key' 2>/dev/null || true"

# Prefetch node:24 if the default Docker Hub mirrors (163/tencent) fail. Do not change daemon.json.
with_timeout "$XFER_T" "${SSH[@]}" "$NAS_HOST" '
  if ! docker image inspect node:24-bookworm-slim >/dev/null 2>&1; then
    echo "prefetching node:24-bookworm-slim via docker.m.daocloud.io"
    docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
    docker tag docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim
  fi
'

echo "building and starting kin-rsi-nas stack (isolated bridge kin-rsi-nas)..."
# --pull=false plus daemon proxy as build-args (see compose/build-up.sh). Does not change daemon.json or OpenClash.
with_timeout "$XFER_T" "${SSH[@]}" "$NAS_HOST" "bash '$REMOTE/compose/build-up.sh'"
with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "cd '$REMOTE/compose' && docker compose ps && docker inspect --format 'net={{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' kin-rsi-nas-worker"
echo "install-nas done. Smoke: $HERE/smoke-nas.sh"
case "$KEY_STATE" in present*) ;; *) echo "Reminder: magpie caller key still missing; smoke will fail until it is provisioned." ;; esac
