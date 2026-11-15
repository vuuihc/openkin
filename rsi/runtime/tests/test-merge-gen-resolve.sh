#!/bin/bash
# test-merge-gen-resolve.sh — a merge of origin/main may conflict in generated files only; the
# merge lane must resolve those itself instead of sending the PR back for a rework round.
#
# Hermetic: temp git repos under mktemp -d, the two regenerators stubbed through
# RSI_DIST_BUILD_CMD / RSI_INV_UPDATE_CMD, RSI_CTRL redirected into the temp dir. No network,
# no npm, no python packages beyond the stdlib. Prints "PASS <case>" per case and exits
# non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R=""   # the repo the current case works on

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# --- stubs -------------------------------------------------------------------------------------
# The dist build runs with cwd = <repo>/ui, exactly like `npm run build`.
cat > "$T/dist-stub.sh" <<'SH'
#!/bin/bash
set -eu
printf 'dist-built\n' > ../web/dist/index.html
[ -n "${STUB_DIST_OUT:-}" ] && cp ../web/dist/index.html "$STUB_DIST_OUT"
exit 0
SH
# The inventory regenerator runs with cwd = the repo root, exactly like
# `python3 scripts/check-ui-inventory.py --update`. STUB_INV_OCC lets a case write a baseline
# that grew past origin/main's copy.
cat > "$T/inv-stub.py" <<'PY'
import json, os
occ = int(os.environ.get("STUB_INV_OCC", "3"))
text = json.dumps(
    {"note": "stub", "metrics": {"raw_button": {"label": "stub", "occurrences": occ, "files": 1}}},
    indent=2,
) + "\n"
with open(os.path.join("scripts", "ui-inventory-baseline.json"), "w", encoding="utf-8") as fh:
    fh.write(text)
out = os.environ.get("STUB_INV_OUT")
if out:
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(text)
PY

inv_json() { printf '{"note":"stub","metrics":{"raw_button":{"label":"stub","occurrences":%s,"files":1}}}\n' "$2" > "$1/scripts/ui-inventory-baseline.json"; }
commit() { g add -A >/dev/null && g commit -q -m "$1" || fail "commit $1 failed"; }

# start_conflict <name> <dist 0|1> <inventory 0|1> <source 0|1>
# Builds a repo whose `feat` branch and `origin/main` both change the requested files, then
# leaves a conflicted `git merge origin/main` in progress — the state sync_main() calls the
# resolver from.
start_conflict() {
  local name="$1" dist="$2" inv="$3" src="$4"
  R="$T/$name"; rm -rf "$R"; mkdir -p "$R/web/dist" "$R/scripts" "$R/ui/src"
  g init -q -b main || fail "$name: git init"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  printf 'dist-base\n' > "$R/web/dist/index.html"; inv_json "$R" 9; printf 'app-base\n' > "$R/ui/src/App.tsx"
  commit base
  g update-ref refs/remotes/origin/main HEAD          # the remote-tracking ref merge.sh reads
  g checkout -q -b feat
  [ "$dist" = 1 ] && printf 'dist-ours\n' > "$R/web/dist/index.html"
  [ "$inv" = 1 ] && inv_json "$R" 2
  [ "$src" = 1 ] && printf 'app-ours\n' > "$R/ui/src/App.tsx"
  commit ours
  g checkout -q main
  [ "$dist" = 1 ] && printf 'dist-theirs\n' > "$R/web/dist/index.html"
  [ "$inv" = 1 ] && inv_json "$R" 4                 # origin/main moved the ratchet to 4
  [ "$src" = 1 ] && printf 'app-theirs\n' > "$R/ui/src/App.tsx"
  commit theirs
  g update-ref refs/remotes/origin/main main
  g checkout -q feat
  g merge -q --no-edit origin/main >/dev/null 2>&1 && fail "$name: expected a conflicted merge"
  [ -n "$(g diff --name-only --diff-filter=U)" ] || fail "$name: no unmerged paths"
  return 0
}

# resolve [stub occurrences] -> the resolver's exit code
resolve() {
  RSI_CTRL="$T/ctrl" \
  RSI_DIST_BUILD_CMD="bash $T/dist-stub.sh" \
  RSI_INV_UPDATE_CMD="python3 $T/inv-stub.py" \
  STUB_INV_OCC="${1:-3}" \
  STUB_DIST_OUT="$T/dist.out" STUB_INV_OUT="$T/inv.out" \
    bash "$MERGE" --resolve-generated "$R"
}

clean_tree() { [ -z "$(g status --porcelain)" ] || { g status --porcelain >&2; return 1; }; }
no_unmerged() { [ -z "$(g diff --name-only --diff-filter=U)" ]; }
# A merge commit landed since $1 — one commit, or a merge plus a rebuild commit.
merged_since() { [ -n "$(g rev-list --min-parents=2 "$1..HEAD")" ]; }

