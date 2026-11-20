#!/bin/bash
# test-lane-worker-contract.sh — the generated worker brief carries the two race rules, and one
# source produces the contract for both the generated brief and the --worker-contract-check seam.
#
# The 2026-11-20 retro measured two rework rounds in 24h with the same shape: a test was written
# but could never go red. #429 proved a class string instead of the real selection path; #434
# started the turn-end goroutine BEFORE writing its cancel flag, racing
# internal/task/orchestrate.go — green in the gate, red only in review. The contract every worker
# receives therefore gains two rules: set the shared state before starting the goroutine that
# reads it, and self-check a new/changed Go test with `-count=5 -race` on the touched package(s).
#
# The contract text lives in one function. `lane.sh --worker-contract-check <item> <mode>
# <worktree> <branch>` prints it; `lane.sh _worker-brief <n>` writes the same text to
# $STATE/lanes/<n>.worker-brief.md through the production header composition. The one-source case
# diffs the two, so a future edit cannot update one and not the other.
#
# Hermetic: temp RSI_CTRL (common.sh derives STATE from it), stubbed lanes.py/volc-budget/lane-pr,
# no network, no model calls, no git, no gh. npm/go/node/curl are booby traps: rendering a brief
# must not need them. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LANE="$(cd "$HERE/.." && pwd)/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }

# Booby traps: a contract seam renders text; it must run without package managers, Go, Node or curl.
npm() { exit 97; }; go() { exit 97; }; node() { exit 97; }; curl() { exit 97; }
export -f npm go node curl

SLUG="contract-race"; ITEM="R-contract-race"
CTRL="$T/ctrl"; ST="$CTRL/rsi/state"; BRIEF="$T/brief.md"
# seam sets HOME=$T/home, so common.sh derives WT_ROOT=$T/home/.kin/worktrees; _worker-brief
# derives the worktree from the slug the same way. Same fact, so the one-source diff is exact.
WT="$T/home/.kin/worktrees/rsi-$SLUG"
mkdir -p "$ST/lanes" "$CTRL/rsi/runtime" "$WT"
printf '# Brief\nbrief body line\n' > "$BRIEF"
# common.sh probes the budget and lane.sh sources lane-pr.sh before any seam: both must be stubs.
printf 'import sys\nsys.exit(0)\n' > "$CTRL/rsi/runtime/volc-budget.py"
printf '#!/bin/bash\n# stub: the seams never create a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
chmod +x "$CTRL/rsi/runtime/lane-pr.sh"   # common.sh heals a missing +x, loudly
# lanes.py get <n>: the same L_* shape the real registry prints, read from the lane record below.
cat > "$CTRL/rsi/runtime/lanes.py" <<'PY'
import json, os, shlex, sys
d = json.load(open(os.path.join(os.environ["RSI_STATE"], "lanes", sys.argv[2] + ".json")))
for k in ("slug", "item", "brief", "mode", "status", "pr"):
    print("L_%s=%s" % (k.upper(), shlex.quote(str(d.get(k, "")))))
PY

# lane_record <mode> — the claim record worker_contract reads for its declared paths and slug.
lane_record() {
  python3 - "$ST" "$ITEM" "$SLUG" "$BRIEF" "$1" <<'PY'
import json, sys, time
st, item, slug, brief, mode = sys.argv[1:6]
json.dump({"lane": 1, "slug": slug, "item": item, "brief": brief, "mode": mode,
           "paths": ["rsi/runtime/lane.sh", "scripts/check.sh"],
           "status": "claimed", "claimed_at": time.time()},
          open(f"{st}/lanes/1.json", "w"))
PY
}

