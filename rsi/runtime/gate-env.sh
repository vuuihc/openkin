# shellcheck shell=bash
# gate-env.sh — can this machine run the gate at all?
#
# A gate that cannot run must report "no verdict", never "your change failed" (AGENTS.md 13).
# 2026-11-22: two sendbacks in one night (contract-story-012159, approval-strip-reading-021235)
# were `cp: … No space left on device` from tests that never ran, and both were billed to the
# branch as rework. `df` is not a precondition here: APFS reported 18 GB available while cp
# failed with ENOSPC in the same state, because it counts purgeable space. The two honest
# signals are a probe write and the failing step's own log.
#
# Sourced by gate.sh after common.sh. Both helpers are independently callable (the tests call
# them directly: a test that ran a full gate from inside check.sh would recurse, because the
# gate runs check.sh, which runs the tests).

if ! declare -F bounded_run > /dev/null 2>&1; then
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
fi

# The markers the OS leaves when a write cannot be satisfied. Matched case-sensitively: this is
# the tool's own error text, not prose.
GATE_ENV_LOG_RE='No space left on device|ENOSPC'
# A test runner's own output quotes logs and assertions, so a marker ON a test-output line is
# prose about the marker, not the machine's error: this suite's own fail() text names it, and a
# gate log tail can quote one inside a FAIL assertion. Counting those would read a genuinely red
# test as ENOSPC and retry it forever with no sendback.
GATE_ENV_TEST_OUTPUT_RE='^(FAIL |--- FAIL|AssertionError|✗|×)'

# gate_env_failure_in_log <step> <log> — 0 and prints the reason when the log proves the machine
# failed, not the branch. A red test log with no marker keeps today's FAIL verdict byte for byte.
gate_env_failure_in_log() {
  local step="$1" log="$2" hits
  [ -r "$log" ] || return 1
  hits="$(grep -aE "$GATE_ENV_LOG_RE" "$log" 2>/dev/null | grep -avE "$GATE_ENV_TEST_OUTPUT_RE")" || true
  [ -n "$hits" ] || return 1
  printf 'disk: no space left on device during %s\n' "$step"
  return 0
}

GATE_PROBE_BYTES=4194304   # 4 MiB: a few MB, written and read in well under a second
GATE_PROBE_REASON=""

# gate_disk_probe <dir> — 0 when a small file can be written, read back and deleted; 1 otherwise,
# with GATE_PROBE_REASON set. Bounded: a probe that can hang is a defect (AGENTS 13).
gate_disk_probe() {
  local dir="$1" f got rc
  GATE_PROBE_REASON=""
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    GATE_PROBE_REASON="disk: probe target '${dir:-}' is not a directory"
    return 1
  fi
  f="$dir/.gate-probe-$$"
  if ! bounded_run 10 dd if=/dev/zero of="$f" bs=1048576 count=4 2>/dev/null; then
    rm -f "$f" 2>/dev/null
    GATE_PROBE_REASON="disk: probe write failed in $dir"
    return 1
  fi
  # The path, not stdin: Bash redirects a background job's stdin from /dev/null. BSD wc prints
  # the count and the path, so take the first field.
  got="$(bounded_run 10 wc -c "$f" 2>/dev/null)"; rc=$?
  rm -f "$f" 2>/dev/null
  got="$(printf '%s' "$got" | awk '{print $1}')"
  if [ "$rc" -ne 0 ] || [ "$got" != "$GATE_PROBE_BYTES" ]; then
    GATE_PROBE_REASON="disk: probe read-back failed in $dir"
    return 1
  fi
  return 0
}
