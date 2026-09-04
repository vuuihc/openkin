#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
generated="$repo_root/ui/src/api/generated/openapi.ts"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

cd "$repo_root/ui"
npx openapi-typescript ../api/openapi.yaml -o "$tmp"

if ! cmp -s "$tmp" "$generated"; then
  diff -u "$generated" "$tmp" || true
  echo "Generated API types are stale. Run: cd ui && npm run generate:api" >&2
  exit 1
fi
