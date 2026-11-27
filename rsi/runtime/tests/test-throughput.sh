#!/bin/bash
# Hermetic checks for the 2026-11-15 throughput pass: review tiers, fix lists, dotfile claims, remote overflow, sol-limit parsing.
# No network, no git remote, no model calls. Prints PASS/FAIL per case; non-zero exit on the first failure.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
# Path-claim cases test path validation only, never the host-pressure guard (including the
# spare-lane gate, which fires there because dotfile-claim already holds lane 1): a loaded
# machine must not turn them into exit-8 refusals.
NOPRESS="RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 RSI_LOAD_MAX=9999 RSI_LANE2_MEM_MIN_MB=0 RSI_LANE2_PRESSURE_MAX=99 RSI_LANE2_SWAP_FREE_MIN_MB=0"
tier() { printf '%b' "$3" | python3 "$H/review-tier.py" --title "$1" --item "$2" ${4:+--attempts "$4"} --worker-model worker-x --review-model reviewer-y --numstat - | cut -d' ' -f1,2; }
# Reviewer independence (2026-11-28, MANDATE 2). merge.sh:2487 calls review-tier.py with no model
# flags on every small/medium PR, and common.sh:47-48 has M_WORKER == M_DIRECTOR — so the cost
# tier's `reviewer` was the worker's own DeepSeek model. These cases pin the role answer that stops
# it (the manual workaround was a state/merge/<slug>.force-alt marker per PR). They run before the
# legacy cases and accumulate, because a red run reverts review-tier.py to origin/main, which
# rejects the model flags: every broken expectation must print its own FAIL name.
mrc=0
mcheck() { # <name> <want "tier role"> <want token|-> <numstat> [flags...]
  local name="$1" want="$2" token="$3" numstat="$4" got fields; shift 4
  got="$(printf '%b' "$numstat" | python3 "$H/review-tier.py" --title 'fix: tiny' --numstat - "$@" | tr '\n' ' ')"
  fields="$(echo "$got" | cut -d' ' -f1,2)"
  if [ "$fields" != "$want" ]; then echo "FAIL $name: want '$want', got '$fields' ($got)" >&2; mrc=1; return; fi
  if [ "$token" != - ] && ! echo "$got" | grep -q "$token"; then echo "FAIL $name: missing '$token' in '$got'" >&2; mrc=1; return; fi
  ok "$name"
}
SMALL_DIFF='20\t10\tui/src/a.tsx\n'
LARGE_DIFF='900\t0\tui/src/a.tsx\n'
mcheck worker-model-equals-reviewer-forces-alt 'small reviewer-alt' worker-model "$SMALL_DIFF" --worker-model m1 --review-model m1
mcheck worker-model-differs-keeps-deepseek 'small reviewer' - "$SMALL_DIFF" --worker-model m1 --review-model m2
mcheck strong-worker-keeps-deepseek-review 'small reviewer' - "$SMALL_DIFF" --worker-model codex/gpt-6.1-sol --review-model 'volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
mcheck strong-worker-equal-strong-review-keeps-deepseek 'small reviewer' - "$SMALL_DIFF" --worker-model codex/gpt-6.1-sol --review-model codex/gpt-6.1-sol
mcheck large-tier-is-never-downgraded 'large reviewer-alt' - "$LARGE_DIFF" --worker-model m1 --review-model m1
# The production call: no flags and no model env, exactly as merge.sh:2487 invokes it. This repo's
# common.sh has M_WORKER == M_DIRECTOR, so the answer must already be reviewer-alt. If this passes
# because a flag or env leaked in, it is not the proof.
prodl="$(printf '%b' "$SMALL_DIFF" | env -u RSI_WORKER_MODEL -u RSI_REVIEW_MODEL python3 "$H/review-tier.py" --title 'fix: tiny' --numstat -)"
if [ "$(echo "$prodl" | cut -d' ' -f1,2)" = 'small reviewer-alt' ] && echo "$prodl" | grep -q worker-model; then
  ok production-call-reads-the-model-table
else
  echo "FAIL production-call-reads-the-model-table: want 'small reviewer-alt' with worker-model, got '$prodl'" >&2; mrc=1
