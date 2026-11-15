#!/bin/bash
# format-changed.test.sh — regression tests for format-changed.sh.
# Runs in a throwaway repo with stubbed npx/gofmt: no network, no node_modules.
#   bash rsi/runtime/format-changed.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/format-changed.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

FAILS=0
pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }
expect_zero() { # description actual-status
  if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1 (status $2)"; fi
}
expect_nonzero() { # description actual-status
  if [ "$2" -ne 0 ]; then pass "$1"; else fail "$1 (status 0)"; fi
}
expect_contains() { # description haystack needle
  if printf '%s' "$2" | grep -q -- "$3"; then pass "$1"; else fail "$1 (missing: $3)"; fi
}
expect_absent() { # description haystack needle
  if printf '%s' "$2" | grep -q -- "$3"; then fail "$1 (unexpected: $3)"; else pass "$1"; fi
}

mkdir -p "$ROOT/bin" "$ROOT/repo"
cat > "$ROOT/bin/npx" <<'STUB'
#!/bin/bash
# prettier stub: --check fails on UNFORMATTED; --write replaces it.
[ "${1:-}" = "prettier" ] || { echo "unexpected npx $*" >&2; exit 2; }
mode="$2"
shift 3   # prettier, mode, --ignore-unknown
rc=0
for f in "$@"; do
  [ -f "$f" ] || continue
  if [ "$mode" = "--check" ]; then
    if grep -q UNFORMATTED "$f"; then echo "[warn] $f"; rc=1; fi
  else
    tmp="$f.stubtmp"
    sed 's/UNFORMATTED/formatted/g' "$f" > "$tmp" && mv "$tmp" "$f"
  fi
done
exit $rc
STUB
cat > "$ROOT/bin/gofmt" <<'STUB'
#!/bin/bash
# gofmt stub: -l lists files containing BADFMT; -w replaces it.
mode="${1:-}"; shift
case "$mode" in
  -l) for f in "$@"; do grep -q BADFMT "$f" && echo "$f"; done ;;
  -w) for f in "$@"; do
        [ -f "$f" ] || continue
        tmp="$f.stubtmp"
        sed 's/BADFMT/good/g' "$f" > "$tmp" && mv "$tmp" "$f"
      done ;;
  *) exit 2 ;;
esac
exit 0
STUB
chmod +x "$ROOT/bin/npx" "$ROOT/bin/gofmt"
export PATH="$ROOT/bin:$PATH"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
REPO="$ROOT/repo"
git init -q -b main "$REPO"
mkdir -p "$REPO/ui" "$REPO/internal"
printf '{}\n' > "$REPO/ui/package.json"
printf 'export const a = UNFORMATTED\n' > "$REPO/ui/a.tsx"
printf 'export const shared = UNFORMATTED\n' > "$REPO/ui/shared.tsx"
printf 'export const untouched = "clean"\n' > "$REPO/ui/untouched.tsx"
printf 'package internal // BADFMT\n' > "$REPO/internal/x.go"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "init"
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" checkout -qb work

# A. An unformatted changed UI file fails the check, naming the file.
printf 'export const a = UNFORMATTED + 1\n' > "$REPO/ui/a.tsx"
printf 'package internal // BADFMT + 1\n' > "$REPO/internal/x.go"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "feat: work"
out="$(bash "$SCRIPT" --check "$REPO" 2>&1)"; rc=$?
expect_nonzero "A: unformatted UI file fails --check" "$rc"
expect_contains "A: prettier names the file" "$out" "a.tsx"

# B. With the UI side formatted, gofmt names the Go file it wants.
printf 'export const a = formatted + 1\n' > "$REPO/ui/a.tsx"
git -C "$REPO" commit -qam "feat: format ui"
out="$(bash "$SCRIPT" --check "$REPO" 2>&1)"; rc=$?
expect_nonzero "B: unformatted Go file fails --check" "$rc"
expect_contains "B: gofmt names the file" "$out" "internal/x.go"

# C. --write --commit --check repairs the tree, commits, and passes.
out="$(bash "$SCRIPT" --write --commit --check "$REPO" 2>&1)"; rc=$?
expect_zero "C: write+commit+check exits 0" "$rc"
subject="$(git -C "$REPO" log -1 --format=%s)"
if [ "$subject" = "style: format changed UI and Go files" ]; then
  pass "C: format commit created"
else
  fail "C: format commit subject is '$subject'"
fi
if [ -z "$(git -C "$REPO" status --porcelain)" ]; then pass "C: working tree clean"; else fail "C: working tree still dirty"; fi
expect_contains "C: UI file formatted" "$(cat "$REPO/ui/a.tsx")" "formatted"
expect_absent "C: UI file has no marker" "$(cat "$REPO/ui/a.tsx")" "UNFORMATTED"
expect_contains "C: Go file formatted" "$(cat "$REPO/internal/x.go")" "good"

# D. A main that advanced mid-lane must not widen the write set: the merge
#    base, not origin/main, decides what the branch owns.
git -C "$REPO" checkout -q main
printf 'export const shared = formatted by main\n' > "$REPO/ui/shared.tsx"
git -C "$REPO" commit -qam "main: change shared"
git -C "$REPO" checkout -q work
git -C "$REPO" update-ref refs/remotes/origin/main main
printf 'export const b = UNFORMATTED\n' > "$REPO/ui/b.tsx"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "feat: b"
out="$(bash "$SCRIPT" --write --commit --check "$REPO" 2>&1)"; rc=$?
expect_zero "D: write+commit+check exits 0 with main ahead" "$rc"
expect_contains "D: branch file formatted" "$(cat "$REPO/ui/b.tsx")" "formatted"
expect_contains "D: main-only file left alone" "$(cat "$REPO/ui/shared.tsx")" "UNFORMATTED"
touched="$(git -C "$REPO" show --name-only --format= HEAD)"
expect_absent "D: format commit excludes files main changed" "$touched" "ui/shared.tsx"
expect_contains "D: format commit includes the branch file" "$touched" "ui/b.tsx"

# E. --commit stages only what the formatters rewrote, not every dirty file.
printf 'export const c = UNFORMATTED\n' > "$REPO/ui/c.tsx"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "feat: c unformatted"
printf 'export const untouched = "cleaner"\n' > "$REPO/ui/untouched.tsx"
out="$(bash "$SCRIPT" --write --commit --check "$REPO" 2>&1)"; rc=$?
expect_zero "E: write+commit+check exits 0" "$rc"
touched="$(git -C "$REPO" show --name-only --format= HEAD)"
expect_contains "E: formatter output committed" "$touched" "ui/c.tsx"
expect_absent "E: unrelated dirty file not committed" "$touched" "ui/untouched.tsx"
dirty="$(git -C "$REPO" status --porcelain -- ui/untouched.tsx)"
if [ -n "$dirty" ]; then pass "E: unrelated dirty file still dirty"; else fail "E: unrelated dirty file was committed"; fi

printf '\n%s failure(s)\n' "$FAILS"
[ "$FAILS" -eq 0 ]
