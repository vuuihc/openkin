#!/bin/bash
# install-nas.sh — Mac side. Create <NAS home>/kin-rsi-nas on the NAS (volume1, not the UGOS overlay),
# copy compose + nas-side scripts, extract the existing magpie gateway key (does not change magpie config),
# clone a bare origin/main, build and start the isolated compose stack.
# Revert: ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'  (data stays until you rm -rf ~/kin-rsi-nas).
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
NAS_HOST="${NAS_HOST:-nas}"
# Ceilings for the NAS-side git sync (AGENTS.md §13). A slow GitHub link gets the defaults; the
# KIN_NAS_* overrides exist so the hermetic suite can prove the bound with a 2 s ceiling.
GIT_FETCH_TIMEOUT="${KIN_NAS_FETCH_TIMEOUT:-120}"
GIT_CLONE_TIMEOUT="${KIN_NAS_CLONE_TIMEOUT:-300}"
# Same discovery as pulse-nas.sh: the NAS install root is $HOME/kin-rsi-nas there.
# NAS_REMOTE overrides it; nothing here hardcodes an account name.
REMOTE="${NAS_REMOTE:-$(ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$NAS_HOST" 'printf %s "$HOME/kin-rsi-nas"' 2>/dev/null || true)}"
if [ -z "$REMOTE" ]; then
  echo "install-nas: cannot discover \$HOME on $NAS_HOST; set NAS_REMOTE to the install root" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

ssh -o BatchMode=yes "$NAS_HOST" "mkdir -p '$REMOTE'/{compose,nas-side,secrets,work/{jobs,wt,logs,home/.claude}}"

# Copy scripts and compose (no secrets). UGOS rsync/scp reject some home paths; tar-over-ssh works.
COPYFILE_DISABLE=1 tar czf - -C "$HERE/compose" . | ssh -o BatchMode=yes "$NAS_HOST" "tar xzf - -C '$REMOTE/compose'"
COPYFILE_DISABLE=1 tar czf - -C "$HERE/nas-side" . | ssh -o BatchMode=yes "$NAS_HOST" "tar xzf - -C '$REMOTE/nas-side'"
# settings for the container home
ssh -o BatchMode=yes "$NAS_HOST" "cp '$REMOTE/compose/claude-settings.json' '$REMOTE/work/home/.claude/settings.json'"

# Extract MAGPIE_WEB_KEY from the already-running magpie container into a 600 file. Do not print it. Do not edit magpie config.
ssh -o BatchMode=yes "$NAS_HOST" "python3 - <<'PY'
import json,subprocess,os
path='$REMOTE/secrets/magpie.key'
if os.path.exists(path) and os.path.getsize(path)>0:
    print('magpie.key already present, bytes', os.path.getsize(path))
    os.chmod(path, 0o600)
    raise SystemExit(0)
ins=json.loads(subprocess.check_output(['docker','inspect','magpie'],text=True))[0]
key=None
for e in ins.get('Config',{}).get('Env',[]):
    if e.startswith('MAGPIE_WEB_KEY='):
        key=e.split('=',1)[1]
        break
