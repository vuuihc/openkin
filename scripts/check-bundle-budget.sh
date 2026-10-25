#!/usr/bin/env bash
set -euo pipefail

# What the console's first screen costs, in the currency the budget was written
# in.
#
# The number is the gzip size of the files web/dist/index.html itself names: the
# module script the console boots from and the stylesheet it applies. Nothing
# else is charged, and in particular not the dynamic chunks — CodeViewer carries
# Monaco and is 865 kB gzip on its own, and a budget that counted it would say
# nothing about what a phone waits for when it opens the console. The regression
# this exists to catch is a chunk that becomes a *static* import, or the entry
# growing; either one moves into this set by itself.
#
# gzip is the unit because that is how the budget was written and how the bytes
# travel: the phone reaches this console through a tunnel that compresses, and
# the number a phone downloads is the one that matters.
#
# 1 MiB is the target from docs/plans/2026-10-23-lody-parity.md §6 ("首屏分包
# （目标 < 1 MB gzip）"). It is a constant rather than a flag on purpose: if a
# change needs more room, the first question is what the entry grew by and
# whether it belongs on the first screen at all, and a threshold that can be
# raised from a command line is a threshold that gets raised in a hurry.

budget=1048576

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$repo_root/web/dist"
index="$dist/index.html"

if [ ! -f "$index" ]; then
  echo "No built console at $index. Run 'cd ui && npx vite build' first." >&2
  exit 1
fi

# Every /assets/ script and stylesheet the document references. The match is on
# the path shape rather than on the tags, so a changed attribute order or a new
# tag type does not quietly empty this list.
#
# What it cannot see, and why that is the right trade here: a first screen that
# grows through something that is not an /assets/ .js or .css — today's
# manifest.webmanifest and icons/icon.svg are the only ones, and a font would be
# the next. Those are outside the parse by construction, so a font added later
# would ship on the first screen with this number unmoved. Widening the match to
# "every URL in the document" would mean counting the icons as budget, which
# they are not.
#
# `|| true` because of pipefail: a grep that matches nothing would otherwise end
# the script right here, with a bare exit 1 and no line saying why — and the
# guard below, which exists to say why, would never be reached.
assets="$(grep -oE '/assets/[A-Za-z0-9._-]+\.(js|css)' "$index" | sed 's|^/||' | sort -u || true)"

if [ -z "$assets" ]; then
  echo "$index names no /assets/ script or stylesheet; there is nothing to measure." >&2
  exit 1
fi

total=0
while IFS= read -r asset; do
  file="$dist/$asset"
  if [ ! -f "$file" ]; then
    echo "$index names $asset but $file does not exist; the build is incomplete." >&2
    exit 1
  fi
  raw="$(wc -c <"$file" | tr -d ' ')"
  gz="$(gzip -9 -c "$file" | wc -c | tr -d ' ')"
  total=$((total + gz))
  printf '  %-34s %9s raw %8s gzip\n' "$asset" "$raw" "$gz"
done <<<"$assets"

percent="$(awk -v total="$total" -v budget="$budget" 'BEGIN { printf "%.1f", (total / budget) * 100 }')"

if [ "$total" -gt "$budget" ]; then
  echo "First screen is $total bytes gzip, over the $budget byte budget ($percent%)." >&2
  echo "Look at what the entry grew by before raising the budget in scripts/check-bundle-budget.sh." >&2
  echo "See docs/plans/2026-10-26-p6-quality.md §P6b." >&2
  exit 1
fi

echo "First screen: $total bytes gzip of $budget ($percent%)."
