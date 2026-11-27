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

# --- no shipped loop settings file may resolve a model to Kimi (ROUTING.md, CEO 2026-11-17) ------
# Each host hands a Claude Code run an "opus" pin: the Mac (runtime/common.sh), the box lane
# (runtime/box/box-side/claude-env.sh) and the NAS (runtime/nas/compose/claude-settings.json in the
# container, runtime/nas/nas-side/claude-env.sh sourced by nas-lane.sh, and
# runtime/nas/nas-side/claude-settings.json copied over $HOME/.claude/settings.json by
# nas-lane.sh). ROUTING.md says all of them resolve to DeepSeek; Kimi is the advisor, called with an
# explicit `--model magpie/auto/kimi-k3.1-pro` flag, never inherited from settings. The NAS files
# drifted to kimi-k3.1-pro and no test noticed (found 2026-11-21), so the pins and both files'
# env/modelOverrides are compared here: a value that names Kimi, a host that disagrees with the
# others, or a missing pin all go red.
opush_pin_guard() { python3 - "$H" <<'PY'
import json, re, sys
h = sys.argv[1]

NAS = ("nas/compose/claude-settings.json", "nas/nas-side/claude-settings.json")

def from_sh(path):
    m = re.search(r"ANTHROPIC_DEFAULT_OPUS_MODEL='([^']+)'", open(path).read())
    return m.group(1) if m else None

def from_json(rel):
    return json.load(open(f"{h}/{rel}")).get("env", {}).get("ANTHROPIC_DEFAULT_OPUS_MODEL")

pins = {
    "runtime/common.sh": from_sh(f"{h}/common.sh"),
    "runtime/nas/compose/claude-settings.json": from_json(NAS[0]),
    "runtime/nas/nas-side/claude-settings.json": from_json(NAS[1]),
    "runtime/nas/nas-side/claude-env.sh": from_sh(f"{h}/nas/nas-side/claude-env.sh"),
    "runtime/box/box-side/claude-env.sh": from_sh(f"{h}/box/box-side/claude-env.sh"),
}
problems = []
for path, value in pins.items():
    if not value:
        problems.append(f"{path}: no ANTHROPIC_DEFAULT_OPUS_MODEL pin")
    elif "kimi" in value.lower():
        problems.append(f"{path}: resolves opus to {value!r}; ROUTING.md keeps Kimi for the advisor only")
if len({v for v in pins.values() if v}) > 1:
    problems.append("the hosts disagree: " + ", ".join(f"{p} -> {v!r}" for p, v in pins.items()))

for rel in NAS:
    doc = json.load(open(f"{h}/{rel}"))
    for key, value in doc.get("env", {}).items():
        if key.endswith("MODEL") and "kimi" in str(value).lower():
            problems.append(f"runtime/{rel}: {key} resolves to {value!r}")
    for key, value in doc.get("modelOverrides", {}).items():
        if "kimi" in str(value).lower():
            problems.append(f"runtime/{rel}: modelOverrides {key} resolves to {value!r}")

if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
PY
}
opush_pin_guard && ok opus-pin-is-deepseek-everywhere || bad opus-pin-is-deepseek-everywhere

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

# --- Codex first for the ordinary standing review; Hydrogen first for UX and the high class ---
# CEO 2026-11-28: the standing strong review starts on Codex while its allowance is available.
# Hydrogen-medium stays first for UX vision (multimodal) and for the high-stakes class, which
# also keeps a reviewer-disagreement second pass off the model that gave the first opinion.
fake="$T/fake-agy"; printf '#!/bin/sh\nexit 0\n' > "$fake"; chmod +x "$fake"
export RSI_AGY_ENABLED=1 RSI_CARBON_ENABLED=1 AGY="$fake"
# clear the sol limit from the previous case
rm -f "$T/st/sol-limited-until"
out="$(check reviewer-alt n T1 shaN)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=codex$" && echo "$out" | grep -q "standing-strong-review" && echo "$out" | grep -q "RSI_ESCALATE_FALLBACK=hydrogen" && ok standing-codex-first || { echo "$out"; bad standing-codex-first; }