# --- cases -------------------------------------------------------------------------------------

# Today's dist-only recipe, unchanged: still resolves.
test_dist_only_unchanged() {
  start_conflict dist_only 1 0 0
  local old; old="$(g rev-parse HEAD)"
  resolve; [ $? -eq 0 ] || fail "dist-only: resolver returned non-zero"
  no_unmerged || fail "dist-only: unmerged entries left"
  merged_since "$old" || fail "dist-only: merge was not committed"
  cmp -s "$R/web/dist/index.html" "$T/dist.out" || fail "dist-only: dist is not the rebuilt output"
  clean_tree || fail "dist-only: tree is not clean"
}

# The case the tax is about: a lone baseline conflict used to be a sendback.
test_baseline_only() {
  start_conflict baseline_only 0 1 0
  local old; old="$(g rev-parse HEAD)"
  resolve; [ $? -eq 0 ] || fail "baseline-only: resolver returned non-zero (today's sendback)"
  no_unmerged || fail "baseline-only: unmerged entries left"
  merged_since "$old" || fail "baseline-only: merge was not committed"
  cmp -s "$R/scripts/ui-inventory-baseline.json" "$T/inv.out" || fail "baseline-only: baseline is not the regenerated output"
  clean_tree || fail "baseline-only: tree is not clean"
}

# Both generated files conflict: both are regenerated and the merge lands as one commit.
test_dist_and_baseline() {
  start_conflict both 1 1 0
  local old; old="$(g rev-parse HEAD)"
  resolve; [ $? -eq 0 ] || fail "both: resolver returned non-zero"
  no_unmerged || fail "both: unmerged entries left"
  merged_since "$old" || fail "both: merge was not committed"
  cmp -s "$R/web/dist/index.html" "$T/dist.out" || fail "both: dist is not the rebuilt output"
  cmp -s "$R/scripts/ui-inventory-baseline.json" "$T/inv.out" || fail "both: baseline is not the regenerated output"
  local n; n="$(g rev-list --count "$old..HEAD")"
  [ "$n" -le 2 ] || fail "both: resolver made $n commits, want 1 (merge) or 2 (merge + rebuild)"
  clean_tree || fail "both: tree is not clean"
}

# A source conflict is a person's job: refuse, commit nothing, leave the conflict for the caller.
test_refuses_source_conflict() {
  start_conflict src_conflict 1 1 1
  local old; old="$(g rev-parse HEAD)"
  resolve; [ $? -ne 0 ] || fail "source-conflict: resolver returned 0"
  [ "$(g rev-parse HEAD)" = "$old" ] || fail "source-conflict: resolver committed"
  g diff --name-only --diff-filter=U | grep -qx 'ui/src/App.tsx' || fail "source-conflict: App.tsx no longer unmerged"
}

# A regenerator that cannot run must leave the merge uncommitted, because the caller's
# `git merge --abort` only restores an uncommitted merge.
test_failed_regen_leaves_merge_abortable() {
  start_conflict failed_regen 1 1 0
  local old; old="$(g rev-parse HEAD)"
  RSI_CTRL="$T/ctrl" RSI_DIST_BUILD_CMD="false" RSI_INV_UPDATE_CMD="python3 $T/inv-stub.py" \
    bash "$MERGE" --resolve-generated "$R"; local rc=$?
  [ "$rc" -ne 0 ] || fail "failed-regen: resolver returned 0"
  [ "$(g rev-parse HEAD)" = "$old" ] || fail "failed-regen: resolver committed"
  g rev-parse -q --verify MERGE_HEAD >/dev/null || fail "failed-regen: merge is no longer abortable"
  g merge --abort >/dev/null 2>&1 || fail "failed-regen: git merge --abort failed"
  clean_tree || fail "failed-regen: tree is not clean after abort"
}


# Counts may only go down: a regenerated baseline above origin/main's (here 4) must abort, not commit.
test_refuses_ratchet_growth() {
  start_conflict ratchet_growth 0 1 0
  local old; old="$(g rev-parse HEAD)"
  resolve 5; [ $? -ne 0 ] || fail "ratchet-growth: resolver returned 0"
  [ "$(g rev-parse HEAD)" = "$old" ] || fail "ratchet-growth: resolver committed a growing baseline"
}

run() { "$1" || exit 1; pass "$1"; }
run test_dist_only_unchanged
run test_baseline_only
run test_dist_and_baseline
run test_refuses_source_conflict
run test_failed_regen_leaves_merge_abortable
run test_refuses_ratchet_growth
