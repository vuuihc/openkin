#!/bin/bash
# Build and start the isolated stack. Uses the Docker daemon's existing HTTP proxy
# as build-args so apt/npm work behind a fake-ip resolver. Does not change daemon.json
# or any other container/network.
set -euo pipefail
cd "$(dirname "$0")"
# docker-compose.yml mounts ${KIN_RSI_NAS_ROOT}/{work,secrets,nas-side}. Default it here so a
# run on the NAS works with no arguments; overriding it moves the whole install root.
export KIN_RSI_NAS_ROOT="${KIN_RSI_NAS_ROOT:-$HOME/kin-rsi-nas}"
PROXY="$(docker info -f '{{.HTTPProxy}}' 2>/dev/null || true)"
if [ -z "${PROXY:-}" ]; then
  PROXY="$(docker info -f '{{.HTTPSProxy}}' 2>/dev/null || true)"
fi
ARGS=(--pull=false)
if [ -n "${PROXY:-}" ] && [ "$PROXY" != "<no value>" ]; then
  ARGS+=(--build-arg "http_proxy=$PROXY" --build-arg "https_proxy=$PROXY" --build-arg "HTTP_PROXY=$PROXY" --build-arg "HTTPS_PROXY=$PROXY")
  echo "build will use existing docker HTTP proxy"
fi
docker compose build "${ARGS[@]}"
docker compose up -d