# Codex unavailable (its allowance marker is set) falls back to Hydrogen-medium, not a hold.
echo $(( $(date +%s) + 3600 )) > "$T/st/sol-limited-until"
out="$(check reviewer-alt n2 T1 shaN2)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=hydrogen$" && echo "$out" | grep -q "standing-strong-review" && echo "$out" | grep -q "sol-limited" && ok standing-hydrogen-when-sol-limited || { echo "$out"; bad standing-hydrogen-when-sol-limited; }
rm -f "$T/st/sol-limited-until"

# UX vision reviews are unchanged: Hydrogen is the multimodal route the UX gate is built on.
out="$(check ux-reviewer-alt ux1 T1 shaUX)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=hydrogen$" && echo "$out" | grep -q "standing-strong-review" && ok ux-vision-stays-hydrogen-first || { echo "$out"; bad ux-vision-stays-hydrogen-first; }

# A second pass after a reviewer disagreement stays on hydrogen-high: now that the ordinary route
# is Codex, re-running it would make the second opinion the same model as the first.
RSI_STATE="$T/st" python3 "$PY" --save-deepseek --slug d --sha sha1 --verdict PASS >/dev/null
out="$(check reviewer-alt d T1 sha1)"
echo "$out" | grep -q "RSI_ESCALATE_MODEL=hydrogen-high" && echo "$out" | grep -q "reviewer-disagreement" && ok disagreement-second-pass-not-codex || { echo "$out"; bad disagreement-second-pass-not-codex; }
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

# --- weekly worth-it: caught per decided review and per yuan, priced by window ---
# Three 1M-input Kimi rows at ¥13 each: one inside A's window, one inside B's, one one
# hour after every outcome (must be excluded). C is decided with no spend -> flat-rate.
mkdir -p "$T/w1"
python3 - "$T/w1" "$T/w1-usage.jsonl" <<'P'
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
SGT = timezone(timedelta(hours=8))
st = Path(sys.argv[1]); ledger = Path(sys.argv[2]); st.mkdir(parents=True, exist_ok=True)
now = datetime.now(SGT)
ws = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
def iso(h): return (ws + timedelta(hours=h)).isoformat()
def row(h):
    return dict(t=iso(h), provider="volcengine-gw", host="example.apigateway-cn-beijing.volceapi.com",
                model="kimi-k3.1-pro", **{"in": 1_000_000}, out=0, cache_read=0)
rows = [
    dict(ts=iso(1), outcome_ts=iso(2), id="a", model="kimi", reason="reviewer-disagreement",
         outcome="FAIL", deepseek_verdict="PASS", has_bm=True, kind=""),
    dict(ts=iso(3), outcome_ts=iso(4), id="b", model="kimi", reason="reviewer-disagreement",
         outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""),
    dict(ts=iso(5), outcome_ts=iso(6), id="c", model="kimi", reason="reviewer-disagreement",
         outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""),
]
(st / "escalations.jsonl").write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
(ledger).write_text("".join(json.dumps(r) + "\n" for r in (row(1.5), row(3.5), row(8.0))))
P
RSI_STATE="$T/w1" MAGPIE_USAGE_JSONL="$T/w1-usage.jsonl" python3 "$PY" --weekly >/dev/null || bad weekly-worth-it-rate-exit
md="$T/w1/escalations-weekly.md"
grep -q 'caught 1 of 3 decided reviews (33%)' "$md" || { cat "$md"; bad weekly-worth-it-rate; }
grep -q 'spend ¥26.00' "$md" || { cat "$md"; bad weekly-worth-it-spend; }
grep -q '¥26.00 per caught defect' "$md" || { cat "$md"; bad weekly-worth-it-per-defect; }
grep -q 'flat-rate 1' "$md" || { cat "$md"; bad weekly-worth-it-flat; }
grep -q 'unmeasured 0' "$md" || { cat "$md"; bad weekly-worth-it-unmeasured; }
grep -q 'Spend is window-priced from the local usage ledger' "$md" || { cat "$md"; bad weekly-worth-it-note; }
# Placement is part of the contract: after the Daily worth-it block, before its closing note.
python3 - "$md" <<'P' || bad weekly-worth-it-placement
import sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
daily = next(i for i, l in enumerate(lines) if l.startswith("## Daily worth-it"))
worth = next(i for i, l in enumerate(lines) if l.startswith("Worth it:"))
close = next(i for i, l in enumerate(lines) if l.startswith("Found-what-DeepSeek-missed is"))
assert daily < worth < close, (daily, worth, close)
assert sum(1 for l in lines if l.startswith("Worth it:")) == 1
P
ok weekly-worth-it-rate

