#!/bin/bash
# gate-test.sh — checks the UX gate plumbing without any model or PR: slice gate, claim guard, walker on a prebuilt binary, threshold maths.
#   UX_KIN_BIN=/path/to/kin bash rsi/runtime/ux/gate-test.sh      (the binary only serves a throwaway daemon on a free port)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; RT="$(cd "$HERE/.." && pwd)"; RSI="$(cd "$RT/.." && pwd)"; WT="$(cd "$RSI/.." && pwd)"
fail=0; ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; fail=1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; mkdir -p "$T/st"
# 1 slice gate
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok S1 && bad "S1 open without APPROVED" || ok "S1 gated without APPROVED"
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok F1 && ok "ungated slice F1 open" || bad "F1 wrongly gated"
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok NOT-A-SLICE && ok "unknown item never gated" || bad "unknown item gated"
echo "# brief" > "$T/brief.md"
RSI_STATE="$T/st" python3 "$RT/lanes.py" claim 1 --slug t --item S2 --brief "$T/brief.md" --paths ui/src/components/layout/PhoneFooter.tsx >"$T/claim.out" 2>&1; [ $? -eq 7 ] && ok "lanes.py refuses to claim S2 before APPROVED" || bad "claim S2 not refused: $(cat "$T/claim.out")"
mkdir -p "$T/st/ux-proto"; touch "$T/st/ux-proto/APPROVED"
RSI_STATE="$T/st" python3 "$RT/slices.py" gate-ok S1 && ok "S1 open after APPROVED" || bad "S1 still gated after APPROVED"
# 2 threshold maths (ux-gate.sh decision block, fed by a stub reviewer; walker needs UX_KIN_BIN + chrome)
if [ -n "${UX_KIN_BIN:-}" ]; then
  for case in "PASS 4 4 4 4 3 0" "mean 3 3 3 3 4 1" "axis 5 5 5 2 5 1" "noscore x x x x x 1"; do
    set -- $case; name=$1
    if [ "$name" = noscore ]; then STUB='echo "looks fine"; echo "UX_VERDICT: PASS"'; else STUB="echo findings; echo 'UX_SCORES: clarity=$2 density=$3 consistency=$4 feedback=$5 keyboard=$6'; echo 'UX_VERDICT: PASS'"; fi
    RSI_UX_REVIEW_CMD="$STUB" bash "$RT/ux-gate.sh" "$WT" "gate-test-$name" "TEST" 0 "deadbeef" >/dev/null 2>&1; rc=$?
    want=${@: -1}; [ $rc -eq "$want" ] && ok "ux-gate $name -> exit $rc" || bad "ux-gate $name exit $rc, want $want"
  done
  python3 - "$RSI/state/ux/gate-test-mean/scores.json" <<'PY' && ok "scores.json recorded" || bad "scores.json missing"
import json, sys; d = json.load(open(sys.argv[1])); assert d["pass"] is False and d["mean"] == 3.2 and any("mean" in r for r in d["reasons"])
PY
  rm -rf "$RSI"/state/ux/gate-test-* "$RSI"/state/shots/gate-test-* "$RSI"/state/merge/gate-test-* "$RSI"/state/briefs/gate-test-*
else echo "skip ux-gate walk cases (set UX_KIN_BIN)"; fi
exit $fail