assert key, 'MAGPIE_WEB_KEY not found in magpie container env (is magpie running?)'
os.makedirs(os.path.dirname(path), exist_ok=True)
fd=os.open(path, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
os.write(fd, key.encode())
os.close(fd)
print('wrote MAGPIE_WEB_KEY into magpie.key (UI key; may not work as a gateway key) bytes', os.path.getsize(path))
print('If smoke fails with not-an-enabled-gateway-key, replace this file with a dedicated caller key.')
print('Creating one (edits magpie config) needs approval: docker exec magpie magpie gateway-key add kin-rsi-nas')
PY"

# Bare clone of the public repo (read-only). GitHub TLS from the NAS is flaky; fall back to a Mac-side bundle.
# Both remote git calls are bounded and report their own status (AGENTS.md §13): a wedged link answers 124
# instead of blocking the installer with no output, and a failed fetch must reach the bundle below instead of
# being swallowed into HAVE_BARE. The remote fetch is the last status word of its branch, not a `|| true`.
sync_stage=fetch sync_timeout="$GIT_FETCH_TIMEOUT" sync_rc=0
bounded_run "$GIT_FETCH_TIMEOUT" ssh -o BatchMode=yes -o ConnectTimeout=10 "$NAS_HOST" "if [ -d '$REMOTE/work/openkin.git' ] && git --git-dir='$REMOTE/work/openkin.git' rev-parse --verify refs/heads/main >/dev/null 2>&1; then git -c http.version=HTTP/1.1 --git-dir='$REMOTE/work/openkin.git' fetch origin main || exit 1; echo HAVE_BARE; else exit 75; fi" || sync_rc=$?
if [ "$sync_rc" = 75 ]; then
  # No usable bare repo yet: a first clone gets its own, longer ceiling.
  sync_stage=clone sync_timeout="$GIT_CLONE_TIMEOUT" sync_rc=0
  bounded_run "$GIT_CLONE_TIMEOUT" ssh -o BatchMode=yes -o ConnectTimeout=10 "$NAS_HOST" "git -c http.version=HTTP/1.1 clone --bare https://github.com/vuuihc/openkin.git '$REMOTE/work/openkin.git'" || sync_rc=$?
fi
if [ "$sync_rc" != 0 ]; then
  if [ "$sync_rc" = 124 ]; then
    echo "NAS git $sync_stage timed out after ${sync_timeout}s"
    # A locally killed ssh can leave the remote git finishing; settle briefly so the bundle fetch
    # below does not race its ref lock. Bounded by construction, no retry loop.
    sleep 2
  else
    echo "NAS git $sync_stage failed (exit $sync_rc)"
  fi
  echo "NAS git clone/fetch failed; shipping origin/main bundle from this Mac"
  BUNDLE="$(mktemp /tmp/openkin-origin-main.XXXXXX.bundle)"
  git -C "$(cd "$HERE/../../.." && pwd)" bundle create "$BUNDLE" origin/main
  COPYFILE_DISABLE=1 tar czf - -C "$(dirname "$BUNDLE")" "$(basename "$BUNDLE")" | ssh -o BatchMode=yes "$NAS_HOST" "tar xzf - -C /tmp"
  ssh -o BatchMode=yes "$NAS_HOST" "
    set -e
    mkdir -p '$REMOTE/work'
    if [ ! -d '$REMOTE/work/openkin.git' ]; then git clone --bare /tmp/$(basename "$BUNDLE") '$REMOTE/work/openkin.git'; else git --git-dir='$REMOTE/work/openkin.git' fetch /tmp/$(basename "$BUNDLE") +origin/main:main; fi
    git --git-dir='$REMOTE/work/openkin.git' remote remove origin 2>/dev/null || true
    git --git-dir='$REMOTE/work/openkin.git' remote add origin https://github.com/vuuihc/openkin.git
    rm -f /tmp/$(basename "$BUNDLE")
  "
  rm -f "$BUNDLE"
fi
ssh -o BatchMode=yes "$NAS_HOST" "chmod 700 '$REMOTE/secrets'; chmod -R u+rwX '$REMOTE/work' '$REMOTE/nas-side' || true; find '$REMOTE/compose' '$REMOTE/nas-side' -name '._*' -delete || true; chmod 600 '$REMOTE/secrets/magpie.key' 2>/dev/null || true"

# Prefetch node:24 if the default Docker Hub mirrors (163/tencent) fail. Do not change daemon.json.
ssh -o BatchMode=yes "$NAS_HOST" '
  if ! docker image inspect node:24-bookworm-slim >/dev/null 2>&1; then
    echo "prefetching node:24-bookworm-slim via docker.m.daocloud.io"
    docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
    docker tag docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim
  fi
'

echo "building and starting kin-rsi-nas stack (isolated bridge kin-rsi-nas)..."
# --pull=false plus daemon proxy as build-args (see compose/build-up.sh). Does not change daemon.json or the daemon proxy.
# Pass the discovered root explicitly: build-up.sh would otherwise default to $HOME/kin-rsi-nas,
# which is the wrong mount when NAS_REMOTE overrides it.
ssh -o BatchMode=yes "$NAS_HOST" "KIN_RSI_NAS_ROOT='$REMOTE' bash '$REMOTE/compose/build-up.sh'"
ssh -o BatchMode=yes "$NAS_HOST" "cd '$REMOTE/compose' && docker compose ps && docker inspect --format 'net={{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' kin-rsi-nas-worker"
echo "install-nas done. Smoke: $HERE/smoke-nas.sh"
