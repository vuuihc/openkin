#!/bin/bash
# Hermetic checks for the 2026-11-15 throughput pass: review tiers, fix lists, dotfile claims, remote overflow, sol-limit parsing.
# No network, no git remote, no model calls. Prints PASS/FAIL per case; non-zero exit on the first failure.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
tier() { printf '%b' "$3" | python3 "$H/review-tier.py" --title "$1" --item "$2" ${4:+--attempts "$4"} --numstat - | cut -d' ' -f1,2; }
[ "$(tier 'refactor(x): extract row' L1 '300\t100\tui/src/a.tsx\n80\t0\tui/src/a.dom.test.tsx\n')" = "small reviewer" ] && ok small-extract || bad small-extract
[ "$(tier 'feat(design): theme' F3 '100\t10\tui/src/x.tsx\n')" = "large reviewer-alt" ] && ok foundation-large || bad foundation-large
[ "$(tier 'refactor: x' T1 '20\t10\tui/src/a.tsx\n' 2)" = "large reviewer-alt" ] && ok rework2-large || bad rework2-large
[ "$(tier 'fix: tiny' G2a '20\t10\tui/src/a.tsx\n')" = "small reviewer" ] && ok tiny-small || bad tiny-small
[ "$(tier 'refactor: x' T1 '300\t10\tui/src/a.tsx\n0\t30\tui/src/a.test.tsx\n')" = "medium reviewer" ] && ok tests-modified-medium || bad tests-modified-medium
[ "$(tier 'feat: deps' X1 '10\t1\tui/package.json\n')" = "large reviewer-alt" ] && ok deps-large || bad deps-large
[ "$(tier 'feat: routes' X1 '50\t1\tui/src/lib/areaRoutes.ts\n')" = "medium reviewer" ] && ok routing-not-small || bad routing-not-small
printf 'Findings:\n1. **major** `ui/src/a.tsx:42` - drops the handler.\n\n2. nit: `ui/src/b.tsx:3` naming.\nFIXLIST:\n- ui/src/a.tsx:42 | major | drops handler | pass it through\nVERDICT: FAIL\n' > "$T/r.txt"
python3 "$H/fixlist.py" "$T/r.txt" | grep -q 'ui/src/a.tsx:42.*pass it through' && ok fixlist-block || bad fixlist-block
printf '1. **major** `ui/src/a.tsx:42` - drops the handler.\n\n2. nit: `ui/src/b.tsx:3` naming.\nVERDICT: FAIL\n' > "$T/r2.txt"
out="$(python3 "$H/fixlist.py" "$T/r2.txt")"; echo "$out" | grep -q 'a.tsx:42' && ! echo "$out" | grep -q 'b.tsx' && ok fixlist-prose-skips-nits || bad fixlist-prose-skips-nits
mkdir -p "$T/st/lanes" "$T/st/cloud"; echo x > "$T/brief.md"
RSI_STATE="$T/st" python3 "$H/lanes.py" claim 1 --slug dot --item X --brief "$T/brief.md" --paths .gitignore ui/src/a.tsx | grep -q "CLAIMED lane 1.*'.gitignore'" && ok dotfile-claim || bad dotfile-claim
# remote overflow: with 3 idle local lanes and ready slices F4,F5a,F5b,F5c,F5e,N3,N4,T2,L2,R2 (F1,V1,F2,F3,N1,Q3a,T1,L1,R1,P1,N2 merged)
mkdir -p "$T/ov/lanes" "$T/ov/cloud/expired"; for i in F1 V1 F2 F3 N1 Q3a T1 L1 R1 P1 N2; do echo "2026-11-15 10:00 PR #1 s-$i $i merged abc u" >> "$T/ov/merged.log"; done
ids="$(RSI_STATE="$T/ov" python3 "$H/slices.py" cloud-pending --json | python3 -c 'import json,sys;print(" ".join(d["id"] for d in json.load(sys.stdin)))')"
[ -n "$ids" ] && ok "cloud-pending lists work ($ids)" || bad cloud-pending-empty
touch "$T/ov/NO_REMOTE_OVERFLOW"; RSI_STATE="$T/ov" python3 "$H/slices.py" cloud-pending --json >/dev/null && ok overflow-switch-parses || bad overflow-switch
echo 'API Error 429 · Codex: The usage limit has been reached (out of its allowance: not asked again before 06:15 UTC+8)' > "$T/log"
sed -n '/^note_sol_limit()/,/^}/p' "$H/dispatch.sh" > "$T/fn.sh"
( LOG="$T/log"; STATE="$T"; . "$T/fn.sh"; note_sol_limit; [ -s "$T/sol-limited-until" ] ) && ok sol-limit-marker || bad sol-limit-marker
echo ALL-PASS
