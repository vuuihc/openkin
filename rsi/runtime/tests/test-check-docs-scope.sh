#!/bin/bash
# test-check-docs-scope.sh — the docs-only merge-gate scope runs just what can judge it.
#
# The rn scope (test-check-rn-scope.sh) cut an RN-only PR's check step to two jobs; a
# markdown-only PR paid the same ~10 min for repo-wide jobs that cannot read a diff of
# prose (2026-11-24: 11.2 h of a 21.5 h lock day on RN/docs PRs). scope_of now returns
# `docs` for a non-empty list that is all markdown outside ui/, web/ and mobile-rn/ —
# AGENTS.md and CLAUDE.md stay `full` because their pinned counts are asserted by tests —
# and gate.sh runs check.sh with KIN_CHECK_SCOPE=docs KIN_CHECK_CHANGED=<list>. The docs
# scope starts stories + ux-spec-refs + doc-refs, which greps the changed paths against
# the loop's shell suites and fails closed on coverage it cannot run (ui test, python
# test, Go test). This suite pins the seam:
#
#   * gate.sh's check step runs check.sh with KIN_CHECK_SCOPE=rn, and with =docs plus the
#     changed-path list, proven by a stub check.sh in a temp repo (without it, deleting either
#     arm falls back to the full check while the gate still prints a scoped label);
#   * --scope-of: md-only → docs; ui/web md, AGENTS.md/CLAUDE.md, md + code, empty → full;
#     mobile-rn md and the 0036 ADR → rn (rn wins precedence);
#   * KIN_CHECK_SCOPE=docs --list is exactly `stories`, `ux-spec-refs`, `doc-refs`;
#   * docs scope without KIN_CHECK_CHANGED exits 2;
#   * doc-refs runs a fixture suite that names the changed path (proving via side file,
#     since job output lands in the job's own log), fails when it fails, and prints
#     DOC_REFS_FALLBACK + fails when a ui/*.test.* file names the doc.
#
# RSI_CHECK_SH / RSI_GATE_SH point the cases at other scripts (the red-first lane uses
# them against origin/main copies). The doc-refs cases run a temp repo — the real
# check.sh next to stubs for the two other docs jobs — so no repo suite or fixture file
# is needed in the real tree. Hermetic: temp dirs, no network. Prints "PASS <case>" per
# case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CHECK="${RSI_CHECK_SH:-$REPO/scripts/check.sh}"
GATE="${RSI_GATE_SH:-$REPO/rsi/runtime/gate.sh}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

# --- gate.sh's check step hands the scope it computed to check.sh ---------------------------
# The cases below pin the classifier (--scope-of) and check.sh's own reading of KIN_CHECK_SCOPE;
# neither proves gate.sh wires the two together. Deleting either arm of its check step left every
# suite green, so the gate could fall back to the full check while still printing "scope:
# docs-only". This case runs the real gate.sh against a temp repo whose check.sh records its
# environment — the only seam that sees the hand-off. It comes first so a gate.sh without the
# wiring fails here, naming this case, before it can fail on --scope-of (the red-first lane runs
# this suite against an origin/main gate.sh).
export GIT_AUTHOR_NAME=docs-scope-test GIT_AUTHOR_EMAIL=docs-scope@example.com
export GIT_COMMITTER_NAME=docs-scope-test GIT_COMMITTER_EMAIL=docs-scope@example.com
export GIT_TERMINAL_PROMPT=0
export GIT=/usr/bin/git
mkdir -p "$T/ctrl/rsi/state"