# seam <args...> — lane.sh against the temp control tree and a temp HOME (no real worktrees, no
# node scan). The seam must exit before PAUSE, locks, fetch, dispatch or any lane bookkeeping.
seam() { RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" "$@"; }
contract_text() { seam --worker-contract-check "$ITEM" "$1" "$WT" "rsi/$SLUG"; }

# --- cases -------------------------------------------------------------------------------------

test_race_ordering_rule() {
  lane_record new
  # Pin the record lookup itself: 1.json is an older record for this lane (stale paths),
  # 2.json is the newest record for this lane (the real paths), and 3.json belongs to another
  # lane and is newest of all. Printing "-", skipping the slug filter, or keeping the first
  # record seen each fails the declared-paths assertion below; only newest-for-this-slug passes.
  python3 - "$ST" "$ITEM" "$SLUG" "$BRIEF" <<'PY'
import json, sys, time
st, item, slug, brief = sys.argv[1:5]
now = time.time()
base = {"lane": 1, "item": item, "brief": brief, "mode": "new", "status": "claimed"}
def write(n, **over):
    json.dump(dict(base, **over), open(f"{st}/lanes/{n}.json", "w"))
write(1, slug=slug, paths=["stale/path.sh"], claimed_at=now - 60)
write(2, slug=slug, paths=["rsi/runtime/lane.sh", "scripts/check.sh"], claimed_at=now)
write(3, slug="other-lane", paths=["other/lane.sh"], claimed_at=now + 60)
PY
  local text
  text="$(contract_text new)" || bad "race-ordering-rule: --worker-contract-check exited $?"
  grep -Fq "Declared paths: rsi/runtime/lane.sh, scripts/check.sh" <<<"$text" \
    || bad "declared-paths: contract does not carry the lane record's paths"
  grep -q "before you start the goroutine" <<<"$text" \
    || bad "race-ordering-rule: no state-before-goroutine rule (${text:0:400})"
  grep -q "Never start the goroutine and then write the flag it reads" <<<"$text" \
    || bad "race-ordering-rule: the rule does not name the forbidden order (${text:0:400})"
  rm -f "$ST"/lanes/2.json "$ST"/lanes/3.json
}

test_race_flag_self_check() {
  lane_record new
  local text
  text="$(contract_text new)" || bad "race-flag-self-check: --worker-contract-check exited $?"
  grep -q -- "-count=5 -race" <<<"$text" \
    || bad "race-flag-self-check: no -count=5 -race self-check (${text:0:400})"
  grep -q -- "./internal/<touched-package>/" <<<"$text" \
    || bad "race-flag-self-check: the self-check does not name the touched package (${text:0:400})"
}

test_prose_claim_check_rule() {
  lane_record new
  local text
  text="$(contract_text new)" || bad "prose-claim-check-rule: --worker-contract-check exited $?"
  grep -Fq "Claim check:" <<<"$text" \
    || bad "prose-claim-check-rule: the contract never names the 'Claim check:' marker"
  grep -Fq "Claim output:" <<<"$text" \
    || bad "prose-claim-check-rule: the contract never names the 'Claim output:' marker"
  grep -Fq "docs/product/" <<<"$text" \
    || bad "prose-claim-check-rule: the trigger paths omit the docs/product/ prefix"
  grep -Fq "rsi/GOAL.md" <<<"$text" \
    || bad "prose-claim-check-rule: the trigger paths omit rsi/GOAL.md"
  grep -Fq "none:" <<<"$text" \
    || bad "prose-claim-check-rule: the contract never names the 'Claim check: none:' waiver"
  grep -Fq "not delivery" <<<"$text" \
    || bad "prose-claim-check-rule: the contract does not say a missing claim is not delivery"
}

test_rework_keeps_rules() {
  lane_record rework
  seam _worker-brief 1 || bad "rework-keeps-rules: _worker-brief exited $?"
  local brief="$ST/lanes/1.worker-brief.md"
  [ -s "$brief" ] || bad "rework-keeps-rules: no generated $ST/lanes/1.worker-brief.md"
  grep -q "^## This is a REWORK" "$brief" || bad "rework-keeps-rules: no REWORK heading"
  grep -q "^REWORK RULES (targeted, not a rewrite)" "$brief" || bad "rework-keeps-rules: no REWORK RULES block"
  grep -q "Fix list" "$brief" || bad "rework-keeps-rules: no Fix list instruction"
  grep -q "before you start the goroutine" "$brief" \
    || bad "rework-keeps-rules: the rework brief lost the ordering rule"
  grep -q -- "-count=5 -race" "$brief" \
    || bad "rework-keeps-rules: the rework brief lost the self-check rule"
  grep -Fq "Claim output:" "$brief" \
    || bad "rework-keeps-rules: the rework brief lost the prose claim-check rule"
}

test_one_source() {
  lane_record new
  local text
  text="$(contract_text new)" || bad "one-source: --worker-contract-check exited $?"
  seam _worker-brief 1 || bad "one-source: _worker-brief exited $?"
  local brief="$ST/lanes/1.worker-brief.md"
  python3 - "$brief" > "$T/contract-portion.txt" <<'PY'
import sys
lines = open(sys.argv[1]).read().splitlines()
try:
    i = lines.index("# Brief")
except ValueError:
    sys.exit("generated brief has no '# Brief' marker")
while i and lines[i - 1] == "":
    i -= 1
sys.stdout.write("\n".join(lines[:i]) + "\n")
PY
  [ -s "$T/contract-portion.txt" ] || bad "one-source: the generated brief has an empty contract portion"
  if ! diff -u "$T/contract-portion.txt" <(printf '%s\n' "$text") > "$T/one-source.diff"; then
    bad "one-source: the seam text differs from the generated brief's contract portion"$'\n'"$(cat "$T/one-source.diff")"
  fi
}

run() { # <case> <fn>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$2" || exit 1
  ok "$1"
}

RAN=0
run race-ordering-rule test_race_ordering_rule
run race-flag-self-check test_race_flag_self_check
run prose-claim-check-rule test_prose_claim_check_rule
run rework-keeps-rules test_rework_keeps_rules
run one-source test_one_source
[ "$RAN" -gt 0 ] || bad "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
