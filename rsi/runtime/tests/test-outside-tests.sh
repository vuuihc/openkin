#!/bin/bash
# test-outside-tests.sh — hermetic checks for runtime/outside-tests.py
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/outside-tests.py" --self-test
echo "test-outside-tests: ALL-PASS"