fi
[ "$mrc" -eq 0 ] || exit 1
[ "$(tier 'refactor(x): extract row' L1 '300\t100\tui/src/a.tsx\n80\t0\tui/src/a.dom.test.tsx\n')" = "small reviewer" ] && ok small-extract || bad small-extract
[ "$(tier 'feat(design): theme' F3 '100\t10\tui/src/x.tsx\n')" = "large reviewer-alt" ] && ok foundation-large || bad foundation-large
[ "$(tier 'refactor: x' T1 '20\t10\tui/src/a.tsx\n' 2)" = "large reviewer-alt" ] && ok rework2-large || bad rework2-large
[ "$(tier 'fix: tiny' G2a '20\t10\tui/src/a.tsx\n')" = "small reviewer" ] && ok tiny-small || bad tiny-small
[ "$(tier 'refactor: x' T1 '300\t10\tui/src/a.tsx\n0\t30\tui/src/a.test.tsx\n')" = "medium reviewer" ] && ok tests-modified-medium || bad tests-modified-medium
[ "$(tier 'feat: deps' X1 '10\t1\tui/package.json\n')" = "large reviewer-alt" ] && ok deps-large || bad deps-large
[ "$(tier 'feat: routes' X1 '50\t1\tui/src/lib/areaRoutes.ts\n')" = "medium reviewer" ] && ok routing-not-small || bad routing-not-small
# A story's design artifacts and any long prose are docs: no runtime surface, so length is not a risk
# signal. #629 (6 Figma frames + 1 review page, 1346 lines) read as `large` and spent the only big merge
# slot 51 minutes across two gates (2026-11-23 14:51-15:09, gate log gate-merge-agents-detect-page-145119).
# These four accumulate their failures instead of exiting on the first one, so a revert of one rule still
# names every case it breaks (red-first reads the failing case's name).
docrc=0
case_tier() { # <name> <want> <title> <item> <numstat> — print PASS/FAIL for one tier expectation
  local got; got="$(tier "$3" "$4" "$5")"
  if [ "$got" = "$2" ]; then ok "$1"; else echo "FAIL $1: want '$2', got '$got'" >&2; docrc=1; fi
}
case_tier docs-artifact-small 'small reviewer' 'docs(stories): draw the KIN-AGENTS-002 review page' '' '696\t0\tdocs/product/stories/KIN-AGENTS-002.review.html\n127\t0\tdocs/product/stories/KIN-AGENTS-002.figma/frames/01-mac-default.svg\n'
case_tier long-docs-small 'small reviewer' 'docs(adr): long decision record' '' '900\t0\tdocs/adr/2026-11-23-long.md\n'
# The exemption is docs-only: a mixed diff and a big non-docs .html still pay the size rule.
case_tier mixed-docs-large 'large reviewer-alt' 'docs+code: long prose beside a control' '' '900\t0\tdocs/product/IA.md\n10\t0\tui/src/a.tsx\n'
case_tier non-docs-html-large 'large reviewer-alt' 'feat: big standalone page' X1 '900\t0\tprototype/window.html\n'
[ "$docrc" -eq 0 ] || exit 1
printf 'Findings:\n1. **major** `ui/src/a.tsx:42` - drops the handler.\n\n2. nit: `ui/src/b.tsx:3` naming.\nFIXLIST:\n- ui/src/a.tsx:42 | major | drops handler | pass it through\nVERDICT: FAIL\n' > "$T/r.txt"
python3 "$H/fixlist.py" "$T/r.txt" | grep -q 'ui/src/a.tsx:42.*pass it through' && ok fixlist-block || bad fixlist-block
printf '1. **major** `ui/src/a.tsx:42` - drops the handler.\n\n2. nit: `ui/src/b.tsx:3` naming.\nVERDICT: FAIL\n' > "$T/r2.txt"
out="$(python3 "$H/fixlist.py" "$T/r2.txt")"; echo "$out" | grep -q 'a.tsx:42' && ! echo "$out" | grep -q 'b.tsx' && ok fixlist-prose-skips-nits || bad fixlist-prose-skips-nits
mkdir -p "$T/st/lanes" "$T/st/cloud"; echo x > "$T/brief.md"
RSI_STATE="$T/st" env $NOPRESS python3 "$H/lanes.py" claim 1 --slug dot --item X --brief "$T/brief.md" --paths .gitignore ui/src/a.tsx | grep -q "CLAIMED lane 1.*'.gitignore'" && ok dotfile-claim || bad dotfile-claim
# remote overflow: with 3 idle local lanes and ready slices F4,F5a,F5b,F5c,F5e,N3,N4,T2,L2,R2 (F1,V1,F2,F3,N1,Q3a,T1,L1,R1,P1,N2 merged)
mkdir -p "$T/ov/lanes" "$T/ov/cloud/expired"; for i in F1 V1 F2 F3 N1 Q3a T1 L1 R1 P1 N2; do echo "2026-11-15 10:00 PR #1 s-$i $i merged abc u" >> "$T/ov/merged.log"; done
ids="$(RSI_STATE="$T/ov" python3 "$H/slices.py" cloud-pending --json | python3 -c 'import json,sys;print(" ".join(d["id"] for d in json.load(sys.stdin)))')"
[ -n "$ids" ] && ok "cloud-pending lists work ($ids)" || bad cloud-pending-empty
touch "$T/ov/NO_REMOTE_OVERFLOW"; RSI_STATE="$T/ov" python3 "$H/slices.py" cloud-pending --json >/dev/null && ok overflow-switch-parses || bad overflow-switch
echo 'API Error 429 · Codex: The usage limit has been reached (out of its allowance: not asked again before 06:15 UTC+8)' > "$T/log"
sed -n '/^note_sol_limit()/,/^}/p' "$H/dispatch.sh" > "$T/fn.sh"
( LOG="$T/log"; STATE="$T"; . "$T/fn.sh"; note_sol_limit; [ -s "$T/sol-limited-until" ] ) && ok sol-limit-marker || bad sol-limit-marker
# run_claude appends stream-json to $LOG; usable_result/emit_and_exit read $LOG.txt,
# so a claude run must extract its text there for kimi / codex fallbacks.
cat > "$T/fake-claude" <<'EOF'
#!/bin/bash
echo '{"type":"result","result":"VERDICT: PASS","is_error":false}'
EOF
chmod +x "$T/fake-claude"
sed -n '/^run_claude()/,/^}/p' "$H/dispatch.sh" > "$T/run-claude.sh"
( LOG="$T/run"; TOOLS=(Read); PROMPT=x; CWD="$T"; WT_ROOT="$T"; RSI_CTRL="$T"; BUDGET_GUARD=1
  CLAUDE="$T/fake-claude"; DISPATCH_MAX_SECS=20; RSI_DIR="$(dirname "$H")"
  rsi_kill_tree() { :; }
  . "$T/run-claude.sh"
  run_claude test-model "" && grep -q 'VERDICT: PASS' "$LOG.txt" ) && ok dispatch-log-text || bad dispatch-log-text
