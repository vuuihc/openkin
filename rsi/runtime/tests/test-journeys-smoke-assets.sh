#!/bin/bash
# test-journeys-smoke-assets.sh — --no-build must refuse a dist whose index.html
# and assets/ came from different builds.
#
# journeys-smoke.sh --no-build used to trust web/dist as-is. When a branch
# switch, a control-tree sync or an uncommitted UI build left index.html naming
# an entry chunk that was not in web/dist/assets, the console 404'd, and the walk
# reported ~20 hard failures that read as product defects (#264; the same class
# cost #251 two phantom walks). This suite pins the guard: with --no-build the
# script stops with exit 2 and "index.html and assets disagree; rebuild" before
# the plan, the daemon or any out dir exists; without --no-build it does not
# fire.
#
# Hermetic: bash and python3 in temp dirs; npm, go, node and curl are booby
# traps (exit 97), so a guard that fell through to the build or the walk cannot
# pass. Prints "ok: <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SCRIPT_SRC="$REPO/scripts/journeys-smoke.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A broken guard must not pass by falling through to the build or the walk.
npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
curl() { echo "booby trap: curl invoked" >&2; exit 97; }
export -f npm go node curl
( npm ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "the npm booby trap is not live"

# tree <name> — a throwaway repo root with the real script and a minimal spec,
# so a run that is not refused reaches the --dry-run plan and exits 0.
tree() {
  local dir="$T/$1"
  mkdir -p "$dir/scripts" "$dir/rsi/runtime/ux" "$dir/web/dist"
  cp "$SCRIPT_SRC" "$dir/scripts/journeys-smoke.sh"
  cat > "$dir/rsi/runtime/ux/journeys.json" <<'JSON'
{"journeys": {"J1": {"viewports": ["phone"]}}, "viewports": {"phone": "390x844"}}
JSON
  printf '%s\n' "$dir"
}

# index_naming <dist> <ref>... — an index.html whose src/href name exactly these.
index_naming() {
  local dist="$1"; shift
  local ref
  {
    printf '<!doctype html><html><head>'
    for ref in "$@"; do
      case "$ref" in
        *.css) printf '<link rel="stylesheet" href="%s">' "$ref" ;;
        *) printf '<script type="module" src="%s"></script>' "$ref" ;;
      esac
    done
    printf '</head><body><div id="root"></div></body></html>\n'
  } > "$dist/index.html"
}

# run <root> <args>... — drive the copied script; sets rc, out, err.
run() {
  local dir="$1"; shift
  out="$(bash "$dir/scripts/journeys-smoke.sh" "$@" 2>"$T/stderr")"
  rc=$?
  err="$(cat "$T/stderr")"
}

# --- 1: index names two assets, assets/ holds neither (today's false red) ------
case_name="test_no_build_refuses_index_naming_a_missing_asset"
R1="$(tree case1)"
mkdir -p "$R1/web/dist/assets"
: > "$R1/web/dist/assets/index-BBBB.js"
index_naming "$R1/web/dist" /assets/index-AAAA.js /assets/index-AAAA.css
run "$R1" --no-build --dry-run
[ "$rc" -eq 2 ] || fail "$case_name: exit $rc, wanted 2 (stdout: $out)"
grep -q 'index.html and assets disagree' <<<"$err" \
  || fail "$case_name: stderr does not name the disagreement: $err"
grep -q 'rebuild' <<<"$err" || fail "$case_name: stderr does not tell the caller to rebuild: $err"
grep -q 'journeys-smoke plan' <<<"$out" && fail "$case_name: printed the plan anyway"
grep -q 'booby trap' <<<"$err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

# --- 2: no assets dir at all --------------------------------------------------
case_name="test_no_build_refuses_a_missing_assets_dir"
R2="$(tree case2)"
index_naming "$R2/web/dist" /assets/x.js
run "$R2" --no-build --dry-run
[ "$rc" -eq 2 ] || fail "$case_name: exit $rc, wanted 2 (stdout: $out)"
grep -qE 'index.html and assets disagree|web/dist/assets is missing' <<<"$err" \
  || fail "$case_name: stderr does not name the missing assets dir: $err"
grep -q 'journeys-smoke plan' <<<"$out" && fail "$case_name: printed the plan anyway"
grep -q 'booby trap' <<<"$err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

# --- 3: a consistent dist walks on to the plan ---------------------------------
case_name="test_no_build_accepts_a_consistent_dist"
R3="$(tree case3)"
mkdir -p "$R3/web/dist/assets"
: > "$R3/web/dist/assets/index-AAAA.js"
: > "$R3/web/dist/assets/index-AAAA.css"
index_naming "$R3/web/dist" /assets/index-AAAA.js /assets/index-AAAA.css
run "$R3" --no-build --dry-run
[ "$rc" -eq 0 ] || fail "$case_name: exit $rc, wanted 0 (stderr: $err)"
grep -q 'journeys-smoke plan' <<<"$out" || fail "$case_name: printed no plan: $out"
grep -q 'build console: no (--no-build)' <<<"$out" \
  || fail "$case_name: plan does not say the build was skipped: $out"
grep -q 'booby trap' <<<"$err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

# --- 4: remote and data references are not files to require --------------------
case_name="test_no_build_ignores_remote_and_data_references"
R4="$(tree case4)"
mkdir -p "$R4/web/dist/assets"
: > "$R4/web/dist/assets/index-AAAA.js"
: > "$R4/web/dist/assets/index-AAAA.css"
index_naming "$R4/web/dist" \
  /assets/index-AAAA.js /assets/index-AAAA.css \
  https://example.com/x.js //cdn.example.com/y.css 'data:text/javascript,export default 1'
run "$R4" --no-build --dry-run
[ "$rc" -eq 0 ] || fail "$case_name: exit $rc, wanted 0 (stderr: $err)"
grep -q 'journeys-smoke plan' <<<"$out" || fail "$case_name: printed no plan: $out"
grep -q 'booby trap' <<<"$err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

# --- 5: the guard is scoped to --no-build --------------------------------------
case_name="test_without_no_build_skips_the_guard"
R5="$(tree case5)"
mkdir -p "$R5/web/dist/assets"
: > "$R5/web/dist/assets/index-BBBB.js"
index_naming "$R5/web/dist" /assets/index-AAAA.js /assets/index-AAAA.css
run "$R5" --dry-run
[ "$rc" -eq 0 ] || fail "$case_name: exit $rc, wanted 0 (stderr: $err)"
grep -q 'journeys-smoke plan' <<<"$out" || fail "$case_name: printed no plan: $out"
grep -q 'index.html and assets disagree' <<<"$err" \
  && fail "$case_name: the guard fired without --no-build"
grep -q 'booby trap' <<<"$err" && fail "$case_name: reached a build/walk command"
pass "$case_name"

echo "journeys-smoke assets guard: 5/5 cases passed"
