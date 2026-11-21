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
ROOT="$(cd "$HERE/../../.." && pwd)"
LANE="$(cd "$HERE/.." && pwd)/lane.sh"
CLOUD_TEMPLATE="$ROOT/rsi/runtime/prompts/cloud-brief-template.md"
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
  grep -Fq "Claim check: none:" <<<"$text" \
    || bad "prose-claim-check-rule: the contract never names the 'Claim check: none:' waiver"
  grep -Fq "at least 20 characters" <<<"$text" \
    || bad "prose-claim-check-rule: the waiver does not state the 20-character reason minimum"
  grep -Fq "not delivery" <<<"$text" \
    || bad "prose-claim-check-rule: the contract does not say a missing claim is not delivery"
}

# A PR body that claims more than the diff does costs a whole rework round: the reviewer has to
# re-derive every claim by hand. The contract therefore asks for a Claims block whose every line
# names the test or mutant that would go red, and the reviewer card makes checking it the first
# pass. This is a writing rule, not a second hard gate, so a testless claim is waived with a
# reasoned `none:` line rather than refused.
test_claims_block_rule() {
  lane_record new
  local text
  text="$(contract_text new)" || bad "claims-block-rule: --worker-contract-check exited $?"
  # Section order: the Claims block sits after Verification and before Screenshots.
  python3 - "$text" <<'PY' || exit 1
import sys
text = sys.argv[1]
def pos(needle):
    i = text.find(needle)
    if i < 0:
        sys.exit("claims-block-rule: the contract never names %r" % needle)
    return i
v, c, s = pos("Verification"), pos("Claims"), pos("Screenshots")
if not v < c < s:
    sys.exit("claims-block-rule: Claims must sit after Verification and before Screenshots "
             "(Verification@%d Claims@%d Screenshots@%d)" % (v, c, s))
PY
  # One line per claim, in field order: where it lives, the test, the mutant/check that goes red.
  grep -Fq '<path:line> · <test name> · <mutant or the check that would go red without the line>' <<<"$text" \
    || bad "claims-block-rule: the path:line · test · mutant field order is not stated"
  # A claim with no test is waived with a reason, not silently dropped. Anchor on the Claims
  # sentence: the bare `none:` text also appears in the older prose Claim-check rule, so only the
  # full sentence makes this case go red when the Claims waiver is deleted.
  grep -Fq 'A claim with no test is `none: <reason of at least 20 characters>`' <<<"$text" \
    || bad "claims-block-rule: the none: waiver and its 20-character minimum are not stated"
  # It is a writing rule the reviewer applies; it is not a second hard gate.
  grep -Fq 'this is a writing rule, not a hard gate' <<<"$text" \
    || bad "claims-block-rule: the contract does not say the Claims rule is not a hard gate"
  if grep -F 'Claims' <<<"$text" | grep -Eq '\bmust\b|fails the lane'; then
    bad "claims-block-rule: the Claims block introduces hard-gate wording"
  fi
}

# The worker's copy of the full suite competes with the merge gate for the same machine: on
# 2026-11-19 a worker's `check.sh` ran beside three queued gates (load 9–10.6 on 8 cores,
# swap free 1.3 GB) and two concurrent UI builds sat behind that day's false reds. The merge
# gate already runs the full suite on the same tree, so the contract keeps the worker on
# focused checks and names the gate as the owner of the full run.
test_no_full_gate_instruction() {
  lane_record new
  local text
  text="$(contract_text new)" || bad "no-full-gate-instruction: --worker-contract-check exited $?"
  grep -Fq "FOCUSED checks only" <<<"$text" \
    || bad "no-full-gate-instruction: the contract lost the focused-checks rule (${text:0:400})"
  grep -Fq "The merge lane runs the full gate" <<<"$text" \
    || bad "no-full-gate-instruction: the contract no longer names the merge lane as the full-gate owner (${text:0:400})"
  if grep -Fq -- "./scripts/check.sh" <<<"$text"; then
    bad "no-full-gate-instruction: the contract still orders the full suite the merge lane already runs"
  fi
}

# The cloud/NAS brief is read by agents on a container with no Go toolchain (python3, bash, git,
# node only), so ordering `./scripts/check.sh` there is a command that cannot pass on their
# machine. The template must send them to the focused suites that exist locally and leave the
# full suite to the Mac merge gate. File-level on purpose: the test reads the file the cloud
# agent reads, not a copy.
test_cloud_brief_has_no_full_gate() {
  [ -f "$CLOUD_TEMPLATE" ] || bad "cloud-brief-has-no-full-gate: no such file: $CLOUD_TEMPLATE"
  if grep -Fq -- "./scripts/check.sh" "$CLOUD_TEMPLATE"; then
    bad "cloud-brief-has-no-full-gate: the template still orders ./scripts/check.sh, which cannot pass on the NAS container"
  fi
  grep -Fq "merge gate" "$CLOUD_TEMPLATE" \
    || bad "cloud-brief-has-no-full-gate: the template never names the merge gate as the full-suite owner"
  grep -Fq 'full `check.sh`' "$CLOUD_TEMPLATE" \
    || bad "cloud-brief-has-no-full-gate: the template never says the merge gate runs the full check.sh"
  grep -Fq "no Go" "$CLOUD_TEMPLATE" \
    || bad "cloud-brief-has-no-full-gate: the template never says the container has no Go toolchain"
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
run claims-block-rule test_claims_block_rule
run no-full-gate-instruction test_no_full_gate_instruction
run cloud-brief-has-no-full-gate test_cloud_brief_has_no_full_gate
run rework-keeps-rules test_rework_keeps_rules
run one-source test_one_source
[ "$RAN" -gt 0 ] || bad "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