gate_applies_scope() { # <case> <changed-path> <expected-scope>
  local name="$1" path="$2" want="$3" repo="$T/gate-scope-$1"
  local envf="$T/gate-scope-$1.env" changedf="$T/gate-scope-$1.changed" out rc
  rm -rf "$repo"; mkdir -p "$repo/scripts" "$repo/$(dirname "$path")"
  cat >"$repo/scripts/check.sh" <<SH
#!/bin/bash
printf '%s\n' "\${KIN_CHECK_SCOPE:-unset}" >"$envf"
if [ -n "\${KIN_CHECK_CHANGED:-}" ] && [ -f "\$KIN_CHECK_CHANGED" ]; then
  cp "\$KIN_CHECK_CHANGED" "$changedf"
fi
SH
  chmod +x "$repo/scripts/check.sh"
  echo base >"$repo/README.md"
  /usr/bin/git init -q -b main "$repo" || fail "gate-applies-scope-$name: git init"
  /usr/bin/git -C "$repo" add -A || fail "gate-applies-scope-$name: git add"
  /usr/bin/git -C "$repo" commit -qm base || fail "gate-applies-scope-$name: base commit"
  /usr/bin/git -C "$repo" update-ref refs/remotes/origin/main HEAD \
    || fail "gate-applies-scope-$name: origin/main"
  echo x >"$repo/$path"
  /usr/bin/git -C "$repo" add -A || fail "gate-applies-scope-$name: git add $path"
  /usr/bin/git -C "$repo" commit -qm "$name" || fail "gate-applies-scope-$name: commit $path"
  out="$T/gate-scope-$name.out"
  ( cd "$repo" && RSI_CTRL="$T/ctrl" bash "$GATE" --only check "$repo" ) >"$out" 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || fail "gate-applies-scope-$name: gate exited $rc: $(tr '\n' ' ' <"$out")"
  grep -q "^scope: $want-only " "$out" \
    || fail "gate-applies-scope-$name: no 'scope: $want-only' label: $(tr '\n' ' ' <"$out")"
  [ -f "$envf" ] || fail "gate-applies-scope-$name: check.sh never ran: $(tr '\n' ' ' <"$out")"
  [ "$(cat "$envf")" = "$want" ] \
    || fail "gate-applies-scope-$name: check.sh saw KIN_CHECK_SCOPE=$(cat "$envf"), want $want"
}

gate_applies_scope rn mobile-rn/one.ts rn
echo "PASS gate-applies-scope-rn"

gate_applies_scope docs docs/x.md docs
grep -qx 'docs/x.md' "$T/gate-scope-docs.changed" 2>/dev/null \
  || fail "gate-applies-scope-docs: KIN_CHECK_CHANGED did not name docs/x.md"
echo "PASS gate-applies-scope-docs"

# --- --scope-of: docs only for a non-empty, markdown-only, unprotected list ------------------
grep -q -- '--scope-of' "$GATE" || fail "scope-of: $GATE has no --scope-of seam"
scope_of() { # <paths...> — one per line through a temp file, print the gate's scope
  local f="$T/paths.$((i += 1))"
  printf '%s\n' "$@" >"$f"
  bash "$GATE" --scope-of "$f"
}
i=0
[ "$(scope_of docs/adr/0035-x.md)" = docs ] \
  || fail "scope-of: a lone markdown ADR is not docs"
[ "$(scope_of docs/fixture.md rsi/runtime/prompts/fill.md)" = docs ] \
  || fail "scope-of: a markdown-only list is not docs"
[ "$(scope_of ui/src/x.md)" = full ] \
  || fail "scope-of: ui markdown should be full"
[ "$(scope_of web/x.md)" = full ] \
  || fail "scope-of: web markdown should be full"
[ "$(scope_of AGENTS.md)" = full ] \
  || fail "scope-of: AGENTS.md pins asserted counts; should be full"
[ "$(scope_of docs/nested/CLAUDE.md)" = full ] \
  || fail "scope-of: a nested CLAUDE.md should be full"
[ "$(scope_of docs/a.md internal/x.go)" = full ] \
  || fail "scope-of: markdown + code should be full"
[ "$(scope_of mobile-rn/docs/x.md)" = rn ] \
  || fail "scope-of: mobile-rn markdown should stay rn"
[ "$(scope_of docs/adr/0036-x.md)" = rn ] \
  || fail "scope-of: the RN ADR should stay rn (rn wins precedence)"
: >"$T/empty"
[ "$(bash "$GATE" --scope-of "$T/empty")" = full ] \
  || fail "scope-of: an empty list should be full"
echo "PASS scope-of-docs"

# --- docs --list is exactly the three jobs that judge a docs diff, in start order ------------
grep -q 'KIN_CHECK_SCOPE' "$CHECK" \
  || fail "docs-list: $CHECK has no KIN_CHECK_SCOPE handling; refusing to run it"
grep -qE '^[[:space:]]*--list\)' "$CHECK" \
  || fail "docs-list: $CHECK has no --list mode; refusing to start a full gate"
