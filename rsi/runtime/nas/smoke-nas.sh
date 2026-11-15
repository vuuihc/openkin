#!/bin/bash
# smoke-nas.sh — Mac side. Verify the NAS worker can reach magpie and `claude -p` returns a short OK.
# Bounded like the pulse: a wedged ssh must not hold a terminal or a launchd slot forever.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
NAS_HOST="${NAS_HOST:-nas}"
SSH_BIN="${NAS_SSH:-ssh}"
SSH=("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -n)
SSH_T="${NAS_SSH_TIMEOUT:-120}"
echo "NAS load/mem before smoke:"
with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "echo load=\$(cat /proc/loadavg); awk '/MemAvailable/{printf \"MemAvailable_GB=%.2f\\n\", \$2/1024/1024}' /proc/meminfo"

# Fast auth probe (redacted). A browser UI key is not a gateway caller key; magpie only accepts an
# enabled caller key from outside the magpie container.
AUTH=$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "docker exec -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker bash -lc 'source /opt/rsi/claude-env.sh && python3 /opt/rsi/auth-probe.py'")
echo "$AUTH"
if echo "$AUTH" | grep -q 'not an enabled magpie gateway key'; then
  echo "SMOKE FAILED: the worker's magpie caller key is missing or not enabled."
  echo "install-nas.sh never copies the browser UI key; provision a caller key once, with approval:"
  echo "  ssh $NAS_HOST 'docker exec magpie magpie gateway-key add kin-rsi-nas'"
  echo "  then write the printed sk-magpie-key-... into <NAS root>/secrets/magpie.key (mode 600)."
  exit 1
fi

OUT=$(with_timeout "$SSH_T" "${SSH[@]}" "$NAS_HOST" "docker exec -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker bash -lc 'source /opt/rsi/claude-env.sh && claude -p \"Reply with exactly NAS_LANE_OK and nothing else.\" --model \"volcengine-gw/volcengine/deepseek-v4.1-flash[1m]\" --permission-mode bypassPermissions --max-budget-usd 1 --output-format text'")
echo "$OUT"
echo "$OUT" | grep -q 'NAS_LANE_OK' && echo "SMOKE OK" || { echo "SMOKE FAILED"; exit 1; }