# --- weekly worth-it: none caught names n/a instead of dividing by zero ---
mkdir -p "$T/w2"
python3 - "$T/w2" "$T/w2-usage.jsonl" <<'P'
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
SGT = timezone(timedelta(hours=8))
st = Path(sys.argv[1]); ledger = Path(sys.argv[2]); st.mkdir(parents=True, exist_ok=True)
now = datetime.now(SGT)
ws = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
def iso(h): return (ws + timedelta(hours=h)).isoformat()
rows = [
    dict(ts=iso(1), outcome_ts=iso(2), id="a", model="kimi", reason="reviewer-disagreement",
         outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""),
    dict(ts=iso(3), outcome_ts=iso(4), id="b", model="kimi", reason="reviewer-disagreement",
         outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""),
]
(st / "escalations.jsonl").write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
ledger.write_text(json.dumps(dict(t=iso(1.5), provider="volcengine-gw", host="example.apigateway-cn-beijing.volceapi.com",
                                  model="kimi-k3.1-pro", **{"in": 1_000_000}, out=0, cache_read=0)) + "\n")
P
RSI_STATE="$T/w2" MAGPIE_USAGE_JSONL="$T/w2-usage.jsonl" python3 "$PY" --weekly >/dev/null || bad weekly-worth-it-none-exit
md="$T/w2/escalations-weekly.md"
grep -q 'caught 0 of 2 decided reviews (0%)' "$md" || { cat "$md"; bad weekly-worth-it-none-caught; }
grep -q 'spend ¥13.00' "$md" || { cat "$md"; bad weekly-worth-it-none-spend; }
grep -q 'per caught defect: n/a (none caught)' "$md" || { cat "$md"; bad weekly-worth-it-none-n; }
grep -q 'flat-rate 1' "$md" || { cat "$md"; bad weekly-worth-it-none-flat; }
ok weekly-worth-it-none-caught

# --- weekly worth-it: a missing ledger says unmeasured, never ¥0.00 ---
mkdir -p "$T/w3"
python3 - "$T/w3" <<'P'
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
SGT = timezone(timedelta(hours=8))
st = Path(sys.argv[1]); st.mkdir(parents=True, exist_ok=True)
now = datetime.now(SGT)
ws = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
iso = lambda h: (ws + timedelta(hours=h)).isoformat()
(st / "escalations.jsonl").write_text(json.dumps(dict(
    ts=iso(1), outcome_ts=iso(2), id="a", model="kimi", reason="reviewer-disagreement",
    outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""), sort_keys=True) + "\n")
P
RSI_STATE="$T/w3" MAGPIE_USAGE_JSONL="$T/no-such-usage.jsonl" python3 "$PY" --weekly >/dev/null || bad weekly-worth-it-unmeasured-exit
md="$T/w3/escalations-weekly.md"
grep -q 'spend unmeasured' "$md" || { cat "$md"; bad weekly-worth-it-unmeasured; }
grep -q 'per caught defect: n/a (spend unmeasured)' "$md" || { cat "$md"; bad weekly-worth-it-unmeasured-per; }
grep -q 'Daily worth-it' "$md" || { cat "$md"; bad weekly-worth-it-unmeasured-daily; }
grep -q '¥0.00' "$md" && { cat "$md"; bad weekly-worth-it-unmeasured-zero; }
ok weekly-worth-it-unmeasured

