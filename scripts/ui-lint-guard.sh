#!/usr/bin/env bash
# The added-file lint guard: rule tests first, then the real scoped run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -x ui/node_modules/.bin/eslint ]]; then
  echo "ui/node_modules is missing — run \`npm ci\` in ui/" >&2
  exit 1
fi

# RuleTester cases run even on a clean branch: a dead rule must still be red.
( cd ui && npx vitest run eslint-rules/index.test.ts ) || exit 1

exec python3 -B scripts/ui_lint_guard.py
