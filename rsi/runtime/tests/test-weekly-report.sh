#!/bin/bash
# The weekly worth-it report must be regenerated on the path the morning brief reads.
#
# Two things are checked here:
#   1. rsi_refresh_weekly_report() (common.sh) rewrites a stale escalations-weekly.md
#      for the current week, and stays quiet + returns 0 when escalate.py is missing.
#   2. run.sh calls it in the daily and dream branches only, never in pulse, and never
#      on a dry run.
#
# Hermetic: a fixture RSI_CTRL tree (escalate.py and volc-budget.py symlinked from this
# checkout), a temp state dir, an empty usage ledger, no network, no model calls.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)"          # rsi/runtime
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
: > "$T/usage.jsonl"

week_start="$(python3 - <<'PY'
import datetime
sgt = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(sgt)
print((now - datetime.timedelta(days=now.weekday())).strftime("%Y-%m-%d"))
PY
)"

# fixture_record <state-dir> — one decided review in the current week so the rewritten
# report has a daily line as well as a heading.
fixture_record() {
  python3 - "$1" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
sgt = timezone(timedelta(hours=8))
st = Path(sys.argv[1]); st.mkdir(parents=True, exist_ok=True)
now = datetime.now(sgt)
ws = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
iso = lambda h: (ws + timedelta(hours=h)).isoformat()
(st / "escalations.jsonl").write_text(json.dumps(dict(
    ts=iso(1), outcome_ts=iso(2), id="a", model="kimi", reason="reviewer-disagreement",
    outcome="PASS", deepseek_verdict="PASS", has_bm=False, kind=""), sort_keys=True) + "\n")
PY
}

# --- report modes refresh the weekly ---
FX="$T/fx"
mkdir -p "$FX/rsi/runtime" "$FX/rsi/state"
ln -s "$H/escalate.py" "$FX/rsi/runtime/escalate.py"
ln -s "$H/volc-budget.py" "$FX/rsi/runtime/volc-budget.py"
printf '# Escalations week 2020-01-06–2020-01-12 (Asia/Singapore)\nstale\n' > "$FX/rsi/state/escalations-weekly.md"
fixture_record "$FX/rsi/state"
(
  export RSI_CTRL="$FX" RSI_STATE="$FX/rsi/state" MAGPIE_USAGE_JSONL="$T/usage.jsonl"
  # shellcheck disable=SC1091
  source "$H/common.sh"
  [ "$RSI_DIR" = "$FX/rsi" ] || exit 1
  rsi_refresh_weekly_report || exit 1
) || bad weekly-refresh-returns-zero
grep -qF "# Escalations week $week_start" "$FX/rsi/state/escalations-weekly.md" \
  || { cat "$FX/rsi/state/escalations-weekly.md"; bad weekly-refresh-heading; }
grep -q '2020-01-06' "$FX/rsi/state/escalations-weekly.md" && bad weekly-refresh-stale-left
grep -q 'Daily worth-it' "$FX/rsi/state/escalations-weekly.md" || bad weekly-refresh-daily
ok report-modes-refresh-the-weekly

# --- escalate.py unreachable: fail-open, file untouched ---
FX2="$T/fx2"
mkdir -p "$FX2/rsi/state"
printf '# Escalations week 2020-01-06–2020-01-12 (Asia/Singapore)\nstale\n' > "$FX2/rsi/state/escalations-weekly.md"
(
  export RSI_CTRL="$FX2" RSI_STATE="$FX2/rsi/state" MAGPIE_USAGE_JSONL="$T/usage.jsonl"
  # shellcheck disable=SC1091
  source "$H/common.sh"
  rsi_refresh_weekly_report
  [ $? -eq 0 ] || exit 1
) || bad weekly-refresh-unreachable-zero
grep -q '2020-01-06' "$FX2/rsi/state/escalations-weekly.md" || bad weekly-refresh-unreachable-clobbered
[ "$(wc -l < "$FX2/rsi/state/escalations-weekly.md")" -eq 2 ] || bad weekly-refresh-unreachable-rewritten
ok weekly-refresh-unreachable-fail-open

# --- run.sh calls the refresh in daily and dream only ---
RUN="$H/run.sh"
[ "$(grep -cF 'rsi_refresh_weekly_report' "$RUN")" -eq 2 ] || bad refresh-call-count
[ "$(grep -cF '[ $DRY -eq 0 ] && rsi_refresh_weekly_report' "$RUN")" -eq 2 ] || bad refresh-dry-guard
sed -n '/^  pulse)/,/^  daily)/p' "$RUN" | grep -qF 'rsi_refresh_weekly_report' && bad refresh-in-pulse
sed -n '/^  daily)/,/^  dream)/p' "$RUN" | grep -qF 'rsi_refresh_weekly_report' || bad refresh-missing-daily
sed -n '/^  dream)/,/^esac/p' "$RUN" | grep -qF 'rsi_refresh_weekly_report' || bad refresh-missing-dream
ok run-sh-calls-refresh-daily-dream-only

echo ALL-PASS