# --- weekly worth-it: no outcome_ts is unmeasured, not decided and not ¥0 ---
mkdir -p "$T/w4"
python3 - "$T/w4" "$T/w4-usage.jsonl" <<'P'
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
SGT = timezone(timedelta(hours=8))
st = Path(sys.argv[1]); ledger = Path(sys.argv[2]); st.mkdir(parents=True, exist_ok=True)
now = datetime.now(SGT)
ws = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
iso = lambda h: (ws + timedelta(hours=h)).isoformat()
rows = [
    dict(ts=iso(1), outcome_ts=iso(2), id="a", model="kimi", reason="reviewer-disagreement",
         outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""),
    # A strong FAIL with B/M after DeepSeek PASS, but no outcome_ts: the window is unknown,
    # so it can neither be priced nor counted as a decided review.
    dict(ts=iso(3), id="b", model="kimi", reason="reviewer-disagreement",
         outcome="FAIL", deepseek_verdict="PASS", has_bm=True, kind=""),
]
(st / "escalations.jsonl").write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
ledger.write_text("")
P
RSI_STATE="$T/w4" MAGPIE_USAGE_JSONL="$T/w4-usage.jsonl" python3 "$PY" --weekly >/dev/null || bad weekly-worth-it-undecided-exit
md="$T/w4/escalations-weekly.md"
grep -q 'caught 0 of 1 decided reviews (0%)' "$md" || { cat "$md"; bad weekly-worth-it-undecided; }
grep -q 'unmeasured 1' "$md" || { cat "$md"; bad weekly-worth-it-undecided-count; }
grep -q 'flat-rate 1' "$md" || { cat "$md"; bad weekly-worth-it-undecided-flat; }
ok weekly-worth-it-undecided

# --- note_agy_limit ignores success prose containing "quota" and stamps real quota errors ---
mkdir -p "$T/agy_st"
(
  STATE="$T/agy_st"
  eval "$(sed -n '/^note_agy_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/agy_ok"
  : > "$LOG"
  echo '{"status":"SUCCESS","response":"populated usage tiles and quota-wait indicators\nUX_VERDICT: PASS"}' > "$LOG.agy.json"
  note_agy_limit
  [ ! -e "$STATE/agy-limited-until" ] || exit 1
) && ok agy-limit-ignores-success-prose || bad agy-limit-ignores-success-prose

(
  STATE="$T/agy_st"
  eval "$(sed -n '/^note_agy_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/agy_err"
  : > "$LOG"
  echo '{"status":"ERROR","error":"RESOURCE_EXHAUSTED: exceeded your current quota"}' > "$LOG.agy.json"
  note_agy_limit
  [ -s "$STATE/agy-limited-until" ] && [ "$(cat "$STATE/agy-limited-until")" -gt "$(date +%s)" ] || exit 1
) && ok agy-limit-stamps-real-quota-error || bad agy-limit-stamps-real-quota-error

# Prose-free error field: the vendor CLI reports a bare "quota" with no long phrase to match.
mkdir -p "$T/agy_st3"
(
  STATE="$T/agy_st3"
  eval "$(sed -n '/^note_agy_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/agy_bare"
  : > "$LOG"
  echo '{"status":"ERROR","error":"quota"}' > "$LOG.agy.json"
  [ ! -e "$STATE/agy-limited-until" ] || exit 1
  note_agy_limit
  [ -s "$STATE/agy-limited-until" ] && [ "$(cat "$STATE/agy-limited-until")" -gt "$(date +%s)" ] || exit 1
) && ok agy-limit-stamps-bare-quota-error || bad agy-limit-stamps-bare-quota-error

