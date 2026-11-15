#!/bin/bash
# format-changed.sh [--write] [--commit] [--check] [worktree]
# Format and/or check the files this change touches, matching CI's changed-files
# `prettier --check` (from ui/, vs origin/main or $BASE_SHA) plus gofmt for
# changed Go files. Never pushes. Compatible with macOS /bin/bash 3.2.
set -euo pipefail

WRITE=0; COMMIT=0; CHECK=0; WT=""
for a in "$@"; do
  case "$a" in
    --write) WRITE=1 ;;
    --commit) COMMIT=1 ;;
    --check) CHECK=1 ;;
    -*) echo "format-changed.sh: unknown flag $a" >&2; exit 2 ;;
    *) WT="$a" ;;
  esac
done
[ $WRITE -eq 0 ] && [ $COMMIT -eq 0 ] && [ $CHECK -eq 0 ] && CHECK=1
WT="$(cd "${WT:-.}" && pwd)"
GIT_BIN="${GIT:-git}"

base="${BASE_SHA:-}"
if [ -z "$base" ] || ! $GIT_BIN -C "$WT" cat-file -e "$base^{commit}" 2>/dev/null; then
  if $GIT_BIN -C "$WT" rev-parse --verify origin/main >/dev/null 2>&1; then
    base=origin/main
  else
    base="$($GIT_BIN -C "$WT" rev-parse HEAD^ 2>/dev/null || true)"
  fi
fi
if [ -z "$base" ] || ! $GIT_BIN -C "$WT" cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "format-changed.sh: no base commit; skipping"
  exit 0
fi

# Relative UI paths, same as CI (`working-directory: ui` + --relative -- .).
ui_rel() { # git-diff extra args (e.g. origin/main...HEAD or origin/main)
  ( cd "$WT/ui" && $GIT_BIN diff --relative --name-only --diff-filter=ACMR "$@" -- . )
}

go_paths() {
  $GIT_BIN -C "$WT" diff --name-only --diff-filter=ACMR "$@" -- '*.go' ':!**/vendor/**'
}

uniq_lines() { awk 'NF && !seen[$0]++ {print}'; }

# Run prettier on relative-to-ui paths listed on stdin (one file per line).
run_prettier() { # --write | --check
  local mode="$1" list tmp
  list="$(cat)"
  [ -n "$list" ] || return 0
  if [ ! -d "$WT/ui" ]; then
    echo "format-changed.sh: ui/ missing but UI files changed" >&2
    return 1
  fi
  tmp="$(mktemp)"
  printf '%s\n' "$list" > "$tmp"
  ( cd "$WT/ui" && xargs -n 50 npx prettier "$mode" --ignore-unknown < "$tmp" )
  rm -f "$tmp"
}

if [ $WRITE -eq 1 ]; then
  # Working tree vs base, so uncommitted worker edits are formatted too.
  UI_WRITE="$( ( ui_rel "$base" || true ) | uniq_lines )"
  GO_WRITE="$( ( go_paths "$base" || true ) | uniq_lines )"
  if [ -n "$UI_WRITE" ]; then
    printf '%s\n' "$UI_WRITE" | run_prettier --write
  fi
  if [ -n "$GO_WRITE" ]; then
    if ! command -v gofmt >/dev/null 2>&1; then
      echo "format-changed.sh: gofmt not on PATH but Go files changed" >&2
      exit 1
    fi
    oldifs="$IFS"
    IFS='
'
    for f in $GO_WRITE; do
      [ -f "$WT/$f" ] && gofmt -w "$WT/$f"
    done
    IFS="$oldifs"
  fi
fi

if [ $COMMIT -eq 1 ]; then
  DIRTY="$($GIT_BIN -C "$WT" status --porcelain --untracked-files=no -- ui '*.go' || true)"
  if [ -n "$DIRTY" ]; then
    $GIT_BIN -C "$WT" add -u -- ui
    oldifs="$IFS"
    IFS='
'
    for f in $($GIT_BIN -C "$WT" diff --name-only --diff-filter=ACMR -- '*.go' || true); do
      [ -n "$f" ] && $GIT_BIN -C "$WT" add -- "$f"
    done
    IFS="$oldifs"
    $GIT_BIN -C "$WT" commit -q -m "style: format changed UI and Go files"
  fi
fi

if [ $CHECK -eq 1 ]; then
  # Exact CI check: committed files only, three-dot vs the base ref.
  UI_CHECK="$( ( ui_rel "$base"...HEAD || true ) | uniq_lines )"
  GO_CHECK="$( ( go_paths "$base"...HEAD || true ) | uniq_lines )"
  if [ -n "$UI_CHECK" ]; then
    printf '%s\n' "$UI_CHECK" | run_prettier --check
  else
    echo "format-changed.sh: no changed UI files"
  fi
  if [ -n "$GO_CHECK" ]; then
    if ! command -v gofmt >/dev/null 2>&1; then
      echo "format-changed.sh: gofmt not on PATH but Go files changed" >&2
      exit 1
    fi
    bad=""
    oldifs="$IFS"
    IFS='
'
    for f in $GO_CHECK; do
      [ -f "$WT/$f" ] || continue
      [ -z "$(gofmt -l "$WT/$f")" ] || bad="$bad$f
"
    done
    IFS="$oldifs"
    if [ -n "$bad" ]; then
      echo "format-changed.sh: gofmt needed on:" >&2
      printf '%s' "$bad" >&2
      exit 1
    fi
  fi
fi
exit 0
