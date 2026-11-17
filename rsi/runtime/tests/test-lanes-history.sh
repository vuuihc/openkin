#!/bin/bash
# test-lanes-history.sh — a lane claim archive must never overwrite the row before it.
#
# lanes.py moves a lane's previous record into state/lanes/history/<stamp>-<slug>.json when the lane is
# claimed again. Two claims of the same slug inside one wall-clock second used to produce the same
# filename, and the second os.replace silently destroyed the first row — the loop's own history lost.
# The NAS twin (rsi/runtime/nas/ingest-nas.sh, #209) already suffixes collisions; this suite pins the
# local-lane half: the helper's naming, the call site that uses it, and one end-to-end pair of claims.
#
# Hermetic: temp RSI_STATE and mktemp only, no network, no repo writes. Prints "PASS <case>" per case
# and exits non-zero on the first failure.
set -u
RUNTIME="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }

# Claim admission also depends on host pressure (load, vm pressure, memory, swap). The cases below test
# history naming only, so pin the env thresholds and stub the two probes: a loaded machine or a critical
# memory-pressure level must not turn them into exit-8 refusals.
mkdir -p "$T/bin"
for probe in sysctl vm_stat; do printf '#!/bin/sh\nexit 1\n' > "$T/bin/$probe"; chmod +x "$T/bin/$probe"; done
NOPRESS="RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 RSI_LOAD_MAX=9999"

# helper_path <state> <slug> [stamp] — print unique_history_path() from lanes.py.
# lanes.py dispatches argv at import, so stub parse_args and load the file with runpy: the helper is
# exercised in place, not copied.
helper_path() { # <state> <slug> [stamp]
  RSI_STATE="$1" python3 - "$RUNTIME/lanes.py" "$2" "${3:-}" <<'PY'
import argparse, runpy, sys
path, slug, stamp = sys.argv[1:4]
class _Noop:
    def f(self, _a): pass
argparse.ArgumentParser.parse_args = lambda self, *a, **k: _Noop()
mod = runpy.run_path(path, run_name="lanes")
print(mod["unique_history_path"](slug, stamp or None))
PY
}

# --- first-claim-keeps-plain-name: an empty history dir keeps <stamp>-<slug>.json -----------------
ST="$T/c1"; mkdir -p "$ST"
got="$(helper_path "$ST" demo 20260101-000000 2>"$T/c1.err")" \
  || bad "first-claim-keeps-plain-name: helper failed: $(tr '\n' ' ' < "$T/c1.err")"
[ "$got" = "$ST/lanes/history/20260101-000000-demo.json" ] \
  || bad "first-claim-keeps-plain-name: got '$got'"
ok first-claim-keeps-plain-name

# --- second-and-third-claims-suffix: collisions count up as -2, -3 and never touch earlier rows ----
ST="$T/c2"; mkdir -p "$ST/lanes/history"
printf 'keep-me\n' > "$ST/lanes/history/20260101-000000-demo.json"
got="$(helper_path "$ST" demo 20260101-000000 2>"$T/c2.err")" \
  || bad "second-and-third-claims-suffix: second call failed: $(tr '\n' ' ' < "$T/c2.err")"
[ "$got" = "$ST/lanes/history/20260101-000000-demo-2.json" ] \
  || bad "second-and-third-claims-suffix: second call got '$got'"
: > "$ST/lanes/history/20260101-000000-demo-2.json"
got="$(helper_path "$ST" demo 20260101-000000 2>"$T/c2b.err")" \
  || bad "second-and-third-claims-suffix: third call failed: $(tr '\n' ' ' < "$T/c2b.err")"
[ "$got" = "$ST/lanes/history/20260101-000000-demo-3.json" ] \
  || bad "second-and-third-claims-suffix: third call got '$got'"
[ "$(cat "$ST/lanes/history/20260101-000000-demo.json")" = "keep-me" ] \
  || bad "second-and-third-claims-suffix: the pre-existing row was overwritten"
ok second-and-third-claims-suffix

# --- same-second-claims-both-survive: two real claims in one second both keep an archive ----------
# Three claim/finish rounds archive the first two records. If the clock stays in one second the two
# archives must be <stamp>-demo.json and <stamp>-demo-2.json; if it rolls over, retry (up to 3) and
# then at least assert two archives exist, one per stamp — never pass without seeing both rows.
brief="$T/brief.md"; printf 'brief\n' > "$brief"
archive_case() { # <state>
  local st="$1" i out
  for i in 1 2 3; do
    out="$(RSI_STATE="$st" PATH="$T/bin:$PATH" env $NOPRESS python3 "$RUNTIME/lanes.py" claim 1 \
      --slug demo --item R-demo --brief "$brief" --paths rsi/runtime/x.py 2>&1)" \
      || bad "same-second-claims-both-survive: claim $i failed: $out"
    grep -q "CLAIMED lane 1" <<<"$out" || bad "same-second-claims-both-survive: claim $i: $out"
    RSI_STATE="$st" python3 "$RUNTIME/lanes.py" finish 1 --status done >/dev/null 2>&1 \
      || bad "same-second-claims-both-survive: finish $i failed"
  done
}
for attempt in 1 2 3; do
  ST="$T/c3-$attempt"; mkdir -p "$ST"
  archive_case "$ST"
  n="$(find "$ST/lanes/history" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
  [ "$n" -ge 2 ] || bad "same-second-claims-both-survive: expected at least 2 archives, got $n"
  f1="$(find "$ST/lanes/history" -maxdepth 1 -name '*.json' | sort | sed -n 1p)"
  f2="$(find "$ST/lanes/history" -maxdepth 1 -name '*.json' | sort | sed -n 2p)"
  b1="$(basename "$f1")"; b2="$(basename "$f2")"
  s1="${b1:0:15}"; s2="${b2:0:15}"
  if [ "$s1" = "$s2" ]; then
    [ "$n" -eq 2 ] || bad "same-second-claims-both-survive: expected exactly 2 archives in one stamp, got $n"
    if { [ "$b1" = "$s1-demo.json" ] && [ "$b2" = "$s1-demo-2.json" ]; } \
       || { [ "$b1" = "$s1-demo-2.json" ] && [ "$b2" = "$s1-demo.json" ]; }; then
      ok same-second-claims-both-survive
    else
      bad "same-second-claims-both-survive: names '$b1' '$b2' are not <stamp>-demo.json / <stamp>-demo-2.json"
    fi
    break
  fi
  [ "$attempt" -lt 3 ] && continue
  echo "SKIP same-second-claims-both-survive (clock rolled: $s1 vs $s2; both archives kept: $b1, $b2)"
done

# --- claim-uses-the-helper: source tripwire — cmd_claim() archives through unique_history_path() ----
body="$(awk '/^def cmd_claim/ { on = 1 } on { print } on && /^$/ { exit }' "$RUNTIME/lanes.py")"
[ -n "$body" ] || bad "claim-uses-the-helper: could not read cmd_claim() in lanes.py"
grep -q 'def unique_history_path' "$RUNTIME/lanes.py" \
  || bad "claim-uses-the-helper: lanes.py has no unique_history_path()"
grep -q 'unique_history_path' <<<"$body" \
  || bad "claim-uses-the-helper: cmd_claim() does not archive through unique_history_path()"
grep -q 'os.path.join(LDIR, "history"' <<<"$body" \
  && bad "claim-uses-the-helper: cmd_claim() still builds a history filename by hand"
ok claim-uses-the-helper

echo "test-lanes-history: ALL-PASS"