printf 'docs/fixture.md\n' >"$T/changed"
out="$(KIN_CHECK_SCOPE=docs KIN_CHECK_CHANGED="$T/changed" bash "$CHECK" --list)" \
  || fail "docs-list: --list exited nonzero: $out"
[ "$out" = $'stories\nux-spec-refs\ndoc-refs' ] \
  || fail "docs-list: expected 'stories', 'ux-spec-refs', 'doc-refs'; got: $out"
echo "PASS docs-list"

# --- docs scope without the changed-path file is a caller bug: exit 2 ------------------------
# env -u: doc-refs runs this suite inside a docs-scoped check.sh, where KIN_CHECK_CHANGED
# is inherited; the case must see it unset to mean anything.
out="$(env -u KIN_CHECK_CHANGED KIN_CHECK_SCOPE=docs bash "$CHECK" --list 2>&1)"; rc=$?
[ "$rc" -eq 2 ] || fail "docs-no-changed: expected exit 2, got $rc: $out"
echo "PASS docs-no-changed"

# --- doc-refs: a temp repo proves it runs the suites that name the changed path --------------
# Real check.sh beside stubs for the other two docs-scope jobs; the fixture suite writes
# a side file because a job's stdout lands in its own log, not check.sh's output.
R="$T/repo"
mkdir -p "$R/scripts" "$R/rsi/runtime/tests" "$R/docs" "$R/ui/src"
cp "$REPO/scripts/check.sh" "$R/scripts/check.sh"
for p in stories.py ux_spec_refs_test.py ux_spec_refs.py; do
  printf 'import sys\nsys.exit(0)\n' >"$R/scripts/$p"
done
printf '#!/bin/bash\necho docs/fixture.md is pinned here\necho ran > "%s"\n' "$T/fixture-ran" \
  >"$R/rsi/runtime/tests/test-doc-fixture.sh"
chmod +x "$R/rsi/runtime/tests/test-doc-fixture.sh"

out="$(cd "$R" && KIN_CHECK_SCOPE=docs KIN_CHECK_CHANGED="$T/changed" bash scripts/check.sh 2>&1)"
rc=$?
[ "$rc" -eq 0 ] || fail "doc-refs-run: docs scope exited $rc: $out"
[ -f "$T/fixture-ran" ] \
  || fail "doc-refs-run: the fixture suite that names docs/fixture.md did not run: $out"
grep -q 'ok   doc-refs' <<<"$out" || fail "doc-refs-run: doc-refs did not pass: $out"
echo "PASS doc-refs-run"

# A referencing suite that fails must fail the job.
printf '#!/bin/bash\necho docs/fixture.md is pinned here\nexit 1\n' \
  >"$R/rsi/runtime/tests/test-doc-fixture.sh"
out="$(cd "$R" && KIN_CHECK_SCOPE=docs KIN_CHECK_CHANGED="$T/changed" bash scripts/check.sh 2>&1)"
rc=$?
[ "$rc" -ne 0 ] || fail "doc-refs-fails: a failing referencing suite exited 0"
grep -q 'FAIL doc-refs' <<<"$out" \
  || fail "doc-refs-fails: output does not name the failing job: $out"
echo "PASS doc-refs-fails"

# A ui test that names the doc is coverage doc-refs cannot run: fail closed, do not skip.
printf '#!/bin/bash\nexit 0\n' >"$R/rsi/runtime/tests/test-doc-fixture.sh"
printf 'it("names docs/fixture.md", () => {});\n' >"$R/ui/src/widget.test.ts"
out="$(cd "$R" && KIN_CHECK_SCOPE=docs KIN_CHECK_CHANGED="$T/changed" bash scripts/check.sh 2>&1)"
rc=$?
[ "$rc" -ne 0 ] || fail "doc-refs-fallback: a ui test naming the doc exited 0"
grep -q 'DOC_REFS_FALLBACK ui/src/widget.test.ts' <<<"$out" \
  || fail "doc-refs-fallback: output has no DOC_REFS_FALLBACK line: $out"
grep -q 'docs scope cannot cover' <<<"$out" \
  || fail "doc-refs-fallback: output has no fail-closed reason: $out"
echo "PASS doc-refs-fallback"
