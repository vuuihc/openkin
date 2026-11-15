#!/usr/bin/env bash
cd /workspace/box-lane
export LITELLM_MASTER_KEY="$(cat proxy.key)"
exec ./venv/bin/litellm --config litellm.yaml --host 127.0.0.1 --port 3425
