#!/bin/bash
# smoke-nas.sh — Mac side. Verify the NAS worker can reach magpie and `claude -p` returns a short OK.
set -euo pipefail
NAS_HOST="${NAS_HOST:-nas}"
echo "NAS load/mem before smoke:"
ssh -o BatchMode=yes "$NAS_HOST" "echo load=\$(cat /proc/loadavg); awk '/MemAvailable/{printf \"MemAvailable_GB=%.2f\\n\", \$2/1024/1024}' /proc/meminfo"

# Fast auth probe (redacted). MAGPIE_WEB_KEY is the browser UI key and is NOT a gateway key;
# magpie only accepts an enabled caller key from outside the magpie container.
AUTH=$(ssh -o BatchMode=yes "$NAS_HOST" "docker exec -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker bash -lc 'source /opt/rsi/claude-env.sh && python3 /opt/rsi/auth-probe.py'")
echo "$AUTH"
if echo "$AUTH" | grep -q 'not an enabled magpie gateway key'; then
  echo "SMOKE FAILED: ~/kin-rsi-nas/secrets/magpie.key is not an enabled magpie gateway key."
  echo "MAGPIE_WEB_KEY is the browser UI key only. Do not edit magpie config from this script."
  echo "To add a dedicated key (this is a magpie config change; do it only with approval):"
  echo "  ssh nas 'docker exec magpie magpie gateway-key add kin-rsi-nas'"
  echo "  then write the printed sk-magpie-key-... into ~/kin-rsi-nas/secrets/magpie.key (mode 600)."
  exit 1
fi

OUT=$(ssh -o BatchMode=yes "$NAS_HOST" "docker exec -u 1000:10 -e HOME=/work/home kin-rsi-nas-worker bash -lc 'source /opt/rsi/claude-env.sh && claude -p \"Reply with exactly NAS_LANE_OK and nothing else.\" --model \"volcengine-gw/volcengine/deepseek-v4.1-flash[1m]\" --permission-mode bypassPermissions --max-budget-usd 1 --output-format text'")
echo "$OUT"
echo "$OUT" | grep -q 'NAS_LANE_OK' && echo "SMOKE OK" || { echo "SMOKE FAILED"; exit 1; }
