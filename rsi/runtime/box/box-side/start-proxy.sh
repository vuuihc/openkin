#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$DIR/litellm.yaml" ]; then
  echo "missing litellm.yaml beside start-proxy.sh; copy litellm.yaml.example and set your gateway host" >&2
  exit 1
fi
cd /workspace/box-lane
export LITELLM_MASTER_KEY="$(cat proxy.key)"
exec ./venv/bin/litellm --config litellm.yaml --host 127.0.0.1 --port 3425