# A failed candidate must not leave stale text for usable_result.
sed -n '/^run_named()/,/^}/p' "$H/dispatch.sh" > "$T/run-named.sh"
( LOG="$T/stale"; echo 'VERDICT: PASS' > "$LOG.txt"; M_KIMI=x; M_DIRECTOR_EFFORT=
  use_name() { :; }; record_model() { :; }; run_claude() { return 1; }
  . "$T/run-named.sh"
  run_named kimi; [ ! -s "$LOG.txt" ] ) && ok dispatch-clear-stale || bad dispatch-clear-stale
# ci_state must ask for `link`, or fetch_ci_failed_log cannot find the run id and
# the CI outside-tests path never runs.
mkdir -p "$T/merge"
cat > "$T/fake-gh" <<'EOF'
#!/bin/bash
fields=""; args=("$@")
for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = "--json" ] && fields="${args[$((i+1))]}"; done
case "${args[0]}" in
  pr) case "$fields" in *link*) ;; *) echo "pr checks --json missing link: $fields" >&2; exit 1;; esac
      echo '[{"name":"build","bucket":"pass","link":"https://github.com/o/r/actions/runs/4242/job/7"}]';;
  run) echo "failed-job log";;
esac
EOF
chmod +x "$T/fake-gh"
sed -n '/^check_buckets()/,/^}/p;/^ci_state()/,/^}/p;/^fetch_ci_failed_log()/,/^}/p' "$H/merge.sh" > "$T/ci-fns.sh"
( GH="$T/fake-gh"; GH_REPO=o/r; N=7; SLUG=ci; STATE="$T"; say() { :; }; sleep() { :; }; with_timeout() { shift; "$@"; }
  . "$T/ci-fns.sh"
  [ "$(ci_state)" = green ] || exit 1
  grep -q 'actions/runs/4242' "$T/merge/ci.ci.txt" || exit 1
  fetch_ci_failed_log "$T/merge/ci-log.txt" || exit 1
  grep -q 'failed-job log' "$T/merge/ci-log.txt" ) && ok ci-link || bad ci-link
