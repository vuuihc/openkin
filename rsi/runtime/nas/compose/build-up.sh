#!/bin/bash
# Build and start the isolated stack. Uses the Docker daemon's existing HTTP proxy
# as build-args so apt/npm work behind OpenClash fake-ip. Does not change daemon.json
# or any other container/network.
set -euo pipefail
cd "$(dirname "$0")"
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
