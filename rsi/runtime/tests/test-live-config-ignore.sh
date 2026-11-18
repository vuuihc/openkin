#!/bin/bash
# test-live-config-ignore.sh — the live box provider config stays uncommittable,
# and its example stays committable.
#
# .gitignore has an exact-path rule for rsi/runtime/box/box-side/litellm.yaml: a
# reactivated operator keeps a real gateway host and key there, and this repo is
# public. Deleting or widening that rule re-opens a `git add -A` that publishes a
# live gateway host. Assertions are on paths only — never on the live file, which
# is operator state and is never read or created.
#
# Hermetic: git and bash only, no writes, no network; npm, go, node and curl are
# booby traps (exit 97) so a future edit cannot start calling them.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BOX="rsi/runtime/box/box-side"
NAS="rsi/runtime/nas/compose"

n=0
pass() { n=$((n + 1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
curl() { echo "booby trap: curl invoked" >&2; exit 97; }
export -f npm go node curl
( npm ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "the npm booby trap is not live"

# not_ignored <path> — true only on exit 1 ("not ignored"); 0 and 128 fail, so a
# broken git cannot pass. --no-index is load-bearing: without it check-ignore
# never reports a tracked path as ignored, so a widened rule that swallowed the
# tracked .example still read "not ignored" (measured 2026-11-18).
not_ignored() { local rc=0; git -C "$REPO" check-ignore -q --no-index -- "$1" || rc=$?; [ "$rc" -eq 1 ]; }

# 1. The live config is ignored at all.
git -C "$REPO" check-ignore -q -- "$BOX/litellm.yaml" \
  || fail "case 1: $BOX/litellm.yaml is not ignored; a live gateway host and key could be committed"
pass "the live box config is ignored"

# 2. By one exact path in .gitignore — not a blanket over the directory.
out="$(git -C "$REPO" check-ignore -v -- "$BOX/litellm.yaml")" \
  || fail "case 2: check-ignore -v names no rule for $BOX/litellm.yaml"
case "$out" in .gitignore:*"$BOX/litellm.yaml") ;; *) fail "case 2: not the exact path in .gitignore: $out" ;; esac
pattern="${out%%$'\t'*}" # .gitignore:<line>:<pattern>
pattern="${pattern#*:*:}"
[ "$pattern" = "$BOX/litellm.yaml" ] || fail "case 2: the rule is '$pattern', not the exact path"
not_ignored "$BOX/litellm.yaml.bak" \
  || fail "case 2: $BOX/litellm.yaml.bak is ignored; the rule is a blanket"
pass "the rule names the exact path in .gitignore, and a sibling stays visible"

# 3. The example stays committable — a widened rule must not hide config templates.
not_ignored "$BOX/litellm.yaml.example" \
  || fail "case 3: $BOX/litellm.yaml.example is ignored (or check-ignore errored)"
pass "the example stays committable"

# 4. Never tracked: an ignore rule cannot protect a file already in the index.
rc=0; git -C "$REPO" ls-files --error-unmatch -- "$BOX/litellm.yaml" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] || fail "case 4: $BOX/litellm.yaml is tracked (ls-files exit $rc); ignore cannot protect it"
pass "the live box config is not tracked"

# 5. The NAS shape: compose/.env is ignored, templates are not. compose/.env.example
#    is not in the tree today, but check-ignore is pattern-based, so it still pins
#    the !.env.example negation; a real sibling (Dockerfile) proves no blanket.
git -C "$REPO" check-ignore -q -- "$NAS/.env" || fail "case 5: $NAS/.env is not ignored"
not_ignored "$NAS/.env.example" || fail "case 5: $NAS/.env.example is ignored; the !.env.example negation is gone"
not_ignored "$NAS/Dockerfile" || fail "case 5: $NAS/Dockerfile is ignored; the .env rules are a blanket"
pass "the NAS compose .env shape is unchanged"

echo "live config ignore guard: $n/$n cases passed"
