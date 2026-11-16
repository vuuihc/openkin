#!/bin/bash
# Hermetic checks for the 2026-11-15 strong-review tightening.
# No network, no model calls. Prints PASS/FAIL per case; non-zero exit on the first failure.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
PY="$H/escalate.py"
export RSI_STATE="$T/st" RSI_AGY_ENABLED=0 RSI_CARBON_ENABLED=0 RSI_VOLC_KIMI_DAY_MAX=0 MAGPIE_USAGE_JSONL="$T/empty-usage.jsonl"
: > "$MAGPIE_USAGE_JSONL"
mkdir -p "$T/st/merge" "$T/st/sendback"
check() { RSI_STATE="$T/st" RSI_AGY_ENABLED="${RSI_AGY_ENABLED:-0}" RSI_CARBON_ENABLED="${RSI_CARBON_ENABLED:-0}" RSI_VOLC_KIMI_DAY_MAX="${RSI_VOLC_KIMI_DAY_MAX:-0}" MAGPIE_USAGE_JSONL="$MAGPIE_USAGE_JSONL" python3 "$PY" --check --role "$1" --slug "$2" --item "$3" --sha "${4:-}"; }

# --- self-test ---
python3 "$PY" --self-test >/dev/null && ok self-test || bad self-test

# --- gate-undiagnosed is not a trigger by itself ---
echo 'item: T1
GATE_RESULT=FAIL: typecheck
error TS2322' > "$T/st/sendback/alone.md"
out="$(check reviewer alone T1 abc123)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=$" && echo "$out" | grep -qv "gate-undiagnosed" && ok gate-fail-alone-no-escalate || { echo "$out"; bad gate-fail-alone-no-escalate; }

echo 'item: T1
GATE_RESULT=FAIL: prettier' > "$T/st/sendback/fmt.md"
out="$(check reviewer fmt T1 abc123)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=$" && ok prettier-no-escalate || { echo "$out"; bad prettier-no-escalate; }

# After a real DeepSeek diagnosis says it cannot find the cause, it may escalate (sol is available here).
echo 'DeepSeek-max diagnosis after a real attempt.
DEEPSEEK_DIAGNOSIS: UNDIAGNOSED
could not diagnose the root cause.' > "$T/st/merge/alone.diagnosis.txt"
# sol is not limited in this empty state, kimi may be blocked by live budget — model may be codex or empty+hold if pick fails for other reasons.
# We only require the reason to include gate-undiagnosed (and not to have fired before the diagnosis file existed).
out="$(check reviewer alone T1 abc123)"
echo "$out" | grep -q "gate-undiagnosed" && ok gate-undiagnosed-after-deepseek || { echo "$out"; bad gate-undiagnosed-after-deepseek; }

# --- disagreement: DeepSeek PASS vs substance FAIL, not mechanical, not DeepSeek FAIL ---
rm -f "$T/st/merge/d.deepseek" "$T/st/sendback/d.md"
echo 'item: T1
GATE_RESULT=FAIL: prettier' > "$T/st/sendback/d.md"
RSI_STATE="$T/st" python3 "$PY" --save-deepseek --slug d --sha sha1 --verdict PASS >/dev/null
out="$(check reviewer d T1 sha1)"
echo "$out" | grep -qv "reviewer-disagreement" && ok disagree-not-mechanical || { echo "$out"; bad disagree-not-mechanical; }

echo 'item: T1
GATE_RESULT=FAIL: typecheck' > "$T/st/sendback/d.md"
out="$(check reviewer d T1 sha1)"
echo "$out" | grep -q "reviewer-disagreement" && ok disagree-pass-vs-gate || { echo "$out"; bad disagree-pass-vs-gate; }

RSI_STATE="$T/st" python3 "$PY" --save-deepseek --slug d --sha sha1 --verdict FAIL >/dev/null
out="$(check reviewer d T1 sha1)"
echo "$out" | grep -qv "reviewer-disagreement" && ok disagree-not-when-deepseek-failed || { echo "$out"; bad disagree-not-when-deepseek-failed; }

# --- keep F1 / rework>=2 ---
echo 'item: F1' > "$T/st/sendback/f.md"
echo 2 > "$T/st/merge/f.attempts"
out="$(check reviewer f F1 sha2)"
echo "$out" | grep -q "astryx-foundation-or-shell:F1" && echo "$out" | grep -q "rework-round-2" && ok keep-foundation-and-rework || { echo "$out"; bad keep-foundation-and-rework; }

# --- dedupe: second call for the same SHA reuses, does not pick a new model to run ---
printf 'FIXLIST:\n- a.tsx:1 | major | bug | fix it\nVERDICT: FAIL\n' > "$T/st/body.txt"
RSI_STATE="$T/st" python3 "$PY" --save-strong --slug f --sha sha2 --verdict FAIL --model 'codex/gpt-6.1-sol' --file "$T/st/body.txt" || bad save-strong
out="$(check reviewer f F1 sha2)"
echo "$out" | grep -q "RSI_ESCALATE_REUSE=1" && echo "$out" | grep -q "RSI_ESCALATE_REUSE_VERDICT=FAIL" && ok reuse-same-sha || { echo "$out"; bad reuse-same-sha; }
out2="$(check reviewer f F1 sha3)"
echo "$out2" | grep -q "RSI_ESCALATE_REUSE=0" && echo "$out2" | grep -q "astryx-foundation-or-shell:F1" && ok new-sha-not-reused || { echo "$out2"; bad new-sha-not-reused; }

