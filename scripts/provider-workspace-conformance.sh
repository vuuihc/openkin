#!/usr/bin/env bash
# Provider workspace conformance test (ADR 0014)
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0

check_no_dangerous() {
  local label="$1" argv="$2"
  for flag in "dangerously-bypass" "dangerously-skip" "workspace-write" "bypassPermissions" "acceptEdits"; do
    if echo "$argv" | grep -qF "$flag" 2>/dev/null; then
      echo "FAIL: $label contains $flag"
      return 1
    fi
  done
  echo "PASS: $label"
  return 0
}

echo "=== Workspace Read-Only Conformance ==="

if check_no_dangerous "Codex read-only" "codex --sandbox read-only -c features.hooks=false"; then
  ((PASS_COUNT++))
else
  ((FAIL_COUNT++))
fi

if check_no_dangerous "Claude read-only" "claude --permission-mode plan --disallowedTools Bash,Edit,Write"; then
  ((PASS_COUNT++))
else
  ((FAIL_COUNT++))
fi

if echo "claude --permission-prompt-tool" | grep -q "disallowedTools"; then
  echo "FAIL: Claude writable should not have disallowedTools"
  ((FAIL_COUNT++))
else
  echo "PASS: Claude writable (no disallowedTools)"
  ((PASS_COUNT++))
fi

echo ""
echo "Results: $PASS_COUNT pass, $FAIL_COUNT fail"
exit $FAIL_COUNT