# A stale clock (a Mon DD already in the past) must not roll a full year into a loop-wide hold.
mkdir -p "$T/agy_st4"
(
  STATE="$T/agy_st4"
  eval "$(sed -n '/^note_agy_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/agy_stale"
  : > "$LOG"
  past="$(python3 - <<'PY'
import datetime
tz = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(tz)
t = now - datetime.timedelta(days=1)
months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
print("" if t.year != now.year else f"{months[t.month]} {t.day} {t.hour:02d}:{t.minute:02d}")
PY
)"
  [ -z "$past" ] && exit 0   # Jan 1: yesterday belongs to last year, not expressible as a same-year clock
  echo "{\"status\":\"ERROR\",\"error\":\"RESOURCE_EXHAUSTED: exceeded your current quota; not asked again before $past UTC+8\"}" > "$LOG.agy.json"
  note_agy_limit
  # Either no stamp at all, or one that stays well inside the next two days — never ~1 year out.
  [ ! -s "$STATE/agy-limited-until" ] || [ "$(cat "$STATE/agy-limited-until")" -lt "$(( $(date +%s) + 172800 ))" ] || exit 1
) && ok agy-limit-ignores-stale-clock || bad agy-limit-ignores-stale-clock

# --- note_sol_limit handles both HH:MM and Mon DD HH:MM UTC+8 ---
mkdir -p "$T/sol_st1" "$T/sol_st2"
(
  STATE="$T/sol_st1"
  eval "$(sed -n '/^note_sol_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/sol_hhmm"
  echo 'API Error: not asked again before 23:59 UTC+8' > "$LOG"
  : > "$LOG.txt"
  note_sol_limit
  [ -s "$STATE/sol-limited-until" ] && [ "$(cat "$STATE/sol-limited-until")" -gt "$(date +%s)" ] || exit 1
) && ok sol-limit-stamps-hhmm || bad sol-limit-stamps-hhmm

(
  STATE="$T/sol_st2"
  eval "$(sed -n '/^note_sol_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/sol_mon"
  expected="$(python3 - "$LOG" <<'PY'
import datetime, sys
tz = datetime.timezone(datetime.timedelta(hours=8))
months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
t = (datetime.datetime.now(tz) + datetime.timedelta(days=2)).replace(second=0, microsecond=0)
open(sys.argv[1], "w").write(
    f"API Error: Request rejected (429) · Codex: The usage limit has been reached "
    f"(out of its allowance: not asked again before {months[t.month]} {t.day} {t.hour:02d}:{t.minute:02d} UTC+8)\n"
)
print(int(t.timestamp()))
PY
)"
  : > "$LOG.txt"
  note_sol_limit
  [ -s "$STATE/sol-limited-until" ] && [ "$(cat "$STATE/sol-limited-until")" = "$expected" ] || exit 1
) && ok sol-limit-stamps-month-day-hhmm || bad sol-limit-stamps-month-day-hhmm

# A stale clock (a Mon DD already in the past) must not roll a full year into a ~12-month sol hold.
mkdir -p "$T/sol_st3"
(
  STATE="$T/sol_st3"
  eval "$(sed -n '/^note_sol_limit()/,/^}/p' "$H/dispatch.sh")"
  LOG="$T/sol_stale"
  past="$(python3 - <<'PY'
import datetime
tz = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(tz)
t = now - datetime.timedelta(days=1)
months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
print("" if t.year != now.year else f"{months[t.month]} {t.day} {t.hour:02d}:{t.minute:02d}")
PY
)"
  [ -z "$past" ] && exit 0   # Jan 1: yesterday belongs to last year, not expressible as a same-year clock
  echo "API Error: not asked again before $past UTC+8" > "$LOG"
  : > "$LOG.txt"
  note_sol_limit
  # Either no stamp at all, or one that stays well inside the next two days — never ~1 year out.
  [ ! -s "$STATE/sol-limited-until" ] || [ "$(cat "$STATE/sol-limited-until")" -lt "$(( $(date +%s) + 172800 ))" ] || exit 1
) && ok sol-limit-ignores-stale-clock || bad sol-limit-ignores-stale-clock

echo ALL-PASS