# --- sol-limited: no model call, hold (not error), once per SHA ---
echo $(( $(date +%s) + 3600 )) > "$T/st/sol-limited-until"
# use a slug with no cache
echo 'item: S1' > "$T/st/sendback/s.md"
out="$(check reviewer-alt s S1 shaS)"
echo "$out" | grep -q "RSI_ESCALATE_HOLD=sol-limited" && echo "$out" | grep -q "RSI_ESCALATE_MODEL=$" && ok sol-limited-hold || { echo "$out"; bad sol-limited-hold; }
RSI_STATE="$T/st" python3 "$PY" --sol-limited >/dev/null && ok sol-limited-cli || bad sol-limited-cli
# jsonl must have hold, not error
python3 - "$T/st/escalations.jsonl" <<'P'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
holds=[r for r in rows if r.get("kind")=="hold" and r.get("slug")=="s"]
errs=[r for r in rows if r.get("outcome")=="error"]
assert holds and holds[0].get("outcome")=="hold", holds
assert not errs, errs
P
ok hold-not-error
# second check does not add another hold line
n1=$(wc -l < "$T/st/escalations.jsonl")
check reviewer-alt s S1 shaS >/dev/null
n2=$(wc -l < "$T/st/escalations.jsonl")
[ "$n1" -eq "$n2" ] && ok hold-deduped || bad hold-deduped

# --- Hydrogen-medium default; high only for F/S/architecture or disagreement; agy-limited -> sol ---
fake="$T/fake-agy"; printf '#!/bin/sh\nexit 0\n' > "$fake"; chmod +x "$fake"
export RSI_AGY_ENABLED=1 RSI_CARBON_ENABLED=1 AGY="$fake"
# clear the sol limit from the previous case
rm -f "$T/st/sol-limited-until"
out="$(check reviewer-alt n T1 shaN)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=hydrogen$" && echo "$out" | grep -q "standing-strong-review" && ok standing-hydrogen-medium || { echo "$out"; bad standing-hydrogen-medium; }
out="$(check reviewer-alt f F1 shaFnew)"
# f still has attempts=2 and item F1 from earlier, but shaFnew is a new sha so no reuse if we use a fresh slug
echo 'item: F3' > "$T/st/sendback/f3.md"
out="$(check reviewer-alt f3 F3 shaF3)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=hydrogen-high" && echo "$out" | grep -q "astryx-foundation-or-shell:F3" && ok foundation-hydrogen-high || { echo "$out"; bad foundation-hydrogen-high; }
echo $(( $(date +%s) + 3600 )) > "$T/st/agy-limited-until"
out="$(check reviewer-alt f3 F3 shaF3)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=codex" && echo "$out" | grep -q "agy-limited" && ok agy-limited-falls-to-sol || { echo "$out"; bad agy-limited-falls-to-sol; }
RSI_STATE="$T/st" python3 "$PY" --agy-limited >/dev/null && ok agy-limited-cli || bad agy-limited-cli
# both limited -> hold
echo $(( $(date +%s) + 3600 )) > "$T/st/sol-limited-until"
RSI_STATE="$T/st" python3 "$PY" --no-strong-available >/dev/null && ok no-strong-available-cli || bad no-strong-available-cli
rm -f "$T/st/agy-limited-until" "$T/st/sol-limited-until"
unset AGY; export RSI_AGY_ENABLED=0 RSI_CARBON_ENABLED=0

# --- weekly daily worth-it line ---
# empty limited marker so weekly does not care
rm -f "$T/st/sol-limited-until"
mkdir -p "$T/st2"
export RSI_STATE="$T/st2"
# one miss (DeepSeek PASS, strong FAIL + B/M) and one agree
python3 - "$PY" "$T/st2" <<'P'
import json,sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
SGT=timezone(timedelta(hours=8))
st=Path(sys.argv[2]); st.mkdir(parents=True, exist_ok=True)
ts=datetime.now(SGT).isoformat()
rows=[
  dict(ts=ts, id="a", role="reviewer-alt", slug="m1", item="T1", model="codex", reason="reviewer-disagreement",
       outcome="FAIL", deepseek_verdict="PASS", has_bm=True, kind=""),
  dict(ts=ts, id="b", role="reviewer-alt", slug="m2", item="F1", model="codex", reason="astryx-foundation-or-shell:F1",
       outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""),
]
(st/"escalations.jsonl").write_text("".join(json.dumps(r,sort_keys=True)+"\n" for r in rows))
P
RSI_STATE="$T/st2" python3 "$PY" --weekly >/dev/null
grep -q "Daily worth-it" "$T/st2/escalations-weekly.md" || bad weekly-heading
grep -q "Found-what-DeepSeek-missed: 1" "$T/st2/escalations-weekly.md" || { cat "$T/st2/escalations-weekly.md"; bad weekly-miss; }
grep -q "Agreed: 1" "$T/st2/escalations-weekly.md" || { cat "$T/st2/escalations-weekly.md"; bad weekly-agreed; }
ok weekly-daily-line

echo ALL-PASS