# host-pressure guard (2026-11-16): memory pressure refuses NEW claims (exit 8) but admits a targeted
# rework, and idle is gated unless the rework dispatcher explicitly asks with --ignore-pressure.
PRESSURE="RSI_MEM_AVAIL_MIN_MB=999999999 RSI_LOAD_MAX=9999"   # force the avail-mem reason, not a load one
mkdir -p "$T/pr/lanes" "$T/pr/cloud"
RSI_STATE="$T/pr" env $PRESSURE python3 "$H/lanes.py" claim 1 --slug pnew --item PX1 --brief "$T/brief.md" --paths ui/src/a.tsx >/dev/null 2>&1; [ $? -eq 8 ] && ok pressure-refuses-new || bad pressure-refuses-new
RSI_STATE="$T/pr" env $PRESSURE python3 "$H/lanes.py" claim 1 --slug prew --item PX1 --brief "$T/brief.md" --mode rework --paths ui/src/a.tsx 2>/dev/null | grep -q "CLAIMED lane 1" && ok pressure-admits-rework || bad pressure-admits-rework
[ -z "$(RSI_STATE="$T/pr" env $PRESSURE python3 "$H/lanes.py" idle 2>/dev/null)" ] && ok pressure-gates-idle || bad pressure-gates-idle
[ -n "$(RSI_STATE="$T/pr" env $PRESSURE python3 "$H/lanes.py" idle --ignore-pressure 2>/dev/null)" ] && ok pressure-ignore-idle || bad pressure-ignore-idle
# spare-lane gate (2026-11-18, Ethan: the Mac's memory is the constraint). While one local worker
# is active, the SECOND one starts only with headroom; a rework may still take the free slot.
SPARE="RSI_MAX_LANES=2 RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 RSI_LANE2_MEM_MIN_MB=999999999 RSI_LOAD_MAX=9999"
LOOSE="RSI_MAX_LANES=2 RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 RSI_LANE2_MEM_MIN_MB=0 RSI_LANE2_PRESSURE_MAX=99 RSI_LANE2_SWAP_FREE_MIN_MB=0 RSI_LOAD_MAX=9999"
busy_lane() { mkdir -p "$1/lanes" "$1/cloud"
  printf '{"lane":1,"slug":"busy","item":"SP1","brief":"%s","mode":"new","paths":["ui/src/a.tsx"],"status":"running","pid":%s,"claimed_at":%s}\n' \
    "$T/brief.md" "$$" "$(date +%s)" > "$1/lanes/1.json"; }
busy_lane "$T/sp1"; busy_lane "$T/sp2"; busy_lane "$T/sp3"
[ -z "$(RSI_STATE="$T/sp1" env $SPARE python3 "$H/lanes.py" idle 2>/dev/null)" ] && ok spare-gates-second-idle || bad spare-gates-second-idle
[ "$(RSI_STATE="$T/sp1" env $LOOSE python3 "$H/lanes.py" idle 2>/dev/null)" = "2" ] && ok spare-idle-with-headroom || bad spare-idle-with-headroom
RSI_STATE="$T/sp2" env $SPARE python3 "$H/lanes.py" claim 2 --slug pspare --item PS2 --brief "$T/brief.md" --paths ui/src/b.tsx >/dev/null 2>&1; [ $? -eq 8 ] && ok spare-refuses-second-claim || bad spare-refuses-second-claim
RSI_STATE="$T/sp2" env $LOOSE python3 "$H/lanes.py" claim 2 --slug pspare --item PS2 --brief "$T/brief.md" --paths ui/src/b.tsx 2>/dev/null | grep -q "CLAIMED lane 2" && ok spare-admits-with-headroom || bad spare-admits-with-headroom
RSI_STATE="$T/sp3" env $SPARE python3 "$H/lanes.py" claim 2 --slug prew --item PS2 --brief "$T/brief.md" --mode rework --paths ui/src/b.tsx 2>/dev/null | grep -q "CLAIMED lane 2" && ok spare-admits-rework || bad spare-admits-rework
# a cold start under the spare floor still gets the first worker: the gate is about the SECOND
# worker, and since 2026-11-20 `idle` must not licence a lane the claim gate would refuse.
mkdir -p "$T/sp4/lanes" "$T/sp4/cloud"
[ "$(RSI_STATE="$T/sp4" env $SPARE python3 "$H/lanes.py" idle 2>/dev/null | tr '\n' ' ')" = "1 " ] && ok spare-first-worker-unaffected || bad spare-first-worker-unaffected
# root-file claim (e.g. Makefile) must succeed, while broad dir 'ui' is refused
RSI_STATE="$T/st" env $NOPRESS python3 "$H/lanes.py" claim 2 --slug mk --item X2 --brief "$T/brief.md" --paths Makefile | grep -q "CLAIMED lane 2" && ok root-file-claim || bad root-file-claim
! RSI_STATE="$T/st" env $NOPRESS python3 "$H/lanes.py" claim 2 --slug bad --item X3 --brief "$T/brief.md" --paths ui >/dev/null 2>&1 && ok broad-dir-refused || bad broad-dir-refused
echo ALL-PASS
